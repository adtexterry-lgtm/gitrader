// SPDX-License-Identifier: CPAL-1.0
// 估值：注入定价、汇率折算、以及「读不到就报错，绝不当 0」的边界。
import { describe, expect, it } from 'vitest'
import type { AccountId } from '@gitrader/protocol'
import { PortfolioError, fxRate, resolveStrategy, staticPriceSource, valuePositions } from '../src/index'
import type { PortfolioInput, PriceSource } from '../src/index'
import { D, capturePortfolioError, makeInstrument, makePosition } from './factories'

const INSTRUMENTS = [
  makeInstrument({ instrumentId: 'binance:BTCUSDT', venue: 'binance', base: 'BTC', quote: 'USDT', kind: 'spot' }),
  makeInstrument({ instrumentId: 'bybit:BTCUSDT', venue: 'bybit', base: 'BTC', quote: 'USDT', kind: 'perp', contractSize: D('0.001'), venueSizeUnit: 'contract' }),
  makeInstrument({ instrumentId: 'okx:ETHUSDT', venue: 'okx', base: 'ETH', quote: 'USDT', kind: 'perp', contractSize: D('0.01'), venueSizeUnit: 'contract' }),
]

const PRICES = staticPriceSource({
  'binance:BTCUSDT': '40000',
  'bybit:BTCUSDT': '40000',
  'okx:ETHUSDT': '3000',
})

function p1() {
  // 现货 2 BTC：成本 60000，市值 80000，多单浮盈 20000。
  return makePosition({
    accountId: 'acct_a1' as AccountId,
    instrumentId: 'binance:BTCUSDT',
    side: 'long',
    size: D('2'),
    entryPrice: D('30000'),
    // 故意填一个和注入价不同的值：估值必须用注入价。
    markPrice: D('99999'),
    unrealizedPnl: D('20000'),
    realizedPnl: D('100'),
  })
}

function p2() {
  // 永续空头 500 张 × 0.001 = 0.5 BTC：入场 46000，标记 40000，浮盈 0.5 × 6000 = 3000。
  return makePosition({
    accountId: 'acct_b1' as AccountId,
    instrumentId: 'bybit:BTCUSDT',
    side: 'short',
    size: D('500'),
    entryPrice: D('46000'),
    markPrice: D('40000'),
    unrealizedPnl: D('3000'),
    realizedPnl: D('-25'),
    fundingSinceOpen: D('-3'),
  })
}

function p3() {
  // 永续多头 100 张 × 0.01 = 1 ETH：入场 2500，标记 3000，浮盈 500。
  return makePosition({
    accountId: 'acct_c1' as AccountId,
    instrumentId: 'okx:ETHUSDT',
    side: 'long',
    size: D('100'),
    entryPrice: D('2500'),
    markPrice: D('3000'),
    unrealizedPnl: D('500'),
    fundingSinceOpen: D('1.5'),
  })
}

function input(overrides: Partial<PortfolioInput> = {}): PortfolioInput {
  return {
    positions: [p1(), p2(), p3()],
    instruments: INSTRUMENTS,
    valuationCcy: 'USD',
    prices: PRICES,
    fx: { 'USDT/USD': '1' },
    ...overrides,
  }
}

describe('valuePositions · 单笔', () => {
  it('多头现货：名义、成本、浮盈、方向敞口逐字段精确', () => {
    const result = valuePositions(input({ positions: [p1()] }))
    expect(result.positions).toHaveLength(1)
    const valued = result.positions[0]!
    expect(valued.base).toBe('BTC')
    expect(valued.quote).toBe('USDT')
    expect(valued.baseQuantity).toBe('2')
    expect(valued.markPrice).toBe('40000')
    expect(valued.markPriceValuation).toBe('40000')
    expect(valued.cost).toBe('60000')
    expect(valued.grossExposure).toBe('80000')
    expect(valued.signedExposure).toBe('80000')
    expect(valued.unrealizedPnl).toBe('20000')
    expect(valued.realizedPnl).toBe('100')
    expect(result.cost).toBe('60000')
    expect(result.grossExposure).toBe('80000')
    expect(result.netExposure).toBe('80000')
    expect(result.unrealizedPnl).toBe('20000')
  })

  it('空头永续：按 contractSize 折基础数量，浮盈方向取反', () => {
    const result = valuePositions(input({ positions: [p2()] }))
    const valued = result.positions[0]!
    expect(valued.contractSize).toBe('0.001')
    expect(valued.baseQuantity).toBe('-0.5')
    expect(valued.cost).toBe('23000')
    expect(valued.grossExposure).toBe('20000')
    expect(valued.signedExposure).toBe('-20000')
    expect(valued.unrealizedPnl).toBe('3000')
    expect(valued.funding).toBe('-3')
    expect(result.netExposure).toBe('-20000')
    expect(result.grossExposure).toBe('20000')
  })

  it('注入价优先于 Position.markPrice（场所字段不参与估值）', () => {
    const valued = valuePositions(input({ positions: [p1()] })).positions[0]!
    expect(valued.markPrice).toBe('40000')
    expect(valued.markPrice).not.toBe('99999')
  })
})

