// SPDX-License-Identifier: CPAL-1.0
// OKX 公共 REST 响应 → 统一模型（纯函数，无状态；不发请求、不读环境）。
// 原始响应包在 { code, msg, data } 信封里，数值一律是字符串；解析不了的回落到协议允许的缺省，不猜精度。
import { asDecimal, makeProblem, normalizeDecimal } from '@gitrader/protocol'
import { mulDec } from '@gitrader/protocol/decimal'
import type {
  Book, BookLevel, Candle, CandleInterval, Decimal, Instrument, InstrumentPriceRule, InstrumentSizeRule, InstrumentStatus,
  MarketContext, Ms, Problem, ProblemName,
} from '@gitrader/protocol'

export const VENUE = 'okx'
/** OKX 公共 REST 缺省基址；可注入（测试与镜像用）。 */
export const DEFAULT_BASE_URL = 'https://www.okx.com'
/** SWAP 资金费通常每 8 小时结算；上游给了 fundingTime / nextFundingTime 时按上游算。 */
export const FUNDING_INTERVAL_MS: Ms = 28_800_000
/** /api/v5/market/candles 单次最多 300 根。 */
export const MAX_CANDLES = 300
/** /api/v5/market/history-candles 每页最多 100 根。 */
export const CANDLE_PAGE = 100
/** 区间翻页硬上限：200 × 100 根，防上游异常时死循环。 */
export const MAX_PAGES = 200
export const DEFAULT_CANDLE_COUNT = 300
/** 公共端点按 IP、按端点限频：20 次 / 2 秒（model = count，不是 weight）。 */
export const IP_RATE_LIMIT = 20
export const IP_RATE_WINDOW_MS: Ms = 2000

/** 协议区间 → 毫秒（翻页游标按它推进）。 */
export const INTERVAL_MS: Record<CandleInterval, number> = {
  '1m': 60_000, '3m': 180_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000,
  '1h': 3_600_000, '2h': 7_200_000, '4h': 14_400_000, '8h': 28_800_000, '12h': 43_200_000,
  '1d': 86_400_000, '3d': 259_200_000, '1w': 604_800_000, '1M': 2_592_000_000,
}

/** 协议区间 → OKX bar 拼写（时 / 天 / 周 / 月大写；分钟与月内 M 保持原样）。 */
export const BAR_OF: Record<CandleInterval, string> = {
  '1m': '1m', '3m': '3m', '5m': '5m', '15m': '15m', '30m': '30m',
  '1h': '1H', '2h': '2H', '4h': '4H', '8h': '8H', '12h': '12H',
  '1d': '1D', '3d': '3D', '1w': '1W', '1M': '1M',
}

export const instrumentIdOf = (symbol: string): string => `${VENUE}:${symbol}`

/** `okx:<instId>` → 场所原生 instId；不是本场所的 id 就拒绝，避免把别的场所符号发到 OKX。 */
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

/** 协议周期 → OKX bar；不在协议表里的周期直接 INVALID_PARAMS（不发请求）。 */
export function barOf(interval: CandleInterval): string {
  const bar = BAR_OF[interval]
  if (!bar) throw problemError('INVALID_PARAMS', `unsupported candle interval: ${String(interval)}`)
  return bar
}

// ---- 原始形状 ---------------------------------------------------------------

/** OKX 统一信封：code 为字符串 "0" 表示成功。 */
export interface OkxEnvelope<T> { code?: string; msg?: string; data?: T[] }

export interface RawInstrument {
  instType?: string
  instId?: string
  instFamily?: string
  baseCcy?: string
  quoteCcy?: string
  settleCcy?: string
  ctVal?: string
  ctValCcy?: string
  ctMult?: string
  tickSz?: string
  lotSz?: string
  minSz?: string
  state?: string
  listTime?: string
  expTime?: string
}

export interface RawTicker {
  instId?: string
  last?: string
  lastSz?: string
  askPx?: string
  bidPx?: string
  ts?: string
}

export interface RawBook { asks?: unknown[]; bids?: unknown[]; ts?: string }
export interface RawMarkPrice { instId?: string; markPx?: string; ts?: string }
export interface RawFundingRate {
  instId?: string
  fundingRate?: string
  fundingTime?: string
  nextFundingTime?: string
}

export const num = (v: unknown): number => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN
  if (typeof v !== 'string') return NaN
  const s = v.trim()
  // OKX 用空串表示「没有值」；Number('') 会得到 0，这里必须当缺失
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

