// SPDX-License-Identifier: CPAL-1.0
// alpha158.ts 的单元测试：目录长度与命名、VWAP0 缺省、computeAlpha158 的序列形状。
import { describe, expect, it } from 'vitest'
import { ALPHA158_WINDOWS, alpha158Catalog, computeAlpha158 } from '../src/strategy/alpha158'
import { alphaFactorById } from '../src/strategy/factors-alpha'
import type { Candle } from '../src/types'

/** 70 根合成 K 线：确定性的锯齿走势，避免窗口内方差为 0。 */
function syntheticCandles(count: number): Candle[] {
  return Array.from({ length: count }, (_, i) => {
    const c = 100 + ((i * 37) % 17) - 8
    const o = c - 1
    return {
      t: i * 60_000,
      o,
      h: Math.max(o, c) + 1,
      l: Math.min(o, c) - 1,
      c,
      v: 100 + ((i * 13) % 23),
    }
  })
}

describe('alpha158Catalog', () => {
  const catalog = alpha158Catalog()

  it('共 157 条（158 减 VWAP0），名字唯一', () => {
    expect(catalog.length).toBe(157)
    const names = catalog.map((entry) => entry.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('含 KMID / ROC5 / VSUMD60，不含 VWAP0', () => {
    const names = new Set(catalog.map((entry) => entry.name))
    expect(names.has('KMID')).toBe(true)
    expect(names.has('ROC5')).toBe(true)
    expect(names.has('VSUMD60')).toBe(true)
    expect(names.has('VWAP0')).toBe(false)
  })

  it('29 族 × 5 窗口的 period 等于窗口', () => {
    for (const window of ALPHA158_WINDOWS) {
      const rolling = catalog.filter((entry) => entry.name.endsWith(`${window}`) && entry.period === window)
      expect(rolling.length).toBe(29)
    }
  })

  it('每条 factorId 都能在 factors-alpha 里找到定义', () => {
    for (const entry of catalog) {
      expect(alphaFactorById(entry.factorId)).toBeDefined()
    }
  })
})

describe('computeAlpha158', () => {
  const candles = syntheticCandles(70)
  const result = computeAlpha158(candles)

  it('每条序列长度 70', () => {
    const names = Object.keys(result)
    expect(names.length).toBe(157)
    for (const name of names) {
      expect(result[name]!.length).toBe(70)
    }
  })

  it('后段（末 5 根）非 null', () => {
    for (const [name, series] of Object.entries(result)) {
      for (let i = 65; i < series.length; i++) {
        const value = series[i]
        expect(value, `${name} @ ${i}`).not.toBeNull()
        expect(value, `${name} @ ${i}`).not.toBeUndefined()
      }
    }
  })

  it('空输入得到空列', () => {
    const empty = computeAlpha158([])
    for (const name of Object.keys(empty)) {
      expect(empty[name]).toEqual([])
    }
  })
})
