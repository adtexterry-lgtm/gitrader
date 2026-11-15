// SPDX-License-Identifier: CPAL-1.0
// dYdX v4 Indexer 公共响应 → 统一模型（纯函数，无状态；不发请求、不读环境）。
// Indexer 的数值一律是字符串、K 线时间是 ISO 字符串且整页倒序；解析不了的回落到协议允许的缺省，不猜精度。
import { asDecimal, makeProblem, normalizeDecimal } from '@gitrader/protocol'
import type {
  Book, BookLevel, Candle, CandleInterval, Decimal, Instrument, InstrumentPriceRule, InstrumentSizeRule, InstrumentStatus,
  MarketContext, Ms, Problem, ProblemName,
} from '@gitrader/protocol'

export const VENUE = 'dydx'
/** dYdX v4 Indexer 公共端点缺省基址（免鉴权，全部在 /v4 下）；可注入（测试与镜像用）。 */
export const DEFAULT_BASE_URL = 'https://indexer.dydx.trade'
/** dYdX v4 永续每小时结算一次资金费（整点）。 */
export const FUNDING_INTERVAL_MS: Ms = 3_600_000
/** /v4/candles/perpetualMarkets 单次上限。 */
export const MAX_CANDLES = 1000
export const CANDLE_PAGE = 1000
/** 区间翻页硬上限：200 × 1000 根，防上游异常时死循环。 */
export const MAX_PAGES = 200
export const DEFAULT_CANDLE_COUNT = 300
/** Indexer 公共端点按 IP 限频约 100 次 / 10 秒（model = count，不是 weight）。 */
export const IP_RATE_LIMIT = 100
export const IP_RATE_WINDOW_MS: Ms = 10_000
/** Indexer 的盘口端点一次给整本（不认 limit），本地截断到 500 档。 */
export const MAX_BOOK_DEPTH = 500

/** 协议区间 → 毫秒（翻页游标按它推进）。 */
export const INTERVAL_MS: Record<CandleInterval, number> = {
  '1m': 60_000, '3m': 180_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000,
  '1h': 3_600_000, '2h': 7_200_000, '4h': 14_400_000, '8h': 28_800_000, '12h': 43_200_000,
  '1d': 86_400_000, '3d': 259_200_000, '1w': 604_800_000, '1M': 2_592_000_000,
}

/** 协议区间 → Indexer 的 resolution 拼写（Indexer 只认这 7 个，其余周期本所没有）。 */
export const RESOLUTION_OF: Record<string, string> = {
  '1m': '1MIN', '5m': '5MINS', '15m': '15MINS', '30m': '30MINS', '1h': '1HOUR', '4h': '4HOURS', '1d': '1DAY',
}

export const instrumentIdOf = (ticker: string): string => `${VENUE}:${ticker}`

/** `dydx:<ticker>` → 场所原生 ticker（原样保留大小写）；不是本场所的 id 就拒绝。 */
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

/** 协议周期 → Indexer resolution；不在本所表里的一律 INVALID_PARAMS（不发请求）。 */
export function resolutionOf(interval: CandleInterval): string {
  const resolution = RESOLUTION_OF[interval]
  if (!resolution) throw problemError('INVALID_PARAMS', `unsupported candle interval: ${String(interval)}`)
  return resolution
}

/** 毫秒 → Indexer 接受的 ISO 字符串（fromISO / toISO 都是带毫秒的 UTC）。 */
export const isoOf = (ms: number): string => new Date(ms).toISOString()

// ---- 原始形状 ---------------------------------------------------------------

/** Indexer 的错误信封：`{ errors: [{ msg, param?, location?, value? }] }`，通常伴随非 2xx。 */
export interface RawErrors { errors?: { msg?: string; param?: string; location?: string; value?: string }[] }

export interface RawPerpetualMarket {
  clobPairId?: string
  ticker?: string
  status?: string
  oraclePrice?: string
  priceChange24H?: string
  volume24H?: string
  trades24H?: number
  nextFundingRate?: string
  initialMarginFraction?: string
  maintenanceMarginFraction?: string
  openInterest?: string
  atomicResolution?: number
  quantumConversionExponent?: number
  tickSize?: string
  stepSize?: string
  stepBaseQuantums?: number
  subticksPerTick?: number
  marketType?: string
  baseOpenInterest?: string
  defaultFundingRate1H?: string
}

export interface RawMarketsResponse { markets?: Record<string, RawPerpetualMarket> }

export interface RawLevel { price?: string; size?: string }
export interface RawOrderbook { bids?: RawLevel[]; asks?: RawLevel[] }

export interface RawTrade { id?: string; side?: string; size?: string; price?: string; type?: string; createdAt?: string }
export interface RawTradesResponse { trades?: RawTrade[] }

