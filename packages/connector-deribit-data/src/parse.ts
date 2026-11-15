// SPDX-License-Identifier: CPAL-1.0
// Deribit v2 公共 JSON-RPC 响应 → 统一模型（纯函数，无状态；不发请求、不读环境）。
// 响应一律包在 `{ jsonrpc, result, error? }` 里；数值多数是 JSON number（少数为字符串），解析不了的回落到协议允许的缺省，不猜精度。
import { asDecimal, makeProblem, normalizeDecimal } from '@gitrader/protocol'
import { mulDec } from '@gitrader/protocol/decimal'
import type {
  Book, BookLevel, Candle, CandleInterval, Decimal, Instrument, InstrumentPriceRule, InstrumentSizeRule, InstrumentStatus,
  MarketContext, Ms, Problem, ProblemName,
} from '@gitrader/protocol'

export const VENUE = 'deribit'
/** Deribit v2 公共 REST 缺省基址；可注入（测试与镜像用）。 */
export const DEFAULT_BASE_URL = 'https://www.deribit.com'
/** 永续连续计息，官方以 8 小时口径给 `current_funding` / `funding_8h`。 */
export const FUNDING_INTERVAL_MS: Ms = 28_800_000
/** /public/get_tradingview_chart_data 单次最多 1000 根。 */
export const MAX_CANDLES = 1000
export const CANDLE_PAGE = 1000
/** 区间翻页硬上限：200 × 1000 根，防上游异常时死循环。 */
export const MAX_PAGES = 200
export const DEFAULT_CANDLE_COUNT = 300
/** 公共端点按 IP、按请求次数限频：约 20 次 / 秒（model = count，不是 weight）。 */
export const IP_RATE_LIMIT = 20
export const IP_RATE_WINDOW_MS: Ms = 1_000
/** /public/get_order_book 的 depth 上限。 */
export const MAX_BOOK_DEPTH = 10_000
/** 计数模型下每个请求记 1 次额度。 */
export const REQUEST_COST = 1

/** 协议区间 → 毫秒（翻页窗口按它推进）。 */
export const INTERVAL_MS: Record<CandleInterval, number> = {
  '1m': 60_000, '3m': 180_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000,
  '1h': 3_600_000, '2h': 7_200_000, '4h': 14_400_000, '8h': 28_800_000, '12h': 43_200_000,
  '1d': 86_400_000, '3d': 259_200_000, '1w': 604_800_000, '1M': 2_592_000_000,
}

/**
 * 协议区间 → Deribit tradingview resolution。
 * Deribit 只认 1/3/5/15/30/60/120/180/360/720/1D：8h、3d、1w、1M 无对应值，按工单不发请求直接拒绝。
 */
export const RESOLUTION_OF: Partial<Record<CandleInterval, string>> = {
  '1m': '1', '3m': '3', '5m': '5', '15m': '15', '30m': '30',
  '1h': '60', '2h': '120', '4h': '240', '12h': '720',
  '1d': '1D',
}

export const instrumentIdOf = (symbol: string): string => `${VENUE}:${symbol}`

/** `deribit:<instrument_name>` → 场所原生 instrument_name；不是本场所的 id 就拒绝，避免把别的场所符号发到 Deribit。 */
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

/** 协议周期 → Deribit resolution；不在表里的周期直接 INVALID_PARAMS（不发请求）。 */
export function resolutionOf(interval: CandleInterval): string {
  const resolution = RESOLUTION_OF[interval]
  if (!resolution) throw problemError('INVALID_PARAMS', `unsupported candle interval: ${String(interval)}`)
  return resolution
}

// ---- 原始形状 ---------------------------------------------------------------

/** Deribit v2 的统一信封：成功带 `result`，失败带 `error`（HTTP 也常是 4xx / 5xx）。 */
export interface DeribitEnvelope<T> {
  jsonrpc?: string
  result?: T
  error?: { code?: number | string; message?: string; data?: unknown }
  testnet?: boolean
}

