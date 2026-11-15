// SPDX-License-Identifier: CPAL-1.0
// Binance USDⓈ-M 响应 → 统一模型（纯函数、无状态）。三块：
//   1) 标的 / 行情解析：Copied from packages/connector-binance-data/src/parse.ts (CPAL-1.0)；以数据包为准，
//      这里只把 orderTypes / tif / triggerPriceTypes 从「空」改成交易连接器实际能下的类型；
//   2) 订单状态映射：NEW / PARTIALLY_FILLED / FILLED / CANCELED / REJECTED / EXPIRED / EXPIRED_IN_MATCH → 协议状态集；
//   3) 私有流归一：ORDER_TRADE_UPDATE / ACCOUNT_UPDATE / listenKeyExpired → 本包的中性事件（内核以后再适配）。
import { asDecimal, makeProblem, normalizeDecimal } from '@gitrader/protocol'
import type {
  Book, BookLevel, Candle, Decimal, Instrument, InstrumentPriceRule, InstrumentSizeRule, InstrumentStatus,
  MarketContext, Ms, OrderStatus, OrderType, TimeInForce, TriggerPriceType,
} from '@gitrader/protocol'
import { abs, cmpDec, fx, str, subDec } from '@gitrader/protocol/decimal'
import { ProblemError } from './errors'

export const VENUE = 'binance'
/** USDⓈ-M 永续缺省基址（与数据包一致；可注入）。 */
export const DEFAULT_BASE_URL = 'https://fapi.binance.com'
/** USDⓈ-M 永续每 8 小时结算一次资金费（00/08/16 UTC）。 */
export const FUNDING_INTERVAL_MS: Ms = 28_800_000
/** K 线缺省条数（与数据包一致）。 */
export const DEFAULT_CANDLE_COUNT = 300
/** exchangeInfo 里没有 MIN_NOTIONAL 时的缺省下限（官方多数永续为 5 USDT）。 */
export const FALLBACK_MIN_NOTIONAL = '5'
/** 本连接器能下的订单类型（capabilities 与标的声明同一份）。 */
export const SUPPORTED_ORDER_TYPES: OrderType[] = ['market', 'limit', 'stop_market', 'stop_limit', 'take_market', 'take_limit', 'trailing_stop']
export const SUPPORTED_TIF: TimeInForce[] = ['gtc', 'ioc', 'fok', 'alo']
/** Binance `workingType` 支持 MARK_PRICE / CONTRACT_PRICE；本连接器只发 MARK_PRICE。 */
export const SUPPORTED_TRIGGER_TYPES: TriggerPriceType[] = ['mark']

export const instrumentIdOf = (symbol: string): string => `${VENUE}:${symbol}`

/** `binance:<symbol>` → 场所原生 symbol；别的场所的 id 一律拒绝。 */
export function symbolOf(instrumentId: string): string {
  const i = instrumentId.indexOf(':')
  if (i <= 0 || i === instrumentId.length - 1 || instrumentId.slice(0, i) !== VENUE) {
    throw new ProblemError(makeProblem('INVALID_PARAMS', `not a ${VENUE} instrument id: ${JSON.stringify(instrumentId)}`))
  }
  return instrumentId.slice(i + 1)
}

/** 十进制取绝对值（字符串层，不走 JS 浮点）。 */
export const absDecimal = (v: string): Decimal => asDecimal(str(abs(fx(v))))

/** total − available，负数按 0 处理（对账数值走 decimal，不做浮点加减）。 */
export const holdOf = (total: Decimal, available: Decimal): Decimal => {
  const diff = subDec(total, available)
  return fx(diff) > 0n ? diff : asDecimal('0')
}

export const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  return Number.isFinite(n) ? n : NaN
}

