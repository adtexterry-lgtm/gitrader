// SPDX-License-Identifier: CPAL-1.0
// 线协议：字段编解码、uint32BE 长度前缀帧、握手、版本协商、v178 消息字段序。
import { describe, expect, it } from 'vitest'
import { asDecimal } from '@gitrader/protocol'
import { API_VERSION, FrameReader, encodeHandshake, encodeMessage, negotiateVersion, parseHandshakeReply } from '../src/wire'
import * as M from '../src/messages'

function fieldsOf(buf: Buffer): string[] {
  const len = buf.readUInt32BE(0)
  expect(len).toBe(buf.length - 4)
  const fields = buf.subarray(4).toString('utf8').split('\0')
  fields.pop()
  return fields
}

describe('wire · 字段编码', () => {
  it('整数 → 十进制文本，布尔 → 1/0，null / undefined → 空串', () => {
    const f = fieldsOf(encodeMessage([71, 2, 7, '', true, false, null, undefined, 'x']))
    expect(f).toEqual(['71', '2', '7', '', '1', '0', '', '', 'x'])
  })

  it('字符串里的 \\0 拒绝（否则字段整体错位）', () => {
    expect(() => encodeMessage(['a\0b'])).toThrow(RangeError)
  })

  it('非安全整数拒绝（小数必须用十进制文本）', () => {
    expect(() => encodeMessage([1.5])).toThrow(RangeError)
    expect(() => encodeMessage([Number.MAX_SAFE_INTEGER + 1])).toThrow(RangeError)
    expect(fieldsOf(encodeMessage(['1.5']))).toEqual(['1.5'])
  })

  it('UTF-8 多字节字段按字节长度编码', () => {
    expect(fieldsOf(encodeMessage(['停牌']))).toEqual(['停牌'])
  })
})

describe('wire · 帧读取', () => {
  it('分片喂入也能拼出整帧', () => {
    const a = encodeMessage(['178', '20261021 09:30:00 EST'])
    const b = encodeMessage(['9', '1', '100'])
    const all = Buffer.concat([a, b])
    const reader = new FrameReader()
    const out: string[][] = []
    for (let i = 0; i < all.length; i += 3) out.push(...reader.push(all.subarray(i, i + 3)))
    expect(out).toEqual([['178', '20261021 09:30:00 EST'], ['9', '1', '100']])
    expect(reader.buffered).toBe(0)
  })

  it('粘包一次吐出多帧', () => {
    const reader = new FrameReader()
    expect(reader.push(Buffer.concat([encodeMessage(['1', '6']), encodeMessage(['2', '6'])]))).toEqual([['1', '6'], ['2', '6']])
  })

  it('长度超过上限抛 RangeError', () => {
    const bad = Buffer.alloc(4)
    bad.writeUInt32BE(1024, 0)
    expect(() => new FrameReader(16).push(bad)).toThrow(/exceeds cap/)
  })

  it('载荷不以 \\0 结尾抛 RangeError', () => {
    const payload = Buffer.from('123', 'utf8')
    const head = Buffer.alloc(4)
    head.writeUInt32BE(payload.length, 0)
    expect(() => new FrameReader().push(Buffer.concat([head, payload]))).toThrow(/NUL/)
  })

  it('字节不够时等待下一块', () => {
    const reader = new FrameReader()
    expect(reader.push(Buffer.from([0, 0]))).toEqual([])
    expect(reader.buffered).toBe(2)
  })
})

describe('wire · 握手与版本协商', () => {
  it('握手 = API\\0 + uint32BE(9) + v178..178（17 字节）', () => {
    const hs = encodeHandshake()
    expect(hs.subarray(0, 4).toString('latin1')).toBe('API\0')
    expect(hs.readUInt32BE(4)).toBe(9)
    expect(hs.subarray(8).toString('latin1')).toBe('v178..178')
    expect(hs.length).toBe(17)
    expect(API_VERSION).toBe(178)
  })

  it('握手回包必须是 2 字段，版本必须是整数', () => {
    expect(parseHandshakeReply(['178', '20261021 09:30:00 EST'])).toEqual({ serverVersion: 178, connectionTime: '20261021 09:30:00 EST' })
    expect(parseHandshakeReply(['178'])).toBeUndefined()
    expect(parseHandshakeReply(['x', 't'])).toBeUndefined()
    expect(parseHandshakeReply(['178', 't', 'extra'])).toBeUndefined()
  })

  it('只接受服务器版本 178', () => {
    expect(negotiateVersion(178)).toEqual({ ok: true, apiVersion: 178 })
    expect(negotiateVersion(176).ok).toBe(false)
    expect(negotiateVersion(200).ok).toBe(false)
    expect(negotiateVersion(176).reason).toContain('178')
  })
})

