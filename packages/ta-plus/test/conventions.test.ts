// SPDX-License-Identifier: CPAL-1.0
// 约定类测试：与 packages/engine-core/src/strategy/ta 的既有约定逐条对齐，不依赖任何数值参照：
//   1) 输出与输入等长；2) 第 i 项只用 ≤ i 的数据（因果：裁掉尾部不改变历史值）；
//   3) 不修改输入；4) 非法周期抛 RangeError；5) 预热期是 null 而不是 0 或 NaN。
import { describe, expect, it } from 'vitest'
import type { Bar, Series } from '../src/index'
import {
  adxr,
  amihudIlliquidity,
  atrPercent,
  avgDev,
  bop,
  cmo,
  downsideVolatility,
  efficiencyRatio,
  emaDistance,
  emaSlope,
  kurtosis,
  maxDrawdown,
  pricePosition,
  realizedVolatility,
  skewness,
  smaDistance,
  tsi,
  variance,
  volumeRatio,
  zScore,
} from '../src/index'
import { barsFrom, lcgSeries } from './fixtures'

const values = lcgSeries(40)
const volumes = lcgSeries(40, 999)
const returns = values.map((v, i) => (i === 0 ? 0 : v / values[i - 1]! - 1))
const bars: Bar[] = barsFrom(lcgSeries(40, 4242))
const adxLike: Series = values.map((v, i) => (i < 5 ? null : v))

const cases: Array<{ name: string; run: (n: number) => Series }> = [
  { name: 'realizedVolatility', run: (n) => realizedVolatility(returns.slice(0, n), 3) },
  { name: 'downsideVolatility', run: (n) => downsideVolatility(returns.slice(0, n), 3) },
  { name: 'skewness', run: (n) => skewness(values.slice(0, n), 3) },
  { name: 'kurtosis', run: (n) => kurtosis(values.slice(0, n), 4) },
  { name: 'maxDrawdown', run: (n) => maxDrawdown(values.slice(0, n), 3) },
  { name: 'atrPercent', run: (n) => atrPercent(bars.slice(0, n), 3) },
  { name: 'amihudIlliquidity', run: (n) => amihudIlliquidity(bars.slice(0, n), 3) },
  { name: 'cmo', run: (n) => cmo(values.slice(0, n), 3) },
  { name: 'tsi', run: (n) => tsi(values.slice(0, n), { slow: 3, fast: 2 }) },
  { name: 'efficiencyRatio', run: (n) => efficiencyRatio(values.slice(0, n), 3) },
  { name: 'smaDistance', run: (n) => smaDistance(values.slice(0, n), 3) },
  { name: 'emaDistance', run: (n) => emaDistance(values.slice(0, n), 3) },
  { name: 'emaSlope', run: (n) => emaSlope(values.slice(0, n), 3, 2) },
  { name: 'zScore', run: (n) => zScore(values.slice(0, n), 3) },
  { name: 'volumeRatio', run: (n) => volumeRatio(volumes.slice(0, n), 3) },
  { name: 'pricePosition', run: (n) => pricePosition(bars.slice(0, n), 3) },
  { name: 'avgDev', run: (n) => avgDev(values.slice(0, n), 3) },
  { name: 'variance', run: (n) => variance(values.slice(0, n), 3) },
  { name: 'bop', run: (n) => bop(bars.slice(0, n)) },
  { name: 'adxr', run: (n) => adxr(adxLike.slice(0, n), 3) },
]

describe('与既有 ta 约定一致', () => {
  it('每个序列指标的输出长度都等于输入长度', () => {
    for (const c of cases) expect(c.run(values.length).length, c.name).toBe(values.length)
  })

  it('输出里没有 NaN / Infinity（预热期是 null，不是 0 或 NaN）', () => {
    for (const c of cases) {
      for (const v of c.run(values.length)) {
        if (v === null) continue
        expect(Number.isFinite(v), `${c.name} 出现了非有限值 ${String(v)}`).toBe(true)
      }
    }
  })

  it('因果性：只用尾部数据不影响历史值（截断到 25 根后前 25 项逐项一致）', () => {
    for (const c of cases) {
      const full = c.run(values.length)
      const prefix = c.run(25)
      for (let i = 0; i < 25; i++) {
        const a = full[i] ?? null
        const b = prefix[i] ?? null
        if (a === null || b === null) expect(b, `${c.name}[${i}]`).toBe(a)
        else expect(b, `${c.name}[${i}]`).toBeCloseTo(a, 12)
      }
    }
  })

  it('不修改输入数组（值序列与 K 线对象都不被写坏）', () => {
    const valuesCopy = values.slice()
    const barsCopy = JSON.parse(JSON.stringify(bars)) as Bar[]
    for (const c of cases) c.run(values.length)
    expect(values).toEqual(valuesCopy)
    expect(bars).toEqual(barsCopy)
  })

  it('非法周期（0、负数、小数）抛 RangeError', () => {
    expect(() => cmo(values, 0)).toThrow(RangeError)
    expect(() => smaDistance(values, -3)).toThrow(RangeError)
    expect(() => efficiencyRatio(values, 2.5)).toThrow(RangeError)
    expect(() => atrPercent(bars, 0)).toThrow(RangeError)
    expect(() => volumeRatio(volumes, 0)).toThrow(RangeError)
    expect(() => pricePosition(bars, 0)).toThrow(RangeError)
  })

  it('预热期是 null：period=5 的 zScore 前 4 项为 null', () => {
    expect(zScore(values, 5).slice(0, 4)).toEqual([null, null, null, null])
  })
})
