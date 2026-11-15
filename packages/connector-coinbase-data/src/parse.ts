// SPDX-License-Identifier: CPAL-1.0
// Coinbase Advanced Trade 公共市场响应 → 统一模型（纯函数，无状态；不发请求、不读环境）。
// 现货：没有标记价 / 资金费；数值一律是字符串，K 线 `start` 是秒且整体倒序，解析后统一成「开盘毫秒 + 升序」。
import { asDecimal, makeProblem, normalizeDecimal } from '@gitrader/protocol'
import type {
  Book, BookLevel, Candle, CandleInterval, Decimal, Instrument, InstrumentPriceRule, InstrumentSizeRule, InstrumentStatus,
  MarketContext, Ms, Problem, ProblemName,
} from '@gitrader/protocol'

export const VENUE = 'coinbase'
/** Coinbase Advanced Trade 公共 REST 缺省基址；可注入（测试与镜像用）。 */
export const DEFAULT_BASE_URL = 'https://api.coinbase.com'
/** /market/products/{id}/candles 单次最多 350 根。 */
export const MAX_CANDLES = 350
/** 翻页窗口大小（按该所单次上限取 350 根）。 */
export const CANDLE_PAGE = 350
/** 区间翻页硬上限：200 × 350 根，防上游异常时死循环。 */
export const MAX_PAGES = 200
/** 无 from 时的缺省根数。 */
export const DEFAULT_CANDLE_COUNT = 300
/** 公共端点按 IP 计次：10 次 / 秒（model = count，不是 weight）。 */
export const IP_RATE_LIMIT = 10
export const IP_RATE_WINDOW_MS: Ms = 1000
/** 公共端点的每次请求权重（按次数计）。 */
export const REQUEST_WEIGHT = 1
/** product_book 的深度钳位上限（文档缺省 50；这里只防误用，不代表上游硬上限）。 */
export const MAX_BOOK_DEPTH = 250

/** 协议区间 → 毫秒（翻页游标按它推进）。 */
export const INTERVAL_MS: Record<CandleInterval, number> = {
  '1m': 60_000, '3m': 180_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000,
  '1h': 3_600_000, '2h': 7_200_000, '4h': 14_400_000, '8h': 28_800_000, '12h': 43_200_000,
  '1d': 86_400_000, '3d': 259_200_000, '1w': 604_800_000, '1M': 2_592_000_000,
}

/** 协议区间 → Coinbase granularity。工单点名的 7 档；其余（4h / 8h / 12h / 3d / 1w / 1M …）上游没有，直接拒绝。 */
export const GRANULARITY_OF: Partial<Record<CandleInterval, string>> = {
  '1m': 'ONE_MINUTE',
  '5m': 'FIVE_MINUTE',
  '15m': 'FIFTEEN_MINUTE',
  '30m': 'THIRTY_MINUTE',
  '1h': 'ONE_HOUR',
  '2h': 'TWO_HOUR',
  '1d': 'ONE_DAY',
}

export const instrumentIdOf = (symbol: string): string => `${VENUE}:${symbol}`

/** `coinbase:BTC-USD` → 场所原生 product_id；不是本场所的 id 就拒绝，避免把别的场所符号发到 Coinbase。 */
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

/** 协议周期 → Coinbase granularity；不在映射表里的周期直接 INVALID_PARAMS（不发请求）。 */
export function granularityOf(interval: CandleInterval): string {
  const granularity = GRANULARITY_OF[interval]
  if (!granularity) throw problemError('INVALID_PARAMS', `unsupported candle interval: ${String(interval)}`)
  return granularity
}

// ---- 原始形状 ---------------------------------------------------------------

export interface RawProduct {
  product_id?: string
  status?: string
  product_type?: string
  base_currency_id?: string
  quote_currency_id?: string
  base_increment?: string
  quote_increment?: string
  base_min_size?: string
  quote_min_size?: string
  price?: string
}

export interface RawProducts { products?: unknown }

export interface RawCandle { start?: string; low?: string; high?: string; open?: string; close?: string; volume?: string }
export interface RawCandles { candles?: unknown }

/** ticker 没有顶层时间戳：时间取最近一笔成交的 `trades[0].time`（ISO-8601）。 */
export interface RawTicker {
  best_bid?: string
  best_ask?: string
  trades?: Array<{ price?: string; size?: string; time?: string }>
}

