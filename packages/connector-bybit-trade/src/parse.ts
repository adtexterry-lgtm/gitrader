// SPDX-License-Identifier: CPAL-1.0
// Bybit v5 私有 REST / 私有 WebSocket 响应 → 统一模型（纯函数，无状态；不发请求、不读环境）。
// 只读行情那半边（合约清单 / K 线 / 报价 / 盘口）复用 packages/connector-bybit-data 的解析与连接器，
// 本文件只处理私有侧：账户、持仓、订单、成交、私有流事件。
// 口径来源：
//   QD live_trading/bybit.py:494-495（wallet-balance）、:763-808（realtime / execution list）、
//   :924-947（position/list）、execution_streams/normalizers.py:131-182（parse_bybit）。
// 数量单位一律「标的币数量」（venueSizeUnit = base）：size / cumExecQty / execQty 都是币数，不做张数换算。
// 三处必须守住的细节（执行层教训 10）：
//   1) venueFillId 包含已归一的 symbol 与 execId；去重键仍为场所 + venueFillId；解析永不合成「近似 id」；
//   2) 执行类型（execType）原样保留：只有 Funding 是资金费，其余（Trade / AdlTrade / BustTrade / Delivery）都进 fills；
//   3) 平仓行（closedSize > 0 / leavesQty == 0）不因「仓位归零」被丢掉 —— 它是账本平仓的唯一凭据。
import { asDecimal, normalizeDecimal } from '@gitrader/protocol'
import type { AccountId, Decimal, MarginSnapshot, Ms, Position } from '@gitrader/protocol'
import { addDec, cmpDec, div, fx, mul, mulDec, str, subDec } from '@gitrader/protocol/decimal'
import type { AccountSnapshot, VenueFill, VenueOpenOrder, VenueOrderStatus } from '@gitrader/protocol/connector'
import { instrumentIdOf, symbolOf } from '@gitrader/connector-bybit-data'

export const VENUE = 'bybit'
export { instrumentIdOf, symbolOf }

/** 本连接器实际发出的协议订单类型（twap 不声明、trailing_stop 走 positions/trading-stop，见 capabilities）。 */
export const SUPPORTED_ORDER_TYPES = ['market', 'limit', 'stop_market', 'stop_limit', 'take_market', 'take_limit'] as const
export const SUPPORTED_TIF = ['gtc', 'ioc', 'fok', 'alo'] as const
export const SUPPORTED_TRIGGER_TYPES = ['mark', 'last'] as const

/** Bybit v5 orderStatus → 协议口径（新增值先按 unknown 处理，不猜）。 */
export const ORDER_STATUS_MAP: Record<string, 'open' | 'partially_filled' | 'filled' | 'cancelled' | 'rejected' | 'untriggered' | 'expired'> = {
  Created: 'open',
  New: 'open',
  Active: 'open',
  Triggered: 'open',
  PartiallyFilled: 'partially_filled',
  PartiallyFilledCanceled: 'cancelled',
  Filled: 'filled',
  Cancelled: 'cancelled',
  Deactivated: 'cancelled',
  Rejected: 'rejected',
  Untriggered: 'untriggered',
}

/** Bybit 的交易对 id 就是 symbol 本身（大小写不敏感的上游口径），本地一律大写。 */
export const upper = (s: string): string => s.trim().toUpperCase()

/**
 * 上游字段 → 文本。对象 / 数组 / 符号一律当缺失：`String({...})` 会回显 "[object Object]"，
 * 而带坏 `toString` 的对象（JSON 里 `{"toString":0}` 就够）会让 `String()` 直接抛 TypeError，
 * 把一个畸形字段升级成解析崩溃。数字与布尔照旧转文本。
 */
export const textOf = (v: unknown): string => {
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return ''
}

