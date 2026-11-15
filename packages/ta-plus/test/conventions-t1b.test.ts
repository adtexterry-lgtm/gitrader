// SPDX-License-Identifier: CPAL-1.0
// T1b 新增指标的约定测试：与 T1a 的 conventions.test.ts 同样的五条（等长 / 无 NaN / 因果 / 不改输入 / 非法周期抛错），
// 单独成文件是为了不动已交付的 T1a 用例。
import { describe, expect, it } from 'vitest'
import type { Bar, Series } from '../src/index'
import {
  adOsc,
  aroonOsc,
  avgPrice,
  beta,
  correl,
  dx,
  linRegAngle,
  linRegIntercept,
  linRegSlope,
  maxIndex,
  medPrice,
  midPoint,
  midPrice,
  minIndex,
  minusDI,
  minusDM,
  natr,
  plusDI,
  plusDM,
  rollingMax,
  rollingMin,
  stochF,
  t3,
  trima,
  tsf,
  typPrice,
  wclPrice,
} from '../src/index'
import { barsFrom, lcgSeries } from './fixtures'

const values = lcgSeries(40)
const other = lcgSeries(40, 777)
const bars: Bar[] = barsFrom(lcgSeries(40, 4242))

const seriesCases: Array<{ name: string; run: (n: number) => Series }> = [
  { name: 'avgPrice', run: (n) => avgPrice(bars.slice(0, n)) },
  { name: 'medPrice', run: (n) => medPrice(bars.slice(0, n)) },
  { name: 'typPrice', run: (n) => typPrice(bars.slice(0, n)) },
  { name: 'wclPrice', run: (n) => wclPrice(bars.slice(0, n)) },
  { name: 'rollingMax', run: (n) => rollingMax(values.slice(0, n), 5) },
  { name: 'rollingMin', run: (n) => rollingMin(values.slice(0, n), 5) },
  { name: 'maxIndex', run: (n) => maxIndex(values.slice(0, n), 5) },
  { name: 'minIndex', run: (n) => minIndex(values.slice(0, n), 5) },
  { name: 'midPoint', run: (n) => midPoint(values.slice(0, n), 5) },
  { name: 'midPrice', run: (n) => midPrice(bars.slice(0, n), 5) },
  { name: 'trima', run: (n) => trima(values.slice(0, n), 5) },
  { name: 't3', run: (n) => t3(values.slice(0, n), 3) },
  { name: 'plusDM', run: (n) => plusDM(bars.slice(0, n), 5) },
  { name: 'minusDM', run: (n) => minusDM(bars.slice(0, n), 5) },
  { name: 'plusDI', run: (n) => plusDI(bars.slice(0, n), 5) },
  { name: 'minusDI', run: (n) => minusDI(bars.slice(0, n), 5) },
  { name: 'dx', run: (n) => dx(bars.slice(0, n), 5) },
  { name: 'aroonOsc', run: (n) => aroonOsc(bars.slice(0, n), 5) },
  { name: 'stochF.k', run: (n) => stochF(bars.slice(0, n), 5, 3).k },
  { name: 'stochF.d', run: (n) => stochF(bars.slice(0, n), 5, 3).d },
  { name: 'correl', run: (n) => correl(values.slice(0, n), other.slice(0, n), 5) },
  { name: 'beta', run: (n) => beta(values.slice(0, n), other.slice(0, n), 5) },
  { name: 'linRegSlope', run: (n) => linRegSlope(values.slice(0, n), 5) },
  { name: 'linRegIntercept', run: (n) => linRegIntercept(values.slice(0, n), 5) },
  { name: 'linRegAngle', run: (n) => linRegAngle(values.slice(0, n), 5) },
  { name: 'tsf', run: (n) => tsf(values.slice(0, n), 5) },
  { name: 'natr', run: (n) => natr(bars.slice(0, n), 5) },
  { name: 'adOsc', run: (n) => adOsc(bars.slice(0, n), 3, 10) },
]

describe('T1b 新增指标与既有 ta 约定一致', () => {
  it('输出长度等于输入长度', () => {
    for (const c of seriesCases) expect(c.run(40).length, c.name).toBe(40)
  })

  it('输出无 NaN / Infinity（预热期是 null）', () => {
    for (const c of seriesCases) {
      for (const v of c.run(40)) {
        if (v === null) continue
        expect(Number.isFinite(v), `${c.name} 出现非有限值 ${String(v)}`).toBe(true)
      }
    }
  })

  it('因果性：截断尾部不改变历史值', () => {
    for (const c of seriesCases) {
      const full = c.run(40)
      const prefix = c.run(25)
      for (let i = 0; i < 25; i++) {
        const a = full[i] ?? null
        const b = prefix[i] ?? null
        if (a === null || b === null) expect(b, `${c.name}[${i}]`).toBe(a)
        else expect(b, `${c.name}[${i}]`).toBeCloseTo(a, 10)
      }
    }
  })

  it('不修改输入', () => {
    const valuesCopy = values.slice()
    const barsCopy = JSON.parse(JSON.stringify(bars)) as Bar[]
    for (const c of seriesCases) c.run(40)
    expect(values).toEqual(valuesCopy)
    expect(bars).toEqual(barsCopy)
  })

  it('非法周期抛 RangeError', () => {
    expect(() => trima(values, 0)).toThrow(RangeError)
    expect(() => t3(values, -1)).toThrow(RangeError)
    expect(() => aroonOsc(bars, 0)).toThrow(RangeError)
    expect(() => natr(bars, 0)).toThrow(RangeError)
    expect(() => adOsc(bars, 0, 3)).toThrow(RangeError)
    expect(() => correl(values, other, 0)).toThrow(RangeError)
    expect(() => beta(values, other, 2.5)).toThrow(RangeError)
  })

  it('对齐同源定义：plusDI 与 minusDI 在同一窗口上的几何关系成立（+DI 或 −DI 至少一方 > 0）', () => {
    const p = plusDI(bars, 5)
    const m = minusDI(bars, 5)
    for (let i = 5; i < bars.length; i++) {
      const a = p[i]
      const b = m[i]
      if (a == null || b == null) continue
      const ai: number = a
      const bi: number = b
      const d = dx(bars, 5)[i]
      if (d == null) continue
      expect(ai + bi).toBeGreaterThan(0)
      expect(d).toBeCloseTo((100 * Math.abs(ai - bi)) / (ai + bi), 10)
    }
  })
})
