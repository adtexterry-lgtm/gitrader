// SPDX-License-Identifier: CPAL-1.0
// 叠加 / 趋势类技术指标：DEMA/TEMA/HMA/KAMA/VWMA/ALMA/ZLEMA、一目均衡、抛物线 SAR、超级趋势、枢轴点、线性回归与包络线。
// 约定：输出与输入等长，不可算处为 null，第 i 项只用 ≤ i 的数据；period 非法时全 null 且不抛错。
import type { Bar, Series } from './types'
import { ema, sma, wma } from './trend'
import { atr } from './volatility'

function isValidPeriod(period: number): boolean {
  return Number.isInteger(period) && period >= 1
}

function emptySeries(length: number): Series {
  return new Array<number | null>(length).fill(null)
}

/** 对可能带前导 null 的序列，取非 null 子序列做计算并按原下标放回。 */
function emaOfSeries(input: Series, period: number): Series {
  const out = emptySeries(input.length)
  const positions: number[] = []
  const values: number[] = []
  for (let i = 0; i < input.length; i++) {
    const value = input[i]
    if (value === null || value === undefined) continue
    positions.push(i)
    values.push(value)
  }
  const computed = ema(values, period)
  for (let j = 0; j < positions.length; j++) {
    const value = computed[j]
    if (value === null || value === undefined) continue
    out[positions[j]!] = value
  }
  return out
}

/** 对可能带前导 null 的序列，取非 null 子序列做 WMA 并按原下标放回。 */
function wmaOfSeries(input: Series, period: number): Series {
  const out = emptySeries(input.length)
  const positions: number[] = []
  const values: number[] = []
  for (let i = 0; i < input.length; i++) {
    const value = input[i]
    if (value === null || value === undefined) continue
    positions.push(i)
    values.push(value)
  }
  const computed = wma(values, period)
  for (let j = 0; j < positions.length; j++) {
    const value = computed[j]
    if (value === null || value === undefined) continue
    out[positions[j]!] = value
  }
  return out
}

/** 双指数移动平均：2·EMA − EMA(EMA)。 */
export function dema(values: number[], period: number): Series {
  if (!isValidPeriod(period)) return emptySeries(values.length)
  const first = ema(values, period)
  const second = emaOfSeries(first, period)
  const out = emptySeries(values.length)
  for (let i = 0; i < values.length; i++) {
    const a = first[i]
    const b = second[i]
    if (a === null || a === undefined || b === null || b === undefined) continue
    out[i] = 2 * a - b
  }
  return out
}

/** 三指数移动平均：3·E1 − 3·E2 + E3。 */
export function tema(values: number[], period: number): Series {
  if (!isValidPeriod(period)) return emptySeries(values.length)
  const e1 = ema(values, period)
  const e2 = emaOfSeries(e1, period)
  const e3 = emaOfSeries(e2, period)
  const out = emptySeries(values.length)
  for (let i = 0; i < values.length; i++) {
    const a = e1[i]
    const b = e2[i]
    const c = e3[i]
    if (a === null || a === undefined || b === null || b === undefined || c === null || c === undefined) {
      continue
    }
    out[i] = 3 * a - 3 * b + c
  }
  return out
}

/** 赫尔移动平均：WMA(2·WMA(n/2) − WMA(n), round(√n))。 */
export function hma(values: number[], period: number): Series {
  if (!isValidPeriod(period)) return emptySeries(values.length)
  const half = Math.max(1, Math.floor(period / 2))
  const root = Math.max(1, Math.round(Math.sqrt(period)))
  const shortWma = wma(values, half)
  const longWma = wma(values, period)
  const diff = emptySeries(values.length)
  for (let i = 0; i < values.length; i++) {
    const a = shortWma[i]
    const b = longWma[i]
    if (a === null || a === undefined || b === null || b === undefined) continue
    diff[i] = 2 * a - b
  }
  return wmaOfSeries(diff, root)
}

