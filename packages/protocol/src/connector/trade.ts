// SPDX-License-Identifier: Apache-2.0
// 连接器接口 · 交易（内核发起；连接器自己不会下单）。契约 §3.6：connector.submit / cancel / amend。
import type { Decimal, Ms } from '../model/decimal'
import type { AccountId, ClientOrderId, InstrumentId, PrecheckId } from '../model/ids'
import type { Fill, OrderIntent } from '../model/order'
import type { Problem } from '../model/problem'
import type { Hex, SignedEvent, SignerHandle } from './signer'

/** 账户引用。 */
export interface AccountRef {
  accountId: AccountId
  /** 主 / 子账户真实地址，查询用。不是 API 钱包地址（官方常见坑，传错会得到空结果）。 */
  address: Hex
  /** 子账户 / 金库：签名者仍是 API 钱包，下单时带 vaultAddress。 */
  vaultAddress?: Hex
  /** 缺省则探测。 */
  accountModel?: 'standard' | 'unified' | 'portfolio'
  /** 来自 Account.builder；只有 approved 才会附 builder。 */
  builder?: { status: 'approved' | 'not_approved' | 'unknown' }
}

export interface TradeContext {
  account: AccountRef
  signer: SignerHandle
  gate?: { precheckId: PrecheckId; ticketId: string; expiresAt: Ms }
  /** 每次签名回调一次（内核据此写 signer.signed）。 */
  onSigned?: (e: SignedEvent) => void
  /** 取消（例如调用窗口结束）。 */
  signal?: AbortSignal
}

/** unknown = 请求已发出但没拿到结果（契约 3006）：必须先按 clientOrderId 查状态，不得盲目重发。 */
export type AckStatus = 'open' | 'filled' | 'untriggered' | 'rejected' | 'unknown'

export interface OrderAck {
  /** 对应入参 intents 的下标（带止盈止损的一张意图会产生多条 ack，共用同一个下标）。 */
  intentIndex: number
  clientOrderId: ClientOrderId
  venueOrderId: string | null
  status: AckStatus
  /** 已成交数量（IOC / 市价类立即成交时 > 0）。 */
  filledSize: Decimal
  avgFillPrice: Decimal | null
  builder: { attached: boolean; feeTenthBps?: number }
  /** 父单与止盈止损子单的角色；单张订单不填。 */
  role?: 'parent' | 'tp' | 'sl'
  /** rejected 时必有；`venue.message` 是上游原话。 */
  problem?: Problem
}

export interface SubmitResult {
  acks: OrderAck[]
  /** 原始响应的 sha256（对账字段 receiptHash，契约 §6.4）。 */
  receiptHash: string
  requestWeight: number
}

export interface CancelTarget { instrumentId: InstrumentId; venueOrderId?: string; clientOrderId?: ClientOrderId }
export interface CancelAck { target: CancelTarget; ok: boolean; problem?: Problem }

export interface AmendRequest {
  instrumentId: InstrumentId
  venueOrderId?: string
  clientOrderId?: ClientOrderId
  /** 改后的完整订单（场所 modify 要求给全量）。 */
  order: OrderIntent
}

/** 场所成交（连接器不知道内核的 orderId / fillId，由内核补成 Fill）。 */
export type VenueFill = Omit<Fill, 'fillId' | 'orderId' | 'accountId' | 'clientOrderId'> & { venueOrderId: string; clientOrderId: ClientOrderId | null }
