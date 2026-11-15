// SPDX-License-Identifier: CPAL-1.0
// 非法周期统一抛错（批 9 主题一第 2 条）：把「每个吃周期参数的导出」列成表，逐个喂非法值，
// 要求一律抛 RangeError——不是返回全 null、不是 NaN、也不是别的错误类型。
// 这张表同时是转发指标的护栏：engine-core 的实现遇到非法周期返回全 null（它自己文档写明），
// 本包的包装函数必须先抛错，所以 plusDI / aroonOsc / linRegSlope 之类出现在表里是必须红的。
// 反证记录见 REPORT-T1.md：把 internal.ts 的 assertPeriod 判断故意改坏（改成什么都不做）后，
// 本文件 7 条用例全红；恢复后全绿。
import { describe, expect, it } from 'vitest'
import type { Bar, Series } from '../src/index'
import {
  adOsc,
  adxr,
  amihudIlliquidity,
  aroonOsc,
  atrPercent,
  avgDev,
  beta,
  cmo,
  correl,
  downsideVolatility,
  dx,
  efficiencyRatio,
  emaDistance,
  emaSlope,
  kurtosis,
  levels,
  linRegAngle,
  linRegIntercept,
  linRegSlope,
  maxDrawdown,
  maxIndex,
  midPoint,
  midPrice,
  minIndex,
  minusDI,
  minusDM,
  natr,
  plusDI,
  plusDM,
  pricePosition,
  realizedVolatility,
  rollingMax,
  rollingMin,
  skewness,
  smaDistance,
  stochF,
  t3,
  trima,
  tsf,
  tsi,
  variance,
  volumeRatio,
  zScore,
} from '../src/index'
import { BARS, CLOSES, VOLUMES } from './fixtures-t1b'
import { barsFrom, lcgSeries } from './fixtures'

/** 非法周期：0、负数、小数、NaN、Infinity 五类。 */
const INVALID = [0, -1, 2.5, Number.NaN, Number.POSITIVE_INFINITY]

const randomBars: Bar[] = barsFrom(lcgSeries(40, 4242))
/** 与 CLOSES 等长的第二条序列（correl / beta 要求等长）。 */
const RANDOM = lcgSeries(CLOSES.length, 777)

/** 吃「价格 / 成交量序列 + period」的导出。 */
const priceSeries: Array<{ name: string; run: (p: number) => Series }> = [
  { name: 'cmo', run: (p) => cmo(CLOSES, p) },
  { name: 'efficiencyRatio', run: (p) => efficiencyRatio(CLOSES, p) },
  { name: 'smaDistance', run: (p) => smaDistance(CLOSES, p) },
  { name: 'emaDistance', run: (p) => emaDistance(CLOSES, p) },
  { name: 'emaSlope', run: (p) => emaSlope(CLOSES, p) },
  { name: 'zScore', run: (p) => zScore(CLOSES, p) },
  { name: 'realizedVolatility', run: (p) => realizedVolatility(CLOSES, p) },
  { name: 'downsideVolatility', run: (p) => downsideVolatility(CLOSES, p) },
  { name: 'skewness', run: (p) => skewness(CLOSES, p) },
  { name: 'kurtosis', run: (p) => kurtosis(CLOSES, p) },
  { name: 'maxDrawdown', run: (p) => maxDrawdown(CLOSES, p) },
  { name: 'avgDev', run: (p) => avgDev(CLOSES, p) },
  { name: 'variance', run: (p) => variance(CLOSES, p) },
  { name: 'trima', run: (p) => trima(CLOSES, p) },
  { name: 't3', run: (p) => t3(CLOSES, p) },
  { name: 'rollingMax', run: (p) => rollingMax(CLOSES, p) },
  { name: 'rollingMin', run: (p) => rollingMin(CLOSES, p) },
  { name: 'maxIndex', run: (p) => maxIndex(CLOSES, p) },
  { name: 'minIndex', run: (p) => minIndex(CLOSES, p) },
  { name: 'midPoint', run: (p) => midPoint(CLOSES, p) },
  { name: 'volumeRatio', run: (p) => volumeRatio(VOLUMES, p) },
  { name: 'linRegSlope', run: (p) => linRegSlope(CLOSES, p) },
  { name: 'linRegIntercept', run: (p) => linRegIntercept(CLOSES, p) },
  { name: 'linRegAngle', run: (p) => linRegAngle(CLOSES, p) },
  { name: 'tsf', run: (p) => tsf(CLOSES, p) },
  { name: 'correl', run: (p) => correl(CLOSES, RANDOM, p) },
  { name: 'beta', run: (p) => beta(CLOSES, RANDOM, p) },
  // ADXR 吃「ADX 序列 + period」，输入形状同上，一并纳入。
  { name: 'adxr', run: (p) => adxr(dx(BARS, 3), p) },
]

/** 吃「K 线 + period」的导出（转发 engine-core 的 4 个也在内）。 */
const barSeries: Array<{ name: string; run: (p: number) => Series }> = [
  { name: 'atrPercent', run: (p) => atrPercent(BARS, p) },
  { name: 'amihudIlliquidity', run: (p) => amihudIlliquidity(BARS, p) },
  { name: 'pricePosition', run: (p) => pricePosition(BARS, p) },
  { name: 'midPrice', run: (p) => midPrice(BARS, p) },
  { name: 'plusDM', run: (p) => plusDM(BARS, p) },
  { name: 'minusDM', run: (p) => minusDM(BARS, p) },
  { name: 'plusDI（转发）', run: (p) => plusDI(BARS, p) },
  { name: 'minusDI（转发）', run: (p) => minusDI(BARS, p) },
  { name: 'dx', run: (p) => dx(BARS, p) },
  { name: 'aroonOsc（转发）', run: (p) => aroonOsc(BARS, p) },
  { name: 'natr', run: (p) => natr(BARS, p) },
  { name: 'natr（40 根随机）', run: (p) => natr(randomBars, p) },
]

