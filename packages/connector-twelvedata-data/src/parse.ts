// SPDX-License-Identifier: CPAL-1.0
// Twelve Data 响应 → 统一模型（纯函数，无状态；不发请求、不读环境）。
// 出处（官方文档；本机离线施工，端点为按文档逐条核对，未联网验证，夹具为手写）：
//   鉴权      请求头 `Authorization: apikey <api key>`（官方 Authentication 同时允许 `apikey` 查询参数；
//             本包只用请求头，密钥不进 URL、不进日志、不进错误信息）
//             https://twelvedata.com/docs#authentication
//   标的清单  GET /stocks?exchange=NASDAQ
//             → {data: [{symbol, name, currency, exchange, mic_code, type}], status: "ok"}
//             https://twelvedata.com/docs#stocks-list
//   K 线      GET /time_series?symbol=&interval=&outputsize=&order=&timezone=
//             → {meta: {symbol, interval, currency, exchange, exchange_timezone, type, mic_code},
//                values: [{datetime, open, high, low, close, volume}], status: "ok"}
//             interval ∈ {1min,5min,15min,30min,45min,1h,2h,4h,8h,1day,1week,1month}；outputsize 上限 5000；
//             缺省 order=desc（最新在前）；`timezone` 可取 UTC（缺省是交易所时区）
//             https://twelvedata.com/docs#time-series
//   实时报价  GET /quote?symbol=
//             → {symbol, name, exchange, mic_code, currency, datetime, timestamp, open, high, low, close,
//                volume, previous_close, change, percent_change, average_volume, is_market_open,
//                fifty_two_week: {low, high, change, change_percent}}
//             https://twelvedata.com/docs#quote
//   市场状态  GET /market_state?exchange=NASDAQ
//             → [{name, code, country, is_market_open, time_after_open, time_to_open, time_to_close}]（顶层是数组）
//             https://twelvedata.com/docs#market-state
//   错误形状  {code, message, status: "error"}（400 / 401 / 404 / 429 等）
//             https://twelvedata.com/docs#errors
// 形状照 packages/protocol/src/model/instrument.ts：股票 kind 'spot'、assetClass 'stocks'、quote / settle 取标的
// 的 currency（缺省 USD）、venueSizeUnit 'base'、contractSize '1'、marketGroup 记 mic_code 所属交易所。
// 协议缺口（写在 REPORT）：Twelve Data 没有「带开收盘时间的交易日历」，/market_state 只给
// is_market_open 与倒计时，所以 sessions 由 buildSessions() 按时段惯例生成（可配），权威开市判断走 marketState()。
import { asDecimal, makeProblem } from '@gitrader/protocol'
import type {
  Candle, CandleInterval, Instrument, InstrumentPriceRule, InstrumentSizeRule, Ms, Problem, ProblemName, TradingSessionWindow,
} from '@gitrader/protocol'

export const VENUE = 'twelvedata'
/** 公开 REST 缺省基址（官方文档：https://twelvedata.com/docs）。 */
export const DEFAULT_BASE_URL = 'https://api.twelvedata.com'
/** 密钥环境变量名（README 首段同款）。 */
export const API_KEY_ENV = 'TWELVEDATA_API_KEY'
/** 免费档限流：8 API credits / 分钟、800 / 天（官方 https://twelvedata.com/pricing）。 */
export const RATE_LIMIT = 8
export const RATE_WINDOW_MS: Ms = 60_000
export const DAILY_CREDIT_LIMIT = 800
export const DAILY_WINDOW_MS: Ms = 86_400_000
/** 一次调用消耗 1 个 credit（普通端点）。 */
export const REQUEST_WEIGHT = 1
/** 官方 outputsize 上限与本包单页根数。 */
export const MAX_CANDLES = 5000
export const CANDLE_PAGE = 5000
/** 区间翻页硬上限，防上游异常时死循环。 */
export const MAX_PAGES = 200
/** 无 from 时的缺省根数。 */
export const DEFAULT_CANDLE_COUNT = 300
export const NY_TZ = 'America/New_York'

/** 协议区间 → 毫秒（翻页游标按它推进）。 */
export const INTERVAL_MS: Record<CandleInterval, number> = {
  '1m': 60_000, '3m': 180_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000,
  '1h': 3_600_000, '2h': 7_200_000, '4h': 14_400_000, '8h': 28_800_000, '12h': 43_200_000,
  '1d': 86_400_000, '3d': 259_200_000, '1w': 604_800_000, '1M': 2_592_000_000,
}

/**
 * 协议区间 → Twelve Data interval。官方没有 3 分钟 / 12 小时 / 3 天这几档
 * （另有 45min，协议里没有对应区间），所以这些区间直接 INVALID_PARAMS，不静默近似。
 */
