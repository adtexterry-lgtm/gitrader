// SPDX-License-Identifier: CPAL-1.0
// 上游 JSON → 协议对象的纯函数集合（无网络）。
// 上游形状出处（Trading API v2 官方文档）：
//   · GET /v2/account：{id, account_number, status, currency, cash, buying_power, equity, last_equity,
//     initial_margin, maintenance_margin, multiplier, daytrade_count, pattern_day_trader, trading_blocked,
//     transfers_blocked, account_blocked, shorting_enabled, ...}；
//   · GET /v2/positions：{symbol, asset_class, qty, qty_available, side, avg_entry_price, current_price,
//     market_value, cost_basis, unrealized_pl, ...}——**持仓专用端点**（教训 5：不从账户汇总里取残缺字段）；
//   · GET /v2/orders：{id, client_order_id, symbol, side, type, time_in_force, qty, filled_qty,
//     filled_avg_price, status, order_class, limit_price, stop_price, extended_hours, created_at, ...}；
//   · GET /v2/account/activities?activity_types=FILL：{id, activity_type, transaction_time, type, price, qty,
//     side, symbol, order_id, cum_qty, leaves_qty, order_status}（QD client.py:592-643 的手写请求即此口径；
//     成交去重键见 fillDedupeKey：两路都用 order_id + 累计成交量）。
// 铁律：字段缺失不猜——关键行缺字段就抛（挂单 / 成交 / 持仓都不当空表处理，教训 8 的同一口径）。
import { normalizeDecimal } from '@gitrader/protocol'
import type { AccountId, Balance, MarginSnapshot, Ms, OrderStatus, Position } from '@gitrader/protocol'
import type { VenueOpenOrder, VenueOrderStatus } from '@gitrader/protocol/connector'
import type { AccountSnapshotSource } from '@gitrader/protocol/connector'
import type { VenueFill } from '@gitrader/protocol/connector'
import { abs as absFx, fx, mul, str as fxStr } from '@gitrader/protocol/decimal'
import { VENUE } from './constants'

/** 上游给的宽松十进制文本 → 协议规范形（去尾随 0，不做浮点运算）。 */
const dec = (value: string): import('@gitrader/protocol').Decimal => normalizeDecimal(value)
const str = (v: unknown): string => {
  if (v === undefined || v === null) return ''
  if (typeof v === 'string') return v.trim()
  if (typeof v === 'number' || typeof v === 'boolean') return String(v).trim()
  // 对象 / 数组 / 符号：交易所响应里这些字段本该是标量，畸形值当缺失（String({}) 会回显
  // "[object Object]"，带坏 toString 的对象还会直接把解析抛掉）
  return ''
}
const numOr = (v: unknown, fallback = 0): number => {
  if (v === undefined || v === null || v === '') return fallback
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}
const bool = (v: unknown): boolean => v === true || v === 'true'
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
/** 十进制文本取绝对值：去掉前导 `-` 后规范化，不过 Number。空串按 '0'。 */
const absText = (value: string): string => {
  const text = value.trim()
  const body = text.startsWith('-') ? text.slice(1) : text
  return normalizeDecimal(body === '' ? '0' : body)
}

/** ISO-8601 → ms（Alpaca 全部时间字段都是 ISO，例如 2026-10-21T13:30:00.123456789Z）。 */
export function msOf(iso: string | undefined | null, fallback = 0): Ms {
  const raw = str(iso)
  if (raw === '') return fallback
  const parsed = Date.parse(raw)
  return Number.isFinite(parsed) ? parsed : fallback
}

/** ms → ISO-8601（UTC，毫秒精度）——activities 的 `after` / 测试断言用。 */
export function isoOf(ms: Ms): string {
  return new Date(ms).toISOString()
}

// ───────────── 订单 ─────────────

export interface OrderRow {
  id: string
  clientOrderId: string
  symbol: string
  side: 'buy' | 'sell'
  type: string
  timeInForce: string
  status: string
  qty: string
  filledQty: string
  filledAvgPrice: string | null
  orderClass: string
  limitPrice: string | null
  stopPrice: string | null
  extendedHours: boolean
  createdAt: Ms
  updatedAt: Ms
  raw: Record<string, unknown>
}

