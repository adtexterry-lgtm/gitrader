// SPDX-License-Identifier: CPAL-1.0
// KuCoin Futures 公共 REST 响应 → 统一模型（纯函数，无状态；不发请求、不读环境）。
// 响应统一包在 { code, data } 信封里，code === '200000' 才算成功；数值有字符串也有 number，
// 时间戳有毫秒（K 线 / 标记价）也有纳秒（ticker / 盘口），解析不了一律回落到协议允许的缺省，不猜精度。
import { asDecimal, makeProblem, normalizeDecimal } from '@gitrader/protocol'
import type {
  Book, BookLevel, Candle, CandleInterval, Decimal, Instrument, InstrumentPriceRule, InstrumentSizeRule, InstrumentStatus,
  MarketContext, Ms, Problem, ProblemName,
} from '@gitrader/protocol'

export const VENUE = 'kucoin'
/** KuCoin Futures 公共 REST 缺省基址；可注入（测试与镜像用）。 */
export const DEFAULT_BASE_URL = 'https://api-futures.kucoin.com'
/** 逐仓 / 全仓永续多数每 8 小时结算资金费；合约清单给了 fundingRateGranularity 时按上游算。 */
export const FUNDING_INTERVAL_MS: Ms = 28_800_000
/** /api/v1/kline/query 单次最多返回 200 根。 */
export const MAX_CANDLES = 200
/** 区间翻页每页 200 根。 */
export const CANDLE_PAGE = 200
/** 区间翻页硬上限：200 × 200 根，防上游异常时死循环。 */
export const MAX_PAGES = 200
/** 无 from 时想要的根数；钳到单页上限 200。 */
export const DEFAULT_CANDLE_COUNT = 300
/** 公共端点按 IP 计次：约 30 次 / 3 秒（model = count，不是 weight）。 */
export const IP_RATE_LIMIT = 30
export const IP_RATE_WINDOW_MS: Ms = 3_000
/** 信封成功码。 */
export const SUCCESS_CODE = '200000'

/**
 * 协议区间 → KuCoin granularity（分钟）。工单表里没有 3m / 3d / 1M，
 * 这三个周期一律 INVALID_PARAMS（即使上游碰巧认 3 分钟）。
 */
export const GRANULARITY_MINUTES: Partial<Record<CandleInterval, number>> = {
  '1m': 1, '5m': 5, '15m': 15, '30m': 30,
  '1h': 60, '2h': 120, '4h': 240, '8h': 480, '12h': 720,
  '1d': 1440, '1w': 10080,
}

export const instrumentIdOf = (symbol: string): string => `${VENUE}:${symbol}`

/** `kucoin:<symbol>` → 场所原生 symbol；不是本场所的 id 就拒绝，避免把别的场所符号发到 KuCoin。 */
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

/** 协议周期 → granularity（分钟）；不在工单表里的周期直接 INVALID_PARAMS（不发请求）。 */
export function granularityOf(interval: CandleInterval): number {
  const minutes = GRANULARITY_MINUTES[interval]
  if (!minutes) throw problemError('INVALID_PARAMS', `unsupported candle interval: ${String(interval)}`)
  return minutes
}

/** 协议周期 → 毫秒（翻页游标按它推进）；不在表里 → INVALID_PARAMS。 */
export function intervalStepMs(interval: CandleInterval): Ms {
  return granularityOf(interval) * 60_000
}

// ---- 原始形状 ---------------------------------------------------------------

/** KuCoin 统一信封：code 为字符串 "200000" 表示成功。 */
export interface KucoinEnvelope<T> { code?: string; msg?: string; data?: T }

export interface RawContract {
  symbol?: string
  displaySymbol?: string
  baseCurrency?: string
  quoteCurrency?: string
  settleCurrency?: string
  status?: string
  tickSize?: string | number
  lotSize?: string | number
  maxOrderQty?: string | number
  multiplier?: string | number
  isInverse?: boolean
  isQuanto?: boolean
  maxLeverage?: string | number
  fundingFeeRate?: string | number
  fundingRateGranularity?: string | number
  nextFundingRateTime?: string | number
  markPrice?: string | number
  indexPrice?: string | number
}

export interface RawTicker {
  symbol?: string
  price?: string | number
  bestBidPrice?: string | number
  bestAskPrice?: string | number
  bestBidSize?: string | number
  bestAskSize?: string | number
  /** 纳秒时间戳（上游口径）。 */
  ts?: string | number
}

