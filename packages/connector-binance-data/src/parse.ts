// SPDX-License-Identifier: CPAL-1.0
// Binance USDⓈ-M 期货公共 REST 响应 → 统一模型（纯函数，无状态；不发请求、不读环境）。
// 原始响应里的数值全是字符串，字段可能缺失；解析不了的一律回落到协议允许的缺省，不猜精度。
import { asDecimal, makeProblem, normalizeDecimal } from '@gitrader/protocol'
import type {
  Book, BookLevel, Candle, CandleInterval, Decimal, FundingRatePoint, Instrument, InstrumentPriceRule, InstrumentSizeRule, InstrumentStatus,
  MarketContext, Ms, Problem, ProblemName,
} from '@gitrader/protocol'

export const VENUE = 'binance'
/** USDⓈ-M 期货公共 REST 缺省基址；可注入（测试与镜像用）。 */
export const DEFAULT_BASE_URL = 'https://fapi.binance.com'
/** USDⓈ-M 永续每 8 小时结算一次资金费（00/08/16 UTC）。 */
export const FUNDING_INTERVAL_MS: Ms = 28_800_000
/** 官方 /fapi/v1/klines 单次上限。 */
export const MAX_CANDLES = 1500
export const CANDLE_PAGE = 1500
/** 区间翻页硬上限：200 × 1500 根，防上游异常时死循环。 */
export const MAX_PAGES = 200
export const DEFAULT_CANDLE_COUNT = 300
/** 官方按 IP 的请求权重上限（每分钟）。 */
export const IP_WEIGHT_LIMIT = 2400
export const IP_WEIGHT_WINDOW_MS: Ms = 60_000

/** 协议区间 → 毫秒（翻页游标按它推进）。区间名与 Binance 原生写法一致。 */
export const INTERVAL_MS: Record<CandleInterval, number> = {
  '1m': 60_000, '3m': 180_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000,
  '1h': 3_600_000, '2h': 7_200_000, '4h': 14_400_000, '8h': 28_800_000, '12h': 43_200_000,
  '1d': 86_400_000, '3d': 259_200_000, '1w': 604_800_000, '1M': 2_592_000_000,
}

export const instrumentIdOf = (symbol: string): string => `${VENUE}:${symbol}`

/** `binance:<symbol>` → 场所原生 symbol；不是本场所的 id 就拒绝，避免把别的场所符号发到 Binance。 */
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

// ---- 原始形状 ---------------------------------------------------------------

export interface RawFilter {
  filterType?: string
  tickSize?: string
  stepSize?: string
  minQty?: string
  notional?: string
  minNotional?: string
}

export interface RawSymbol {
  symbol?: string
  pair?: string
  contractType?: string
  status?: string
  baseAsset?: string
  quoteAsset?: string
  marginAsset?: string
  pricePrecision?: number
  quantityPrecision?: number
  filters?: RawFilter[]
}

export interface RawExchangeInfo { symbols?: RawSymbol[] }
export interface RawBookTicker { symbol?: string; bidPrice?: string; askPrice?: string; bidQty?: string; askQty?: string; time?: number }
export interface RawDepth { lastUpdateId?: number; E?: number; T?: number; bids?: unknown[]; asks?: unknown[] }
export interface RawPremiumIndex {
  symbol?: string; markPrice?: string; indexPrice?: string; lastFundingRate?: string; nextFundingTime?: number; time?: number
}
/** GET /fapi/v1/fundingRate 的一行：结算时间（毫秒）与该次结算的资金费率。 */
export interface RawFundingRate { symbol?: string; fundingTime?: number; fundingRate?: string; markPrice?: string }

export const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
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

function splitSymbol(symbol: string, quoteAsset: string): { base: string; quote: string } {
  if (quoteAsset !== '' && symbol.endsWith(quoteAsset) && symbol.length > quoteAsset.length) {
    return { base: symbol.slice(0, -quoteAsset.length), quote: quoteAsset }
  }
  for (const q of ['USDT', 'USDC', 'BUSD', 'USD']) {
    if (symbol.endsWith(q) && symbol.length > q.length) return { base: symbol.slice(0, -q.length), quote: q }
  }
  return { base: symbol, quote: quoteAsset === '' ? 'USDT' : quoteAsset }
}

