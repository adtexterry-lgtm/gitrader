// SPDX-License-Identifier: CPAL-1.0
// Bitget v2 USDT 永续公共 REST 响应 → 统一模型（纯函数，无状态；不发请求、不读环境）。
// 响应统一包在 { code, msg, requestTime, data } 信封里，code === '00000' 才算成功；数值一律是字符串。
// 解析不了的回落到协议允许的缺省，不猜精度：tick 用 pricePlace + priceEndStep，step 用 volumePlace。
import { asDecimal, makeProblem, normalizeDecimal } from '@gitrader/protocol'
import type {
  Book, BookLevel, Candle, CandleInterval, Decimal, Instrument, InstrumentPriceRule, InstrumentSizeRule, InstrumentStatus,
  MarketContext, Ms, Problem, ProblemName,
} from '@gitrader/protocol'

export const VENUE = 'bitget'
/** Bitget v2 公共 REST 缺省基址；可注入（测试与镜像用）。 */
export const DEFAULT_BASE_URL = 'https://api.bitget.com'
/** v2 mix 端点必须带的产品类型：本连接器只做 USDT 本位永续。 */
export const PRODUCT_TYPE = 'USDT-FUTURES'
/** 上游没给 fundInterval 时的缺省资金间隔（USDT 永续通常 8 小时）。 */
export const FUNDING_INTERVAL_MS: Ms = 28_800_000
/** /api/v2/mix/market/candles 单次最多 200 根（上游实测 limit 上限 200）。 */
export const MAX_CANDLES = 200
export const CANDLE_PAGE = 200
/** /api/v2/mix/market/history-candles 每页最多 200 根（上游实测 limit 上限 200）。 */
export const HISTORY_PAGE = 200
/** 区间翻页硬上限：200 页，防上游异常时死循环。 */
export const MAX_PAGES = 200
export const DEFAULT_CANDLE_COUNT = 300
/** 约 20 次 / 秒（按 IP 计次，不是权重）。 */
export const IP_RATE_LIMIT = 20
export const IP_RATE_WINDOW_MS: Ms = 1000

/** 协议区间 → 毫秒（翻页游标按它推进）。 */
export const INTERVAL_MS: Record<CandleInterval, number> = {
  '1m': 60_000, '3m': 180_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000,
  '1h': 3_600_000, '2h': 7_200_000, '4h': 14_400_000, '8h': 28_800_000, '12h': 43_200_000,
  '1d': 86_400_000, '3d': 259_200_000, '1w': 604_800_000, '1M': 2_592_000_000,
}

/**
 * 协议区间 → Bitget granularity 拼写（时 / 天 / 周 / 月大写，分钟保持小写）。
 * 工单给了 1m 3m 5m 15m 30m 1H 4H 6H 12H 1D 3D 1W 1M，上游实测也认 2H；8h 不在表内 → INVALID_PARAMS。
 */
export const GRANULARITY_OF: Partial<Record<CandleInterval, string>> = {
  '1m': '1m', '3m': '3m', '5m': '5m', '15m': '15m', '30m': '30m',
  '1h': '1H', '2h': '2H', '4h': '4H', '12h': '12H',
  '1d': '1D', '3d': '3D', '1w': '1W', '1M': '1M',
}

export const instrumentIdOf = (symbol: string): string => `${VENUE}:${symbol}`

/** `bitget:<symbol>` → 场所原生 symbol（原样保留大小写）；不是本场所的 id 就拒绝。 */
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

/** 协议周期 → Bitget granularity；不在工单表里的周期直接 INVALID_PARAMS（不发请求）。 */
export function granularityOf(interval: CandleInterval): string {
  const granularity = GRANULARITY_OF[interval]
  if (!granularity) throw problemError('INVALID_PARAMS', `unsupported candle interval: ${String(interval)}`)
  return granularity
}

// ---- 原始形状 ---------------------------------------------------------------

/** Bitget 统一信封：code 为字符串 "00000" 表示成功；失败时 data 为 null。 */
export interface BitgetEnvelope<T> {
  code?: string
  msg?: string
  requestTime?: number | string
  data?: T | T[] | null
}

export interface RawContract {
  symbol?: string
  baseCoin?: string
  quoteCoin?: string
  symbolType?: string
  symbolStatus?: string
  pricePlace?: string
  priceEndStep?: string
  volumePlace?: string
  minTradeNum?: string
  minTradeUSDT?: string
  fundInterval?: string
  maxLever?: string
}