/** 宽松十进制文本 → Decimal；非法 / 空串回落 '0'（Bybit 用空串表示「没有值」）。 */
export function decimalOf(v: unknown): Decimal {
  if (typeof v === 'number') return Number.isFinite(v) ? asDecimal(String(v)) : asDecimal('0')
  if (typeof v !== 'string' || v.trim() === '') return asDecimal('0')
  try {
    return normalizeDecimal(v.trim())
  } catch {
    return asDecimal('0')
  }
}

/** 绝对值（定点，不碰浮点）。 */
export function absDecimal(v: unknown): Decimal {
  const d = decimalOf(v)
  return cmpDec(d, '0') < 0 ? subDec('0', d) : d
}

/** Bybit 有些字段是 number，有些是字符串；空串必须当缺失（Number('') === 0 是坑）。 */
export const num = (v: unknown): number => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN
  if (typeof v !== 'string') return NaN
  const s = v.trim()
  if (s === '') return NaN
  const n = Number(s)
  return Number.isFinite(n) ? n : NaN
}

/** 剩余量 = 委托量 − 已成交量（定点减法，不走浮点）。 */
export function remainingOf(qty: unknown, cumExecQty: unknown): Decimal {
  const total = decimalOf(qty)
  const done = decimalOf(cumExecQty)
  return cmpDec(done, '0') <= 0 ? total : subDec(total, done)
}

/** 成交去重键：场所 + 已包含标的命名空间的 venueFillId（执行层唯一稳定的去重口径）。 */
export function fillDedupeKey(fill: { venueFillId: string }): string {
  return `${VENUE}|${fill.venueFillId}`
}

// ---- 账户 -------------------------------------------------------------------

export interface RawCoin {
  coin?: string
  equity?: string
  usdValue?: string
  walletBalance?: string
  availableToWithdraw?: string
  locked?: string
  unrealisedPnl?: string
}

export interface RawWallet {
  accountType?: string
  totalEquity?: string
  totalWalletBalance?: string
  totalMarginBalance?: string
  totalInitialMargin?: string
  totalMaintenanceMargin?: string
  /** 统一账户的「可用余额」是这一项（不是 coin[].availableToWithdraw，那是逐币可提）。 */
  totalAvailableBalance?: string
  totalPerpUpl?: string
  coin?: RawCoin[]
}

export interface RawWalletPage {
  list?: RawWallet[]
}

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/live_trading/bybit.py:494-495; adapted.
/**
 * /v5/account/wallet-balance 的 result.list[0] → AccountSnapshot（只有余额与保证金；持仓由 /v5/position/list 单独取）。
 * available 用 `totalAvailableBalance`：统一账户里它才是「还能开新仓」的口径。
 */
export function parseAccountSnapshot(
  raw: RawWallet | null | undefined,
  accountId: AccountId,
  now: Ms,
  accountModel: 'standard' | 'unified' | 'portfolio' = 'unified',
): AccountSnapshot {
  const coins = Array.isArray(raw?.coin) ? raw.coin : []
  const balances = coins.flatMap((c) => {
    // coin[] 里的空元素 / 非对象元素当缺失，不把解析炸掉
    if (c === null || typeof c !== 'object') return []
    const asset = typeof c.coin === 'string' ? c.coin.trim().toUpperCase() : ''
    if (asset === '') return []
    const total = decimalOf(c.walletBalance ?? c.equity)
    const available = decimalOf(c.availableToWithdraw ?? c.walletBalance)
    const hold = cmpDec(total, available) > 0 ? subDec(total, available) : asDecimal('0')
    return [{ accountId, asset, total, available, hold, ts: now }]
  })
  const equity = decimalOf(raw?.totalEquity ?? raw?.totalMarginBalance ?? raw?.totalWalletBalance)
  const maintenanceMargin = decimalOf(raw?.totalMaintenanceMargin)
  const ratio = Number(equity) > 0 ? (Number(maintenanceMargin) / Number(equity)).toFixed(8) : '0'
  const margin: MarginSnapshot = {
    accountId,
    model: accountModel,
    valuationCcy: 'USDT',
    equity,
    initialMargin: decimalOf(raw?.totalInitialMargin),
    maintenanceMargin,
    available: decimalOf(raw?.totalAvailableBalance),
    marginRatio: decimalOf(ratio),
    leverage: 0,
    ts: now,
  }
  return { accountModel, balances, margin, positions: [], ts: now, source: 'rest', availableDeductsOpenOrders: true }
}