export interface RawInstrument {
  instrument_name?: string
  kind?: string
  is_active?: boolean
  state?: string
  settlement_period?: string
  tick_size?: number | string
  contract_size?: number | string
  min_trade_amount?: number | string
  lot_size?: number | string
  base_currency?: string
  quote_currency?: string
  settlement_currency?: string
  instrument_type?: string
  expiration_timestamp?: number
  creation_timestamp?: number
}

export interface RawTicker {
  instrument_name?: string
  timestamp?: number
  state?: string
  best_bid_price?: number | string | null
  best_ask_price?: number | string | null
  last_price?: number | string | null
  mark_price?: number | string | null
  index_price?: number | string | null
  current_funding?: number | string | null
  funding_8h?: number | string | null
  open_interest?: number | string | null
  estimated_delivery_price?: number | string | null
  stats?: { volume?: number; volume_usd?: number; high?: number; low?: number; price_change?: number }
}

export interface RawOrderBook {
  instrument_name?: string
  timestamp?: number
  change_id?: number
  bids?: unknown[]
  asks?: unknown[]
  mark_price?: number | null
  index_price?: number | null
}

/** 列式 K 线：ticks / open / high / low / close / volume 是等长数组，status 为 `ok` / `no_data`。 */
export interface RawChart {
  ticks?: unknown[]
  open?: unknown[]
  high?: unknown[]
  low?: unknown[]
  close?: unknown[]
  volume?: unknown[]
  status?: string
}

export const num = (v: unknown): number => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN
  if (typeof v !== 'string') return NaN
  const s = v.trim()
  // Deribit 用 null 表示「没有这个字段的值」；空串同理，不能当 0
  if (s === '') return NaN
  const n = Number(s)
  return Number.isFinite(n) ? n : NaN
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

/** Deribit state：open / settlement / delivery / closed / archived（未激活条目的状态由 is_active 兜住）。 */
function statusOf(state: string | undefined, active: boolean): InstrumentStatus {
  switch (state) {
    case 'open': return 'trading'
    case 'settlement':
    case 'delivery': return 'halted'
    case 'closed':
    case 'archived': return 'delisted'
    default: return active ? 'trading' : 'halted'
  }
}

// ---- /public/get_instruments → Instrument -----------------------------------

/**
 * 一条 get_instruments 结果 → Instrument。
 * Deribit 的永续也在 `kind: 'future'` 里，靠 `settlement_period: 'perpetual'` 区分永续与交割（day / week / month）。
 * 工单要求只取 `is_active === true`；期权等其它 kind 一律跳过。
 * 只收线性（USDC 结算）合约：settlement_currency（或 quote_currency）为 USDC 才进清单，币本位与其它结算币一律排除。
 */
export function parseInstrument(s: RawInstrument, now: Ms): Instrument | undefined {
  const name = typeof s.instrument_name === 'string' && s.instrument_name !== '' ? s.instrument_name : undefined
  if (!name) return undefined
  if (typeof s.kind === 'string' && s.kind !== 'future') return undefined
  if (s.is_active !== true) return undefined

  const period = typeof s.settlement_period === 'string' ? s.settlement_period : ''
  const isPerp = period === 'perpetual'
  const base = typeof s.base_currency === 'string' && s.base_currency !== '' ? s.base_currency : (name.split('-')[0] ?? name)
  const quote = typeof s.quote_currency === 'string' && s.quote_currency !== '' ? s.quote_currency : 'USD'
  const settle = typeof s.settlement_currency === 'string' && s.settlement_currency !== '' ? s.settlement_currency : base

  // 只收线性（USDC 结算）合约：settlement_currency 为 USDC（清单缺该字段时看 quote_currency）才进清单。
  // 币本位（settlement = 标的币，如 BTC-PERPETUAL 的 BTC）与其它结算币（USD / USDT…）一律排除。
  if (settle !== 'USDC' && quote !== 'USDC') return undefined

  const tick = positiveDecimal(s.tick_size)
  const price: InstrumentPriceRule = tick ? { tick, maxDecimals: decimalsOf(tick) } : { sigFigs: 5, maxDecimals: 8 }

  // 数量单位是「张」：lot_size（步长）与 min_trade_amount（最小量）都是张数，× contract_size 折成币。
  // 协议数量一律按币计（venueSizeUnit = 'base'）；面值本身留在 contractSize（协议 Instrument 没有 x- 扩展键槽位）。
  const contractSize = positiveDecimal(s.contract_size) ?? asDecimal('1')
  const lotSize = positiveDecimal(s.lot_size) ?? asDecimal('1')
  const step = mulDec(lotSize, contractSize)
  const minQty = mulDec(positiveDecimal(s.min_trade_amount) ?? lotSize, contractSize)
  const size: InstrumentSizeRule = { step, decimals: decimalsOf(step), min: minQty }

  const instrument: Instrument = {
    instrumentId: instrumentIdOf(name),
    venue: VENUE,
    symbol: name,
    displaySymbol: isPerp ? `${base}-PERP` : name,
    kind: isPerp ? 'perp' : 'future',
    base,
    quote,
    settle,
    // 币本位已在上面按 settlement_currency 排除，这里只剩线性合约
    settlement: 'linear',
    contractSize,
    venueSizeUnit: 'base',
    assetClass: 'crypto',
    marketGroup: null,
    status: statusOf(s.state, s.is_active === true),
    price,
    size,
    // 只读数据连接器：不下单，所以标的层面也不声明任何可下单类型
    orderTypes: [],
    tif: [],
    triggerPriceTypes: [],
    sessions: { tz: 'UTC', windows: [{ days: [0, 1, 2, 3, 4, 5, 6], from: '00:00', to: '23:59', quality: 'regular' }] },
    updatedAt: now,
  }
  // 永续才声明资金间隔；交割合约没有资金费
  if (isPerp) instrument.fundingIntervalMs = FUNDING_INTERVAL_MS
  return instrument
}

