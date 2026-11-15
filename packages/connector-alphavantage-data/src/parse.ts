// SPDX-License-Identifier: CPAL-1.0
// Alpha Vantage 响应 → 统一模型（纯函数，无状态；不发请求、不读环境）。
//
// 出处：Alpha Vantage 官方 API 文档 https://www.alphavantage.co/documentation/ （逐端点核对，施工时离线，未联网验证）：
//   盘中序列  GET /query?function=TIME_SERIES_INTRADAY&symbol=IBM&interval=1min|5min|15min|30min|60min
//             &outputsize=compact|full&month=YYYY-MM&datatype=json
//             → { "Meta Data": {"5. Time Zone": "US/Eastern", ...},
//                 "Time Series (5min)": { "2026-10-20 19:55:00": {
//                   "1. open": "...", "2. high": "...", "3. low": "...", "4. close": "...", "5. volume": "..." } } }
//   日线      GET /query?function=TIME_SERIES_DAILY&symbol=IBM&outputsize=compact|full
//             → { "Meta Data": {...}, "Time Series (Daily)": { "2026-10-20": {"1. open" … "5. volume"} } }
//   周线      GET /query?function=TIME_SERIES_WEEKLY  → { "Weekly Time Series": { "2026-10-16": {…} } }
//   月线      GET /query?function=TIME_SERIES_MONTHLY → { "Monthly Time Series": { "2026-09-30": {…} } }
//   实时报价  GET /query?function=GLOBAL_QUOTE&symbol=IBM
//             → { "Global Quote": {"01. symbol": "IBM", "02. open", "03. high", "04. low", "05. price",
//                 "06. volume", "07. latest trading day", "08. previous close", "09. change", "10. change percent"} }
//             没有买卖价（bid / ask）字段 —— 免费档不提供盘口，见 README「已知限制」。
//   标的清单  GET /query?function=LISTING_STATUS&state=active|delisted&date=YYYY-MM-DD
//             → CSV（datatype=csv 是缺省）：symbol,name,exchange,assetType,ipoDate,delistingDate,status
//   官方文档里 TIME_SERIES_INTRADAY **整个端点标 Premium**（不只是 1min），TIME_SERIES_DAILY 的
//   outputsize=full 也只给付费 key；免费 key 只有日线 compact、周线 / 月线全历史。本包照常发请求，
//   按上游返回的 "Information" / "Note" 区分付费提示（VENUE_AUTH）与限流（VENUE_UNAVAILABLE）。
//
// 免费档限制（官方 Support 页；施工时离线，数字待真网核对）：25 次/天。
//   **超限与参数错误都不改 HTTP 状态码，仍是 200**，body 是 {"Information"|"Note"} 或 {"Error Message"}；
//   所以判定错误必须看 body（见 avFailureOf），不能只看 res.ok。
//
// 协议形状照 packages/protocol/src/model/instrument.ts：美股现货 kind 'spot'、assetClass 'stocks'、
// quote / settle 'USD'、venueSizeUnit 'base'、contractSize '1'；Candle 的 t 一律是**开盘毫秒**。
// Alpha Vantage 的时间戳是**美东时间**（Meta Data 的 "5. Time Zone": "US/Eastern"），本包在解析处折成 UTC 毫秒；
// 日线只给交易日期，取该日期美东 00:00；周线取该日期所在周的周一 00:00，月线取该月 1 日 00:00
// （夏令时按折算后的那一天算，见 README「时间口径」）。
import { asDecimal, makeProblem } from '@gitrader/protocol'
import type {
  Candle, CandleInterval, Instrument, InstrumentPriceRule, InstrumentSizeRule, InstrumentStatus, Ms,
  Problem, ProblemName,
} from '@gitrader/protocol'

export const VENUE = 'alphavantage'
/** 官方唯一基址（所有端点在 /query 上以 query string 区分）。 */
export const DEFAULT_BASE_URL = 'https://www.alphavantage.co'
export const QUERY_PATH = '/query'

/** API Key 从环境变量读（官方示例用 query 参数 `apikey`）。两个常见写法都认，前者优先。 */
export const API_KEY_ENV = ['ALPHAVANTAGE_API_KEY', 'ALPHA_VANTAGE_API_KEY'] as const

/** 免费档：25 次/天（官方 Support 页）。 */
export const RATE_LIMIT = 25
export const RATE_WINDOW_MS: Ms = 86_400_000
/** 单次请求权重（按次计，不按权重）。 */
export const REQUEST_WEIGHT = 1

