// SPDX-License-Identifier: CPAL-1.0
// 私有流归一：Bitget WS `fill` / `orders` 通道 → 执行事件（保留成交号 = 去重键、执行类型、零数量平仓行）。
// 口径：QD execution_streams/normalizers.py:185-249。
import { describe, expect, it } from 'vitest'
import { normalizeBitgetEvent } from '../src/parse'
import { NOW } from './helpers/fake-bitget'

describe('通道过滤', () => {
  it('fill 通道被认', () => {
    const out = normalizeBitgetEvent({ arg: { channel: 'fill', instType: 'USDT-FUTURES' }, data: [] })
    expect(out.channel).toBe('fill')
  })
  it('orders 通道被认', () => {
    expect(normalizeBitgetEvent({ arg: { channel: 'orders' }, data: [] }).channel).toBe('orders')
  })
  it('其它通道返回空事件（不报错）', () => {
    const out = normalizeBitgetEvent({ arg: { channel: 'ticker' }, data: [{ tradeId: 'x' }] })
    expect(out.events).toEqual([])
  })
  it('空 payload / 坏形状不崩', () => {
    expect(normalizeBitgetEvent(null).events).toEqual([])
    expect(normalizeBitgetEvent({}).events).toEqual([])
    expect(normalizeBitgetEvent({ arg: {}, data: 'x' }).events).toEqual([])
  })
})

describe('fill 事件字段', () => {
  const fillRow = {
    tradeId: 't-9', orderId: '9001', clientOid: 'gtc1', symbol: 'BTCUSDT', side: 'buy', fillQty: '0.005',
    fillPrice: '100.5', cTime: String(NOW - 100), profit: '1.25', tradeScope: 'maker',
    feeDetail: [{ feeCoin: 'USDT', totalFee: '-0.0003' }],
  }
  it('成交号原样保留（去重键）', () => {
    const [event] = normalizeBitgetEvent({ arg: { channel: 'fill', instType: 'USDT-FUTURES' }, data: [fillRow] }).events
    expect(event!.venueFillId).toBe('BTCUSDT:t-9')
  })
  it('私有成交号按标的命名空间；无 tradeId 的非零成交保持空号', () => {
    const events = normalizeBitgetEvent({
      arg: { channel: 'fill', instType: 'USDT-FUTURES' },
      data: [
        { ...fillRow, symbol: 'BTCUSDT', tradeId: 'shared' },
        { ...fillRow, symbol: 'ETHUSDT', tradeId: 'shared' },
      ],
    }).events
    expect(events.map((event) => event.venueFillId)).toEqual(['BTCUSDT:shared', 'ETHUSDT:shared'])
    const noId = normalizeBitgetEvent({ arg: { channel: 'fill' }, data: [{ symbol: 'BTCUSDT', fillQty: '1' }] }).events[0]
    expect(noId!.venueFillId).toBe('')
  })
  it('数量 / 价格 / 方向 / 持仓方向', () => {
    const [event] = normalizeBitgetEvent({ arg: { channel: 'fill' }, data: [{ ...fillRow, holdSide: 'short' }] }).events
    expect(event!.size).toBe('0.005')
    expect(event!.price).toBe('100.5')
    expect(event!.side).toBe('buy')
    expect(event!.holdSide).toBe('short')
    expect(event!.instrumentId).toBe('bitget:BTCUSDT')
  })
  it('手续费取反（上游负数是扣费）且币种保留', () => {
    const [event] = normalizeBitgetEvent({ arg: { channel: 'fill' }, data: [fillRow] }).events
    expect(event!.fee).toBe('0.0003')
    expect(event!.feeCcy).toBe('USDT')
  })
  it('执行类型 maker 被保留', () => {
    const [event] = normalizeBitgetEvent({ arg: { channel: 'fill' }, data: [fillRow] }).events
    expect(event!.liquidity).toBe('maker')
  })
  it('没有 tradeScope 时按 taker（不可知也不假装 maker）', () => {
    const [event] = normalizeBitgetEvent({ arg: { channel: 'fill' }, data: [{ ...fillRow, tradeScope: undefined }] }).events
    expect(event!.liquidity).toBe('taker')
  })
  it('realizedPnl 保留符号', () => {
    const [event] = normalizeBitgetEvent({ arg: { channel: 'fill' }, data: [{ ...fillRow, profit: '-2' }] }).events
    expect(event!.realizedPnl).toBe('-2')
  })
  it('null clientOrderId 归一成 null', () => {
    const [event] = normalizeBitgetEvent({ arg: { channel: 'fill' }, data: [{ ...fillRow, clientOid: undefined }] }).events
    expect(event!.clientOrderId).toBeNull()
  })
  it('累计数量来自 accBaseVolume', () => {
    const [event] = normalizeBitgetEvent({ arg: { channel: 'fill' }, data: [{ ...fillRow, accBaseVolume: '0.01' }] }).events
    expect(event!.cumSize).toBe('0.01')
  })
  it('没有累计数量 → null', () => {
    const [event] = normalizeBitgetEvent({ arg: { channel: 'fill' }, data: [fillRow] }).events
    expect(event!.cumSize).toBeNull()
  })
  it('时间戳取 cTime，缺失回落 now', () => {
    const withTime = normalizeBitgetEvent({ arg: { channel: 'fill' }, data: [fillRow] }).events[0]!
    expect(withTime.ts).toBe(NOW - 100)
    const without = normalizeBitgetEvent({ arg: { channel: 'fill' }, data: [{ tradeId: 'x', symbol: 'B', fillQty: '1', fillPrice: '1' }] }, { now: 42 }).events[0]!
    expect(without.ts).toBe(42)
  })
})

