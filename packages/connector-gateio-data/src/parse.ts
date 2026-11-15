// SPDX-License-Identifier: CPAL-1.0
// Gate.io v4 USDT 永续公共 REST 响应 → 统一模型（纯函数，无状态；不发请求、不读环境）。
// Gate.io 的字段混用类型：价格是字符串、张数常是数字、时间是「秒」；解析不了的回落到协议允许的缺省，不猜精度。
import { asDecimal, makeProblem, normalizeDecimal } from '@gitrader/protocol'
import { mulDec } from '@gitrader/protocol/decimal'
import type {
  Book, BookLevel, Candle, CandleInterval, Decimal, Instrument, InstrumentPriceRule, InstrumentSizeRule, InstrumentStatus,
  MarketContext, Ms, Problem, ProblemName,
} from '@gitrader/protocol'

export const VENUE = 'gateio'
/** Gate.io 公共 REST 缺省基址；可注入（测试与镜像用）。 */
export const DEFAULT_BASE_URL = 'https://api.gateio.ws'
/** USDT 永续的全部端点都挂在这个前缀下。 */
export const API_PREFIX = '/api/v4/futures/usdt'
/** 永续资金费通常每 8 小时结算；合约给了 funding_interval 时按合约算。 */
export const FUNDING_INTERVAL_MS: Ms = 28_800_000
/** /candlesticks 单次最多返回 2000 根（合约 history.pageLimit 同值）。 */
export const MAX_CANDLES = 2000
/** 区间翻页时认定「这一页已经到底」的页大小：不足 2000 根即视为最后一页。 */
export const CANDLE_PAGE = 2000
/** 区间翻页硬上限：200 页，防上游异常时死循环。 */
export const MAX_PAGES = 200
export const DEFAULT_CANDLE_COUNT = 300
/** 公共端点按 IP 计次：200 次 / 10 秒（model = count，不是 weight）。 */
export const IP_RATE_LIMIT = 200
export const IP_RATE_WINDOW_MS: Ms = 10_000
/** /order_book 的 limit 上限是 100。 */
export const MAX_BOOK_DEPTH = 100

/** 协议区间 → 毫秒（翻页游标按它推进）。 */
export const INTERVAL_MS: Record<CandleInterval, number> = {
  '1m': 60_000, '3m': 180_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000,
  '1h': 3_600_000, '2h': 7_200_000, '4h': 14_400_000, '8h': 28_800_000, '12h': 43_200_000,
  '1d': 86_400_000, '3d': 259_200_000, '1w': 604_800_000, '1M': 2_592_000_000,
}

/**
 * 协议区间 → Gate.io interval 拼写。Gate.io 只给 1m / 5m / 15m / 30m / 1h / 4h / 8h / 1d / 7d，
 * 其余协议区间（3m / 2h / 12h / 3d / 1M）**不在表内**，调用即 INVALID_PARAMS（不发请求）。
 * 注意 `1w → 7d`：Gate.io 的周线拼写是 7d。
 */
export const VENUE_INTERVALS: Partial<Record<CandleInterval, string>> = {
  '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1h', '4h': '4h', '8h': '8h', '1d': '1d', '1w': '7d',
}

export const instrumentIdOf = (symbol: string): string => `${VENUE}:${symbol}`

/** `gateio:BTC_USDT` → 场所原生 `BTC_USDT`；不是本场所的 id 就拒绝，避免把别的场所符号发到 Gate.io。 */
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

/** 协议周期 → Gate.io interval；不在映射表里的周期直接 INVALID_PARAMS（不发请求）。 */
export function venueIntervalOf(interval: CandleInterval): string {
  const mapped = VENUE_INTERVALS[interval]
  if (!mapped) throw problemError('INVALID_PARAMS', `unsupported candle interval: ${String(interval)}`)
  return mapped
}

// ---- 原始形状 ---------------------------------------------------------------

