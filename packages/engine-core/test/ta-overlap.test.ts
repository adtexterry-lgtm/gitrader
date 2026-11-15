// SPDX-License-Identifier: CPAL-1.0
// overlap.ts 的单元测试：叠加 / 趋势类指标的已知答案、预热期、长度与非法参数行为。
import { describe, expect, it } from 'vitest'
import {
  alma,
  dema,
  envelope,
  hma,
  ichimoku,
  kama,
  linearRegression,
  parabolicSar,
  pivotPoints,
  supertrend,
  tema,
  vwma,
  zlema,
} from '../src/strategy/ta/overlap'
import { sma } from '../src/strategy/ta/trend'
import type { Bar, Series } from '../src/strategy/ta/types'

const constValues = new Array<number>(40).fill(100)
const constBars: Bar[] = Array.from({ length: 40 }, () => ({ o: 100, h: 100, l: 100, c: 100, v: 1 }))
const upValues = Array.from({ length: 40 }, (_, i) => 100 + i)
const upBars: Bar[] = upValues.map((c) => ({ o: c, h: c + 1, l: c - 1, c, v: 1 }))
const downValues = Array.from({ length: 40 }, (_, i) => 200 - i)
const downBars: Bar[] = downValues.map((c) => ({ o: c, h: c + 1, l: c - 1, c, v: 1 }))

function firstNonNull(series: Series): number {
  for (let i = 0; i < series.length; i++) {
    const value = series[i]
    if (value !== null && value !== undefined) return i
  }
  return -1
}

function expectFlat(series: Series, expected: number, from: number, digits = 10): void {
  for (let i = from; i < series.length; i++) {
    const value = series[i]
    expect(value).not.toBeNull()
    expect(value as number).toBeCloseTo(expected, digits)
  }
}

function expectAllNull(series: Series): void {
  for (const value of series) expect(value).toBeNull()
}

describe('常数序列已知答案', () => {
  it('dema / tema / hma / kama / vwma / alma / zlema 预热后均为 100', () => {
    expectFlat(dema(constValues, 5), 100, 8)
    expectFlat(tema(constValues, 5), 100, 12)
    expectFlat(hma(constValues, 9), 100, 10)
    expectFlat(kama(constValues, 10), 100, 9)
    expectFlat(vwma(constBars, 5), 100, 4)
    expectFlat(alma(constValues, 9), 100, 8)
    expectFlat(zlema(constValues, 5), 100, 6)
  })

  it('一目均衡五线预热后均为 100', () => {
    const result = ichimoku(constBars, { tenkan: 3, kijun: 5, senkou: 7 })
    expectFlat(result.tenkan, 100, 2)
    expectFlat(result.kijun, 100, 4)
    expectFlat(result.senkouA, 100, 4)
    expectFlat(result.senkouB, 100, 6)
    expectFlat(result.chikou, 100, 0)
    for (const series of [result.tenkan, result.kijun, result.senkouA, result.senkouB, result.chikou]) {
      expect(series.length).toBe(constBars.length)
    }
  })

  it('线性回归：slope 为 0、value 为 100、r2 为 null', () => {
    const result = linearRegression(constValues, 5)
    for (let i = 4; i < constValues.length; i++) {
      expect(result.slope[i] as number).toBeCloseTo(0, 10)
      expect(result.intercept[i] as number).toBeCloseTo(100, 10)
      expect(result.value[i] as number).toBeCloseTo(100, 10)
      expect(result.r2[i]).toBeNull()
    }
    for (let i = 0; i < 4; i++) {
      expect(result.slope[i]).toBeNull()
      expect(result.value[i]).toBeNull()
    }
  })

  it('包络线：pct = 0.1 时上轨 110、下轨 90', () => {
    const result = envelope(constValues, 5, 0.1)
    expectFlat(result.mid, 100, 4)
    expectFlat(result.upper, 110, 4)
    expectFlat(result.lower, 90, 4)
  })

  it('枢轴点：常数 h=110 / l=90 / c=100 的五线取值', () => {
    const bars: Bar[] = Array.from({ length: 40 }, () => ({ o: 100, h: 110, l: 90, c: 100, v: 1 }))
    const result = pivotPoints(bars)
    expect(result.p[0]).toBeNull()
    expect(result.r1[0]).toBeNull()
    for (let i = 1; i < bars.length; i++) {
      expect(result.p[i] as number).toBeCloseTo(100, 10)
      expect(result.r1[i] as number).toBeCloseTo(110, 10)
      expect(result.s1[i] as number).toBeCloseTo(90, 10)
      expect(result.r2[i] as number).toBeCloseTo(120, 10)
      expect(result.s2[i] as number).toBeCloseTo(80, 10)
    }
  })
})