function statusOf(status: string | undefined): InstrumentStatus {
  switch (status) {
    case 'TRADING': return 'trading'
    case 'CLOSE':
    case 'PRE_DELIVERING':
    case 'DELIVERING': return 'delisted'
    case 'SETTLING':
    case 'PRE_SETTLE': return 'halted'
    default: return 'halted'
  }
}

// ---- exchangeInfo → Instrument ----------------------------------------------

export function parseInstrument(s: RawSymbol, now: Ms): Instrument | undefined {
  const symbol = typeof s.symbol === 'string' && s.symbol !== '' ? s.symbol : undefined
  if (!symbol) return undefined
  // 只收永续：交割合约 / 非合约条目一律跳过
  if (typeof s.contractType === 'string' && s.contractType !== 'PERPETUAL') return undefined
  const quoteAsset = typeof s.quoteAsset === 'string' ? s.quoteAsset : ''
  const { base, quote } = splitSymbol(symbol, quoteAsset)
  const filters = Array.isArray(s.filters) ? s.filters : []
  const filter = (type: string): RawFilter | undefined => filters.find((f) => !!f && f.filterType === type)

  const tick = positiveDecimal(filter('PRICE_FILTER')?.tickSize)
  const pricePrecision = num(s.pricePrecision)
  const maxDecimals = Number.isInteger(pricePrecision) && pricePrecision >= 0 ? pricePrecision : tick ? decimalsOf(tick) : 8
  const price: InstrumentPriceRule = tick ? { tick, maxDecimals } : { sigFigs: 5, maxDecimals }

  const step = positiveDecimal(filter('LOT_SIZE')?.stepSize) ?? asDecimal('1')
  const minQty = positiveDecimal(filter('LOT_SIZE')?.minQty) ?? step
  const size: InstrumentSizeRule = { step, decimals: decimalsOf(step), min: minQty }
  const minNotional = positiveDecimal(filter('MIN_NOTIONAL')?.notional) ?? positiveDecimal(filter('MIN_NOTIONAL')?.minNotional)

  return {
    instrumentId: instrumentIdOf(symbol),
    venue: VENUE,
    symbol,
    displaySymbol: `${base}-PERP`,
    kind: 'perp',
    base,
    quote: quote === '' ? 'USDT' : quote,
    settle: typeof s.marginAsset === 'string' && s.marginAsset !== '' ? s.marginAsset : quote === '' ? 'USDT' : quote,
    settlement: 'linear',
    contractSize: asDecimal('1'),
    venueSizeUnit: 'base',
    assetClass: 'crypto',
    marketGroup: null,
    status: statusOf(s.status),
    price,
    size,
    ...(minNotional ? { minNotional } : {}),
    // 只读数据连接器：不下单，所以标的层面也不声明任何可下单类型
    orderTypes: [],
    tif: [],
    triggerPriceTypes: [],
    fundingIntervalMs: FUNDING_INTERVAL_MS,
    sessions: { tz: 'UTC', windows: [{ days: [0, 1, 2, 3, 4, 5, 6], from: '00:00', to: '23:59', quality: 'regular' }] },
    updatedAt: now,
  }
}

/** exchangeInfo 全量 → 标的（含已下架，由上层决定是否展示）。 */
export function parseInstruments(raw: unknown, now: Ms): Instrument[] {
  const list = (raw as RawExchangeInfo | null | undefined)?.symbols
  if (!Array.isArray(list)) return []
  const out: Instrument[] = []
  for (const s of list) {
    if (!s || typeof s !== 'object') continue
    const instrument = parseInstrument(s as RawSymbol, now)
    if (instrument) out.push(instrument)
  }
  return out.sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0))
}

// ---- 行情 -------------------------------------------------------------------

/** 12 列 kline 数组 → Candle（t 为开盘毫秒）。列顺序：开盘时间、O、H、L、C、量、…（其余忽略）。 */
export function parseKlines(raw: unknown): Candle[] {
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
    out.push({ t, o, h, l, c, v })
  }
  return out
}