/** 订单行；缺 id / symbol / side 就抛（不把坏行当成「没这张单」）。 */
export function parseOrder(payload: unknown): OrderRow {
  if (!isRecord(payload)) throw new TypeError('alpaca order response is not an object')
  const id = str(payload['id'])
  const symbol = str(payload['symbol']).toUpperCase()
  const side = str(payload['side']).toLowerCase()
  if (id === '') throw new TypeError('alpaca order has no id')
  if (symbol === '') throw new TypeError(`alpaca order ${id} has no symbol`)
  if (side !== 'buy' && side !== 'sell') throw new TypeError(`alpaca order ${id} has an unknown side: ${side}`)
  return {
    id,
    clientOrderId: str(payload['client_order_id']),
    symbol,
    side,
    type: str(payload['type']),
    timeInForce: str(payload['time_in_force']),
    status: str(payload['status']).toLowerCase(),
    qty: str(payload['qty']) === '' ? '0' : str(payload['qty']),
    filledQty: str(payload['filled_qty']) === '' ? '0' : str(payload['filled_qty']),
    filledAvgPrice: str(payload['filled_avg_price']) === '' ? null : str(payload['filled_avg_price']),
    orderClass: str(payload['order_class']) === '' ? 'simple' : str(payload['order_class']),
    limitPrice: str(payload['limit_price']) === '' ? null : str(payload['limit_price']),
    stopPrice: str(payload['stop_price']) === '' ? null : str(payload['stop_price']),
    extendedHours: bool(payload['extended_hours']),
    createdAt: msOf(str(payload['submitted_at']) || str(payload['created_at'])),
    updatedAt: msOf(str(payload['updated_at']) || str(payload['submitted_at']) || str(payload['created_at'])),
    raw: payload,
  }
}

/** Alpaca 原生 status → 协议 OrderStatus（全表导出给测试断言；不认识的落 'submitted' 并保留原文）。 */
export const ORDER_STATUS_MAP: Record<string, OrderStatus> = {
  new: 'open',
  accepted: 'submitted',
  pending_new: 'submitted',
  accepted_for_bidding: 'submitted',
  partially_filled: 'partially_filled',
  filled: 'filled',
  done_for_day: 'expired',
  canceled: 'cancelled',
  expired: 'expired',
  replaced: 'cancelled',
  pending_cancel: 'open',
  pending_replace: 'open',
  stopped: 'open',
  suspended: 'open',
  calculated: 'filled',
  held: 'untriggered',
  rejected: 'rejected',
  denied: 'rejected',
}

export function mapOrderStatus(raw: string | undefined): OrderStatus {
  return ORDER_STATUS_MAP[(raw ?? '').toLowerCase()] ?? 'submitted'
}

/**
 * 上游状态 + 数量 → 协议 OrderStatus。
 * `calculated` 是「日终计算」的中间态：按累计成交量判（十进制比较），够量才算 filled，否则 expired。
 * 其它状态走 mapOrderStatus。空数量按 '0' 处理。
 */
export function orderStatusOf(raw: string, qty: string, filledQty: string): OrderStatus {
  if (raw.toLowerCase() === 'calculated') {
    const qtyText = qty.trim() === '' ? '0' : qty.trim()
    const filledText = filledQty.trim() === '' ? '0' : filledQty.trim()
    return fx(filledText) >= fx(qtyText) ? 'filled' : 'expired'
  }
  return mapOrderStatus(raw)
}

/** 下单回执的状态（AckStatus 比 OrderStatus 窄：只关心「挂着 / 成交 / 未触发 / 拒绝 / 未知」）。 */
export function ackStatusOf(raw: string | undefined): 'open' | 'filled' | 'untriggered' | 'rejected' {
  const status = (raw ?? '').toLowerCase()
  if (status === 'filled' || status === 'calculated') return 'filled'
  if (status === 'rejected' || status === 'denied' || status === 'canceled' || status === 'expired') return 'rejected'
  if (status === 'held' || status === 'stopped') return 'untriggered'
  return 'open'
}

export function parseOrderStatus(payload: unknown): VenueOrderStatus {
  const row = parseOrder(payload)
  return {
    found: true,
    status: orderStatusOf(row.status, row.qty, row.filledQty),
    venueOrderId: row.id,
    filledSize: dec(row.filledQty),
    raw: row.raw,
  }
}

// ───────────── 挂单 ─────────────

/** 协议挂单类型；Alpaca 的 type 只有 market / limit / stop / stop_limit / trailing_stop。 */
export function mapOpenOrderType(raw: string | undefined): VenueOpenOrder['type'] {
  switch ((raw ?? '').toLowerCase()) {
    case 'limit': return 'limit'
    case 'stop': return 'stop_market'
    case 'stop_limit': return 'stop_limit'
    case 'trailing_stop': return 'stop_market'
    default: return 'unknown'
  }
}

