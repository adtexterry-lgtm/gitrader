// SPDX-License-Identifier: CPAL-1.0
// proto 编解码与 CLOB 消息编码测试。字段编号/类型按官方 proto 逐条核对（注释里给出出处），
// 解码走测试自己的独立 TLV 读取器（test/helpers/tlv.ts），不与 src/proto.ts 共用实现。
import { describe, expect, it } from 'vitest'
import { ProtoWriter, WIRE_BYTES, WIRE_FIXED32, WIRE_VARINT, firstField, fromBase64, readFields, toBase64, varint } from '../src/proto'
import {
  anyOf, encodeOrder, encodeOrderId, encodeSubaccountId, msgBatchCancel, msgCancelOrder, msgPlaceOrder, packedVarints,
} from '../src/msgs'
import { ORDER_FLAGS, ORDER_SIDE, ORDER_TIF, TYPE_URL } from '../src/constants'
import { hex, maybe, one, walk } from './helpers/tlv'

describe('varint 编码', () => {
  it('0 / 1 / 127 / 128 / 300 / 2^32 / 2^64-1 的字节与公认编码一致', () => {
    expect(hex(varint(0n))).toBe('00')
    expect(hex(varint(1n))).toBe('01')
    expect(hex(varint(127n))).toBe('7f')
    expect(hex(varint(128n))).toBe('8001')
    expect(hex(varint(300n))).toBe('ac02')
    expect(hex(varint(4294967296n))).toBe('8080808010')
    expect(hex(varint(18446744073709551615n))).toBe('ffffffffffffffffff01')
  })

  it('负值被拒绝（uint64 字段不接受负数）', () => {
    expect(() => varint(-1n)).toThrow(RangeError)
  })

  it('读回写出的值（1..2^53 抽样）', () => {
    for (const v of [0, 1, 2, 63, 64, 8191, 8192, 123456789, 2 ** 40]) {
      const enc = new ProtoWriter().uint64Always(1, v).finish()
      expect(readFields(enc)).toHaveLength(1)
      expect(Number(one(walk(enc), 1).num)).toBe(v)
    }
  })
})

describe('ProtoWriter / readFields', () => {
  it('零值字段按 proto3 省略，uint64Always 强制写出', () => {
    expect(new ProtoWriter().uint64(3, 0).finish()).toHaveLength(0)
    expect(hex(new ProtoWriter().uint64Always(3, 0).finish())).toBe('1800')
  })

  it('string 空串省略，非空写成 tag+len+utf8', () => {
    expect(new ProtoWriter().string(1, '').finish()).toHaveLength(0)
    const enc = new ProtoWriter().string(1, 'hi').finish()
    expect(hex(enc)).toBe('0a026869')
    expect(one(walk(enc), 1).text).toBe('hi')
  })

  it('bool 只写 true', () => {
    expect(new ProtoWriter().bool(8, false).finish()).toHaveLength(0)
    expect(hex(new ProtoWriter().bool(8, true).finish())).toBe('4001')
  })

  it('fixed32 小端写 4 字节，wire type = 5', () => {
    const enc = new ProtoWriter().fixed32(2, 0x01020304).finish()
    expect(hex(enc)).toBe('1504030201')
    const f = one(walk(enc), 2)
    expect(f.wire).toBe(WIRE_FIXED32)
    expect(Number(f.num)).toBe(0x01020304)
  })

  it('嵌套消息：空子消息写成 tag + 长度 0', () => {
    const enc = new ProtoWriter().bytes(6, new ProtoWriter().finish()).finish()
    expect(hex(enc)).toBe('3200')
  })

  it('大的 length-delimited 字段长度用多字节 varint', () => {
    const payload = new Uint8Array(300).fill(0x41)
    const enc = new ProtoWriter().bytes(1, payload).finish()
    const f = one(walk(enc), 1)
    expect(f.data).toHaveLength(300)
    expect(f.wire).toBe(WIRE_BYTES)
  })

  it('readFields 保留未知字段（前向兼容）并且能读 varint', () => {
    const enc = new ProtoWriter().uint64(99, 7).finish()
    const f = readFields(enc)
    expect(f).toHaveLength(1)
    expect(f[0]!.field).toBe(99)
    expect(f[0]!.wire).toBe(WIRE_VARINT)
    expect(f[0]!.value).toBe(7n)
  })

  it('截断的 length-delimited / 非法 wire type 抛错', () => {
    expect(() => readFields(new Uint8Array([0x0a, 0x05, 0x41]))).toThrow(/truncated/)
    expect(() => readFields(new Uint8Array([0x0f]))).toThrow(/unsupported/)
  })

  it('varint 超过 64 位抛错', () => {
    expect(() => readFields(new Uint8Array([0x08, ...Array(11).fill(0x80), 0x01]))).toThrow(/64 bits/)
  })

  it('base64 往返', () => {
    const b = new Uint8Array([0, 1, 2, 250, 255])
    expect(Array.from(fromBase64(toBase64(b)))).toEqual(Array.from(b))
  })
})

