// SPDX-License-Identifier: CPAL-1.0
// 读本地历史数据文件 → 报告。只读文件系统（normalize 写一份规范 JSON），不联网、不碰引擎运行时。
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, extname } from 'node:path'
import { CANDLE_INTERVALS } from '@gitrader/protocol/constants'
import type { CandleInterval } from '@gitrader/protocol/types'
import { parseCandleCsv, parseCandleJson, parseFundingCsv, parseFundingJson } from './parse'
import { resolveDataPath } from './root'
import type { CandleFileReport, FileFormat, FundingFileReport, Gap, InspectOptions, IntervalGuess } from './types'

/** 全仓统一的文件摘要格式：`sha256:<hex>`（与 engine-core/src/util/hash.ts 的 sha256Digest 逐字相同）。 */
export function sha256Digest(data: Uint8Array | string): string {
  return `sha256:${createHash('sha256').update(data).digest('hex')}`
}

/** 扩展名定格式：`.csv` / `.json`，其它直接报错（不猜）。 */
export function formatFromPath(path: string): FileFormat {
  const ext = extname(path).toLowerCase()
  if (ext === '.csv') return 'csv'
  if (ext === '.json') return 'json'
  throw new Error(`unsupported data file extension: ${path}`)
}

const MIN = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000

/** CANDLE_INTERVALS 的毫秒值。"1M" 是日历月，没有固定毫秒，故不在此表（永远对不上 label）。 */
const INTERVAL_MS: Readonly<Record<string, number>> = {
  '1m': MIN,
  '3m': 3 * MIN,
  '5m': 5 * MIN,
  '15m': 15 * MIN,
  '30m': 30 * MIN,
  '1h': HOUR,
  '2h': 2 * HOUR,
  '4h': 4 * HOUR,
  '8h': 8 * HOUR,
  '12h': 12 * HOUR,
  '1d': DAY,
  '3d': 3 * DAY,
  '1w': 7 * DAY,
}

/** 毫秒 → CANDLE_INTERVALS 名字；对不上返回 null。 */
export function labelForInterval(ms: number): CandleInterval | null {
  for (const iv of CANDLE_INTERVALS) {
    if (INTERVAL_MS[iv] === ms) return iv
  }
  return null
}

/** 相邻 t 差众数 → {ms,label,confidence}；不足两根返回 null。平票取更小的间隔（确定性）。 */
export function guessInterval(candles: readonly { t: number }[], warnings: string[]): IntervalGuess | null {
  if (candles.length < 2) {
    warnings.push('not enough candles to infer an interval')
    return null
  }
  const counts = new Map<number, number>()
  let total = 0
  for (let i = 1; i < candles.length; i++) {
    const d = candles[i]!.t - candles[i - 1]!.t
    if (d <= 0) continue
    counts.set(d, (counts.get(d) ?? 0) + 1)
    total++
  }
  if (total === 0) {
    warnings.push('not enough candles to infer an interval')
    return null
  }
  let bestMs = 0
  let bestCount = -1
  for (const d of [...counts.keys()].sort((a, b) => a - b)) {
    const c = counts.get(d)!
    if (c > bestCount) {
      bestMs = d
      bestCount = c
    }
  }
  return { ms: bestMs, label: labelForInterval(bestMs), confidence: bestCount / total }
}

/**
 * 按众数间隔找缺口：相邻差 delta 折成 steps = round(delta / ms)，steps > 1 即记一条缺口；
 * from / to 是推断出的第一根 / 最后一根缺失 K 线的开盘时间，missing = steps - 1。最多返回 maxGaps 条。
 */
export function findGaps(candles: readonly { t: number }[], ms: number, maxGaps: number, warnings: string[]): Gap[] {
  if (candles.length < 2 || ms <= 0) return []
  const gaps: Gap[] = []
  let irregular = 0
  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1]!.t
    const delta = candles[i]!.t - prev
    if (delta % ms !== 0) irregular++
    const steps = Math.round(delta / ms)
    if (steps > 1) {
      gaps.push({ from: prev + ms, to: prev + ms * (steps - 1), missing: steps - 1 })
    }
  }
  if (irregular > 0) warnings.push(`${irregular} spacing(s) are not a multiple of the inferred interval`)
  if (gaps.length > maxGaps) {
    warnings.push(`${gaps.length} gaps found; only the first ${maxGaps} are listed`)
    return gaps.slice(0, maxGaps)
  }
  return gaps
}

