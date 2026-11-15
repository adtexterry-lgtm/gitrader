// SPDX-License-Identifier: CPAL-1.0
// 解析口径逐字对齐 packages/engine-core/src/runtime/data.ts 的 parseCsv / parseJson / parseFundingCsv / parseFundingJson：
// CSV 列为 t,o,h,l,c[,v]（资金费 t,rate[,premium]），可有表头行，t 为 Unix 毫秒，坏行跳过，按 t 升序去重保留先出现的那根。
// 差别只在返回值：这里额外带 rows / header / skipped / duplicates 计数，供报告使用；能进 candles 的根与引擎一致。
import type { Candle } from '@gitrader/protocol/types'
import type { FundingPoint, ParsedCandles, ParsedFunding } from './types'

/** 与引擎一致的逐行切分：按 \n 切、trim、空行跳过（不处理 \r\n 以外的转义，与引擎同）。 */
function nonEmptyLines(text: string): string[] {
  const out: string[] = []
  let start = 0
  const n = text.length
  while (start < n) {
    let end = text.indexOf('\n', start)
    if (end < 0) end = n
    const line = text.slice(start, end).trim()
    start = end + 1
    if (line === '') continue
    out.push(line)
  }
  return out
}

/** 首行首列不是数值即视为表头（引擎把表头当坏行跳过，这里单独计数）。 */
function hasHeader(lines: readonly string[]): boolean {
  const first = lines[0]
  if (first === undefined) return false
  const cell = first.split(',')[0]
  return cell === undefined || !Number.isFinite(Number(cell))
}

/** CSV K 线：`t,o,h,l,c[,v]`。 */
export function parseCandleCsv(text: string): ParsedCandles {
  const lines = nonEmptyLines(text)
  const header = hasHeader(lines)
  const raw: Candle[] = []
  let skipped = 0
  for (let i = header ? 1 : 0; i < lines.length; i++) {
    const f = lines[i]!.split(',')
    if (f.length < 5) {
      skipped++
      continue
    }
    const t = Number(f[0])
    const o = Number(f[1])
    const h = Number(f[2])
    const l = Number(f[3])
    const c = Number(f[4])
    const v = f.length > 5 ? Number(f[5]) : 0
    if (![t, o, h, l, c, v].every(Number.isFinite)) {
      skipped++
      continue
    }
    raw.push({ t, o, h, l, c, v })
  }
  const sorted = raw.sort((a, b) => a.t - b.t)
  const candles = sorted.filter((c, i) => i === 0 || c.t !== sorted[i - 1]!.t)
  return { rows: lines.length, header, candles, duplicates: raw.length - candles.length, skipped }
}

/** JSON K 线：`[{t,o,h,l,c,v?}]`、`[[t,o,h,l,c,v?]]` 或 `{ "candles": [...] }`。非法 JSON 抛错（与引擎一致）。 */
export function parseCandleJson(text: string): ParsedCandles {
  let j: unknown
  try {
    j = JSON.parse(text)
  } catch {
    throw new Error('data file is not valid JSON')
  }
  const arr = Array.isArray(j)
    ? j
    : j && typeof j === 'object' && Array.isArray((j as { candles?: unknown }).candles)
      ? (j as { candles: unknown[] }).candles
      : null
  if (arr === null) throw new Error('JSON data must be an array of candles or { "candles": [...] }')
  const raw: Candle[] = []
  let skipped = 0
  for (const x of arr) {
    const v = Array.isArray(x)
      ? x
      : x && typeof x === 'object'
        ? [
            (x as Record<string, unknown>).t,
            (x as Record<string, unknown>).o,
            (x as Record<string, unknown>).h,
            (x as Record<string, unknown>).l,
            (x as Record<string, unknown>).c,
            (x as Record<string, unknown>).v ?? 0,
          ]
        : null
    if (!v || v.length < 5) {
      skipped++
      continue
    }
    const n = [v[0], v[1], v[2], v[3], v[4], v[5] ?? 0]
    if (!n.every((y) => typeof y === 'number' && Number.isFinite(y))) {
      skipped++
      continue
    }
    raw.push({ t: n[0] as number, o: n[1] as number, h: n[2] as number, l: n[3] as number, c: n[4] as number, v: n[5] as number })
  }
  const sorted = raw.sort((a, b) => a.t - b.t)
  const candles = sorted.filter((c, i) => i === 0 || c.t !== sorted[i - 1]!.t)
  return { rows: arr.length, header: false, candles, duplicates: raw.length - candles.length, skipped }
}

/**
 * CSV 资金费：`t,rate[,premium]`。引擎只取前两列、且不排序不去重；报告需要 from/to 与重复计数，所以这里补上排序去重
 * （与 loadFunding 装载后的顺序一致），接受 / 拒绝规则仍是引擎那一套。
 */
export function parseFundingCsv(text: string): ParsedFunding {
  const lines = nonEmptyLines(text)
  const header = hasHeader(lines)
  const raw: FundingPoint[] = []
  let skipped = 0
  for (let i = header ? 1 : 0; i < lines.length; i++) {
    const f = lines[i]!.split(',')
    if (f.length < 2) {
      skipped++
      continue
    }
    const t = Number(f[0])
    const rate = Number(f[1])
    if (!Number.isFinite(t) || !Number.isFinite(rate)) {
      skipped++
      continue
    }
    raw.push({ t, rate })
  }
  const sorted = raw.sort((a, b) => a.t - b.t)
  const points = sorted.filter((p, i) => i === 0 || p.t !== sorted[i - 1]!.t)
  return { rows: lines.length, header, points, duplicates: raw.length - points.length, skipped }
}

/** JSON 资金费：`[{t,rate}]`、`[[t,rate]]` 或 `{ "points": [...] }`。与引擎一样容忍 rate 是数字字符串。 */
export function parseFundingJson(text: string): ParsedFunding {
  let j: unknown
  try {
    j = JSON.parse(text)
  } catch {
    return { rows: 0, header: false, points: [], duplicates: 0, skipped: 0, invalid: true }
  }
  const arr = Array.isArray(j)
    ? j
    : j && typeof j === 'object' && Array.isArray((j as { points?: unknown }).points)
      ? (j as { points: unknown[] }).points
      : null
  if (arr === null) return { rows: 0, header: false, points: [], duplicates: 0, skipped: 0, invalid: true }
  const raw: FundingPoint[] = []
  let skipped = 0
  for (const p of arr) {
    let t: unknown
    let rate: unknown
    if (Array.isArray(p)) {
      if (p.length < 2) {
        skipped++
        continue
      }
      t = p[0]
      rate = p[1]
    } else if (p && typeof p === 'object') {
      const o = p as Record<string, unknown>
      t = o.t
      rate = o.rate
    } else {
      skipped++
      continue
    }
    if (typeof t !== 'number' || !Number.isFinite(t)) {
      skipped++
      continue
    }
    const n = typeof rate === 'number' ? rate : typeof rate === 'string' ? Number(rate) : NaN
    if (!Number.isFinite(n)) {
      skipped++
      continue
    }
    raw.push({ t, rate: n })
  }
  const sorted = raw.sort((a, b) => a.t - b.t)
  const points = sorted.filter((p, i) => i === 0 || p.t !== sorted[i - 1]!.t)
  return { rows: arr.length, header: false, points, duplicates: raw.length - points.length, skipped }
}