/** get_instruments 的 `result[]` → 标的（按 symbol 升序；未激活 / 非 future 已剔除）。 */
export function parseInstruments(raw: unknown, now: Ms): Instrument[] {
  if (!Array.isArray(raw)) return []
  const out: Instrument[] = []
  for (const s of raw) {
    if (!s || typeof s !== 'object') continue
    const instrument = parseInstrument(s as RawInstrument, now)
    if (instrument) out.push(instrument)
  }
  return out.sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0))
}

// ---- 行情 -------------------------------------------------------------------

/**
 * 列式 K 线 → 行式 Candle（t 已是毫秒，Deribit 不返回秒）。
 * 六列按最短一列对齐；缺列 / 非有限值的那一根跳过，不猜价格。
 * `volume` 按 Deribit 文档（public/get_tradingview_chart_data 的 volume 字段）以基础币计量，直接透传、不再乘面值。
 */
export function parseChart(raw: unknown): Candle[] {
  const chart = (raw ?? {}) as RawChart
  const ticks = Array.isArray(chart.ticks) ? chart.ticks : []
  const open = Array.isArray(chart.open) ? chart.open : []
  const high = Array.isArray(chart.high) ? chart.high : []
  const low = Array.isArray(chart.low) ? chart.low : []
  const close = Array.isArray(chart.close) ? chart.close : []
  const volume = Array.isArray(chart.volume) ? chart.volume : []
  const length = Math.min(ticks.length, open.length, high.length, low.length, close.length, volume.length)

  const out: Candle[] = []
  for (let i = 0; i < length; i++) {
    const t = num(ticks[i])
    const o = num(open[i])
    const h = num(high[i])
    const l = num(low[i])
    const c = num(close[i])
    const v = num(volume[i])
    if (![t, o, h, l, c, v].every((x) => Number.isFinite(x))) continue
    out.push({ t, o, h, l, c, v })
  }
  return out
}

/**
 * ticker → { ts, bid, ask, last? }；买卖价缺失或非正（新标的上游偶发 null）视为没有报价。
 * ticker 里以张计的数量字段（best_bid_amount / best_ask_amount / stats.volume）没有进 Quote，无需折算；
 * 真正会被折算的是 context() 的 `open_interest`（见 parseContext）。
 * 价格字段与数量单位无关，原样透传。
 */
