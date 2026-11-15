// SPDX-License-Identifier: CPAL-1.0
// 统计与区间类补充：平均绝对偏差 AVGDEV、滚动方差 VAR、力量平衡 BOP、ADX 评级 ADXR。
// 口径出处：TA-Lib ta_AVGDEV.c:186-204（窗口内对 SMA 的平均绝对偏差）、ta_VAR.c（总体方差 × nbDev²，本包只做 nbDev=1）、
//           ta_BOP.c:106（(close−open)/(high−low)）、ta_ADXR.c:170-177（(ADX[k] + ADX[k−(period−1)]) / 2）。

import type { Bar, Series } from './types'
import { assertPeriod, nullSeries } from './internal'

/**
 * 平均绝对偏差：窗口内 mean(|x − SMA|)。TA-Lib TA_AVGDEV 同口径（总体，不除 n−1）。
 * 与 CCI 的分母同源（CCI 用它再做 0.015 缩放），engine-core 的 cci 是内联实现，这里给出可复用的序列版本。
 */
export function avgDev(values: number[], period = 20): Series {
  assertPeriod(period)
  const out = nullSeries(values.length)
  for (let i = period - 1; i < values.length; i++) {
    const start = i - period + 1
    let sum = 0
    for (let j = start; j <= i; j++) sum += values[j]!
    const mean = sum / period
    let deviation = 0
    for (let j = start; j <= i; j++) deviation += Math.abs(values[j]! - mean)
    out[i] = deviation / period
  }
  return out
}

/**
 * 滚动方差：TA-Lib TA_VAR 在 nbDev=1 时的口径 = 总体方差（除以 period）。
 * ddof 可调（ddof=1 即 pandas .var() 默认）；period 必须大于 ddof。
 */
export function variance(values: number[], period = 20, ddof = 0): Series {
  assertPeriod(period)
  if (!Number.isInteger(ddof) || ddof < 0) throw new RangeError(`ddof 必须是 ≥ 0 的整数，实际为 ${String(ddof)}`)
  if (period <= ddof) throw new RangeError(`period 必须大于 ddof，实际为 period=${String(period)} ddof=${String(ddof)}`)
  const out = nullSeries(values.length)
  for (let i = period - 1; i < values.length; i++) {
    const start = i - period + 1
    let max = 0
    let finite = true
    for (let j = start; j <= i; j++) {
      const v = values[j]!
      if (!Number.isFinite(v)) {
        finite = false
        break
      }
      const a = Math.abs(v)
      if (a > max) max = a
    }
    if (!finite) continue // 窗口内有 NaN / ±Infinity → null，不传染到后面的窗口
    if (max === 0) {
      out[i] = 0
      continue
    }
    // 按 2 的幂缩放：除以 2 的幂是精确运算，正常量级下与不缩放逐位相同；1e300 量级的平方不再溢出
    const scale = 2 ** Math.floor(Math.log2(max))
    let sum = 0
    for (let j = start; j <= i; j++) sum += values[j]! / scale
    const mean = sum / period
    let squares = 0
    for (let j = start; j <= i; j++) {
      const d = values[j]! / scale - mean
      squares += d * d
    }
    const v = ((squares / (period - ddof)) * scale) * scale // 先乘一个 scale 再乘一个，避免 scale*scale 先溢出
    out[i] = Number.isFinite(v) ? v : null // 方差超出双精度范围时诚实地给 null，不返回 Infinity
  }
  return out
}

/**
 * 力量平衡 BOP：单根 K 线的 (close − open) / (high − low)，区间为 0 时输出 0。
 * TA-Lib TA_BOP 是无窗口的单 bar 指标（lookback 0），这里保持逐 bar 输出、无预热。
 */
export function bop(bars: Bar[]): Series {
  const out = nullSeries(bars.length)
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i]!
    const range = bar.h - bar.l
    out[i] = range === 0 ? 0 : (bar.c - bar.o) / range
  }
  return out
}

/**
 * ADX 评级 ADXR：adxr[i] = (adx[i] + adx[i−(period−1)]) / 2。
 * 输入是任意 ADX 序列（例如 engine-core 的 adx().adx），任一端为 null 时输出 null。
 * TA-Lib 的 TA_ADXR 是对内部 ADX 做同样的事；接受序列输入是为了不在本包重复 ADX。
 */
export function adxr(adxValues: Series, period = 14): Series {
  assertPeriod(period)
  const lag = period - 1
  const out = nullSeries(adxValues.length)
  for (let i = lag; i < adxValues.length; i++) {
    const now = adxValues[i]
    const before = adxValues[i - lag]
    if (now === null || now === undefined || before === null || before === undefined) continue
    out[i] = (now + before) / 2
  }
  return out
}
