// SPDX-License-Identifier: CPAL-1.0
// 风险 / 波动类：已实现波动率、下行波动率、偏度、超额峰度、最大回撤、ATR 占价比、Amihud 非流动性。
// 口径出处：QuantDinger app/services/factors/registry.py 的 _realized_vol / _downside_volatility / _skewness /
// _kurtosis / _max_drawdown / _atr_pct / _amihud_illiquidity（Apache-2.0，见 README 出处表）。
// 与 pandas 版本的区别写在每个函数上：这里一律「对齐输入、预热期 null、因果」，不做 dropna 后的位置压缩。

import type { Bar, Series } from './types'
import { assertPeriod, nullSeries } from './internal'

/** 美股年交易日 252（与 QD `_realized_vol` 的 √252 一致）；7×24 市场请传 `periodsPerYear: 365`。 */
const DEFAULT_PERIODS_PER_YEAR = 252

/** 单序列有限性校验。 */
function assertAllFinite(values: number[], label: string): void {
  for (let i = 0; i < values.length; i++) {
    if (!Number.isFinite(values[i]!)) throw new RangeError(`${label}: 第 ${i} 项不是有限数`)
  }
}

/**
 * 已实现波动率：窗口内收益率的样本标准差（ddof=1，pandas .std() 口径），可选年化 ×√periodsPerYear。
 * 输入是每根 K 线的简单收益率（用 simpleReturns 从收盘价得到），不是价格。
 */
export function realizedVolatility(
  returns: number[],
  period = 20,
  options: { annualize?: boolean; periodsPerYear?: number; ddof?: number } = {},
): Series {
  assertPeriod(period)
  const { annualize = true, periodsPerYear = DEFAULT_PERIODS_PER_YEAR, ddof = 1 } = options
  assertPeriod(periodsPerYear, 'periodsPerYear')
  if (!Number.isInteger(ddof) || ddof < 0) throw new RangeError(`ddof 必须是 ≥ 0 的整数，实际为 ${String(ddof)}`)
  if (period <= ddof) throw new RangeError(`period 必须大于 ddof，实际为 period=${String(period)} ddof=${String(ddof)}`)
  assertAllFinite(returns, 'realizedVolatility')
  const out = nullSeries(returns.length)
  const scale = annualize ? Math.sqrt(periodsPerYear) : 1
  for (let i = period - 1; i < returns.length; i++) {
    let sum = 0
    for (let j = i - period + 1; j <= i; j++) sum += returns[j]!
    const mean = sum / period
    let squares = 0
    for (let j = i - period + 1; j <= i; j++) {
      const d = returns[j]! - mean
      squares += d * d
    }
    out[i] = Math.sqrt(squares / (period - ddof)) * scale
  }
  return out
}

/**
 * 下行波动率（Sortino 分母的口径）：只累计低于目标收益 mar 的偏差平方，按【整窗】求均值后开方，可选年化。
 * 与 QD 的 _downside_volatility 一致：分母是 period 而不是「下跌期数」。
 */
export function downsideVolatility(
  returns: number[],
  period = 20,
  options: { mar?: number; annualize?: boolean; periodsPerYear?: number } = {},
): Series {
  assertPeriod(period)
  const { mar = 0, annualize = true, periodsPerYear = DEFAULT_PERIODS_PER_YEAR } = options
  assertPeriod(periodsPerYear, 'periodsPerYear')
  assertAllFinite(returns, 'downsideVolatility')
  const out = nullSeries(returns.length)
  const scale = annualize ? Math.sqrt(periodsPerYear) : 1
  for (let i = period - 1; i < returns.length; i++) {
    let squares = 0
    for (let j = i - period + 1; j <= i; j++) {
      const shortfall = returns[j]! - mar
      if (shortfall < 0) squares += shortfall * shortfall
    }
    out[i] = Math.sqrt(squares / period) * scale
  }
  return out
}