describe('valuePositions · 按 venueSizeUnit 折基础数量', () => {
  // 同一组数据只改 venueSizeUnit：数量 2、面值 0.01、注入价 3000。
  function valued(venueSizeUnit: 'base' | 'contract') {
    const instrument = makeInstrument({
      instrumentId: 'data:ETHUSDT',
      venue: 'data',
      base: 'ETH',
      quote: 'USDT',
      kind: 'perp',
      contractSize: D('0.01'),
      venueSizeUnit,
    })
    const position = makePosition({ instrumentId: 'data:ETHUSDT', size: D('2'), entryPrice: D('1000') })
    return valuePositions({
      positions: [position],
      instruments: [instrument],
      valuationCcy: 'USD',
      prices: staticPriceSource({ 'data:ETHUSDT': '3000' }),
      fx: { 'USDT/USD': '1' },
    }).positions[0]!
  }

  it("venueSizeUnit: 'base'：基础数量就是 size，contractSize 只作展示", () => {
    const position = valued('base')
    expect(position.contractSize).toBe('0.01')
    expect(position.baseQuantity).toBe('2')
    expect(position.grossExposure).toBe('6000')
  })

  it("venueSizeUnit: 'contract'：基础数量 = size × contractSize", () => {
    const position = valued('contract')
    expect(position.contractSize).toBe('0.01')
    expect(position.baseQuantity).toBe('0.02')
    expect(position.grossExposure).toBe('60')
  })
})

describe('valuePositions · 跨场所合计与汇率', () => {
  it('三笔跨三场所：总成本 / 总名义 / 净敞口 / 浮盈 / 已实现 / 资金费', () => {
    const result = valuePositions(input())
    expect(result.valuationCcy).toBe('USD')
    expect(result.positions).toHaveLength(3)
    expect(result.cost).toBe('85500')
    expect(result.grossExposure).toBe('103000')
    expect(result.netExposure).toBe('63000')
    expect(result.unrealizedPnl).toBe('23500')
    expect(result.realizedPnl).toBe('75')
    expect(result.funding).toBe('-1.5')
  })

  it('报价币与计价币不同：按注入汇率折算每个金额字段', () => {
    const result = valuePositions(input({ fx: { 'USDT/USD': '0.5' }, positions: [p1()] }))
    const valued = result.positions[0]!
    expect(valued.markPrice).toBe('40000')
    expect(valued.markPriceValuation).toBe('20000')
    expect(valued.cost).toBe('30000')
    expect(valued.grossExposure).toBe('40000')
    expect(valued.unrealizedPnl).toBe('10000')
    expect(valued.realizedPnl).toBe('50')
    expect(result.grossExposure).toBe('40000')
  })

  it('只给反向汇率对时取倒数（USD/USDT = 2 ⇒ USDT→USD = 0.5）', () => {
    const result = valuePositions(input({ fx: { 'USD/USDT': '2' }, positions: [p1()] }))
    expect(result.positions[0]!.markPriceValuation).toBe('20000')
    expect(result.grossExposure).toBe('40000')
  })

  it('报价币等于计价币时不需要汇率表', () => {
    const result = valuePositions(input({ valuationCcy: 'USDT', fx: undefined, positions: [p1()] }))
    expect(result.grossExposure).toBe('80000')
    expect(fxRate(undefined, 'USDT', 'USDT')).toBe('1')
  })

  it('已实现盈亏与资金费同样按汇率折算', () => {
    const result = valuePositions(input({ fx: { 'USDT/USD': '0.5' }, positions: [p2()] }))
    expect(result.positions[0]!.realizedPnl).toBe('-12.5')
    expect(result.positions[0]!.funding).toBe('-1.5')
    expect(result.realizedPnl).toBe('-12.5')
    expect(result.funding).toBe('-1.5')
  })
})

