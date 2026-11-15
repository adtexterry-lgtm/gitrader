// SPDX-License-Identifier: CPAL-1.0
// 端到端：合成两笔跨场所持仓，四块报表必须互相自洽（估值 -> 敞口 -> 归因 -> 集中度）。
import { describe, expect, it } from 'vitest'
import type { AccountId } from '@gitrader/protocol'
import { addDec } from '@gitrader/protocol/decimal'
import { PortfolioError, analyzePortfolio, staticPriceSource } from '../src/index'
import type { PortfolioInput } from '../src/index'
import { D, capturePortfolioError, makeInstrument, makePosition } from './factories'

const INSTRUMENTS = [
  makeInstrument({ instrumentId: 'binance:BTCUSDT', venue: 'binance', base: 'BTC', quote: 'USDT', kind: 'spot' }),
  makeInstrument({
    instrumentId: 'bybit:ETHUSDT',
    venue: 'bybit',
    base: 'ETH',
    quote: 'USDT',
    kind: 'perp',
    contractSize: D('0.01'),
    venueSizeUnit: 'contract',
  }),
]

const PRICES = staticPriceSource({ 'binance:BTCUSDT': '40000', 'bybit:ETHUSDT': '3000' })

function input(overrides: Partial<PortfolioInput> = {}): PortfolioInput {
  return {
    positions: [
      makePosition({
        accountId: 'acct_a1' as AccountId,
        instrumentId: 'binance:BTCUSDT',
        side: 'long',
        size: D('1'),
        entryPrice: D('30000'),
        markPrice: D('40000'),
        unrealizedPnl: D('10000'),
        realizedPnl: D('50'),
      }),
      makePosition({
        accountId: 'acct_b1' as AccountId,
        instrumentId: 'bybit:ETHUSDT',
        side: 'short',
        size: D('50'),
        entryPrice: D('4000'),
        markPrice: D('3000'),
        unrealizedPnl: D('500'),
        realizedPnl: D('0'),
        fundingSinceOpen: D('-1'),
      }),
    ],
    instruments: INSTRUMENTS,
    valuationCcy: 'USD',
    prices: PRICES,
    fx: { 'USDT/USD': '1' },
    strategyTags: { acct_a1: 'trend', acct_b1: 'carry' },
    ...overrides,
  }
}

describe('analyzePortfolio', () => {
  it('四块报表在同一份合成数据上互相自洽', () => {
    const analysis = analyzePortfolio(input())

    // 估值
    expect(analysis.valuation.grossExposure).toBe('41500')
    expect(analysis.valuation.netExposure).toBe('38500')
    expect(analysis.valuation.cost).toBe('32000')
    expect(analysis.valuation.unrealizedPnl).toBe('10500')

    // 敞口
    expect(analysis.exposure.totals.gross).toBe('41500')
    expect(analysis.exposure.byAsset.map((bucket) => `${bucket.key}:${bucket.net}`)).toEqual(['BTC:40000', 'ETH:-1500'])
    expect(analysis.exposure.byVenue.map((bucket) => `${bucket.key}:${bucket.gross}`)).toEqual(['binance:40000', 'bybit:1500'])
    expect(analysis.exposure.byDirection).toEqual({ long: '40000', short: '1500', net: '38500', gross: '41500' })

    // 归因：trend = 50 + 10000 + 0；carry = 0 + 500 − 1
    expect(analysis.attribution.byStrategy.map((bucket) => `${bucket.key}:${bucket.total}`)).toEqual(['trend:10050', 'carry:499'])
    expect(analysis.attribution.total.total).toBe('10549')

    // 集中度：BTC 40000 / 41500
    expect(analysis.concentration.byAsset.largest).toEqual({ key: 'BTC', exposure: '40000', weight: '0.96385542' })
    expect(analysis.concentration.byAsset.hhi).toBe('0.9303237')
    expect(analysis.concentration.byAsset.effectiveN).toBe('1.07489468')
  })

  it('归因总额 = 已实现 + 未实现 + 资金费（不重不漏）', () => {
    const analysis = analyzePortfolio(input())
    const rebuilt = addDec(addDec(analysis.valuation.realizedPnl, analysis.valuation.unrealizedPnl), analysis.valuation.funding)
    expect(rebuilt).toBe(analysis.attribution.total.total)
    expect(rebuilt).toBe('10549')
  })

  it('估值出错时原样抛出 PortfolioError（不返回半截报表）', () => {
    const error = capturePortfolioError(() => analyzePortfolio(input({ instruments: [] })))
    expect(error).toBeInstanceOf(PortfolioError)
    expect(error.code).toBe('valuation_failed')
    expect(error.details).toHaveLength(2)
  })
})
