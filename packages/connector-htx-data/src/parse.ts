// SPDX-License-Identifier: CPAL-1.0
// HTX（原火币）USDT 本位永续公共 REST 响应 → 统一模型（纯函数，无状态；不发请求、不读环境）。
//
// 端点、字段、K 线周期、分页上限的出处一律是 HTX 官方 USDT-M 合约 API v1 文档
// （https://huobiapi.github.io/docs/usdt_swap/v1/en/，2026-10-21 查阅；下文简写「HTX v1 §节名」）。
// 该所字段混用类型：价格/数量时而是字符串、时而是数字；K 线与合约信息的时间是「秒」。
// 解析不了的一律回落到协议允许的缺省，不猜精度、不编字段。
import { asDecimal, makeProblem, normalizeDecimal } from '@gitrader/protocol'
import type {
  Book, BookLevel, Candle, CandleInterval, Decimal, Instrument, InstrumentPriceRule, InstrumentSizeRule, InstrumentStatus,
  MarketContext, Ms, Problem, ProblemName,
} from '@gitrader/protocol'

export const VENUE = 'htx'
/** USDT 本位永续公共 REST 缺省基址；可注入（测试与镜像用）。HTX v1 §API Access。 */
export const DEFAULT_BASE_URL = 'https://api.hbdm.com'
/** 官方文档入口；每个端点注释里的 §节名都指这一页（2026-10-21 查阅）。 */
export const DOCS_URL = 'https://huobiapi.github.io/docs/usdt_swap/v1/en/'
/**
 * 资金费每 8 小时结算一次：官方示例 data.funding_time=1613976000000、next_funding_time=1614004800000，
 * 差值 28 800 000 ms（HTX v1 §[General] Query funding rate）。
 */
export const FUNDING_INTERVAL_MS: Ms = 28_800_000
/** /linear-swap-ex/market/history/kline 的 size 上限 [1,2000]（HTX v1 §[General] Get KLine Data）。 */
export const MAX_CANDLES = 2000
/** 区间翻页的窗口长度（根）：官方 from/to 模式下一次最多给 2000 根。 */
export const CANDLE_PAGE = 2000
/** 区间翻页硬上限：200 × 2000 根，防上游异常时死循环。 */
export const MAX_PAGES = 200
export const DEFAULT_CANDLE_COUNT = 300
/**
 * 公共行情 REST 按 IP 限频：800 次/秒（HTX v1 §API Access「For restful interfaces … 800 times/second
 * for one IP at most」，含 K 线、市场概览、合约信息、盘口）。
 */
export const IP_RATE_LIMIT = 800
export const IP_RATE_WINDOW_MS: Ms = 1000
/**
 * /linear-swap-ex/market/depth 的档位数（HTX v1 §[General] Get Market Depth）：
 * step0 不合并、给 150 档；step6 不合并、给 20 档。其余 step 是合并档，本连接器不用。
 */
export const BOOK_LEVELS_WIDE = 150
export const BOOK_LEVELS_NARROW = 20

/** 协议区间 → 毫秒（翻页游标按它推进）。 */
export const INTERVAL_MS: Record<CandleInterval, number> = {
  '1m': 60_000, '3m': 180_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000,
  '1h': 3_600_000, '2h': 7_200_000, '4h': 14_400_000, '8h': 28_800_000, '12h': 43_200_000,
  '1d': 86_400_000, '3d': 259_200_000, '1w': 604_800_000, '1M': 2_592_000_000,
}

/**
 * 协议区间 → HTX period 拼写。HTX v1 §[General] Get KLine Data 的 period 取值只有
 * `1min, 5min, 15min, 30min, 60min, 1hour, 4hour, 1day, 1mon`；
 * 其余协议区间（3m / 2h / 8h / 12h / 3d / 1w）**不在表内**，调用即 INVALID_PARAMS（不发请求）。
 */
export const VENUE_INTERVALS: Partial<Record<CandleInterval, string>> = {
  '1m': '1min', '5m': '5min', '15m': '15min', '30m': '30min', '1h': '60min', '4h': '4hour', '1d': '1day', '1M': '1mon',
}

export const instrumentIdOf = (symbol: string): string => `${VENUE}:${symbol}`

/** `htx:BTC-USDT` → 场所原生 contract_code；不是本场所的 id 就拒绝，避免把别的场所符号发到 HTX。 */
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