export interface RawDepth { symbol?: string; bids?: unknown[]; asks?: unknown[]; sequence?: number; ts?: string | number }

export interface RawMarkPrice {
  symbol?: string
  granularity?: number
  timePoint?: string | number
  value?: string | number
  indexPrice?: string | number
}

export interface RawFundingRate {
  symbol?: string
  granularity?: string | number
  timePoint?: string | number
  value?: string | number
  fundingTime?: string | number
}

export const num = (v: unknown): number => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN
  if (typeof v !== 'string') return NaN
  const s = v.trim()
  // 上游用空串表示「没有值」；Number('') 会得到 0，这里必须当缺失
  if (s === '') return NaN
  const n = Number(s)
  return Number.isFinite(n) ? n : NaN
}

/**
 * KuCoin 同一个所里时间戳单位不统一：ticker / level2 给纳秒，K 线 / 标记价给毫秒。
 * 按量级归一到毫秒（毫秒 ≈ 1e12，微秒 ≈ 1e15，纳秒 ≈ 1e18）。非法值回 NaN。
 */
export function msOf(v: unknown): Ms {
  const n = num(v)
  if (!Number.isFinite(n) || n <= 0) return NaN
  if (n >= 1e17) return Math.round(n / 1e6)
  if (n >= 1e14) return Math.round(n / 1e3)
  return Math.round(n)
}

const tsOr = (v: unknown, now: Ms): Ms => {
  const ms = msOf(v)
  return Number.isFinite(ms) ? ms : now
}

/** 宽松十进制文本 → 规范形；非法 / 非正数返回 undefined（tick、lot 为 0 时上游等于没给）。 */
function positiveDecimal(v: unknown): Decimal | undefined {
  if (typeof v !== 'string' && typeof v !== 'number') return undefined
  const s = String(v).trim()
  if (s === '') return undefined
  try {
    const d = normalizeDecimal(s)
    return num(d) > 0 ? d : undefined
  } catch {
    return undefined
  }
}

const decimalsOf = (d: Decimal): number => {
  const i = d.indexOf('.')
  return i < 0 ? 0 : d.length - i - 1
}

/** `XBTUSDTM` → base / quote；上游给了 baseCurrency / quoteCurrency 时优先用它。 */
function splitSymbol(symbol: string): { base: string; quote: string } {
  for (const suffix of ['USDTM', 'USDM']) {
    if (symbol.endsWith(suffix) && symbol.length > suffix.length) {
      return { base: symbol.slice(0, -suffix.length), quote: 'USDT' }
    }
  }
  for (const quote of ['USDT', 'USDC', 'USD']) {
    if (symbol.endsWith(quote) && symbol.length > quote.length) {
      return { base: symbol.slice(0, -quote.length), quote }
    }
  }
  return { base: symbol, quote: 'USDT' }
}

/** 合约状态：Open 可交易；CancelOnly / Init 只减仓或未开市；Closed / Settled 视为已下架。 */
function statusOf(status: string | undefined): InstrumentStatus {
  switch (status) {
    case 'Open': return 'trading'
    case 'CancelOnly':
    case 'Init': return 'halted'
    case 'Closed':
    case 'Settled': return 'delisted'
    default: return 'halted'
  }
}

// ---- /api/v1/contracts/active → Instrument -----------------------------------

