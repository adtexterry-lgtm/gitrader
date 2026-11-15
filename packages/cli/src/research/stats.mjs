// SPDX-License-Identifier: CPAL-1.0
// 基础统计（本目录为纯 .mjs，无构建步骤，故按公式复制而非 import 工作区包）。
// 公式与 @gitrader/stats 的 mean / variance / stdev / quantile 逐行一致：
// packages/stats/src/dist.ts:7-30、packages/stats/src/bootstrap.ts:41-50。

/** 算术平均；空序列返回 NaN。 */
export function mean(xs) {
  if (xs.length === 0) return NaN
  let sum = 0
  for (let i = 0; i < xs.length; i++) sum += xs[i]
  return sum / xs.length
}

/** 样本方差（含 Bessel 校正 ddof）；n <= ddof 返回 NaN。 */
export function variance(xs, ddof = 1) {
  const n = xs.length
  if (n <= ddof) return NaN
  const m = mean(xs)
  let ss = 0
  for (let i = 0; i < n; i++) {
    const d = xs[i] - m
    ss += d * d
  }
  return ss / (n - ddof)
}

/** 样本标准差 = sqrt(variance)。 */
export function stdev(xs, ddof = 1) {
  return Math.sqrt(variance(xs, ddof))
}

/**
 * Newey–West（HAC）t 值：用于相互重叠的序列（滚动窗口 IC 相邻两点共享 window−1 根数据）。
 * 序列先去均值；Bartlett 核，权重 1 − j/(lags+1)，自协方差 γ_j 以 n 为分母；t = 均值 / √(长期方差 / n)。
 * 返回 { t, lrv, nEff, mean }：lrv = 长期方差，nEff = n·γ₀/lrv（有效独立样本数，重叠越重越小）；
 * 点数 < 3、lags 非法或长期方差 ≤ 0 返回 null。
 */
export function neweyWest(xs, lags) {
  const n = xs.length
  if (n < 3 || !Number.isInteger(lags) || lags < 0) return null
  const m = mean(xs)
  const d = new Array(n)
  for (let i = 0; i < n; i++) d[i] = xs[i] - m
  const gamma = (j) => {
    let s = 0
    for (let i = j; i < n; i++) s += d[i] * d[i - j]
    return s / n
  }
  const g0 = gamma(0)
  let lrv = g0
  for (let j = 1; j <= Math.min(lags, n - 1); j++) lrv += 2 * (1 - j / (lags + 1)) * gamma(j)
  if (!(lrv > 0) || !Number.isFinite(lrv)) return null
  return { t: m / Math.sqrt(lrv / n), lrv, nEff: (n * g0) / lrv, mean: m }
}

/** 线性插值分位数（输入必须已升序）；q 越界或空序列抛错。 */
export function quantile(sorted, q) {
  if (!(q >= 0 && q <= 1)) throw new RangeError('quantile: q 必须在 [0, 1] 内')
  const m = sorted.length
  if (m === 0) throw new RangeError('quantile: 输入序列不能为空')
  const h = (m - 1) * q
  const lo = Math.floor(h)
  const hi = Math.min(lo + 1, m - 1)
  const base = sorted[lo]
  return base + (h - lo) * (sorted[hi] - base)
}

/** 平均秩（1 起）；并列取平均名次，按值升序、同值保持原顺序。 */
export function averageRanks(values) {
  const order = values.map((_, index) => index)
  order.sort((a, b) => {
    const diff = values[a] - values[b]
    return diff === 0 ? a - b : diff
  })
  const ranks = new Array(values.length).fill(0)
  let i = 0
  while (i < order.length) {
    let j = i
    while (j + 1 < order.length && values[order[j + 1]] === values[order[i]]) j++
    const rank = (i + j) / 2 + 1
    for (let k = i; k <= j; k++) ranks[order[k]] = rank
    i = j + 1
  }
  return ranks
}

/** 四舍五入到 digits 位（报告用，只影响显示）。 */
export function round(value, digits = 4) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null
  const scale = 10 ** digits
  return Math.round(value * scale) / scale
}