describe('SubaccountId / OrderId（官方字段号）', () => {
  it('SubaccountId{owner=1,number=2}：number=0 省略，字节为 0a len utf8', () => {
    expect(hex(encodeSubaccountId('dydx1abc', 0))).toBe('0a086479647831616263')
    expect(hex(encodeSubaccountId('dydx1abc', 1))).toBe('0a0864796478316162631001')
  })

  it('OrderId：client_id 是 fixed32（wire 5），order_flags / clob_pair_id 是 varint', () => {
    const enc = encodeOrderId({ owner: 'dydx1abc', subaccountNumber: 0, clientId: 1, clobPairId: 3, orderFlags: 0 })
    const f = walk(enc)
    const sub = one(f, 1)
    expect(sub.wire).toBe(WIRE_BYTES)
    const cid = one(f, 2)
    expect(cid.wire).toBe(WIRE_FIXED32)
    expect(Number(cid.num)).toBe(1)
    expect(Number(one(f, 4).num)).toBe(3)
    expect(maybe(f, 3)).toBeUndefined()
  })

  it('OrderId 全字段：flags=64、clientId=0xdeadbeef 原样小端', () => {
    const enc = encodeOrderId({ owner: 'dydx1abc', subaccountNumber: 2, clientId: 0xdeadbeef, clobPairId: 7, orderFlags: 64 })
    const f = walk(enc)
    expect(Number(one(f, 2).num)).toBe(0xdeadbeef)
    expect(Number(one(f, 3).num)).toBe(64)
    expect(Number(one(f, 4).num)).toBe(7)
    expect(walk(one(f, 1).data!)[0]!.wire).toBe(WIRE_BYTES)
    expect(Number(one(walk(one(f, 1).data!), 2).num)).toBe(2)
  })

  it('缺少 owner 时拒绝空地址（构造期由 keys 保证，这里只测编码不写空字符串）', () => {
    expect(hex(encodeSubaccountId('', 0))).toBe('')
  })
})

