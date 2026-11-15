// SPDX-License-Identifier: CPAL-1.0
// Polygon 响应 → 统一模型（纯函数，无状态；不发请求、不读环境）。
//
// 出处：Polygon 官方文档 https://polygon.io/docs/stocks/ （逐端点核对；施工时离线，未联网验证）：
//   标的清单  GET https://api.massive.com/v3/reference/tickers?market=stocks&active=true&limit=&cursor=
//             → { "results": [{ "ticker": "AAPL", "name": "Apple Inc.", "market": "stocks", "locale": "us",
//                  "primary_exchange": "XNAS", "type": "CS", "active": true, "currency_name": "usd", … }],
//                 "status": "OK", "count": 1000, "next_url": "https://api.massive.com/v3/reference/tickers?…&cursor=…" }
//   聚合 K 线 GET https://api.massive.com/v2/aggs/ticker/{stocksTicker}/range/{multiplier}/{timespan}/{from}/{to}
//             ?adjusted=true&sort=asc&limit=50000
//             → { "ticker": "AAPL", "queryCount": 1, "resultsCount": 2, "adjusted": true,
//                 "results": [{ "o", "h", "l", "c", "v", "vw", "t", "n" }], "status": "OK", "request_id": … }
//             timespan ∈ minute | hour | day | week | month | quarter | year；from / to 可写 YYYY-MM-DD 或**毫秒时间戳**。
//   快照      GET https://api.massive.com/v2/snapshot/locale/us/markets/stocks/tickers/{stocksTicker}
//             → { "status": "OK", "ticker": { "ticker": "AAPL", "updated": 1792468…,
//                  "day": {"o","h","l","c","v","vw"}, "prevDay": {"c",…},
//                  "lastTrade": {"p", "s", "t"}, "lastQuote": {"p", "P", "s", "S", "t"} } }
//             **快照里的时间戳是纳秒**（updated / lastTrade.t / lastQuote.t），聚合是毫秒；本包在解析处统一折成毫秒。
//   权限      GET /v1/marketstatus/now → { market: 'open' | 'closed' | 'extended-hours', … }（本包不用：只读行情
//             不按开市时段裁剪请求，避免把「休市无数据」误判成故障）。
//   免费档    ：「5 API calls / minute」，历史深度与盘中聚合需付费套餐；本包不写死套餐能力，按上游 403 / 429 反馈。
//
// 协议形状照 packages/protocol/src/model/instrument.ts：美股现货 kind 'spot'、assetClass 'stocks'、
// quote / settle 'USD'、venueSizeUnit 'base'、contractSize '1'；Candle.t 一律是**开盘毫秒**（Polygon 的 `t` 本来就是毫秒）。
import { asDecimal, makeProblem } from '@gitrader/protocol'
import type {
  Candle, CandleInterval, Instrument, InstrumentPriceRule, InstrumentSizeRule, InstrumentStatus, Ms,
  Problem, ProblemName,
} from '@gitrader/protocol'

export const VENUE = 'polygon'
export const DEFAULT_BASE_URL = 'https://api.massive.com'

/** API Key 从环境变量读（官方示例是 query 的 apiKey；本包改走 Authorization: Bearer 头，不进 URL）。 */
export const API_KEY_ENV = ['POLYGON_API_KEY'] as const

export const TICKERS_PATH = '/v3/reference/tickers'
export const snapshotPath = (symbol: string): string => `/v2/snapshot/locale/us/markets/stocks/tickers/${encodeURIComponent(symbol)}`
export const aggsPath = (symbol: string, multiplier: number, timespan: string, fromMs: Ms, toMs: Ms): string =>
  `/v2/aggs/ticker/${encodeURIComponent(symbol)}/range/${multiplier}/${timespan}/${Math.floor(fromMs)}/${Math.floor(toMs)}`

/** 免费档：5 次/分钟（官方 Pricing / Rate limits 页；施工时离线，待真网核对）。 */
export const RATE_LIMIT = 5
export const RATE_WINDOW_MS: Ms = 60_000
/** 一次请求权重（按次计）。 */
export const REQUEST_WEIGHT = 1

/** 聚合端点单次上限：官方 limit 的最大值是 50000。 */
export const CANDLE_PAGE = 50_000
export const MAX_CANDLES = 50_000
/** 无 from 时的缺省根数（与其它行情包一致）。 */
export const DEFAULT_CANDLE_COUNT = 300
/** 区间分页硬上限（防上游异常时死循环）。 */
export const MAX_PAGES = 200
/** 标的清单默认最多翻多少页（每页 1000 支；免费档 5 次/分钟，翻满 100 页要 20 分钟，可配小）。 */
export const DEFAULT_INSTRUMENT_PAGES = 100

