// SPDX-License-Identifier: CPAL-1.0
// 窗口类：滚动极值与极值位置、中点（TA-Lib MAX / MIN / MAXINDEX / MININDEX / MIDPOINT / MIDPRICE）。
// 口径出处：TA-Lib `include/ta_func.h` 的 TA_MAX / TA_MIN / TA_MAXINDEX / TA_MININDEX / TA_MIDPOINT / TA_MIDPRICE；
//           MAXINDEX / MININDEX 返回的是**输入数组下标**（不是窗口内偏移），并列时取窗口里最新的一根
//           （TA_MAXINDEX.c 中 `else if (tmp >= highest) highestIdx = today`）。
// 与 engine-core 的 `idxMax` / `idxMin` 不同：那两个返回「距极值多少根」，这里返回下标，语义更接近 TA-Lib。
import type { Bar, Series } from './types'
import { assertPeriod, nullSeries } from './internal'

/**
 * 滚动最大值（窗口含当根）；前 period−1 项为 null。
 * R1-PERF-07：单调队列，总耗时 O(n)，与窗口长度无关。队列里留「严格递减」的下标，并列时保留较早的一根，
 * 与逐窗朴素扫描（`>` 才换）取到同一个值。输入含 NaN 时比较语义不同，回退到朴素扫描（行为保持旧样）。
 */
export function rollingMax(values: number[], period: number): Series {
  assertPeriod(period)
  const n = values.length
  const out = nullSeries(n)
  for (let i = 0; i < n; i++) if (Number.isNaN(values[i]!)) return rollingMaxNaive(values, period, out)
  const dq = new Int32Array(n)
  let head = 0
  let tail = 0
  for (let i = 0; i < n; i++) {
    const v = values[i]!
    while (tail > head && values[dq[tail - 1]!]! < v) tail--
    dq[tail++] = i
    if (dq[head]! <= i - period) head++
    if (i >= period - 1) out[i] = values[dq[head]!]!
  }
  return out
}

function rollingMaxNaive(values: number[], period: number, out: Series): Series {
  for (let i = period - 1; i < values.length; i++) {
    let max = values[i - period + 1]!
    for (let j = i - period + 2; j <= i; j++) if (values[j]! > max) max = values[j]!
    out[i] = max
  }
  return out
}

/** 滚动最小值（窗口含当根）；前 period−1 项为 null。 */
export function rollingMin(values: number[], period: number): Series {
  assertPeriod(period)
  const out = nullSeries(values.length)
  for (let i = period - 1; i < values.length; i++) {
    let min = values[i - period + 1]!
    for (let j = i - period + 2; j <= i; j++) if (values[j]! < min) min = values[j]!
    out[i] = min
  }
  return out
}

/** 窗口内最大值在输入数组里的下标；并列时取最新一根。 */
export function maxIndex(values: number[], period: number): Series {
  assertPeriod(period)
  const out = nullSeries(values.length)
  for (let i = period - 1; i < values.length; i++) {
    let best = i - period + 1
    for (let j = i - period + 2; j <= i; j++) if (values[j]! >= values[best]!) best = j
    out[i] = best
  }
  return out
}

/** 窗口内最小值在输入数组里的下标；并列时取最新一根。 */
export function minIndex(values: number[], period: number): Series {
  assertPeriod(period)
  const out = nullSeries(values.length)
  for (let i = period - 1; i < values.length; i++) {
    let best = i - period + 1
    for (let j = i - period + 2; j <= i; j++) if (values[j]! <= values[best]!) best = j
    out[i] = best
  }
  return out
}

/** 窗口中点：(滚动最大值 + 滚动最小值) / 2；前 period−1 项为 null。 */
export function midPoint(values: number[], period: number): Series {
  assertPeriod(period)
  const high = rollingMax(values, period)
  const low = rollingMin(values, period)
  const out = nullSeries(values.length)
  for (let i = 0; i < values.length; i++) {
    const h = high[i]
    const l = low[i]
    if (h === null || h === undefined || l === null || l === undefined) continue
    out[i] = (h + l) / 2
  }
  return out
}

/** 价格中点：(窗口最高价 + 窗口最低价) / 2；前 period−1 项为 null。 */
export function midPrice(bars: Bar[], period: number): Series {
  assertPeriod(period)
  const out = nullSeries(bars.length)
  for (let i = period - 1; i < bars.length; i++) {
    let highest = bars[i - period + 1]!.h
    let lowest = bars[i - period + 1]!.l
    for (let j = i - period + 2; j <= i; j++) {
      const bar = bars[j]!
      if (bar.h > highest) highest = bar.h
      if (bar.l < lowest) lowest = bar.l
    }
    out[i] = (highest + lowest) / 2
  }
  return out
}