// ---- 持仓 -------------------------------------------------------------------

export interface RawPosition {
  symbol?: string
  category?: string
  side?: string
  size?: string
  avgPrice?: string
  markPrice?: string
  liqPrice?: string
  leverage?: string
  positionValue?: string
  unrealisedPnl?: string
  cumRealisedPnl?: string
  positionIdx?: number
  tradeMode?: number
  createdTime?: string | number
  updatedTime?: string | number
  stopLoss?: string
  takeProfit?: string
  trailingStop?: string
}

export interface RawPositionPage {
  list?: RawPosition[]
  nextPageCursor?: string
}

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/live_trading/bybit.py:924-947; adapted.
/** /v5/position/list 一行 → Position（size = 0 的槽位跳过；side Buy = long / Sell = short）。 */
export function parsePosition(row: RawPosition, accountId: AccountId, now: Ms): Position | null {
  const symbol = typeof row.symbol === 'string' ? upper(row.symbol) : ''
  if (symbol === '') return null
  const size = absDecimal(row.size)
  if (cmpDec(size, '0') === 0) return null
  const side = typeof row.side === 'string' ? row.side.trim().toLowerCase() : ''
  const short = side === 'sell' || (side === '' && cmpDec(decimalOf(row.size), '0') < 0)
  const markPrice = decimalOf(row.markPrice)
  const notional = typeof row.positionValue === 'string' && row.positionValue.trim() !== ''
    ? absDecimal(row.positionValue)
    : absDecimal(mulDec(size, markPrice))
  const opened = num(row.createdTime)
  const updated = num(row.updatedTime)
  return {
    accountId,
    instrumentId: instrumentIdOf(symbol),
    side: short ? 'short' : 'long',
    size,
    entryPrice: decimalOf(row.avgPrice),
    markPrice,
    notional,
    unrealizedPnl: decimalOf(row.unrealisedPnl),
    realizedPnl: decimalOf(row.cumRealisedPnl),
    leverage: Math.max(1, Math.round(num(row.leverage) || 1)),
    marginMode: row.tradeMode === 1 ? 'isolated' : 'cross',
    liquidationPrice: num(row.liqPrice) > 0 ? decimalOf(row.liqPrice) : null,
    fundingSinceOpen: asDecimal('0'),
    openedAt: Number.isFinite(opened) && opened > 0 ? Math.round(opened) : now,
    updatedAt: Number.isFinite(updated) && updated > 0 ? Math.round(updated) : now,
  }
}

export function parsePositions(raw: unknown, accountId: AccountId, now: Ms): Position[] {
  const page = (raw ?? {}) as RawPositionPage
  if (!Array.isArray(page.list)) return []
  const out: Position[] = []
  for (const row of page.list) {
    if (!row || typeof row !== 'object') continue
    const parsed = parsePosition(row, accountId, now)
    if (parsed) out.push(parsed)
  }
  return out
}

// ---- 订单 -------------------------------------------------------------------

export interface RawOrder {
  orderId?: string
  orderLinkId?: string
  symbol?: string
  category?: string
  side?: string
  orderType?: string
  orderStatus?: string
  price?: string
  qty?: string
  cumExecQty?: string
  avgPrice?: string
  timeInForce?: string
  reduceOnly?: boolean
  closeOnTrigger?: boolean
  triggerPrice?: string
  triggerBy?: string
  triggerDirection?: number
  orderFilter?: string
  positionIdx?: number
  cumExecFee?: string
  createdTime?: string | number
  updatedTime?: string | number
  stopOrderType?: string
  takeProfit?: string
  stopLoss?: string
}

export interface RawOrderPage {
  list?: RawOrder[]
  nextPageCursor?: string
}

