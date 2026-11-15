// SPDX-License-Identifier: CPAL-1.0
// Kraken Futures 公共 REST 响应 → 统一模型（纯函数，无状态；不发请求、不读环境）。
// 合约清单与 ticker 包在 { result, ... } 信封里，K 线端点只回 { candles, more_candles }；
// 数值混用 number 与字符串，解析不了的一律回落到协议允许的缺省，不猜精度。
import { asDecimal, makeProblem, normalizeDecimal } from '@gitrader/protocol'
import { mulDec } from '@gitrader/protocol/decimal'
import type {
  Book, BookLevel, Candle, CandleInterval, Decimal, Instrument, InstrumentPriceRule, InstrumentSizeRule, InstrumentStatus,
  MarketContext, Ms, Problem, ProblemName,
} from '@gitrader/protocol'

export const VENUE = 'kraken'
/** Kraken Futures 公共 REST 缺省基址；可注入（测试与镜像用）。 */
export const DEFAULT_BASE_URL = 'https://futures.kraken.com'
/** Kraken 永续的资金费按小时连续计提；ticker 的 fundingRate 是绝对额（quote / 张），相对费率见 parseContext。 */
export const FUNDING_INTERVAL_MS: Ms = 3_600_000
/** /api/charts/v1/trade 单次最多 5000 根。 */
export const MAX_CANDLES = 5000
/** 每页最多 5000 根。 */
export const CANDLE_PAGE = 5000
/** 区间翻页硬上限：200 × 5000 根，防上游异常时死循环。 */
export const MAX_PAGES = 200
export const DEFAULT_CANDLE_COUNT = 300
/** 公共端点约每 10 秒 500 次，按次计（model = count，不是 weight）。 */
export const IP_RATE_LIMIT = 500
export const IP_RATE_WINDOW_MS: Ms = 10_000
/** orderbook 端点不带 depth 参数、全量返回；本地截断的上限。 */
export const MAX_BOOK_DEPTH = 500

/** 协议区间 → 毫秒（翻页游标按它推进）。 */
export const INTERVAL_MS: Record<CandleInterval, number> = {
  '1m': 60_000, '3m': 180_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000,
  '1h': 3_600_000, '2h': 7_200_000, '4h': 14_400_000, '8h': 28_800_000, '12h': 43_200_000,
  '1d': 86_400_000, '3d': 259_200_000, '1w': 604_800_000, '1M': 2_592_000_000,
}

/**
 * 协议区间 → Kraken resolution。Kraken 只有这 9 档，其余协议周期（3m / 2h / 8h / 3d / 1M）没有对应值，
 * 调用时直接 INVALID_PARAMS，不发请求。
 */
export const RESOLUTION_OF: Partial<Record<CandleInterval, string>> = {
  '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m',
  '1h': '1h', '4h': '4h', '12h': '12h', '1d': '1d', '1w': '1w',
}

export const instrumentIdOf = (symbol: string): string => `${VENUE}:${symbol}`

/** `kraken:<symbol>` → 场所原生 symbol（大写原样保留）；不是本场所的 id 就拒绝。 */
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

/** 协议周期 → Kraken resolution；没有对应档位的周期直接 INVALID_PARAMS（不发请求）。 */
export function resolutionOf(interval: CandleInterval): string {
  const resolution = RESOLUTION_OF[interval]
  if (!resolution) throw problemError('INVALID_PARAMS', `unsupported candle interval: ${String(interval)}`)
  return resolution
}

// ---- 原始形状 ---------------------------------------------------------------

/** Kraken Futures 信封：`result` 为 'success' 或 'error'。 */
export interface KrakenEnvelope<T = unknown> {
  result?: string
  error?: string
  serverTime?: string
  instruments?: T[]
  tickers?: T[]
}

/** 只有本连接器用得到的字段（真实响应还有 marginLevels / isin / platformsPermitted 等，不读）。 */
export interface RawInstrument {
  symbol?: string
  type?: string
  tickSize?: number | string
  contractSize?: number | string
  tradeable?: boolean
  suspended?: boolean
  isExpired?: boolean
  contractValueTradePrecision?: number
  fundingRateCoefficient?: number
  base?: string
  quote?: string
  pair?: string
}

export interface RawTicker {
  symbol?: string
  last?: number | string
  lastTime?: string
  markPrice?: number | string
  bid?: number | string
  ask?: number | string
  indexPrice?: number | string
  openInterest?: number | string
  fundingRate?: number | string
  relativeFundingRate?: number | string
  fundingRatePrediction?: number | string
  suspended?: boolean
}

export interface RawOrderBook { bids?: unknown[]; asks?: unknown[] }

/** K 线行：`time` 是毫秒（上游如此），OHLCV 是字符串。 */
export interface RawCandle { time?: number | string; open?: unknown; high?: unknown; low?: unknown; close?: unknown; volume?: unknown }

export interface ChartsBody { candles?: RawCandle[]; more_candles?: boolean }

export const num = (v: unknown): number => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN
  if (typeof v !== 'string') return NaN
  const s = v.trim()
  if (s === '') return NaN
  const n = Number(s)
  return Number.isFinite(n) ? n : NaN
}

