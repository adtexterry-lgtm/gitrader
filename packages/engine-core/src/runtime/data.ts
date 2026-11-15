// SPDX-License-Identifier: CPAL-1.0
// 回测 / 回放的数据入口：宿主行情（host.market.history 分页）或本地 CSV 文件（校验 sha256）。引擎不自带行情（market.own = false）。
import { readFile } from 'node:fs/promises'
import type { Candle } from '../types'
import { RpcError, rpcErr } from '../gep/peer'
import { normalizeFunding } from './host-api'
import type { HostApi, FundingPoint } from './host-api'
import type { ResolvedSpec } from './spec'
import { sha256Digest } from '../util/hash'
import { cacheDir, cacheKey, readCache, writeCache } from './candle-cache'

export interface LoadedData { candles: Candle[]; source: string; warnings: string[] }

export async function loadCandles(r: ResolvedSpec, host: HostApi, maxBars: number): Promise<LoadedData> {
  const warnings: string[] = []
  let candles: Candle[]
  let source: string
  if (r.spec.data.source === 'files') {
    const files = r.spec.data.files ?? []
    const f = files.find((x) => ((x as { kind?: string }).kind ?? 'candles') === 'candles') ?? files[0]!
    const idx = files.indexOf(f)
    let buf: Buffer
    try { buf = await readFile(f.path) } catch { throw rpcErr('DATA_UNAVAILABLE', 'data file cannot be read') }
    if (sha256Digest(buf) !== f.sha256) throw rpcErr('DATA_UNAVAILABLE', `data file sha256 does not match spec.data.files[${idx}].sha256`)
    const fmt = f.format as string
    const parsed = fmt === 'json' ? parseJsonWithReport(buf.toString('utf8')) : parseCsvWithReport(buf.toString('utf8'))
    candles = parsed.candles
    warnings.push(...dropWarnings(parsed.drops, fmt === 'json' ? 'item' : 'line'))
    source = `files:${fmt}`
  } else {
    const dir = cacheDir()
    const key = dir ? cacheKey(r.instrumentId, r.interval, r.from, r.to) : null
    const cached = dir && key ? await readCache(dir, key) : null
    if (cached) {
      candles = cached
      source = 'cache'
    } else {
      try {
        const h = await host.history(r.instrumentId, r.interval, { from: r.from, to: r.to, maxBars: maxBars + 1 })
        candles = h.candles
        source = `host:${h.source}`
        if (!h.complete && candles.length > maxBars) warnings.push('host history was cut at the engine bar limit')
        if (dir && key && h.complete && candles.length <= maxBars && r.to <= Date.now()) await writeCache(dir, key, candles)
      } catch (e) {
        if (e instanceof RpcError) throw e
        throw rpcErr('DATA_UNAVAILABLE', 'host.market.history failed')
      }
    }
  }
  // 秒级时间戳检测
  if (r.spec.data.source === 'files' && r.from >= SECONDS_BOUND) {
    const seconds = candles.filter((c) => c.t > 0 && c.t < SECONDS_BOUND)
    if (seconds.length > 0) warnings.push(`data file: ${seconds.length} row(s) have t that looks like Unix seconds (t < 1e11, first t=${seconds[0]!.t}); timestamps must be milliseconds, so they fall outside [from, to) and were ignored`)
  }
  candles = candles.filter((c) => c.t >= r.from && c.t < r.to)
  if (candles.length > maxBars) {
    warnings.push(`data has ${candles.length} bars; only the most recent ${maxBars} are used (engine limit)`)
    candles = candles.slice(-maxBars)
  }
  return { candles, source, warnings }
}

export interface DropReport {
  /** 非数 / NaN / 列数不足的行数。 */
  malformed: number
  /** 首个坏行位置：CSV 为物理行号（1 起，含表头与空行），JSON 为数组下标（0 起）。 */
  firstMalformed: number | null
  /** 时间戳重复被丢的行数（保留文件顺序里最早的一行）。 */
  duplicates: number
  firstDuplicateT: number | null
}

export interface ParsedCandles { candles: Candle[]; drops: DropReport }

const SECONDS_BOUND = 1e11   // 毫秒时间戳小于它的是 1973 年之前，对加密行情只可能是秒

