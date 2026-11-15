// SPDX-License-Identifier: CPAL-1.0
// 与 engine-core 的关系测试（批 9 收尾）：把「5 个同口径同值转发」「4 个口径不同」写成可执行的断言，
// 让 README 的差异表不能只靠文字成立。
//   转发：直接 import engine-core 的 ta 实现，与本包导出的输出逐项比对——若有人把转发改回第二套实现，
//         数值一旦偏离就红。
//   差异：每个差异给一条「如果两者真的一样，这条会红」的用例（种子口径 / 区间为 0 的兜底 / null 窗口 / 单位）。
// 独立性说明：这些断言证明的是「本包与 engine-core 的分工」，不是「本包数值对外部真理正确」；
//   外部参照值在 directional/osc-ext/regression/volatility-ext/stat-ext 各自的测试里。
import { describe, expect, it } from 'vitest'
import { adx, aroon, chaikinOscillator } from '../../engine-core/src/strategy/ta/oscillators'
import { stochastic } from '../../engine-core/src/strategy/ta/momentum'
import { linearRegression } from '../../engine-core/src/strategy/ta/overlap'
import { rollingCorr } from '../../engine-core/src/strategy/ta/alpha-ops'
import { rollingStd } from '../../engine-core/src/strategy/ta/volatility'
import {
  adOsc,
  aroonOsc,
  correl,
  dx,
  linRegIntercept,
  linRegSlope,
  minusDI,
  plusDI,
  stochF,
  variance,
} from '../src/index'
import type { Bar } from '../src/index'
import { BARS, CLOSES } from './fixtures-t1b'
import { barsFrom, lcgSeries } from './fixtures'

const PERIODS = [2, 3, 5, 14]
const randomBars: Bar[] = barsFrom(lcgSeries(40, 4242))

describe('转发：同口径同值的 5 个指标与 engine-core 逐项一致', () => {
  it('plusDI / minusDI 等于 engine-core adx().plusDi / .minusDi', () => {
    for (const period of PERIODS) {
      for (const bars of [BARS, randomBars]) {
        const core = adx(bars, period)
        expect(plusDI(bars, period), `plusDI period=${period}`).toStrictEqual(core.plusDi)
        expect(minusDI(bars, period), `minusDI period=${period}`).toStrictEqual(core.minusDi)
      }
    }
  })

  it('aroonOsc 等于 engine-core aroon().osc', () => {
    for (const period of PERIODS) {
      expect(aroonOsc(BARS, period)).toStrictEqual(aroon(BARS, period).osc)
      expect(aroonOsc(randomBars, period)).toStrictEqual(aroon(randomBars, period).osc)
    }
  })

  it('linRegSlope / linRegIntercept 等于 engine-core linearRegression().slope / .intercept', () => {
    for (const period of PERIODS) {
      const reg = linearRegression(CLOSES, period)
      expect(linRegSlope(CLOSES, period), `slope period=${period}`).toStrictEqual(reg.slope)
      expect(linRegIntercept(CLOSES, period), `intercept period=${period}`).toStrictEqual(reg.intercept)
    }
  })

  it('dx 由转发的两条 DI 合成：null 位置与 +DI / −DI 完全对齐', () => {
    const core = adx(randomBars, 5)
    const ours = dx(randomBars, 5)
    for (let i = 0; i < randomBars.length; i++) {
      const p = core.plusDi[i]
      const m = core.minusDi[i]
      const pNull = p === null || p === undefined
      const mNull = m === null || m === undefined
      if (pNull || mNull || p === m) expect(ours[i], `dx[${i}]`).toBeNull()
      else expect(ours[i], `dx[${i}]`).toBeCloseTo((100 * Math.abs(p - m)) / (p + m), 10)
    }
  })

  it('转发不继承 engine-core 的宽口径：非法周期在 engine-core 是「全 null」，在本包是抛 RangeError', () => {
    // engine-core 的一面：非法周期静默返回全 null（这是它文档写明的约定，不是 bug）。
    expect(adx(BARS, 0).plusDi.every((v) => v === null)).toBe(true)
    expect(aroon(BARS, -1).osc.every((v) => v === null)).toBe(true)
    expect(linearRegression(CLOSES, 2.5).slope.every((v) => v === null)).toBe(true)
    // 本包的一面：同一次调用必须抛错，不能静默吞掉（否则「非法周期统一抛错」就被转发破坏了）。
    expect(() => plusDI(BARS, 0)).toThrow(RangeError)
    expect(() => minusDI(BARS, 0)).toThrow(RangeError)
    expect(() => aroonOsc(BARS, -1)).toThrow(RangeError)
    expect(() => linRegSlope(CLOSES, 2.5)).toThrow(RangeError)
    expect(() => linRegIntercept(CLOSES, 2.5)).toThrow(RangeError)
  })
})