/** 宽松十进制文本 → Decimal；缺失 / 非法回落到 fallback（上游偶发空串）。 */
export function decimalOf(v: unknown, fallback = '0'): Decimal {
  if (typeof v === 'string') {
    const s = v.trim()
    if (s !== '') {
      try {
        return normalizeDecimal(s)
      } catch {
        /* fall through */
      }
    }
  }
  if (typeof v === 'number' && Number.isFinite(v)) {
    try {
      return normalizeDecimal(String(v))
    } catch {
      /* fall through */
    }
  }
  return asDecimal(fallback)
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

/** 标的记录：协议 Instrument + 场所原生 symbol（下单参数要用）。 */
export interface InstrumentRecord {
  instrument: Instrument
  symbol: string
}

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

// Copied from packages/connector-binance-data/src/parse.ts:131-197 (CPAL-1.0); 只加了可下单类型声明。
export function parseInstrument(s: RawSymbol, now: Ms): Instrument | undefined {
  const symbol = typeof s.symbol === 'string' && s.symbol !== '' ? s.symbol : undefined
  if (!symbol) return undefined
  // 只收永续：交割 / 非合约条目跳过
  if (typeof s.contractType === 'string' && s.contractType !== 'PERPETUAL') return undefined
  const quoteAsset = typeof s.quoteAsset === 'string' ? s.quoteAsset : ''
  const { base, quote } = splitSymbol(symbol, quoteAsset)
  const filters = Array.isArray(s.filters) ? s.filters : []
  const filter = (type: string): RawFilter | undefined => filters.find((f) => !!f && f.filterType === type)

  const tick = positiveDecimal(filter('PRICE_FILTER')?.tickSize)
  const pricePrecision = num(s.pricePrecision)
  const maxDecimals = Number.isInteger(pricePrecision) && pricePrecision >= 0 ? pricePrecision : tick ? decimalsOf(tick) : 8
  const price: InstrumentPriceRule = tick ? { tick, maxDecimals } : { maxDecimals }

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
    minNotional: minNotional ?? asDecimal(FALLBACK_MIN_NOTIONAL),
    orderTypes: [...SUPPORTED_ORDER_TYPES],
    tif: [...SUPPORTED_TIF],
    triggerPriceTypes: [...SUPPORTED_TRIGGER_TYPES],
    fundingIntervalMs: FUNDING_INTERVAL_MS,
    sessions: { tz: 'UTC', windows: [{ days: [0, 1, 2, 3, 4, 5, 6], from: '00:00', to: '23:59', quality: 'regular' }] },
    updatedAt: now,
  }
}

/** exchangeInfo 全量 → 标的记录（含已下架，由上层决定是否展示）。 */
export function parseInstrumentRecords(raw: unknown, now: Ms): InstrumentRecord[] {
  const list = (raw as RawExchangeInfo | null | undefined)?.symbols
  if (!Array.isArray(list)) return []
  const out: InstrumentRecord[] = []
  for (const s of list) {
    if (!s || typeof s !== 'object') continue
    const instrument = parseInstrument(s as RawSymbol, now)
    if (instrument) out.push({ instrument, symbol: instrument.symbol })
  }
  return out.sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0))
}

/** 只要 Instrument 列表（与数据包 parseInstruments 同形）。 */
export function parseInstruments(raw: unknown, now: Ms): Instrument[] {
  return parseInstrumentRecords(raw, now).map((r) => r.instrument)
}

// ---- 行情 -------------------------------------------------------------------

// Copied from packages/connector-binance-data/src/parse.ts:200-283 (CPAL-1.0).
/** 12 列 kline 数组 → Candle（t 为开盘毫秒）。 */
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

/** bookTicker → { ts, bid, ask }；买卖价缺失 / 非正视为没有报价。 */
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

/** premiumIndex → MarketContext：标记价、指数价、资金费率。 */
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

// ---- 订单状态映射 -----------------------------------------------------------

/** Binance 订单状态 → 协议状态集（未列出的返回 null，由调用方决定怎么处置）。 */
export const ORDER_STATUS_MAP: Record<string, OrderStatus> = {
  NEW: 'open',
  PARTIALLY_FILLED: 'partially_filled',
  FILLED: 'filled',
  CANCELED: 'cancelled',
  REJECTED: 'rejected',
  EXPIRED: 'expired',
  EXPIRED_IN_MATCH: 'expired',
  // algo 单（/fapi/v1/algoOrder）状态：NEW 待触发，TRIGGERING / TRIGGERED 已生效，FINISHED 已成交。
  // 归一表照 QD execution_streams/events.py:30-40（active → open，done → filled，取消类 → cancelled）。
  TRIGGERING: 'open',
  TRIGGERED: 'open',
  FINISHED: 'filled',
}

export function mapOrderStatus(raw: unknown): OrderStatus | null {
  if (typeof raw !== 'string') return null
  return ORDER_STATUS_MAP[raw] ?? null
}

/** 场所订单类型 → 协议 open order 类型（协议 VenueOpenOrder.type 的枚举）。 */
export function mapOpenOrderType(raw: unknown): 'limit' | 'stop_market' | 'stop_limit' | 'take_market' | 'take_limit' | 'unknown' {
  switch (raw) {
    case 'LIMIT': return 'limit'
    case 'STOP_MARKET': return 'stop_market'
    case 'STOP': return 'stop_limit'
    case 'TAKE_PROFIT_MARKET': return 'take_market'
    case 'TAKE_PROFIT': return 'take_limit'
    case 'TRAILING_STOP_MARKET': return 'stop_market'
    default: return 'unknown'
  }
}

// ---- 私有流归一 -------------------------------------------------------------