/**
 * 协议周期 → Polygon 的 multiplier / timespan。
 * timespan 只有 minute / hour / day / week / month / quarter / year，multiplier 是正整数倍数，
 * 所以 14 个协议周期全部能表达（这是与 Alpha Vantage 的差别：那边只有 8 个）。
 */
export const INTERVAL_OF: Record<CandleInterval, { multiplier: number; timespan: string }> = {
  '1m': { multiplier: 1, timespan: 'minute' },
  '3m': { multiplier: 3, timespan: 'minute' },
  '5m': { multiplier: 5, timespan: 'minute' },
  '15m': { multiplier: 15, timespan: 'minute' },
  '30m': { multiplier: 30, timespan: 'minute' },
  '1h': { multiplier: 1, timespan: 'hour' },
  '2h': { multiplier: 2, timespan: 'hour' },
  '4h': { multiplier: 4, timespan: 'hour' },
  '8h': { multiplier: 8, timespan: 'hour' },
  '12h': { multiplier: 12, timespan: 'hour' },
  '1d': { multiplier: 1, timespan: 'day' },
  '3d': { multiplier: 3, timespan: 'day' },
  '1w': { multiplier: 1, timespan: 'week' },
  '1M': { multiplier: 1, timespan: 'month' },
}

/** 一周的毫秒数（无 from 时的回看窗口按周取整用）。 */
const DAY_MS = 86_400_000

/** 一根 K 线的名义长度（毫秒）：只用于算「无 from 时的回看窗口」，不参与任何撮合语义。 */
export function barMsOf(interval: CandleInterval): Ms {
  const spec = INTERVAL_OF[interval]
  switch (spec.timespan) {
    case 'minute': return spec.multiplier * 60_000
    case 'hour': return spec.multiplier * 3_600_000
    case 'day': return spec.multiplier * DAY_MS
    case 'week': return spec.multiplier * 7 * DAY_MS
    default: return spec.multiplier * 30 * DAY_MS
  }
}

export const instrumentIdOf = (symbol: string): string => `${VENUE}:${symbol}`

/** `polygon:AAPL` → 场所原生 symbol（原样保留大小写，BRK.B 不改写）；不是本场所的 id 就拒绝。 */
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

/** interval → Polygon 的 multiplier / timespan；不在表里直接 INVALID_PARAMS（不发请求）。 */
export function intervalSpecOf(interval: CandleInterval): { multiplier: number; timespan: string } {
  const spec = INTERVAL_OF[interval]
  if (!spec) throw problemError('INVALID_PARAMS', `unsupported candle interval for polygon: ${String(interval)}`)
  return spec
}

/** 无 from 时的根数：1..50000，缺省 300。 */
export function clampCount(n: number | undefined): number {
  const raw = typeof n === 'number' && Number.isFinite(n) ? Math.floor(n) : DEFAULT_CANDLE_COUNT
  return Math.max(1, Math.min(MAX_CANDLES, raw))
}

export const num = (v: unknown): number => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? n : NaN
  }
  return NaN
}

/** 纳秒时间戳 → 毫秒（Polygon 快照的时间戳是纳秒）。不是正数就 NaN。 */
export function nsToMs(v: unknown): number {
  const ns = num(v)
  if (!Number.isFinite(ns) || ns <= 0) return NaN
  return Math.round(ns / 1e6)
}

/**
 * 时间戳 → 毫秒，按量级判单位：≥ 1e15 当纳秒（Polygon 快照）、≥ 1e11 当毫秒、其余当秒（防御性）。
 * 纳秒 epoch（约 1.8e18）超过 2^53，JSON 往返后 ±256 ns 的误差靠 round 到毫秒消掉。
 */
export function epochMsOf(v: unknown): number {
  const n = num(v)
  if (!Number.isFinite(n) || n <= 0) return NaN
  if (n >= 1e15) return Math.round(n / 1e6)
  if (n >= 1e11) return Math.round(n)
  return Math.round(n * 1000)
}

// ---- 上游失败体 ----------------------------------------------------------------

export interface PolygonFailure {
  status: string
  message: string
}

/**
 * Polygon 的错误体：`{"status": "ERROR", "error": "…", "request_id": "…"}`（HTTP 码通常也非 2xx，
 * 但 200 + ERROR 的形态存在，所以照 Alpha Vantage 的做法两头都判）。
 */
