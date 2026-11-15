// SPDX-License-Identifier: CPAL-1.0
// Finnhub 响应 → 统一模型（纯函数，无状态；不发请求、不读环境）。
// 出处（官方文档；本机离线施工，端点为按文档逐条核对，未联网验证，夹具为手写）：
//   鉴权      请求头 `X-Finnhub-Token: <api key>`
//             https://finnhub.io/docs/api/authentication （文档同时允许 `token` 查询参数；
//             本包只用请求头，密钥不进 URL、不进日志、不进错误信息）
//   标的清单  GET /stock/symbol?exchange=US
//             → [{currency, description, displaySymbol, figi, isin, mic, shareClassFIGI, symbol, symbol2, type}]
//             https://finnhub.io/docs/api/stock-symbols
//   K 线      GET /stock/candle?symbol=&resolution=&from=&to=
//             → {c[], h[], l[], o[], s, t[], v[]}，s = "ok" | "no_data"，t 为**秒**；官方标为 Premium Access Required
//             resolution ∈ {1, 5, 15, 30, 60, D, W, M}
//             https://finnhub.io/docs/api/stock-candles
//   实时报价  GET /quote?symbol=
//             → {c, d, dp, h, l, o, pc, t}（当前价 / 涨跌 / 涨跌幅 / 最高 / 最低 / 开盘 / 昨收 / 秒级时间戳）
//             https://finnhub.io/docs/api/quote
//   买卖盘    GET /stock/bidask?symbol=
//             → {a, av, b, bv, t}（卖价 a / 卖量 av / 买价 b / 买量 bv / 秒级时间戳；官方标为付费档端点）
//             https://finnhub.io/docs/api/bidask
//   市场状态  GET /stock/market-status?exchange=US
//             → {exchange, holiday, isOpen, session, t, timezone}，session ∈ pre-market|regular|post-market|closed
//             https://finnhub.io/docs/api/market-status
//   休市日历  GET /stock/market-holiday?exchange=US
//             → {data: [{atDate, eventName, tradingHour}]}（tradingHour 形如 "09:30-13:00"，即提前收盘日）
//             https://finnhub.io/docs/api/market-holiday
// 形状照 packages/protocol/src/model/instrument.ts：美股 kind 'spot'、assetClass 'stocks'、quote / settle 取标的
// 的 currency（缺省 USD）、venueSizeUnit 'base'、contractSize '1'。
// 协议缺口（写在 REPORT）：Finnhub 没有「交易日历含开盘收盘时间」的端点，所以 sessions 的常规时段由
// buildSessions() 按美股常规交易时段生成（可配），日期级例外（休市 / 提前收盘）由 marketHolidays() 原样暴露。
import { asDecimal, makeProblem } from '@gitrader/protocol'
import type {
  Candle, CandleInterval, Instrument, InstrumentPriceRule, InstrumentSizeRule, Ms, Problem, ProblemName, TradingSessionWindow,
} from '@gitrader/protocol'

export const VENUE = 'finnhub'
/** 公开 REST 缺省基址（官方文档：https://finnhub.io/docs/api）。 */
export const DEFAULT_BASE_URL = 'https://finnhub.io/api/v1'
/** 密钥环境变量名（README 首段同款）。 */
export const API_KEY_ENV = 'FINNHUB_API_KEY'
/** 免费档限流：60 次 API 调用 / 分钟（官方 https://finnhub.io/docs/api/rate-limit）。 */
export const RATE_LIMIT = 60
export const RATE_WINDOW_MS: Ms = 60_000
/** 每次请求的计次权重（Finnhub 按调用次数计，不按权重）。 */
export const REQUEST_WEIGHT = 1
/** 一次 K 线请求覆盖的根数：官方未声明单次上限，本包按「5000 × interval」的时间窗推进。 */
export const MAX_CANDLES = 5000
export const CANDLE_PAGE = 5000
/** 区间翻页硬上限，防上游异常时死循环。 */
export const MAX_PAGES = 200
/** 无 from 时的缺省根数。 */
export const DEFAULT_CANDLE_COUNT = 300
/** 美股常规时段所在时区（sessions 的 tz）。 */
export const NY_TZ = 'America/New_York'

