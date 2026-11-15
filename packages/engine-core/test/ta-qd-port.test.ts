// SPDX-License-Identifier: CPAL-1.0
// QD 指标移植测试：KDJ、Parkinson / Garman-Klass 年化波动、turnover_proxy 与 volume_zscore 的取值、预热期与非法参数。

import { describe, expect, it } from 'vitest'
import type { Bar } from '../src/strategy/ta/types'
import { kdj } from '../src/strategy/ta/oscillators'
import { garmanKlassVol, parkinsonVol } from '../src/strategy/ta/volatility'
import { turnoverProxy, volumeZscore } from '../src/strategy/ta/volume'

/** 等差上涨 K 线：c = 100 + i，h = c + 1，l = c − 1，v = 10。 */
const upBars = (n: number): Bar[] =>
  Array.from({ length: n }, (_, i) => {
    const c = 100 + i
    return { o: c, h: c + 1, l: c - 1, c, v: 10 }
  })

/** 常数 K 线：h = l = c = o = 100，v 可指定。 */
const flatBars = (n: number, v = 10): Bar[] =>
  Array.from({ length: n }, () => ({ o: 100, h: 100, l: 100, c: 100, v }))

/** 高 101、低 99、开收 100 的常数 K 线。 */
const rangeBars = (n: number): Bar[] =>
  Array.from({ length: n }, () => ({ o: 100, h: 101, l: 99, c: 100, v: 10 }))

/** 成交量 1..n 的 K 线，价格固定 100。 */
const volumeBars = (n: number): Bar[] =>
  Array.from({ length: n }, (_, i) => ({ o: 100, h: 100, l: 100, c: 100, v: i + 1 }))

/** 输出是否全为 null。 */
const allNull = (values: Array<number | null>): boolean => values.every((v) => v === null)

describe('kdj', () => {
  it('前 n−1 项为 null，之后按 QD 的 K/D 递推与 J = 3K − 2D', () => {
    const bars = upBars(40)
    const { k, d, j } = kdj(bars, { n: 9 })
    expect(k[7] ?? null).toBeNull()
    expect(d[7] ?? null).toBeNull()
    expect(j[7] ?? null).toBeNull()
    // RSV = (100 + 8 − (100 + 0 − 1)) / ((100 + 8 + 1) − (100 + 0 − 1)) · 100 = 90
    // K = 2/3 · 50 + 1/3 · 90，D = 2/3 · 50 + 1/3 · K，J = 3K − 2D。
    expect(k[8]!).toBeCloseTo(63.3333, 3)
    expect(d[8]!).toBeCloseTo(54.4444, 3)
    expect(j[8]!).toBeCloseTo(81.1111, 3)
    expect(k.length).toBe(bars.length)
    expect(d.length).toBe(bars.length)
    expect(j.length).toBe(bars.length)
  })

  it('max = min 时 RSV 取 50（QD 的 fillna(50)），K / D / J 保持 50', () => {
    const bars = flatBars(20)
    const { k, d, j } = kdj(bars, { n: 9 })
    for (let i = 8; i < bars.length; i += 1) {
      expect(k[i]!).toBeCloseTo(50, 10)
      expect(d[i]!).toBeCloseTo(50, 10)
      expect(j[i]!).toBeCloseTo(50, 10)
    }
  })

  it('n / k / d 非法时全 null 且不抛；空输入为空数组', () => {
    const bars = upBars(40)
    const zero = kdj(bars, { n: 0 })
    expect(allNull(zero.k)).toBe(true)
    expect(allNull(zero.d)).toBe(true)
    expect(allNull(zero.j)).toBe(true)
    expect(allNull(kdj(bars, { k: 0 }).k)).toBe(true)
    expect(allNull(kdj(bars, { d: 0 }).d)).toBe(true)
    expect(kdj([], { n: 9 }).k).toEqual([])
    expect(kdj([], { n: 9 }).d).toEqual([])
    expect(kdj([], { n: 9 }).j).toEqual([])
  })
})

describe('parkinsonVol', () => {
  it('常数 h / l 时预热后等于 ln(h/l)² / (4n·ln2) 开方再乘 sqrt(periodsPerYear)', () => {
    const bars = rangeBars(40)
    const out = parkinsonVol(bars, 10, 1)
    const expected = Math.sqrt(Math.log(101 / 99) ** 2 / (4 * Math.log(2)))
    for (let i = 0; i < 9; i += 1) expect(out[i] ?? null).toBeNull()
    for (let i = 9; i < bars.length; i += 1) expect(out[i]!).toBeCloseTo(expected, 10)
    expect(out.length).toBe(bars.length)
  })

  it('period 0 全 null 不抛；空输入为空数组', () => {
    expect(allNull(parkinsonVol(rangeBars(20), 0, 1))).toBe(true)
    expect(parkinsonVol([], 10, 1)).toEqual([])
  })
})

describe('garmanKlassVol', () => {
  it('c = o 时开收项为 0，预热后等于 0.5·ln(h/l)² 开方再乘 sqrt(periodsPerYear)', () => {
    const bars = rangeBars(40)
    const out = garmanKlassVol(bars, 10, 1)
    const expected = Math.sqrt(0.5 * Math.log(101 / 99) ** 2)
    for (let i = 0; i < 9; i += 1) expect(out[i] ?? null).toBeNull()
    for (let i = 9; i < bars.length; i += 1) expect(out[i]!).toBeCloseTo(expected, 10)
    expect(out.length).toBe(bars.length)
  })

  it('period 0 全 null 不抛；空输入为空数组', () => {
    expect(allNull(garmanKlassVol(rangeBars(20), 0, 1))).toBe(true)
    expect(garmanKlassVol([], 10, 1)).toEqual([])
  })
})

describe('turnoverProxy', () => {
  it('最近 period 根 close · volume 的均值', () => {
    const bars: Bar[] = [
      { o: 1, h: 1, l: 1, c: 1, v: 10 },
      { o: 2, h: 2, l: 2, c: 2, v: 20 },
      { o: 3, h: 3, l: 3, c: 3, v: 30 },
    ]
    const out = turnoverProxy(bars, 2)
    expect(out[0] ?? null).toBeNull()
    // (1·10 + 2·20) / 2 = 25
    expect(out[1]!).toBeCloseTo(25, 10)
    // (2·20 + 3·30) / 2 = 65
    expect(out[2]!).toBeCloseTo(65, 10)
    expect(out.length).toBe(bars.length)
  })

  it('period 0 全 null 不抛；空输入为空数组', () => {
    expect(allNull(turnoverProxy(volumeBars(20), 0))).toBe(true)
    expect(turnoverProxy([], 20)).toEqual([])
  })
})

describe('volumeZscore', () => {
  it('成交量常数时标准差为 0，输出 null', () => {
    const out = volumeZscore(flatBars(20), 5)
    expect(allNull(out)).toBe(true)
  })

  it('v = 1..40 period 5 时第 5 项为 (5 − 3) / stdev([1,2,3,4,5])', () => {
    const out = volumeZscore(volumeBars(40), 5)
    expect(out[3] ?? null).toBeNull()
    expect(out[4]!).toBeCloseTo(1.2649, 3)
    expect(out.length).toBe(40)
  })

  it('period 0 全 null 不抛；空输入为空数组', () => {
    expect(allNull(volumeZscore(volumeBars(20), 0))).toBe(true)
    expect(volumeZscore([], 20)).toEqual([])
  })
})
