// SPDX-License-Identifier: CPAL-1.0
// Bybit v5 公共 REST 响应 → 统一模型（纯函数，无状态；不发请求、不读环境）。
// 原始响应包在 { retCode, retMsg, result, time } 信封里；数值多数是字符串，个别字段是 number。
// 解析不了的回落到协议允许的缺省，不猜精度。
import { asDecimal, makeProblem, normalizeDecimal } from '@gitrader/protocol'
import type {
  Book, BookLevel, Candle, CandleInterval, Decimal, Instrument, InstrumentPriceRule, InstrumentSizeRule, MarketContext, Ms,
  Problem, ProblemName,
} from '@gitrader/protocol'

export const VENUE = 'bybit'
/** Bybit v5 公共 REST 缺省基址；可注入（测试与镜像用）。 */
export const DEFAULT_BASE_URL = 'https://api.bybit.com'
/** 资金费缺省每 8 小时结算；合约清单给了 fundingInterval（分钟）时按上游算。 */
export const FUNDING_INTERVAL_MS: Ms = 28_800_000
/** /v5/market/kline 单次最多 1000 根。 */
export const MAX_CANDLES = 1000
/** 区间翻页时每页请求的根数（= 单页上限）。 */
export const CANDLE_PAGE = 1000
/** 区间翻页硬上限：200 × 1000 根，防上游异常时死循环。 */
export const MAX_PAGES = 200
export const DEFAULT_CANDLE_COUNT = 300
/** 合约清单分页硬上限（每页 1000 条），防游标不前进时死循环。 */
export const MAX_INSTRUMENT_PAGES = 20
/** 公共端点按 IP、按调用次数限频：120 次 / 5 秒（model = count，不是 weight）。 */
export const IP_RATE_LIMIT = 120
export const IP_RATE_WINDOW_MS: Ms = 5_000
/** /v5/market/orderbook 的 limit 上限。 */
export const MAX_BOOK_DEPTH = 500
/** 本连接器只读 USDT 线性永续，固定发 category=linear。 */
export const INSTRUMENT_CATEGORY = 'linear'

/** 协议区间 → 毫秒（翻页窗口按它推进）。 */
export const INTERVAL_MS: Record<CandleInterval, number> = {
  '1m': 60_000, '3m': 180_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000,
  '1h': 3_600_000, '2h': 7_200_000, '4h': 14_400_000, '8h': 28_800_000, '12h': 43_200_000,
  '1d': 86_400_000, '3d': 259_200_000, '1w': 604_800_000, '1M': 2_592_000_000,
}

/**
 * 协议区间 → Bybit interval 拼写。Bybit v5 只有 1/3/5/15/30/60/120/240/360/720/D/W/M，
 * 没有 8 小时也没有 3 天，故 8h / 3d 不在表内（调用方据此抛 INVALID_PARAMS）。
 */
export const BYBIT_INTERVAL: Partial<Record<CandleInterval, string>> = {
  '1m': '1', '3m': '3', '5m': '5', '15m': '15', '30m': '30',
  '1h': '60', '2h': '120', '4h': '240', '12h': '720',
  '1d': 'D', '1w': 'W', '1M': 'M',
}

export const instrumentIdOf = (symbol: string): string => `${VENUE}:${symbol}`

/** `bybit:<symbol>` → 场所原生 symbol；不是本场所的 id 就拒绝，避免把别的场所符号发到 Bybit。 */
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

/** 协议周期 → Bybit interval；8h / 3d 与表外周期直接 INVALID_PARAMS（不发请求）。 */
export function intervalOf(interval: CandleInterval): string {
  const mapped = BYBIT_INTERVAL[interval]
  if (!mapped) throw problemError('INVALID_PARAMS', `unsupported candle interval: ${String(interval)}`)
  return mapped
}

// ---- 原始形状 ---------------------------------------------------------------

/** Bybit v5 统一信封：retCode 为 0 表示成功。 */
export interface BybitEnvelope<T> { retCode?: number | string; retMsg?: string; result?: T; time?: number }

export interface RawInstrument {
  symbol?: string
  contractType?: string
  status?: string
  baseCoin?: string
  quoteCoin?: string
  settleCoin?: string
  fundingInterval?: number | string
  priceFilter?: { tickSize?: string }
  lotSizeFilter?: { qtyStep?: string; minOrderQty?: string; minNotionalValue?: string }
}

