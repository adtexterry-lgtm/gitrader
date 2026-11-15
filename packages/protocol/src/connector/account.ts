// SPDX-License-Identifier: Apache-2.0
// 连接器接口 · 账户读取与启动对账（契约 §6.4 启动对账、§1.4.9 账户模式感知）。
import type { Decimal, Ms } from '../model/decimal'
import type { ClientOrderId, InstrumentId } from '../model/ids'
import type { Balance, MarginSnapshot } from '../model/account'
import type { Position } from '../model/order'
import type { VenueRules } from '../model/risk'
import type { VenueFill } from './trade'

/** v0.1.7：快照数据的来源。ws = 用户流增量维护；rest = 轮询兜底；replay = 回放；fixture = 夹具。 */
export const ACCOUNT_SNAPSHOT_SOURCES = ['ws', 'rest', 'replay', 'fixture'] as const
export type AccountSnapshotSource = (typeof ACCOUNT_SNAPSHOT_SOURCES)[number]

/** 连接器读到的账户快照（与 GEP 的 AccountSnapshot 不同：没有 openOrders / attestation，带 accountModel）。 */
export interface AccountSnapshot {
  accountModel: 'standard' | 'unified' | 'portfolio'
  balances: Balance[]
  margin: MarginSnapshot
  positions: Position[]
  ts: Ms
  /**
   * v0.1.7（可选）：这份账户数据最后一次推送的时刻（ms）；账户没动静时 WS 不推，所以它可以比 now 老很多。
   * 有 confirmedAt 时按 now - confirmedAt 阈值判定；缺失时只看 stale，不以 asOf 年龄拒绝。
   */
  asOf?: Ms
  /** 最后一次确认账户视图仍新鲜的时刻（ms）；缺失时只按 stale 判断，不回退到 asOf。 */
  confirmedAt?: Ms
  /** v0.1.7（可选）：true = 现在不能当实时数据用（WS 断了且 REST 兜底也过期，或还没拿到首批快照）。风控闸遇到 stale 的快照应按 failClosed 处理。 */
  stale?: boolean
  availableDeductsOpenOrders?: boolean
  openOrders?: Array<{ instrumentId: InstrumentId; side: 'buy' | 'sell'; notional: Decimal; count: number }>
  stopLossOrderIds?: string[]
  rules?: VenueRules
  /** v0.1.7（可选）：数据来源。 */
  source?: AccountSnapshotSource
}

/** 场所侧挂单（订阅 / 查询）。 */
export interface VenueOpenOrder {
  instrumentId: InstrumentId
  venueOrderId: string
  clientOrderId: ClientOrderId | null
  side: 'buy' | 'sell'
  type: 'limit' | 'stop_market' | 'stop_limit' | 'take_market' | 'take_limit' | 'unknown'
  price: Decimal | null
  triggerPrice: Decimal | null
  size: Decimal
  origSize: Decimal
  reduceOnly: boolean
  isTrigger: boolean
  createdAt: Ms
  /** fix-r2：子单所属父单的场所单号（纸面场所填写；其他连接器可不填）。 */
  parentVenueOrderId?: string
}

/** 内核启动对账：先拉场所未结订单、持仓、最近成交，与账本推算状态比对；不一致保持 HALTED 等人处理。 */
export interface StartupSnapshot {
  account: AccountSnapshot
  openOrders: VenueOpenOrder[]
  fills: VenueFill[]
  /** 回补的起点；fills 不超过 2000 条（官方上限），到上限时 truncated = true。 */
  fillsSince: Ms
  truncated: boolean
}

export interface VenueOrderStatus {
  found: boolean
  /** 上游原始状态字符串（open / filled / canceled / triggered / rejected / ...），不翻译。 */
  status?: string
  venueOrderId?: string
  filledSize?: Decimal
  avgFillPrice?: Decimal
  raw?: unknown
}