/** Bybit orderType + 触发价 → 协议订单类型（触发的 stop/take 用 triggerDirection 反推，与本包的构造规则互逆）。 */
export function mapOpenOrderType(orderType: unknown, hasTrigger: boolean, side: unknown, triggerDirection: unknown): VenueOpenOrder['type'] {
  const limit = textOf(orderType).trim().toLowerCase() === 'limit'
  if (!hasTrigger) return limit ? 'limit' : 'unknown'
  const sell = textOf(side).trim().toLowerCase() === 'sell'
  const dir = Number(triggerDirection)
  // 卖出 + 涨破触发（1）= 止盈；卖出 + 跌破（2）= 止损；买入相反。
  const take = sell ? dir === 1 : dir === 2
  if (take) return limit ? 'take_limit' : 'take_market'
  return limit ? 'stop_limit' : 'stop_market'
}

/** /v5/order/realtime 一行 → VenueOpenOrder（剩余量按 qty − cumExecQty 算）。 */
export function parseOpenOrder(row: RawOrder): VenueOpenOrder | null {
  const symbol = typeof row.symbol === 'string' ? upper(row.symbol) : ''
  if (symbol === '') return null
  const orderId = textOf(row.orderId)
  if (orderId === '') return null
  const trigger = num(row.triggerPrice)
  const hasTrigger = Number.isFinite(trigger) && trigger > 0
  const price = num(row.price)
  const type = mapOpenOrderType(row.orderType, hasTrigger, row.side, row.triggerDirection)
  const created = num(row.createdTime)
  return {
    instrumentId: instrumentIdOf(symbol),
    venueOrderId: orderId,
    clientOrderId: typeof row.orderLinkId === 'string' && row.orderLinkId !== '' ? row.orderLinkId : null,
    side: textOf(row.side).trim().toLowerCase() === 'sell' ? 'sell' : 'buy',
    type,
    price: Number.isFinite(price) && price > 0 ? decimalOf(row.price) : null,
    triggerPrice: hasTrigger ? decimalOf(row.triggerPrice) : null,
    size: remainingOf(row.qty, row.cumExecQty),
    origSize: decimalOf(row.qty),
    reduceOnly: row.reduceOnly === true || row.closeOnTrigger === true,
    isTrigger: hasTrigger || textOf(row.orderFilter).toLowerCase() === 'stoporder',
    createdAt: Number.isFinite(created) && created > 0 ? Math.round(created) : 0,
  }
}

/** 单张订单状态（原样返回上游 orderStatus 字符串，不翻译）。 */
export function parseOrderStatusResult(row: RawOrder | null | undefined): VenueOrderStatus {
  if (!row || typeof row !== 'object' || row.orderId === undefined) return { found: false }
  const status = typeof row.orderStatus === 'string' ? row.orderStatus : undefined
  return {
    found: true,
    ...(status !== undefined ? { status } : {}),
    venueOrderId: textOf(row.orderId),
    ...(row.cumExecQty !== undefined ? { filledSize: decimalOf(row.cumExecQty) } : {}),
    raw: row,
  }
}

// ---- 成交 -------------------------------------------------------------------

export interface RawExecution {
  execId?: string
  orderId?: string
  orderLinkId?: string
  symbol?: string
  side?: string
  execPrice?: string
  execQty?: string
  execFee?: string
  feeRate?: string
  feeCurrency?: string
  execType?: string
  execPnl?: string
  execTime?: string | number
  isMaker?: boolean
  closedSize?: string
  leavesQty?: string
  category?: string
  extraFees?: Array<{ feeCoin?: string; fee?: string }>
}

export interface RawExecutionPage {
  list?: RawExecution[]
  nextPageCursor?: string
}

