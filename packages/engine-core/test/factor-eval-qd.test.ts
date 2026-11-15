// SPDX-License-Identifier: CPAL-1.0
// factor-eval.ts 中 QD 移植部分的单元测试：IC 衰减、分组单调性与同组去均值中性化。
import { describe, expect, it } from 'vitest'
import { icDecay, neutralize, quantileMonotonicity } from '../src/strategy/factor-eval'
import type { Candle } from '../src/types'

function makeCandles(closes: number[]): Candle[] {
  return closes.map((c, i) => ({ t: i, o: c, h: c + 1, l: c - 1, c, v: 10 }))
}

describe('icDecay', () => {
  it('前向收益随序号递减时各项 IC 为 -1', () => {
    const candles = makeCandles(Array.from({ length: 40 }, (_, i) => 100 + i))
    const factor = candles.map((_, i) => i)
    const decay = icDecay(factor, candles, [1, 5])
    expect(decay.length).toBe(2)
    expect(decay[0]!.horizon).toBe(1)
    expect(decay[0]!.ic!).toBeCloseTo(-1, 12)
    expect(decay[1]!.horizon).toBe(5)
    expect(decay[1]!.ic!).toBeCloseTo(-1, 12)
  })
})

describe('quantileMonotonicity', () => {
  it('分层序号与组均值同向为 1，反向为 -1', () => {
    expect(
      quantileMonotonicity([
        { q: 1, meanFwd: 0.01 },
        { q: 2, meanFwd: 0.02 },
        { q: 3, meanFwd: 0.03 },
      ]),
    ).toBe(1)
    expect(
      quantileMonotonicity([
        { q: 1, meanFwd: 0.03 },
        { q: 2, meanFwd: 0.02 },
        { q: 3, meanFwd: 0.01 },
      ]),
    ).toBe(-1)
  })

  it('少于 3 组为 null', () => {
    expect(
      quantileMonotonicity([
        { q: 1, meanFwd: 0.01 },
        { q: 2, meanFwd: 0.02 },
      ]),
    ).toBeNull()
  })
})

describe('neutralize', () => {
  it('同组去均值，null 保留，单值组为 0', () => {
    expect(neutralize([1, 3, null, 10, 20], ['a', 'a', 'a', 'b', 'b'])).toEqual([
      -1, 1, null, -5, 5,
    ])
    expect(neutralize([7, null], ['z', 'z'])).toEqual([0, null])
  })

  it('null 组视为同一「未分组」桶去均值', () => {
    expect(neutralize([1, 3, 5], ['a', null, null])).toEqual([0, -1, 1])
  })

  it('组内 null 不参与均值，输出仍为 null', () => {
    expect(neutralize([2, null, 4], ['g', 'g', 'g'])).toEqual([-1, null, 1])
  })
})