/** 合约清单一页：result.list[] + result.nextPageCursor。 */
export interface RawInstrumentPage { list?: unknown; nextPageCursor?: string }

/** /v5/market/tickers 的一行（既有字符串也有 number 字段）。 */
export interface RawTicker {
  symbol?: string
  lastPrice?: string
  markPrice?: string
  indexPrice?: string
  bid1Price?: string
  ask1Price?: string
  fundingRate?: string
  nextFundingTime?: string | number
  openInterest?: string
  turnover24h?: string
}

export interface RawTickerPage { list?: unknown }

export interface RawBook { s?: string; b?: unknown[]; a?: unknown[]; ts?: number | string }
export interface RawKlinePage { list?: unknown }

export const num = (v: unknown): number => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN
  if (typeof v !== 'string') return NaN
  const s = v.trim()
  // Bybit 用空串表示「没有值」；Number('') 会得到 0，这里必须当缺失
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

const QUOTE_SUFFIXES = ['USDT', 'USDC', 'USD'] as const

/** 线上合约都带 baseCoin / quoteCoin；缺字段时才按已知计价币后缀切 symbol。 */
function splitSymbol(symbol: string): { base: string; quote: string } | undefined {
  for (const quote of QUOTE_SUFFIXES) {
    if (symbol.length > quote.length && symbol.endsWith(quote)) {
      return { base: symbol.slice(0, -quote.length), quote }
    }
  }
  return undefined
}

function text(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined
}

/** fundingInterval 是「分钟」；缺失或不合法回落 8 小时。 */
function fundingIntervalOf(raw: RawInstrument): Ms {
  const minutes = num(raw.fundingInterval)
  return Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes * 60_000) : FUNDING_INTERVAL_MS
}

// ---- /market/instruments-info → Instrument ----------------------------------

/**
 * 一条合约 → Instrument。只收 `contractType === 'LinearPerpetual'`，状态只收 `Trading` 与 `PendingOpen`：
 * `PendingOpen`（官方 changelog 2026-09-01 新增：转 Trading 前不能下单）进表但标 `halted`，不静默消失；
 * 交割 / 反向 / PreLaunch / 已下架一律跳过（其它状态由上层 discover 重新拉到为止）。
 */
export function parseInstrument(s: RawInstrument, now: Ms): Instrument | undefined {
  const symbol = text(s.symbol)
  if (!symbol) return undefined
  if (s.contractType !== undefined && s.contractType !== 'LinearPerpetual') return undefined
  if (s.status !== undefined && s.status !== 'Trading' && s.status !== 'PendingOpen') return undefined

  const parts = splitSymbol(symbol)
  const base = text(s.baseCoin) ?? parts?.base
  const quote = text(s.quoteCoin) ?? parts?.quote
  if (!base || !quote) return undefined

  const tick = positiveDecimal(s.priceFilter?.tickSize)
  const price: InstrumentPriceRule = tick ? { tick, maxDecimals: decimalsOf(tick) } : { sigFigs: 5, maxDecimals: 8 }

  // 线性永续的数量单位是标的币（qtyStep / minOrderQty 都是币数），不是张。
  const step = positiveDecimal(s.lotSizeFilter?.qtyStep) ?? asDecimal('1')
  const minQty = positiveDecimal(s.lotSizeFilter?.minOrderQty) ?? step
  const size: InstrumentSizeRule = { step, decimals: decimalsOf(step), min: minQty }
  const minNotional = positiveDecimal(s.lotSizeFilter?.minNotionalValue)

  return {
    instrumentId: instrumentIdOf(symbol),
    venue: VENUE,
    symbol,
    displaySymbol: `${base}-PERP`,
    kind: 'perp',
    base,
    quote,
    settle: text(s.settleCoin) ?? quote,
    // 只收 LinearPerpetual，结算方式必然是线性
    settlement: 'linear',
    contractSize: asDecimal('1'),
    venueSizeUnit: 'base',
    assetClass: 'crypto',
    marketGroup: null,
    status: s.status === 'PendingOpen' ? 'halted' : 'trading',
    price,
    size,
    ...(minNotional ? { minNotional } : {}),
    // 只读数据连接器：不下单，所以标的层面也不声明任何可下单类型
    orderTypes: [],
    tif: [],
    triggerPriceTypes: [],
    fundingIntervalMs: fundingIntervalOf(s),
    sessions: { tz: 'UTC', windows: [{ days: [0, 1, 2, 3, 4, 5, 6], from: '00:00', to: '23:59', quality: 'regular' }] },
    updatedAt: now,
  }
}