/** 合约条目（截取本连接器用到的字段；Gate.io 返回的其它字段一律忽略）。 */
export interface RawContract {
  name?: string
  in_delisting?: boolean
  order_price_round?: string
  order_size_min?: number | string
  quanto_multiplier?: string | number
  funding_rate?: string | number
  funding_interval?: number | string
  funding_next_apply?: number | string
  mark_price?: string
  leverage_max?: string | number
  status?: string
  type?: string
}

/** ticker 条目：只有 `contract` 与价格，没有时间戳字段。 */
export interface RawTicker {
  contract?: string
  last?: string
  mark_price?: string
  funding_rate?: string
  highest_bid?: string
  lowest_ask?: string
  total_size?: string | number
  quanto_multiplier?: string
}

/** /order_book：`{ current, update, asks: [{p, s}], bids: [{p, s}] }`，`s` 是张数。 */
export interface RawBook { current?: number | string; update?: number | string; asks?: unknown[]; bids?: unknown[] }

/** /candlesticks：`{ t(秒), v(张), c, h, l, o, sum }`。 */
export interface RawCandle { t?: number | string; o?: string; h?: string; l?: string; c?: string; v?: number | string }

/** 非 2xx 的错误体：`{ label, message? }`（如 `{"label":"CONTRACT_NOT_FOUND"}`）。 */
export interface GateErrorBody { label?: string; message?: string }

export const num = (v: unknown): number => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN
  if (typeof v !== 'string') return NaN
  const s = v.trim()
  // 空串表示「没有值」；Number('') 会得到 0，这里必须当缺失
  if (s === '') return NaN
  const n = Number(s)
  return Number.isFinite(n) ? n : NaN
}

/** 宽松十进制文本 → 规范形；非法 / 非正数返回 undefined（tick、min 为 0 时上游等于没给）。 */
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

/** 张数 × quanto_multiplier 的浮点尾差（52915.700000000004）压到 12 位有效数字。 */
export const roundSize = (x: number): number => (Number.isFinite(x) ? Number(x.toPrecision(12)) : x)

/**
 * 张数 × quanto_multiplier → 币数：K 线 `v`、盘口 `size`、持仓量共用这一个换算入口。
 * 面值未知（合约缓存未加载）或非正时按 1 处理，即原样保留张数。
 */
export function toBaseSize(contracts: number, contractSize: Decimal | number | undefined): number {
  const multiplier = num(contractSize)
  return roundSize(contracts * (Number.isFinite(multiplier) && multiplier > 0 ? multiplier : 1))
}

/** 合约清单的 funding_next_apply（秒 → 毫秒）；缺失 / 非正返回 undefined。 */
export function fundingNextApplyMs(c: RawContract): Ms | undefined {
  const seconds = num(c.funding_next_apply)
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : undefined
}

/** `BTC_USDT` → base / quote（Gate.io 原生符号用下划线，大小写原样保留）。 */
function splitSymbol(symbol: string): { base: string; quote: string } {
  const i = symbol.indexOf('_')
  if (i <= 0) return { base: symbol, quote: 'USDT' }
  return { base: symbol.slice(0, i), quote: symbol.slice(i + 1) }
}

/** Gate.io 合约 status：trading / delisted / delisting；缺失按可交易处理（in_delisting 已单独过滤）。 */
function statusOf(status: string | undefined): InstrumentStatus {
  switch (status) {
    case 'trading': return 'trading'
    case 'delisted': return 'delisted'
    case 'delisting': return 'halted'
    case undefined: return 'trading'
    default: return 'halted'
  }
}

// ---- /contracts → Instrument -------------------------------------------------

/**
 * 合约条目 → Instrument。`in_delisting === true` 的条目**整体丢弃**（工单口径：只取 in_delisting === false）。
 * 数量单位一律是币：quanto_multiplier 是每张对应的标的数量，一张即一个步长，所以
 * size.step = quanto_multiplier、size.min = order_size_min（张）× quanto_multiplier（为 0 / 缺失回落一张），
 * venueSizeUnit 固定 'base'；contractSize 保留 quanto_multiplier 只供展示。
 */
