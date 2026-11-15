// SPDX-License-Identifier: CPAL-1.0
// 性能表基准：10 万根 K 线，按每个导出的真实入参形状调用，输出到 REPORT-T1b 的性能节。
import { describe, expect, it } from 'vitest'
import { bench, makeBars } from './perf-harness'
import * as ta from '../src/index'
import type { Series } from '../src/types'

interface SeriesCase {
  name: string
  kind: 'series'
  inputLength: number
  run: () => Series
}

interface ObjectCase {
  name: string
  kind: 'object'
  run: () => unknown
}

type PerfCase = SeriesCase | ObjectCase

const FUNDAMENTAL = new Set([
  'bookToPrice',
  'debtToEquity',
  'earningsYield',
  'freeCashFlowYield',
  'returnOnEquity',
  'revenueGrowth',
])

describe('性能表（10 万根，按真实入参形状）', () => {
  it('输出各指标耗时并校验输出形状', () => {
    const bars = makeBars(100_000)
    const closes = bars.map((bar) => bar.c)
    const volumes = bars.map((bar) => bar.v)
    const returns = ta.simpleReturns(closes).slice(1) as number[]
    // 两条等长、错开一根的收益率序列：beta / correl 的输入形状。
    const returnsLead = returns.slice(1)
    const returnsLag = returns.slice(0, -1)
    const adxValues = ta.dx(bars, 14)

    const cases: PerfCase[] = [
      { name: 'simpleReturns', kind: 'series', inputLength: closes.length, run: () => ta.simpleReturns(closes) },
      // 风险 / 波动（收益序列）
      { name: 'realizedVolatility', kind: 'series', inputLength: returns.length, run: () => ta.realizedVolatility(returns) },
      { name: 'downsideVolatility', kind: 'series', inputLength: returns.length, run: () => ta.downsideVolatility(returns) },
      { name: 'skewness', kind: 'series', inputLength: returns.length, run: () => ta.skewness(returns) },
      { name: 'kurtosis', kind: 'series', inputLength: returns.length, run: () => ta.kurtosis(returns) },
      { name: 'maxDrawdown', kind: 'series', inputLength: closes.length, run: () => ta.maxDrawdown(closes) },
      // 风险 / 波动（K 线）
      { name: 'atrPercent', kind: 'series', inputLength: bars.length, run: () => ta.atrPercent(bars) },
      { name: 'amihudIlliquidity', kind: 'series', inputLength: bars.length, run: () => ta.amihudIlliquidity(bars) },
      // 动量 / 均线偏离（价格序列）
      { name: 'cmo', kind: 'series', inputLength: closes.length, run: () => ta.cmo(closes) },
      { name: 'tsi', kind: 'series', inputLength: closes.length, run: () => ta.tsi(closes) },
      { name: 'efficiencyRatio', kind: 'series', inputLength: closes.length, run: () => ta.efficiencyRatio(closes) },
      { name: 'smaDistance', kind: 'series', inputLength: closes.length, run: () => ta.smaDistance(closes) },
      { name: 'emaDistance', kind: 'series', inputLength: closes.length, run: () => ta.emaDistance(closes) },
      { name: 'emaSlope', kind: 'series', inputLength: closes.length, run: () => ta.emaSlope(closes) },
      { name: 'zScore', kind: 'series', inputLength: closes.length, run: () => ta.zScore(closes) },
      // 流动性 / 区间位置
      { name: 'volumeRatio', kind: 'series', inputLength: volumes.length, run: () => ta.volumeRatio(volumes) },
      { name: 'pricePosition', kind: 'series', inputLength: bars.length, run: () => ta.pricePosition(bars) },
      // 统计与区间
      { name: 'avgDev', kind: 'series', inputLength: closes.length, run: () => ta.avgDev(closes) },
      { name: 'variance', kind: 'series', inputLength: closes.length, run: () => ta.variance(closes) },
      { name: 'bop', kind: 'series', inputLength: bars.length, run: () => ta.bop(bars) },
      { name: 'adxr', kind: 'series', inputLength: adxValues.length, run: () => ta.adxr(adxValues) },
      // 价格变换
      { name: 'avgPrice', kind: 'series', inputLength: bars.length, run: () => ta.avgPrice(bars) },
      { name: 'medPrice', kind: 'series', inputLength: bars.length, run: () => ta.medPrice(bars) },
      { name: 'typPrice', kind: 'series', inputLength: bars.length, run: () => ta.typPrice(bars) },
      { name: 'wclPrice', kind: 'series', inputLength: bars.length, run: () => ta.wclPrice(bars) },
      // 窗口极值与中点
      { name: 'rollingMax', kind: 'series', inputLength: closes.length, run: () => ta.rollingMax(closes, 20) },
      { name: 'rollingMin', kind: 'series', inputLength: closes.length, run: () => ta.rollingMin(closes, 20) },
      { name: 'maxIndex', kind: 'series', inputLength: closes.length, run: () => ta.maxIndex(closes, 20) },
      { name: 'minIndex', kind: 'series', inputLength: closes.length, run: () => ta.minIndex(closes, 20) },
      { name: 'midPoint', kind: 'series', inputLength: closes.length, run: () => ta.midPoint(closes, 20) },
      { name: 'midPrice', kind: 'series', inputLength: bars.length, run: () => ta.midPrice(bars, 20) },
      // 均线扩展
      { name: 'trima', kind: 'series', inputLength: closes.length, run: () => ta.trima(closes) },
      { name: 't3', kind: 'series', inputLength: closes.length, run: () => ta.t3(closes) },
      // 方向类
      { name: 'plusDM', kind: 'series', inputLength: bars.length, run: () => ta.plusDM(bars) },
      { name: 'minusDM', kind: 'series', inputLength: bars.length, run: () => ta.minusDM(bars) },
      { name: 'plusDI', kind: 'series', inputLength: bars.length, run: () => ta.plusDI(bars) },
      { name: 'minusDI', kind: 'series', inputLength: bars.length, run: () => ta.minusDI(bars) },
      { name: 'dx', kind: 'series', inputLength: bars.length, run: () => ta.dx(bars) },
      // 振荡补充
      { name: 'aroonOsc', kind: 'series', inputLength: bars.length, run: () => ta.aroonOsc(bars) },
      { name: 'stochF', kind: 'series', inputLength: bars.length, run: () => ta.stochF(bars).k },
      // 回归与相关（两条等长收益率序列）
      { name: 'correl', kind: 'series', inputLength: returnsLead.length, run: () => ta.correl(returnsLead, returnsLag) },
      { name: 'beta', kind: 'series', inputLength: returnsLead.length, run: () => ta.beta(returnsLead, returnsLag) },
      { name: 'linRegSlope', kind: 'series', inputLength: closes.length, run: () => ta.linRegSlope(closes) },
      { name: 'linRegIntercept', kind: 'series', inputLength: closes.length, run: () => ta.linRegIntercept(closes) },
      { name: 'linRegAngle', kind: 'series', inputLength: closes.length, run: () => ta.linRegAngle(closes) },
      { name: 'tsf', kind: 'series', inputLength: closes.length, run: () => ta.tsf(closes) },
      // 波动与量能补充
      { name: 'natr', kind: 'series', inputLength: bars.length, run: () => ta.natr(bars) },
      { name: 'adOsc', kind: 'series', inputLength: bars.length, run: () => ta.adOsc(bars) },
      // 价位估计（返回标量对象，不是等长序列）
      { name: 'levels', kind: 'object', run: () => ta.levels(bars) },
    ]

    const exported = Object.keys(ta).filter(
      (name) => typeof (ta as unknown as Record<string, unknown>)[name] === 'function',
    )
    expect(exported.filter((name) => FUNDAMENTAL.has(name)).sort()).toEqual([...FUNDAMENTAL].sort())
    expect(cases.map((item) => item.name).sort()).toEqual(exported.filter((name) => !FUNDAMENTAL.has(name)).sort())

    const rows: Array<[string, number]> = []
    for (const item of cases) {
      if (item.kind === 'series') {
        const result = item.run()
        expect(result.length, `${item.name} 输出长度`).toBe(item.inputLength)
        expect(
          result.some((value) => typeof value === 'number' && Number.isFinite(value)),
          `${item.name} 至少一个有限数`,
        ).toBe(true)
      } else {
        const result = item.run()
        if (result === null || typeof result !== 'object') throw new Error(`${item.name} 应返回对象`)
        const numeric = Object.values(result as Record<string, unknown>).filter(
          (value): value is number => typeof value === 'number',
        )
        expect(numeric.length, `${item.name} 数值字段`).toBeGreaterThan(0)
        for (const value of numeric) expect(Number.isFinite(value), `${item.name} 有限数`).toBe(true)
      }
      const ms = bench(item.run, 3)
      rows.push([item.name, Math.round(ms * 100) / 100])
    }

    rows.sort((a, b) => a[1] - b[1])
    console.log('PERF_TABLE_START')
    for (const [name, ms] of rows) console.log(`${name}\t${ms.toFixed(2)}ms`)
    console.log('PERF_TABLE_END')
    console.log('标量函数（6 个基本面比率），不计时')
  }, 120_000)
})