/** 协议周期 → HTX period；不在映射表里的周期直接 INVALID_PARAMS（不发请求）。 */
export function venueIntervalOf(interval: CandleInterval): string {
  const mapped = VENUE_INTERVALS[interval]
  if (!mapped) throw problemError('INVALID_PARAMS', `unsupported candle interval: ${String(interval)}`)
  return mapped
}

// ---- 原始形状 ---------------------------------------------------------------

/**
 * HTX 的公共 REST 统一信封：`{ status: "ok" | "error", data | tick | ticks, ts, ch, err_code, err_msg }`
 * （HTX v1 各端点 Response 段；错误体见 §Details of Each Error Code）。
 */
export interface HtxEnvelope {
  status?: string
  ch?: string
  ts?: number
  data?: unknown
  tick?: unknown
  ticks?: unknown[]
  err_code?: number
  err_msg?: string
}

/** 合约条目（只取本连接器用到的字段；HTX v1 §[General] Query Swap Info）。 */
export interface RawContract {
  symbol?: string
  contract_code?: string
  contract_size?: string | number
  price_tick?: string | number
  contract_status?: number | string
  support_margin_mode?: string
  business_type?: string
  contract_type?: string
  pair?: string
}

/** K 线/标记价 K 线的一行：id 是开盘时间（秒），amount 是币数量，vol 是张数。 */
export interface RawKline {
  id?: number | string
  open?: string | number
  close?: string | number
  high?: string | number
  low?: string | number
  amount?: string | number
  vol?: string | number
}

/** /market/detail/merged 的 tick：ask/bid 是 `[价格, 张数]`。 */
export interface RawMergedTick {
  id?: number | string
  ts?: number | string
  close?: string | number
  ask?: unknown
  bid?: unknown
}

/** /market/depth 的 tick：asks/bids 是 `[[价格, 张数], ...]`。 */
export interface RawDepthTick {
  ts?: number | string
  id?: number | string
  asks?: unknown[]
  bids?: unknown[]
}

/** /swap_funding_rate 的 data（HTX v1 §[General] Query funding rate）。 */
export interface RawFunding {
  contract_code?: string
  fee_asset?: string
  funding_time?: string | number
  funding_rate?: string | number
  estimated_rate?: string | number
  next_funding_time?: string | number
}

export const num = (v: unknown): number => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN
  if (typeof v !== 'string') return NaN
  const s = v.trim()
  // 空串表示「没有值」；Number('') 会得到 0，这里必须当缺失
  if (s === '') return NaN
  const n = Number(s)
  return Number.isFinite(n) ? n : NaN
}

/** 宽松十进制文本 → 规范形；非法 / 非正数返回 undefined（tick、面值为 0 时上游等于没给）。 */
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

/** 张数 × 每张面值的浮点尾差压到 12 位有效数字。 */
export const roundSize = (x: number): number => (Number.isFinite(x) ? Number(x.toPrecision(12)) : x)

/**
 * 张数（Cont.）× 每张对应的标的币数 → 币数量：盘口 size、K 线 vol 回落路径共用这一个入口。
 * 面值未知（合约缓存未加载）或非正时按 1 处理，即原样保留张数。
 */
export function toBaseSize(contracts: number, contractSize: Decimal | number | undefined): number {
  const multiplier = num(contractSize)
  return roundSize(contracts * (Number.isFinite(multiplier) && multiplier > 0 ? multiplier : 1))
}

/** `BTC-USDT` → base / quote（HTX 原生 contract_code 用连字符，大小写原样保留）。 */
function splitSymbol(symbol: string, pair: string | undefined): { base: string; quote: string } {
  const source = typeof pair === 'string' && pair.indexOf('-') > 0 ? pair : symbol
  const i = source.indexOf('-')
  if (i <= 0) return { base: source, quote: 'USDT' }
  return { base: source.slice(0, i), quote: source.slice(i + 1) }
}

/**
 * contract_status → 协议状态（HTX v1 §[General] Query Swap Info 的取值表）：
 * 0 Delisting / 5 In Settlement / 6 Delivering / 7 Settlement Completed / 8 Delivered → delisted；
 * 2 Pending Listing / 3 Suspension / 4 Suspending of Listing → halted（未正常交易）；
 * 1 Listing → trading；未知值按 halted（不假装可交易）。
 */
function statusOf(code: number): InstrumentStatus {
  switch (code) {
    case 1: return 'trading'
    case 0:
    case 5:
    case 6:
    case 7:
    case 8: return 'delisted'
    default: return 'halted'
  }
}