/** h < max(o,c) 或 l > min(o,c) 的根数。 */
export function countOhlcViolations(candles: readonly { o: number; h: number; l: number; c: number }[]): number {
  let n = 0
  for (const c of candles) {
    if (c.h < Math.max(c.o, c.c) || c.l > Math.min(c.o, c.c)) n++
  }
  return n
}

/** 检查一个 K 线文件（格式按扩展名）。文件读不到 / JSON 结构不对时抛错。 */
export function inspectCandleFile(path: string, opts: InspectOptions = {}): CandleFileReport {
  const abs = resolveDataPath(path, opts.root, 'data file')
  const format = opts.format ?? formatFromPath(abs)
  const buf = readFileSync(abs)
  const text = buf.toString('utf8')
  const parsed = format === 'json' ? parseCandleJson(text) : parseCandleCsv(text)
  const warnings: string[] = []
  if (parsed.header) warnings.push('first line treated as a header')
  if (parsed.skipped > 0) warnings.push(`${parsed.skipped} malformed row(s) skipped`)
  if (parsed.duplicates > 0) warnings.push(`${parsed.duplicates} duplicate timestamp(s) dropped, earliest kept`)
  if (parsed.candles.length === 0) warnings.push('no candles parsed')
  const interval = guessInterval(parsed.candles, warnings)
  const gaps = interval === null ? [] : findGaps(parsed.candles, interval.ms, opts.maxGaps ?? 50, warnings)
  const ohlcViolations = countOhlcViolations(parsed.candles)
  if (ohlcViolations > 0) warnings.push(`${ohlcViolations} candle(s) violate o/h/l/c ordering`)
  const first = parsed.candles[0]
  const last = parsed.candles[parsed.candles.length - 1]
  return {
    path: abs,
    format,
    sha256: sha256Digest(buf),
    rows: parsed.rows,
    parsed: parsed.candles.length + parsed.duplicates,
    skipped: parsed.skipped,
    from: first?.t ?? null,
    to: last?.t ?? null,
    interval,
    gaps,
    duplicates: parsed.duplicates,
    ohlcViolations,
    warnings,
  }
}

/** 检查一个资金费文件（t,rate[,premium] / JSON 点列）。 */
export function inspectFundingFile(path: string, opts: InspectOptions = {}): FundingFileReport {
  const abs = resolveDataPath(path, opts.root, 'data file')
  const format = opts.format ?? formatFromPath(abs)
  const buf = readFileSync(abs)
  const parsed = format === 'json' ? parseFundingJson(buf.toString('utf8')) : parseFundingCsv(buf.toString('utf8'))
  const warnings: string[] = []
  if (parsed.invalid === true) warnings.push('JSON is not a funding point list; nothing parsed')
  if (parsed.header) warnings.push('first line treated as a header')
  if (parsed.skipped > 0) warnings.push(`${parsed.skipped} malformed row(s) skipped`)
  if (parsed.duplicates > 0) warnings.push(`${parsed.duplicates} duplicate timestamp(s) dropped, earliest kept`)
  if (parsed.points.length === 0) warnings.push('no funding points parsed')
  const first = parsed.points[0]
  const last = parsed.points[parsed.points.length - 1]
  return {
    path: abs,
    format,
    sha256: sha256Digest(buf),
    rows: parsed.rows,
    parsed: parsed.points.length + parsed.duplicates,
    skipped: parsed.skipped,
    from: first?.t ?? null,
    to: last?.t ?? null,
    duplicates: parsed.duplicates,
    warnings,
  }
}

/**
 * 转成引擎规范 JSON：`{ "candles": [{t,o,h,l,c,v}, ...] }`，升序、按 t 去重（保留先出现）。
 * 返回输出文件的报告（即 inspectCandleFile(outPath)）。
 */
export function normalizeCandleFile(path: string, outPath: string, opts: InspectOptions = {}): CandleFileReport {
  const abs = resolveDataPath(path, opts.root, 'data file')
  const format = formatFromPath(abs)
  const text = readFileSync(abs).toString('utf8')
  const parsed = format === 'json' ? parseCandleJson(text) : parseCandleCsv(text)
  // 给了 root 时输出同样不许越界：写盘前先过 root 约束（含 ../ 与绝对路径逃逸）。
  const outAbs = resolveDataPath(outPath, opts.root, 'output file')
  mkdirSync(dirname(outAbs), { recursive: true })
  const body = `${JSON.stringify({ candles: parsed.candles }, null, 2)}\n`
  writeFileSync(outAbs, body, 'utf8')
  return inspectCandleFile(outAbs, opts)
}