/** 一次响应能带回来的 K 线上限（盘中 full 约 30 天 × 390 根，给足余量后钳住）。 */
export const MAX_CANDLES = 20_000
/** compact 档的根数：官方文档 "compact" = 最近 100 根。 */
export const CANDLE_PAGE = 100
/** 无 from 时的缺省根数：免费档 compact 只给 100 根，缺省就取一页。 */
export const DEFAULT_CANDLE_COUNT = 100
/** 盘中按月切片翻页的硬上限（防上游异常时死循环）。 */
export const MAX_PAGES = 200

/** 美东时区：Alpha Vantage 所有序列的时间戳都按它解释。 */
export const ET_TZ = 'America/New_York'

/** 协议周期 → 盘中 interval（官方 intraday 只支持这五档：1min / 5min / 15min / 30min / 60min）。 */
export const INTRADAY_INTERVAL: Partial<Record<CandleInterval, string>> = {
  '1m': '1min', '5m': '5min', '15m': '15min', '30m': '30min', '1h': '60min',
}

/** 日 / 周 / 月序列的时间口径：日 = 该日期；周 = 该周周一；月 = 该月 1 日。 */
export type SeriesPeriod = 'day' | 'week' | 'month'

/** 协议周期 → 日 / 周 / 月序列的 function、响应里的序列键与时间口径。 */
export const SERIES_OF: Partial<Record<CandleInterval, { fn: string; key: string; period: SeriesPeriod }>> = {
  '1d': { fn: 'TIME_SERIES_DAILY', key: 'Time Series (Daily)', period: 'day' },
  '1w': { fn: 'TIME_SERIES_WEEKLY', key: 'Weekly Time Series', period: 'week' },
  '1M': { fn: 'TIME_SERIES_MONTHLY', key: 'Monthly Time Series', period: 'month' },
}

/** 本包支持的周期（其余协议周期 Alpha Vantage 没有：3m / 2h / 4h / 8h / 12h / 3d）。 */
export const SUPPORTED_INTERVALS: CandleInterval[] = ['1m', '5m', '15m', '30m', '1h', '1d', '1w', '1M']

export type SeriesSpec =
  | { kind: 'intraday'; avInterval: string }
  | { kind: 'series'; fn: string; key: string; period: SeriesPeriod }

export const instrumentIdOf = (symbol: string): string => `${VENUE}:${symbol}`

/** `alphavantage:IBM` → 场所原生 symbol（原样保留大小写）；不是本场所的 id 就拒绝。 */
export function symbolOf(instrumentId: string): string {
  const i = instrumentId.indexOf(':')
  if (i <= 0 || i === instrumentId.length - 1 || instrumentId.slice(0, i) !== VENUE) {
    throw problemError('INVALID_PARAMS', `not a ${VENUE} instrument id: ${JSON.stringify(instrumentId)}`)
  }
  return instrumentId.slice(i + 1)
}

/** 带 Problem 的错误：内核按 problem.name / retryable 决定是否重试。 */
export class ProblemError extends Error {
  readonly problem: Problem

  constructor(problem: Problem) {
    super(problem.message)
    this.name = 'ProblemError'
    this.problem = problem
  }
}

export function problemError(name: ProblemName, message: string, extra: Partial<Problem> = {}): ProblemError {
  return new ProblemError(makeProblem(name, message, extra))
}

// ---- 周期映射 ------------------------------------------------------------------

/** interval → 该打哪个 function / 哪个序列键；不支持的周期直接 INVALID_PARAMS（不发请求）。 */
export function seriesSpecOf(interval: CandleInterval): SeriesSpec {
  const intraday = INTRADAY_INTERVAL[interval]
  if (intraday !== undefined) return { kind: 'intraday', avInterval: intraday }
  const series = SERIES_OF[interval]
  if (series !== undefined) return { kind: 'series', fn: series.fn, key: series.key, period: series.period }
  throw problemError(
    'INVALID_PARAMS',
    `unsupported candle interval for alphavantage: ${String(interval)} (supported: ${SUPPORTED_INTERVALS.join(', ')})`,
  )
}

/** 无 from 时的根数：1..MAX_CANDLES，缺省 100。 */
export function clampCount(n: number | undefined): number {
  const raw = typeof n === 'number' && Number.isFinite(n) ? Math.floor(n) : DEFAULT_CANDLE_COUNT
  return Math.max(1, Math.min(MAX_CANDLES, raw))
}