/** 协议区间 → 毫秒（本地翻页游标按它推进；与协议 CANDLE_INTERVALS 一一对应）。 */
export const INTERVAL_MS: Record<CandleInterval, number> = {
  '1m': 60_000, '3m': 180_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000,
  '1h': 3_600_000, '2h': 7_200_000, '4h': 14_400_000, '8h': 28_800_000, '12h': 43_200_000,
  '1d': 86_400_000, '3d': 259_200_000, '1w': 604_800_000, '1M': 2_592_000_000,
}

/**
 * 协议区间 → Finnhub resolution。官方只给 1 / 5 / 15 / 30 / 60 / D / W / M 八档，
 * 协议里的 3m / 2h / 4h / 8h / 12h / 3d 没有对应写法 → 直接 INVALID_PARAMS，不发请求、不静默近似。
 */
export const RESOLUTION_OF: Partial<Record<CandleInterval, string>> = {
  '1m': '1', '5m': '5', '15m': '15', '30m': '30', '1h': '60', '1d': 'D', '1w': 'W', '1M': 'M',
}

export const SUPPORTED_INTERVALS = Object.keys(RESOLUTION_OF) as CandleInterval[]

export const instrumentIdOf = (symbol: string): string => `${VENUE}:${symbol}`

/** `finnhub:AAPL` → 场所原生 symbol（原样保留大小写：BRK.B 不改成 BRK/B）；不是本场所的 id 就拒绝。 */
export function symbolOf(instrumentId: string): string {
  const i = instrumentId.indexOf(':')
  if (i <= 0 || i === instrumentId.length - 1 || instrumentId.slice(0, i) !== VENUE) {
    throw problemError('INVALID_PARAMS', `not a ${VENUE} instrument id: ${JSON.stringify(instrumentId)}`)
  }
  return instrumentId.slice(i + 1)
}

export function resolutionOf(interval: CandleInterval): string {
  const resolution = RESOLUTION_OF[interval]
  if (!resolution) {
    throw problemError(
      'INVALID_PARAMS',
      `unsupported candle interval for finnhub: ${String(interval)} (official resolutions: ${SUPPORTED_INTERVALS.join(', ')})`,
    )
  }
  return resolution
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

// ---- 小工具 --------------------------------------------------------------------

export const num = (v: unknown): number => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN
  if (typeof v !== 'string' || v.trim() === '') return NaN
  const n = Number(v)
  return Number.isFinite(n) ? n : NaN
}

/** 上游时间戳是**秒**（可带小数）→ 整数毫秒；非法返回 NaN。 */
export function secondsToMs(v: unknown): number {
  const s = num(v)
  return Number.isFinite(s) && s > 0 ? Math.round(s * 1000) : NaN
}

// ---- 密钥（只比存在性，不打印、不落盘、不进断言） ------------------------------

export interface FinnhubCredentialInput {
  apiKey?: string
  /** 环境变量来源（缺省 process.env；测试注入假对象，不读真环境）。 */
  env?: Record<string, string | undefined>
}

export interface FinnhubCredentials {
  apiKey: string
}

/**
 * 取密钥：构造参数优先，其次环境变量 `FINNHUB_API_KEY`。
 * 没有密钥直接拒绝（Finnhub 所有端点都要 key，没有匿名可用的行情）；
 * 错误信息只出现变量名，不出现任何密钥内容。
 */
export function resolveCredentials(o: FinnhubCredentialInput = {}): FinnhubCredentials {
  const env = o.env ?? (typeof process === 'undefined' ? {} : process.env)
  const apiKey = firstNonEmpty(o.apiKey, env[API_KEY_ENV])
  if (apiKey === undefined) {
    throw problemError('INVALID_PARAMS', `finnhub data connector needs an API key (set ${API_KEY_ENV} or pass apiKey)`)
  }
  return { apiKey }
}

/** 鉴权请求头（Finnhub：`X-Finnhub-Token`）；密钥只在这一个地方出现。 */
export function authHeaders(c: FinnhubCredentials): Record<string, string> {
  return { 'X-Finnhub-Token': c.apiKey }
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return undefined
}

