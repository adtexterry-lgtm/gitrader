// SPDX-License-Identifier: CPAL-1.0
// 趋势类技术指标：均线（SMA/EMA/WMA）、MACD 与交叉信号。
import type { Series } from './types'

function assertPeriod(period: number): void {
  if (!Number.isInteger(period) || period < 1) {
    throw new RangeError('period 必须为大于等于 1 的整数')
  }
}

export function sma(values: number[], period: number): Series {
  assertPeriod(period)
  const out: Series = new Array<number | null>(values.length).fill(null)
  if (values.length < period) return out
  for (let i = period - 1; i < values.length; i++) {
    let sum = 0
    for (let j = i - period + 1; j <= i; j++) {
      sum += values[j]!
    }
    out[i] = sum / period
  }
  return out
}

export function ema(values: number[], period: number): Series {
  assertPeriod(period)
  const out: Series = new Array<number | null>(values.length).fill(null)
  if (values.length < period) return out
  let seed = 0
  for (let j = 0; j < period; j++) {
    seed += values[j]!
  }
  let prev = seed / period
  out[period - 1] = prev
  const k = 2 / (period + 1)
  for (let i = period; i < values.length; i++) {
    prev = values[i]! * k + prev * (1 - k)
    out[i] = prev
  }
  return out
}

export function wma(values: number[], period: number): Series {
  assertPeriod(period)
  const out: Series = new Array<number | null>(values.length).fill(null)
  if (values.length < period) return out
  const denominator = (period * (period + 1)) / 2
  for (let i = period - 1; i < values.length; i++) {
    let sum = 0
    for (let w = 1; w <= period; w++) {
      sum += values[i - period + w]! * w
    }
    out[i] = sum / denominator
  }
  return out
}

export function macd(
  values: number[],
  fast = 12,
  slow = 26,
  signal = 9,
): { macd: Series; signal: Series; hist: Series } {
  assertPeriod(fast)
  assertPeriod(slow)
  assertPeriod(signal)
  if (fast >= slow) {
    throw new RangeError('fast 必须小于 slow')
  }

  const fastEma = ema(values, fast)
  const slowEma = ema(values, slow)
  const macdOut: Series = new Array<number | null>(values.length).fill(null)
  const compact: number[] = []
  const positions: number[] = []
  for (let i = 0; i < values.length; i++) {
    const f = fastEma[i]
    const s = slowEma[i]
    if (f === null || f === undefined || s === null || s === undefined) continue
    const value = f - s
    macdOut[i] = value
    compact.push(value)
    positions.push(i)
  }

  const compactSignal = ema(compact, signal)
  const signalOut: Series = new Array<number | null>(values.length).fill(null)
  for (let j = 0; j < positions.length; j++) {
    signalOut[positions[j]!] = compactSignal[j]!
  }

  const histOut: Series = new Array<number | null>(values.length).fill(null)
  for (let i = 0; i < values.length; i++) {
    const m = macdOut[i]
    const s = signalOut[i]
    if (m === null || m === undefined || s === null || s === undefined) continue
    histOut[i] = m - s
  }

  return { macd: macdOut, signal: signalOut, hist: histOut }
}

export function cross(a: Series, b: Series): Series {
  if (a.length !== b.length) {
    throw new RangeError('两条序列长度必须相等')
  }
  const out: Series = new Array<number | null>(a.length).fill(null)
  for (let i = 1; i < a.length; i++) {
    const aPrev = a[i - 1]
    const bPrev = b[i - 1]
    const aCur = a[i]
    const bCur = b[i]
    if (
      aPrev === null ||
      aPrev === undefined ||
      bPrev === null ||
      bPrev === undefined ||
      aCur === null ||
      aCur === undefined ||
      bCur === null ||
      bCur === undefined
    ) {
      continue
    }
    if (aPrev <= bPrev && aCur > bCur) {
      out[i] = 1
    } else if (aPrev >= bPrev && aCur < bCur) {
      out[i] = -1
    } else {
      out[i] = 0
    }
  }
  return out
}