/**
 * 偏度。sample=true（默认）用 pandas .skew() / Excel SKEW 的校正公式
 *   n / ((n-1)(n-2)) · Σ((x-μ)/s)³，s 为样本标准差（ddof=1），需要 n ≥ 3；
 * sample=false 用总体矩 g1 = m3 / m2^1.5，需要 n ≥ 2。窗口标准差为 0 时返回 0（偏度无定义，取中性值）。
 */
export function skewness(values: number[], period = 20, options: { sample?: boolean } = {}): Series {
  assertPeriod(period)
  const { sample = true } = options
  assertAllFinite(values, 'skewness')
  const out = nullSeries(values.length)
  const minimum = sample ? 3 : 2
  if (period < minimum) return out
  for (let i = period - 1; i < values.length; i++) {
    const start = i - period + 1
    let sum = 0
    for (let j = start; j <= i; j++) sum += values[j]!
    const mean = sum / period
    let m2 = 0
    let m3 = 0
    for (let j = start; j <= i; j++) {
      const d = values[j]! - mean
      m2 += d * d
      m3 += d * d * d
    }
    if (sample) {
      const variance = m2 / (period - 1)
      if (variance === 0) { out[i] = 0; continue }
      const s = Math.sqrt(variance)
      let acc = 0
      for (let j = start; j <= i; j++) {
        const z = (values[j]! - mean) / s
        acc += z * z * z
      }
      out[i] = (period / ((period - 1) * (period - 2))) * acc
    } else {
      const popVariance = m2 / period
      out[i] = popVariance === 0 ? 0 : m3 / period / Math.pow(popVariance, 1.5)
    }
  }
  return out
}

/**
 * 超额峰度（正态分布为 0）。sample=true（默认）用 pandas .kurt() / Excel KURT 的校正公式
 *   n(n+1) / ((n-1)(n-2)(n-3)) · Σ((x-μ)/s)⁴ − 3(n−1)² / ((n−2)(n−3))，需要 n ≥ 4；
 * sample=false 用总体超额峰度 m4/m2² − 3，需要 n ≥ 2。窗口标准差为 0 时返回 0。
 *
 * R3-11 / R1-PERF-07：
 *   - 峰度与尺度、平移无关，所以先把整列除以最大绝对值再算——量级到 1e299 时 d⁴ 不再溢出，结果与 1e150 量级一致；
 *   - 窗口滑动用「平移后的 1~4 次幂和」O(1) 更新，总耗时 O(n)，与窗口长度无关。平移量取每 period 根重算一次的窗口均值，
 *     把累加误差压在 period·ε 量级；窗口方差相对平移后的二次幂和小到 1e-3 以下（四次幂相消严重）时当场按该窗口重算，保证精度；
 *   - 连续 period 根完全相同 = 常数窗口，直接给 0（与两遍法的 m2 === 0 同义）。
 */