export function parseOpenOrder(payload: unknown, now: Ms): VenueOpenOrder | undefined {
  const row = parseOrder(payload)
  const created = row.createdAt === 0 ? now : row.createdAt
  return {
    instrumentId: `${VENUE}:${row.symbol}`,
    venueOrderId: row.id,
    clientOrderId: row.clientOrderId === '' ? null : row.clientOrderId,
    side: row.side,
    type: mapOpenOrderType(row.type),
    price: row.limitPrice === null ? null : dec(row.limitPrice),
    triggerPrice: row.stopPrice === null ? null : dec(row.stopPrice),
    size: dec(row.qty),
    origSize: dec(row.qty),
    reduceOnly: false, // Alpaca 没有 reduceOnly 字段
    isTrigger: row.type === 'stop' || row.type === 'stop_limit' || row.type === 'stopped',
    createdAt: created,
  }
}

/** 挂单列表；任一行坏了整体抛（fail closed：不把「读不全」当成「没有挂单」）。 */
export function parseOpenOrders(payload: unknown, now: Ms): VenueOpenOrder[] {
  if (!Array.isArray(payload)) throw new TypeError('alpaca open-orders response is not an array')
  const out: VenueOpenOrder[] = []
  for (const raw of payload) {
    const order = parseOpenOrder(raw, now)
    if (order !== undefined) out.push(order)
  }
  return out
}

// ───────────── 持仓 ─────────────

export interface ParseContext {
  accountId: AccountId
  now: Ms
}

/** 持仓专用端点的一行 → Position。`qty` 为负（老口径）或 side='short' 都认。 */
export function parsePosition(payload: unknown, ctx: ParseContext): Position | undefined {
  if (!isRecord(payload)) throw new TypeError('alpaca position row is not an object')
  const symbol = str(payload['symbol']).toUpperCase()
  if (symbol === '') throw new TypeError('alpaca position row has no symbol')
  const rawQty = str(payload['qty']) === '' ? '0' : str(payload['qty'])
  const qtyFx = fx(rawQty)
  const sideRaw = str(payload['side']).toLowerCase()
  const side = sideRaw === 'short' || (sideRaw === '' && qtyFx < 0n) ? 'short' : 'long'
  const size = absText(rawQty)
  if (size === '0') return undefined // 平掉的零仓位不占持仓表
  const entry = str(payload['avg_entry_price']) === '' ? '0' : normalizeDecimal(str(payload['avg_entry_price']))
  const mark = str(payload['current_price']) === '' ? entry : normalizeDecimal(str(payload['current_price']))
  const rawMarketValue = str(payload['market_value'])
  const marketValue = rawMarketValue === '' ? fxStr(absFx(mul(fx(size), fx(mark)))) : absText(rawMarketValue)
  const leverage = 1 // Alpaca 持仓不给杠杆：现金 / 保证金账户按 1 倍报（八条 #8）
  return {
    accountId: ctx.accountId,
    instrumentId: `${VENUE}:${symbol}`,
    side,
    size: dec(size),
    entryPrice: dec(entry),
    markPrice: dec(mark),
    notional: dec(marketValue),
    unrealizedPnl: dec(str(payload['unrealized_pl']) === '' ? '0' : normalizeDecimal(str(payload['unrealized_pl']))),
    realizedPnl: dec('0'),
    leverage,
    marginMode: 'cross',
    liquidationPrice: null, // 现金 / 保证金账户没有逐仓强平价（八条 #8：没有就说没有）
    fundingSinceOpen: dec('0'), // 股票没有资金费（八条 #8）
    openedAt: msOf(str(payload['created_at']), ctx.now),
    updatedAt: ctx.now,
  }
}

export function parsePositions(payload: unknown, ctx: ParseContext): Position[] {
  if (!Array.isArray(payload)) throw new TypeError('alpaca positions response is not an array')
  const out: Position[] = []
  for (const raw of payload) {
    const pos = parsePosition(raw, ctx)
    if (pos !== undefined) out.push(pos)
  }
  return out
}

/** 该标的现在可卖的多头数量（股）；查不到该标的 → '0'（十进制相加，不过 Number）。 */
export function heldLongQty(positions: readonly Position[], instrumentId: string): string {
  let total = 0n
  for (const pos of positions) {
    if (pos.instrumentId !== instrumentId) continue
    if (pos.side !== 'long') continue
    total += fx(pos.size)
  }
  return fxStr(total)
}

/**
 * 原始持仓数组 → 该标的多头**可卖**数量（`qty_available`，缺失时退回 `qty`）。
 * 卖单归属用：挂单占住的股份不能再卖，所以取可卖量而不是名义持仓量。
 * 用十进制相加（教训 7）；查不到该标的 → '0'。
 */