/** 只有 Funding 是资金费；Trade / AdlTrade / BustTrade / Delivery 都改变仓位，按成交处理。 */
export function isTradeExecution(row: RawExecution): boolean {
  const type = typeof row.execType === 'string' ? row.execType.trim().toLowerCase() : ''
  return type !== 'funding'
}

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/execution_streams/normalizers.py:131-182; adapted.
/**
 * /v5/execution/list 一行 → VenueFill。
 * venueFillId 包含已归一 symbol 与原始 execId；保留 execType 语义（只有 Funding 被排除）、平仓行（closedSize > 0 的成交不因仓位归零被丢）。
 * BustTrade / AdlTrade 是强平 / 自动减仓成交，额外标 `liquidation: true`。
 * 费用按 QD 口径：execFee + extraFees[].fee 相加，币种取 feeCurrency（缺省 USDT）。
 */
export function parseExecution(row: RawExecution, now: Ms): VenueFill | null {
  const symbol = typeof row.symbol === 'string' ? upper(row.symbol) : ''
  if (symbol === '') return null
  if (!isTradeExecution(row)) return null
  const qty = decimalOf(row.execQty)
  if (cmpDec(qty, '0') <= 0) return null
  const execId = typeof row.execId === 'string' && row.execId !== '' ? row.execId : ''
  if (execId === '') return null
  let fee = decimalOf(row.execFee)
  const extra = Array.isArray(row.extraFees) ? row.extraFees : []
  for (const part of extra) {
    if (!part || typeof part !== 'object') continue
    fee = addDec(fee, decimalOf(part.fee))
  }
  const ts = num(row.execTime)
  const side = textOf(row.side).trim().toLowerCase() === 'sell' ? 'sell' : 'buy'
  const execType = typeof row.execType === 'string' ? row.execType.trim().toLowerCase() : ''
  const liquidation = execType === 'busttrade' || execType === 'adltrade'
  return {
    venueFillId: `${symbol}:${execId}`,
    venueOrderId: textOf(row.orderId),
    clientOrderId: typeof row.orderLinkId === 'string' && row.orderLinkId !== '' ? row.orderLinkId : null,
    instrumentId: instrumentIdOf(symbol),
    side,
    price: decimalOf(row.execPrice),
    size: qty,
    fee,
    feeCcy: typeof row.feeCurrency === 'string' && row.feeCurrency.trim() !== '' ? upper(row.feeCurrency) : 'USDT',
    liquidity: row.isMaker === true ? 'maker' : 'taker',
    realizedPnl: decimalOf(row.execPnl),
    ts: Number.isFinite(ts) && ts > 0 ? Math.round(ts) : now,
    ...(liquidation ? { liquidation: true } : {}),
  }
}

export function parseExecutions(raw: unknown, now: Ms): VenueFill[] {
  const page = (raw ?? {}) as RawExecutionPage
  if (!Array.isArray(page.list)) return []
  const out: VenueFill[] = []
  for (const row of page.list) {
    if (!row || typeof row !== 'object') continue
    const parsed = parseExecution(row, now)
    if (parsed) out.push(parsed)
  }
  return out
}

// ---- 私有 WebSocket 归一 ----------------------------------------------------

export interface BybitPrivateFill extends VenueFill {
  /** 上游 execType 原样（Trade / Funding / AdlTrade …）。 */
  execType: string
  /** 这次成交是否平掉了一部分仓位（closedSize > 0）——含把仓位平到 0 的那一行。 */
  closing: boolean
}

export type BybitPrivateEvent =
  | { kind: 'fill'; fill: BybitPrivateFill }
  | {
      kind: 'order'
      update: { venueOrderId: string; clientOrderId: string | null; instrumentId: string; status: string; ts: Ms }
    }
  | { kind: 'position'; instrumentId: string; side: 'long' | 'short'; size: Decimal; ts: Ms }
  | { kind: 'wallet'; accountType: string; ts: Ms }
  | { kind: 'pong' }
  | { kind: 'subscribed'; topic: string; success: boolean }
  | { kind: 'unknown'; topic: string; raw: unknown }

/**
 * 私有流一帧（{"topic":"execution","data":[...]}）→ 归一事件。
 * 三条不许丢的字段：含 symbol 的 venueFillId、execType（成交类型）、closedSize > 0 的平仓行（含仓位归零那行）。
 */