describe('口径不同：4 个不转发也不删除的指标，差异有断言兜住', () => {
  it('adOsc 与 engine-core chaikinOscillator 的 EMA 种子不同：起点数值不相等，随根数收敛', () => {
    const ours = adOsc(BARS, 2, 4)
    const core = chaikinOscillator(BARS, { fast: 2, slow: 4 })
    const start = 3 // max(fast, slow) − 1，两者的首个非 null 位置一致
    expect(ours[start]).not.toBeNull()
    expect(core[start]).not.toBeNull()
    const firstGap = Math.abs((ours[start] as number) - (core[start] as number))
    const lastGap = Math.abs((ours[9] as number) - (core[9] as number))
    // 种子口径：本包以第一个 A/D 值为种子（照 ta_ADOSC.c），engine-core 以首 period 个 A/D 的均值做种子。
    expect(firstGap).toBeGreaterThan(1e-6)
    expect(lastGap).toBeLessThan(firstGap)
  })

  it('stochF 与 engine-core stochastic() 只在「区间为 0」时不同：本包 K = 0（照 ta_STOCHF.c），engine-core 给 50', () => {
    // 正常 K 线（HH > LL）上两者逐项相等 —— 差异只有兜底值，不是两套公式。
    // K 完全逐位一致；D 的求和顺序不同（本包对稠密段做 SMA，engine-core 对窗口求和），末位差 < 1e-13。
    expect(stochF(BARS, 3, 2).k).toStrictEqual(stochastic(BARS, 3, 2).k)
    const oursD = stochF(BARS, 3, 2).d
    const coreD = stochastic(BARS, 3, 2).d
    for (let i = 0; i < oursD.length; i++) {
      if (coreD[i] === null) expect(oursD[i]).toBeNull()
      else expect(oursD[i], `d[${i}]`).toBeCloseTo(coreD[i] as number, 12)
    }
    const flat: Bar[] = Array.from({ length: 5 }, () => ({ o: 10, h: 10, l: 10, c: 10, v: 1 }))
    expect(stochF(flat, 3, 2).k.slice(2)).toEqual([0, 0, 0])
    expect(stochastic(flat, 3, 2).k.slice(2)).toEqual([50, 50, 50])
  })

  it('correl 与 engine-core rollingCorr：数值口径相同（都跳到窗口方差为 0 的情形），输入形状与 null 窗口处理不同', () => {
    const a = CLOSES
    const b = lcgSeries(CLOSES.length, 777)
    const ours = correl(a, b, 3)
    const core = rollingCorr(a, b, 3)
    for (let i = 2; i < a.length; i++) expect(ours[i], `correl[${i}]`).toBeCloseTo(core[i] as number, 12)
    // 差异面：rollingCorr 接受 (number|null)[]，任何窗口含 null 就给 null（0 号元素补齐的下标 4 落在
    // 窗口 4 / 5 / 6 里）；本包的入参是 number[]，含 null 的窗口在类型上就进不来，要调用方自己先补或裁。
    const gapped: Array<number | null> = a.map((v, i) => (i === 4 ? null : v))
    expect(rollingCorr(gapped, b, 3).slice(4, 7)).toEqual([null, null, null])
    expect(rollingCorr(gapped, b, 3)[7]).not.toBeNull()
  })

  it('variance 与 engine-core rollingStd：一个是方差、一个是标准差（单位不同），方差 = 标准差的平方', () => {
    const std = rollingStd(CLOSES, 4, 0)
    const vari = variance(CLOSES, 4, 0)
    for (let i = 3; i < CLOSES.length; i++) {
      expect(vari[i], `variance[${i}]`).toBeCloseTo((std[i] as number) ** 2, 10)
      if (vari[i] !== null) expect(vari[i]).not.toBeCloseTo(std[i] as number, 10)
    }
  })
})
