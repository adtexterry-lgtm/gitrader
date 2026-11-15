// SPDX-License-Identifier: CPAL-1.0
// Alpha158 批 A 算子：滚动求和、Pearson 滚动相关、窗口内百分位名次、极值距今根数、线性回归末点残差。
// 约定：输出与输入等长，第 i 项只用 ≤ i 的数据；窗口不足或窗口内含 null 处为 null；period 非法时抛错。
import type { Series } from './types'

function assertPeriod(period: number): void {
  if (!Number.isInteger(period) || period < 1) {
    throw new Error('period 必须为大于等于 1 的整数')
  }
}

/** 窗口 [start, end] 内是否含 null / undefined。 */
function windowHasGap(values: readonly (number | null)[], start: number, end: number): boolean {
  for (let j = start; j <= end; j++) {
    const value = values[j]
    if (value === null || value === undefined) return true
  }
  return false
}

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/factors/qlib_adapter.py:277,281; adapted.
/** 滚动求和（窗口含当前项）；窗口内含 null 时为 null。 */
export function rollingSum(values: readonly (number | null)[], period: number): (number | null)[] {
  assertPeriod(period)
  const out: Series = new Array<number | null>(values.length).fill(null)
  if (values.length < period) return out
  for (let i = period - 1; i < values.length; i++) {
    const start = i - period + 1
    if (windowHasGap(values, start, i)) continue
    let sum = 0
    for (let j = start; j <= i; j++) sum += values[j]!
    out[i] = sum
  }
  return out
}

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/factors/qlib_adapter.py:287-294; adapted.
/** 滚动 Pearson 相关系数；窗口内任一 null 或分母为 0 时为 null。 */
export function rollingCorr(
  a: readonly (number | null)[],
  b: readonly (number | null)[],
  period: number,
): (number | null)[] {
  assertPeriod(period)
  const out: Series = new Array<number | null>(a.length).fill(null)
  if (a.length < period) return out
  for (let i = period - 1; i < a.length; i++) {
    const start = i - period + 1
    if (windowHasGap(a, start, i) || windowHasGap(b, start, i)) continue
    let meanA = 0
    let meanB = 0
    for (let j = start; j <= i; j++) {
      meanA += a[j]!
      meanB += b[j]!
    }
    meanA /= period
    meanB /= period
    let sxy = 0
    let sxx = 0
    let syy = 0
    for (let j = start; j <= i; j++) {
      const da = a[j]! - meanA
      const db = b[j]! - meanB
      sxy += da * db
      sxx += da * da
      syy += db * db
    }
    const denom = Math.sqrt(sxx * syy)
    out[i] = denom === 0 ? null : sxy / denom
  }
  return out
}

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/factors/qlib_adapter.py:309; adapted.
/** 末值在窗口内的百分位：average 名次 / period（并列取平均名次，同 pandas rank(pct=True)）。 */
export function rankPct(values: readonly (number | null)[], period: number): (number | null)[] {
  assertPeriod(period)
  const out: Series = new Array<number | null>(values.length).fill(null)
  if (values.length < period) return out
  for (let i = period - 1; i < values.length; i++) {
    const start = i - period + 1
    if (windowHasGap(values, start, i)) continue
    const last = values[i]!
    let below = 0
    let equal = 0
    for (let j = start; j <= i; j++) {
      const value = values[j]!
      if (value < last) below += 1
      else if (value === last) equal += 1
    }
    out[i] = (below + (equal + 1) / 2) / period
  }
  return out
}

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/factors/qlib_adapter.py:269-272; adapted.
/** 窗口内最大值距今根数（0 = 当前根）；并列取最早出现。 */
export function idxMax(values: readonly (number | null)[], period: number): (number | null)[] {
  assertPeriod(period)
  const out: Series = new Array<number | null>(values.length).fill(null)
  if (values.length < period) return out
  for (let i = period - 1; i < values.length; i++) {
    const start = i - period + 1
    if (windowHasGap(values, start, i)) continue
    let best = start
    for (let j = start + 1; j <= i; j++) {
      if (values[j]! > values[best]!) best = j
    }
    out[i] = i - best
  }
  return out
}

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/factors/qlib_adapter.py:269-272; adapted.
/** 窗口内最小值距今根数（0 = 当前根）；并列取最早出现。 */
export function idxMin(values: readonly (number | null)[], period: number): (number | null)[] {
  assertPeriod(period)
  const out: Series = new Array<number | null>(values.length).fill(null)
  if (values.length < period) return out
  for (let i = period - 1; i < values.length; i++) {
    const start = i - period + 1
    if (windowHasGap(values, start, i)) continue
    let best = start
    for (let j = start + 1; j <= i; j++) {
      if (values[j]! < values[best]!) best = j
    }
    out[i] = i - best
  }
  return out
}

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/factors/qlib_adapter.py:240-248; adapted.
/** 窗口一次线性回归的末点残差：y[-1] − (slope·x[-1] + intercept)，x 取 0..period-1。 */
export function linearResidual(values: readonly (number | null)[], period: number): (number | null)[] {
  assertPeriod(period)
  const out: Series = new Array<number | null>(values.length).fill(null)
  if (values.length < period) return out
  const xbar = (period - 1) / 2
  for (let i = period - 1; i < values.length; i++) {
    const start = i - period + 1
    if (windowHasGap(values, start, i)) continue
    let ybar = 0
    for (let j = start; j <= i; j++) ybar += values[j]!
    ybar /= period
    let sxx = 0
    let sxy = 0
    for (let k = 0; k < period; k++) {
      const dx = k - xbar
      sxy += dx * (values[start + k]! - ybar)
      sxx += dx * dx
    }
    const slope = sxx === 0 ? 0 : sxy / sxx
    const intercept = ybar - slope * xbar
    out[i] = values[i]! - (slope * (period - 1) + intercept)
  }
  return out
}