export function polygonFailureOf(body: unknown): PolygonFailure | undefined {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return undefined
  const b = body as Record<string, unknown>
  const status = typeof b.status === 'string' ? b.status : ''
  if (status !== 'ERROR' && status !== 'NOT_AUTHORIZED') return undefined
  const message = typeof b.error === 'string' ? b.error : (typeof b.message === 'string' ? b.message : 'unknown error')
  return { status, message }
}

// ---- 标的清单 ------------------------------------------------------------------

interface RawTicker {
  ticker?: unknown
  name?: unknown
  market?: unknown
  locale?: unknown
  primary_exchange?: unknown
  type?: unknown
  active?: unknown
  currency_name?: unknown
}

export interface TickerPage {
  instruments: Instrument[]
  /** 下一页游标（来自 next_url 的 cursor 参数）；没有下一页就 undefined。 */
  cursor: string | undefined
}

/** next_url → cursor（Polygon 翻页只认 cursor；不直接跟随 next_url，免得绕过注入的基址）。 */
export function cursorOf(nextUrl: unknown): string | undefined {
  if (typeof nextUrl !== 'string' || nextUrl.trim() === '') return undefined
  try {
    const url = new URL(nextUrl)
    const cursor = url.searchParams.get('cursor')
    return cursor === null || cursor === '' ? undefined : cursor
  } catch {
    return undefined
  }
}

/**
 * /v3/reference/tickers 一页 → 标的 + 下一页游标。
 * 只收 `market: "stocks"`、`locale: "us"` 的行（外汇 / 加密 / 期权是别的端点，进来就是上游变了，丢弃而不是硬映射）；
 * `active: false` → 'delisted'。currency_name 大写进 quote / settle（官方给 "usd"）。
 */
export function parseTickerPage(raw: unknown, now: Ms): TickerPage {
  if (raw === null || typeof raw !== 'object') {
    throw problemError('VENUE_UNAVAILABLE', 'polygon tickers response is not an object', {
      retryable: true, venue: { id: VENUE, message: 'unexpected payload' },
    })
  }
  const page = raw as { results?: unknown; next_url?: unknown }
  const rows = Array.isArray(page.results) ? page.results : []
  const price: InstrumentPriceRule = { maxDecimals: 4 }
  const size: InstrumentSizeRule = { step: asDecimal('1'), decimals: 0, min: asDecimal('1') }
  const instruments: Instrument[] = []
  for (const row of rows as unknown[]) {
    if (row === null || typeof row !== 'object') continue
    const t = row as RawTicker
    const symbol = typeof t.ticker === 'string' ? t.ticker.trim() : ''
    if (symbol === '') continue
    const market = typeof t.market === 'string' ? t.market : 'stocks'
    const locale = typeof t.locale === 'string' ? t.locale : 'us'
    if (market !== 'stocks' || locale !== 'us') continue
    const name = typeof t.name === 'string' ? t.name.trim() : ''
    const currency = typeof t.currency_name === 'string' && t.currency_name.trim() !== ''
      ? t.currency_name.trim().toUpperCase()
      : 'USD'
    const exchange = typeof t.primary_exchange === 'string' ? t.primary_exchange.trim() : ''
    const type = typeof t.type === 'string' ? t.type.trim() : ''
    const status: InstrumentStatus = t.active === false ? 'delisted' : 'trading'
    instruments.push({
      instrumentId: instrumentIdOf(symbol),
      venue: VENUE,
      symbol,
      displaySymbol: symbol,
      kind: 'spot',
      base: symbol,
      quote: currency,
      settle: currency,
      settlement: 'linear',
      contractSize: asDecimal('1'),
      venueSizeUnit: 'base',
      assetClass: 'stocks',
      marketGroup: exchange !== '' ? exchange : (type !== '' ? type : null),
      ...(name !== '' ? { underlying: { description: name, synthetic: false } } : {}),
      status,
      price,
      size,
      orderTypes: [],
      tif: [],
      triggerPriceTypes: [],
      updatedAt: now,
    })
  }
  return { instruments, cursor: cursorOf(page.next_url) }
}

// ---- 聚合 K 线 -----------------------------------------------------------------

interface RawAgg {
  o?: unknown
  h?: unknown
  l?: unknown
  c?: unknown
  v?: unknown
  vw?: unknown
  t?: unknown
}