export function availableLongQty(payload: unknown, symbol: string): string {
  if (!Array.isArray(payload)) throw new TypeError('alpaca positions response is not an array')
  const wanted = symbol.trim().toUpperCase()
  let total = 0n
  for (const raw of payload) {
    if (!isRecord(raw)) throw new TypeError('alpaca position row is not an object')
    if (str(raw['symbol']).toUpperCase() !== wanted) continue
    const qtyText = str(raw['qty']) === '' ? '0' : str(raw['qty'])
    const qty = fx(qtyText)
    const sideRaw = str(raw['side']).toLowerCase()
    const side = sideRaw === 'short' || (sideRaw === '' && qty < 0n) ? 'short' : 'long'
    if (side !== 'long') continue
    const availableText = str(raw['qty_available']) === '' ? qtyText : str(raw['qty_available'])
    total += fx(availableText)
  }
  return fxStr(total)
}

// ───────────── 账户 ─────────────

/** 账户限制（协议 AccountSnapshot 没有这些字段——八条 #6 要求如实上报，见 REPORT 的协议缺口）。 */
export interface AccountRestrictions {
  tradingBlocked: boolean
  accountBlocked: boolean
  transfersBlocked: boolean
  patternDayTrader: boolean
  daytradeCount: number
  shortingEnabled: boolean
  multiplier: number
  status: string
  /** 原始行（不带密钥；账户行里没有密钥字段）。 */
  raw: Record<string, unknown>
}

export interface ParsedAccount {
  balances: Balance[]
  margin: MarginSnapshot
  restrictions: AccountRestrictions
  source: AccountSnapshotSource
}

/** `GET /v2/account` → 余额 / 保证金 / 限制标志。 */
export function parseAccount(payload: unknown, ctx: ParseContext): ParsedAccount {
  if (!isRecord(payload)) throw new TypeError('alpaca account response is not an object')
  const cash = str(payload['cash'])
  const buyingPower = str(payload['buying_power'])
  const equity = str(payload['equity']) === '' ? str(payload['portfolio_value']) : str(payload['equity'])
  if (equity === '') throw new TypeError('alpaca account response has no equity / portfolio_value')
  const maintenance = str(payload['maintenance_margin']) === '' ? '0' : str(payload['maintenance_margin'])
  const initial = str(payload['initial_margin']) === '' ? '0' : str(payload['initial_margin'])
  const equityN = Number(equity)
  const maintenanceN = Number(maintenance)
  const ratio = Number.isFinite(equityN) && equityN > 0 && Number.isFinite(maintenanceN) ? maintenanceN / equityN : 0
  const multiplier = numOr(payload['multiplier'], 1)
  const currency = str(payload['currency']) === '' ? 'USD' : str(payload['currency'])
  const balance: Balance = {
    accountId: ctx.accountId,
    asset: currency,
    total: dec(cash === '' ? equity : cash),
    available: dec(buyingPower === '' ? (cash === '' ? equity : cash) : buyingPower),
    hold: dec('0'),
    ts: ctx.now,
  }
  return {
    balances: [balance],
    margin: {
      accountId: ctx.accountId,
      model: 'standard',
      valuationCcy: currency,
      equity: dec(equity),
      initialMargin: dec(initial),
      maintenanceMargin: dec(maintenance),
      available: dec(buyingPower === '' ? equity : buyingPower),
      marginRatio: dec(String(Number.isFinite(ratio) ? ratio : 0)),
      leverage: Number.isFinite(multiplier) && multiplier > 0 ? multiplier : 1,
      ts: ctx.now,
    },
    restrictions: {
      tradingBlocked: bool(payload['trading_blocked']),
      accountBlocked: bool(payload['account_blocked']),
      transfersBlocked: bool(payload['transfers_blocked']),
      patternDayTrader: bool(payload['pattern_day_trader']),
      daytradeCount: numOr(payload['daytrade_count'], 0),
      shortingEnabled: bool(payload['shorting_enabled']),
      multiplier: Number.isFinite(multiplier) ? multiplier : 1,
      status: str(payload['status']),
      raw: payload,
    },
    source: 'rest',
  }
}

// ───────────── 成交（account activities FILL）─────────────

export interface ParsedFill {
  fill: VenueFill
  /** 诊断：账户活动 id（REST 成交）。 */
  activityId: string
  /** 诊断：上游执行 id（有就保留，重放 / 私有流对账用）。 */
  executionId: string | null
  activityType: string
}