describe('Order 消息', () => {
  const base = {
    orderId: { owner: 'dydx1abc', subaccountNumber: 0, clientId: 5, clobPairId: 1, orderFlags: ORDER_FLAGS.shortTerm },
    side: 'buy' as const,
    quantums: 100_000_000,
    subticks: 5_000_000_000,
    goodTilBlock: 1234,
    tif: 'ioc' as const,
    reduceOnly: false,
    clientMetadata: 7,
  }

  it('短单：side/quantums/subticks/good_til_block(tag 5)/tif 的字段号与值', () => {
    const f = walk(encodeOrder(base))
    expect(Number(one(f, 2).num)).toBe(ORDER_SIDE.buy)
    expect(Number(one(f, 3).num)).toBe(100_000_000)
    expect(Number(one(f, 4).num)).toBe(5_000_000_000)
    expect(Number(one(f, 5).num)).toBe(1234)
    expect(Number(one(f, 7).num)).toBe(ORDER_TIF.ioc)
    expect(Number(one(f, 9).num)).toBe(7)
    expect(maybe(f, 6)).toBeUndefined()
  })

  it('gtc 写 UNSPECIFIED(0)（proto 省略），postOnly 写 2', () => {
    const gtc = walk(encodeOrder({ ...base, tif: 'gtc' }))
    expect(maybe(gtc, 7)).toBeUndefined()
    const post = walk(encodeOrder({ ...base, tif: 'postOnly' }))
    expect(Number(one(post, 7).num)).toBe(2)
  })

  it('reduce_only=true 才写 field 8', () => {
    expect(maybe(walk(encodeOrder(base)), 8)).toBeUndefined()
    expect(Number(one(walk(encodeOrder({ ...base, reduceOnly: true })), 8).num)).toBe(1)
  })

  it('长单用 good_til_block_time（field 6，fixed32），不写 field 5', () => {
    const enc = encodeOrder({ ...base, orderId: { ...base.orderId, orderFlags: ORDER_FLAGS.longTerm }, goodTilBlock: undefined, goodTilBlockTime: 1_800_000_000, tif: 'gtc' })
    const f = walk(enc)
    expect(maybe(f, 5)).toBeUndefined()
    const ts = one(f, 6)
    expect(ts.wire).toBe(WIRE_FIXED32)
    expect(Number(ts.num)).toBe(1_800_000_000)
  })

  it('good_til_block_time 超出 fixed32（0..2^32-1）→ TypeError', () => {
    const long = { ...base, orderId: { ...base.orderId, orderFlags: ORDER_FLAGS.longTerm }, goodTilBlock: undefined, tif: 'gtc' as const }
    expect(() => encodeOrder({ ...long, goodTilBlockTime: 2 ** 32 })).toThrow(TypeError)
    expect(() => encodeOrder({ ...long, goodTilBlockTime: -1 })).toThrow(TypeError)
    expect(() => encodeOrder({ ...long, goodTilBlockTime: 0xffffffff })).not.toThrow()
  })

  it('条件单：condition_type(field 10) + conditional_order_trigger_subticks(field 11)，flags=32', () => {
    const enc = encodeOrder({
      ...base, orderId: { ...base.orderId, orderFlags: ORDER_FLAGS.conditional }, goodTilBlock: undefined, goodTilBlockTime: 1_900_000_000,
      tif: 'gtc', reduceOnly: true, conditionType: 'stopLoss', conditionalTriggerSubticks: 4_900_000_000,
    })
    const f = walk(enc)
    expect(Number(one(walk(one(f, 1).data!), 3).num)).toBe(ORDER_FLAGS.conditional)
    expect(Number(one(f, 10).num)).toBe(1)
    expect(Number(one(f, 11).num)).toBe(4_900_000_000)
  })

  it('止盈条件类型是 2', () => {
    const enc = encodeOrder({
      ...base, orderId: { ...base.orderId, orderFlags: ORDER_FLAGS.conditional }, goodTilBlock: undefined, goodTilBlockTime: 1,
      conditionType: 'takeProfit', conditionalTriggerSubticks: 1,
    })
    expect(Number(one(walk(enc), 10).num)).toBe(2)
  })

  it('两个到期字段都给 / 都不给 / 短单给时间 / 长单给块高 → 拒绝', () => {
    expect(() => encodeOrder({ ...base, goodTilBlockTime: 100 })).toThrow(/exactly one/)
    expect(() => encodeOrder({ ...base, goodTilBlock: 0 })).toThrow(/exactly one/)
    // 长单只给块高：短单专属字段对长单无效 → 拒绝
    expect(() => encodeOrder({ ...base, orderId: { ...base.orderId, orderFlags: ORDER_FLAGS.longTerm } })).toThrow(/stateful orders need/)
    // 短单只给时间：拒绝
    expect(() => encodeOrder({ ...base, goodTilBlock: undefined, goodTilBlockTime: 100 })).toThrow(/short-term orders need/)
  })

  it('client_metadata 超出 0..127 → 拒绝（短单每块每账户只有 128 个槽位）', () => {
    expect(() => encodeOrder({ ...base, clientMetadata: 128 })).toThrow(/0\.\.127/)
    expect(() => encodeOrder({ ...base, clientMetadata: -1 })).toThrow(/0\.\.127/)
    expect(() => encodeOrder({ ...base, clientMetadata: 127 })).not.toThrow()
  })

  it('短单带条件类型 / 有条件价却无条件类型 → 拒绝', () => {
    expect(() => encodeOrder({ ...base, conditionType: 'stopLoss' })).toThrow(/short-term orders cannot/)
    expect(() => encodeOrder({ ...base, conditionalTriggerSubticks: 1 })).toThrow(/require a condition type/)
  })

  it('order_router_address 走 field 14', () => {
    const enc = encodeOrder({ ...base, orderRouterAddress: 'dydx1router' })
    expect(one(walk(enc), 14).text).toBe('dydx1router')
  })
})