export interface RawCandle {
  startedAt?: string
  ticker?: string
  resolution?: string
  low?: string
  high?: string
  open?: string
  close?: string
  baseTokenVolume?: string
  usdVolume?: string
  trades?: number
  startingOpenInterest?: string
}

export interface RawCandlesResponse { candles?: RawCandle[] }

/** Indexer 的字符串数值 → number；空串 / 非数字一律 NaN（Indexer 用 "" 表示「还没有值」）。 */
export const num = (v: unknown): number => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN
  if (typeof v !== 'string') return NaN
  const s = v.trim()
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

/** `BTC-USD` → base `BTC` / quote `USD`（dYdX v4 永续一律以 USD 计价）。 */
function splitTicker(ticker: string): { base: string; quote: string } {
  const i = ticker.indexOf('-')
  if (i <= 0) return { base: ticker, quote: 'USD' }
  const quote = ticker.slice(i + 1)
  return { base: ticker.slice(0, i), quote: quote === '' ? 'USD' : quote }
}

/** Indexer status：ACTIVE 可交易；FINAL_SETTLEMENT（及其它）按已下架处理。 */
function statusOf(status: string | undefined): InstrumentStatus {
  return status === 'ACTIVE' ? 'trading' : 'delisted'
}

// ---- /v4/perpetualMarkets → Instrument --------------------------------------

export function parseInstrument(market: RawPerpetualMarket, ticker: string, now: Ms): Instrument | undefined {
  if (typeof ticker !== 'string' || ticker === '') return undefined
  const { base, quote } = splitTicker(ticker)

  const tick = positiveDecimal(market.tickSize)
  const price: InstrumentPriceRule = tick ? { tick, maxDecimals: decimalsOf(tick) } : { sigFigs: 5, maxDecimals: 8 }

  // dYdX v4 的下单数量就是标的币数量（venueSizeUnit = base），stepSize 即最小步进。
  const step = positiveDecimal(market.stepSize) ?? asDecimal('1')
  const size: InstrumentSizeRule = { step, decimals: decimalsOf(step), min: step }

  return {
    instrumentId: instrumentIdOf(ticker),
    venue: VENUE,
    symbol: ticker,
    displaySymbol: `${base}-PERP`,
    kind: 'perp',
    base,
    quote,
    // dYdX v4 统一以 USDC 结算
    settle: 'USDC',
    settlement: 'linear',
    contractSize: asDecimal('1'),
    venueSizeUnit: 'base',
    assetClass: 'crypto',
    marketGroup: null,
    status: statusOf(market.status),
    price,
    size,
    // 只读数据连接器：不下单，所以标的层面也不声明任何可下单类型
    orderTypes: [],
    tif: [],
    triggerPriceTypes: [],
    fundingIntervalMs: FUNDING_INTERVAL_MS,
    sessions: { tz: 'UTC', windows: [{ days: [0, 1, 2, 3, 4, 5, 6], from: '00:00', to: '23:59', quality: 'regular' }] },
    updatedAt: now,
  }
}

/**
 * /v4/perpetualMarkets 的 `markets` 对象 → 标的 + 原始条目（context 用）。
 * 键是 ticker；条目里通常也带 ticker，两者不一致时以键为准（Indexer 以键索引）。
 */
export function parseMarkets(
  raw: unknown,
  now: Ms,
): { instruments: Instrument[]; markets: Map<string, RawPerpetualMarket> } {
  const markets = new Map<string, RawPerpetualMarket>()
  const instruments: Instrument[] = []
  const source = (raw as RawMarketsResponse | null | undefined)?.markets
  if (!source || typeof source !== 'object') return { instruments, markets }
  for (const [ticker, entry] of Object.entries(source)) {
    if (!entry || typeof entry !== 'object') continue
    const market = entry as RawPerpetualMarket
    const instrument = parseInstrument(market, ticker, now)
    if (!instrument) continue
    markets.set(ticker, market)
    instruments.push(instrument)
  }
  instruments.sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0))
  return { instruments, markets }
}

/** 只要标的列表（测试与上层便利函数用）。 */
export function parseInstruments(raw: unknown, now: Ms): Instrument[] {
  return parseMarkets(raw, now).instruments
}

// ---- 行情 -------------------------------------------------------------------

/** ISO 字符串（或秒 / 毫秒数字）→ 开盘毫秒；解析不了一律 NaN。 */
export function candleTime(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN
  if (typeof v !== 'string') return NaN
  const s = v.trim()
  if (s === '') return NaN
  if (/^-?\d+(\.\d+)?$/.test(s)) {
    const n = Number(s)
    if (!Number.isFinite(n)) return NaN
    // 纯数字多半是秒级时间戳；已经够大的按毫秒处理
    return n < 1e11 ? n * 1000 : n
  }
  const parsed = Date.parse(s)
  return Number.isFinite(parsed) ? parsed : NaN
}

