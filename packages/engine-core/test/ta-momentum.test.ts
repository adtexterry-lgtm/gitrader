// SPDX-License-Identifier: CPAL-1.0
// 动量类指标：RSI（Wilder）、随机指标、变化率、动量、威廉指标、顺势指标的数值、预热期 null 与因果性。
import { describe, expect, it } from 'vitest'
import { cci, momentum, roc, rsi, stochastic, williamsR } from '../src/strategy/ta/momentum'

const barsFrom = (h: number[], l: number[], c: number[]) =>
  h.map((hv, i) => ({ o: c[i]!, h: hv, l: l[i]!, c: c[i]!, v: 1 }))

const ramp = (n: number) => Array.from({ length: n }, (_, i) => i + 1)

describe('rsi', () => {
  it('period 2 的 Wilder 递推', () => {
    expect(rsi([1, 2, 3, 2, 3], 2)).toEqual([null, null, 100, 50, 75])
  })

  it('单调递增 / 递减 / 常数序列的边界', () => {
    const up = rsi(ramp(30), 14)
    for (let i = 14; i < up.length; i += 1) expect(up[i]).toBeCloseTo(100, 9)
    const down = rsi(ramp(30).reverse(), 14)
    for (let i = 14; i < down.length; i += 1) expect(down[i]).toBeCloseTo(0, 9)
    const flat = rsi(new Array<number>(30).fill(7), 14)
    for (let i = 14; i < flat.length; i += 1) expect(flat[i]).toBeCloseTo(50, 9)
  })
})

describe('stochastic', () => {
  it('k 与 d 的数值与预热期', () => {
    const bars = barsFrom([2, 3, 4, 5, 6], [1, 2, 3, 4, 5], [1.5, 2.5, 3.5, 4.5, 5.5])
    const { k, d } = stochastic(bars, 3, 2)
    expect(k[0]).toBeNull()
    expect(k[1]).toBeNull()
    for (const i of [2, 3, 4]) expect(k[i]).toBeCloseTo(83.3333333333, 9)
    expect(d[2]).toBeNull()
    for (const i of [3, 4]) expect(d[i]).toBeCloseTo(83.3333333333, 9)
  })
})

describe('williamsR', () => {
  it('取窗口最高最低价换算', () => {
    const bars = barsFrom([2, 3, 4, 5, 6], [1, 2, 3, 4, 5], [1.5, 2.5, 3.5, 4.5, 5.5])
    const out = williamsR(bars, 3)
    expect(out[1]).toBeNull()
    expect(out[2]).toBeCloseTo(-16.6666666667, 9)
  })
})

describe('roc 与 momentum', () => {
  it('变化率与动量的差值口径', () => {
    expect(roc([1, 2, 4, 8], 1)).toEqual([null, 1, 1, 1])
    expect(roc([0, 1], 1)).toEqual([null, null])
    expect(momentum([1, 2, 4, 8], 2)).toEqual([null, null, 3, 6])
  })
})

describe('cci', () => {
  it('典型价单调时取 100，常数时为 0', () => {
    const flat = [1, 2, 3, 4, 5]
    const out = cci(barsFrom(flat, flat, flat), 3)
    expect(out[0]).toBeNull()
    expect(out[1]).toBeNull()
    for (const i of [2, 3, 4]) expect(out[i]).toBeCloseTo(100, 9)
    const fixed = [3, 3, 3, 3, 3]
    const zero = cci(barsFrom(fixed, fixed, fixed), 3)
    for (let i = 0; i < zero.length; i += 1) {
      if (i < 2) expect(zero[i]).toBeNull()
      else expect(zero[i]).toBeCloseTo(0, 9)
    }
  })
})

describe('参数校验与因果性', () => {
  it('非法周期抛 RangeError', () => {
    const bars = barsFrom([2, 3, 4], [1, 2, 3], [1.5, 2.5, 3.5])
    expect(() => rsi([1, 2, 3], 0)).toThrow(RangeError)
    expect(() => cci(bars, 1.5)).toThrow(RangeError)
  })

  it('第 i 项只用 ≤ i 的数据', () => {
    const long = rsi(ramp(30), 5)
    const short = rsi(ramp(20), 5)
    for (let i = 0; i < short.length; i += 1) {
      const a = long[i] ?? null
      const b = short[i] ?? null
      if (a === null || b === null) expect(a).toEqual(b)
      else expect(a).toBeCloseTo(b, 9)
    }
  })
})
