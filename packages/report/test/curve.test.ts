// SPDX-License-Identifier: CPAL-1.0
// 曲线工具：降采样保真、回撤序列、月度分桶。
import { describe, expect, it } from 'vitest'
import { drawdownSeries, MIN_SAMPLE_LIMIT, monthKeyUtc, monthlyReturns, sampleCurve, sampleCurveIndices } from '../src/curve'
import type { CurvePoint } from '../src/types'
import { buildMonthlyCurve } from './fixture'

describe('降采样', () => {
  it('点数不超过上限时原样返回', () => {
    const values = [1, 2, 3, 4, 5]
    expect(sampleCurveIndices(values, 240, 1)).toEqual([0, 1, 2, 3, 4])
  })

  it('上限小于 10 且确实需要降采样时抛错（照 QD 的下限）', () => {
    const values = Array.from({ length: 100 }, (_, i) => 100 + i)
    expect(() => sampleCurveIndices(values, MIN_SAMPLE_LIMIT - 1, 100)).toThrow(RangeError)
  })

  it('保留首尾、最高点、最低点与最大回撤区间，长度不超过上限', () => {
    // 0..199，第 60 点冲到 300（峰），第 90 点跌到 120（谷），其余缓慢上行。
    const values: number[] = []
    for (let i = 0; i < 200; i++) values.push(i < 60 ? 130 + i : i < 90 ? 300 - (i - 60) * 6 : 120 + (i - 90) * 0.2)
    const idx = sampleCurveIndices(values, 40, 100)
    expect(idx.length).toBeLessThanOrEqual(40)
    expect(idx[0]).toBe(0)
    expect(idx[idx.length - 1]).toBe(199)
    const sampled = idx.map((i) => values[i]!)
    expect(Math.max(...sampled)).toBe(300)
    expect(Math.min(...sampled)).toBe(120)
    expect(sampled[0]).toBe(130)
  })

  it('sampleCurve 返回的点与下标一致（顺序不变、时间戳取自原点）', () => {
    const points: CurvePoint[] = Array.from({ length: 500 }, (_, i) => ({ t: i * 1000, v: 1000 + (i % 7) * 3 + i }))
    const out = sampleCurve(points, 60, points[0]!.v)
    expect(out.length).toBeLessThanOrEqual(60)
    for (let i = 1; i < out.length; i++) expect(out[i]!.t).toBeGreaterThan(out[i - 1]!.t)
  })
})

describe('回撤序列', () => {
  it('峰值从起算权益算起，逐点回撤 = v / peak - 1', () => {
    const points: CurvePoint[] = [
      { t: 0, v: 100 },
      { t: 1, v: 120 },
      { t: 2, v: 90 },
      { t: 3, v: 150 },
    ]
    const dd = drawdownSeries(points, 100)
    expect(dd[0]).toBeCloseTo(0, 12)
    expect(dd[1]).toBeCloseTo(0, 12)
    expect(dd[2]).toBeCloseTo(90 / 120 - 1, 12)
    expect(dd[3]).toBeCloseTo(0, 12)
  })
})

describe('月度分桶', () => {
  it('月末权益环比：110→99 = -0.1，99→108 = 0.0909', () => {
    const months = monthlyReturns(buildMonthlyCurve())
    expect(months.map((m) => m.key)).toEqual(['2023-11', '2023-12', '2024-01'])
    expect(months[0]?.ret).toBeCloseTo(110 / 100 - 1, 12)
    expect(months[1]?.ret).toBeCloseTo(99 / 110 - 1, 12)
    expect(months[2]?.ret).toBeCloseTo(108 / 99 - 1, 12)
    expect(months[0]?.points).toBe(3)
    expect(months[2]?.points).toBe(2)
  })

  it('空曲线得到空数组；UTC 月键补零', () => {
    expect(monthlyReturns([])).toEqual([])
    expect(monthKeyUtc(Date.UTC(2024, 8, 5))).toBe('2024-09')
    expect(monthKeyUtc(Date.UTC(2024, 11, 31, 23, 59))).toBe('2024-12')
  })
})