// ---- 时段（sessions） ----------------------------------------------------------

export interface SessionBuildOptions {
  /** 常规时段开盘（纽约本地 HH:mm），缺省 09:30。 */
  regularOpen?: string
  /** 常规时段收盘（纽约本地 HH:mm），缺省 16:00。 */
  regularClose?: string
  /** 是否另列盘前 / 盘后窗口（quality 'thin'），缺省关：Finnhub 不给时段，扩展时段由调用方显式开启。 */
  extendedHours?: boolean
  preOpen?: string
  postClose?: string
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/

function hhmmOf(v: string | undefined, fallback: string, label: string): string {
  const value = v ?? fallback
  if (!HHMM.test(value)) {
    throw problemError('INVALID_PARAMS', `finnhub ${label} must be HH:mm (got ${JSON.stringify(value)})`)
  }
  return value
}

/**
 * 美股周模板：周一至周五，常规时段（缺省 09:30–16:00 纽约本地，可配）。
 * Finnhub 没有「日历含开收盘时间」的端点，所以这里给的是市场惯例时段而不是接口值；
 * 日期级例外走 marketHolidays()（休市与提前收盘日），REPORT 已登记为协议缺口。
 */
export function buildSessions(o: SessionBuildOptions = {}): { tz: string; windows: TradingSessionWindow[] } {
  const open = hhmmOf(o.regularOpen, '09:30', 'regularOpen')
  const close = hhmmOf(o.regularClose, '16:00', 'regularClose')
  if (open >= close) {
    throw problemError('INVALID_PARAMS', `finnhub regularOpen ${open} must be earlier than regularClose ${close}`)
  }
  const days = [1, 2, 3, 4, 5]
  const windows: TradingSessionWindow[] = []
  if (o.extendedHours === true) {
    const preOpen = hhmmOf(o.preOpen, '04:00', 'preOpen')
    const postClose = hhmmOf(o.postClose, '20:00', 'postClose')
    if (preOpen < open) windows.push({ days, from: preOpen, to: open, quality: 'thin' })
    windows.push({ days, from: open, to: close, quality: 'regular' })
    if (postClose > close) windows.push({ days, from: close, to: postClose, quality: 'thin' })
  } else {
    windows.push({ days, from: open, to: close, quality: 'regular' })
  }
  return { tz: NY_TZ, windows }
}

// ---- 标的（/stock/symbol） ------------------------------------------------------

export interface RawSymbolRow {
  currency?: unknown
  description?: unknown
  displaySymbol?: unknown
  symbol?: unknown
  type?: unknown
  mic?: unknown
}

/**
 * 一行 /stock/symbol → Instrument。
 * - symbol 为空的行丢弃；`currency` 缺省按 USD（US 交易所的官方字段，缺字段时取市场惯例）。
 * - 美股最小报价单位随价格档位变化，协议没有分档字段 → 只填 maxDecimals 4，不写死 tick。
 * - 数量按整数股：step '1' / decimals 0 / min '1'；Finnhub 不提供交易规则字段。
 */
export function parseInstrument(
  row: RawSymbolRow,
  now: Ms,
  sessions: { tz: string; windows: TradingSessionWindow[] },
): Instrument | undefined {
  if (!row || typeof row !== 'object') return undefined
  const symbol = typeof row.symbol === 'string' && row.symbol.trim() !== '' ? row.symbol.trim() : undefined
  if (!symbol) return undefined
  const currency = typeof row.currency === 'string' && row.currency.trim() !== '' ? row.currency.trim().toUpperCase() : 'USD'
  const description = typeof row.description === 'string' && row.description.trim() !== '' ? row.description.trim() : undefined
  const displaySymbol = typeof row.displaySymbol === 'string' && row.displaySymbol.trim() !== '' ? row.displaySymbol.trim() : symbol
  const price: InstrumentPriceRule = { maxDecimals: 4 }
  const size: InstrumentSizeRule = { step: asDecimal('1'), decimals: 0, min: asDecimal('1') }
  return {
    instrumentId: instrumentIdOf(symbol),
    venue: VENUE,
    symbol,
    displaySymbol,
    kind: 'spot',
    base: symbol,
    quote: currency,
    settle: currency,
    settlement: 'linear',
    contractSize: asDecimal('1'),
    venueSizeUnit: 'base',
    assetClass: 'stocks',
    marketGroup: null,
    ...(description !== undefined ? { underlying: { description, synthetic: false } } : {}),
    status: 'trading',
    price,
    size,
    // 只读数据连接器：不下单，所以标的层面也不声明任何可下单类型
    orderTypes: [],
    tif: [],
    triggerPriceTypes: [],
    sessions,
    updatedAt: now,
  }
}

/** /stock/symbol 数组 → 标的（按 symbol 升序；无 symbol / 非对象行丢弃）。 */
export function parseSymbols(raw: unknown, now: Ms, sessions: { tz: string; windows: TradingSessionWindow[] }): Instrument[] {
  if (!Array.isArray(raw)) {
    throw problemError('VENUE_UNAVAILABLE', `${VENUE} /stock/symbol returned no array`, {
      retryable: true,
      venue: { id: VENUE, message: 'invalid symbol payload' },
    })
  }
  const out: Instrument[] = []
  for (const row of raw as unknown[]) {
    if (!row || typeof row !== 'object') continue
    const instrument = parseInstrument(row as RawSymbolRow, now, sessions)
    if (instrument) out.push(instrument)
  }
  return out.sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0))
}