// ---- 美东时间 → UTC 毫秒 ------------------------------------------------------

const ET_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: ET_TZ, hour12: false,
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
})

interface WallParts { y: number; m: number; d: number; H: number; M: number; S: number }

function etPartsOf(ms: Ms): WallParts {
  const parts = ET_FMT.formatToParts(new Date(ms))
  const pick = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? '0')
  const hour = pick('hour')
  return { y: pick('year'), m: pick('month'), d: pick('day'), H: hour === 24 ? 0 : hour, M: pick('minute'), S: pick('second') }
}

/** 美东挂钟时间相对 UTC 的偏移（EDT 为 −4 h，EST 为 −5 h）。 */
function etOffsetMs(utcMs: Ms): number {
  const p = etPartsOf(utcMs)
  return Date.UTC(p.y, p.m - 1, p.d, p.H, p.M, p.S) - Math.floor(utcMs / 1000) * 1000
}

const WALL = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/

/**
 * Alpha Vantage 的时间戳（`YYYY-MM-DD HH:mm:ss` 或 `YYYY-MM-DD`，美东）→ UTC 毫秒。
 * 迭代两次解出偏移即可覆盖夏令时切换（挂钟 → UTC 是单调的，二次迭代收敛）。
 * 夏令时「跳过」的不存在时刻（春季 02:30）与「重复」的时刻（秋季 01:30）Alpha Vantage 不会给（那时不开市）；
 * 真遇到时按首次迭代的偏移落位，不做额外猜测。
 */
export function etMsOf(wall: string): Ms {
  const m = WALL.exec(wall.trim())
  if (!m) throw problemError('VENUE_UNAVAILABLE', `alphavantage timestamp is not a date: ${JSON.stringify(wall)}`, {
    venue: { id: VENUE, message: 'unexpected timestamp format' },
  })
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  const H = m[4] === undefined ? 0 : Number(m[4])
  const M = m[5] === undefined ? 0 : Number(m[5])
  const S = m[6] === undefined ? 0 : Number(m[6])
  const asUtc = Date.UTC(y, mo - 1, d, H, M, S)
  let t = asUtc - etOffsetMs(asUtc)
  const refined = asUtc - etOffsetMs(t)
  if (refined !== t) t = refined
  return t
}

/** UTC 毫秒 → 美东日期 `YYYY-MM-DD`（盘中切片 month 参数按美东自然月算）。 */
export function etDayOf(ms: Ms): string {
  const p = etPartsOf(ms)
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`
}

/** UTC 毫秒 → 美东自然月 `YYYY-MM`（盘中 `month=` 参数用）。 */
export function etMonthOf(ms: Ms): string {
  return etDayOf(ms).slice(0, 7)
}

/** 美东下一天（按日历日推进，跨月 / 跨年安全）。 */
export function nextDay(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!m) throw problemError('INVALID_PARAMS', `not a YYYY-MM-DD date: ${JSON.stringify(date)}`)
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1)
  const d = new Date(t)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}

/** 下一个月（`YYYY-MM` → 下个月的 `YYYY-MM`）。 */
export function nextMonth(month: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(month)
  if (!m) throw problemError('INVALID_PARAMS', `not a YYYY-MM month: ${JSON.stringify(month)}`)
  const year = Number(m[1])
  const mon = Number(m[2])
  const t = new Date(Date.UTC(year, mon, 1))
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}`
}

// ---- 周 / 月线的时间口径 -------------------------------------------------------

const DAY_MS = 86_400_000

/**
 * 周线 / 月线的键是周期末交易日日期，协议要开盘毫秒：周线取该日期所在周的周一，月线取该月 1 日。
 * 只改日期部分（时间后缀原样保留），随后仍用 etMsOf 按**那一天**的美东偏移折算（夏令时按该日算）。
 */
function periodStartOf(stamp: string, period: SeriesPeriod): string {
  if (period === 'day') return stamp
  const m = /^(\d{4})-(\d{2})-(\d{2})(.*)$/.exec(stamp.trim())
  if (!m) return stamp
  const dayMs = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  const startMs = period === 'week'
    ? dayMs - ((new Date(dayMs).getUTCDay() + 6) % 7) * DAY_MS
    : Date.UTC(Number(m[1]), Number(m[2]) - 1, 1)
  const d = new Date(startMs)
  const head = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
  return `${head}${m[4] ?? ''}`
}