describe('valuePositions · 数据缺口必须显式', () => {
  it('缺价缺省报错，并列出全部缺价标的（不静默当 0）', () => {
    const prices = staticPriceSource({ 'binance:BTCUSDT': '40000' })
    const error = capturePortfolioError(() => valuePositions(input({ prices })))
    expect(error.code).toBe('valuation_failed')
    expect(error.message).toContain('2 problem(s)')
    expect(error.details).toEqual(['missing_price: bybit:BTCUSDT', 'missing_price: okx:ETHUSDT'])
  })

  it("onMissingPrice: 'skip' 只跳过缺价那笔，列进 unpriced，合计不含它", () => {
    const prices = staticPriceSource({ 'binance:BTCUSDT': '40000' })
    const result = valuePositions(input({ prices, onMissingPrice: 'skip' }))
    expect(result.positions).toHaveLength(1)
    expect(result.unpriced).toEqual(['bybit:BTCUSDT', 'okx:ETHUSDT'])
    expect(result.grossExposure).toBe('80000')
    expect(result.unrealizedPnl).toBe('20000')
  })

  it('价格返回 0 按缺价处理（0 不是价格）', () => {
    const zero: PriceSource = { price: () => D('0') }
    const error = capturePortfolioError(() => valuePositions(input({ prices: zero, positions: [p1()] })))
    expect(error.details).toEqual(['missing_price: binance:BTCUSDT'])
  })

  it('缺汇率报错，不默认按 1 折算', () => {
    const error = capturePortfolioError(() => valuePositions(input({ valuationCcy: 'EUR', fx: { 'USDT/USD': '1' } })))
    expect(error.code).toBe('valuation_failed')
    expect(error.details).toEqual(['missing_fx: USDT/EUR'])
  })

  it('汇率表里的 0 / 负值直接拒绝', () => {
    expect(() => valuePositions(input({ fx: { 'USDT/USD': '0' } }))).toThrow(PortfolioError)
    expect(() => fxRate({ 'USDT/USD': '0' }, 'USDT', 'USD')).toThrow(PortfolioError)
  })

  it('未知标的报错', () => {
    const error = capturePortfolioError(() => valuePositions(input({ instruments: [] })))
    expect(error.details).toEqual([
      'unknown_instrument: binance:BTCUSDT',
      'unknown_instrument: bybit:BTCUSDT',
      'unknown_instrument: okx:ETHUSDT',
    ])
  })

  it('反向结算（inverse）直接拒绝，不做半吊子折算', () => {
    const instruments = [makeInstrument({ instrumentId: 'binance:BTCUSDT', settlement: 'inverse' })]
    const error = capturePortfolioError(() => valuePositions(input({ instruments, positions: [p1()] })))
    expect(error.details).toEqual(['unsupported_settlement: binance:BTCUSDT (inverse)'])
  })

  it('同一 (账户, 标的, 方向) 重复持仓报错，防止重复计账', () => {
    const error = capturePortfolioError(() => valuePositions(input({ positions: [p1(), p1()] })))
    expect(error.details).toEqual(['duplicate_position: acct_a1|binance:BTCUSDT|long'])
  })

  it('size 非正数报错', () => {
    const bad = makePosition({ instrumentId: 'binance:BTCUSDT', size: D('0') })
    const error = capturePortfolioError(() => valuePositions(input({ positions: [bad] })))
    expect(error.details).toEqual(['invalid_position: binance:BTCUSDT size must be positive, got 0'])
  })

  it('同一标的多空并存是合法的（对冲），不报重复', () => {
    const hedge = makePosition({
      accountId: 'acct_a1' as AccountId,
      instrumentId: 'binance:BTCUSDT',
      side: 'short',
      size: D('1'),
      entryPrice: D('41000'),
    })
    const result = valuePositions(input({ positions: [p1(), hedge] }))
    expect(result.positions).toHaveLength(2)
    expect(result.netExposure).toBe('40000')
    expect(result.grossExposure).toBe('120000')
  })
})

describe('注入的价格源', () => {
  it('staticPriceSource 非数 / 非正价格构造期就抛', () => {
    expect(() => staticPriceSource({ 'binance:BTCUSDT': 'abc' })).toThrow(TypeError)
    expect(() => staticPriceSource({ 'binance:BTCUSDT': '0' })).toThrow(TypeError)
    expect(staticPriceSource({ X: '1.5' }).price('X')).toBe('1.5')
    expect(staticPriceSource({ X: '1.5' }).price('Y')).toBeUndefined()
  })

  it('fxRate 缺对时报错', () => {
    const error = capturePortfolioError(() => fxRate({ 'USDT/USD': '1' }, 'USDT', 'JPY'))
    expect(error.code).toBe('missing_fx')
  })
})

describe('策略标签解析', () => {
  it('精确键 > 账户键 > unassigned', () => {
    const tags = { acct_a1: 'trend', 'acct_a1|binance:BTCUSDT': 'carry' }
    expect(resolveStrategy(tags, 'acct_a1', 'binance:BTCUSDT')).toBe('carry')
    expect(resolveStrategy(tags, 'acct_a1', 'okx:XRPUSDT')).toBe('trend')
    expect(resolveStrategy(tags, 'acct_z9', 'okx:XRPUSDT')).toBe('unassigned')
    expect(resolveStrategy(undefined, 'acct_a1', 'okx:XRPUSDT')).toBe('unassigned')
  })

  it('估值结果带上解析后的策略 id', () => {
    const result = valuePositions(input({ strategyTags: { acct_a1: 'trend', acct_b1: 'carry' } }))
    const byStrategy = result.positions.map((position) => `${position.accountId}:${position.strategyId}`)
    expect(byStrategy).toEqual(['acct_a1:trend', 'acct_b1:carry', 'acct_c1:unassigned'])
  })
})