export function kurtosis(values: number[], period = 20, options: { sample?: boolean } = {}): Series {
  assertPeriod(period)
  const { sample = true } = options
  assertAllFinite(values, 'kurtosis')
  const n = values.length
  const out = nullSeries(n)
  const minimum = sample ? 4 : 2
  if (period < minimum || n < period) return out
  let scale = 0
  for (let i = 0; i < n; i++) { const a = Math.abs(values[i]!); if (a > scale) scale = a }
  if (scale === 0) { for (let i = period - 1; i < n; i++) out[i] = 0; return out }
  const y = new Float64Array(n)
  for (let i = 0; i < n; i++) y[i] = values[i]! / scale
  let c = 0
  let s1 = 0
  let s2 = 0
  let s3 = 0
  let s4 = 0
  const resum = (start: number): void => {
    let sum = 0
    for (let j = start; j < start + period; j++) sum += y[j]!
    c = sum / period
    s1 = 0; s2 = 0; s3 = 0; s4 = 0
    for (let j = start; j < start + period; j++) {
      const d = y[j]! - c
      const d2 = d * d
      s1 += d; s2 += d2; s3 += d2 * d; s4 += d2 * d2
    }
  }
  let run = 1
  for (let i = 0; i < n; i++) {
    if (i > 0) run = values[i] === values[i - 1] ? run + 1 : 1
    if (i < period - 1) continue
    const start = i - period + 1
    let fresh = false
    if (start % period === 0) { resum(start); fresh = true } else {
      const yo = y[start - 1]! - c
      const yn = y[i]! - c
      const yo2 = yo * yo
      const yn2 = yn * yn
      s1 += yn - yo; s2 += yn2 - yo2; s3 += yn2 * yn - yo2 * yo; s4 += yn2 * yn2 - yo2 * yo2
    }
    if (run >= period) { out[i] = 0; continue }
    let m = s1 / period
    let m2 = s2 - period * m * m
    if (!fresh && !(m2 > 1e-3 * s2)) { resum(start); fresh = true; m = s1 / period; m2 = s2 - period * m * m }
    if (!(m2 > 0)) { out[i] = 0; continue }
    const m4 = s4 - 4 * m * s3 + 6 * m * m * s2 - 3 * period * m * m * m * m
    out[i] = sample
      ? (period * (period + 1)) / ((period - 1) * (period - 2) * (period - 3)) * (m4 * (period - 1) * (period - 1)) / (m2 * m2) - (3 * (period - 1) * (period - 1)) / ((period - 2) * (period - 3))
      : (period * m4) / (m2 * m2) - 3
  }
  return out
}

/**
 * 窗口内最大回撤（负数或 0 的分数）：对窗口做「到当前为止的最高点」求 dd = v/peak − 1，取窗口内最小值。
 * 与 QD 的 _max_drawdown 一致（QD 只看最后一窗，这里逐 bar 输出，便于当因子序列用）。
 *
 * R1-PERF-07：窗口最大回撤 = 窗口内任意 a ≤ b 的 v_b/v_a − 1 的最小值（v > 0），可以拆成「(最大, 最小, 最优回撤)」三元组的结合运算。
 * 按 period 分块，每块算前缀与后缀三元组，窗口横跨两块时把「前块后缀」和「后块前缀」合并，总耗时 O(n)，且每个除法与朴素算法同一对操作数，
 * 结果逐位相同。有 ≤ 0 的值（峰值 ≤ 0 时朴素算法跳过该点）回退朴素扫描。
 */
export function maxDrawdown(values: number[], period = 20): Series {
  assertPeriod(period)
  assertAllFinite(values, 'maxDrawdown')
  const n = values.length
  const out = nullSeries(n)
  let positive = true
  for (let i = 0; i < n; i++) if (!(values[i]! > 0)) { positive = false; break }
  if (!positive) {
    for (let i = period - 1; i < n; i++) {
      let peak = -Infinity
      let worst = 0
      for (let j = i - period + 1; j <= i; j++) {
        const v = values[j]!
        if (v > peak) peak = v
        if (peak > 0) {
          const dd = v / peak - 1
          if (dd < worst) worst = dd
        }
      }
      out[i] = worst
    }
    return out
  }
  const pMax = new Float64Array(n)
  const pMin = new Float64Array(n)
  const pBest = new Float64Array(n)
  const sMax = new Float64Array(n)
  const sMin = new Float64Array(n)
  const sBest = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const v = values[i]!
    if (i % period === 0) { pMax[i] = v; pMin[i] = v; pBest[i] = 0 } else {
      pMax[i] = Math.max(pMax[i - 1]!, v)
      pMin[i] = Math.min(pMin[i - 1]!, v)
      pBest[i] = Math.min(pBest[i - 1]!, v / pMax[i - 1]! - 1)
    }
  }
  for (let i = n - 1; i >= 0; i--) {
    const v = values[i]!
    if (i === n - 1 || (i + 1) % period === 0) { sMax[i] = v; sMin[i] = v; sBest[i] = 0 } else {
      sMax[i] = Math.max(sMax[i + 1]!, v)
      sMin[i] = Math.min(sMin[i + 1]!, v)
      sBest[i] = Math.min(sBest[i + 1]!, sMin[i + 1]! / v - 1)
    }
  }
  for (let i = period - 1; i < n; i++) {
    const start = i - period + 1
    out[i] = start % period === 0 ? pBest[i]! : Math.min(sBest[start]!, pBest[i]!, pMin[i]! / sMax[start]! - 1)
  }
  return out
}