export interface RawTicker {
  symbol?: string
  lastPr?: string
  bidPr?: string
  askPr?: string
  bidSz?: string
  askSz?: string
  ts?: string
  markPrice?: string
  indexPrice?: string
  fundingRate?: string
  holdingAmount?: string
  quoteVolume?: string
  open24h?: string
}

export interface RawDepth {
  asks?: unknown[]
  bids?: unknown[]
  ts?: string
  scale?: string
}

export interface RawFundingRate {
  symbol?: string
  fundingRate?: string
  fundingRateInterval?: string
  nextUpdate?: string
  minFundingRate?: string
  maxFundingRate?: string
}

export const num = (v: unknown): number => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN
  if (typeof v !== 'string') return NaN
  const s = v.trim()
  // Bitget 用空串 / null 表示「没有值」；Number('') 会得到 0，这里必须当缺失
  if (s === '') return NaN
  const n = Number(s)
  return Number.isFinite(n) ? n : NaN
}

/** 宽松十进制文本 → 规范形；非法 / 非正数返回 undefined（tick、step 为 0 时上游等于没给）。 */
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

/**
 * `priceEndStep × 10^-pricePlace` → tick 文本（按十进制位右移，避开浮点误差）。
 * Bitget 只给「精度位数 + 末位步长」，例如 BTCUSDT pricePlace=1 / priceEndStep=1 → 0.1。
 */
function scaledDecimal(step: string, places: number): Decimal | undefined {
  const digits = step.trim()
  if (!/^\d+$/.test(digits)) return undefined
  if (places <= 0) return positiveDecimal(digits)
  const padded = digits.padStart(places + 1, '0')
  const cut = padded.length - places
  return positiveDecimal(`${padded.slice(0, cut)}.${padded.slice(cut)}`)
}

/** Bitget symbolStatus：normal 可交易；offline / delisted 视为已下架，其余（maintain 等）停牌。 */
function statusOf(status: string | undefined): InstrumentStatus {
  switch (status) {
    case 'normal': return 'trading'
    case 'offline':
    case 'delisted': return 'delisted'
    default: return 'halted'
  }
}

// ---- /mix/market/contracts → Instrument --------------------------------------

/**
 * 一条合约 → Instrument。工单口径只收 `symbolStatus === 'normal'`；
 * tick / step 由 pricePlace / priceEndStep / volumePlace 推导，推不出来回落到协议缺省。
 */
export function parseInstrument(c: RawContract, now: Ms): Instrument | undefined {
  const symbol = typeof c.symbol === 'string' && c.symbol !== '' ? c.symbol : undefined
  if (!symbol) return undefined
  // 只收永续：symbolType 给了且不是 perpetual 的条目一律跳过
  if (typeof c.symbolType === 'string' && c.symbolType !== 'perpetual') return undefined
  if (typeof c.symbolStatus === 'string' && c.symbolStatus !== 'normal') return undefined

  const base = typeof c.baseCoin === 'string' && c.baseCoin !== ''
    ? c.baseCoin
    : symbol.endsWith('USDT') && symbol.length > 4 ? symbol.slice(0, -4) : symbol
  const quote = typeof c.quoteCoin === 'string' && c.quoteCoin !== '' ? c.quoteCoin : 'USDT'

  const places = num(c.pricePlace)
  const priceDecimals = Number.isInteger(places) && places >= 0 && places <= 18 ? places : 8
  const tick = typeof c.priceEndStep === 'string' ? scaledDecimal(c.priceEndStep, priceDecimals) : positiveDecimal(c.priceEndStep)
  const price: InstrumentPriceRule = tick ? { tick, maxDecimals: priceDecimals } : { sigFigs: 5, maxDecimals: 8 }

  const volumePlaces = num(c.volumePlace)
  const sizeDecimals = Number.isInteger(volumePlaces) && volumePlaces >= 0 && volumePlaces <= 18 ? volumePlaces : 0
  const step = (sizeDecimals > 0 ? scaledDecimal('1', sizeDecimals) : asDecimal('1')) ?? asDecimal('1')
  const minQty = positiveDecimal(c.minTradeNum) ?? step
  const size: InstrumentSizeRule = { step, decimals: decimalsOf(step), min: minQty }
  const minNotional = positiveDecimal(c.minTradeUSDT)

  const hours = num(c.fundInterval)
  const fundingIntervalMs = Number.isFinite(hours) && hours > 0 ? Math.round(hours * 3_600_000) : FUNDING_INTERVAL_MS
  const maxLeverage = num(c.maxLever)

  return {
    instrumentId: instrumentIdOf(symbol),
    venue: VENUE,
    symbol,
    displaySymbol: `${base}-PERP`,
    kind: 'perp',
    base,
    quote,
    settle: quote,
    settlement: 'linear',
    // USDT 永续按币本位数量下单（不是张数）
    contractSize: asDecimal('1'),
    venueSizeUnit: 'base',
    assetClass: 'crypto',
    marketGroup: null,
    status: statusOf(c.symbolStatus),
    price,
    size,
    ...(minNotional ? { minNotional } : {}),
    ...(maxLeverage > 0 ? { maxLeverage } : {}),
    // 只读数据连接器：不下单，所以标的层面也不声明任何可下单类型
    orderTypes: [],
    tif: [],
    triggerPriceTypes: [],
    fundingIntervalMs,
    sessions: { tz: 'UTC', windows: [{ days: [0, 1, 2, 3, 4, 5, 6], from: '00:00', to: '23:59', quality: 'regular' }] },
    updatedAt: now,
  }
}

