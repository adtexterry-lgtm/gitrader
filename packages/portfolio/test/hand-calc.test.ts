// SPDX-License-Identifier: CPAL-1.0
// 收口复核：敞口与盈亏归因各两组手算独立用例（端到端：协议 Position + Instrument + 注入价 + 汇率）。
// 期望值全部在注释里逐步手算，不调用包内任何函数生成；与 analysis / valuation 用例的数据集互不重叠。
import { describe, expect, it } from 'vitest'
import type { AccountId } from '@gitrader/protocol'
import { analyzePortfolio, staticPriceSource } from '../src/index'
import type { PortfolioInput } from '../src/index'
import { D, makeInstrument, makePosition } from './factories'

// 组 1：两种报价币（USDT 直连、USDC 直连）、三个场所、多空混合、contractSize 0.1。
//   USDT->USD 0.999；USDC->USD 1.001。
//   p1 acct1 okx BTC 多 0.5 @58000，注入价 60000：标记(USD) 60000×0.999 = 59940；名义 0.5×59940 = 29970
//   p2 acct2 HL  BTC 空 0.2 @61000，注入价 60100：标记(USD) 60100×1.001 = 60160.1；名义 0.2×60160.1 = 12032.02
//   p3 acct1 binance ETH 空 30 张 × 0.1 = 3 ETH @2400，注入价 2500：标记(USD) 2497.5；名义 3×2497.5 = 7492.5
function group1(): PortfolioInput {
  return {
    instruments: [
      makeInstrument({ instrumentId: 'okx:BTC-USDT-SWAP', venue: 'okx', base: 'BTC', quote: 'USDT' }),
      makeInstrument({ instrumentId: 'hyperliquid:BTC', venue: 'hyperliquid', base: 'BTC', quote: 'USDC' }),
      makeInstrument({ instrumentId: 'binance:ETHUSDT', venue: 'binance', base: 'ETH', quote: 'USDT', contractSize: D('0.1'), venueSizeUnit: 'contract' }),
    ],
    positions: [
      makePosition({ accountId: 'acct1' as AccountId, instrumentId: 'okx:BTC-USDT-SWAP', side: 'long', size: D('0.5'), entryPrice: D('58000'), realizedPnl: D('120'), fundingSinceOpen: D('-4'), unrealizedPnl: D('1000') }),
      makePosition({ accountId: 'acct2' as AccountId, instrumentId: 'hyperliquid:BTC', side: 'short', size: D('0.2'), entryPrice: D('61000'), realizedPnl: D('-50'), fundingSinceOpen: D('2'), unrealizedPnl: D('175') }),
      makePosition({ accountId: 'acct1' as AccountId, instrumentId: 'binance:ETHUSDT', side: 'short', size: D('30'), entryPrice: D('2400'), realizedPnl: D('10'), unrealizedPnl: D('-300') }),
    ],
    valuationCcy: 'USD',
    prices: staticPriceSource({ 'okx:BTC-USDT-SWAP': '60000', 'hyperliquid:BTC': '60100', 'binance:ETHUSDT': '2500' }),
    fx: { 'USDT/USD': '0.999', 'USDC/USD': '1.001' },
    strategyTags: { 'acct1|okx:BTC-USDT-SWAP': 'trend', acct1: 'meanrev', acct2: 'carry' },
  }
}

// 组 2：只给反向汇率对 USD/USDT = 1.25（USDT->USD = 0.8）；同一标的跨账户对冲；第二个标的报价币即计价币。
//   q1 acct1 bybit SOL 多 100 @140，注入价 150：标记(USD) 120；名义 12000
//   q2 acct2 bybit SOL 空 40 @155：名义 40×120 = 4800
//   q3 acct1 kraken ETH 多 250 张 × 0.01 = 2.5 ETH @3200，注入价 3000（USD，汇率 1）：名义 7500
function group2(): PortfolioInput {
  return {
    instruments: [
      makeInstrument({ instrumentId: 'bybit:SOLUSDT', venue: 'bybit', base: 'SOL', quote: 'USDT' }),
      makeInstrument({ instrumentId: 'kraken:ETHUSD', venue: 'kraken', base: 'ETH', quote: 'USD', contractSize: D('0.01'), venueSizeUnit: 'contract' }),
    ],
    positions: [
      makePosition({ accountId: 'acct1' as AccountId, instrumentId: 'bybit:SOLUSDT', side: 'long', size: D('100'), entryPrice: D('140'), realizedPnl: D('25'), fundingSinceOpen: D('-2.5') }),
      makePosition({ accountId: 'acct2' as AccountId, instrumentId: 'bybit:SOLUSDT', side: 'short', size: D('40'), entryPrice: D('155'), realizedPnl: D('-10'), fundingSinceOpen: D('1.25') }),
      makePosition({ accountId: 'acct1' as AccountId, instrumentId: 'kraken:ETHUSD', side: 'long', size: D('250'), entryPrice: D('3200'), fundingSinceOpen: D('-0.75') }),
    ],
    valuationCcy: 'USD',
    prices: staticPriceSource({ 'bybit:SOLUSDT': '150', 'kraken:ETHUSD': '3000' }),
    fx: { 'USD/USDT': '1.25' },
    strategyTags: { acct1: 'grid', acct2: 'grid', 'acct1|kraken:ETHUSD': 'trend' },
  }
}

