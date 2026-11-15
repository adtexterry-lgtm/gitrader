// SPDX-License-Identifier: CPAL-1.0
// quantums / subticks 换算测试。样例市场取 dYdX 主网 BTC-USD 的公开参数口径
// （atomicResolution=-10、quantumConversionExponent=-9、stepBaseQuantums=1e6、subticksPerTick=1e5）；
// 期望值全部用「1 quantum = 1e-10 BTC」「1 subtick = 1e-14 USDC / 1e-10 BTC」手算核对。
// 取整口径照协议 OrderIntent.rounding：缺省 'reject'（不改量改价），'passive' 向下/内侧取整。
import { describe, expect, it } from 'vitest'
import {
  isOnStep, isOnTick, priceBand, priceFromSubticks, quantumsFor, roundToMultiple, sizeFromQuantums, subticksFor,
  truncToMultiple, type MarketParams,
} from '../src/precision'
import { fx } from '@gitrader/protocol/decimal'

const btc: MarketParams = {
  ticker: 'BTC-USD',
  clobPairId: 0,
  atomicResolution: -10,
  quantumConversionExponent: -9,
  stepBaseQuantums: 1_000_000,
  subticksPerTick: 100_000,
}

describe('quantums', () => {
  it('0.5 BTC = 5e9 quantums（0.5 / 1e-10）', () => {
    expect(quantumsFor('0.5', btc)).toBe(5_000_000_000n)
  })

  it('1 BTC = 1e10 quantums；0.01 BTC = 1e8 quantums', () => {
    expect(quantumsFor('1', btc)).toBe(10_000_000_000n)
    expect(quantumsFor('0.01', btc)).toBe(100_000_000n)
  })

  it('0.00015 BTC 不是 step 整数倍：缺省拒绝（消息里写 step 大小），passive → 1 个 step', () => {
    expect(() => quantumsFor('0.00015', btc)).toThrow(/stepBaseQuantums 1000000/)
    expect(quantumsFor('0.00015', btc, 'passive')).toBe(1_000_000n)
  })

  it('0.00001 BTC 小于一个 step：两种模式都拒（不夹到一个 step）', () => {
    expect(() => quantumsFor('0.00001', btc)).toThrow(/smaller than one step/)
    expect(() => quantumsFor('0.00001', btc, 'passive')).toThrow(/smaller than one step/)
  })

  it('0.01234 BTC → 缺省拒绝，passive 向下截到 0.0123', () => {
    expect(() => quantumsFor('0.01234', btc)).toThrow(/stepBaseQuantums/)
    expect(quantumsFor('0.01234', btc, 'passive')).toBe(123_000_000n)
  })

  it('比一个 quantum 还细的数量在缺省模式下拒绝', () => {
    expect(() => quantumsFor('0.000000000015', btc)).toThrow(/finer than one quantum/)
  })

  it('quantums 一定是 step 的整数倍', () => {
    for (const size of ['0.001', '0.1234', '2.5', '10']) {
      expect(isOnStep(quantumsFor(size, btc, 'passive'), btc)).toBe(true)
    }
  })

  it('sizeFromQuantums 反算回人类可读数量', () => {
    expect(sizeFromQuantums(5_000_000_000n, btc)).toBe('0.5')
    expect(sizeFromQuantums(1_000_000n, btc)).toBe('0.0001')
  })

  it('非正数量 / 非法 step 抛错', () => {
    expect(() => quantumsFor('0', btc)).toThrow(/positive/)
    expect(() => quantumsFor('-1', btc)).toThrow(/positive/)
    expect(() => quantumsFor('NaN', btc)).toThrow()
    expect(() => quantumsFor('1', { ...btc, stepBaseQuantums: 0 })).toThrow(/stepBaseQuantums/)
  })
})