export function parseCsvWithReport(text: string): ParsedCandles {
  const out: Candle[] = []
  let start = 0
  const n = text.length
  let lineNo = 0
  let headerChecked = false
  let malformed = 0
  let firstMalformed: number | null = null
  
  while (start < n) {
    let end = text.indexOf('\n', start)
    if (end < 0) end = n
    const line = text.slice(start, end).trim()
    start = end + 1
    lineNo += 1
    if (line === '') continue
    
    const f = line.split(',')
    if (!headerChecked) {
      headerChecked = true
      const firstCol = Number(f[0])
      if (!Number.isFinite(firstCol)) continue  // 表头行，不算坏行
    }
    
    if (f.length < 5) {
      malformed += 1
      if (firstMalformed === null) firstMalformed = lineNo
      continue
    }
    const t = Number(f[0]), o = Number(f[1]), h = Number(f[2]), l = Number(f[3]), c = Number(f[4]), v = f.length > 5 ? Number(f[5]) : 0
    if (![t, o, h, l, c, v].every(Number.isFinite)) {
      malformed += 1
      if (firstMalformed === null) firstMalformed = lineNo
      continue
    }
    out.push({ t, o, h, l, c, v })
  }
  
  out.sort((a, b) => a.t - b.t)
  
  // 去重并统计
  let duplicates = 0
  let firstDuplicateT: number | null = null
  const deduped: Candle[] = []
  for (let i = 0; i < out.length; i++) {
    if (i === 0 || out[i]!.t !== out[i - 1]!.t) {
      deduped.push(out[i]!)
    } else {
      duplicates += 1
      if (firstDuplicateT === null) firstDuplicateT = out[i]!.t
    }
  }
  
  return { candles: deduped, drops: { malformed, firstMalformed, duplicates, firstDuplicateT } }
}

export function parseJsonWithReport(text: string): ParsedCandles {
  let j: unknown
  try { j = JSON.parse(text) } catch { throw rpcErr('DATA_UNAVAILABLE', 'data file is not valid JSON') }
  const arr = Array.isArray(j) ? j : j && typeof j === 'object' && Array.isArray((j as { candles?: unknown }).candles) ? (j as { candles: unknown[] }).candles : null
  if (!arr) throw rpcErr('DATA_UNAVAILABLE', 'JSON data must be an array of candles or { "candles": [...] }')
  
  const out: Candle[] = []
  let malformed = 0
  let firstMalformed: number | null = null
  
  for (let idx = 0; idx < arr.length; idx++) {
    const x = arr[idx]
    const v = Array.isArray(x) ? x : x && typeof x === 'object' ? [(x as Record<string, unknown>).t, (x as Record<string, unknown>).o, (x as Record<string, unknown>).h, (x as Record<string, unknown>).l, (x as Record<string, unknown>).c, (x as Record<string, unknown>).v ?? 0] : null
    if (!v || v.length < 5) {
      malformed += 1
      if (firstMalformed === null) firstMalformed = idx
      continue
    }
    const nums = [v[0], v[1], v[2], v[3], v[4], v[5] ?? 0]
    if (!nums.every((y) => typeof y === 'number' && Number.isFinite(y))) {
      malformed += 1
      if (firstMalformed === null) firstMalformed = idx
      continue
    }
    out.push({ t: nums[0] as number, o: nums[1] as number, h: nums[2] as number, l: nums[3] as number, c: nums[4] as number, v: nums[5] as number })
  }
  
  out.sort((a, b) => a.t - b.t)
  
  let duplicates = 0
  let firstDuplicateT: number | null = null
  const deduped: Candle[] = []
  for (let i = 0; i < out.length; i++) {
    if (i === 0 || out[i]!.t !== out[i - 1]!.t) {
      deduped.push(out[i]!)
    } else {
      duplicates += 1
      if (firstDuplicateT === null) firstDuplicateT = out[i]!.t
    }
  }
  
  return { candles: deduped, drops: { malformed, firstMalformed, duplicates, firstDuplicateT } }
}

export function dropWarnings(d: DropReport, unit: 'line' | 'item'): string[] {
  const at = (k: number): string => (unit === 'line' ? `line ${k}` : `item #${k}`)
  const w: string[] = []
  if (d.malformed > 0) w.push(`data file: dropped ${d.malformed} malformed row(s) (non-numeric / NaN / too few columns; first at ${at(d.firstMalformed!)})`)
  if (d.duplicates > 0) w.push(`data file: dropped ${d.duplicates} duplicate timestamp(s) (kept the earliest row in file order; first duplicate t=${d.firstDuplicateT})`)
  return w
}