export interface RawPricebook {
  pricebook?: { product_id?: string; bids?: unknown; asks?: unknown; time?: string }
}

export const num = (v: unknown): number => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN
  if (typeof v !== 'string') return NaN
  const s = v.trim()
  // Coinbase 用空串表示「没有值」；Number('') 会得到 0，这里必须当缺失
  if (s === '') return NaN
  const n = Number(s)
  return Number.isFinite(n) ? n : NaN
}

/** ISO-8601 → 毫秒；小数秒超过 3 位时截断（`Date.parse` 只保证 3 位）。非法返回 NaN。 */
export function isoMs(v: unknown): number {
  if (typeof v !== 'string' || v.trim() === '') return NaN
  const s = v.trim().replace(/(\.\d{3})\d+/, '$1')
  const t = Date.parse(s)
  return Number.isFinite(t) ? t : NaN
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

/** `BTC-USD` → base / quote；优先用 base_currency_id / quote_currency_id，缺失再按 product_id 切。 */
function splitProductId(productId: string): { base: string; quote: string } {
  const i = productId.indexOf('-')
  if (i <= 0 || i === productId.length - 1) return { base: productId, quote: '' }
  return { base: productId.slice(0, i), quote: productId.slice(i + 1) }
}

/** Coinbase status：online / offline / delisted / post_only / limit_only / cancel_only / auction_mode。 */
function statusOf(status: string | undefined): InstrumentStatus {
  switch (status) {
    case 'online': return 'trading'
    case 'delisted': return 'delisted'
    default: return 'halted'
  }
}

// ---- /market/products → Instrument ------------------------------------------

/**
 * 单个产品 → Instrument。工单只收 `status === 'online'` 的现货条目：
 * 停牌 / 下线 / 交割类条目一律跳过（不进目录，也就不会出现在 getInstrument 里）。
 */
export function parseInstrument(p: RawProduct, now: Ms): Instrument | undefined {
  const productId = typeof p.product_id === 'string' && p.product_id !== '' ? p.product_id : undefined
  if (!productId) return undefined
  if (p.status !== 'online') return undefined
  if (typeof p.product_type === 'string' && p.product_type !== 'SPOT') return undefined

  const fallback = splitProductId(productId)
  const base = typeof p.base_currency_id === 'string' && p.base_currency_id !== '' ? p.base_currency_id : fallback.base
  const quote = typeof p.quote_currency_id === 'string' && p.quote_currency_id !== '' ? p.quote_currency_id : fallback.quote

  const tick = positiveDecimal(p.quote_increment)
  const price: InstrumentPriceRule = tick ? { tick, maxDecimals: decimalsOf(tick) } : { sigFigs: 5, maxDecimals: 8 }

  // 现货的数量步长就是 base 的最小增量；min 优先取 base_min_size，缺失回落到 step。
  const step = positiveDecimal(p.base_increment) ?? asDecimal('1')
  const minQty = positiveDecimal(p.base_min_size) ?? step
  const size: InstrumentSizeRule = { step, decimals: decimalsOf(step), min: minQty }

  const minNotional = positiveDecimal(p.quote_min_size)

  return {
    instrumentId: instrumentIdOf(productId),
    venue: VENUE,
    symbol: productId,
    displaySymbol: productId,
    kind: 'spot',
    base,
    quote,
    settle: quote,
    settlement: 'linear',
    contractSize: asDecimal('1'),
    venueSizeUnit: 'base',
    assetClass: 'crypto',
    marketGroup: null,
    status: statusOf(p.status),
    price,
    size,
    ...(minNotional ? { minNotional } : {}),
    // 现货没有资金费：fundingIntervalMs 留协议缺省（不写这个键）
    orderTypes: [],
    tif: [],
    triggerPriceTypes: [],
    sessions: { tz: 'UTC', windows: [{ days: [0, 1, 2, 3, 4, 5, 6], from: '00:00', to: '23:59', quality: 'regular' }] },
    updatedAt: now,
  }
}

/** /market/products 的 products 数组（或直接数组）→ 标的，按 symbol 升序。 */
export function parseProducts(raw: unknown, now: Ms): Instrument[] {
  const rows = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as RawProducts).products)
      ? (raw as RawProducts).products
      : []
  const out: Instrument[] = []
  for (const row of rows as unknown[]) {
    if (!row || typeof row !== 'object') continue
    const instrument = parseInstrument(row as RawProduct, now)
    if (instrument) out.push(instrument)
  }
  return out.sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0))
}