export function parseInstrument(c: RawContract, now: Ms): Instrument | undefined {
  const symbol = typeof c.name === 'string' && c.name !== '' ? c.name : undefined
  if (!symbol) return undefined
  if (c.in_delisting === true) return undefined

  const { base, quote } = splitSymbol(symbol)
  const tick = positiveDecimal(c.order_price_round)
  const price: InstrumentPriceRule = tick ? { tick, maxDecimals: decimalsOf(tick) } : { sigFigs: 5, maxDecimals: 8 }

  const contractSize = positiveDecimal(c.quanto_multiplier) ?? asDecimal('1')
  // 数量步长 / 最小数量都从「张」折成币：一张 = 一个 quanto_multiplier
  const step = contractSize
  const minContracts = positiveDecimal(c.order_size_min)
  const size: InstrumentSizeRule = {
    step, decimals: decimalsOf(step), min: minContracts === undefined ? step : mulDec(minContracts, contractSize),
  }
  const fundingSeconds = num(c.funding_interval)

  const instrument: Instrument = {
    instrumentId: instrumentIdOf(symbol),
    venue: VENUE,
    symbol,
    displaySymbol: `${base}-PERP`,
    kind: 'perp',
    base,
    quote,
    settle: quote,
    // /futures/usdt 是 USDT 本位；type 为 inverse 的条目才按反向合约标记
    settlement: c.type === 'inverse' ? 'inverse' : 'linear',
    contractSize,
    venueSizeUnit: 'base',
    assetClass: 'crypto',
    marketGroup: null,
    status: statusOf(c.status),
    price,
    size,
    // 只读数据连接器：不下单，所以标的层面也不声明任何可下单类型
    orderTypes: [],
    tif: [],
    triggerPriceTypes: [],
    fundingIntervalMs: fundingSeconds > 0 ? Math.round(fundingSeconds * 1000) : FUNDING_INTERVAL_MS,
    sessions: { tz: 'UTC', windows: [{ days: [0, 1, 2, 3, 4, 5, 6], from: '00:00', to: '23:59', quality: 'regular' }] },
    updatedAt: now,
  }
  const leverage = num(c.leverage_max)
  if (leverage > 0) instrument.maxLeverage = leverage
  return instrument
}

/** /contracts 数组 → 标的（已剔除 in_delisting），按原生符号排序。 */
export function parseInstruments(raw: unknown, now: Ms): Instrument[] {
  if (!Array.isArray(raw)) return []
  const out: Instrument[] = []
  for (const row of raw) {
    if (!row || typeof row !== 'object') continue
    const instrument = parseInstrument(row as RawContract, now)
    if (instrument) out.push(instrument)
  }
  return out.sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0))
}

// ---- 行情 -------------------------------------------------------------------

/**
 * K 线行 → Candle。Gate.io 的 `t` 是**秒**（这里 ×1000 统一成开盘毫秒），
 * `o/h/l/c` 是字符串，`v` 是**张数**，按 quanto_multiplier 折成币数（面值未知时按 1 处理）。
 * 上游正常是升序；升降序与去重仍由调用方兜底。
 */
export function parseCandles(raw: unknown, contractSize?: Decimal | number): Candle[] {
  if (!Array.isArray(raw)) return []
  const out: Candle[] = []
  for (const row of raw) {
    if (!row || typeof row !== 'object') continue
    const r = row as RawCandle
    const seconds = num(r.t)
    const o = num(r.o)
    const h = num(r.h)
    const l = num(r.l)
    const c = num(r.c)
    const v = num(r.v)
    if (![seconds, o, h, l, c, v].every((x) => Number.isFinite(x))) continue
    if (!(seconds > 0)) continue
    out.push({ t: Math.round(seconds * 1000), o, h, l, c, v: toBaseSize(v, contractSize) })
  }
  return out
}

/**
 * ticker → { ts, bid, ask, last? }。Gate.io 的 /tickers 没有时间戳字段，所以 ts 用注入的时钟。
 * 买卖价缺失或非正（新标的、流动性空档）视为没有报价。
 */