// ---- 上游错误（HTTP 200 里带着） -----------------------------------------------
export type AvFailureKind = 'api-error' | 'rate-limit'

export interface AvFailure {
  kind: AvFailureKind
  message: string
}

/**
 * Alpha Vantage 用 HTTP 200 传错误：
 *   {"Error Message": "Invalid API call. …"}  → 参数 / 标的错误（api-error）
 *   {"Information": "…"} / {"Note": "…"}      → 频率限制或付费档提示（rate-limit；付费由调用侧按文本判 premium）
 * 返回 undefined 表示 body 是正常数据。字段名逐字照官方文档。
 */
export function avFailureOf(body: unknown): AvFailure | undefined {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return undefined
  const b = body as Record<string, unknown>
  const pick = (key: string): string | undefined => {
    const v = b[key]
    return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined
  }
  const error = pick('Error Message')
  if (error !== undefined) return { kind: 'api-error', message: error }
  const info = pick('Information') ?? pick('Note')
  if (info !== undefined) return { kind: 'rate-limit', message: info }
  return undefined
}

// ---- 数值 ----------------------------------------------------------------------

export const num = (v: unknown): number => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? n : NaN
  }
  return NaN
}

// ---- K 线 ----------------------------------------------------------------------

interface RawSeriesRow { '1. open'?: unknown; '2. high'?: unknown; '3. low'?: unknown; '4. close'?: unknown; '5. volume'?: unknown }

/**
 * `{"Time Series (5min)": {"2026-10-20 19:55:00": {"1. open": …}}}` → Candle[]（升序去重）。
 * 键可能是盘中 `YYYY-MM-DD HH:mm:ss`、日 / 周 / 月 `YYYY-MM-DD`；统一按美东折成毫秒。
 * period 决定周 / 月线取哪一天的开盘时刻（见 periodStartOf）；缺字段 / 非数值的行跳过（不编造 0）。
 */
export function parseSeries(raw: unknown, key: string, period: SeriesPeriod = 'day'): Candle[] {
  if (raw === null || typeof raw !== 'object') {
    throw problemError('VENUE_UNAVAILABLE', `alphavantage response is not an object (expected "${key}")`, {
      retryable: true, venue: { id: VENUE, message: 'unexpected payload' },
    })
  }
  const series = (raw as Record<string, unknown>)[key]
  if (series === undefined || series === null) return []
  if (typeof series !== 'object') {
    throw problemError('VENUE_UNAVAILABLE', `alphavantage "${key}" is not an object`, {
      retryable: true, venue: { id: VENUE, message: 'unexpected series shape' },
    })
  }
  const seen = new Map<Ms, Candle>()
  for (const [stamp, row] of Object.entries(series as Record<string, unknown>)) {
    if (row === null || typeof row !== 'object') continue
    const r = row as RawSeriesRow
    const o = num(r['1. open'])
    const h = num(r['2. high'])
    const l = num(r['3. low'])
    const c = num(r['4. close'])
    const v = num(r['5. volume'])
    if (![o, h, l, c, v].every((x) => Number.isFinite(x))) continue
    let t: Ms
    try {
      t = etMsOf(periodStartOf(stamp, period))
    } catch {
      continue
    }
    seen.set(t, { t, o, h, l, c, v })
  }
  return [...seen.values()].sort((a, b) => a.t - b.t)
}

/** 升序去重（同一根在切片 / 翻页边界可能重复）。 */
export function dedupeCandles(candles: Candle[]): Candle[] {
  const seen = new Map<Ms, Candle>()
  for (const candle of candles) seen.set(candle.t, candle)
  return [...seen.values()].sort((a, b) => a.t - b.t)
}

// ---- 报价 ----------------------------------------------------------------------

export interface GlobalQuote {
  symbol: string
  price: number
  open?: number
  high?: number
  low?: number
  volume?: number
  prevClose?: number
  tradingDay?: string
}