/** contracts 的 data 数组 → 标的（非 normal 条目在解析层就被剔除）。 */
export function parseInstruments(raw: unknown, now: Ms): Instrument[] {
  if (!Array.isArray(raw)) return []
  const out: Instrument[] = []
  for (const c of raw) {
    if (!c || typeof c !== 'object') continue
    const instrument = parseInstrument(c as RawContract, now)
    if (instrument) out.push(instrument)
  }
  return out.sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0))
}

// ---- 行情 -------------------------------------------------------------------

/**
 * K 线行 → Candle。Bitget 列顺序：[ts(毫秒字符串), open, high, low, close, baseVolume, quoteVolume]，
 * 时间是毫秒（不再 ×1000），上游按升序返回；排序与去重交给调用方。
 */
export function parseCandles(raw: unknown): Candle[] {
  if (!Array.isArray(raw)) return []
  const out: Candle[] = []
  for (const row of raw) {
    if (!Array.isArray(row) || row.length < 6) continue
    const t = num(row[0])
    const o = num(row[1])
    const h = num(row[2])
    const l = num(row[3])
    const c = num(row[4])
    const v = num(row[5])
    if (![t, o, h, l, c, v].every((x) => Number.isFinite(x))) continue
    if (!(t > 0)) continue
    out.push({ t, o, h, l, c, v })
  }
  return out
}

/** ticker → { ts, bid, ask, last? }；买卖价缺失或非正（上游偶发空串 / 新标的）视为没有报价。 */
export function parseTicker(
  raw: RawTicker | null | undefined,
  now: Ms,
): { ts: Ms; bid: number; ask: number; last?: number } | undefined {
  if (!raw) return undefined
  const bid = num(raw.bidPr)
  const ask = num(raw.askPr)
  if (!(bid > 0) || !(ask > 0)) return undefined
  const ts = num(raw.ts)
  const last = num(raw.lastPr)
  const out: { ts: Ms; bid: number; ask: number; last?: number } = { ts: Number.isFinite(ts) && ts > 0 ? ts : now, bid, ask }
  if (last > 0) out.last = last
  return out
}

/** merge-depth → Book；bids 降序、asks 升序，按 depth 截断（上游给的是 [price, size] 数组）。 */
export function parseDepth(raw: RawDepth | null | undefined, instrumentId: string, depth: number, now: Ms): Book {
  const levels = (rows: unknown): BookLevel[] => {
    if (!Array.isArray(rows)) return []
    const out: BookLevel[] = []
    for (const row of rows) {
      if (!Array.isArray(row)) continue
      const price = num(row[0])
      const size = num(row[1])
      if (!(price > 0) || !(size > 0)) continue
      out.push({ price, size })
    }
    return out
  }
  const bids = levels(raw?.bids).sort((a, b) => b.price - a.price).slice(0, depth)
  const asks = levels(raw?.asks).sort((a, b) => a.price - b.price).slice(0, depth)
  const ts = num(raw?.ts)
  return { instrumentId, ts: Number.isFinite(ts) && ts > 0 ? ts : now, bids, asks }
}

