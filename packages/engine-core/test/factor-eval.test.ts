// SPDX-License-Identifier: CPAL-1.0
// factor-eval.ts 的单元测试：前向收益、秩相关、滚动 IC、IC 汇总、分组收益与一站式评估。
import { describe, expect, it } from 'vitest'
import {
  crossSectionalIc,
  evaluateFactor,
  forwardReturns,
  icSummary,
  quantileReturns,
  rankIc,
  rollingIc,
} from '../src/strategy/factor-eval'
import { factorById } from '../src/strategy/factors'
import type { Candle } from '../src/types'

function makeCandles(closes: number[]): Candle[] {
  return closes.map((c, i) => ({ t: i, o: c, h: c + 1, l: c - 1, c, v: 10 }))
}

describe('forwardReturns', () => {
  it('按 horizon 平移收盘，尾部为 null', () => {
    const candles = makeCandles([100, 110, 121])
    const fwd = forwardReturns(candles, 1)
    expect(fwd.length).toBe(3)
    expect(fwd[0]!).toBeCloseTo(0.1, 12)
    expect(fwd[1]!).toBeCloseTo(0.1, 12)
    expect(fwd[2]).toBeNull()
  })
})

describe('rankIc', () => {
  it('单调同向为 1，反向为 -1', () => {
    expect(rankIc([1, 2, 3, 4, 5], [2, 4, 6, 8, 10])).toBe(1)
    expect(rankIc([1, 2, 3, 4, 5], [10, 8, 6, 4, 2])).toBe(-1)
  })

  it('任一方零方差为 null', () => {
    expect(rankIc([1, 1, 1, 1], [1, 2, 3, 4])).toBeNull()
  })

  it('带 null 时只用有效点', () => {
    expect(rankIc([1, null, 3, 4, 5], [5, 9, 1, 2, 3])!).toBeCloseTo(-0.2, 12)
  })
})

describe('rollingIc', () => {
  it('窗口滚动计算，前 window-1 个为 null', () => {
    expect(rollingIc([1, 2, 3, 4], [1, 2, 3, 4], 3)).toEqual([null, null, 1, 1])
  })
})

describe('icSummary', () => {
  it('两个正 IC 的均值、标准差、IR 与 t 统计量', () => {
    const summary = icSummary([0.1, 0.3])
    expect(summary.n).toBe(2)
    expect(summary.mean).toBeCloseTo(0.2, 12)
    expect(summary.std).toBeCloseTo(0.14142, 5)
    expect(summary.ir!).toBeCloseTo(1.4142, 4)
    expect(summary.tStat!).toBeCloseTo(2.0, 6)
    expect(summary.positiveShare).toBe(1)
  })

  it('单个有效点时 IR 为 null', () => {
    const summary = icSummary([null, 0.5])
    expect(summary.n).toBe(1)
    expect(summary.ir).toBeNull()
    expect(summary.tStat).toBeNull()
  })
})

describe('quantileReturns', () => {
  it('两组的均值与多空差', () => {
    const factor = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    const fwd = factor.map((value) => value / 100)
    const result = quantileReturns(factor, fwd, 2)
    expect(result.buckets.length).toBe(2)
    expect(result.buckets[0]!.q).toBe(1)
    expect(result.buckets[0]!.n).toBe(5)
    expect(result.buckets[0]!.meanFwd).toBeCloseTo(0.03, 12)
    expect(result.buckets[1]!.q).toBe(2)
    expect(result.buckets[1]!.n).toBe(5)
    expect(result.buckets[1]!.meanFwd).toBeCloseTo(0.08, 12)
    expect(result.spread!).toBeCloseTo(0.05, 12)
  })

  it('有效点少于组数时为空', () => {
    const result = quantileReturns([1, null], [0.1, 0.2], 3)
    expect(result.buckets).toEqual([])
    expect(result.spread).toBeNull()
  })
})

describe('crossSectionalIc', () => {
  it('横截面单调同向为 1', () => {
    expect(crossSectionalIc([3, 1, 2], [0.3, 0.1, 0.2])).toBe(1)
  })
})

describe('evaluateFactor', () => {
  it('恒定动量无秩相关，分组仍等分且多空差为 0', () => {
    const candles = makeCandles(
      Array.from({ length: 60 }, (_, i) => 100 * Math.pow(1.01, i)),
    )
    const report = evaluateFactor(candles, factorById('momentum')!, {
      horizon: 5,
      window: 10,
      quantiles: 2,
      params: { period: 5 },
    })
    expect(report.id).toBe('momentum')
    expect(report.horizon).toBe(5)
    expect(report.ic).toBeNull()
    expect(report.rolling.n).toBe(0)
    expect(report.quantiles.buckets.length).toBe(2)
    const expected = Math.pow(1.01, 5) - 1
    expect(report.quantiles.buckets[0]!.meanFwd).toBeCloseTo(expected, 10)
    expect(report.quantiles.buckets[1]!.meanFwd).toBeCloseTo(
      report.quantiles.buckets[0]!.meanFwd,
      12,
    )
    expect(report.quantiles.spread!).toBeCloseTo(0, 12)
  })
})