/**
 * candles[] → Candle。列名不像 CEX 那样是数组下标：startedAt 是 ISO 字符串，
 * open/high/low/close/baseTokenVolume 是字符串。Indexer 整页倒序，这里只逐行解析，
 * 升降序与去重交给调用方。
 */
export function parseCandles(raw: unknown): Candle[] {
  const rows = Array.isArray(raw)
    ? raw
    : (raw as RawCandlesResponse | null | undefined)?.candles
  if (!Array.isArray(rows)) return []
  const out: Candle[] = []
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const r = row as RawCandle
    const t = candleTime(r.startedAt)
    const o = num(r.open)
    const h = num(r.high)
    const l = num(r.low)
    const c = num(r.close)
    const v = num(r.baseTokenVolume)
    if (![t, o, h, l, c, v].every((x) => Number.isFinite(x))) continue
    out.push({ t, o, h, l, c, v })
  }
  return out
}

/** 盘口 → Book；bids 降序、asks 升序，按 depth 截断。Indexer 不给盘口时间戳，用 now。 */
export function parseOrderbook(raw: unknown, instrumentId: string, depth: number, now: Ms): Book {
  const book = (raw ?? {}) as RawOrderbook
  const levels = (rows: unknown): BookLevel[] => {
    if (!Array.isArray(rows)) return []
    const out: BookLevel[] = []
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue
      const level = row as RawLevel
      const price = num(level.price)
      const size = num(level.size)
      if (!(price > 0) || !(size > 0)) continue
      out.push({ price, size })
    }
    return out
  }
  const bids = levels(book.bids).sort((a, b) => b.price - a.price).slice(0, depth)
  const asks = levels(book.asks).sort((a, b) => a.price - b.price).slice(0, depth)
  return { instrumentId, ts: now, bids, asks }
}

/** 盘口最优档 → { bid, ask }；任一侧缺失或非正视为没有报价。 */
export function parseTopOfBook(raw: unknown): { bid: number; ask: number } | undefined {
  const book = (raw ?? {}) as RawOrderbook
  const best = (rows: RawLevel[] | undefined, pick: (a: number, b: number) => number): number => {
    if (!Array.isArray(rows)) return NaN
    let out = NaN
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue
      const price = num(row.price)
      if (!(price > 0)) continue
      out = Number.isFinite(out) ? pick(out, price) : price
    }
    return out
  }
  const bid = best(book.bids, Math.max)
  const ask = best(book.asks, Math.min)
  if (!(bid > 0) || !(ask > 0)) return undefined
  return { bid, ask }
}

/** /v4/trades?limit=1 → 最近一笔成交价；没有成交返回 undefined。 */
export function parseLastTradePrice(raw: unknown): number | undefined {
  const trades = (raw as RawTradesResponse | null | undefined)?.trades
  if (!Array.isArray(trades) || trades.length === 0) return undefined
  const price = num(trades[0]?.price)
  return price > 0 ? price : undefined
}

/**
 * 市场条目（perpetualMarkets）→ MarketContext：oraclePrice 作标记价、nextFundingRate 作资金费率、
 * 资金间隔固定 1 小时；openInterest 有就给。Indexer 不给下次资金时间字段，留协议缺省。
 */
export function parseContext(market: RawPerpetualMarket | undefined, instrumentId: string, now: Ms): MarketContext {
  const oracle = num(market?.oraclePrice)
  const fundingRate = num(market?.nextFundingRate)
  const openInterest = num(market?.openInterest)
  const context: MarketContext = {
    instrumentId,
    ts: now,
    markPrice: Number.isFinite(oracle) && oracle > 0 ? oracle : 0,
    fundingIntervalMs: FUNDING_INTERVAL_MS,
  }
  if (Number.isFinite(oracle) && oracle > 0) context.oraclePrice = oracle
  if (Number.isFinite(fundingRate)) context.fundingRate = fundingRate
  if (Number.isFinite(openInterest) && openInterest >= 0) context.openInterest = openInterest
  return context
}

// ---- 请求计次（Indexer 按调用次数计，不区分端点） ---------------------------

export const MARKETS_WEIGHT = 1
export const CANDLES_WEIGHT = 1
export const ORDERBOOK_WEIGHT = 1
export const TRADES_WEIGHT = 1

/** 请求的深度向上取整并钳到 1..500（Indexer 盘口一次给整本，本地截断）。 */
export function depthLimitOf(depth: number | undefined): number {
  const want = Number.isFinite(depth) && (depth as number) > 0 ? Math.ceil(depth as number) : 20
  return Math.max(1, Math.min(MAX_BOOK_DEPTH, want))
}