/** `BTC-USDT-SWAP` → base / quote；baseCcy / quoteCcy 在 SWAP 上通常为空，只能按 instId 切。 */
function splitInstId(instId: string): { base: string; quote: string } {
  const parts = instId.split('-')
  const base = parts[0] ?? instId
  const quote = parts.length > 1 ? (parts[1] ?? '') : ''
  return { base, quote }
}

/** OKX state：live / suspend / preopen / test / expired。测试网条目也当不可交易。 */
function statusOf(state: string | undefined): InstrumentStatus {
  switch (state) {
    case 'live': return 'trading'
    case 'suspend':
    case 'preopen':
    case 'test': return 'halted'
    case 'expired': return 'delisted'
    default: return 'halted'
  }
}

// ---- /public/instruments → Instrument ---------------------------------------

export function parseInstrument(s: RawInstrument, now: Ms): Instrument | undefined {
  const instId = typeof s.instId === 'string' && s.instId !== '' ? s.instId : undefined
  if (!instId) return undefined
  // 只收永续：交割 / 期权 / 现货条目一律跳过
  if (typeof s.instType === 'string' && s.instType !== 'SWAP') return undefined
  const { base, quote: quoteFromId } = splitInstId(instId)
  const quote = typeof s.quoteCcy === 'string' && s.quoteCcy !== '' ? s.quoteCcy : quoteFromId
  const settle = typeof s.settleCcy === 'string' && s.settleCcy !== '' ? s.settleCcy : quote
  // 只收线性合约：以 USDT / USDC 结算；币本位（settleCcy = 标的币）与其它结算币一律跳过
  if (settle !== 'USDT' && settle !== 'USDC') return undefined

  const tick = positiveDecimal(s.tickSz)
  const price: InstrumentPriceRule = tick ? { tick, maxDecimals: decimalsOf(tick) } : { sigFigs: 5, maxDecimals: 8 }

  // OKX 的数量单位是「张」：lotSz / minSz 都是张数，ctVal 是每张对应的标的数量 → 一律折成币。
  // contractSize 保留 ctVal，只供展示；协议的数量步长 / 最小数量用币数量。
  const contractSize = positiveDecimal(s.ctVal) ?? asDecimal('1')
  const step = mulDec(positiveDecimal(s.lotSz) ?? asDecimal('1'), contractSize)
  const minQty = mulDec(positiveDecimal(s.minSz) ?? positiveDecimal(s.lotSz) ?? asDecimal('1'), contractSize)
  const size: InstrumentSizeRule = { step, decimals: decimalsOf(step), min: minQty }

  return {
    instrumentId: instrumentIdOf(instId),
    venue: VENUE,
    symbol: instId,
    displaySymbol: `${base}-PERP`,
    kind: 'perp',
    base,
    quote: quote === '' ? 'USDT' : quote,
    settle,
    // 币本位已在上面排除，这里只会是线性合约
    settlement: 'linear',
    contractSize,
    venueSizeUnit: 'base',
    assetClass: 'crypto',
    marketGroup: null,
    status: statusOf(s.state),
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

/** /public/instruments 的 data 数组 → 标的（含停牌 / 已下架，由上层决定是否展示）。 */
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
 * K 线行 → Candle。OKX 列顺序：[ts, o, h, l, c, vol, volCcy, volCcyQuote, confirm]，
 * 且整体按时间倒序返回 —— 这里只做逐行解析，升降序与去重交给调用方。
 * vol 是「张」、volCcy 是币数量：协议 Candle.v 一律用币 —— 给了 ctVal（contractSize）就按
 * `vol × ctVal` 折成币（与上游 volCcy 同口径）；拿不到 ctVal 才回落 volCcy，再不行用 vol 原值。
 */
export function parseCandles(raw: unknown, contractSize?: Decimal): Candle[] {
  if (!Array.isArray(raw)) return []
  const ctVal = contractSize === undefined ? NaN : num(contractSize)
  const fold = Number.isFinite(ctVal) && ctVal > 0 ? contractSize : undefined
  const out: Candle[] = []
  for (const row of raw) {
    if (!Array.isArray(row) || row.length < 7) continue
    const t = num(row[0])
    const o = num(row[1])
    const h = num(row[2])
    const l = num(row[3])
    const c = num(row[4])
    const vol = num(row[5])
    const volCcy = num(row[6])
    let v: number
    if (fold !== undefined && Number.isFinite(vol)) v = Number(mulDec(String(vol), fold))
    else if (Number.isFinite(volCcy)) v = volCcy
    else v = vol
    if (![t, o, h, l, c, v].every((x) => Number.isFinite(x))) continue
    out.push({ t, o, h, l, c, v })
  }
  return out
}

/** ticker → { ts, bid, ask, last? }；买卖价缺失或非正（上游偶发空串、新标的）视为没有报价。 */
export function parseTicker(
  raw: RawTicker | null | undefined,
  now: Ms,
): { ts: Ms; bid: number; ask: number; last?: number } | undefined {
  if (!raw) return undefined
  const bid = num(raw.bidPx)
  const ask = num(raw.askPx)
  if (!(bid > 0) || !(ask > 0)) return undefined
  const ts = num(raw.ts)
  const last = num(raw.last)
  const out: { ts: Ms; bid: number; ask: number; last?: number } = { ts: Number.isFinite(ts) && ts > 0 ? ts : now, bid, ask }
  if (last > 0) out.last = last
  return out
}

/**
 * /market/books → Book；bids 降序、asks 升序，按 depth 截断。
 * 上游 size 是张数：给了 contractSize（ctVal）就折成币数量，没给保持原值。
 */
export function parseBooks(
  raw: RawBook | null | undefined,
  instrumentId: string,
  depth: number,
  now: Ms,
  contractSize?: Decimal,
): Book {
  const ctVal = contractSize === undefined ? undefined : num(contractSize)
  const factor = contractSize !== undefined && ctVal !== undefined && ctVal > 0 ? contractSize : undefined
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
  const ts = num(raw?.ts)
  return { instrumentId, ts: Number.isFinite(ts) && ts > 0 ? ts : now, bids, asks }
}

/** /public/mark-price → 标记价与上游时间戳。 */
export function parseMarkPrice(raw: RawMarkPrice | null | undefined, now: Ms): { markPrice: number; ts: Ms } {
  const markPrice = num(raw?.markPx)
  const ts = num(raw?.ts)
  return { markPrice: Number.isFinite(markPrice) ? markPrice : 0, ts: Number.isFinite(ts) && ts > 0 ? ts : now }
}

/** /public/funding-rate → 资金费率；资金间隔优先取 nextFundingTime - fundingTime，缺失回落 8h。 */
export function parseFundingRate(
  raw: RawFundingRate | null | undefined,
  now: Ms,
): { fundingRate?: number; fundingIntervalMs: Ms; ts: Ms } {
  const rate = num(raw?.fundingRate)
  const fundingTime = num(raw?.fundingTime)
  const nextTime = num(raw?.nextFundingTime)
  const span = nextTime - fundingTime
  const interval = Number.isFinite(span) && span > 0 ? span : FUNDING_INTERVAL_MS
  const out: { fundingRate?: number; fundingIntervalMs: Ms; ts: Ms } = {
    fundingIntervalMs: interval,
    ts: Number.isFinite(fundingTime) && fundingTime > 0 ? fundingTime : now,
  }
  if (Number.isFinite(rate)) out.fundingRate = rate
  return out
}

/** 标记价 + 资金费 → MarketContext（OKX 不给指数价，oraclePrice 留空）。 */
export function parseContext(
  mark: { markPrice: number; ts: Ms },
  funding: { fundingRate?: number; fundingIntervalMs: Ms; ts: Ms },
  instrumentId: string,
): MarketContext {
  const context: MarketContext = {
    instrumentId,
    ts: mark.ts,
    markPrice: mark.markPrice,
    fundingIntervalMs: funding.fundingIntervalMs,
  }
  if (funding.fundingRate !== undefined) context.fundingRate = funding.fundingRate
  return context
}

// ---- 请求权重（OKX 公共端点的档位，按调用次数计） ---------------------------

export const INSTRUMENTS_WEIGHT = 1
export const TICKER_WEIGHT = 1
export const MARK_PRICE_WEIGHT = 1
export const FUNDING_RATE_WEIGHT = 1
export const HISTORY_CANDLES_WEIGHT = 1

export const candlesWeight = (limit: number): number => (limit <= 100 ? 1 : 2)
export const booksWeight = (sz: number): number => (sz <= 50 ? 1 : sz <= 100 ? 2 : 5)

export const MAX_BOOK_DEPTH = 400

/** 请求的深度向上取整并钳到 1..400（/market/books 的 sz 上限）。 */
export function depthLimitOf(depth: number | undefined): number {
  const want = Number.isFinite(depth) && (depth as number) > 0 ? Math.ceil(depth as number) : 20
  return Math.max(1, Math.min(MAX_BOOK_DEPTH, want))
}