export interface UserOrderEvent {
  kind: 'order'
  ts: Ms
  instrumentId: string
  venueOrderId: string
  clientOrderId: string | null
  rawStatus: string
  status: OrderStatus | null
  /** 成交号（d.t）：内核去重键；没有成交时为 ''。 */
  tradeId: string
  /** 执行类型（d.x）：TRADE / NEW / CANCELED / CALCULATED … */
  executionType: string
  side: 'buy' | 'sell'
  positionSide: 'LONG' | 'SHORT' | 'BOTH'
  orderType: string
  filledSize: Decimal
  lastFillSize: Decimal
  avgPrice: Decimal | null
  lastFillPrice: Decimal | null
  stopPrice: Decimal | null
  realizedPnl: Decimal
  fee: Decimal | null
  feeCcy: string | null
  maker: boolean
  reduceOnly: boolean
}

export interface UserAccountEvent {
  kind: 'account'
  ts: Ms
  reason: string
  /**
   * ACCOUNT_UPDATE 只给 wb / cw / bc：total = wb、crossWallet = cw；不给可用余额（不写 0），
   * 可用余额由 REST /fapi/v2/account 对账补。
   */
  balances: Array<{ asset: string; total: Decimal; crossWallet: Decimal; ts: Ms }>
  positions: Array<{
    instrumentId: string
    side: 'long' | 'short'
    size: Decimal
    entryPrice: Decimal
    unrealizedPnl: Decimal
  }>
}

export interface ListenKeyExpiredEvent { kind: 'listenKeyExpired'; ts: Ms }
export interface UnknownUserEvent { kind: 'unknown'; eventType: string; ts: Ms }

export type BinanceUserEvent = UserOrderEvent | UserAccountEvent | ListenKeyExpiredEvent | UnknownUserEvent

const sideOf = (v: unknown): 'buy' | 'sell' => (typeof v === 'string' && v.toUpperCase() === 'SELL' ? 'sell' : 'buy')

const positionSideOf = (v: unknown): 'LONG' | 'SHORT' | 'BOTH' => {
  const s = typeof v === 'string' ? v.toUpperCase() : ''
  return s === 'LONG' || s === 'SHORT' ? s : 'BOTH'
}