describe('官方字节向量（逐字节核对 encodeOrder）', () => {
  // 期望值由独立编码器（官方 proto 字段表）算出，不是本包 encodeOrder 反推。
  const owner = 'dydx14zzueazeh0hj67cghhf9jypslcf9sh2n5k6art'

  it('短单：clientId 123 / clobPairId 1 / flags 0 / goodTilBlock 1020 / IOC / reduceOnly', () => {
    const enc = encodeOrder({
      orderId: { owner, subaccountNumber: 0, clientId: 123, clobPairId: 1, orderFlags: 0 },
      side: 'buy',
      quantums: 1_000_000,
      subticks: 2_000_000_000,
      goodTilBlock: 1020,
      tif: 'ioc',
      reduceOnly: true,
      clientMetadata: 0,
    })
    expect(hex(enc)).toBe('0a360a2d0a2b6479647831347a7a7565617a656830686a36376367686866396a7970736c6366397368326e356b36617274157b0000002001100118c0843d2080a8d6b90728fc0738014001')
  })

  it('长单：flags 64 / sell / goodTilBlockTime 1900000000（fixed32）/ gtc', () => {
    const enc = encodeOrder({
      orderId: { owner, subaccountNumber: 0, clientId: 123, clobPairId: 1, orderFlags: 64 },
      side: 'sell',
      quantums: 1_000_000,
      subticks: 2_000_000_000,
      goodTilBlockTime: 1_900_000_000,
      tif: 'gtc',
      reduceOnly: false,
      clientMetadata: 0,
    })
    expect(hex(enc)).toBe('0a380a2d0a2b6479647831347a7a7565617a656830686a36376367686866396a7970736c6366397368326e356b36617274157b00000018402001100218c0843d2080a8d6b9073500b33f71')
  })

  it('条件单：clientId 7 / clobPairId 0 / flags 32 / 触发 1950000000', () => {
    const enc = encodeOrder({
      orderId: { owner, subaccountNumber: 0, clientId: 7, clobPairId: 0, orderFlags: 32 },
      side: 'sell',
      quantums: 1_000_000,
      subticks: 1_900_000_000,
      goodTilBlockTime: 1_900_000_000,
      tif: 'ioc',
      reduceOnly: true,
      clientMetadata: 0,
      conditionType: 'stopLoss',
      conditionalTriggerSubticks: 1_950_000_000,
    })
    expect(hex(enc)).toBe('0a360a2d0a2b6479647831347a7a7565617a656830686a36376367686866396a7970736c6366397368326e356b3661727415070000001820100218c0843d2080e6fe89073500b33f713801400150015880c7eaa107')
  })
})