describe('等差递增序列', () => {
  it('线性回归：slope 为 1 且 value 等于当前值', () => {
    const result = linearRegression(upValues, 5)
    for (let i = 4; i < upValues.length; i++) {
      expect(result.slope[i] as number).toBeCloseTo(1, 10)
      expect(result.value[i] as number).toBeCloseTo(upValues[i]!, 8)
      expect(result.r2[i] as number).toBeCloseTo(1, 8)
    }
  })

  it('dema / tema / hma / zlema 预热后单调递增且滞后小于 SMA', () => {
    const series = [
      ['dema', dema(upValues, 5)],
      ['tema', tema(upValues, 5)],
      ['hma', hma(upValues, 5)],
      ['zlema', zlema(upValues, 5)],
    ] as const
    const smaLast = sma(upValues, 5)[39] as number
    const current = upValues[39]!
    for (const [, values] of series) {
      const start = firstNonNull(values)
      for (let i = start + 1; i < values.length; i++) {
        expect(values[i] as number).toBeGreaterThan(values[i - 1] as number)
      }
      const last = values[39] as number
      expect(Math.abs(last - current)).toBeLessThan(Math.abs(smaLast - current))
    }
  })

  it('kama 预热后单调不减', () => {
    const result = kama(upValues, 10)
    const start = firstNonNull(result)
    expect(start).toBe(9)
    for (let i = start + 1; i < result.length; i++) {
      expect(result[i] as number).toBeGreaterThanOrEqual(result[i - 1] as number)
    }
  })

  it('parabolicSar 趋势为 +1 且 SAR 低于最低价', () => {
    const result = parabolicSar(upBars)
    for (let i = 2; i < upBars.length; i++) {
      expect(result.trend[i]).toBe(1)
      expect(result.sar[i] as number).toBeLessThan(upBars[i]!.l)
    }
  })

  it('supertrend 最后一根趋势为 +1', () => {
    const result = supertrend(upBars)
    expect(result.trend[39]).toBe(1)
  })

  it('一目均衡 tenkan 在 i = 39 时为 135', () => {
    const result = ichimoku(upBars)
    expect(result.tenkan[39] as number).toBeCloseTo(135, 10)
  })
})

describe('等差递减序列', () => {
  it('parabolicSar 趋势为 -1 且 SAR 高于最高价', () => {
    const result = parabolicSar(downBars)
    for (let i = 1; i < downBars.length; i++) {
      expect(result.trend[i]).toBe(-1)
      expect(result.sar[i] as number).toBeGreaterThan(downBars[i]!.h)
    }
  })

  it('supertrend 最后一根趋势为 -1', () => {
    const result = supertrend(downBars)
    expect(result.trend[39]).toBe(-1)
  })
})

describe('预热期与长度', () => {
  it('各指标第一个非 null 下标符合公式', () => {
    expect(firstNonNull(dema(constValues, 5))).toBe(8)
    expect(firstNonNull(tema(constValues, 5))).toBe(12)
    expect(firstNonNull(hma(constValues, 9))).toBe(10)
    expect(firstNonNull(kama(constValues, 10))).toBe(9)
    expect(firstNonNull(vwma(constBars, 5))).toBe(4)
    expect(firstNonNull(alma(constValues, 9))).toBe(8)
    expect(firstNonNull(zlema(constValues, 5))).toBe(6)
    expect(firstNonNull(envelope(constValues, 5).mid)).toBe(4)
    expect(firstNonNull(linearRegression(constValues, 5).value)).toBe(4)
    expect(firstNonNull(pivotPoints(constBars).p)).toBe(1)
    expect(firstNonNull(parabolicSar(constBars).sar)).toBe(1)
    expect(firstNonNull(supertrend(constBars, { period: 10 }).upper)).toBe(9)
  })

  it('一目均衡默认周期的预热期', () => {
    const longBars: Bar[] = Array.from({ length: 60 }, () => ({ o: 100, h: 100, l: 100, c: 100, v: 1 }))
    const result = ichimoku(longBars)
    expect(firstNonNull(result.tenkan)).toBe(8)
    expect(firstNonNull(result.kijun)).toBe(25)
    expect(firstNonNull(result.senkouA)).toBe(25)
    expect(firstNonNull(result.senkouB)).toBe(51)
    expect(firstNonNull(result.chikou)).toBe(0)
  })

  it('输出长度与输入一致', () => {
    expect(dema(upValues, 5).length).toBe(upValues.length)
    expect(parabolicSar(upBars).trend.length).toBe(upBars.length)
    expect(supertrend(upBars).lower.length).toBe(upBars.length)
    expect(linearRegression(upValues, 5).r2.length).toBe(upValues.length)
  })
})

describe('非法参数与空输入', () => {
  it('period 为 0 或非整数时全 null 且不抛错', () => {
    for (const period of [0, 2.5]) {
      const series = [
        dema(upValues, period),
        tema(upValues, period),
        hma(upValues, period),
        kama(upValues, period),
        vwma(upBars, period),
        alma(upValues, period),
        zlema(upValues, period),
        envelope(upValues, period).mid,
        linearRegression(upValues, period).value,
        supertrend(upBars, { period }).upper,
      ]
      for (const item of series) {
        expect(item.length).toBe(upValues.length)
        expectAllNull(item)
      }
      const ich = ichimoku(upBars, { tenkan: period })
      for (const item of [ich.tenkan, ich.kijun, ich.senkouA, ich.senkouB, ich.chikou]) {
        expectAllNull(item)
      }
    }
  })

  it('空输入返回空数组', () => {
    expect(dema([], 5)).toEqual([])
    expect(tema([], 5)).toEqual([])
    expect(hma([], 5)).toEqual([])
    expect(kama([], 5)).toEqual([])
    expect(vwma([], 5)).toEqual([])
    expect(alma([], 5)).toEqual([])
    expect(zlema([], 5)).toEqual([])
    expect(ichimoku([])).toEqual({ tenkan: [], kijun: [], senkouA: [], senkouB: [], chikou: [] })
    expect(parabolicSar([])).toEqual({ sar: [], trend: [] })
    expect(supertrend([])).toEqual({ upper: [], lower: [], trend: [] })
    expect(pivotPoints([])).toEqual({ p: [], r1: [], s1: [], r2: [], s2: [] })
    expect(linearRegression([], 5)).toEqual({ slope: [], intercept: [], value: [], r2: [] })
    expect(envelope([], 5)).toEqual({ mid: [], upper: [], lower: [] })
  })
})