/** Kaufman 自适应移动平均：ER 为净变动 / 路径长度，SC 平滑后递推；种子取第一个可算点的收盘价。 */
export function kama(values: number[], period = 10, fast = 2, slow = 30): Series {
  if (!isValidPeriod(period)) return emptySeries(values.length)
  const out = emptySeries(values.length)
  if (values.length < period) return out
  const fastSc = 2 / (fast + 1)
  const slowSc = 2 / (slow + 1)
  let prev = values[period - 1]!
  out[period - 1] = prev
  for (let i = period; i < values.length; i++) {
    const change = Math.abs(values[i]! - values[i - period]!)
    let path = 0
    for (let j = i - period + 1; j <= i; j++) {
      path += Math.abs(values[j]! - values[j - 1]!)
    }
    const er = path === 0 ? 0 : change / path
    const sc = (er * (fastSc - slowSc) + slowSc) ** 2
    prev = prev + sc * (values[i]! - prev)
    out[i] = prev
  }
  return out
}

/** 成交量加权移动平均：Σ(c·v) / Σv，窗口成交量为 0 时该点为 null。 */
export function vwma(bars: Bar[], period: number): Series {
  if (!isValidPeriod(period)) return emptySeries(bars.length)
  const out = emptySeries(bars.length)
  for (let i = period - 1; i < bars.length; i++) {
    let sumPv = 0
    let sumV = 0
    for (let j = i - period + 1; j <= i; j++) {
      const bar = bars[j]!
      sumPv += bar.c * bar.v
      sumV += bar.v
    }
    out[i] = sumV === 0 ? null : sumPv / sumV
  }
  return out
}

/** Arnaud Legoux 移动平均：高斯权重按 offset / sigma 归一化后对窗口加权。 */
export function alma(values: number[], period = 9, offset = 0.85, sigma = 6): Series {
  if (!isValidPeriod(period)) return emptySeries(values.length)
  const out = emptySeries(values.length)
  const center = offset * (period - 1)
  const scale = period / sigma
  const normalizer = 2 * scale * scale
  const weights: number[] = []
  let weightSum = 0
  for (let k = 0; k < period; k++) {
    const d = k - center
    const weight = normalizer === 0 ? (d === 0 ? 1 : 0) : Math.exp(-(d * d) / normalizer)
    weights.push(weight)
    weightSum += weight
  }
  if (weightSum === 0) return out
  for (let i = period - 1; i < values.length; i++) {
    let sum = 0
    for (let k = 0; k < period; k++) {
      sum += values[i - period + 1 + k]! * weights[k]!
    }
    out[i] = sum / weightSum
  }
  return out
}

/** 零滞后指数移动平均：先去滞后 2·c[i] − c[i−lag]，再取 EMA；lag = floor((n−1)/2)。 */
export function zlema(values: number[], period: number): Series {
  if (!isValidPeriod(period)) return emptySeries(values.length)
  const lag = Math.floor((period - 1) / 2)
  const positions: number[] = []
  const adjusted: number[] = []
  for (let i = lag; i < values.length; i++) {
    positions.push(i)
    adjusted.push(2 * values[i]! - values[i - lag]!)
  }
  const computed = ema(adjusted, period)
  const out = emptySeries(values.length)
  for (let j = 0; j < positions.length; j++) {
    const value = computed[j]
    if (value === null || value === undefined) continue
    out[positions[j]!] = value
  }
  return out
}

export interface IchimokuOptions {
  tenkan?: number
  kijun?: number
  senkou?: number
}