describe('手算 · 敞口', () => {
  it('组 1：资产 / 场所 / 方向 / 总桶', () => {
    const { exposure } = analyzePortfolio(group1())
    // BTC：gross 29970 + 12032.02 = 42002.02；net 29970 − 12032.02 = 17937.98；币量 0.5 − 0.2 = 0.3
    // ETH：gross 7492.5，net −7492.5，币量 −3
    expect(exposure.byAsset.map((b) => [b.key, b.gross, b.net, b.long, b.short, b.quantity, b.positionCount])).toEqual([
      ['BTC', '42002.02', '17937.98', '29970', '12032.02', '0.3', 2],
      ['ETH', '7492.5', '-7492.5', '0', '7492.5', '-3', 1],
    ])
    expect(exposure.byVenue.map((b) => [b.key, b.gross, b.net, b.quantity])).toEqual([
      ['okx', '29970', '29970', '0.5'],
      ['hyperliquid', '12032.02', '-12032.02', '-0.2'],
      ['binance', '7492.5', '-7492.5', '-3'],
    ])
    // 方向：long 29970；short 12032.02 + 7492.5 = 19524.52；net 10445.48；gross 49494.52
    expect(exposure.byDirection).toEqual({ long: '29970', short: '19524.52', net: '10445.48', gross: '49494.52' })
    // 总币量 0.5 − 0.2 − 3 = −2.7（跨资产相加只作对账用）
    expect(exposure.totals).toMatchObject({ gross: '49494.52', net: '10445.48', quantity: '-2.7', positionCount: 3 })
  })

  it('组 2：同一标的跨账户对冲 + 反向汇率对 + 集中度', () => {
    const { exposure, concentration } = analyzePortfolio(group2())
    // bybit:SOLUSDT：gross 12000 + 4800 = 16800；net 7200；币量 100 − 40 = 60
    expect(exposure.byInstrument.map((b) => [b.key, b.gross, b.net, b.quantity, b.positionCount])).toEqual([
      ['bybit:SOLUSDT', '16800', '7200', '60', 2],
      ['kraken:ETHUSD', '7500', '7500', '2.5', 1],
    ])
    expect(exposure.byDirection).toEqual({ long: '19500', short: '4800', net: '14700', gross: '24300' })
    // HHI = (16800/24300)² + (7500/24300)² = (168² + 75²) / 243² = 33849 / 59049 = 0.57323578…（第 8 位后为 72…，四舍五入进 1）
    expect(concentration.byAsset.hhi).toBe('0.57323579')
    expect(concentration.byAsset.largest).toEqual({ key: 'SOL', exposure: '16800', weight: '0.69135802' })
  })
})

describe('手算 · 盈亏归因', () => {
  it('组 1：策略 / 场所 / 总额，资金费与已实现按各自报价币折算', () => {
    const { attribution } = analyzePortfolio(group1())
    // 未实现（注入价重算，USD）：
    //   p1 多：0.5 × (59940 − 58000×0.999=57942) = 0.5 × 1998 = 999
    //   p2 空：0.2 × (61000×1.001=61061 − 60160.1) = 0.2 × 900.9 = 180.18
    //   p3 空：3 × (2400×0.999=2397.6 − 2497.5) = 3 × −99.9 = −299.7
    // 已实现：120×0.999 = 119.88；−50×1.001 = −50.05；10×0.999 = 9.99
    // 资金费：−4×0.999 = −3.996；2×1.001 = 2.002；0
    // 每笔合计：p1 1114.884；p2 132.132；p3 −289.71
    expect(attribution.byStrategy.map((b) => [b.key, b.realized, b.unrealized, b.funding, b.total])).toEqual([
      ['trend', '119.88', '999', '-3.996', '1114.884'],
      ['carry', '-50.05', '180.18', '2.002', '132.132'],
      ['meanrev', '9.99', '-299.7', '0', '-289.71'],
    ])
    expect(attribution.byVenue.map((b) => [b.key, b.total])).toEqual([
      ['okx', '1114.884'],
      ['hyperliquid', '132.132'],
      ['binance', '-289.71'],
    ])
    // 总额：已实现 79.82 + 未实现 879.48 + 资金费 −1.994 = 957.306
    // 场所上报未实现折 USD：999 + 175×1.001=175.175 + (−299.7) = 874.475；drift = 879.48 − 874.475 = 5.005
    expect(attribution.total).toMatchObject({ realized: '79.82', unrealized: '879.48', funding: '-1.994', total: '957.306', venueUnrealized: '874.475', drift: '5.005' })
  })

  it('组 2：同策略跨账户合并，精确键优先于账户键', () => {
    const { attribution } = analyzePortfolio(group2())
    // 未实现：q1 100 × (120 − 140×0.8=112) = 800；q2 40 × (155×0.8=124 − 120) = 160；q3 2.5 × (3000 − 3200) = −500
    // 已实现：25×0.8 = 20；−10×0.8 = −8；0
    // 资金费：−2.5×0.8 = −2；1.25×0.8 = 1；−0.75
    // grid = q1 + q2：已实现 12、未实现 960、资金费 −1、合计 971；trend = q3：−500.75
    expect(attribution.byStrategy.map((b) => [b.key, b.realized, b.unrealized, b.funding, b.total, b.positionCount])).toEqual([
      ['grid', '12', '960', '-1', '971', 2],
      ['trend', '0', '-500', '-0.75', '-500.75', 1],
    ])
    expect(attribution.byInstrument.map((b) => [b.key, b.total])).toEqual([
      ['bybit:SOLUSDT', '971'],
      ['kraken:ETHUSD', '-500.75'],
    ])
    // 总额：12 + 460 − 1.75 = 470.25
    expect(attribution.total).toMatchObject({ realized: '12', unrealized: '460', funding: '-1.75', total: '470.25' })
  })
})
