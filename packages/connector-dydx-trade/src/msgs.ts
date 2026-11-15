// SPDX-License-Identifier: CPAL-1.0
// dYdX v4 CLOB 消息编码（proto3 wire format，字段表照官方 proto 抄录）：
//   dydxprotocol/clob/order.proto：
//     OrderId      { subaccount_id = 1, client_id = 2 (fixed32!), order_flags = 3, clob_pair_id = 4 }
//     SubaccountId { owner = 1 (string), number = 2 }
//     Order        { order_id = 1, side = 2, quantums = 3, subticks = 4,
//                    oneof good_til_oneof { good_til_block = 5 (uint32) | good_til_block_time = 6 (fixed32!) },
//                    time_in_force = 7, reduce_only = 8, client_metadata = 9, condition_type = 10,
//                    conditional_order_trigger_subticks = 11, twap_parameters = 12, builder_code_parameters = 13,
//                    order_router_address = 14 }
//   dydxprotocol/clob/tx.proto：
//     MsgPlaceOrder  { order = 1 }
//     MsgCancelOrder { order_id = 1, oneof { good_til_block = 2 (uint32) | good_til_block_time = 3 (fixed32!) } }
//     MsgBatchCancel { subaccount_id = 1, short_term_cancels = 2 (repeated OrderBatch), good_til_block = 3 }
//     OrderBatch     { clob_pair_id = 1, client_ids = 2 (repeated uint32, packed) }
// 注意 good_til_block_time 是 fixed32（unix 秒），不是 google.protobuf.Timestamp 子消息。
// 设计参照（只借「一条消息 = 一个 Any」「短单带块高、长单带时间戳」的取值规则，代码从零写）：
//   nautilus_trader crates/adapters/dydx/src/execution/order_builder.rs@55c0e820。
import { CONDITION_TYPE, ORDER_FLAGS, ORDER_SIDE, ORDER_TIF, TYPE_URL } from './constants'
import { ProtoWriter } from './proto'

export interface OrderIdParts {
  owner: string
  subaccountNumber: number
  clientId: number
  clobPairId: number
  orderFlags: number
}

export interface OrderMessage {
  orderId: OrderIdParts
  side: 'buy' | 'sell'
  /** 基础资产的 quantums（整数，按 atomicResolution 放大）。 */
  quantums: number | bigint
  /** 价格的 subticks（整数）。 */
  subticks: number | bigint
  /** 短单：最后一个可用块高（与 goodTilBlockTime 互斥）。 */
  goodTilBlock?: number
  /** 长单 / 条件单：最后可用时间（unix 秒）。 */
  goodTilBlockTime?: number
  /** 'gtc' 对应 proto 的 UNSPECIFIED(0)，'ioc' = 1，'postOnly' = 2。 */
  tif: 'gtc' | 'ioc' | 'postOnly'
  reduceOnly: boolean
  /** 0–127 的客户端元数据。 */
  clientMetadata: number
  conditionType?: 'stopLoss' | 'takeProfit'
  conditionalTriggerSubticks?: number | bigint
  orderRouterAddress?: string
}

export function encodeSubaccountId(owner: string, number: number): Uint8Array {
  return new ProtoWriter().string(1, owner).uint64(2, number).finish()
}

export function encodeOrderId(p: OrderIdParts): Uint8Array {
  return new ProtoWriter()
    .bytes(1, encodeSubaccountId(p.owner, p.subaccountNumber))
    .fixed32(2, p.clientId)
    .uint64(3, p.orderFlags)
    .uint64(4, p.clobPairId)
    .finish()
}

/** good_til_block_time 是 fixed32：只能是 0..2^32-1 的 unix 秒。 */
function assertFixed32(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 0xffffffff) {
    throw new TypeError(`${field} must fit in a fixed32 (0..4294967295), got ${String(value)}`)
  }
  return value
}