// ---- K 线（/stock/candle，列式返回） ---------------------------------------------

export interface RawCandleSeries {
  c?: unknown
  h?: unknown
  l?: unknown
  o?: unknown
  s?: unknown
  t?: unknown
  v?: unknown
}

/**
 * {c,h,l,o,s,t,v} 列式 → Candle[]（t 为**开盘毫秒**，上游给秒要 ×1000）。
 * `s !== 'ok'`（官方 `no_data`）→ 空数组，不猜。列长不一致时按最短列对齐。
 */
export function parseCandles(raw: unknown): Candle[] {
  if (!raw || typeof raw !== 'object') return []
  const series = raw as RawCandleSeries
  if (series.s !== 'ok') return []
  const t = Array.isArray(series.t) ? series.t : []
  const o = Array.isArray(series.o) ? series.o : []
  const h = Array.isArray(series.h) ? series.h : []
  const l = Array.isArray(series.l) ? series.l : []
  const c = Array.isArray(series.c) ? series.c : []
  const v = Array.isArray(series.v) ? series.v : []
  const n = Math.min(t.length, o.length, h.length, l.length, c.length, v.length)
  const out: Candle[] = []
  for (let i = 0; i < n; i++) {
    const ts = secondsToMs(t[i])
    const open = num(o[i])
    const high = num(h[i])
    const low = num(l[i])
    const close = num(c[i])
    const volume = num(v[i])
    if (![ts, open, high, low, close, volume].every((x) => Number.isFinite(x))) continue
    out.push({ t: ts, o: open, h: high, l: low, c: close, v: volume })
  }
  return out
}

// ---- 报价（/quote、/stock/bidask） ----------------------------------------------

export interface RawQuote {
  c?: unknown
  d?: unknown
  dp?: unknown
  h?: unknown
  l?: unknown
  o?: unknown
  pc?: unknown
  t?: unknown
}

export interface LastTradeQuote {
  ts: Ms
  last: number
  open?: number
  high?: number
  low?: number
  prevClose?: number
}

/** /quote → 最新成交价 + 当日高低 / 昨收。`c <= 0`（无行情）视为没有报价。 */
export function parseQuote(raw: unknown): LastTradeQuote | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const q = raw as RawQuote
  const last = num(q.c)
  if (!(last > 0)) return undefined
  const ts = secondsToMs(q.t)
  const out: LastTradeQuote = { ts: Number.isFinite(ts) ? ts : 0, last }
  const open = num(q.o)
  const high = num(q.h)
  const low = num(q.l)
  const prevClose = num(q.pc)
  if (open > 0) out.open = open
  if (high > 0) out.high = high
  if (low > 0) out.low = low
  if (prevClose > 0) out.prevClose = prevClose
  return out
}