/** /v2/aggs results → Candle[]（升序去重，t 已是毫秒开盘时间）；坏行跳过、vw 有就填 vwap。 */
export function parseAggs(raw: unknown): Candle[] {
  if (raw === null || typeof raw !== 'object') {
    throw problemError('VENUE_UNAVAILABLE', 'polygon aggregates response is not an object', {
      retryable: true, venue: { id: VENUE, message: 'unexpected payload' },
    })
  }
  const rows = Array.isArray((raw as { results?: unknown }).results) ? (raw as { results: unknown[] }).results : []
  const seen = new Map<Ms, Candle>()
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue
    const r = row as RawAgg
    const t = num(r.t)
    const o = num(r.o)
    const h = num(r.h)
    const l = num(r.l)
    const c = num(r.c)
    const v = num(r.v)
    if (![t, o, h, l, c, v].every((x) => Number.isFinite(x)) || t <= 0) continue
    const candle: Candle = { t: Math.floor(t), o, h, l, c, v }
    const vwap = num(r.vw)
    if (Number.isFinite(vwap) && vwap > 0) candle.vwap = vwap
    seen.set(candle.t, candle)
  }
  return [...seen.values()].sort((a, b) => a.t - b.t)
}

/** 本页是否还有下一页（results 达到 limit 或 resultsCount 等于 limit 时按「可能还有」处理）。 */
export function mayHaveMore(raw: unknown, returned: number, limit: number): boolean {
  if (returned >= limit) return true
  if (raw !== null && typeof raw === 'object') {
    const count = num((raw as { resultsCount?: unknown }).resultsCount)
    if (Number.isFinite(count) && count >= limit) return true
  }
  return false
}

// ---- 快照（报价 / 盘口 / context） ---------------------------------------------

export interface SnapshotQuote {
  ts: Ms
  bid: number
  ask: number
  bidSize?: number
  askSize?: number
  last?: number
  prevClose?: number
  dayVolume?: number
  dayVwap?: number
}

/**
 * 快照 → 报价字段。取 lastQuote 的 p（bid）/ P（ask），lastTrade.p（最新成交），prevDay.c（昨收），
 * day.v / day.vw（当日量与 VWAP）。时间戳按纳秒折毫秒：优先 lastQuote.t，其次 lastTrade.t，最后 updated。
 * bid / ask 任一缺失或非正 → undefined（不造单边报价）。
 */
export function parseSnapshot(raw: unknown): SnapshotQuote | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const ticker = (raw as { ticker?: unknown }).ticker
  if (ticker === null || typeof ticker !== 'object') return undefined
  const t = ticker as {
    updated?: unknown
    day?: unknown
    prevDay?: unknown
    lastTrade?: unknown
    lastQuote?: unknown
  }
  const quote = t.lastQuote !== null && typeof t.lastQuote === 'object'
    ? (t.lastQuote as { p?: unknown; P?: unknown; s?: unknown; S?: unknown; t?: unknown })
    : {}
  const trade = t.lastTrade !== null && typeof t.lastTrade === 'object'
    ? (t.lastTrade as { p?: unknown; t?: unknown })
    : {}
  const bid = num(quote.p)
  const ask = num(quote.P)
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0) return undefined

  const day = t.day !== null && typeof t.day === 'object' ? (t.day as { v?: unknown; vw?: unknown }) : {}
  const prevDay = t.prevDay !== null && typeof t.prevDay === 'object' ? (t.prevDay as { c?: unknown }) : {}

  // 报价自己的时间戳优先（快照里的 updated 可能比 lastQuote 晚，混用会让 ageMs 偏小）
  const candidates = [quote.t, trade.t, t.updated].map(epochMsOf).filter((x) => Number.isFinite(x) && x > 0)
  const ts = candidates.length > 0 ? candidates[0]! : NaN
  if (!Number.isFinite(ts)) return undefined

  const out: SnapshotQuote = { ts, bid, ask }
  const bidSize = num(quote.s)
  if (Number.isFinite(bidSize) && bidSize > 0) out.bidSize = bidSize
  const askSize = num(quote.S)
  if (Number.isFinite(askSize) && askSize > 0) out.askSize = askSize
  const last = num(trade.p)
  if (Number.isFinite(last) && last > 0) out.last = last
  const prevClose = num(prevDay.c)
  if (Number.isFinite(prevClose) && prevClose > 0) out.prevClose = prevClose
  const dayVolume = num(day.v)
  if (Number.isFinite(dayVolume) && dayVolume > 0) out.dayVolume = dayVolume
  const dayVwap = num(day.vw)
  if (Number.isFinite(dayVwap) && dayVwap > 0) out.dayVwap = dayVwap
  return out
}