export function encodeOrder(o: OrderMessage): Uint8Array {
  const flags = o.orderId.orderFlags
  const hasBlock = o.goodTilBlock !== undefined && o.goodTilBlock !== 0
  const hasTime = o.goodTilBlockTime !== undefined && o.goodTilBlockTime !== 0
  if (hasBlock === hasTime) throw new TypeError('exactly one of goodTilBlock / goodTilBlockTime must be set')
  if (flags === ORDER_FLAGS.shortTerm && !hasBlock) throw new TypeError('short-term orders need goodTilBlock')
  if (flags !== ORDER_FLAGS.shortTerm && !hasTime) throw new TypeError('stateful orders need goodTilBlockTime')
  if (o.clientMetadata < 0 || o.clientMetadata > 127) throw new TypeError('client_metadata must be within 0..127')
  if (flags === ORDER_FLAGS.shortTerm && o.conditionType !== undefined) {
    throw new TypeError('short-term orders cannot carry a condition type')
  }
  if (o.conditionType === undefined && o.conditionalTriggerSubticks !== undefined) {
    throw new TypeError('conditional trigger subticks require a condition type')
  }

  const w = new ProtoWriter()
  w.bytes(1, encodeOrderId(o.orderId))
  w.enum(2, ORDER_SIDE[o.side])
  w.uint64(3, o.quantums)
  w.uint64(4, o.subticks)
  if (hasBlock) w.uint64(5, o.goodTilBlock!)
  else w.fixed32(6, assertFixed32(o.goodTilBlockTime!, 'goodTilBlockTime'))
  w.enum(7, ORDER_TIF[o.tif])
  w.bool(8, o.reduceOnly)
  w.uint64(9, o.clientMetadata)
  if (o.conditionType !== undefined) {
    w.enum(10, CONDITION_TYPE[o.conditionType])
    w.uint64(11, o.conditionalTriggerSubticks ?? 0n)
  }
  if (o.orderRouterAddress !== undefined && o.orderRouterAddress !== '') w.string(14, o.orderRouterAddress)
  return w.finish()
}

/** 任意消息包成 Any{type_url=1, value=2}。 */
export function anyOf(typeUrl: string, value: Uint8Array): Uint8Array {
  return new ProtoWriter().string(1, typeUrl).bytes(2, value).finish()
}

export function msgPlaceOrder(o: OrderMessage): Uint8Array {
  return new ProtoWriter().bytes(1, encodeOrder(o)).finish()
}

export function msgCancelOrder(p: OrderIdParts, until: { block?: number; blockTime?: number }): Uint8Array {
  const hasBlock = until.block !== undefined && until.block !== 0
  const hasTime = until.blockTime !== undefined && until.blockTime !== 0
  if (hasBlock === hasTime) throw new TypeError('cancel needs exactly one of block / blockTime')
  const w = new ProtoWriter().bytes(1, encodeOrderId(p))
  if (hasBlock) w.uint64(2, until.block!)
  else w.fixed32(3, assertFixed32(until.blockTime!, 'cancel blockTime'))
  return w.finish()
}

/** packed repeated varint（proto3 repeated 标量默认编码）。 */
export function packedVarints(values: readonly number[]): Uint8Array {
  const out: number[] = []
  for (const value of values) {
    let n = value >>> 0
    do {
      let b = n & 0x7f
      n >>>= 7
      if (n > 0) b |= 0x80
      out.push(b)
    } while (n > 0)
  }
  return new Uint8Array(out)
}

export function encodeOrderBatch(clobPairId: number, clientIds: readonly number[]): Uint8Array {
  const w = new ProtoWriter().uint64(1, clobPairId)
  if (clientIds.length > 0) w.bytes(2, packedVarints(clientIds))
  return w.finish()
}

export function msgBatchCancel(
  owner: string,
  subaccountNumber: number,
  clobPairId: number,
  clientIds: readonly number[],
  goodTilBlock: number,
): Uint8Array {
  return new ProtoWriter()
    .bytes(1, encodeSubaccountId(owner, subaccountNumber))
    .bytes(2, encodeOrderBatch(clobPairId, clientIds))
    .uint64(3, goodTilBlock)
    .finish()
}

export const TYPE_URLS = TYPE_URL
