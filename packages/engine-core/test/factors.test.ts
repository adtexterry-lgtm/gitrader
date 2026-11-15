// SPDX-License-Identifier: CPAL-1.0
// factors.ts 的单元测试：内置因子清单、批量计算与各因子的数值口径。
import { describe, expect, it } from 'vitest'
import { FACTORS, computeFactors, factorById } from '../src/strategy/factors'
import type { Candle } from '../src/types'

/** 按收盘价构造 K 线；h / l 缺省为收盘 ± 1，v 缺省为 10。 */
function makeCandles(closes: number[], opts?: { v?: number }): Candle[] {
  const volume = opts?.v ?? 10
  return closes.map((c, i) => ({ t: i, o: c, h: c + 1, l: c - 1, c, v: volume }))
}

function linearCloses(count: number): number[] {
  return Array.from({ length: count }, (_, i) => 100 + i)
}

describe('FACTORS 清单', () => {
  it('共 10 个、id 唯一、可按 id 查找', () => {
    expect(FACTORS.length).toBe(10)
    const ids = FACTORS.map((def) => def.id)
    expect(new Set(ids).size).toBe(10)
    expect(factorById('momentum')).toBeDefined()
    expect(factorById('missing')).toBeUndefined()
  })

  it('computeFactors 返回键与 ids 一致，列长度等于 candles 长度', () => {
    const candles = makeCandles(linearCloses(30))
    const ids = ['momentum', 'rsi']
    const result = computeFactors(candles, ids)
    expect(Object.keys(result).sort()).toEqual([...ids].sort())
    for (const id of ids) {
      expect(result[id]!.length).toBe(candles.length)
    }
    expect(Object.keys(computeFactors(candles)).length).toBe(FACTORS.length)
  })
})

describe('单调上涨收盘 100 + i', () => {
  const candles = makeCandles(linearCloses(30))

  it('momentum 的周期与预热期', () => {
    const values = factorById('momentum')!.compute(candles, { period: 5 })
    expect(values[4]).toBeNull()
    expect(values[5]!).toBeCloseTo(105 / 100 - 1, 12)
  })

  it('range 为最高价与最低价之差除以收盘', () => {
    const values = factorById('range')!.compute(candles, { period: 10 })
    expect(values[8]).toBeNull()
    expect(values[9]!).toBeCloseTo(11 / 109, 12)
  })

  it('efficiency_ratio 单调序列为 1', () => {
    const values = factorById('efficiency_ratio')!.compute(candles, { period: 10 })
    for (let i = 10; i < values.length; i++) {
      expect(values[i]!).toBeCloseTo(1, 12)
    }
  })

  it('max_drawdown 单调上涨为 0', () => {
    const values = factorById('max_drawdown')!.compute(candles, { period: 20 })
    for (let i = 0; i < 19; i++) expect(values[i]).toBeNull()
    for (let i = 19; i < values.length; i++) expect(values[i]!).toBeCloseTo(0, 12)
  })

  it('zscore 用样本标准差（ddof 1）', () => {
    const values = factorById('zscore')!.compute(candles, { period: 20 })
    expect(values[18]).toBeNull()
    expect(values[19]!).toBeCloseTo((119 - 109.5) / 5.9161, 3)
    expect(values[19]!).toBeCloseTo(1.6058, 3)
  })
})

describe('锯齿收盘 100 / 110 交替', () => {
  const closes = Array.from({ length: 30 }, (_, i) => (i % 2 === 0 ? 100 : 110))
  const candles = makeCandles(closes)

  it('volatility 非 null 且大于 0', () => {
    const values = factorById('volatility')!.compute(candles, { period: 4 })
    expect(values[3]).toBeNull()
    expect(values[4]).not.toBeNull()
    expect(values[4]!).toBeGreaterThan(0)
  })

  it('efficiency_ratio 净位移为 0', () => {
    const values = factorById('efficiency_ratio')!.compute(candles, { period: 4 })
    for (let i = 4; i < values.length; i++) {
      expect(values[i]!).toBeCloseTo(0, 12)
    }
  })

  it('max_drawdown 为 10/110', () => {
    const values = factorById('max_drawdown')!.compute(candles, { period: 4 })
    expect(values[4]!).toBeCloseTo((110 - 100) / 110, 12)
    expect(values[4]!).toBeCloseTo(0.0909, 3)
  })
})

describe('量价类因子', () => {
  it('volume_ratio 成交量恒定时为 1，全 0 时为 null', () => {
    const constant = makeCandles(linearCloses(30), { v: 10 })
    const ratio = factorById('volume_ratio')!.compute(constant, { period: 20 })
    expect(ratio[19]).toBeNull()
    for (let i = 20; i < ratio.length; i++) expect(ratio[i]!).toBeCloseTo(1, 12)

    const zero = makeCandles(linearCloses(30), { v: 0 })
    const zeroRatio = factorById('volume_ratio')!.compute(zero, { period: 20 })
    for (let i = 0; i < zeroRatio.length; i++) expect(zeroRatio[i]).toBeNull()
  })

  it('amihud 收益全 0 时为 0', () => {
    const flat = Array.from({ length: 30 }, (_, i) => ({ t: i, o: 100, h: 101, l: 99, c: 100, v: 10 }))
    const values = factorById('amihud')!.compute(flat, { period: 20 })
    expect(values[19]).toBeNull()
    for (let i = 20; i < values.length; i++) expect(values[i]!).toBeCloseTo(0, 12)
  })
})

describe('边界情况', () => {
  it('period 为 1 时全 null 且不抛', () => {
    const candles = makeCandles(linearCloses(10))
    const values = factorById('momentum')!.compute(candles, { period: 1 })
    expect(values.length).toBe(candles.length)
    for (const value of values) expect(value).toBeNull()
  })

  it('空 candles 返回空数组', () => {
    expect(factorById('momentum')!.compute([])).toEqual([])
    expect(computeFactors([], ['momentum']).momentum).toEqual([])
  })
})
