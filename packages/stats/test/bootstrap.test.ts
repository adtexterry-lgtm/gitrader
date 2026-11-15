// SPDX-License-Identifier: CPAL-1.0
// bootstrap.ts 的单元测试：随机数可复现、分位数插值、自助法行为与非法参数。

import { describe, expect, it } from 'vitest'
import { circularBlockBootstrap, mulberry32, quantile } from '../src/bootstrap'

const meanOf = (ys: number[]): number => {
  let sum = 0
  for (const y of ys) sum += y
  return sum / ys.length
}

const drawSeries = (seed: number, count: number, shift: number): number[] => {
  const rand = mulberry32(seed)
  const out: number[] = []
  for (let i = 0; i < count; i++) out.push(rand() + shift)
  return out
}

describe('mulberry32', () => {
  it('同种子序列逐个相等且落在 [0,1)', () => {
    const a = mulberry32(42)
    const b = mulberry32(42)
    for (let i = 0; i < 3; i++) {
      const x = a()
      const y = b()
      expect(x).toBe(y)
      expect(x).toBeGreaterThanOrEqual(0)
      expect(x).toBeLessThan(1)
      expect(y).toBeGreaterThanOrEqual(0)
      expect(y).toBeLessThan(1)
    }
  })
})

describe('quantile', () => {
  it('按 R type 7 线性插值', () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5)
    expect(quantile([1, 2, 3, 4], 0)).toBe(1)
    expect(quantile([1, 2, 3, 4], 1)).toBe(4)
    expect(quantile([1, 2, 3, 4], 0.25)).toBe(1.75)
  })
})

describe('circularBlockBootstrap 确定性', () => {
  const xs = drawSeries(1, 100, -0.4)

  it('同种子两次调用 values 深度相等', () => {
    const first = circularBlockBootstrap(xs, { blockLen: 3, samples: 200, seed: 7 })
    const second = circularBlockBootstrap(xs, { blockLen: 3, samples: 200, seed: 7 })
    expect(first.values.length).toBe(200)
    expect(first.values).toEqual(second.values)
  })

  it('换种子 values 不等', () => {
    const base = circularBlockBootstrap(xs, { blockLen: 3, samples: 200, seed: 7 })
    const other = circularBlockBootstrap(xs, { blockLen: 3, samples: 200, seed: 8 })
    expect(other.values).not.toEqual(base.values)
  })
})

describe('circularBlockBootstrap 返回形状', () => {
  const xs = drawSeries(5, 100, -0.4)
  const res = circularBlockBootstrap(xs, { blockLen: 5, samples: 300, seed: 11 })

  it('长度、区间与 p 值范围自洽', () => {
    expect(res.values.length).toBe(300)
    expect(res.ci[0]).toBeLessThanOrEqual(res.mean)
    expect(res.mean).toBeLessThanOrEqual(res.ci[1])
    expect(res.pValue).toBeGreaterThanOrEqual(0)
    expect(res.pValue).toBeLessThanOrEqual(1)
  })
})

describe('circularBlockBootstrap 常数序列', () => {
  it('统计量恒定，区间退化，p 值为 0', () => {
    const xs: number[] = []
    for (let i = 0; i < 50; i++) xs.push(0.01)
    const res = circularBlockBootstrap(xs, { blockLen: 4, samples: 100, seed: 3, stat: meanOf })
    for (const v of res.values) expect(Math.abs(v - 0.01)).toBeLessThan(1e-12)
    expect(res.ci[0]).toBeCloseTo(0.01, 12)
    expect(res.ci[1]).toBeCloseTo(0.01, 12)
    expect(res.pValue).toBe(0)
  })
})

describe('circularBlockBootstrap 单元素', () => {
  it('重抽样后仍为原值', () => {
    const res = circularBlockBootstrap([3], { blockLen: 1, samples: 10, seed: 2, stat: meanOf })
    expect(res.values.length).toBe(10)
    for (const v of res.values) expect(v).toBe(3)
  })
})

describe('circularBlockBootstrap 强正收益', () => {
  it('默认夏普下 p 值为 0 且区间下界为正', () => {
    const xs = drawSeries(3, 200, 0.5)
    const res = circularBlockBootstrap(xs, { blockLen: 5, samples: 200, seed: 4 })
    expect(res.pValue).toBe(0)
    expect(res.ci[0]).toBeGreaterThan(0)
  })
})

describe('circularBlockBootstrap 非法参数', () => {
  const xs = [0.1, -0.2, 0.3, 0.4, -0.5]

  it('blockLen 为 0 抛 RangeError', () => {
    expect(() => circularBlockBootstrap(xs, { blockLen: 0, samples: 10 })).toThrow(RangeError)
  })

  it('samples 为 0 抛 RangeError', () => {
    expect(() => circularBlockBootstrap(xs, { blockLen: 2, samples: 0 })).toThrow(RangeError)
  })

  it('level 为 1.5 抛 RangeError', () => {
    expect(() => circularBlockBootstrap(xs, { blockLen: 2, samples: 10, level: 1.5 })).toThrow(RangeError)
  })

  it('空 xs 抛 RangeError', () => {
    expect(() => circularBlockBootstrap([], { blockLen: 2, samples: 10 })).toThrow(RangeError)
  })
})