const optionalDecimal = (v: unknown): Decimal | null => (v === undefined || v === null || v === '' ? null : decimalOf(v))

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/execution_streams/normalizers.py:34-79; adapted.
/** 私有流原始帧 → 本包的中性事件；认不出来的返回 unknown 事件（不抛错，流不能因为一条怪消息断掉）。 */
export function normalizeUserEvent(payload: unknown): BinanceUserEvent | null {
  if (payload === null || typeof payload !== 'object') return null
  const p = payload as Record<string, unknown>
  const eventType = typeof p.e === 'string' ? p.e : ''
  const eventTs = num(p.E)

  if (eventType === 'ALGO_UPDATE') {
    const o = p.o
    if (!o || typeof o !== 'object' || Array.isArray(o)) return null
    const d = o as Record<string, unknown>
    const symbol = typeof d.s === 'string' && d.s !== '' ? d.s : undefined
    const algoId = d.aid
    const aid = typeof algoId === 'string' || typeof algoId === 'number' ? String(algoId) : ''
    const side = typeof d.S === 'string' ? d.S.toUpperCase() : ''
    if (!symbol || aid === '' || (side !== 'BUY' && side !== 'SELL')) return null

    const rawStatus = typeof d.X === 'string' ? d.X : ''
    const filledSize = optionalDecimal(d.aq) ?? asDecimal('0')
    let status: OrderStatus | null
    switch (rawStatus) {
      case 'NEW': status = 'untriggered'; break
      case 'TRIGGERING': status = null; break
      case 'TRIGGERED': status = 'open'; break
      case 'CANCELED': status = 'cancelled'; break
      case 'REJECTED': status = 'rejected'; break
      case 'EXPIRED': status = 'expired'; break
      case 'FINISHED': {
        const q = strictDecimal(d.q)
        const aq = strictDecimal(d.aq)
        if (q === null || aq === null || cmpDec(q, '0') <= 0 || cmpDec(aq, '0') < 0 || cmpDec(aq, q) > 0) {
          status = null
        } else {
          status = cmpDec(aq, q) === 0 ? 'filled' : 'cancelled'
        }
        break
      }
      default: status = null
    }
    const ts = num(p.T) || eventTs
    const venueOrderId = (rawStatus === 'TRIGGERED' || rawStatus === 'FINISHED')
      && (typeof d.ai === 'string' || typeof d.ai === 'number') && String(d.ai) !== ''
      ? String(d.ai)
      : aid
    return {
      kind: 'order',
      ts: Number.isFinite(ts) && ts > 0 ? ts : 0,
      instrumentId: instrumentIdOf(symbol),
      venueOrderId,
      clientOrderId: typeof d.caid === 'string' && d.caid !== '' ? d.caid : null,
      rawStatus,
      status,
      tradeId: '',
      executionType: rawStatus,
      side: side === 'SELL' ? 'sell' : 'buy',
      positionSide: positionSideOf(d.ps),
      orderType: typeof d.o === 'string' ? d.o : '',
      filledSize,
      lastFillSize: asDecimal('0'),
      avgPrice: optionalDecimal(d.ap),
      lastFillPrice: null,
      stopPrice: optionalDecimal(d.tp),
      realizedPnl: asDecimal('0'),
      fee: null,
      feeCcy: null,
      maker: false,
      reduceOnly: d.R === true,
    }
  }

  if (eventType === 'ORDER_TRADE_UPDATE') {
    const o = p.o
    if (!o || typeof o !== 'object') return null
    const d = o as Record<string, unknown>
    const ts = num(d.T) || eventTs
    const rawStatus = typeof d.X === 'string' ? d.X : ''
    return {
      kind: 'order',
      ts: Number.isFinite(ts) && ts > 0 ? ts : 0,
      instrumentId: instrumentIdOf(String(d.s ?? '')),
      venueOrderId: String(d.i ?? ''),
      clientOrderId: typeof d.c === 'string' && d.c !== '' ? d.c : null,
      rawStatus,
      status: mapOrderStatus(rawStatus),
      tradeId: typeof d.t === 'number' || typeof d.t === 'string' ? String(d.t) : '',
      executionType: typeof d.x === 'string' ? d.x : '',
      side: sideOf(d.S),
      positionSide: positionSideOf(d.ps),
      orderType: typeof d.o === 'string' ? d.o : typeof d.ot === 'string' ? d.ot : '',
      filledSize: decimalOf(d.z),
      lastFillSize: decimalOf(d.l),
      avgPrice: optionalDecimal(d.ap),
      lastFillPrice: optionalDecimal(d.L),
      stopPrice: optionalDecimal(d.sp),
      realizedPnl: decimalOf(d.rp),
      fee: optionalDecimal(d.n),
      feeCcy: typeof d.N === 'string' && d.N !== '' ? d.N : null,
      maker: d.m === true,
      reduceOnly: d.R === true,
    }
  }

  if (eventType === 'ACCOUNT_UPDATE') {
    const a = p.a
    if (!a || typeof a !== 'object') return null
    const d = a as Record<string, unknown>
    const ts = num(d.T) || eventTs
    const balances = Array.isArray(d.B)
      ? d.B.flatMap((row) => {
        if (!row || typeof row !== 'object') return []
        const b = row as Record<string, unknown>
        const asset = typeof b.a === 'string' ? b.a : ''
        if (asset === '') return []
        const total = decimalOf(b.wb)
        const crossWallet = decimalOf(b.cw)
        return [{ asset, total, crossWallet, ts: Number.isFinite(ts) && ts > 0 ? ts : 0 }]
      })
      : []
    const positions = Array.isArray(d.P)
      ? d.P.flatMap((row) => {
        if (!row || typeof row !== 'object') return []
        const pos = row as Record<string, unknown>
        const symbol = typeof pos.s === 'string' ? pos.s : ''
        if (symbol === '') return []
        // pa = 0 是平仓行，不能丢（内核要看到仓位归零）。
        const amount = typeof pos.pa === 'string' || typeof pos.pa === 'number' ? String(pos.pa) : '0'
        const signed = num(amount)
        if (Number.isNaN(signed)) return []
        return [{
          instrumentId: instrumentIdOf(symbol),
          side: (signed < 0 ? 'short' : 'long') as 'long' | 'short',
          size: absDecimal(decimalOf(amount)),
          entryPrice: decimalOf(pos.ep),
          unrealizedPnl: decimalOf(pos.up),
        }]
      })
      : []
    return {
      kind: 'account',
      ts: Number.isFinite(ts) && ts > 0 ? ts : 0,
      reason: typeof d.m === 'string' ? d.m : '',
      balances,
      positions,
    }
  }

  if (eventType === 'listenKeyExpired') {
    return { kind: 'listenKeyExpired', ts: Number.isFinite(eventTs) && eventTs > 0 ? eventTs : 0 }
  }

  return { kind: 'unknown', eventType, ts: Number.isFinite(eventTs) && eventTs > 0 ? eventTs : 0 }
}

function strictDecimal(value: unknown): Decimal | null {
  if (typeof value !== 'string') return null
  try {
    return normalizeDecimal(value)
  } catch {
    return null
  }
}

/** 把 WebSocket 帧文本解析成事件；坏 JSON 返回 null（不抛）。 */
export function parseUserStreamMessage(text: string): BinanceUserEvent | null {
  try {
    return normalizeUserEvent(JSON.parse(text) as unknown)
  } catch {
    return null
  }
}