/** 一目均衡表：各线均为截至当前 bar 的窗口值，不做前移 / 后移。 */
export function ichimoku(
  bars: Bar[],
  options: IchimokuOptions = {},
): { tenkan: Series; kijun: Series; senkouA: Series; senkouB: Series; chikou: Series } {
  const tenkanPeriod = options.tenkan ?? 9
  const kijunPeriod = options.kijun ?? 26
  const senkouPeriod = options.senkou ?? 52
  const n = bars.length
  if (!isValidPeriod(tenkanPeriod) || !isValidPeriod(kijunPeriod) || !isValidPeriod(senkouPeriod)) {
    return {
      tenkan: emptySeries(n),
      kijun: emptySeries(n),
      senkouA: emptySeries(n),
      senkouB: emptySeries(n),
      chikou: emptySeries(n),
    }
  }

  const midpoint = (period: number): Series => {
    const out = emptySeries(n)
    for (let i = period - 1; i < n; i++) {
      let high = -Infinity
      let low = Infinity
      for (let j = i - period + 1; j <= i; j++) {
        const bar = bars[j]!
        if (bar.h > high) high = bar.h
        if (bar.l < low) low = bar.l
      }
      out[i] = (high + low) / 2
    }
    return out
  }

  const tenkan = midpoint(tenkanPeriod)
  const kijun = midpoint(kijunPeriod)
  const senkouB = midpoint(senkouPeriod)
  const senkouA = emptySeries(n)
  for (let i = 0; i < n; i++) {
    const a = tenkan[i]
    const b = kijun[i]
    if (a === null || a === undefined || b === null || b === undefined) continue
    senkouA[i] = (a + b) / 2
  }
  const chikou = emptySeries(n)
  for (let i = 0; i < n; i++) chikou[i] = bars[i]!.c

  return { tenkan, kijun, senkouA, senkouB, chikou }
}

export interface ParabolicSarOptions {
  step?: number
  max?: number
}

/** 标准 Wilder 抛物线 SAR：初始趋势看第 2 根收盘相对第 1 根，反转时 SAR 取前趋势 EP。 */
export function parabolicSar(
  bars: Bar[],
  options: ParabolicSarOptions = {},
): { sar: Series; trend: Series } {
  const step = options.step ?? 0.02
  const max = options.max ?? 0.2
  const n = bars.length
  const sar = emptySeries(n)
  const trend = emptySeries(n)
  if (n < 2) return { sar, trend }

  let up = bars[1]!.c >= bars[0]!.c
  let af = step
  let ep = up
    ? Math.max(bars[0]!.h, bars[1]!.h)
    : Math.min(bars[0]!.l, bars[1]!.l)
  let value = up ? bars[0]!.l : bars[0]!.h
  sar[1] = value
  trend[1] = up ? 1 : -1

  for (let i = 2; i < n; i++) {
    const bar = bars[i]!
    let candidate = value + af * (ep - value)
    if (up) {
      candidate = Math.min(candidate, bars[i - 1]!.l, bars[i - 2]!.l)
      if (bar.l < candidate) {
        up = false
        candidate = ep
        ep = bar.l
        af = step
      } else if (bar.h > ep) {
        ep = bar.h
        af = Math.min(af + step, max)
      }
    } else {
      candidate = Math.max(candidate, bars[i - 1]!.h, bars[i - 2]!.h)
      if (bar.h > candidate) {
        up = true
        candidate = ep
        ep = bar.h
        af = step
      } else if (bar.l < ep) {
        ep = bar.l
        af = Math.min(af + step, max)
      }
    }
    value = candidate
    sar[i] = value
    trend[i] = up ? 1 : -1
  }
  return { sar, trend }
}

export interface SupertrendOptions {
  period?: number
  multiplier?: number
}