describe('Msg 包装', () => {
  const order = {
    orderId: { owner: 'dydx1abc', subaccountNumber: 0, clientId: 5, clobPairId: 1, orderFlags: 0 },
    side: 'sell' as const,
    quantums: 1,
    subticks: 1,
    goodTilBlock: 10,
    tif: 'ioc' as const,
    reduceOnly: false,
    clientMetadata: 0,
  }

  it('MsgPlaceOrder{order=1} 里 field 1 是 Order 字节', () => {
    const enc = msgPlaceOrder(order)
    const f = walk(enc)
    const inner = one(f, 1).data!
    expect(Number(one(walk(inner), 2).num)).toBe(ORDER_SIDE.sell)
  })

  it('MsgCancelOrder 短单：order_id=1 + good_til_block=2', () => {
    const enc = msgCancelOrder(order.orderId, { block: 99 })
    const f = walk(enc)
    expect(Number(one(f, 2).num)).toBe(99)
    expect(maybe(f, 3)).toBeUndefined()
    expect(one(walk(one(f, 1).data!), 2).wire).toBe(WIRE_FIXED32)
  })

  it('MsgCancelOrder 长单：good_til_block_time 是 fixed32（tx.proto 明确 fixed32）', () => {
    const enc = msgCancelOrder(order.orderId, { blockTime: 1_800_000_000 })
    const f = walk(enc)
    const t = one(f, 3)
    expect(t.wire).toBe(WIRE_FIXED32)
    expect(Number(t.num)).toBe(1_800_000_000)
    expect(maybe(f, 2)).toBeUndefined()
  })

  it('MsgCancelOrder 两个到期都不给 → 拒绝', () => {
    expect(() => msgCancelOrder(order.orderId, {})).toThrow(/exactly one/)
  })

  it('MsgBatchCancel：subaccount=1、order batch=2、good_til_block=3；client_ids 是 packed varint', () => {
    const enc = msgBatchCancel('dydx1abc', 0, 4, [1, 300], 55)
    const f = walk(enc)
    expect(Number(one(f, 3).num)).toBe(55)
    const batch = walk(one(f, 2).data!)
    expect(Number(one(batch, 1).num)).toBe(4)
    expect(hex(one(batch, 2).data!)).toBe(hex(packedVarints([1, 300])))
    expect(hex(one(batch, 2).data!)).toBe('01ac02')
  })

  it('Any{type_url=1,value=2} 的 type_url 与 value 都对得上', () => {
    const value = new Uint8Array([1, 2, 3])
    const f = walk(anyOf(TYPE_URL.msgPlaceOrder, value))
    expect(one(f, 1).text).toBe('/dydxprotocol.clob.MsgPlaceOrder')
    expect(hex(one(f, 2).data!)).toBe('010203')
  })

  it('packedVarints 空数组给空字节', () => {
    expect(packedVarints([])).toHaveLength(0)
  })
})

describe('readFields 与独立读取器结果一致（互校）', () => {
  it('随机若干消息：两边字段号 / wire type / 值完全一致', () => {
    const samples = [
      encodeOrderId({ owner: 'dydx1abc', subaccountNumber: 3, clientId: 42, clobPairId: 9, orderFlags: 64 }),
      msgBatchCancel('dydx1abc', 1, 2, [7, 8, 9], 1000),
      new ProtoWriter().fixed32(6, 1_700_000_000).finish(),
    ]
    for (const s of samples) {
      const a = readFields(s).map((x) => `${x.field}/${x.wire}/${x.value ?? hex(x.bytes ?? new Uint8Array())}`)
      const b = walk(s).map((x) => `${x.field}/${x.wire}/${x.num ?? hex(x.data ?? new Uint8Array())}`)
      expect(a).toEqual(b)
    }
  })

  it('firstField 找第一个出现', () => {
    const enc = new ProtoWriter().uint64(1, 5).uint64(1, 6).finish()
    expect(firstField(readFields(enc), 1)?.value).toBe(5n)
  })
})