export interface RawBidAsk {
  a?: unknown
  av?: unknown
  b?: unknown
  bv?: unknown
  t?: unknown
}

export interface TopOfBook {
  ts: Ms
  bid: number
  ask: number
  bidSize?: number
  askSize?: number
}

/** /stock/bidask → 最优一档（付费档端点；免费 key 会拿到 403 → VENUE_AUTH）。买卖价缺一或非正视为没有。 */
export function parseBidAsk(raw: unknown): TopOfBook | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as RawBidAsk
  const bid = num(r.b)
  const ask = num(r.a)
  if (!(bid > 0) || !(ask > 0)) return undefined
  const ts = secondsToMs(r.t)
  const out: TopOfBook = { ts: Number.isFinite(ts) ? ts : 0, bid, ask }
  const bidSize = num(r.bv)
  const askSize = num(r.av)
  if (bidSize > 0) out.bidSize = bidSize
  if (askSize > 0) out.askSize = askSize
  return out
}

// ---- 市场状态 / 休市（/stock/market-status、/stock/market-holiday） -------------

export interface RawMarketStatus {
  exchange?: unknown
  holiday?: unknown
  isOpen?: unknown
  session?: unknown
  t?: unknown
  timezone?: unknown
}

export interface MarketState {
  exchange: string
  isOpen: boolean
  session: string
  ts: Ms
  holiday: string | null
  timezone: string | null
}

/**
 * /stock/market-status → MarketState。session 取值 pre-market / regular / post-market / closed；
 * 不认识的取值原样保留（上游加了新状态时不至于误判成开市）。
 */
export function parseMarketStatus(raw: unknown): MarketState {
  if (!raw || typeof raw !== 'object') {
    throw problemError('VENUE_UNAVAILABLE', `${VENUE} /stock/market-status returned no object`, {
      retryable: true,
      venue: { id: VENUE, message: 'invalid market status payload' },
    })
  }
  const s = raw as RawMarketStatus
  const ts = secondsToMs(s.t)
  return {
    exchange: typeof s.exchange === 'string' ? s.exchange : '',
    isOpen: s.isOpen === true,
    session: typeof s.session === 'string' ? s.session : 'closed',
    ts: Number.isFinite(ts) ? ts : 0,
    holiday: typeof s.holiday === 'string' && s.holiday !== '' ? s.holiday : null,
    timezone: typeof s.timezone === 'string' && s.timezone !== '' ? s.timezone : null,
  }
}

export interface RawHolidayRow {
  atDate?: unknown
  eventName?: unknown
  tradingHour?: unknown
}

export interface MarketHoliday {
  date: string
  event: string
  tradingHour: string | null
}

/** /stock/market-holiday → [{date, event, tradingHour}]（按日期升序；日期不是 YYYY-MM-DD 的行跳过）。 */
export function parseMarketHolidays(raw: unknown): MarketHoliday[] {
  const rows = raw && typeof raw === 'object' && Array.isArray((raw as { data?: unknown }).data) ? (raw as { data: unknown[] }).data : []
  const out: MarketHoliday[] = []
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const r = row as RawHolidayRow
    if (typeof r.atDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(r.atDate)) continue
    out.push({
      date: r.atDate,
      event: typeof r.eventName === 'string' ? r.eventName : '',
      tradingHour: typeof r.tradingHour === 'string' && r.tradingHour !== '' ? r.tradingHour : null,
    })
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
}

// ---- 根数钳位 / 去重 ------------------------------------------------------------

/** 无 from 时的根数：1..5000，缺省 300。 */
export function clampCount(n: number | undefined): number {
  const raw = typeof n === 'number' && Number.isFinite(n) ? Math.floor(n) : DEFAULT_CANDLE_COUNT
  return Math.max(1, Math.min(MAX_CANDLES, raw))
}

/** 升序去重（同一根 K 线在翻页边界可能重复）。 */
export function dedupeCandles(candles: Candle[]): Candle[] {
  const seen = new Map<Ms, Candle>()
  for (const candle of candles) seen.set(candle.t, candle)
  return [...seen.values()].sort((a, b) => a.t - b.t)
}
