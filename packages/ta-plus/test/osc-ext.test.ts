// SPDX-License-Identifier: CPAL-1.0
// 振荡补充参照：TA-Lib ta_AROONOSC.c（窗口 period+1 根，并列取最近一根）、ta_STOCHF.c（Fast-K/Fast-D）。
// 手算（period=3）：i=3 窗 H=101,103,104,103 → 最高 104@2，距 1 根 → Up=66.67；L=99,100,101,100 → 最低 99@0，
//   距 3 根 → Down=0；AROONOSC = 66.67。
// Fast-K（kPeriod=3）：i=2 窗 H 最大 104、L 最小 99、c=103 → 100×4/5 = 80；Fast-D（2）= (80+50)/2 = 65。
import { describe, expect, it } from 'vitest'
import { aroonOsc, stochF } from '../src/index'
import { BARS, expectSeries } from './fixtures-t1b'

const N = (n: number): null[] => new Array<null>(n).fill(null)

describe('AROONOSC / STOCHF（TA-Lib 定义式 + 手算）', () => {
  it('aroonOsc 在 period+1 根窗口上取最近极值；i=3 为 200/3', () => {
    expectSeries(
      aroonOsc(BARS, 3),
      [...N(3), 200 / 3, 100 / 3, 100 / 3, 100, 200 / 3, 200 / 3, 100 / 3],
      'aroonOsc',
    )
  })

  it('aroonOsc 的极值就是当根时得 +100 / −100', () => {
    const rising = Array.from({ length: 6 }, (_, i) => ({ o: 10 + i, h: 11 + i, l: 10 + i, c: 10.5 + i, v: 1 }))
    expect(aroonOsc(rising, 3)[5]).toBeCloseTo(100, 9)
    const falling = Array.from({ length: 6 }, (_, i) => ({ o: 10 - i, h: 10 - i, l: 9 - i, c: 9.5 - i, v: 1 }))
    expect(aroonOsc(falling, 3)[5]).toBeCloseTo(-100, 9)
  })

  it('aroonOsc 首项在 period 位置（窗口 period+1 根）', () => {
    expect(aroonOsc(BARS, 3).slice(0, 3)).toEqual([null, null, null])
    expect(aroonOsc(BARS, 3)[3]).not.toBeNull()
  })

  it('stochF：Fast-K = 100×(c − LL)/(HH − LL)', () => {
    expectSeries(
      stochF(BARS, 3, 2).k,
      [...N(2), 80, 50, 80, 60, 80, 83.33333333333333, 40, 83.33333333333333],
      'stochF.k',
    )
  })

  it('stochF：Fast-D 是 Fast-K 的简单平均，首项在 kPeriod+dPeriod−2', () => {
    expectSeries(
      stochF(BARS, 3, 2).d,
      [...N(3), 65, 65, 70, 70, 81.66666666666667, 61.66666666666667, 61.66666666666667],
      'stochF.d',
    )
  })

  it('stochF：区间为 0 时 K = 0（不产生 NaN）', () => {
    const bars = Array.from({ length: 5 }, () => ({ o: 10, h: 10, l: 10, c: 10, v: 1 }))
    const { k, d } = stochF(bars, 3, 2)
    expect(k).toEqual([null, null, 0, 0, 0])
    expect(d).toEqual([null, null, null, 0, 0])
  })

  it('非法周期抛 RangeError', () => {
    expect(() => aroonOsc(BARS, 0)).toThrow(RangeError)
    expect(() => stochF(BARS, 0, 2)).toThrow(RangeError)
    expect(() => stochF(BARS, 3, 0)).toThrow(RangeError)
  })
})