/** GLOBAL_QUOTE → 结构化字段；`{"Global Quote": {}}`（未知标的）→ undefined。字段编号照官方文档。 */
export function parseGlobalQuote(raw: unknown): GlobalQuote | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const quote = (raw as Record<string, unknown>)['Global Quote']
  if (quote === null || typeof quote !== 'object') return undefined
  const q = quote as Record<string, unknown>
  const symbol = typeof q['01. symbol'] === 'string' ? q['01. symbol'].trim() : ''
  const price = num(q['05. price'])
  if (symbol === '' || !Number.isFinite(price) || price <= 0) return undefined
  const out: GlobalQuote = { symbol, price }
  const put = (target: 'open' | 'high' | 'low' | 'volume' | 'prevClose', value: unknown): void => {
    const n = num(value)
    if (Number.isFinite(n) && n >= 0) out[target] = n
  }
  put('open', q['02. open'])
  put('high', q['03. high'])
  put('low', q['04. low'])
  put('volume', q['06. volume'])
  put('prevClose', q['08. previous close'])
  const day = q['07. latest trading day']
  if (typeof day === 'string' && day.trim() !== '') out.tradingDay = day.trim()
  return out
}

// ---- 标的清单（LISTING_STATUS 的 CSV） -----------------------------------------

/** 极简 CSV 解析（RFC 4180：双引号包裹、"" 转义、CRLF）；返回行数组，空行丢弃。 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  const endField = (): void => { row.push(field); field = '' }
  const endRow = (): void => { endField(); if (row.some((c) => c.trim() !== '')) rows.push(row); row = [] }
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ } else quoted = false
      } else field += ch
      continue
    }
    if (ch === '"') { quoted = true; continue }
    if (ch === ',') { endField(); continue }
    if (ch === '\n') { endRow(); continue }
    if (ch === '\r') { if (text[i + 1] === '\n') i++; endRow(); continue }
    field += ch
  }
  if (field !== '' || row.length > 0) endRow()
  return rows
}

const STATUS_OF = (status: string): InstrumentStatus => (status.toLowerCase() === 'active' ? 'trading' : 'delisted')

/**
 * LISTING_STATUS CSV → Instrument[]（按 symbol 升序）。
 * 表头逐字照官方文档：symbol,name,exchange,assetType,ipoDate,delistingDate,status。
 * 没有 symbol 的行丢弃；无 name 时 description 省略（不编造）。
 * assetType（Stock / ETF …）放 `marketGroup`（场所内子市场），不改语义。
 */
export function parseListingCsv(text: string, now: Ms): Instrument[] {
  const rows = parseCsv(text)
  const header = rows.shift()?.map((h) => h.trim().toLowerCase()) ?? []
  const col = (name: string): number => header.indexOf(name.toLowerCase())
  const iSymbol = col('symbol')
  if (iSymbol < 0) {
    throw problemError('VENUE_UNAVAILABLE', 'alphavantage LISTING_STATUS returned no symbol column', {
      retryable: true, venue: { id: VENUE, message: 'unexpected csv header' },
    })
  }
  const iName = col('name')
  const iExchange = col('exchange')
  const iType = col('assettype')
  const iStatus = col('status')
  const out: Instrument[] = []
  for (const row of rows) {
    const symbol = (row[iSymbol] ?? '').trim()
    if (symbol === '') continue
    const name = iName >= 0 ? (row[iName] ?? '').trim() : ''
    const exchange = iExchange >= 0 ? (row[iExchange] ?? '').trim() : ''
    const type = iType >= 0 ? (row[iType] ?? '').trim() : ''
    const status = iStatus >= 0 ? (row[iStatus] ?? '').trim() : ''
    const price: InstrumentPriceRule = { maxDecimals: 4 }
    const size: InstrumentSizeRule = { step: asDecimal('1'), decimals: 0, min: asDecimal('1') }
    const instrument: Instrument = {
      instrumentId: instrumentIdOf(symbol),
      venue: VENUE,
      symbol,
      displaySymbol: symbol,
      kind: 'spot',
      base: symbol,
      quote: 'USD',
      settle: 'USD',
      settlement: 'linear',
      contractSize: asDecimal('1'),
      venueSizeUnit: 'base',
      assetClass: 'stocks',
      marketGroup: type !== '' ? type : (exchange !== '' ? exchange : null),
      ...(name !== '' ? { underlying: { description: name, synthetic: false } } : {}),
      status: status === '' ? 'trading' : STATUS_OF(status),
      price,
      size,
      orderTypes: [],
      tif: [],
      triggerPriceTypes: [],
      updatedAt: now,
    }
    out.push(instrument)
  }
  const deduped = new Map<string, Instrument>()
  for (const instrument of out) deduped.set(instrument.instrumentId, instrument)
  return [...deduped.values()].sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0))
}