// ---- /swap_contract_info → Instrument ----------------------------------------

/**
 * 合约条目 → Instrument（HTX v1 §[General] Query Swap Info）。
 * - 只收 `business_type === 'swap'` 且 `contract_type === 'swap'` 的永续，且 quote 必须是 USDT / USDC
 *   （工单口径：币本位反向合约第一版排除；币本位走的是另一套 coin-swap 主机，本包不碰）。
 * - `contract_size` 是**每张对应的标的币数**：官方 K 线示例 vol=4 张、amount=0.004 币、trade_turnover=52.3072
 *   ＝4 × 0.001 × 13076.8，反推 1 张 = 0.001 BTC（HTX v1 §[General] Get KLine Data Response）。
 *   所以 size.step = size.min = contract_size，venueSizeUnit 固定 'base'，contractSize 只作展示。
 */
export function parseInstrument(c: RawContract, now: Ms): Instrument | undefined {
  const symbol = typeof c.contract_code === 'string' && c.contract_code !== '' ? c.contract_code : undefined
  if (!symbol) return undefined
  if (typeof c.business_type === 'string' && c.business_type !== 'swap') return undefined
  if (typeof c.contract_type === 'string' && c.contract_type !== 'swap') return undefined

  const { base, quote } = splitSymbol(symbol, c.pair)
  if (quote !== 'USDT' && quote !== 'USDC') return undefined

  const tick = positiveDecimal(c.price_tick)
  const price: InstrumentPriceRule = tick ? { tick, maxDecimals: decimalsOf(tick) } : { sigFigs: 5, maxDecimals: 8 }

  const contractSize = positiveDecimal(c.contract_size) ?? asDecimal('1')
  // 一张 = 一个步长；官方没有公开的「最小下单张数」字段（在私有 swap_order_limit 里），所以最小数量按一张算
  const size: InstrumentSizeRule = { step: contractSize, decimals: decimalsOf(contractSize), min: contractSize }
  const statusCode = num(c.contract_status)

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
    contractSize,
    venueSizeUnit: 'base',
    assetClass: 'crypto',
    marketGroup: null,
    status: Number.isFinite(statusCode) ? statusOf(statusCode) : 'halted',
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

/** /swap_contract_info 的 data 数组 → 标的，按原生符号排序（已滤掉期货 / 非 USDT-USDC 条目）。 */
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
 * K 线行 → Candle（HTX v1 §[General] Get KLine Data）：
 * `id` 是**秒**（×1000 成开盘毫秒）；成交量优先取「以币计」的 `amount`（Trade Amount(Coin)），
 * 缺失时回落到 `vol`（张数）× 每张面值。官方没有承诺返回顺序，排序与去重由调用方兜底。
 */
export function parseCandles(raw: unknown, contractSize?: Decimal | number): Candle[] {
  if (!Array.isArray(raw)) return []
  const out: Candle[] = []
  for (const row of raw) {
    if (!row || typeof row !== 'object') continue
    const r = row as RawKline
    const seconds = num(r.id)
    const o = num(r.open)
    const h = num(r.high)
    const l = num(r.low)
    const c = num(r.close)
    const coinVolume = num(r.amount)
    const volume = Number.isFinite(coinVolume) ? roundSize(coinVolume) : toBaseSize(num(r.vol), contractSize)
    if (![seconds, o, h, l, c, volume].every((x) => Number.isFinite(x))) continue
    if (!(seconds > 0)) continue
    out.push({ t: Math.round(seconds * 1000), o, h, l, c, v: volume })
  }
  return out
}

/**
 * /market/detail/merged 的 tick → { ts, bid, ask, last? }（HTX v1 §[General] Get Market Data Overview）。
 * 买卖价缺失或非正（新标的、流动性空档、上游偶发空数组）视为没有报价；`ts` 是毫秒。
 */
export function parseMergedQuote(
  tick: unknown,
  now: Ms,
): { ts: Ms; bid: number; ask: number; last?: number } | undefined {
  if (!tick || typeof tick !== 'object') return undefined
  const t = tick as RawMergedTick
  const level = (v: unknown): number => (Array.isArray(v) ? num(v[0]) : NaN)
  const bid = level(t.bid)
  const ask = level(t.ask)
  if (!(bid > 0) || !(ask > 0)) return undefined
  const tsRaw = num(t.ts)
  const last = num(t.close)
  const out: { ts: Ms; bid: number; ask: number; last?: number } = {
    ts: Number.isFinite(tsRaw) && tsRaw > 0 ? Math.round(tsRaw) : now,
    bid,
    ask,
  }
  if (last > 0) out.last = last
  return out
}

/**
 * /market/depth 的 tick → Book（HTX v1 §[General] Get Market Depth）。`[price, vol(Cont.)]`，
 * 数量按每张面值折成币数（contractSize 由调用方从合约缓存取，未知时传 undefined 即原样张数）。
 * bids 降序、asks 升序，按 depth 截断；ts 取 tick.ts（毫秒）。
 */
export function parseDepth(
  tick: unknown,
  instrumentId: string,
  depth: number,
  contractSize: Decimal | number | undefined,
  now: Ms,
): Book {
  const levels = (rows: unknown): BookLevel[] => {
    if (!Array.isArray(rows)) return []
    const out: BookLevel[] = []
    for (const row of rows) {
      if (!Array.isArray(row)) continue
      const price = num(row[0])
      const contracts = num(row[1])
      if (!(price > 0) || !(contracts > 0)) continue
      const size = toBaseSize(contracts, contractSize)
      if (!(size > 0)) continue
      out.push({ price, size })
    }
    return out
  }
  const t = (tick ?? {}) as RawDepthTick
  const bids = levels(t.bids).sort((a, b) => b.price - a.price).slice(0, depth)
  const asks = levels(t.asks).sort((a, b) => a.price - b.price).slice(0, depth)
  const tsRaw = num(t.ts)
  return { instrumentId, ts: Number.isFinite(tsRaw) && tsRaw > 0 ? Math.round(tsRaw) : now, bids, asks }
}

/** 标记价 K 线的最后一行 → 最新标记价（HTX v1 §[General] Get Kline Data of Mark Price）。 */
export function parseMarkPrice(raw: unknown, now: Ms): { price: number; ts: Ms } | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined
  let newest: { price: number; ts: Ms } | undefined
  for (const row of raw) {
    if (!row || typeof row !== 'object') continue
    const r = row as RawKline
    const price = num(r.close)
    const seconds = num(r.id)
    if (!(price > 0)) continue
    const ts = seconds > 0 ? Math.round(seconds * 1000) : now
    if (!newest || ts >= newest.ts) newest = { price, ts }
  }
  return newest
}