// ---- 行情 -------------------------------------------------------------------

/**
 * K 线行 → Candle：`start` 是**秒字符串**，这里 ×1000 统一成开盘毫秒；
 * 上游整体倒序返回，排序与去重交给调用方。字段名是 open/close/high/low/volume（不是 o/h/l/c/v）。
 */
export function parseCandles(raw: unknown): Candle[] {
  const rows = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as RawCandles).candles)
      ? (raw as RawCandles).candles
      : []
  const out: Candle[] = []
  for (const row of rows as unknown[]) {
    if (!row || typeof row !== 'object') continue
    const r = row as RawCandle
    const sec = num(r.start)
    const o = num(r.open)
    const h = num(r.high)
    const l = num(r.low)
    const c = num(r.close)
    const v = num(r.volume)
    if (![sec, o, h, l, c, v].every((x) => Number.isFinite(x))) continue
    if (sec <= 0) continue
    out.push({ t: Math.round(sec * 1000), o, h, l, c, v })
  }
  return out
}

/** ticker → { ts, bid, ask, last? }；买卖价缺失或非正（上游空串、冷门标的）视为没有报价。 */
export function parseTicker(
  raw: RawTicker | null | undefined,
  now: Ms,
): { ts: Ms; bid: number; ask: number; last?: number } | undefined {
  if (!raw) return undefined
  const bid = num(raw.best_bid)
  const ask = num(raw.best_ask)
  if (!(bid > 0) || !(ask > 0)) return undefined
  const trade = Array.isArray(raw.trades) ? raw.trades[0] : undefined
  const ts = isoMs(trade?.time)
  const last = num(trade?.price)
  const out: { ts: Ms; bid: number; ask: number; last?: number } = { ts: Number.isFinite(ts) && ts > 0 ? ts : now, bid, ask }
  if (last > 0) out.last = last
  return out
}

/** /market/product_book → Book（`pricebook.bids` / `.asks` 是 `{ price, size }` 字符串对象数组）。 */
export function parseBook(raw: RawPricebook | null | undefined, instrumentId: string, depth: number, now: Ms): Book {
  const book = raw?.pricebook
  const levels = (rows: unknown): BookLevel[] => {
    if (!Array.isArray(rows)) return []
    const out: BookLevel[] = []
    for (const row of rows as unknown[]) {
      if (!row || typeof row !== 'object') continue
      const r = row as { price?: unknown; size?: unknown }
      const price = num(r.price)
      const size = num(r.size)
      if (!(price > 0) || !(size > 0)) continue
      out.push({ price, size })
    }
    return out
  }
  const bids = levels(book?.bids).sort((a, b) => b.price - a.price).slice(0, depth)
  const asks = levels(book?.asks).sort((a, b) => a.price - b.price).slice(0, depth)
  const ts = isoMs(book?.time)
  return { instrumentId, ts: Number.isFinite(ts) && ts > 0 ? ts : now, bids, asks }
}

/**
 * 现货上下文：Coinbase 公共现货没有标记价 / 资金费 / 下次资金时间。
 * 现货无标记价，以最新成交价代：markPrice 取报价的 last，没有 last 时用 bid/ask 中价；
 * 资金费相关键一律不写（协议缺省 = 没有），并补一个 midPrice（纯本地，不联网）。
 */
export function parseContext(
  quote: { bid: number; ask: number; last?: number },
  instrumentId: string,
  now: Ms,
): MarketContext {
  const midPrice = (quote.bid + quote.ask) / 2
  const last = quote.last
  return {
    instrumentId, ts: now,
    markPrice: last !== undefined && last > 0 ? last : midPrice,
    midPrice,
  }
}

/** 请求深度向上取整并钳到 1..250。 */
export function depthLimitOf(depth: number | undefined): number {
  const want = Number.isFinite(depth) && (depth as number) > 0 ? Math.ceil(depth as number) : 20
  return Math.max(1, Math.min(MAX_BOOK_DEPTH, want))
}

/** 无 from 时的根数：1..350，缺省 300。 */
export function clampCount(n: number | undefined): number {
  const raw = typeof n === 'number' && Number.isFinite(n) ? Math.floor(n) : DEFAULT_CANDLE_COUNT
  return Math.max(1, Math.min(MAX_CANDLES, raw))
}