export function parseTicker(
  raw: RawTicker | null | undefined,
  now: Ms,
): { ts: Ms; bid: number; ask: number; last?: number } | undefined {
  if (!raw) return undefined
  const bid = num(raw.best_bid_price)
  const ask = num(raw.best_ask_price)
  if (!(bid > 0) || !(ask > 0)) return undefined
  const tsRaw = num(raw.timestamp)
  const last = num(raw.last_price)
  const out: { ts: Ms; bid: number; ask: number; last?: number } = {
    ts: Number.isFinite(tsRaw) && tsRaw > 0 ? tsRaw : now,
    bid,
    ask,
  }
  if (last > 0) out.last = last
  return out
}

/**
 * get_order_book → Book；bids 降序、asks 升序，按 depth 截断。
 * 盘口 amount 是张数：给了 contractSize 就 × 它折成币；拿不到面值（清单未缓存）时按原值透传。
 */
export function parseOrderBook(
  raw: RawOrderBook | null | undefined,
  instrumentId: string,
  depth: number,
  now: Ms,
  contractSize?: Decimal,
): Book {
  const ctVal = contractSize === undefined ? NaN : num(contractSize)
  const factor = contractSize !== undefined && ctVal > 0 ? contractSize : undefined
  const levels = (rows: unknown): BookLevel[] => {
    if (!Array.isArray(rows)) return []
    const out: BookLevel[] = []
    for (const row of rows) {
      if (!Array.isArray(row)) continue
      const price = num(row[0])
      const size = num(row[1])
      if (!(price > 0) || !(size > 0)) continue
      out.push({ price, size: factor === undefined ? size : Number(mulDec(String(size), factor)) })
    }
    return out
  }
  const bids = levels(raw?.bids).sort((a, b) => b.price - a.price).slice(0, depth)
  const asks = levels(raw?.asks).sort((a, b) => a.price - b.price).slice(0, depth)
  const tsRaw = num(raw?.timestamp)
  return { instrumentId, ts: Number.isFinite(tsRaw) && tsRaw > 0 ? tsRaw : now, bids, asks }
}

/**
 * ticker → MarketContext：标记价、指数价、资金费率、资金间隔 8h、未平仓数量。
 * 资金费率优先 `current_funding`（永续当期值），缺失回落到 `funding_8h`（8 小时口径均值）；交割合约两者都没有。
 * `open_interest` 是张数：给了 contractSize 就 × 它折成币（与盘口 / 步长同口径）；拿不到面值按原值透传。
 */
export function parseContext(
  raw: RawTicker | null | undefined,
  instrumentId: string,
  now: Ms,
  contractSize?: Decimal,
): MarketContext {
  const markPrice = num(raw?.mark_price)
  const indexPrice = num(raw?.index_price)
  const lastPrice = num(raw?.last_price)
  const currentFunding = num(raw?.current_funding)
  const funding8h = num(raw?.funding_8h)
  const openInterest = num(raw?.open_interest)
  const ctVal = contractSize === undefined ? NaN : num(contractSize)
  const factor = contractSize !== undefined && ctVal > 0 ? contractSize : undefined
  const tsRaw = num(raw?.timestamp)

  const context: MarketContext = {
    instrumentId,
    ts: Number.isFinite(tsRaw) && tsRaw > 0 ? tsRaw : now,
    markPrice: Number.isFinite(markPrice) ? markPrice : Number.isFinite(indexPrice) ? indexPrice : Number.isFinite(lastPrice) ? lastPrice : 0,
    fundingIntervalMs: FUNDING_INTERVAL_MS,
  }
  if (Number.isFinite(indexPrice)) context.oraclePrice = indexPrice
  const fundingRate = Number.isFinite(currentFunding) ? currentFunding : funding8h
  if (Number.isFinite(fundingRate)) context.fundingRate = fundingRate
  if (Number.isFinite(openInterest)) {
    context.openInterest = factor === undefined ? openInterest : Number(mulDec(String(openInterest), factor))
  }
  return context
}

/** 请求的深度向上取整并钳到 1..10000（get_order_book 的 depth 是「价格档数」）。 */
export function depthLimitOf(depth: number | undefined): number {
  const want = Number.isFinite(depth) && (depth as number) > 0 ? Math.ceil(depth as number) : 20
  return Math.max(1, Math.min(MAX_BOOK_DEPTH, want))
}
