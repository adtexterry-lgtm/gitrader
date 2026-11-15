// SPDX-License-Identifier: CPAL-1.0
// 均线扩展：三角移动平均 TRIMA、Tillson T3。
// 口径出处：TA-Lib `ta_TRIMA.c:159-160`（偶数期 = SMA(SMA(x, period/2), period/2+1)；奇数期 = SMA(SMA(x,(period+1)/2), (period+1)/2)）、
//           `ta_T3.c`（六重 EMA 级联 + c1..c4 权重，lookbackTotal = 6 × (period−1)）。
import type { Series } from './types'
import { assertFinite, assertPeriod, nullSeries, smaSeries } from './internal'

/** 三角移动平均：两次简单平均的复合（权重呈三角形）。首个非 null 位置为 period−1。 */
export function trima(values: number[], period = 20): Series {
  assertPeriod(period)
  const odd = period % 2 === 1
  const n1 = odd ? (period + 1) / 2 : period / 2
  const n2 = odd ? (period + 1) / 2 : period / 2 + 1
  const out = nullSeries(values.length)
  const first = smaSeries(values, n1)
  const dense: number[] = []
  for (const value of first) if (value !== null) dense.push(value)
  const second = smaSeries(dense, n2)
  const offset = n1 - 1
  for (let j = 0; j < second.length; j++) {
    const value = second[j]
    if (value === null || value === undefined) continue
    out[offset + j] = value
  }
  return out
}

/** 六重 EMA 级联；每级用「本级前 period 个值的简单平均」作种子，返回各级非 null 稠密序列。 */
function emaCascade(values: number[], period: number, stages: number): number[][] {
  const out: number[][] = []
  let seq = values
  const k = 2 / (period + 1)
  for (let s = 0; s < stages; s++) {
    const dense: number[] = []
    if (seq.length >= period) {
      let seed = 0
      for (let i = 0; i < period; i++) seed += seq[i]!
      let e = seed / period
      dense.push(e)
      for (let i = period; i < seq.length; i++) {
        e = seq[i]! * k + e * (1 - k)
        dense.push(e)
      }
    }
    out.push(dense)
    seq = dense
  }
  return out
}

/**
 * Tillson T3：T3 = c1·e6 + c2·e5 + c3·e4 + c4·e3，ei 为第 i 重 EMA。
 * c1 = −v³、c2 = 3(v²+v³)、c3 = −3(2v²+v+v³)、c4 = (1+v)³；四个系数之和为 1，
 * 因此常数序列输入必得同一常数（见用例）。vFactor 默认 0.7（TA-Lib 默认）。
 * 首个非 null 位置为 6 × (period−1)。
 */
export function t3(values: number[], period = 5, vFactor = 0.7): Series {
  assertPeriod(period)
  assertFinite(vFactor, 'vFactor')
  const out = nullSeries(values.length)
  const v2 = vFactor * vFactor
  const v3 = v2 * vFactor
  const c1 = -v3
  const c2 = 3 * (v2 + v3)
  const c3 = -3 * (2 * v2 + vFactor + v3)
  const c4 = 1 + 3 * vFactor + 3 * v2 + v3
  const stages = emaCascade(values, period, 6)
  const e3 = stages[2]!
  const e4 = stages[3]!
  const e5 = stages[4]!
  const e6 = stages[5]!
  const step = period - 1
  for (let i = 6 * step; i < values.length; i++) {
    out[i] = c1 * e6[i - 6 * step]! + c2 * e5[i - 5 * step]! + c3 * e4[i - 4 * step]! + c4 * e3[i - 3 * step]!
  }
  return out
}