/** ATR 通道式 SuperTrend：最终上下轨单向收缩，收盘突破后翻转。 */
export function supertrend(
  bars: Bar[],
  options: SupertrendOptions = {},
): { upper: Series; lower: Series; trend: Series } {
  const period = options.period ?? 10
  const multiplier = options.multiplier ?? 3
  const n = bars.length
  const upper = emptySeries(n)
  const lower = emptySeries(n)
  const trend = emptySeries(n)
  if (!isValidPeriod(period)) return { upper, lower, trend }

  const width = atr(bars, period)
  const start = period - 1
  let prevUpper = 0
  let prevLower = 0
  let trendUp = false
  for (let i = start; i < n; i++) {
    const bar = bars[i]!
    const at = width[i]
    if (at === null || at === undefined) continue
    const mid = (bar.h + bar.l) / 2
    const basicUpper = mid + multiplier * at
    const basicLower = mid - multiplier * at
    let finalUpper = basicUpper
    let finalLower = basicLower
    let up: boolean
    if (i === start) {
      up = bar.c > basicUpper
    } else {
      const prevClose = bars[i - 1]!.c
      finalUpper = basicUpper < prevUpper || prevClose > prevUpper ? basicUpper : prevUpper
      finalLower = basicLower > prevLower || prevClose < prevLower ? basicLower : prevLower
      up = trendUp ? bar.c >= finalLower : bar.c > finalUpper
    }
    upper[i] = finalUpper
    lower[i] = finalLower
    trend[i] = up ? 1 : -1
    prevUpper = finalUpper
    prevLower = finalLower
    trendUp = up
  }
  return { upper, lower, trend }
}

/** 枢轴点：第 i 项用第 i−1 根的 h/l/c，第 0 项为 null。 */
export function pivotPoints(bars: Bar[]): {
  p: Series
  r1: Series
  s1: Series
  r2: Series
  s2: Series
} {
  const n = bars.length
  const p = emptySeries(n)
  const r1 = emptySeries(n)
  const s1 = emptySeries(n)
  const r2 = emptySeries(n)
  const s2 = emptySeries(n)
  for (let i = 1; i < n; i++) {
    const bar = bars[i - 1]!
    const pivot = (bar.h + bar.l + bar.c) / 3
    p[i] = pivot
    r1[i] = 2 * pivot - bar.l
    s1[i] = 2 * pivot - bar.h
    r2[i] = pivot + (bar.h - bar.l)
    s2[i] = pivot - (bar.h - bar.l)
  }
  return { p, r1, s1, r2, s2 }
}

/** 窗口最小二乘线性回归：slope/intercept/value 与决定系数 r2（方差为 0 时 r2 为 null）。 */
export function linearRegression(
  values: number[],
  period: number,
): { slope: Series; intercept: Series; value: Series; r2: Series } {
  const n = values.length
  const slope = emptySeries(n)
  const intercept = emptySeries(n)
  const value = emptySeries(n)
  const r2 = emptySeries(n)
  if (!isValidPeriod(period)) return { slope, intercept, value, r2 }

  const xbar = (period - 1) / 2
  for (let i = period - 1; i < n; i++) {
    const start = i - period + 1
    let ybar = 0
    for (let k = 0; k < period; k++) ybar += values[start + k]!
    ybar /= period
    let sxx = 0
    let sxy = 0
    let syy = 0
    for (let k = 0; k < period; k++) {
      const dx = k - xbar
      const dy = values[start + k]! - ybar
      sxx += dx * dx
      sxy += dx * dy
      syy += dy * dy
    }
    const b = sxx === 0 ? 0 : sxy / sxx
    const a = ybar - b * xbar
    slope[i] = b
    intercept[i] = a
    value[i] = b * (period - 1) + a
    r2[i] = syy === 0 ? null : (b * sxy) / syy
  }
  return { slope, intercept, value, r2 }
}

/** 包络线：SMA 与其上下各 pct 比例的平行线。 */
export function envelope(
  values: number[],
  period: number,
  pct = 0.025,
): { mid: Series; upper: Series; lower: Series } {
  const n = values.length
  if (!isValidPeriod(period)) {
    return { mid: emptySeries(n), upper: emptySeries(n), lower: emptySeries(n) }
  }
  const mid = sma(values, period)
  const upper = emptySeries(n)
  const lower = emptySeries(n)
  for (let i = 0; i < n; i++) {
    const m = mid[i]
    if (m === null || m === undefined) continue
    upper[i] = m * (1 + pct)
    lower[i] = m * (1 - pct)
  }
  return { mid, upper, lower }
}