export function parseTicker(
  raw: RawTicker | null | undefined,
  now: Ms,
): { ts: Ms; bid: number; ask: number; last?: number } | undefined {
  if (!raw) return undefined
  const bid = num(raw.highest_bid)
  const ask = num(raw.lowest_ask)
  if (!(bid > 0) || !(ask > 0)) return undefined
  const last = num(raw.last)
  const out: { ts: Ms; bid: number; ask: number; last?: number } = { ts: now, bid, ask }
  if (last > 0) out.last = last
  return out
}

/**
 * /order_book → Book。`s` 是**张数**，按合约的 quanto_multiplier 折成币数（contractSize 由调用方从合约缓存取，
 * 未知时传 undefined 即原样保留张数）。bids 降序、asks 升序，按 depth 截断；ts 取上游 `current`（秒，浮点）×1000。
 */
export function parseBook(
  raw: RawBook | null | undefined,
  instrumentId: string,
  depth: number,
  contractSize: Decimal | number | undefined,
  now: Ms,
): Book {
  const levels = (rows: unknown): BookLevel[] => {
    if (!Array.isArray(rows)) return []
    const out: BookLevel[] = []
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue
      const level = row as { p?: unknown; s?: unknown }
      const price = num(level.p)
      const contracts = num(level.s)
      if (!(price > 0) || !(contracts > 0)) continue
      const size = toBaseSize(contracts, contractSize)
      if (!(size > 0)) continue
      out.push({ price, size })
    }
    return out
  }
  const bids = levels(raw?.bids).sort((a, b) => b.price - a.price).slice(0, depth)
  const asks = levels(raw?.asks).sort((a, b) => a.price - b.price).slice(0, depth)
  const seconds = num(raw?.current)
  const ts = Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : now
  return { instrumentId, ts, bids, asks }
}

/**
 * 协议 MarketContext 没有「下次资金时间」字段：Gate.io 的 funding_next_apply 以扩展字段
 * `nextFundingTime` 一并返回（毫秒），不改变协议的其余字段语义。
 */
export interface GateioMarketContext extends MarketContext { nextFundingTime?: Ms }

/**
 * ticker → MarketContext：mark_price、funding_rate、total_size（张）→ openInterest（币数）。
 * fundingIntervalMs 由调用方给（合约缓存里的 funding_interval，秒 → 毫秒；缺失回落 8 h），
 * nextFundingTime 取合约缓存的 funding_next_apply（秒 → 毫秒）。
 */
export function parseContext(
  raw: RawTicker | null | undefined,
  opts: { instrumentId: string; fundingIntervalMs: Ms; contractSize: Decimal | number | undefined; nextFundingTime?: Ms },
  now: Ms,
): GateioMarketContext {
  const markPrice = num(raw?.mark_price)
  const fundingRate = num(raw?.funding_rate)
  const totalSize = num(raw?.total_size)
  const context: GateioMarketContext = {
    instrumentId: opts.instrumentId,
    ts: now,
    markPrice: Number.isFinite(markPrice) ? markPrice : 0,
    fundingIntervalMs: opts.fundingIntervalMs,
  }
  if (Number.isFinite(fundingRate)) context.fundingRate = fundingRate
  if (Number.isFinite(totalSize) && totalSize > 0) context.openInterest = toBaseSize(totalSize, opts.contractSize)
  if (opts.nextFundingTime !== undefined && Number.isFinite(opts.nextFundingTime) && opts.nextFundingTime > 0) {
    context.nextFundingTime = opts.nextFundingTime
  }
  return context
}

// ---- 请求权重（Gate.io 公共端点按「次」计，不是权重） -------------------------

export const INSTRUMENTS_WEIGHT = 1
export const TICKER_WEIGHT = 1
export const BOOK_WEIGHT = 1
export const CANDLES_WEIGHT = 1

/** /order_book 的 limit 向上取整并钳到 1..100。 */
export function depthLimitOf(depth: number | undefined): number {
  const want = Number.isFinite(depth) && (depth as number) > 0 ? Math.ceil(depth as number) : 20
  return Math.max(1, Math.min(MAX_BOOK_DEPTH, want))
}