export function parseInstrument(c: RawContract, now: Ms): Instrument | undefined {
  const symbol = typeof c.symbol === 'string' && c.symbol !== '' ? c.symbol : undefined
  if (!symbol) return undefined
  // 本连接器只做 USDT 永续：反向 / 币本位合约一律跳过
  if (c.isInverse === true) return undefined

  const fallback = splitSymbol(symbol)
  const base = typeof c.baseCurrency === 'string' && c.baseCurrency !== '' ? c.baseCurrency : fallback.base
  const quote = typeof c.quoteCurrency === 'string' && c.quoteCurrency !== '' ? c.quoteCurrency : fallback.quote
  const settle = typeof c.settleCurrency === 'string' && c.settleCurrency !== '' ? c.settleCurrency : quote

  const tick = positiveDecimal(c.tickSize)
  const price: InstrumentPriceRule = tick ? { tick, maxDecimals: decimalsOf(tick) } : { sigFigs: 5, maxDecimals: 8 }

  // KuCoin 的下单量单位是「张」：lotSize 是每手张数，multiplier 是每张对应的标的币数。
  const step = positiveDecimal(c.lotSize) ?? asDecimal('1')
  const size: InstrumentSizeRule = { step, decimals: decimalsOf(step), min: step }
  const contractSize = positiveDecimal(c.multiplier) ?? asDecimal('1')

  const fundingInterval = num(c.fundingRateGranularity)
  const leverage = num(c.maxLeverage)

  return {
    instrumentId: instrumentIdOf(symbol),
    venue: VENUE,
    symbol,
    displaySymbol: `${base}-PERP`,
    kind: 'perp',
    base,
    quote,
    settle,
    settlement: 'linear',
    contractSize,
    venueSizeUnit: 'contract',
    assetClass: 'crypto',
    marketGroup: null,
    status: statusOf(c.status),
    price,
    size,
    ...(Number.isFinite(leverage) && leverage > 0 ? { maxLeverage: leverage } : {}),
    // 只读数据连接器：不下单，所以标的层面也不声明任何可下单类型
    orderTypes: [],
    tif: [],
    triggerPriceTypes: [],
    fundingIntervalMs: Number.isFinite(fundingInterval) && fundingInterval > 0 ? fundingInterval : FUNDING_INTERVAL_MS,
    sessions: { tz: 'UTC', windows: [{ days: [0, 1, 2, 3, 4, 5, 6], from: '00:00', to: '23:59', quality: 'regular' }] },
    updatedAt: now,
  }
}

/** 合约清单 → 标的：只收 status === 'Open' 的 USDT 永续（工单口径）。 */
export function parseInstruments(raw: unknown, now: Ms): Instrument[] {
  if (!Array.isArray(raw)) return []
  const out: Instrument[] = []
  for (const row of raw) {
    if (!row || typeof row !== 'object') continue
    const instrument = parseInstrument(row as RawContract, now)
    if (instrument && instrument.status === 'trading') out.push(instrument)
  }
  return out.sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0))
}

// ---- 行情 -------------------------------------------------------------------

/**
 * K 线行 → Candle。KuCoin 列顺序：[time(毫秒), o, h, l, c, volume(张), turnover]，
 * 升序返回；这里只做逐行解析与时间归一，升降序与去重交给调用方。
 */
export function parseCandles(raw: unknown): Candle[] {
  if (!Array.isArray(raw)) return []
  const out: Candle[] = []
  for (const row of raw) {
    if (!Array.isArray(row) || row.length < 6) continue
    const t = msOf(row[0])
    const o = num(row[1])
    const h = num(row[2])
    const l = num(row[3])
    const c = num(row[4])
    const v = num(row[5])
    if (![t, o, h, l, c, v].every((x) => Number.isFinite(x))) continue
    out.push({ t, o, h, l, c, v })
  }
  return out
}

/** ticker → { ts, bid, ask, last? }；买卖价缺失或非正（上游偶发 null）视为没有报价。 */
export function parseTicker(
  raw: RawTicker | null | undefined,
  now: Ms,
): { ts: Ms; bid: number; ask: number; last?: number } | undefined {
  if (!raw) return undefined
  const bid = num(raw.bestBidPrice)
  const ask = num(raw.bestAskPrice)
  if (!(bid > 0) || !(ask > 0)) return undefined
  const out: { ts: Ms; bid: number; ask: number; last?: number } = { ts: tsOr(raw.ts, now), bid, ask }
  const last = num(raw.price)
  if (last > 0) out.last = last
  return out
}

/**
 * /level2/depth20|depth100 → Book。上游每个价位是 [price, size(张)]，
 * 这里按 contractSize（multiplier）折成标的币数；bids 降序、asks 升序，按 depth 截断。
 */
export function parseDepth(
  raw: RawDepth | null | undefined,
  instrumentId: string,
  depth: number,
  now: Ms,
  contractSize = 1,
): Book {
  const factor = Number.isFinite(contractSize) && contractSize > 0 ? contractSize : 1
  const levels = (rows: unknown): BookLevel[] => {
    if (!Array.isArray(rows)) return []
    const out: BookLevel[] = []
    for (const row of rows) {
      if (!Array.isArray(row)) continue
      const price = num(row[0])
      const contracts = num(row[1])
      if (!(price > 0) || !(contracts > 0)) continue
      // 张 × multiplier 会带浮点尾巴（59 × 0.001 = 0.059000000000000004），保留 12 位有效数字
      out.push({ price, size: Number((contracts * factor).toPrecision(12)) })
    }
    return out
  }
  const bids = levels(raw?.bids).sort((a, b) => b.price - a.price).slice(0, depth)
  const asks = levels(raw?.asks).sort((a, b) => a.price - b.price).slice(0, depth)
  return { instrumentId, ts: tsOr(raw?.ts, now), bids, asks }
}