export const INTERVAL_OF: Partial<Record<CandleInterval, string>> = {
  '1m': '1min', '5m': '5min', '15m': '15min', '30m': '30min',
  '1h': '1h', '2h': '2h', '4h': '4h', '8h': '8h', '1d': '1day', '1w': '1week', '1M': '1month',
}

export const SUPPORTED_INTERVALS = Object.keys(INTERVAL_OF) as CandleInterval[]

export const instrumentIdOf = (symbol: string): string => `${VENUE}:${symbol}`

/** `twelvedata:AAPL` → 场所原生 symbol（原样保留大小写与交易所后缀，如 BRK.B / 0700.HK）；不是本场所的 id 就拒绝。 */
export function symbolOf(instrumentId: string): string {
  const i = instrumentId.indexOf(':')
  if (i <= 0 || i === instrumentId.length - 1 || instrumentId.slice(0, i) !== VENUE) {
    throw problemError('INVALID_PARAMS', `not a ${VENUE} instrument id: ${JSON.stringify(instrumentId)}`)
  }
  return instrumentId.slice(i + 1)
}

export function intervalOf(interval: CandleInterval): string {
  const value = INTERVAL_OF[interval]
  if (!value) {
    throw problemError(
      'INVALID_PARAMS',
      `unsupported candle interval for twelvedata: ${String(interval)} (official intervals: ${SUPPORTED_INTERVALS.join(', ')})`,
    )
  }
  return value
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

/**
 * 时间 → 毫秒。上游 `datetime` 是交易所本地时间字符串（`timezone=UTC` 时是 UTC），
 * 两种形状：`YYYY-MM-DD`（日线及以上）与 `YYYY-MM-DD HH:mm:ss`（盘中）。按 UTC 解释。
 */
export function isoMs(v: unknown): number {
  if (typeof v !== 'string' || v.trim() === '') return NaN
  const text = v.trim()
  const normalized = text.length === 10 ? `${text}T00:00:00Z` : `${text.replace(' ', 'T')}Z`
  const ms = Date.parse(normalized)
  return Number.isFinite(ms) ? ms : NaN
}

// ---- 密钥（只比存在性，不打印、不落盘、不进断言） ------------------------------

export interface TwelveDataCredentialInput {
  apiKey?: string
  /** 环境变量来源（缺省 process.env；测试注入假对象，不读真环境）。 */
  env?: Record<string, string | undefined>
}

export interface TwelveDataCredentials {
  apiKey: string
}

/**
 * 取密钥：构造参数优先，其次环境变量 `TWELVEDATA_API_KEY`。
 * 没有密钥直接拒绝（所有端点都要 key，没有匿名行情）；错误信息只出现变量名。
 */
export function resolveCredentials(o: TwelveDataCredentialInput = {}): TwelveDataCredentials {
  const env = o.env ?? (typeof process === 'undefined' ? {} : process.env)
  const apiKey = firstNonEmpty(o.apiKey, env[API_KEY_ENV])
  if (apiKey === undefined) {
    throw problemError('INVALID_PARAMS', `twelvedata data connector needs an API key (set ${API_KEY_ENV} or pass apiKey)`)
  }
  return { apiKey }
}

/** 鉴权请求头（官方：`Authorization: apikey <key>`）；密钥只在这一个地方出现。 */
export function authHeaders(c: TwelveDataCredentials): Record<string, string> {
  return { authorization: `apikey ${c.apiKey}` }
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return undefined
}

// ---- 时段（sessions） ----------------------------------------------------------

export interface SessionBuildOptions {
  /** 时段所在时区，缺省 America/New_York（美股）；其它市场按交易所所在时区填。 */
  tz?: string
  /** 常规时段开盘（本地 HH:mm），缺省 09:30。 */
  regularOpen?: string
  /** 常规时段收盘（本地 HH:mm），缺省 16:00。 */
  regularClose?: string
  /** 交易日（0 = 周日），缺省周一至周五。 */
  days?: number[]
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/

function hhmmOf(v: string | undefined, fallback: string, label: string): string {
  const value = v ?? fallback
  if (!HHMM.test(value)) {
    throw problemError('INVALID_PARAMS', `twelvedata ${label} must be HH:mm (got ${JSON.stringify(value)})`)
  }
  return value
}

/**
 * 周模板：缺省周一至周五 09:30–16:00（America/New_York），时区与开收盘可配。
 * Twelve Data 的 /market_state 只给 is_market_open，没有开收盘时间，所以这里给的是时段惯例而不是接口值；
 * 权威开市判断走 marketState()，REPORT 已登记为协议缺口。
 */
export function buildSessions(o: SessionBuildOptions = {}): { tz: string; windows: TradingSessionWindow[] } {
  const tz = o.tz ?? NY_TZ
  if (typeof tz !== 'string' || tz.trim() === '') {
    throw problemError('INVALID_PARAMS', 'twelvedata sessions.tz must be a non-empty IANA timezone name')
  }
  const open = hhmmOf(o.regularOpen, '09:30', 'regularOpen')
  const close = hhmmOf(o.regularClose, '16:00', 'regularClose')
  if (open >= close) {
    throw problemError('INVALID_PARAMS', `twelvedata regularOpen ${open} must be earlier than regularClose ${close}`)
  }
  const days = o.days ?? [1, 2, 3, 4, 5]
  for (const day of days) {
    if (!Number.isInteger(day) || day < 0 || day > 6) {
      throw problemError('INVALID_PARAMS', `twelvedata sessions.days must be 0..6 (got ${String(day)})`)
    }
  }
  return { tz: tz.trim(), windows: [{ days: [...days], from: open, to: close, quality: 'regular' }] }
}

// ---- 标的（/stocks） ------------------------------------------------------------

export interface RawStockRow {
  symbol?: unknown
  name?: unknown
  currency?: unknown
  exchange?: unknown
  mic_code?: unknown
  type?: unknown
}

/**
 * 一行 /stocks → Instrument。
 * - symbol 为空的行丢弃；currency 缺省 USD。
 * - marketGroup 记交易所（`exchange`），方便跨市场区分同名代码（如 0700.HK）。
 * - 数量按整数股（step '1' / decimals 0 / min '1'）：官方股票清单不给交易规则。
 * - 最小报价单位按价格档位变化，协议没有分档字段 → 只填 maxDecimals 4。
 */
export function parseInstrument(
  row: RawStockRow,
  now: Ms,
  sessions: { tz: string; windows: TradingSessionWindow[] },
): Instrument | undefined {
  if (!row || typeof row !== 'object') return undefined
  const symbol = typeof row.symbol === 'string' && row.symbol.trim() !== '' ? row.symbol.trim() : undefined
  if (!symbol) return undefined
  const currency = typeof row.currency === 'string' && row.currency.trim() !== '' ? row.currency.trim().toUpperCase() : 'USD'
  const exchange = typeof row.exchange === 'string' && row.exchange.trim() !== '' ? row.exchange.trim() : null
  const name = typeof row.name === 'string' && row.name.trim() !== '' ? row.name.trim() : undefined
  const price: InstrumentPriceRule = { maxDecimals: 4 }
  const size: InstrumentSizeRule = { step: asDecimal('1'), decimals: 0, min: asDecimal('1') }
  return {
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
    marketGroup: exchange,
    ...(name !== undefined ? { underlying: { description: name, synthetic: false } } : {}),
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

/** /stocks 的 `{data: [...]}` → 标的（按 symbol 升序；无 symbol / 非对象行丢弃）。 */
export function parseStocks(raw: unknown, now: Ms, sessions: { tz: string; windows: TradingSessionWindow[] }): Instrument[] {
  const rows = raw && typeof raw === 'object' && Array.isArray((raw as { data?: unknown }).data) ? (raw as { data: unknown[] }).data : undefined
  if (rows === undefined) {
    throw problemError('VENUE_UNAVAILABLE', `${VENUE} /stocks returned no data array`, {
      retryable: true,
      venue: { id: VENUE, message: 'invalid stocks payload' },
    })
  }
  const out: Instrument[] = []
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const instrument = parseInstrument(row as RawStockRow, now, sessions)
    if (instrument) out.push(instrument)
  }
  return out.sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0))
}

// ---- K 线（/time_series） -------------------------------------------------------

export interface RawTimeSeriesValue {
  datetime?: unknown
  open?: unknown
  high?: unknown
  low?: unknown
  close?: unknown
  volume?: unknown
}

export interface RawTimeSeries {
  meta?: unknown
  values?: unknown
  status?: unknown
}

/**
 * `values: [{datetime, open, high, low, close, volume}]` → Candle[]。
 * 官方缺省最新在前（order=desc），这里不翻转，统一由 dedupeCandles 升序去重；
 * 任一行缺 OHLCV（指数 / 部分外汇没有 volume）就跳过该行，不补 0。
 */
export function parseTimeSeries(raw: unknown): Candle[] {
  if (!raw || typeof raw !== 'object') return []
  const series = raw as RawTimeSeries
  if (series.status === 'error') return []
  const values = Array.isArray(series.values) ? series.values : []
  const out: Candle[] = []
  for (const row of values) {
    if (!row || typeof row !== 'object') continue
    const v = row as RawTimeSeriesValue
    const ts = isoMs(v.datetime)
    const open = num(v.open)
    const high = num(v.high)
    const low = num(v.low)
    const close = num(v.close)
    const volume = num(v.volume)
    if (![ts, open, high, low, close, volume].every((x) => Number.isFinite(x))) continue
    out.push({ t: ts, o: open, h: high, l: low, c: close, v: volume })
  }
  return out
}

// ---- 报价（/quote） ------------------------------------------------------------

export interface RawQuote {
  symbol?: unknown
  name?: unknown
  exchange?: unknown
  mic_code?: unknown
  currency?: unknown
  datetime?: unknown
  timestamp?: unknown
  open?: unknown
  high?: unknown
  low?: unknown
  close?: unknown
  volume?: unknown
  previous_close?: unknown
  change?: unknown
  percent_change?: unknown
  is_market_open?: unknown
}

export interface VendorQuote {
  ts: Ms
  last: number
  open?: number
  high?: number
  low?: number
  volume?: number
  prevClose?: number
  isMarketOpen?: boolean
}

/**
 * /quote → 最新成交价 + 当日高低 / 昨收 / 成交量。
 * `timestamp` 是秒级 epoch（官方字段），缺省时退回 `datetime`。`close <= 0` 视为没有报价。
 */
export function parseQuote(raw: unknown): VendorQuote | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const q = raw as RawQuote
  const last = num(q.close)
  if (!(last > 0)) return undefined
  const seconds = num(q.timestamp)
  const ts = Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : isoMs(q.datetime)
  const out: VendorQuote = { ts: Number.isFinite(ts) ? ts : 0, last }
  const open = num(q.open)
  const high = num(q.high)
  const low = num(q.low)
  const volume = num(q.volume)
  const prevClose = num(q.previous_close)
  if (open > 0) out.open = open
  if (high > 0) out.high = high
  if (low > 0) out.low = low
  if (volume > 0) out.volume = volume
  if (prevClose > 0) out.prevClose = prevClose
  if (typeof q.is_market_open === 'boolean') out.isMarketOpen = q.is_market_open
  return out
}

