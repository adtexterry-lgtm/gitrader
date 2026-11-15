// SPDX-License-Identifier: CPAL-1.0
// 集中度：HHI / 等效持仓数 / 前 N 大占比，口径是**绝对敞口**（多空都算正）。
import { describe, expect, it } from 'vitest'
import { concentration, concentrationOf } from '../src/index'
import { makeValued } from './factories'

describe('HHI 与等效持仓数', () => {
  it('单一标的：HHI = 1，等效持仓数 = 1', () => {
    const report = concentration([makeValued({ signedExposure: '1000', base: 'BTC' })], 'asset')
    expect(report.gross).toBe('1000')
    expect(report.hhi).toBe('1')
    expect(report.effectiveN).toBe('1')
    expect(report.top1).toBe('1')
    expect(report.largest).toEqual({ key: 'BTC', exposure: '1000', weight: '1' })
  })

  it('四个等额标的：HHI = 0.25，等效持仓数 = 4，前三占 0.75', () => {
    const positions = ['A', 'B', 'C', 'D'].map((base) => makeValued({ signedExposure: '100', base }))
    const report = concentration(positions, 'asset')
    expect(report.gross).toBe('400')
    expect(report.hhi).toBe('0.25')
    expect(report.effectiveN).toBe('4')
    expect(report.top1).toBe('0.25')
    expect(report.top3).toBe('0.75')
    expect(report.top5).toBe('1')
    expect(report.buckets.map((bucket) => bucket.key)).toEqual(['A', 'B', 'C', 'D'])
    expect(report.buckets.map((bucket) => bucket.weight)).toEqual(['0.25', '0.25', '0.25', '0.25'])
  })

  it('75000 / 25000 两桶：HHI = 0.625，等效持仓数 = 1.6', () => {
    const report = concentration(
      [makeValued({ signedExposure: '75000', base: 'BTC' }), makeValued({ signedExposure: '25000', base: 'ETH' })],
      'asset',
    )
    expect(report.hhi).toBe('0.625')
    expect(report.effectiveN).toBe('1.6')
    expect(report.top1).toBe('0.75')
    expect(report.top3).toBe('1')
  })

  it('三个等额标的：权重 0.33333333，HHI ≈ 1/3，等效持仓数 3', () => {
    const positions = ['A', 'B', 'C'].map((base) => makeValued({ signedExposure: '100', base }))
    const report = concentration(positions, 'asset')
    expect(report.buckets.map((bucket) => bucket.weight)).toEqual(['0.33333333', '0.33333333', '0.33333333'])
    expect(report.hhi).toBe('0.33333333')
    expect(report.effectiveN).toBe('3')
    expect(report.top3).toBe('1')
  })
})

describe('口径反证：必须用绝对敞口，不能用净敞口', () => {
  it('同一标的多空各 100：净敞口为 0，但集中度必须是「全压一个标的」', () => {
    const book = [
      makeValued({ signedExposure: '100', base: 'BTC', side: 'long' }),
      makeValued({ signedExposure: '-100', base: 'BTC', side: 'short' }),
    ]
    const report = concentration(book, 'asset')
    expect(report.gross).toBe('200')
    expect(report.buckets).toHaveLength(1)
    expect(report.hhi).toBe('1')
    expect(report.effectiveN).toBe('1')
    expect(report.top1).toBe('1')
  })
})

describe('维度与空组合', () => {
  it('按场所 / 标的 / 策略分组，键名取自对应字段', () => {
    const book = [
      makeValued({ signedExposure: '600', venue: 'binance', instrumentId: 'binance:BTCUSDT', strategyId: 'trend' }),
      makeValued({ signedExposure: '400', venue: 'bybit', instrumentId: 'bybit:ETHUSDT', strategyId: 'carry' }),
    ]
    expect(concentration(book, 'venue').buckets.map((bucket) => bucket.key)).toEqual(['binance', 'bybit'])
    expect(concentration(book, 'instrument').buckets.map((bucket) => bucket.key)).toEqual(['binance:BTCUSDT', 'bybit:ETHUSDT'])
    expect(concentration(book, 'strategy').buckets.map((bucket) => bucket.key)).toEqual(['trend', 'carry'])
    expect(concentration(book, 'venue').hhi).toBe('0.52')
  })

  it('concentrationOf 一次给四个维度', () => {
    const report = concentrationOf([makeValued({ signedExposure: '100', base: 'BTC', venue: 'binance', strategyId: 'trend' })])
    expect(report.byAsset.hhi).toBe('1')
    expect(report.byVenue.hhi).toBe('1')
    expect(report.byInstrument.hhi).toBe('1')
    expect(report.byStrategy.hhi).toBe('1')
  })

  it('空组合：零值、无最大桶，不抛错', () => {
    const report = concentration([], 'asset')
    expect(report.gross).toBe('0')
    expect(report.hhi).toBe('0')
    expect(report.effectiveN).toBe('0')
    expect(report.top1).toBe('0')
    expect(report.top3).toBe('0')
    expect(report.top5).toBe('0')
    expect(report.largest).toBeNull()
    expect(report.buckets).toEqual([])
  })
})