/**
 * 时间戳归一成毫秒：数字 < 1e12 视为秒（×1000），ISO 字符串交给 Date.parse。
 * Kraken 的 K 线给毫秒、charts 的 from / to 要秒，凡入口都走这一处，避免单位混用。
 */
export function parseTs(v: unknown): Ms | undefined {
  if (typeof v === 'number' || (typeof v === 'string' && /^\d+$/.test(v.trim()))) {
    const n = num(v)
    if (!Number.isFinite(n) || n <= 0) return undefined
    return n < 1e12 ? Math.round(n * 1000) : n
  }
  if (typeof v !== 'string' || v.trim() === '') return undefined
  const parsed = Date.parse(v)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
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
 * 张数精度 → 最小步长。正值是小数位（4 → '0.0001'）；0 → '1'；
 * 负值是 10 的正幂（真网有 -1 / -2 / -3 的标的，表示步长 10 / 100 / 1000 张）。
 */
export function stepOfDecimals(decimals: number): Decimal {
  if (!Number.isFinite(decimals)) return asDecimal('1')
  const p = Math.trunc(decimals)
  if (p > 0) return asDecimal(`0.${'0'.repeat(p - 1)}1`)
  if (p < 0) return asDecimal(`1${'0'.repeat(-p)}`)
  return asDecimal('1')
}

/** symbol 里的标的 / 计价币：优先上游 base / quote，缺失时按 `XBT:USD` 拆。 */
function pairOf(s: RawInstrument, symbol: string): { base: string; quote: string } {
  const fromPair = typeof s.pair === 'string' && s.pair.includes(':') ? s.pair.split(':') : []
  const base = typeof s.base === 'string' && s.base !== '' ? s.base : (fromPair[0] ?? '')
  const quote = typeof s.quote === 'string' && s.quote !== '' ? s.quote : (fromPair[1] ?? '')
  if (base !== '' && quote !== '') return { base, quote }
  // 最后一招：PF_<BASE><QUOTE> 里剥掉已知的计价币后缀
  const bare = symbol.replace(/^PF_/, '')
  for (const suffix of ['USDT', 'USDC', 'USD', 'EUR']) {
    if (bare.endsWith(suffix) && bare.length > suffix.length) return { base: bare.slice(0, -suffix.length), quote: suffix }
  }
  return { base: bare, quote: '' }
}

/** tradeable=false / isExpired → 不收录（返回 undefined）；suspended → halted。 */
function statusOf(s: RawInstrument): InstrumentStatus {
  if (s.isExpired === true) return 'delisted'
  if (s.suspended === true) return 'halted'
  return 'trading'
}

// ---- /derivatives/api/v3/instruments → Instrument ---------------------------

export function parseInstrument(s: RawInstrument, now: Ms): Instrument | undefined {
  const symbol = typeof s.symbol === 'string' ? s.symbol : ''
  if (symbol === '') return undefined
  // 只要永续：PF_ 前缀 + tradeable === true（交割 / 反向季度合约是 FF_ / FI_ 等，一律跳过）
  if (!symbol.startsWith('PF_')) return undefined
  if (s.tradeable !== true) return undefined

  const { base, quote } = pairOf(s, symbol)

  const tick = positiveDecimal(s.tickSize)
  const price: InstrumentPriceRule = tick ? { tick, maxDecimals: decimalsOf(tick) } : { sigFigs: 5, maxDecimals: 8 }

  // Kraken 的 PF_ 以标的币计价：1 张 = 1 个基础币单位。清单给了 contractSize（每张对应的标的币数）就乘上去，
  // 数量步长 / 最小数量都折成币数量；contractSize 本身保留面值，venueSizeUnit 声明为 'base'。
  const precision = typeof s.contractValueTradePrecision === 'number' ? s.contractValueTradePrecision : 0
  const contractSize = positiveDecimal(s.contractSize) ?? asDecimal('1')
  const step = mulDec(stepOfDecimals(precision), contractSize)
  const size: InstrumentSizeRule = { step, decimals: decimalsOf(step), min: step }

  // Kraken 的 PF_ 以标的币结算（反向）；只有计价币是 USDT / USDC 时才按线性处理
  const linear = /^USD[TC]$/.test(quote)
  const settlement: 'linear' | 'inverse' = linear ? 'linear' : 'inverse'

  return {
    instrumentId: instrumentIdOf(symbol),
    venue: VENUE,
    symbol,
    displaySymbol: quote === '' ? `${base}-PERP` : `${base}-${quote}-PERP`,
    kind: 'perp',
    base,
    quote: quote === '' ? 'USD' : quote,
    settle: linear ? quote : base,
    settlement,
    contractSize,
    venueSizeUnit: 'base',
    assetClass: 'crypto',
    marketGroup: null,
    status: statusOf(s),
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

/** 合约清单数组 → 标的（已按 symbol 升序）。 */
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

/** 数量从「张」折成标的币：contractSize 缺省按 1，保留行情类允许的 number 形态。 */
function sizeInBase(value: number, contractSize?: Decimal): number {
  return contractSize === undefined ? value : Number(mulDec(String(value), contractSize))
}

/**
 * K 线行 → Candle。`time` 归一到毫秒（上游给毫秒；防御性处理秒级），OHLCV 走宽松数字解析。
 * 给了 contractSize 时 volume 与盘口 size 同口径折成标的币数量。
 * 返回**升序、按 t 去重**：charts 端点自身是升序，但倒序 / 重复也不该漏到上层。
 */
export function parseCandles(raw: unknown, contractSize?: Decimal): Candle[] {
  if (!Array.isArray(raw)) return []
  const seen = new Map<Ms, Candle>()
  for (const row of raw) {
    if (!row || typeof row !== 'object') continue
    const r = row as RawCandle
    const t = parseTs(r.time)
    const o = num(r.open)
    const h = num(r.high)
    const l = num(r.low)
    const c = num(r.close)
    const v = sizeInBase(num(r.volume), contractSize)
    if (t === undefined || ![o, h, l, c, v].every((x) => Number.isFinite(x))) continue
    seen.set(t, { t, o, h, l, c, v })
  }
  return [...seen.values()].sort((a, b) => a.t - b.t)
}

/** ticker → { ts, bid, ask, last? }；买卖价缺失或非正（停牌 / 新标的）视为没有报价。 */
export function parseTicker(
  raw: RawTicker | null | undefined,
  fallbackTs: Ms,
): { ts: Ms; bid: number; ask: number; last?: number } | undefined {
  if (!raw) return undefined
  const bid = num(raw.bid)
  const ask = num(raw.ask)
  if (!(bid > 0) || !(ask > 0)) return undefined
  const ts = parseTs(raw.lastTime) ?? fallbackTs
  const last = num(raw.last)
  const out: { ts: Ms; bid: number; ask: number; last?: number } = { ts, bid, ask }
  if (last > 0) out.last = last
  return out
}

/**
 * /derivatives/api/v3/orderbook → Book。上游 bids 是**升序**（最低价在前，含远端薄档），这里翻成降序。
 * size 与合约清单同口径：给了 contractSize 就按 张 × contractSize 折成标的币数量。
 */
export function parseBook(
  raw: RawOrderBook | null | undefined,
  instrumentId: string,
  depth: number,
  now: Ms,
  contractSize?: Decimal,
): Book {
  const levels = (rows: unknown): BookLevel[] => {
    if (!Array.isArray(rows)) return []
    const out: BookLevel[] = []
    for (const row of rows) {
      if (!Array.isArray(row)) continue
      const price = num(row[0])
      const size = num(row[1])
      if (!(price > 0) || !(size > 0)) continue
      out.push({ price, size: sizeInBase(size, contractSize) })
    }
    return out
  }
  const bids = levels(raw?.bids).sort((a, b) => b.price - a.price).slice(0, depth)
  const asks = levels(raw?.asks).sort((a, b) => a.price - b.price).slice(0, depth)
  return { instrumentId, ts: now, bids, asks }
}

/**
 * ticker → MarketContext。Kraken 在一次 tickers 响应里同时给标记价 / 指数价 / 资金费 / 未平仓，
 * 一个请求就够。ticker 的 fundingRate 是绝对额（quote / 张），这里换算成相对费率：
 * fundingRate / markPrice（分数口径，与其他连接器一致）；没有可用标记价时不发该字段。
 * 下次资金时间该所不给，协议里也没有该字段。
 */
export function parseContext(raw: RawTicker | null | undefined, instrumentId: string, fallbackTs: Ms): MarketContext {
  const markPrice = num(raw?.markPrice)
  const ts = parseTs(raw?.lastTime) ?? fallbackTs
  const context: MarketContext = {
    instrumentId,
    ts,
    markPrice: Number.isFinite(markPrice) ? markPrice : 0,
    fundingIntervalMs: FUNDING_INTERVAL_MS,
  }
  const fundingRate = num(raw?.fundingRate)
  if (Number.isFinite(fundingRate) && markPrice > 0) context.fundingRate = fundingRate / markPrice
  const oraclePrice = num(raw?.indexPrice)
  if (oraclePrice > 0) context.oraclePrice = oraclePrice
  const openInterest = num(raw?.openInterest)
  if (Number.isFinite(openInterest)) context.openInterest = openInterest
  const mid = (num(raw?.bid) + num(raw?.ask)) / 2
  if (Number.isFinite(mid) && mid > 0) context.midPrice = mid
  return context
}

// ---- 请求权重（Kraken 公共端点没有权重表，一律按次计 1） ---------------------

export const INSTRUMENTS_WEIGHT = 1
export const TICKERS_WEIGHT = 1
export const ORDERBOOK_WEIGHT = 1
export const CHARTS_WEIGHT = 1

/** 请求的深度向上取整并钳到 1..500（orderbook 全量返回，本地截断）。 */
export function depthLimitOf(depth: number | undefined): number {
  const want = Number.isFinite(depth) && (depth as number) > 0 ? Math.ceil(depth as number) : 20
  return Math.max(1, Math.min(MAX_BOOK_DEPTH, want))
}