describe('messages · 出站字段序', () => {
  it('startApi / cancelOrder / reqExecutions / 订阅与撤订阅', () => {
    expect(fieldsOf(M.startApi(7))).toEqual(['71', '2', '7', ''])
    expect(fieldsOf(M.cancelOrder(101))).toEqual(['4', '1', '101', ''])
    expect(fieldsOf(M.reqExecutions(5, 7, 'DU1', ''))).toEqual(['7', '3', '5', '7', 'DU1', '', '', '', '', ''])
    expect(fieldsOf(M.reqPositions())).toEqual(['61', '1'])
    expect(fieldsOf(M.cancelPositions())).toEqual(['64', '1'])
    expect(fieldsOf(M.cancelAccountSummary(9))).toEqual(['63', '1', '9'])
  })

  it('默认账户摘要标签不含 Currency / AccountReady', () => {
    const tags = fieldsOf(M.reqAccountSummary(1))[4]!.split(',')
    expect(tags).not.toContain('Currency')
    expect(tags).not.toContain('AccountReady')
    expect(tags).toContain('NetLiquidation')
  })

  it('placeOrder 114 字段，关键价格落在 lmtPrice / auxPrice / trailingPercent', () => {
    const c = M.stockContract('AAPL')
    const o = M.emptyOrder(101)
    o.totalQuantity = asDecimal('10')
    o.lmtPrice = asDecimal('100.5')
    const f = fieldsOf(M.placeOrder(c, o))
    expect(f).toHaveLength(114)
    expect(f[0]).toBe('3')
    expect(f[1]).toBe('101')
    expect(f[3]).toBe('AAPL')
    expect(f[19]).toBe('100.5')
    expect(f[24]).toBe('')
    const trail = M.emptyOrder(102)
    trail.orderType = 'TRAIL'
    trail.trailingPercent = asDecimal('7')
    expect(fieldsOf(M.placeOrder(c, trail))[69]).toBe('7')
  })

  it('GTD 的 goodTillDate 落在字段 38（UTC 写法）', () => {
    const o = M.emptyOrder(101)
    o.tif = 'GTD'
    o.goodTillDate = '20261022-20:00:00'
    expect(fieldsOf(M.placeOrder(M.stockContract('AAPL'), o))[38]).toBe('20261022-20:00:00')
  })
})

describe('messages · 入站解码', () => {
  it('orderStatus（无版本号）与 error（带版本号）', () => {
    const s = M.decodeOrderStatus(['3', '101', 'PreSubmitted', '0', '10', '', '5001', '0', '', '7', '', ''])
    expect(s).toMatchObject({ orderId: 101, status: 'PreSubmitted', filled: '0', remaining: '10', permId: 5001 })
    expect(M.decodeError(['4', '2', '101', '201', 'rejected', '{}'])).toEqual({ reqId: 101, code: 201, message: 'rejected', advanced: '{}' })
  })

  it('未设置的 double（Double.MAX / 空串）解码成 undefined', () => {
    expect(M.decodeOrderStatus(['3', '1', 'Submitted', '0', '1', '1.7976931348623157E308', '1', '0', '', '7', '', '']).avgFillPrice).toBeUndefined()
    expect(M.decodeTickPrice(['1', '6', '1', '2', '-1', '0', '0']).price).toBeUndefined()
  })

  it('execDetails 的 orderId 在合约之前、orderRef 在 avgPrice 之后', () => {
    const x = M.decodeExecDetails([
      '11', '9', '101', '265598', 'AAPL', 'STK', '', '0', '', '', 'ISLAND', 'USD', 'AAPL', 'NMS',
      'e1', '20261021 10:00:00 US/Eastern', 'DU1', 'ISLAND', 'BOT', '10', '100.5', '5001', '7', '0', '10', '100.5', 'REF', '', '', '', '2', '0',
    ])
    expect(x).toMatchObject({ reqId: 9, orderId: 101, execId: 'e1', side: 'BOT', orderRef: 'REF', lastLiquidity: 2 })
    expect(x.contract).toMatchObject({ conId: 265598, symbol: 'AAPL' })
  })
})

describe('messages · 常量与无设置值', () => {
  it('消息号与 IB 文档一致（抽查）', () => {
    expect(M.OUT.PLACE_ORDER).toBe(3)
    expect(M.OUT.CANCEL_ORDER).toBe(4)
    expect(M.OUT.REQ_POSITIONS).toBe(61)
    expect(M.OUT.REQ_ACCOUNT_SUMMARY).toBe(62)
    expect(M.OUT.CANCEL_ACCOUNT_SUMMARY).toBe(63)
    expect(M.OUT.CANCEL_POSITIONS).toBe(64)
    expect(M.IN.ORDER_STATUS).toBe(3)
    expect(M.IN.COMMISSION_REPORT).toBe(59)
    expect(M.UNSET_INTEGER).toBe(2147483647)
  })

  it('FieldReader 越界 / 非整数文本抛 RangeError', () => {
    expect(() => new M.FieldReader(['3']).str()).toThrow(RangeError)
    expect(() => new M.FieldReader(['3', 'x']).int()).toThrow(RangeError)
    expect(new M.FieldReader(['3', '', '0']).int()).toBe(0)
    expect(new M.FieldReader(['3', '1.0E-4']).dec()).toBe('0.0001')
    expect(M.decText(undefined)).toBe('')
  })
})