export function parsePrivateMessage(payload: unknown, now: Ms): BybitPrivateEvent[] {
  if (!payload || typeof payload !== 'object') return []
  const msg = payload as { topic?: string; data?: unknown; op?: string; success?: boolean; ret_msg?: string }
  if (typeof msg.op === 'string') {
    if (msg.op === 'pong') return [{ kind: 'pong' }]
    if (msg.op === 'subscribe' || msg.op === 'auth') {
      return [{ kind: 'subscribed', topic: msg.op, success: msg.success !== false }]
    }
    return [{ kind: 'unknown', topic: msg.op, raw: payload }]
  }
  const topic = typeof msg.topic === 'string' ? msg.topic : ''
  const rows = Array.isArray(msg.data) ? msg.data : []
  const linearOnly = (category: unknown): boolean =>
    typeof category !== 'string' || category.trim() === '' || category.trim().toLowerCase() === 'linear'
  if (topic.startsWith('execution')) {
    const out: BybitPrivateEvent[] = []
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue
      const exec = row as RawExecution
      if (!linearOnly(exec.category)) continue
      const execType = typeof exec.execType === 'string' && exec.execType !== '' ? exec.execType : 'Trade'
      const base = parseExecution(exec, now)
      // Funding 是资金费，保留为 unknown；Trade / AdlTrade / BustTrade / Delivery 都是成交。
      if (!base) {
        out.push({ kind: 'unknown', topic, raw: row })
        continue
      }
      const closing = num(exec.closedSize) > 0
      out.push({ kind: 'fill', fill: { ...base, execType, closing } })
    }
    return out
  }
  if (topic.startsWith('order')) {
    const out: BybitPrivateEvent[] = []
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue
      const order = row as RawOrder
      if (!linearOnly(order.category)) continue
      const symbol = typeof order.symbol === 'string' ? upper(order.symbol) : ''
      if (symbol === '' || order.orderId === undefined) continue
      const ts = num(order.updatedTime ?? order.createdTime)
      out.push({
        kind: 'order',
        update: {
          venueOrderId: String(order.orderId),
          clientOrderId: typeof order.orderLinkId === 'string' && order.orderLinkId !== '' ? order.orderLinkId : null,
          instrumentId: instrumentIdOf(symbol),
          status: String(order.orderStatus ?? ''),
          ts: Number.isFinite(ts) && ts > 0 ? Math.round(ts) : now,
        },
      })
    }
    return out
  }
  if (topic.startsWith('position')) {
    const out: BybitPrivateEvent[] = []
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue
      const pos = row as RawPosition
      if (!linearOnly(pos.category)) continue
      const symbol = typeof pos.symbol === 'string' ? upper(pos.symbol) : ''
      if (symbol === '') continue
      const ts = num(pos.updatedTime)
      out.push({
        kind: 'position',
        instrumentId: instrumentIdOf(symbol),
        side: String(pos.side ?? '').trim().toLowerCase() === 'sell' ? 'short' : 'long',
        size: absDecimal(pos.size),
        ts: Number.isFinite(ts) && ts > 0 ? Math.round(ts) : now,
      })
    }
    return out
  }
  if (topic.startsWith('wallet')) {
    const first = rows[0] as { accountType?: string } | undefined
    return [{ kind: 'wallet', accountType: String(first?.accountType ?? ''), ts: now }]
  }
  return [{ kind: 'unknown', topic, raw: payload }]
}

/** 加权均价（成交价 × 量 / 总量，全定点）；总量 0 返回 null。 */
export function vwapOf(fills: ReadonlyArray<{ price: string; size: string }>): Decimal | null {
  let notional = fx('0')
  let qty = fx('0')
  for (const f of fills) {
    notional = notional + mul(fx(f.price), fx(f.size))
    qty = qty + fx(f.size)
  }
  if (qty <= 0n) return null
  return asDecimal(str(div(notional, qty)))
}
