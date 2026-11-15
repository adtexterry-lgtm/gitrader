// SPDX-License-Identifier: CPAL-1.0
// 动量 / 趋势强度补充：CMO、TSI、效率系数、均线偏离度（SMA/EMA）、EMA 斜率、均值回归 z 分数。
// 口径出处：TA-Lib ta_CMO.c（100·(gain−loss)/(gain+loss)，Wilder 平滑，种子取平均，见 README 出处表）；
//           QuantDinger app/services/factors/registry.py 的 _cmo / _tsi / _efficiency_ratio /
//           _ma_distance / _ema_slope / _zscore_last（Apache-2.0）。

import { assertPeriod, emaDense, emaSeries, nullSeries, smaSeries, windowMoments } from './internal'
import type { Series } from './types'

/**
 * 钱德动量摆动指标 CMO：Wilder 平滑的涨跌额，100·(gain−loss)/(gain+loss)。
 * 与 TA-Lib TA_CMO 同口径：种子为前 period 个涨跌额的【平均】（TA-Lib ta_CMO.c），之后 Wilder 递推
 * gain += g/period − gain/period（loss 同理）；涨跌和都为 0 时输出 0。首个可算位置为下标 period。
 */
export function cmo(values: number[], period = 14): Series {
  assertPeriod(period)
  const out = nullSeries(values.length)
  if (values.length <= period) return out
  let gain = 0
  let loss = 0
  let prev = values[0]!
  for (let i = 1; i <= period; i++) {
    const delta = values[i]! - prev
    prev = values[i]!
    if (delta > 0) gain += delta
    else loss -= delta
  }
  gain /= period
  loss /= period
  const emit = (i: number): void => {
    const total = gain + loss
    out[i] = total > 0 ? (100 * (gain - loss)) / total : 0
  }
  emit(period)
  for (let i = period + 1; i < values.length; i++) {
    const delta = values[i]! - prev
    prev = values[i]!
    const up = delta > 0 ? delta : 0
    gain += up / period - gain / period
    loss += (up - delta) / period - loss / period
    emit(i)
  }
  return out
}

/**
 * 真实强度指数 TSI（William Blau）：动量与其绝对值的二级 EMA 之比 ×100。
 * momentum[i] = close[i] − close[i−1]；分子 = EMA(EMA(momentum, slow), fast)，
 * 分母 = EMA(EMA(|momentum|, slow), fast)；分母为 0 时输出 0。首个可算位置为下标 slow+fast−1。
 */
export function tsi(values: number[], options: { slow?: number; fast?: number } = {}): Series {
  const { slow = 25, fast = 13 } = options
  assertPeriod(slow, 'slow')
  assertPeriod(fast, 'fast')
  const out = nullSeries(values.length)
  if (values.length < 2) return out
  const momentum: number[] = []
  for (let i = 1; i < values.length; i++) momentum.push(values[i]! - values[i - 1]!)
  const first = emaDense(momentum, slow)
  if (first.values.length === 0) return out
  const second = emaDense(first.values, fast)
  if (second.values.length === 0) return out
  const absFirst = emaDense(momentum.map((v) => Math.abs(v)), slow)
  const absSecond = emaDense(absFirst.values, fast)
  for (let j = 0; j < second.values.length; j++) {
    const denominator = absSecond.values[j]!
    // 二级 EMA 的下标 → 一级 EMA 的下标 → 动量下标 → 原始收盘价下标（动量下标 k 对应原序列 k+1）
    const index = 1 + first.positions[second.positions[j]!]!
    out[index] = denominator === 0 ? 0 : (100 * second.values[j]!) / denominator
  }
  return out
}

/**
 * 考夫曼效率系数 ER：净变动 / 路径长度，|v[i]−v[i−period]| / Σ|Δv|，取值 0..1。
 * 与 QD 的 _efficiency_ratio 一致；路径长度为 0 时输出 0（完全无变动）。
 */
export function efficiencyRatio(values: number[], period = 10): Series {
  assertPeriod(period)
  const out = nullSeries(values.length)
  for (let i = period; i < values.length; i++) {
    let path = 0
    for (let j = i - period + 1; j <= i; j++) path += Math.abs(values[j]! - values[j - 1]!)
    out[i] = path === 0 ? 0 : Math.abs(values[i]! - values[i - period]!) / path
  }
  return out
}

/**
 * 价格对 SMA 的偏离度（分数，不是百分数）：close[i] / sma[i] − 1。QD 的 sma_distance 口径。
 * SMA 为 0 处为 null。
 */
export function smaDistance(values: number[], period = 20): Series {
  assertPeriod(period)
  const average = smaSeries(values, period)
  const out = nullSeries(values.length)
  for (let i = 0; i < values.length; i++) {
    const base = average[i]
    if (base === null || base === undefined || base === 0) continue
    out[i] = values[i]! / base - 1
  }
  return out
}

/** 价格对 EMA 的偏离度（分数）：close[i] / ema[i] − 1。QD 的 ema_distance 口径；EMA 为 0 处为 null。 */
export function emaDistance(values: number[], period = 20): Series {
  assertPeriod(period)
  const average = emaSeries(values, period)
  const out = nullSeries(values.length)
  for (let i = 0; i < values.length; i++) {
    const base = average[i]
    if (base === null || base === undefined || base === 0) continue
    out[i] = values[i]! / base - 1
  }
  return out
}

/**
 * EMA 斜率（相对变化，分数）：ema[i] / ema[i−slopePeriod] − 1。
 * 与 QD 的 _ema_slope 一致（QD 取最后一窗，这里逐 bar 输出）。基准为 0 或尚未可算处为 null。
 */
export function emaSlope(values: number[], period = 20, slopePeriod = 5): Series {
  assertPeriod(period)
  assertPeriod(slopePeriod, 'slopePeriod')
  const average = emaSeries(values, period)
  const out = nullSeries(values.length)
  for (let i = slopePeriod; i < values.length; i++) {
    const now = average[i]
    const base = average[i - slopePeriod]
    if (now === null || now === undefined || base === null || base === undefined || base === 0) continue
    out[i] = now / base - 1
  }
  return out
}

/**
 * 均值回归 z 分数：窗口最后一项相对窗口均值的标准化偏离 (last − mean) / std。
 * 与 QD 的 _zscore_last / mean_reversion_zscore 一致，std 用 ddof=1（pandas .std() 默认）。
 * 标准差为 0 时输出 0（窗口内无波动，取中性值）。
 */
export function zScore(values: number[], period = 20, ddof = 1): Series {
  assertPeriod(period)
  if (!Number.isInteger(ddof) || ddof < 0) throw new RangeError(`ddof 必须是 ≥ 0 的整数，实际为 ${String(ddof)}`)
  if (period <= ddof) throw new RangeError(`period 必须大于 ddof，实际为 period=${String(period)} ddof=${String(ddof)}`)
  const out = nullSeries(values.length)
  for (let i = period - 1; i < values.length; i++) {
    const window = values.slice(i - period + 1, i + 1)
    const { mean, variance } = windowMoments(window, period, ddof)
    if (variance === 0) { out[i] = 0; continue }
    out[i] = (values[i]! - mean) / Math.sqrt(variance)
  }
  return out
}