/** 一页 result.list[] → 标的（按 symbol 升序）。 */
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
 * K 线行 → Candle。Bybit 列顺序：[startTime(ms), open, high, low, close, volume, turnover]，
 * 且整体按时间**倒序**返回 —— 这里只做逐行解析，升降序与去重交给调用方。
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
    out.push({ t, o, h, l, c, v })
  }
  return out
}

/** tickers 一行的可用字段：报价三件套 + 标记价 / 资金费 / 下次资金时间 / 持仓量。 */
export interface ParsedTicker {
  ts: Ms
  bid: number
  ask: number
  last?: number
  markPrice?: number
  fundingRate?: number
  nextFundingTime?: Ms
  openInterest?: number
}

const optional = (store: ParsedTicker, key: 'last' | 'markPrice' | 'fundingRate' | 'openInterest', value: number): void => {
  if (Number.isFinite(value)) store[key] = value
}

/**
 * ticker 行 → ParsedTicker（只解析，不判断能否报价；调用方用 bid/ask > 0 决定 quote 是否可用）。
 * ts 缺失时回落到注入时钟。
 */
export function parseTicker(raw: unknown, now: Ms): ParsedTicker | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const row = raw as RawTicker
  // tickers 的 list 行没有独立时间戳，用注入时钟当采集时刻（信封 time 是服务端时刻，不随行）
  // bid / ask 允许非有限（空串 / 缺字段 = 「这条报价拿不到」）：这里只解析，能不能报价由调用方
  // 用 `bid > 0 && ask > 0` 判定（market.ts:278），不能在这一层把整行 ticker 丢掉 —— 标记价 / 资金
  // 费率还是好用的。
  const out: ParsedTicker = { ts: now, bid: num(row.bid1Price), ask: num(row.ask1Price) }
  optional(out, 'last', num(row.lastPrice))
  optional(out, 'markPrice', num(row.markPrice))
  optional(out, 'fundingRate', num(row.fundingRate))
  optional(out, 'openInterest', num(row.openInterest))
  const next = num(row.nextFundingTime)
  if (Number.isFinite(next) && next > 0) out.nextFundingTime = next
  return out
}

/** b / a → Book；bids 降序、asks 升序，按 depth 截断。 */
export function parseBooks(raw: RawBook | null | undefined, instrumentId: string, depth: number, now: Ms): Book {
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
  const bids = levels(raw?.b).sort((a, b) => b.price - a.price).slice(0, depth)
  const asks = levels(raw?.a).sort((a, b) => a.price - b.price).slice(0, depth)
  const ts = num(raw?.ts)
  return { instrumentId, ts: Number.isFinite(ts) && ts > 0 ? ts : now, bids, asks }
}

/**
 * ticker → MarketContext。标记价 / 资金费 / 持仓量都来自同一次 tickers 请求；
 * 资金间隔取合约清单的 fundingInterval（分钟 → 毫秒），拿不到标的时回落 8 小时。
 */
export function parseContext(ticker: ParsedTicker, instrument: Instrument | undefined, instrumentId: string): MarketContext {
  const context: MarketContext = {
    instrumentId,
    ts: ticker.ts,
    markPrice: ticker.markPrice ?? 0,
    fundingIntervalMs: instrument?.fundingIntervalMs ?? FUNDING_INTERVAL_MS,
  }
  if (ticker.fundingRate !== undefined) context.fundingRate = ticker.fundingRate
  if (ticker.openInterest !== undefined) context.openInterest = ticker.openInterest
  return context
}

// ---- 请求权重（Bybit 公共端点是次数口径，一次请求记 1） ----------------------

export const INSTRUMENTS_WEIGHT = 1
export const TICKER_WEIGHT = 1
export const BOOK_WEIGHT = 1
export const KLINE_WEIGHT = 1

/** 请求的深度向上取整并钳到 1..500（/market/orderbook 的 limit 上限）。 */
export function depthLimitOf(depth: number | undefined): number {
  const want = Number.isFinite(depth) && (depth as number) > 0 ? Math.ceil(depth as number) : 20
  return Math.max(1, Math.min(MAX_BOOK_DEPTH, want))
}