describe('非法周期一律抛 RangeError（统一口径）', () => {
  it('价格 / 成交量序列类：0 / 负数 / 小数 / NaN / Infinity 全抛 RangeError', () => {
    for (const c of priceSeries) {
      for (const bad of INVALID) {
        expect(() => c.run(bad), `${c.name}(${String(bad)})`).toThrow(RangeError)
      }
    }
  })

  it('K 线类（含 4 个转发指标）：0 / 负数 / 小数 / NaN / Infinity 全抛 RangeError', () => {
    for (const c of barSeries) {
      for (const bad of INVALID) {
        expect(() => c.run(bad), `${c.name}(${String(bad)})`).toThrow(RangeError)
      }
    }
  })

  it('周期参数的「名字」也进错误信息：多周期指标点名是哪一个错了', () => {
    expect(() => tsi(CLOSES, { slow: 0 })).toThrow(/slow/)
    expect(() => tsi(CLOSES, { fast: 1.5 })).toThrow(/fast/)
    expect(() => emaSlope(CLOSES, 3, 0)).toThrow(/slopePeriod/)
    expect(() => adOsc(BARS, 0, 10)).toThrow(/fastPeriod/)
    expect(() => adOsc(BARS, 3, -2)).toThrow(/slowPeriod/)
    expect(() => realizedVolatility(CLOSES, 3, { periodsPerYear: 0 })).toThrow(/periodsPerYear/)
    expect(() => downsideVolatility(CLOSES, 3, { periodsPerYear: 2.5 })).toThrow(/periodsPerYear/)
  })

  it('stochF 的两个周期、levels 的 options.period 同样抛 RangeError', () => {
    expect(() => stochF(BARS, 0, 3)).toThrow(RangeError)
    expect(() => stochF(BARS, 3, 0)).toThrow(RangeError)
    expect(() => stochF(BARS, 3, 2.5)).toThrow(RangeError)
    expect(() => levels(BARS, { period: 0 })).toThrow(RangeError)
    expect(() => levels(BARS, { period: 2.5 })).toThrow(RangeError)
  })

  it('adOsc / tsi / stochF / levels 的每个周期参数都跑满五类非法值', () => {
    const multi: Array<{ name: string; run: (p: number) => unknown }> = [
      { name: 'adOsc fastPeriod', run: (p) => adOsc(BARS, p, 10) },
      { name: 'adOsc slowPeriod', run: (p) => adOsc(BARS, 3, p) },
      { name: 'tsi slow', run: (p) => tsi(CLOSES, { slow: p }) },
      { name: 'tsi fast', run: (p) => tsi(CLOSES, { fast: p }) },
      { name: 'stochF kPeriod', run: (p) => stochF(BARS, p, 3) },
      { name: 'stochF dPeriod', run: (p) => stochF(BARS, 3, p) },
      { name: 'levels options.period', run: (p) => levels(BARS, { period: p }) },
    ]
    for (const c of multi) {
      for (const bad of INVALID) {
        expect(() => c.run(bad), `${c.name}(${String(bad)})`).toThrow(RangeError)
      }
    }
  })

  it('回归类至少两个点：period = 1 抛 RangeError（engine-core 会给 0 斜率的全序列）', () => {
    for (const fn of [linRegSlope, linRegIntercept, linRegAngle, tsf]) {
      expect(() => fn(CLOSES, 1)).toThrow(RangeError)
    }
  })

  it('variance 的 ddof 也是可判定参数：period ≤ ddof 或 ddof 非法都抛 RangeError', () => {
    expect(() => variance(CLOSES, 3, 3)).toThrow(RangeError)
    expect(() => variance(CLOSES, 3, 5)).toThrow(RangeError)
    expect(() => variance(CLOSES, 3, -1)).toThrow(RangeError)
    expect(() => variance(CLOSES, 3, 1.5)).toThrow(RangeError)
  })

  it('抛的是 RangeError（不是 Error / TypeError），且合法周期不抛', () => {
    let caught: unknown = null
    try {
      plusDI(BARS, 0)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(RangeError)
    expect(caught).not.toBeInstanceOf(TypeError)
    // 合法周期一律不抛（否则上面那些「抛错」断言就没有区分力）。取 5：偏度要 ≥ 3、峰度要 ≥ 4，
    // 5 对全表都合法；period=1 不算「合法」到这个程度——zScore 默认 ddof=1 会因 period ≤ ddof 抛错。
    for (const c of [...priceSeries, ...barSeries]) {
      expect(() => c.run(5), `${c.name} period=5`).not.toThrow()
    }
  })
})

describe('GQ-27 回归类最小周期', () => {
  it('correl / beta：period=1 抛 RangeError（与 linRegSlope 一致，回归类要求 ≥ 2）', () => {
    expect(() => correl(CLOSES, RANDOM, 1)).toThrow(RangeError) // 修前：返回全 null
    expect(() => beta(CLOSES, RANDOM, 1)).toThrow(RangeError)
    expect(() => linRegSlope(CLOSES, 1)).toThrow(RangeError) // 对照：一直如此
  })
  it('反例：period=2 正常返回，前 period-1 项为 null', () => {
    const c = correl(CLOSES, RANDOM, 2)
    const b = beta(CLOSES, RANDOM, 2)
    expect(c).toHaveLength(CLOSES.length)
    expect(c[0]).toBeNull()
    expect(b[0]).toBeNull()
    expect(c.slice(1).some((x) => x !== null)).toBe(true)
  })
})
