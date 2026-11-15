// SPDX-License-Identifier: CPAL-1.0
// 位置级保护单（TP / SL / 追踪）：POST /api/v2/mix/order/place-tpsl-order 的请求体。
// 口径：QD backend_api_python/app/services/live_trading/native_protection.py:190-229。
import { describe, expect, it } from 'vitest'
import { OrderBuildError, buildProtectionOrders } from '../src/orders'
import { parseInstrumentRecords } from '../src/parse'
import { NOW, contractRow } from './helpers/fake-bitget'

const btc = parseInstrumentRecords([contractRow()], NOW)[0]!

describe('SL / TP', () => {
  it('SL → planType=loss_plan + triggerType=mark_price + executePrice=0', () => {
    const [order] = buildProtectionOrders({ symbol: 'BTCUSDT', holdSide: 'long', size: '0.01', stopLossPrice: '90000' })
    expect(order!.role).toBe('sl')
    expect(order!.body['planType']).toBe('loss_plan')
    expect(order!.body['triggerType']).toBe('mark_price')
    expect(order!.body['executePrice']).toBe('0')
    expect(order!.body['triggerPrice']).toBe('90000')
    expect(order!.body['holdSide']).toBe('long')
  })
  it('TP → planType=profit_plan', () => {
    const [order] = buildProtectionOrders({ symbol: 'BTCUSDT', holdSide: 'long', size: '0.01', takeProfitPrice: '110000' })
    expect(order!.role).toBe('tp')
    expect(order!.body['planType']).toBe('profit_plan')
  })
  it('同时给 SL / TP → 两条，顺序 sl 在前', () => {
    const orders = buildProtectionOrders({ symbol: 'BTCUSDT', holdSide: 'long', size: '0.01', stopLossPrice: '90000', takeProfitPrice: '110000' })
    expect(orders.map((o) => o.role)).toEqual(['sl', 'tp'])
  })
  it('都为空 → 不发任何单（空数组）', () => {
    expect(buildProtectionOrders({ symbol: 'BTCUSDT', holdSide: 'long', size: '0.01' })).toEqual([])
  })
  it('价格非法（0 / 非数字）被跳过', () => {
    expect(buildProtectionOrders({ symbol: 'BTCUSDT', holdSide: 'long', size: '0.01', stopLossPrice: '0' })).toEqual([])
    expect(buildProtectionOrders({ symbol: 'BTCUSDT', holdSide: 'long', size: '0.01', takeProfitPrice: 'abc' })).toEqual([])
  })
  it('holdSide / marginCoin / productType 原样带上', () => {
    const [order] = buildProtectionOrders({ symbol: 'ETHUSDT', holdSide: 'short', size: '1', stopLossPrice: '3200' })
    expect(order!.body['holdSide']).toBe('short')
    expect(order!.body['marginCoin']).toBe('USDT')
    expect(order!.body['productType']).toBe('USDT-FUTURES')
    expect(order!.body['symbol']).toBe('ETHUSDT')
  })
  it('clientOid 带 -sl / -tp 后缀（≤ 64）', () => {
    const orders = buildProtectionOrders({
      symbol: 'BTCUSDT', holdSide: 'long', size: '0.01', stopLossPrice: '90000', takeProfitPrice: '110000', clientOrderId: 'gtparent01',
    })
    expect(orders[0]!.body['clientOid']).toBe('gtparent01sl')
    expect(orders[1]!.body['clientOid']).toBe('gtparent01tp')
  })
  it('父单 id 很长时截到 64 位', () => {
    const [order] = buildProtectionOrders({ symbol: 'BTCUSDT', holdSide: 'long', size: '0.01', stopLossPrice: '90000', clientOrderId: 'a'.repeat(80) })
    expect(order!.body['clientOid']!.length).toBe(64)
  })
  it('没给父单 id 就不发 clientOid', () => {
    const [order] = buildProtectionOrders({ symbol: 'BTCUSDT', holdSide: 'long', size: '0.01', stopLossPrice: '90000' })
    expect(order!.body['clientOid']).toBeUndefined()
  })
})

describe('追踪（moving_plan）', () => {
  it('planType=moving_plan + rangeRate=百分比 + 不带 executePrice', () => {
    const [order] = buildProtectionOrders({
      symbol: 'BTCUSDT', holdSide: 'long', size: '0.01', trailingPercent: 0.02, activationPrice: '100000',
    })
    expect(order!.role).toBe('trail')
    expect(order!.body['planType']).toBe('moving_plan')
    expect(order!.body['rangeRate']).toBe('2')
    expect(order!.body['triggerPrice']).toBe('100000')
    expect(order!.body['executePrice']).toBeUndefined()
  })
  it('没有 activationPrice 时用 entryPrice', () => {
    const [order] = buildProtectionOrders({ symbol: 'BTCUSDT', holdSide: 'long', size: '0.01', trailingPercent: 0.05, entryPrice: '99000' })
    expect(order!.body['triggerPrice']).toBe('99000')
    expect(order!.body['rangeRate']).toBe('5')
  })
  it('既无 activationPrice 也无 entryPrice → INVALID_PARAMS', () => {
    expect(() => buildProtectionOrders({ symbol: 'BTCUSDT', holdSide: 'long', size: '0.01', trailingPercent: 0.02 })).toThrow(OrderBuildError)
  })
  it('trailingPercent = 0 不发追踪单', () => {
    expect(buildProtectionOrders({ symbol: 'BTCUSDT', holdSide: 'long', size: '0.01', trailingPercent: 0 })).toEqual([])
  })
  it('SL + TP + 追踪可同时存在（三条）', () => {
    const orders = buildProtectionOrders({
      symbol: 'BTCUSDT', holdSide: 'short', size: '0.01', stopLossPrice: '110000', takeProfitPrice: '90000',
      trailingPercent: 0.03, activationPrice: '100000',
    })
    expect(orders.map((o) => o.role)).toEqual(['sl', 'tp', 'trail'])
  })
})

describe('数量规整', () => {
  it('给了标的记录时按 step 截断', () => {
    const [order] = buildProtectionOrders({ symbol: 'BTCUSDT', holdSide: 'long', size: '0.0109', stopLossPrice: '90000' }, btc)
    expect(order!.body['size']).toBe('0.01')
  })
  it('截断后为 0 → PRECISION', () => {
    expect(() => buildProtectionOrders({ symbol: 'BTCUSDT', holdSide: 'long', size: '0.0001', stopLossPrice: '90000' }, btc))
      .toThrow(OrderBuildError)
  })
  it('没有记录时用规范化后的原值', () => {
    const [order] = buildProtectionOrders({ symbol: 'BTCUSDT', holdSide: 'long', size: '0.01000', stopLossPrice: '90000' })
    expect(order!.body['size']).toBe('0.01')
  })
  it('负数量 → PRECISION', () => {
    expect(() => buildProtectionOrders({ symbol: 'BTCUSDT', holdSide: 'long', size: '-1', stopLossPrice: '90000' })).toThrow(OrderBuildError)
  })
})