/**
 * `GET /v2/account/activities?activity_types=FILL` 的一行 → VenueFill。
 * 去重键与私有流一致：`venueFillId` = `<order_id>:<累计成交量>`（见 fillDedupeKey 的说明）。
 * 手续费不在 FILL 活动里（Alpaca 把 SEC / TAF / 佣金记成独立活动），所以 fee = 0 并如实注明。
 * maker / taker：活动行不给流动性方向，一律按 'taker' 记（费率侧偏高的一侧，不低报费用）。
 */
export function parseActivityFill(payload: unknown, ctx: { now: Ms; instrumentOf?: (symbol: string) => string }): ParsedFill {
  if (!isRecord(payload)) throw new TypeError('alpaca activity row is not an object')
  const id = str(payload['id'])
  const symbol = str(payload['symbol']).toUpperCase()
  const qty = str(payload['qty'])
  const price = str(payload['price'])
  const cumQty = str(payload['cum_qty'])
  if (id === '') throw new TypeError('alpaca FILL activity has no id')
  if (symbol === '') throw new TypeError(`alpaca FILL activity ${id} has no symbol`)
  if (qty === '' || price === '') throw new TypeError(`alpaca FILL activity ${id} has no qty / price`)
  if (cumQty === '') throw new TypeError(`alpaca FILL activity ${id} has no cum_qty (it is part of the dedupe key)`)
  const sideRaw = str(payload['side']).toLowerCase()
  const side = sideRaw === 'sell' ? 'sell' : 'buy'
  const ts = msOf(str(payload['transaction_time']) || str(payload['at']) || str(payload['date']), ctx.now)
  const executionId = str(payload['execution_id']) === '' ? null : str(payload['execution_id'])
  const venueOrderId = str(payload['order_id'])
  if (venueOrderId === '') throw new TypeError(`alpaca FILL activity ${id} has no order_id (it is part of the dedupe key)`)
  const instrumentId = ctx.instrumentOf !== undefined ? ctx.instrumentOf(symbol) : `${VENUE}:${symbol}`
  const fill: VenueFill = {
    venueFillId: `${venueOrderId}:${normalizeDecimal(cumQty)}`,
    venueOrderId,
    clientOrderId: null,
    instrumentId,
    side,
    price: dec(price),
    size: dec(absText(qty)),
    fee: dec('0'),
    feeCcy: 'USD',
    liquidity: 'taker',
    realizedPnl: dec('0'),
    ts,
  }
  return { fill, activityId: id, executionId, activityType: str(payload['activity_type']).toUpperCase() }
}

/** 活动列表 → 成交（按跨源一致的 venueFillId 去重；坏行抛，不静默丢成交）。 */
export function parseActivityFills(payload: unknown, ctx: { now: Ms; instrumentOf?: (symbol: string) => string }): ParsedFill[] {
  if (!Array.isArray(payload)) throw new TypeError('alpaca activities response is not an array')
  const out = new Map<string, ParsedFill>()
  for (const raw of payload) {
    const parsed = parseActivityFill(raw, ctx)
    out.set(parsed.fill.venueFillId, parsed)
  }
  return [...out.values()].sort((a, b) => a.fill.ts - b.fill.ts)
}

/**
 * 成交去重键：REST 活动行与私有流 fill 事件都返回同一个键。
 * 官方未说明活动 id 与 execution_id 的对应关系，故用 order_id + 累计成交量：
 * REST = 活动行的 `order_id` + `cum_qty`；流 = `data.order.id` + `data.order.filled_qty`。
 */
export function fillDedupeKey(ids: { venueOrderId?: string; cumQty?: string }): string {
  if (ids.venueOrderId === undefined || ids.venueOrderId === '') throw new TypeError('fill dedupe needs an order id')
  if (ids.cumQty === undefined || ids.cumQty === '') throw new TypeError('fill dedupe needs the cumulative filled quantity')
  return `${ids.venueOrderId}:${normalizeDecimal(ids.cumQty)}`
}

// ───────────── 全撤结果 ─────────────

export interface CancelResultRow { id: string; ok: boolean; status: number }

/** `DELETE /v2/orders` 的 207 批量结果：[{id, status}]，status 200 = 撤成功。 */
export function parseCancelAllResults(payload: unknown): CancelResultRow[] {
  if (payload === undefined || payload === null) return []
  if (!Array.isArray(payload)) throw new TypeError('alpaca cancel-all response is not an array')
  const out: CancelResultRow[] = []
  for (const raw of payload) {
    if (!isRecord(raw)) continue
    const id = str(raw['id'])
    if (id === '') continue
    const status = numOr(raw['status'], 0)
    out.push({ id, ok: status === 200 || status === 204, status })
  }
  return out
}
