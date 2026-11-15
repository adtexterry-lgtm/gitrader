// SPDX-License-Identifier: CPAL-1.0
// 动量类技术指标：RSI、随机指标、变化率、动量、威廉指标与顺势指标；输出与输入等长，不可算处为 null。
import type { Bar, Series } from './types'

/** 周期必须是正整数，否则抛 RangeError。 */
function checkPeriod(period: number): void {
  if (!Number.isInteger(period) || period < 1) throw new RangeError(`周期必须是正整数：${period}`)
}

/** RSI 由平均涨跌额换算（0–100）。 */
function rsiFrom(avgGain: number, avgLoss: number): number {
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100
  return 100 - 100 / (1 + avgGain / avgLoss)
}

/** 窗口内最高价 / 最低价（含当前 bar）。 */
function highLow(bars: Bar[], i: number, period: number): { hh: number; ll: number } {
  let hh = -Infinity
  let ll = Infinity
  for (let j = i - period + 1; j <= i; j += 1) {
    const bar = bars[j]!
    if (bar.h > hh) hh = bar.h
    if (bar.l < ll) ll = bar.l
  }
  return { hh, ll }
}

/** Wilder 口径相对强弱指标（0–100），前 period 项为 null。 */
export function rsi(closes: number[], period = 14): Series {
  checkPeriod(period)
  const n = closes.length
  const out: Series = new Array<number | null>(n).fill(null)
  if (n <= period) return out
  let gainSum = 0
  let lossSum = 0
  for (let i = 1; i <= period; i += 1) {
    const d = closes[i]! - closes[i - 1]!
    if (d > 0) gainSum += d
    else lossSum -= d
  }
  let avgGain = gainSum / period
  let avgLoss = lossSum / period
  out[period] = rsiFrom(avgGain, avgLoss)
  for (let i = period + 1; i < n; i += 1) {
    const d = closes[i]! - closes[i - 1]!
    const gain = d > 0 ? d : 0
    const loss = d < 0 ? -d : 0
    avgGain = (avgGain * (period - 1) + gain) / period
    avgLoss = (avgLoss * (period - 1) + loss) / period
    out[i] = rsiFrom(avgGain, avgLoss)
  }
  return out
}

/** 随机指标 K 与 D（0–100）；D 为对 K 非 null 子序列的简单平均。 */
export function stochastic(bars: Bar[], kPeriod = 14, dPeriod = 3): { k: Series; d: Series } {
  checkPeriod(kPeriod)
  checkPeriod(dPeriod)
  const n = bars.length
  const k: Series = new Array<number | null>(n).fill(null)
  const d: Series = new Array<number | null>(n).fill(null)
  const kValues: number[] = []
  const kIndexes: number[] = []
  for (let i = kPeriod - 1; i < n; i += 1) {
    const { hh, ll } = highLow(bars, i, kPeriod)
    const value = hh === ll ? 50 : (100 * (bars[i]!.c - ll)) / (hh - ll)
    k[i] = value
    kValues.push(value)
    kIndexes.push(i)
  }
  for (let p = dPeriod - 1; p < kValues.length; p += 1) {
    let sum = 0
    for (let q = p - dPeriod + 1; q <= p; q += 1) sum += kValues[q]!
    d[kIndexes[p]!] = sum / dPeriod
  }
  return { k, d }
}

/** 变化率（分数）：v[i] / v[i−period] − 1；基数为 0 处为 null。 */
export function roc(values: number[], period: number): Series {
  checkPeriod(period)
  const n = values.length
  const out: Series = new Array<number | null>(n).fill(null)
  for (let i = period; i < n; i += 1) {
    const base = values[i - period]!
    out[i] = base === 0 ? null : values[i]! / base - 1
  }
  return out
}

/** 动量：v[i] − v[i−period]，前 period 项为 null。 */
export function momentum(values: number[], period: number): Series {
  checkPeriod(period)
  const n = values.length
  const out: Series = new Array<number | null>(n).fill(null)
  for (let i = period; i < n; i += 1) out[i] = values[i]! - values[i - period]!
  return out
}

/** 威廉指标（−100..0）；窗口最高价等于最低价时为 −50。 */
export function williamsR(bars: Bar[], period = 14): Series {
  checkPeriod(period)
  const n = bars.length
  const out: Series = new Array<number | null>(n).fill(null)
  for (let i = period - 1; i < n; i += 1) {
    const { hh, ll } = highLow(bars, i, period)
    out[i] = hh === ll ? -50 : (-100 * (hh - bars[i]!.c)) / (hh - ll)
  }
  return out
}

/** 顺势指标：以典型价的均值和平均绝对偏差衡量偏离程度；平均偏差为 0 时取 0。 */
export function cci(bars: Bar[], period = 20): Series {
  checkPeriod(period)
  const n = bars.length
  const out: Series = new Array<number | null>(n).fill(null)
  const tp: number[] = bars.map((bar) => (bar.h + bar.l + bar.c) / 3)
  for (let i = period - 1; i < n; i += 1) {
    let sum = 0
    for (let j = i - period + 1; j <= i; j += 1) sum += tp[j]!
    const sma = sum / period
    let devSum = 0
    for (let j = i - period + 1; j <= i; j += 1) devSum += Math.abs(tp[j]! - sma)
    const meanDev = devSum / period
    out[i] = meanDev === 0 ? 0 : (tp[i]! - sma) / (0.015 * meanDev)
  }
  return out
}
