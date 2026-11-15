// SPDX-License-Identifier: CPAL-1.0
// pbo.ts 的验收测试：确定性、列顺序无关、伪随机区间、自定义指标、参数校验与退化直线。
import { describe, expect, it } from 'vitest'
import { cscvPbo } from '../src/pbo'

const mulberry32 = (seed: number) => () => {
  seed |= 0
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

function alternatingData(): number[][] {
  const rows: number[][] = []
  for (let t = 0; t < 64; t++) {
    const even = t % 2 === 0
    rows.push([even ? 0.02 : 0, even ? 0 : -0.02, even ? 0.01 : -0.01])
  }
  return rows
}

describe('cscvPbo', () => {
  it('identifies a strategy that is best in every block', () => {
    const result = cscvPbo(alternatingData(), { blocks: 8 })
    expect(result.combos).toBe(70)
    expect(result.pbo).toBe(0)
    for (const lambda of result.lambdas) expect(lambda).toBeGreaterThan(0)
    expect(result.oosRankMean).toBeCloseTo(0.75, 12)
    expect(result.probLossOos).toBe(0)
  })

  it('does not depend on the input column order', () => {
    const swapped = alternatingData().map((row) => [row[1]!, row[0]!, row[2]!])
    const result = cscvPbo(swapped, { blocks: 8 })
    expect(result.pbo).toBe(0)
  })

  it('is deterministic on seeded pseudo-random returns', () => {
    const rand = mulberry32(42)
    const rows: number[][] = []
    for (let t = 0; t < 64; t++) {
      const row: number[] = []
      for (let j = 0; j < 5; j++) row.push((rand() - 0.5) * 0.01)
      rows.push(row)
    }

    const first = cscvPbo(rows, { blocks: 8 })
    const second = cscvPbo(rows, { blocks: 8 })

    expect(first.pbo).toBeGreaterThanOrEqual(0.2)
    expect(first.pbo).toBeLessThanOrEqual(0.8)
    expect(first.lambdas.length).toBe(70)
    expect(first.combos).toBe(70)
    expect(second).toEqual(first)
  })

  it('accepts a custom metric', () => {
    const metric = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length
    const result = cscvPbo(alternatingData(), { blocks: 8, metric })
    expect(result.pbo).toBe(0)
  })

  it('rejects invalid arguments', () => {
    const data = alternatingData()
    expect(() => cscvPbo(data, { blocks: 7 })).toThrow(RangeError)
    expect(() => cscvPbo(data, { blocks: 100 })).toThrow(RangeError)
    expect(() => cscvPbo(data.map((row) => [row[0]!]))).toThrow(RangeError)
  })

  it('returns a finite degradation line', () => {
    const result = cscvPbo(alternatingData(), { blocks: 8 })
    expect(Number.isFinite(result.degradation.slope)).toBe(true)
    expect(Number.isFinite(result.degradation.intercept)).toBe(true)
  })
})
