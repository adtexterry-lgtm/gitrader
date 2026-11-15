// SPDX-License-Identifier: Apache-2.0
// 契约 §1.4.5 OrderIntent、§1.4.6 Order、§1.4.7 Fill、§1.4.8 Position / FundingPayment。
import type { Decimal, Ms } from './decimal'
import type { AccountId, ClientOrderId, FillId, FundingId, InstrumentId, MandateId, OrderId, PrecheckId, ProposalId } from './ids'
import type { MarginMode, OrderType, TimeInForce, TriggerPriceType } from './instrument'
import type { Origin } from './origin'
import type { Problem } from './problem'
import type { ReconcilePriceSource } from './execution-reconcile'

export const ORDER_SIDES = ['buy', 'sell'] as const
export type Side = (typeof ORDER_SIDES)[number]
export const TPSL_ROLES = ['tp', 'sl'] as const
export type TpSlRole = (typeof TPSL_ROLES)[number]
export const POSITION_SIDES = ['long', 'short'] as const
export type PositionSide = (typeof POSITION_SIDES)[number]
export const ORDER_ADJUST_FIELDS = ['size', 'leverage', 'maxSlippageBps'] as const
export type OrderAdjustField = (typeof ORDER_ADJUST_FIELDS)[number]

export interface TpSlLeg { triggerPrice: Decimal; price?: Decimal }

export interface OrderIntent {
  accountId: AccountId
  instrumentId: InstrumentId
  side: Side
  type: OrderType
  /** size 与 notional 二选一；都给以 size 为准。数量为基础资产单位。 */
  size?: Decimal
  notional?: Decimal
  /** 限价类必填。 */
  price?: Decimal
  /** 触发类必填。 */
  triggerPrice?: Decimal
  triggerType?: TriggerPriceType
  /** 缺省 gtc。 */
  tif?: TimeInForce
  reduceOnly?: boolean
  postOnly?: boolean
  leverage?: number
  marginMode?: MarginMode
  /** 市价类必填；缺省取风控策略的 maxSlippageBps。 */
  maxSlippageBps?: number
  tpsl?: { takeProfit?: TpSlLeg; stopLoss?: TpSlLeg; grouping: 'order' | 'position' }
  expiresAt?: Ms
  /** 缺省由内核生成；调用方可预先指定以做幂等。 */
  clientOrderId?: ClientOrderId
  /** 缺省 reject；passive = 买单向下、卖单向上取整。 */
  rounding?: 'reject' | 'passive'
  allowAdjust?: OrderAdjustField[]
  /** 非人类行为人必填，1–2,000 字。 */
  reason?: string
  /** v0.1.3：归属的子仓位（引擎侧的虚拟账，内核只透传并写进账本）。 */
  legId?: string
  /** v0.1.3：出场计划 id（多级止盈 / 止损 / 时间出场共享）。 */
  exitPlanId?: string
  /** v0.1.3：同组一笔成交其余自动撤（OCO）；是否由场所原生实现看能力声明。 */
  ocoGroupId?: string
  /** 仅 trailing_stop 有意义；callbackRatio 为大于 0 的比例字符串（如 '0.02'）；activationPrice 优先于 activationRatio。 */
  trailing?: { callbackRatio: Decimal; activationPrice?: Decimal; activationRatio?: Decimal }
}

export const ORDER_STATUSES = [
  'new', 'submitted', 'open', 'untriggered', 'partially_filled', 'filled', 'cancelled', 'expired', 'rejected', 'denied',
] as const
export type OrderStatus = (typeof ORDER_STATUSES)[number]

export interface Order {
  orderId: OrderId
  clientOrderId: ClientOrderId
  venueOrderId?: string | null
  accountId: AccountId
  instrumentId: InstrumentId
  side: Side
  type: OrderType
  tif: TimeInForce
  size: Decimal
  filledSize: Decimal
  price?: Decimal | null
  triggerPrice?: Decimal | null
  avgFillPrice?: Decimal | null
  reduceOnly?: boolean
  postOnly?: boolean
  leverage?: number
  /** denied = 内核风控 / 授权书拒绝；rejected = 场所拒绝。 */
  status: OrderStatus
  /** denied / rejected 时必填。 */
  problem?: Problem
  /** 累计费用：正 = 付出，负 = 返佣。 */
  fee: Decimal
  builder?: { attached: boolean; feeTenthBps?: number }
  parentOrderId?: OrderId
  tpslRole?: TpSlRole
  proposalId?: ProposalId
  mandateId?: MandateId
  precheckId?: PrecheckId
  /** v0.1.3：子仓位 / 出场计划 / OCO 组（来自 OrderIntent）。 */
  legId?: string
  exitPlanId?: string
  ocoGroupId?: string
  origin: Origin
  createdAt: Ms
  updatedAt: Ms
  submittedAt?: Ms
  closedAt?: Ms
  /** OrderIntent.trailing 的只读镜像，采用相同的激活优先级。 */
  readonly trailing?: Readonly<NonNullable<OrderIntent['trailing']>>
}

export interface Fill {
  fillId: FillId
  orderId: OrderId
  clientOrderId: ClientOrderId
  /** 用于去重与对账。 */
  venueFillId: string
  accountId: AccountId
  instrumentId: InstrumentId
  side: Side
  price: Decimal
  size: Decimal
  fee: Decimal
  feeCcy: string
  builderFee?: Decimal
  liquidity: 'maker' | 'taker'
  /** 现金流符号。 */
  realizedPnl: Decimal
  /** 强平 / ADL 成交，origin.actor = venue:<venue>。 */
  liquidation?: boolean
  /** v0.1.3：成交归属的子仓位（继承自订单）。 */
  legId?: string
  exitPlanId?: string
  ts: Ms
  inferred?: {
    suggestionId: string
    reportId: string
    confirmedAt: Ms
    confirmedBy: string
    priceSource: ReconcilePriceSource
    basisDigest: string
  }
}

/** v0.1.3：持仓里的子仓位归因视图。其 size 之和必须等于 Position.size（可作为 reconciliation 的一项）；场所真实持仓仍是聚合的。 */
export interface PositionLeg {
  legId: string
  exitPlanId?: string
  size: Decimal
  entryPrice?: Decimal
}

export interface Position {
  accountId: AccountId
  instrumentId: InstrumentId
  side: PositionSide
  /** 正数。 */
  size: Decimal
  entryPrice: Decimal
  markPrice: Decimal
  /** 标记价对应的最近一次有效场所报价时间；未知时省略。 */
  markTs?: Ms
  notional: Decimal
  unrealizedPnl: Decimal
  realizedPnl: Decimal
  leverage: number
  marginMode: MarginMode
  initialMargin?: Decimal
  maintenanceMargin?: Decimal
  liquidationPrice: Decimal | null
  /** 纸面账户的强平价为近似值。 */
  estimated?: boolean
  /** 现金流符号（正 = 收到）。 */
  fundingSinceOpen: Decimal
  openedAt: Ms
  updatedAt: Ms
  /** v0.1.3：子仓位归因（可选）。 */
  legs?: PositionLeg[]
}

export interface FundingPayment {
  fundingId: FundingId
  accountId: AccountId
  instrumentId: InstrumentId
  ts: Ms
  /** 费率（分数）。 */
  rate: Decimal
  intervalMs: Ms
  /** 多正空负。 */
  positionSize: Decimal
  /** 现金流符号。 */
  amount: Decimal
  asset: string
  venueRef?: string
}