// ---- 市场状态（/market_state） --------------------------------------------------

export interface RawMarketState {
  name?: unknown
  code?: unknown
  country?: unknown
  is_market_open?: unknown
  time_after_open?: unknown
  time_to_open?: unknown
  time_to_close?: unknown
}

export interface MarketState {
  exchange: string
  isOpen: boolean
  timeToOpen: string | null
  timeToClose: string | null
  timeAfterOpen: string | null
}

/**
 * /market_state → MarketState（官方权威开市判断；`is_market_open` 不是布尔就当未开市）。
 * 响应顶层是数组：先按 `code`（大小写不敏感）匹配 exchange，找不到再按 `name`；都找不到 → INVALID_PARAMS。
 */
export function parseMarketState(raw: unknown, exchange: string): MarketState {
  if (!Array.isArray(raw)) {
    throw problemError('VENUE_UNAVAILABLE', `${VENUE} /market_state returned no array`, {
      retryable: true,
      venue: { id: VENUE, message: 'invalid market state payload' },
    })
  }
  const wanted = exchange.trim().toLowerCase()
  const rows = raw as RawMarketState[]
  const byCode = (r: RawMarketState | null): boolean => typeof r?.code === 'string' && r.code.toLowerCase() === wanted
  const byName = (r: RawMarketState | null): boolean => typeof r?.name === 'string' && r.name.toLowerCase() === wanted
  const s = rows.find(byCode) ?? rows.find(byName)
  if (!s) {
    throw problemError('INVALID_PARAMS', `${VENUE} /market_state has no entry for exchange ${JSON.stringify(exchange)}`)
  }
  return {
    exchange: typeof s.code === 'string' && s.code !== '' ? s.code : typeof s.name === 'string' ? s.name : exchange,
    isOpen: s.is_market_open === true,
    timeToOpen: typeof s.time_to_open === 'string' && s.time_to_open !== '' ? s.time_to_open : null,
    timeToClose: typeof s.time_to_close === 'string' && s.time_to_close !== '' ? s.time_to_close : null,
    timeAfterOpen: typeof s.time_after_open === 'string' && s.time_after_open !== '' ? s.time_after_open : null,
  }
}

// ---- 根数钳位 / 去重 ------------------------------------------------------------

/** 无 from 时的根数：1..5000，缺省 300。 */
export function clampCount(n: number | undefined): number {
  const raw = typeof n === 'number' && Number.isFinite(n) ? Math.floor(n) : DEFAULT_CANDLE_COUNT
  return Math.max(1, Math.min(MAX_CANDLES, raw))
}

/** 升序去重（官方缺省最新在前，翻页边界上同一根也可能重复）。 */
export function dedupeCandles(candles: Candle[]): Candle[] {
  const seen = new Map<Ms, Candle>()
  for (const candle of candles) seen.set(candle.t, candle)
  return [...seen.values()].sort((a, b) => a.t - b.t)
}