/**
 * 协议 MarketContext 没有「下次资金时间」字段：HTX 的 next_funding_time（毫秒字符串）以扩展字段
 * `nextFundingTime` 一并返回，其余字段语义不变。
 */
export interface HtxMarketContext extends MarketContext { nextFundingTime?: Ms }

/**
 * 资金费率 data + 标记价 → MarketContext（HTX v1 §[General] Query funding rate / Get Kline Data of Mark Price）。
 * HTX 没有公开的 REST「实时标记价」端点（只有标记价 K 线），所以 markPrice 取最新 1 分钟标记价 K 线的收盘价，
 * 最多落后 1 分钟；拿不到时按协议缺省 0，不拿指数价冒充标记价。
 */
export function parseContext(
  funding: RawFunding | undefined,
  mark: { price: number; ts: Ms } | undefined,
  opts: { instrumentId: string; fundingIntervalMs?: Ms },
  now: Ms,
): HtxMarketContext {
  const rate = num(funding?.funding_rate)
  const nextFunding = num(funding?.next_funding_time)
  const context: HtxMarketContext = {
    instrumentId: opts.instrumentId,
    ts: now,
    markPrice: mark ? mark.price : 0,
    fundingIntervalMs: opts.fundingIntervalMs ?? FUNDING_INTERVAL_MS,
  }
  if (Number.isFinite(rate)) context.fundingRate = rate
  if (Number.isFinite(nextFunding) && nextFunding > 0) context.nextFundingTime = Math.round(nextFunding)
  return context
}

// ---- 盘口档位（官方 step 取值） ----------------------------------------------

/**
 * 请求的深度 → 官方 depth type：≤20 档用 step6（不合并、20 档），更多用 step0（不合并、150 档）。
 * HTX v1 §[General] Get Market Depth：step16-19 只对 SHIB-USDT 生效，本连接器不用合并档。
 */
export function depthStepOf(depth: number | undefined): 'step0' | 'step6' {
  const want = Number.isFinite(depth) && (depth as number) > 0 ? Math.ceil(depth as number) : BOOK_LEVELS_NARROW
  return want <= BOOK_LEVELS_NARROW ? 'step6' : 'step0'
}
