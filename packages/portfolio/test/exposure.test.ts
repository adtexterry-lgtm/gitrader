// SPDX-License-Identifier: CPAL-1.0
// 敞口：跨场所按资产互抵、按场所/方向拆分，gross 与 net 的区别是重点。
import { describe, expect, it } from 'vitest'
import { exposureByAsset, exposureByDirection, exposureByInstrument, exposureByVenue, exposureOf } from '../src/index'
import { makeValued } from './factories'

function book() {
  return [
    makeValued({ signedExposure: '80000', base: 'BTC', venue: 'binance', instrumentId: 'binance:BTCUSDT', baseQuantity: '2' }),
    makeValued({ signedExposure: '-20000', base: 'BTC', venue: 'bybit', instrumentId: 'bybit:BTCUSDT', baseQuantity: '-0.5' }),
    makeValued({ signedExposure: '3000', base: 'ETH', venue: 'okx', instrumentId: 'okx:ETHUSDT', baseQuantity: '1' }),
  ]
}

describe('exposureByAsset', () => {
  it('同一资产跨场所多空互抵：net 60000，gross 100000，币量 1.5', () => {
    const buckets = exposureByAsset(book())
    expect(buckets.map((bucket) => bucket.key)).toEqual(['BTC', 'ETH'])
    const btc = buckets[0]!
    expect(btc.gross).toBe('100000')
    expect(btc.net).toBe('60000')
    expect(btc.long).toBe('80000')
    expect(btc.short).toBe('20000')
    expect(btc.quantity).toBe('1.5')
    expect(btc.positionCount).toBe(2)
    const eth = buckets[1]!
    expect(eth.gross).toBe('3000')
    expect(eth.quantity).toBe('1')
  })

  it('多空完全对冲时 net = 0 但 gross 不为 0', () => {
    const buckets = exposureByAsset([
      makeValued({ signedExposure: '500', base: 'SOL' }),
      makeValued({ signedExposure: '-500', base: 'SOL' }),
    ])
    expect(buckets).toHaveLength(1)
    expect(buckets[0]!.net).toBe('0')
    expect(buckets[0]!.gross).toBe('1000')
    expect(buckets[0]!.quantity).toBe('0')
  })

  it('按 gross 降序、同值按键名升序（排序确定，便于快照）', () => {
    const buckets = exposureByAsset([
      makeValued({ signedExposure: '500', base: 'ZEC' }),
      makeValued({ signedExposure: '500', base: 'ADA' }),
      makeValued({ signedExposure: '900', base: 'BTC' }),
    ])
    expect(buckets.map((bucket) => bucket.key)).toEqual(['BTC', 'ADA', 'ZEC'])
  })
})

describe('exposureByInstrument', () => {
  it('同一标的跨账户多空合并：净额 3000，毛额 5000；不同标的各成一桶', () => {
    const buckets = exposureByInstrument([
      makeValued({ signedExposure: '4000', instrumentId: 'bybit:BTCUSDT', venue: 'bybit', base: 'BTC' }),
      makeValued({ signedExposure: '-1000', instrumentId: 'bybit:BTCUSDT', venue: 'bybit', base: 'BTC' }),
      makeValued({ signedExposure: '900', instrumentId: 'okx:ETHUSDT', venue: 'okx', base: 'ETH' }),
    ])
    expect(buckets.map((bucket) => `${bucket.key}:${bucket.net}`)).toEqual(['bybit:BTCUSDT:3000', 'okx:ETHUSDT:900'])
    expect(buckets[0]!.gross).toBe('5000')
    expect(buckets[0]!.positionCount).toBe(2)
  })
})

describe('exposureByVenue / exposureByDirection', () => {
  it('按场所拆分，各自带币量与笔数', () => {
    const buckets = exposureByVenue(book())
    expect(buckets.map((bucket) => bucket.key)).toEqual(['binance', 'bybit', 'okx'])
    expect(buckets.map((bucket) => bucket.gross)).toEqual(['80000', '20000', '3000'])
    expect(buckets[1]!.quantity).toBe('-0.5')
    expect(buckets[1]!.positionCount).toBe(1)
  })

  it('方向汇总：long 83000 / short 20000 / net 63000 / gross 103000', () => {
    expect(exposureByDirection(book())).toEqual({
      long: '83000',
      short: '20000',
      net: '63000',
      gross: '103000',
    })
  })

  it('总桶等于各维度之和', () => {
    const report = exposureOf(book())
    expect(report.totals).toMatchObject({ key: 'total', gross: '103000', net: '63000', positionCount: 3 })
    expect(report.byAsset).toEqual(exposureByAsset(book()))
    expect(report.byVenue).toEqual(exposureByVenue(book()))
    expect(report.byInstrument).toEqual(exposureByInstrument(book()))
    expect(report.byDirection.gross).toBe(report.totals.gross)
  })
})

describe('空组合', () => {
  it('空持仓：零值 + 空数组，不抛错', () => {
    const report = exposureOf([])
    expect(report.totals).toEqual({ key: 'total', gross: '0', net: '0', long: '0', short: '0', quantity: '0', positionCount: 0 })
    expect(report.byAsset).toEqual([])
    expect(report.byVenue).toEqual([])
    expect(report.byDirection).toEqual({ long: '0', short: '0', net: '0', gross: '0' })
  })
})