/** 真实波幅（与 engine-core 的 trueRange 同口径）：第 0 项 h−l，之后 max(h−l, |h−prevC|, |l−prevC|)。 */
function trueRange(bars: Bar[]): number[] {
  const out = new Array<number>(bars.length).fill(0)
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i]!
    if (i === 0) { out[i] = bar.h - bar.l; continue }
    const prev = bars[i - 1]!
    out[i] = Math.max(bar.h - bar.l, Math.abs(bar.h - prev.c), Math.abs(bar.l - prev.c))
  }
  return out
}

/** Wilder ATR：种子为前 period 个 TR 的简单平均，之后 (prev·(period−1) + TR)/period。 */
function wilderAtr(bars: Bar[], period: number): Series {
  const out = nullSeries(bars.length)
  if (bars.length < period) return out
  const tr = trueRange(bars)
  let seed = 0
  for (let i = 0; i < period; i++) seed += tr[i]!
  let value = seed / period
  out[period - 1] = value
  for (let i = period; i < bars.length; i++) {
    value = (value * (period - 1) + tr[i]!) / period
    out[i] = value
  }
  return out
}

/**
 * ATR 占价格比（比率，不是百分数）：atr[i] / close[i]。QD 的 _atr_pct 即 atr/close，此处逐 bar 输出。
 * 收盘价 ≤ 0 处为 null。
 */
export function atrPercent(bars: Bar[], period = 14): Series {
  assertPeriod(period)
  const atr = wilderAtr(bars, period)
  const out = nullSeries(bars.length)
  for (let i = 0; i < bars.length; i++) {
    const a = atr[i]
    const c = bars[i]!.c
    if (a === null || a === undefined || c <= 0) continue
    out[i] = a / c
  }
  return out
}

/**
 * Amihud 非流动性：窗口内 mean(|r_i| / (close_i · volume_i))，r_i = close_i/close_{i-1} − 1。
 * 成交额 ≤ 0 的 bar 不计入（避免除零放大），窗口内没有一个可计入项时为 null。
 * 成交额 / 比值 / 累加和超出双精度范围（不可表示）时该窗口为 null，不再给 0。
 * 与 QD 的 _amihud_illiquidity 一致（QD 用 pct_change 后取最后一窗）。
 */
export function amihudIlliquidity(bars: Bar[], period = 20): Series {
  assertPeriod(period)
  const out = nullSeries(bars.length)
  for (let i = period; i < bars.length; i++) {
    let sum = 0
    let count = 0
    let overflow = false
    for (let j = i - period + 1; j <= i; j++) {
      const prevClose = bars[j - 1]!.c
      if (prevClose <= 0) continue
      const traded = bars[j]!.c * bars[j]!.v
      if (!(traded > 0)) continue
      const term = Math.abs(bars[j]!.c / prevClose - 1) / traded
      // R3-11：成交额（或比值）超出双精度表示范围时，旧实现把 |r|/∞ 当成 0 给出「0 非流动性」；现在这个窗口给 null。
      if (!Number.isFinite(traded) || !Number.isFinite(term)) { overflow = true; break }
      sum += term
      count += 1
    }
    out[i] = overflow || count === 0 || !Number.isFinite(sum) ? null : sum / count
  }
  return out
}