/** bookTicker → { ts, bid, ask }；买卖价缺失或非正（上游偶发空串）视为没有报价。 */
export function parseBookTicker(
  raw: RawBookTicker | null | undefined,
  now: Ms,
): { ts: Ms; bid: number; ask: number } | undefined {
  if (!raw) return undefined
  const bid = num(raw.bidPrice)
  const ask = num(raw.askPrice)
  if (!(bid > 0) || !(ask > 0)) return undefined
  const ts = num(raw.time)
  return { ts: Number.isFinite(ts) && ts > 0 ? ts : now, bid, ask }
}

/** depth → Book；bids 降序、asks 升序，按 depth 截断。 */
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
  const ts = num(raw?.T ?? raw?.E)
  return { instrumentId, ts: Number.isFinite(ts) && ts > 0 ? ts : now, bids, asks }
}

/** fundingRate 响应 → 资金费历史点（升序）；时间或费率不合法的行跳过，不猜。 */
export function parseFundingRates(raw: unknown, instrumentId: string): FundingRatePoint[] {
  if (!Array.isArray(raw)) return []
  const out: FundingRatePoint[] = []
  for (const row of raw as RawFundingRate[]) {
    const t = num(row?.fundingTime)
    if (!Number.isFinite(t) || t < 0) continue
    let rate: Decimal
    try { rate = normalizeDecimal(String(row?.fundingRate ?? '')) } catch { continue }
    out.push({ instrumentId, t: Math.trunc(t) as Ms, rate })
  }
  return out.sort((a, b) => a.t - b.t)
}

/** premiumIndex → MarketContext：标记价、指数价（oracle）、资金费率、资金间隔。 */
export function parsePremiumIndex(raw: RawPremiumIndex | null | undefined, instrumentId: string, now: Ms): MarketContext {
  const markPrice = num(raw?.markPrice)
  const indexPrice = num(raw?.indexPrice)
  const fundingRate = num(raw?.lastFundingRate)
  const tsRaw = num(raw?.time)
  const context: MarketContext = {
    instrumentId,
    ts: Number.isFinite(tsRaw) && tsRaw > 0 ? tsRaw : now,
    markPrice: Number.isFinite(markPrice) ? markPrice : Number.isFinite(indexPrice) ? indexPrice : 0,
    fundingIntervalMs: FUNDING_INTERVAL_MS,
  }
  if (Number.isFinite(indexPrice)) context.oraclePrice = indexPrice
  if (Number.isFinite(fundingRate)) context.fundingRate = fundingRate
  return context
}

// ---- 权重（官方按 IP 的 weight 模型） ----------------------------------------

export const EXCHANGE_INFO_WEIGHT = 1
export const BOOK_TICKER_WEIGHT = 2
export const PREMIUM_INDEX_WEIGHT = 1
/** /fapi/v1/fundingRate：单页上限 1000 条，权重 1（官方另限每 5 分钟 500 次 / IP）。 */
export const FUNDING_RATE_WEIGHT = 1
export const FUNDING_PAGE = 1000
/** 公开行情只读 <= 2 次/秒：资金费翻页每页之间至少隔这么久。 */
export const FUNDING_PAGE_GAP_MS = 500

export const klineWeight = (limit: number): number => (limit <= 100 ? 1 : limit <= 500 ? 2 : limit <= 1000 ? 5 : 10)
export const depthWeight = (limit: number): number => (limit <= 50 ? 2 : limit <= 100 ? 5 : limit <= 500 ? 10 : 20)

const DEPTH_LIMITS = [5, 10, 20, 50, 100, 500, 1000] as const

/** 请求的深度向上取到官方允许的档位（只允许 5/10/20/50/100/500/1000）。 */
export function depthLimitOf(depth: number | undefined): number {
  const want = Number.isFinite(depth) && (depth as number) > 0 ? Math.ceil(depth as number) : 20
  for (const limit of DEPTH_LIMITS) if (limit >= want) return limit
  return 1000
}
