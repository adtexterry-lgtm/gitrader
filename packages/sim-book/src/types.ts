// SPDX-License-Identifier: CPAL-1.0
// 本包的数据形状：三种 JSONL 记录、订单请求、订单回报。所有价格 / 数量都是十进制文本（见 num.ts）。
import type { Fx } from '@gitrader/protocol/decimal'

export type Side = 'buy' | 'sell'
export type BookSide = 'bid' | 'ask'
export type DeltaAction = 'add' | 'update' | 'delete' | 'clear'
export type OrderType = 'market' | 'limit' | 'stop_market' | 'stop_limit'
export type TimeInForce = 'gtc' | 'ioc' | 'fok'
export type LiquiditySide = 'maker' | 'taker'
export type AggressorSide = 'buy' | 'sell' | 'unknown'

/** 订单终态与工作态。accepted / partially_filled 且 resting=true 表示还有剩余挂在簿上。 */
export type OrderStatus = 'accepted' | 'partially_filled' | 'filled' | 'canceled' | 'rejected'

/** 非成交终态的原因码；成交的订单不带 reason。 */
export type OrderReason =
  | 'post_only_would_take'
  | 'fok_unfillable'
  | 'ioc_remainder_void'
  | 'insufficient_liquidity'
  | 'no_liquidity'
  | 'reduce_only_no_position'
  | 'duplicate_order_id'
  | 'unknown_order'
  | 'already_terminal'
  | 'invalid_order'

/** 档位在 JSONL 里写成二元组 [价格, 数量]，省掉重复的键名。 */
export type LevelTuple = [string, string]

export interface SnapshotRecord {
  type: 'book_snapshot'
  /** 事件时间（毫秒整数）。记录流上必须非递减。 */
  ts: number
  /** 可选序号：一旦出现，全流都必须有且非递减。 */
  seq?: number
  instrument: string
  bids: LevelTuple[]
  asks: LevelTuple[]
}

export interface DeltaRecord {
  type: 'book_delta'
  ts: number
  seq?: number
  instrument: string
  side: BookSide
  action: DeltaAction
  /** add / update / delete 必填；clear 不许带。 */
  price?: string
  /** add / update 必填且 > 0；delete / clear 不许带。 */
  size?: string
}

export interface TradeRecord {
  type: 'trade'
  ts: number
  seq?: number
  instrument: string
  price: string
  size: string
  aggressor?: AggressorSide
  tradeId?: string
}

export type MarketRecord = SnapshotRecord | DeltaRecord | TradeRecord

export interface OrderRequest {
  id: string
  side: Side
  type: OrderType
  qty: string
  /** 缺省 gtc。 */
  tif?: TimeInForce
  /** limit / stop_limit 必填。 */
  price?: string
  /** stop_market / stop_limit 必填。 */
  triggerPrice?: string
  /** 只许挂在簿上；下单即会吃单则整单拒绝。只约束入场，成交后不再检查。 */
  postOnly?: boolean
  /** 只许减仓；数量按传入持仓上限截断。 */
  reduceOnly?: boolean
}

/** 调用方传入的持仓视图（本包不维护持仓，只按它给减仓单定量）。 */
export interface PositionView {
  side: 'long' | 'short' | 'flat'
  qty: string
}

export interface SubmitContext {
  position?: PositionView
}

export interface FillReport {
  price: string
  qty: string
  liquidity: LiquiditySide
}

export interface OrderReport {
  orderId: string
  status: OrderStatus
  fills: FillReport[]
  filledQty: string
  remainingQty: string
  /** 成交量加权均价；无成交为 "0"。超出 18 位小数的部分向零截断。 */
  avgPrice: string
  /** 是否还有剩余挂在簿上（下单后可撤）。 */
  resting: boolean
  reason?: OrderReason
  /** 说明性备注（例如减仓单被截断到持仓量）。 */
  notes: string[]
  ts: number
}

/** 内部工作单：价格 / 数量已是定点值。 */
export interface WorkingFill {
  price: Fx
  qty: Fx
  liquidity: LiquiditySide
}

export interface WorkingOrder {
  readonly id: string
  readonly side: Side
  readonly type: OrderType
  readonly tif: TimeInForce
  readonly seq: number
  /** 改单（modify）要改写，故不是 readonly。 */
  price: Fx | null
  readonly triggerPrice: Fx | null
  readonly postOnly: boolean
  readonly reduceOnly: boolean
  /** 已按减仓上限截断后的数量。 */
  qty: Fx
  filled: Fx
  triggered: boolean
  status: OrderStatus
  reason: OrderReason | undefined
  fills: WorkingFill[]
  notes: string[]
  ts: number
}
