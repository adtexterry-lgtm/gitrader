// SPDX-License-Identifier: CPAL-1.0
// 内部工具：周期校验、等长 null 序列、SMA/EMA 递推、窗口统计矩。风格与 engine-core 的 ta/ 一致。
import type { Series } from './types'

/** 周期参数校验：必须是 ≥ 1 的整数，否则抛 RangeError。 */
export function assertPeriod(period: number, name = 'period'): void {
  if (!Number.isInteger(period) || period < 1) {
    throw new RangeError(`${name} 必须是 ≥ 1 的整数，实际为 ${String(period)}`)
  }
}

/** 有限数校验：非有限值（NaN / Infinity）一律抛 RangeError，防止脏数据静默扩散。 */
export function assertFinite(value: number, name: string): void {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${name} 必须是有限数，实际为 ${String(value)}`)
  }
}

/** 等长全 null 序列。 */
export function nullSeries(length: number): Series {
  return new Array<number | null>(length).fill(null)
}

/** 简单移动平均：前 period-1 项为 null。 */
export function smaSeries(values: number[], period: number): Series {
  assertPeriod(period)
  const out = nullSeries(values.length)
  if (values.length < period) return out
  let sum = 0
  for (let i = 0; i < values.length; i++) {
    sum += values[i]!
    if (i >= period) sum -= values[i - period]!
    if (i >= period - 1) out[i] = sum / period
  }
  return out
}

/** 指数移动平均：种子为前 period 项的简单平均，k = 2 / (period + 1)；前 period-1 项为 null。 */
export function emaSeries(values: number[], period: number): Series {
  assertPeriod(period)
  const out = nullSeries(values.length)
  if (values.length < period) return out
  let seed = 0
  for (let i = 0; i < period; i++) seed += values[i]!
  let e = seed / period
  out[period - 1] = e
  const k = 2 / (period + 1)
  for (let i = period; i < values.length; i++) {
    e = values[i]! * k + e * (1 - k)
    out[i] = e
  }
  return out
}

/** 密集 EMA：返回 { values, positions }，positions 是相对于输入的下标，便于把平滑链对齐回原始时间轴。 */
export function emaDense(values: number[], period: number): { values: number[]; positions: number[] } {
  assertPeriod(period)
  if (values.length < period) return { values: [], positions: [] }
  const out: number[] = []
  const positions: number[] = []
  let seed = 0
  for (let i = 0; i < period; i++) seed += values[i]!
  let e = seed / period
  out.push(e)
  positions.push(period - 1)
  const k = 2 / (period + 1)
  for (let i = period; i < values.length; i++) {
    e = values[i]! * k + e * (1 - k)
    out.push(e)
    positions.push(i)
  }
  return { values: out, positions }
}

/** 单根 K 线的简单收益率序列（第 0 项为 null，之后 c[i]/c[i-1] - 1）；基数为 0 处为 null。 */
export function simpleReturns(values: number[]): Series {
  const out = nullSeries(values.length)
  for (let i = 1; i < values.length; i++) {
    const base = values[i - 1]!
    out[i] = base === 0 ? null : values[i]! / base - 1
  }
  return out
}

/** 窗口均值与总体方差（ddof=0 为总体，ddof=1 为样本）；period 必须大于 ddof。 */
export function windowMoments(
  values: number[],
  period: number,
  ddof: number,
): { mean: number; variance: number } {
  if (period <= ddof) {
    throw new RangeError(`period 必须大于 ddof，实际为 period=${String(period)} ddof=${String(ddof)}`)
  }
  let sum = 0
  for (const v of values) sum += v
  const mean = sum / period
  let squares = 0
  for (const v of values) {
    const d = v - mean
    squares += d * d
  }
  return { mean, variance: squares / (period - ddof) }
}