/** CSV：列 t,o,h,l,c[,v]；可有表头行；t 为 Unix 毫秒；坏行跳过。 */
export function parseCsv(text: string): Candle[] {
  return parseCsvWithReport(text).candles
}

/**
 * JSON：`[{t,o,h,l,c,v?}, ...]`、`[[t,o,h,l,c,v?], ...]` 或 `{ "candles": [...] }`。t 为 Unix 毫秒；坏项跳过；按 t 升序去重。
 */
export function parseJson(text: string): Candle[] {
  return parseJsonWithReport(text).candles
}

export interface LoadedFunding { points: FundingPoint[]; source: string; applied: boolean; warnings: string[] }

/** 装载资金费：spec 声明的文件（kind="funding"，校验 sha256）或宿主 host.market.fundingHistory；只保留 [from, to) 内的点。 */
export async function loadFunding(r: ResolvedSpec, host: HostApi): Promise<LoadedFunding> {
  const warnings: string[] = []
  if (r.spec.assumptions.funding !== true) {
    const given = r.spec.data.source === 'files' && (r.spec.data.files ?? []).some((x) => (x as { kind?: string }).kind === 'funding')
    return { points: [], source: 'none', applied: false, warnings: given ? ['a funding file was supplied but assumptions.funding is false; it was ignored'] : [] }
  }
  let points: FundingPoint[] = []
  let source = 'none'
  if (r.spec.data.source === 'files') {
    const f = (r.spec.data.files ?? []).find((x) => (x as { kind?: string }).kind === 'funding')
    if (!f) {
      warnings.push('funding requested but spec.data.files has no entry with kind "funding"')
    } else {
      let buf: Buffer
      try { buf = await readFile(f.path) } catch { throw rpcErr('DATA_UNAVAILABLE', 'funding file cannot be read') }
      if (sha256Digest(buf) !== f.sha256) throw rpcErr('DATA_UNAVAILABLE', 'funding file sha256 does not match spec.data.files[].sha256')
      const fmt = f.format
      points = fmt === 'json' ? parseFundingJson(buf.toString('utf8')) : parseFundingCsv(buf.toString('utf8'))
      source = `files:${fmt}`
    }
  } else {
    try {
      const h = await host.fundingHistory(r.instrumentId, { from: r.from, to: r.to })
      points = h.points
      source = 'host'
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      warnings.push(`host.market.fundingHistory unavailable: ${message.slice(0, 200)}`)
    }
  }
  points = points.filter((p) => p.t >= r.from && p.t < r.to)
  points.sort((a, b) => a.t - b.t)
  points = points.filter((p, i) => i === 0 || p.t !== points[i - 1]!.t)
  if (points.length === 0) {
    warnings.push('no funding points in range')
    return { points, source, applied: false, warnings }
  }
  return { points, source, applied: true, warnings }
}

/** CSV：列 t,rate[,premium]；可有表头行；t 为 Unix 毫秒；坏行跳过。 */
export function parseFundingCsv(text: string): FundingPoint[] {
  const out: FundingPoint[] = []
  let start = 0
  const n = text.length
  while (start < n) {
    let end = text.indexOf('\n', start)
    if (end < 0) end = n
    const line = text.slice(start, end).trim()
    start = end + 1
    if (line === '') continue
    const f = line.split(',')
    if (f.length < 2) continue
    const t = Number(f[0])
    const rate = Number(f[1])
    if (!Number.isFinite(t) || !Number.isFinite(rate)) continue
    out.push({ t, rate })
  }
  return out
}

/** JSON：`[{t,rate}]`、`[[t,rate]]` 或 `{ "points": [...] }`；坏项跳过；按 t 升序去重。 */
export function parseFundingJson(text: string): FundingPoint[] {
  let j: unknown
  try { j = JSON.parse(text) } catch { return [] }
  const arr = Array.isArray(j) ? j : j && typeof j === 'object' && Array.isArray((j as { points?: unknown }).points) ? (j as { points: unknown[] }).points : []
  return normalizeFunding(arr)
}
