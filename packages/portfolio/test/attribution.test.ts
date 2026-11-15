// SPDX-License-Identifier: CPAL-1.0
// 盈亏归因：按策略/场所/标的拆已实现+未实现+资金费；桶之和必须等于 total。
import { describe, expect, it } from 'vitest'
import { addDec } from '@gitrader/protocol/decimal'
import { attributionByInstrument, attributionByStrategy, attributionByVenue, attributionOf } from '../src/index'
import { makeValued } from './factories'

function book() {
  return [
    makeValued({
      signedExposure: '80000',
      base: 'BTC',
      venue: 'binance',
      instrumentId: 'binance:BTCUSDT',
      strategyId: 'trend',
      realizedPnl: '100',
      unrealizedPnl: '20000',
      venueUnrealizedPnl: '20000',
      funding: '0',
    }),
    makeValued({
      signedExposure: '-20000',
      base: 'BTC',
      venue: 'bybit',
      instrumentId: 'bybit:BTCUSDT',
      strategyId: 'carry',
      realizedPnl: '-25',
      unrealizedPnl: '3000',
      venueUnrealizedPnl: '2900',
      funding: '-3',
    }),
    makeValued({
      signedExposure: '3000',
      base: 'ETH',
      venue: 'okx',
      instrumentId: 'okx:ETHUSDT',
      strategyId: 'trend',
      realizedPnl: '0',
      unrealizedPnl: '500',
      venueUnrealizedPnl: '500',
      funding: '1.5',
    }),
  ]
}

describe('attributionByStrategy', () => {
  it('同策略跨场所合并：trend 已实现 100 / 未实现 20500 / 资金费 1.5', () => {
    const buckets = attributionByStrategy(book())
    expect(buckets.map((bucket) => bucket.key)).toEqual(['trend', 'carry'])
    const trend = buckets[0]!
    expect(trend.realized).toBe('100')
    expect(trend.unrealized).toBe('20500')
    expect(trend.funding).toBe('1.5')
    expect(trend.total).toBe('20601.5')
    expect(trend.positionCount).toBe(2)
    const carry = buckets[1]!
    expect(carry.realized).toBe('-25')
    expect(carry.unrealized).toBe('3000')
    expect(carry.funding).toBe('-3')
    expect(carry.total).toBe('2972')
  })

  it('没有标签的持仓落到 unassigned 桶，且不被静默丢掉', () => {
    const buckets = attributionByStrategy([...book(), makeValued({ signedExposure: '10', strategyId: 'unassigned', unrealizedPnl: '5' })])
    const unassigned = buckets.find((bucket) => bucket.key === 'unassigned')
    expect(unassigned).toBeDefined()
    expect(unassigned!.unrealized).toBe('5')
    expect(unassigned!.total).toBe('5')
  })

  it('按 total 降序排列', () => {
    expect(attributionByStrategy(book()).map((bucket) => bucket.key)).toEqual(['trend', 'carry'])
  })
})

describe('attributionByVenue / byInstrument', () => {
  it('按场所归因逐字段精确', () => {
    const buckets = attributionByVenue(book())
    expect(buckets.map((bucket) => bucket.key)).toEqual(['binance', 'bybit', 'okx'])
    expect(buckets[0]!.total).toBe('20100')
    expect(buckets[1]!.total).toBe('2972')
    expect(buckets[2]!.total).toBe('501.5')
  })

  it('按标的归因：三个标的各一桶，按 total 降序', () => {
    const buckets = attributionByInstrument(book())
    expect(buckets.map((bucket) => bucket.key)).toEqual(['binance:BTCUSDT', 'bybit:BTCUSDT', 'okx:ETHUSDT'])
    expect(buckets.map((bucket) => bucket.total)).toEqual(['20100', '2972', '501.5'])
  })
})

describe('不变式与对账', () => {
  it('任何维度的桶之和都等于 total（8 位小数下精确相等）', () => {
    const report = attributionOf(book())
    expect(report.total.total).toBe('23573.5')
    for (const dimension of [report.byStrategy, report.byVenue, report.byInstrument]) {
      // 求和走协议自己的十进制加法（独立于本包的聚合代码），全程不碰浮点。
      const sum = dimension.reduce((acc, bucket) => addDec(acc, bucket.total), '0')
      expect(sum).toBe(report.total.total)
    }
  })

  it('drift = 注入价重算的未实现 − 场所上报的未实现', () => {
    const report = attributionOf(book())
    const bybit = report.byVenue.find((bucket) => bucket.key === 'bybit')!
    expect(bybit.unrealized).toBe('3000')
    expect(bybit.venueUnrealized).toBe('2900')
    expect(bybit.drift).toBe('100')
    expect(report.total.drift).toBe('100')
  })

  it('total 含资金费：缺了资金费就会差 3', () => {
    const report = attributionOf(book())
    expect(report.total.realized).toBe('75')
    expect(report.total.unrealized).toBe('23500')
    expect(report.total.funding).toBe('-1.5')
    expect(report.total.total).toBe('23573.5')
  })

  it('空持仓：单桶零值', () => {
    expect(attributionOf([]).total).toEqual({
      key: 'total',
      realized: '0',
      unrealized: '0',
      funding: '0',
      total: '0',
      venueUnrealized: '0',
      drift: '0',
      positionCount: 0,
    })
    expect(attributionOf([]).byStrategy).toEqual([])
  })
})