/**
 * current-fund-rate → 资金费率与资金间隔。
 * 上游的 nextUpdate（下次结算毫秒）在协议 MarketContext 里没有对应字段，这里只用来对齐口径、不外露。
 */
export function parseFundingRate(
  raw: RawFundingRate | null | undefined,
  now: Ms,
): { fundingRate?: number; fundingIntervalMs: Ms; ts: Ms } {
  const rate = num(raw?.fundingRate)
  const hours = num(raw?.fundingRateInterval)
  const fundingIntervalMs = Number.isFinite(hours) && hours > 0 ? Math.round(hours * 3_600_000) : FUNDING_INTERVAL_MS
  const next = num(raw?.nextUpdate)
  const out: { fundingRate?: number; fundingIntervalMs: Ms; ts: Ms } = {
    fundingIntervalMs,
    ts: Number.isFinite(next) && next > 0 ? next : now,
  }
  if (Number.isFinite(rate)) out.fundingRate = rate
  return out
}

/**
 * ticker + current-fund-rate → MarketContext：标记价、指数价、资金费率、资金间隔、持仓量、24h 成交额。
 * Bitget 不给「下次资金时间」的协议字段，fundingIntervalMs 由 fundingRateInterval 小时数换算。
 */
export function parseContext(
  ticker: RawTicker | null | undefined,
  funding: RawFundingRate | null | undefined,
  instrumentId: string,
  now: Ms,
): MarketContext {
  const ts = num(ticker?.ts)
  const markPrice = num(ticker?.markPrice)
  const last = num(ticker?.lastPr)
  const indexPrice = num(ticker?.indexPrice)
  const bid = num(ticker?.bidPr)
  const ask = num(ticker?.askPr)
  const rate = parseFundingRate(funding, now)
  const tickerRate = num(ticker?.fundingRate)
  const openInterest = num(ticker?.holdingAmount)
  const dayNotionalVolume = num(ticker?.quoteVolume)
  const prevDayPrice = num(ticker?.open24h)

  const context: MarketContext = {
    instrumentId,
    ts: Number.isFinite(ts) && ts > 0 ? ts : now,
    markPrice: Number.isFinite(markPrice) ? markPrice : Number.isFinite(last) ? last : 0,
    fundingIntervalMs: rate.fundingIntervalMs,
  }
  if (Number.isFinite(indexPrice) && indexPrice > 0) context.oraclePrice = indexPrice
  if (bid > 0 && ask > 0) context.midPrice = (bid + ask) / 2
  if (rate.fundingRate !== undefined) context.fundingRate = rate.fundingRate
  else if (Number.isFinite(tickerRate)) context.fundingRate = tickerRate
  if (Number.isFinite(openInterest) && openInterest > 0) context.openInterest = openInterest
  if (Number.isFinite(dayNotionalVolume) && dayNotionalVolume > 0) context.dayNotionalVolume = dayNotionalVolume
  if (Number.isFinite(prevDayPrice) && prevDayPrice > 0) context.prevDayPrice = prevDayPrice
  return context
}

// ---- 请求计次（Bitget 公共端点按次 / 秒，不按权重） ---------------------------

export const CONTRACTS_WEIGHT = 1
export const TICKER_WEIGHT = 1
export const DEPTH_WEIGHT = 1
export const FUNDING_WEIGHT = 1
export const CANDLES_WEIGHT = 1
export const HISTORY_CANDLES_WEIGHT = 1

/** /mix/market/merge-depth 只接受 1 / 5 / 15 / 50 / max 五档。 */
export const DEPTH_LIMITS = ['1', '5', '15', '50', 'max'] as const
export type DepthLimit = (typeof DEPTH_LIMITS)[number]

/** 请求的深度向上取到官方允许的档位（缺省 20 → 50 档）。 */
export function depthLimitOf(depth: number | undefined): DepthLimit {
  const want = Number.isFinite(depth) && (depth as number) > 0 ? Math.ceil(depth as number) : 20
  if (want <= 1) return '1'
  if (want <= 5) return '5'
  if (want <= 15) return '15'
  if (want <= 50) return '50'
  return 'max'
}