describe('零数量平仓行（教训 10：保留 tradeId 就保留事件）', () => {
  it('数量 0 但有 tradeId → 保留', () => {
    const out = normalizeBitgetEvent({ arg: { channel: 'fill' }, data: [{ tradeId: 'close-1', symbol: 'BTCUSDT', fillQty: '0', fillPrice: '100', status: 'filled' }] })
    expect(out.events).toHaveLength(1)
    expect(out.events[0]!.venueFillId).toBe('BTCUSDT:close-1')
    expect(out.events[0]!.mapped).toBe('filled')
  })
  it('数量 0 且没有 tradeId → 丢弃', () => {
    expect(normalizeBitgetEvent({ arg: { channel: 'fill' }, data: [{ symbol: 'BTCUSDT', fillQty: '0' }] }).events).toEqual([])
  })
})

describe('orders 通道与 SPOT 差异', () => {
  it('orders 通道保留原生状态并映射', () => {
    const [event] = normalizeBitgetEvent({
      arg: { channel: 'orders', instType: 'USDT-FUTURES' },
      data: [{ orderId: '9001', clientOid: 'c', symbol: 'BTCUSDT', side: 'sell', fillQty: '0.1', fillPrice: '99', status: 'partially_filled' }],
    }).events
    expect(event!.channel).toBe('orders')
    expect(event!.status).toBe('partially_filled')
    expect(event!.mapped).toBe('partially_filled')
  })
  it('orders 通道累计数量来自 accBaseVolume', () => {
    const [event] = normalizeBitgetEvent({
      arg: { channel: 'orders', instType: 'USDT-FUTURES' },
      data: [{ orderId: '1', symbol: 'B', fillQty: '1', fillPrice: '1', accBaseVolume: '5', status: 'live' }],
    }).events
    expect(event!.cumSize).toBe('5')
  })
  it('SPOT fill 用 size 字段与 priceAvg', () => {
    const [event] = normalizeBitgetEvent({
      arg: { channel: 'fill', instType: 'SPOT' },
      data: [{ tradeId: 's1', symbol: 'BTCUSDT', side: 'buy', size: '0.2', priceAvg: '50' }],
    }).events
    expect(event!.size).toBe('0.2')
    expect(event!.price).toBe('50')
  })
  it('未知状态映射为 null（不猜成 open）', () => {
    const [event] = normalizeBitgetEvent({ arg: { channel: 'orders' }, data: [{ orderId: '1', symbol: 'B', fillQty: '1', status: 'weird_state' }] }).events
    expect(event!.mapped).toBeNull()
    expect(event!.status).toBe('weird_state')
  })
  it('fill 通道没有状态时默认 filled', () => {
    const [event] = normalizeBitgetEvent({ arg: { channel: 'fill' }, data: [{ tradeId: 'x', symbol: 'B', fillQty: '1', fillPrice: '1' }] }).events
    expect(event!.mapped).toBe('filled')
  })
})

describe('费率形状', () => {
  it('feeDetail 平铺 fee / feeCoin', () => {
    const [event] = normalizeBitgetEvent({ arg: { channel: 'fill' }, data: [{ tradeId: 'x', symbol: 'B', fillQty: '1', fillPrice: '1', fillFee: '-0.001', fillFeeCoin: 'BGB' }] }).events
    expect(event!.feeCcy).toBe('BGB')
    expect(event!.fee).toBe('0.001')
  })
  it('两种币扣费 → MIXED（不再相加）且 fees 留逐币明细', () => {
    const [event] = normalizeBitgetEvent({
      arg: { channel: 'fill' },
      data: [{ tradeId: 'x', symbol: 'B', fillQty: '1', fillPrice: '1', feeDetail: { newFees: { d: '-0.0001', r: '-0.0002' } } }],
    }).events
    expect(event!.feeCcy).toBe('MIXED')
    expect(event!.fee).toBe('0')
    expect(event!.fees).toEqual({ BGB: '0.0001', USDT: '0.0002' })
  })
  it('极小金额不走浮点（5e-8 也保留完整精度）', () => {
    const [event] = normalizeBitgetEvent({
      arg: { channel: 'fill' },
      data: [{ tradeId: 'x', symbol: 'B', fillQty: '1', fillPrice: '1', feeDetail: [{ feeCoin: 'USDT', totalFee: '-0.00000005' }] }],
    }).events
    expect(event!.fee).toBe('0.00000005')
    expect(event!.feeCcy).toBe('USDT')
  })
  it('完全没有费率字段 → fee 0、币种空串', () => {
    const [event] = normalizeBitgetEvent({ arg: { channel: 'fill' }, data: [{ tradeId: 'x', symbol: 'B', fillQty: '1', fillPrice: '1' }] }).events
    expect(event!.fee).toBe('0')
    expect(event!.feeCcy).toBe('')
  })
})
