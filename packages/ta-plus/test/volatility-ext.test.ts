// SPDX-License-Identifier: CPAL-1.0
// 波动与量能补充参照：NATR 公式同 TA-Lib ta_NATR.c（= 100×ATR/close = 100×atrPercent）；
// ATR 是 engine-core / QD 口径（第 0 根 TR = h−l，首值在下标 period−1）。
// 与 TA-Lib 的差异：ta_NATR.c 的 TR 从第 1 根算、首值在下标 period；本夹具 period 3 时
// TA-Lib 的 natr[3] = 100·3/102 = 2.941176…，本包 natr[3] = 2.723311…。
// 手算 NATR（period=3）：TR = 2,3,3 → ATR = 8/3 → 100×(8/3)/103 = 2.58899…（下标 2）
// ADOSC 参照 ta_ADOSC.c（EMA(A/D,fast) − EMA(A/D,slow)，两条 EMA 都以第一个 A/D 值为种子，
// k = 2/(n+1)，输出从 max(fast,slow)−1 起）。
// 手算 ADOSC（fast=2, slow=4）：A/D = 0, 400, 700, 1200, …；i=1 fast=266.67/slow=160；
//   i=2 fast=555.56/slow=376；i=3 fast=985.19/slow=705.6 → 279.5852…
import { describe, expect, it } from 'vitest'
import { adOsc, natr } from '../src/index'
import { BARS, expectSeries } from './fixtures-t1b'

const N = (n: number): null[] => new Array<null>(n).fill(null)

describe('NATR / ADOSC（TA-Lib 定义式 + 手算）', () => {
  it('natr = 100 × ATR ÷ close，i=2 为 100×(8/3)/103', () => {
    expectSeries(
      natr(BARS, 3),
      [
        ...N(2),
        2.588996763754,
        2.723311546841,
        2.742165242165,
        2.816732590195,
        2.794434646286,
        2.788777596604,
        3.176989905385,
        3.304716200374,
      ],
      'natr',
    )
    expect(natr(BARS, 3)[2]).toBeCloseTo((100 * (8 / 3)) / 103, 12)
  })

  it('natr 预热期为 period−1，输出单位是百分比（不是分数）', () => {
    expect(natr(BARS, 3).slice(0, 2)).toEqual([null, null])
    expect(natr(BARS, 3)[2]!).toBeGreaterThan(1)
    expect(natr(BARS, 3)[2]!).toBeLessThan(10)
  })

  it('常数 K 线（h=l=c）时 ATR 为 0，NATR 为 0', () => {
    const flat = Array.from({ length: 6 }, () => ({ o: 5, h: 5, l: 5, c: 5, v: 1 }))
    expect(natr(flat, 3).slice(2)).toEqual([0, 0, 0, 0])
  })

  it('close 为 0 处输出 null（不做除零）', () => {
    const zeroClose = Array.from({ length: 6 }, () => ({ o: 0, h: 1, l: 0, c: 0, v: 1 }))
    expect(natr(zeroClose, 3).slice(2)).toEqual([null, null, null, null])
  })

  it('adOsc = EMA(A/D,2) − EMA(A/D,4)，首项在 max(fast,slow)−1', () => {
    expectSeries(
      adOsc(BARS, 2, 4),
      [
        ...N(3),
        279.585185185185,
        322.812839506173,
        360.930502057613,
        343.417011796982,
        390.558666154549,
        420.282463829294,
        465.263010787542,
      ],
      'adOsc',
    )
  })

  it('adOsc 参数顺序决定符号：fast/slow 互换后结果取负', () => {
    const a = adOsc(BARS, 2, 4)
    const b = adOsc(BARS, 4, 2)
    for (let i = 3; i < BARS.length; i++) expect(b[i]).toBeCloseTo(-a[i]!, 9)
  })

  it('区间为 0 的 K 线不计入 A/D（价格不变时 adOsc 恒为 0）', () => {
    const flat = Array.from({ length: 8 }, () => ({ o: 3, h: 3, l: 3, c: 3, v: 900 }))
    expect(adOsc(flat, 2, 4).slice(3)).toEqual([0, 0, 0, 0, 0])
  })

  it('非法周期抛 RangeError', () => {
    expect(() => natr(BARS, 0)).toThrow(RangeError)
    expect(() => adOsc(BARS, 0, 4)).toThrow(RangeError)
    expect(() => adOsc(BARS, 2, -1)).toThrow(RangeError)
    expect(() => adOsc(BARS, 2, 1.5)).toThrow(RangeError)
  })
})