describe('subticks', () => {
  it('20000 USDC 的价格 = 2e9 subticks；50000 → 5e9', () => {
    expect(subticksFor('20000', btc, 'buy')).toBe(2_000_000_000n)
    expect(subticksFor('20000', btc, 'sell')).toBe(2_000_000_000n)
    expect(subticksFor('50000', btc, 'buy')).toBe(5_000_000_000n)
  })

  it('20000.4 不是 tick 整数倍：缺省拒绝，passive 买向下 / 卖向上', () => {
    expect(() => subticksFor('20000.4', btc, 'buy')).toThrow(/subticksPerTick/)
    expect(subticksFor('20000.4', btc, 'buy', 'passive')).toBe(2_000_000_000n)
    expect(subticksFor('20000.4', btc, 'sell', 'passive')).toBe(2_000_100_000n)
  })

  it('passive 方向：买单不往上、卖单不往下（20000.00003 → 2e9 / 2000100000）', () => {
    const buy = subticksFor('20000.00003', btc, 'buy', 'passive')
    const sell = subticksFor('20000.00003', btc, 'sell', 'passive')
    expect(buy).toBe(2_000_000_000n)
    expect(sell).toBe(2_000_100_000n)
    expect(isOnTick(buy, btc)).toBe(true)
    expect(isOnTick(sell, btc)).toBe(true)
  })

  it('结果小于一个 tick：买单拒绝，卖单向上取到恰好一个 tick', () => {
    expect(() => subticksFor('0.000000000001', btc, 'buy', 'passive')).toThrow(/one tick/)
    expect(subticksFor('0.000000000001', btc, 'sell', 'passive')).toBe(100_000n)
  })

  it('priceFromSubticks 反算回人类可读价格', () => {
    expect(priceFromSubticks(2_000_000_000n, btc)).toBe('20000')
    expect(priceFromSubticks(100_000n, btc)).toBe('1')
  })

  it('非正价格 / 非法 tick 抛错', () => {
    expect(() => subticksFor('0', btc, 'buy')).toThrow(/positive/)
    expect(() => subticksFor('1', { ...btc, subticksPerTick: 0 }, 'buy')).toThrow(/subticksPerTick/)
  })
})

describe('市价价带', () => {
  it('参考价 20000、50 bps：买 20100 / 卖 19900', () => {
    expect(priceBand('20000', 50, 'buy')).toBe('20100')
    expect(priceBand('20000', 50, 'sell')).toBe('19900')
  })

  it('价带取整落在带内：买向下、卖向上（band 口径）', () => {
    expect(subticksFor(priceBand('20000', 50, 'buy'), btc, 'buy', 'band')).toBe(2_010_000_000n)
    expect(subticksFor(priceBand('20000', 50, 'sell'), btc, 'sell', 'band')).toBe(1_990_000_000n)
    // 参考价带小数：买向下取到 20000.00，不越出带宽
    expect(subticksFor(priceBand('20000.37', 0, 'buy'), btc, 'buy', 'band')).toBe(2_000_000_000n)
  })

  it('0 bps 等于参考价；10000 bps 卖价归零', () => {
    expect(priceBand('123.45', 0, 'buy')).toBe('123.45')
    expect(fx(priceBand('100', 10000, 'sell'))).toBe(0n)
  })

  it('非法 bps / 非正参考价抛错', () => {
    expect(() => priceBand('100', -1, 'buy')).toThrow(/non-negative/)
    expect(() => priceBand('100', 10_001, 'buy')).toThrow(/basis points/)
    expect(() => priceBand('100', Number.NaN, 'buy')).toThrow()
    expect(() => priceBand('0', 10, 'buy')).toThrow(/positive/)
  })

  it('价带在链上取整后仍是合法 tick', () => {
    const px = priceBand('20000', 37, 'buy')
    expect(isOnTick(subticksFor(px, btc, 'buy', 'band'), btc)).toBe(true)
  })
})

describe('取整工具', () => {
  it('roundToMultiple 四舍五入到整数倍', () => {
    expect(roundToMultiple(fx('14'), fx('5'))).toBe(15n * 10n ** 18n)
    expect(roundToMultiple(fx('12'), fx('5'))).toBe(10n * 10n ** 18n)
    expect(roundToMultiple(fx('-14'), fx('5'))).toBe(-15n * 10n ** 18n)
  })

  it('truncToMultiple 向零截断', () => {
    expect(truncToMultiple(fx('14'), fx('5'))).toBe(10n * 10n ** 18n)
    expect(truncToMultiple(fx('-14'), fx('5'))).toBe(-10n * 10n ** 18n)
  })

  it('unit 非正抛错', () => {
    expect(() => roundToMultiple(fx('1'), 0n)).toThrow(RangeError)
    expect(() => truncToMultiple(fx('1'), 0n)).toThrow(RangeError)
  })
})
