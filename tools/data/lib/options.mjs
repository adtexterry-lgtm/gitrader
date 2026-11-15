// SPDX-License-Identifier: CPAL-1.0
// 命令行参数 → 校验过的选项。纯函数：不读环境、不联网、不写文件，坏输入一律抛 UsageError。
import { isInterval, INTERVALS } from './intervals.mjs'
import { VENUE_NAMES } from './venues.mjs'

/** 用法错误：CLI 以退出码 2 结束（与 @gitrader/data-files 的 run 同口径）。 */
export class UsageError extends Error {
  constructor(message) {
    super(message)
    this.name = 'UsageError'
  }
}

/** 翻页硬上限：照 packages/connector-binance-data/src/market.ts:19 的 MAX_PAGES（200 × 1500 根）。 */
export const DEFAULT_MAX_PAGES = 200

const FLAGS = ['venue', 'instrument', 'interval', 'from', 'to', 'out', 'max-pages']

export const USAGE = [
  'usage: node tools/data/fetch-candles.mjs --venue <v> --instrument <sym> --interval <iv> --from <ms|ISO> [--to <ms|ISO>] --out <file.json>',
  '',
  '  --venue       ' + VENUE_NAMES.join(' | '),
  '  --instrument  场所原生符号（BTCUSDT / BTC-USDT-SWAP / BTCUSD …）或完整 id（binance:BTCUSDT）',
  '  --interval    ' + INTERVALS.join(' | '),
  '  --from        起始开盘时间（Unix 毫秒，或 2024-01-01 / 2024-01-01T00:00:00Z 这类 ISO 文本）',
  '  --to          结束开盘时间（含）；缺省 = 现在',
  '  --out         规范 JSON 输出路径（必须 .json）；同目录另写 <名>.csv 原文与 <名>.manifest.json',
  '  --max-pages   翻页硬上限，缺省 ' + DEFAULT_MAX_PAGES,
  '',
  'exit codes: 0 ok, 1 拉取 / 落盘失败, 2 用法错误',
].join('\n')

/** 毫秒整数或 ISO 文本 → 毫秒。不认识就抛 UsageError（不猜时区：ISO 不带 Z 时按本机时区，与 Date.parse 一致）。 */
export function toMs(value, name) {
  const text = String(value).trim()
  if (text === '') throw new UsageError(`--${name} is empty`)
  if (/^-?\d+$/.test(text)) {
    const n = Number(text)
    if (!Number.isSafeInteger(n)) throw new UsageError(`--${name} is not a safe integer: ${text}`)
    return n
  }
  const parsed = Date.parse(text)
  if (!Number.isFinite(parsed)) throw new UsageError(`--${name} is neither Unix milliseconds nor a date: ${text}`)
  return parsed
}

/** 符号 → 完整 instrument id（`<venue>:<symbol>`）；已经带前缀时校验前缀一致。 */
export function instrumentIdOf(venue, instrument) {
  const text = String(instrument).trim()
  if (text === '') throw new UsageError('--instrument is empty')
  const i = text.indexOf(':')
  if (i < 0) return `${venue}:${text}`
  const prefix = text.slice(0, i)
  const symbol = text.slice(i + 1).trim()
  if (prefix !== venue) throw new UsageError(`instrument id ${JSON.stringify(text)} belongs to ${JSON.stringify(prefix)}, not ${JSON.stringify(venue)}`)
  if (symbol === '') throw new UsageError(`instrument id ${JSON.stringify(text)} has an empty symbol`)
  return `${venue}:${symbol}`
}

function readPairs(argv) {
  const values = new Map()
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) throw new UsageError(`unexpected positional argument: ${arg}`)
    const eq = arg.indexOf('=')
    const name = eq < 0 ? arg.slice(2) : arg.slice(2, eq)
    if (!FLAGS.includes(name)) throw new UsageError(`unknown option: --${name}`)
    if (eq >= 0) {
      values.set(name, arg.slice(eq + 1))
      continue
    }
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) throw new UsageError(`--${name} needs a value`)
    values.set(name, next)
    i++
  }
  return values
}

/**
 * 解析 fetch-candles 的参数。返回 { venue, instrument, instrumentId, interval, from, to, out, maxPages }。
 * to 缺省 = now()；只拒 from > to（区间含两端，from === to 是合法的单根窗口）。
 */
export function parseFetchArgs(argv, { now = () => Date.now() } = {}) {
  const values = readPairs(argv)
  const venue = values.get('venue')
  if (venue === undefined) throw new UsageError('--venue is required')
  if (!VENUE_NAMES.includes(venue)) throw new UsageError(`unknown venue: ${venue}; supported: ${VENUE_NAMES.join(', ')}`)

  const instrument = values.get('instrument')
  if (instrument === undefined) throw new UsageError('--instrument is required')

  const interval = values.get('interval')
  if (interval === undefined) throw new UsageError('--interval is required')
  if (!isInterval(interval)) throw new UsageError(`unknown interval: ${interval}; supported: ${INTERVALS.join(', ')}`)

  const fromRaw = values.get('from')
  if (fromRaw === undefined) throw new UsageError('--from is required')
  const from = toMs(fromRaw, 'from')

  const toRaw = values.get('to')
  const to = toRaw === undefined ? Math.floor(now()) : toMs(toRaw, 'to')
  if (from > to) throw new UsageError(`--from (${from}) must be earlier than --to (${to})`)

  const out = values.get('out')
  if (out === undefined) throw new UsageError('--out is required (a .json path)')
  if (!/\.json$/i.test(out)) throw new UsageError(`--out must end with .json: ${out}`)

  const maxRaw = values.get('max-pages')
  let maxPages = DEFAULT_MAX_PAGES
  if (maxRaw !== undefined) {
    if (!/^\d+$/.test(maxRaw) || Number(maxRaw) < 1) throw new UsageError(`--max-pages must be a positive integer: ${maxRaw}`)
    maxPages = Number(maxRaw)
  }

  return { venue, instrumentId: instrumentIdOf(venue, instrument), interval, from, to, out, maxPages }
}