/** /mark-price/{symbol}/current → 标记价、指数价与上游时间戳。 */
export function parseMarkPrice(
  raw: RawMarkPrice | null | undefined,
  now: Ms,
): { markPrice: number; oraclePrice?: number; ts: Ms } {
  const markPrice = num(raw?.value)
  const indexPrice = num(raw?.indexPrice)
  const out: { markPrice: number; oraclePrice?: number; ts: Ms } = {
    markPrice: Number.isFinite(markPrice) ? markPrice : 0,
    ts: tsOr(raw?.timePoint, now),
  }
  if (Number.isFinite(indexPrice) && indexPrice > 0) out.oraclePrice = indexPrice
  return out
}

/** /funding-rate/{symbol}/current → 资金费率 + 结算间隔（granularity 本身是毫秒）。 */
export function parseFundingRate(
  raw: RawFundingRate | null | undefined,
  now: Ms,
): { fundingRate?: number; fundingIntervalMs: Ms; ts: Ms } {
  const rate = num(raw?.value)
  const interval = num(raw?.granularity)
  const out: { fundingRate?: number; fundingIntervalMs: Ms; ts: Ms } = {
    fundingIntervalMs: Number.isFinite(interval) && interval > 0 ? interval : FUNDING_INTERVAL_MS,
    ts: tsOr(raw?.timePoint, now),
  }
  if (Number.isFinite(rate)) out.fundingRate = rate
  return out
}

/** 标记价 + 资金费 → MarketContext（KuCoin 不给指数价时 oraclePrice 留空）。 */
export function parseContext(
  mark: { markPrice: number; oraclePrice?: number; ts: Ms },
  funding: { fundingRate?: number; fundingIntervalMs: Ms; ts: Ms },
  instrumentId: string,
): MarketContext {
  const context: MarketContext = {
    instrumentId,
    ts: mark.ts,
    markPrice: mark.markPrice,
    fundingIntervalMs: funding.fundingIntervalMs,
  }
  if (mark.oraclePrice !== undefined) context.oraclePrice = mark.oraclePrice
  if (funding.fundingRate !== undefined) context.fundingRate = funding.fundingRate
  return context
}

// ---- 端点路径与请求额度（公共端点按调用次数计） ------------------------------

export const CONTRACTS_PATH = '/api/v1/contracts/active'
export const TICKER_PATH = '/api/v1/ticker'
export const DEPTH_20_PATH = '/api/v1/level2/depth20'
export const DEPTH_100_PATH = '/api/v1/level2/depth100'
export const KLINE_PATH = '/api/v1/kline/query'
export const markPricePath = (symbol: string): string => `/api/v1/mark-price/${encodeURIComponent(symbol)}/current`
export const fundingRatePath = (symbol: string): string => `/api/v1/funding-rate/${encodeURIComponent(symbol)}/current`

export const CONTRACTS_WEIGHT = 1
export const TICKER_WEIGHT = 1
export const DEPTH_WEIGHT = 1
export const KLINE_WEIGHT = 1
export const MARK_PRICE_WEIGHT = 1
export const FUNDING_RATE_WEIGHT = 1

/** 每个价位的档数上限：depth20 / depth100 两档。 */
export const LEVEL2_PAGE = 20
export const MAX_BOOK_DEPTH = 100

/** 请求的深度向上取整并钳到 1..100。 */
export function depthLimitOf(depth: number | undefined): number {
  const want = Number.isFinite(depth) && (depth as number) > 0 ? Math.ceil(depth as number) : LEVEL2_PAGE
  return Math.max(1, Math.min(MAX_BOOK_DEPTH, want))
}

/** 深度 → 端点：≤ 20 走 depth20，否则走 depth100。 */
export function depthPathOf(limit: number): string {
  return limit > LEVEL2_PAGE ? DEPTH_100_PATH : DEPTH_20_PATH
}
