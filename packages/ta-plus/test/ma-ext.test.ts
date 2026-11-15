// SPDX-License-Identifier: CPAL-1.0
// 均线扩展参照：TA-Lib ta_TRIMA.c:159-160（偶数期 = SMA(SMA(x,p/2),p/2+1)，奇数期 = SMA(SMA(x,(p+1)/2),(p+1)/2)）
// 与 ta_T3.c（六重 EMA + c1..c4 权重，lookback = 6×(period−1)）。
// trima(4) 逐步手算（closes，i=3）：SMA2 → [101, 102.5, 102.5]，SMA3 → (101+102.5+102.5)/3 = 102。
// t3 期望值经收口代理 2026-10-22 用 Python Fraction 按定义独立重算一致（重算脚本不入库）。
import { describe, expect, it } from 'vitest'
import { t3, trima } from '../src/index'
import { CLOSES, expectSeries } from './fixtures-t1b'

const N = (n: number): null[] => new Array<null>(n).fill(null)

describe('TRIMA / T3（TA-Lib 定义式）', () => {
  it('trima 偶数期 4 = SMA(SMA(x,2),3)，i=3 为 102', () => {
    expectSeries(
      trima(CLOSES, 4),
      [...N(3), 102, 102.66666666666666, 103, 103.5, 104.33333333333333, 104.83333333333333, 105.33333333333333],
      'trima4',
    )
  })

  it('trima 奇数期 5 = SMA(SMA(x,3),3)，i=4 为 307/3', () => {
    expectSeries(
      trima(CLOSES, 5),
      [
        ...N(4),
        102.33333333333333,
        102.77777777777777,
        103.33333333333333,
        103.88888888888889,
        104.55555555555556,
        105.1111111111111,
      ],
      'trima5',
    )
  })

  it('trima 的权重和为 1：常数序列还原该常数（period 3 与 4 都成立）', () => {
    const flat = [5, 5, 5, 5, 5, 5, 5, 5]
    for (const p of [3, 4]) {
      for (const v of trima(flat, p).slice(p - 1)) expect(v).toBeCloseTo(5, 12)
    }
  })

  it('trima 预热期为 period−1（奇数期与偶数期同）', () => {
    expect(trima(CLOSES, 4).slice(0, 3)).toEqual([null, null, null])
    expect(trima(CLOSES, 5).slice(0, 4)).toEqual([null, null, null, null])
    expect(trima(CLOSES, 5)[4]).not.toBeNull()
  })

  it('t3 首个非 null 位置为 6×(period−1)，值等于独立参考实现', () => {
    expectSeries(
      t3(CLOSES, 2),
      [
        ...N(6),
        104.284288777117,
        105.415011261833,
        104.837781413177,
        105.94914361519,
      ],
      't3-p2',
    )
  })

  it('t3 的 c1..c4 之和为 1：常数序列还原该常数（vFactor 0.7）', () => {
    const flat = new Array<number>(20).fill(42)
    const out = t3(flat, 2)
    for (const v of out.slice(6)) expect(v).toBeCloseTo(42, 10)
  })

  it('t3 预热期随 period 线性增长：period=2 → 6，period=3 → 12', () => {
    const long = Array.from({ length: 20 }, (_, i) => 100 + i)
    const p2 = t3(long, 2)
    const p3 = t3(long, 3)
    expect(p2.slice(0, 6)).toEqual([null, null, null, null, null, null])
    expect(p2[6]).not.toBeNull()
    expect(p3.slice(0, 12).every((v) => v === null)).toBe(true)
    expect(p3[12]).not.toBeNull()
  })

  it('非法参数抛 RangeError（period 0 / 小数、vFactor 非有限）', () => {
    expect(() => trima(CLOSES, 0)).toThrow(RangeError)
    expect(() => trima(CLOSES, 2.5)).toThrow(RangeError)
    expect(() => t3(CLOSES, 0)).toThrow(RangeError)
    expect(() => t3(CLOSES, 2, Number.NaN)).toThrow(RangeError)
  })
})
