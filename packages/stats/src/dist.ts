// SPDX-License-Identifier: CPAL-1.0
// 纯函数统计工具：分布、夏普比率、PSR、DSR（无第三方依赖，输入输出均为 number）。

const EULER_MASCHERONI = 0.5772156649015329

// 出处：Pearson 样本矩定义，算术平均。
export function mean(xs: number[]): number {
  if (xs.length === 0) return NaN
  let sum = 0
  for (let i = 0; i < xs.length; i++) sum += xs[i]!
  return sum / xs.length
}

// 出处：样本方差（含 Bessel 校正 ddof），ddof 为分母修正量。
export function variance(xs: number[], ddof = 1): number {
  const n = xs.length
  if (n <= ddof) return NaN
  const m = mean(xs)
  let ss = 0
  for (let i = 0; i < n; i++) {
    const d = xs[i]! - m
    ss += d * d
  }
  return ss / (n - ddof)
}

// 出处：样本标准差 = sqrt(样本方差)。
export function stdev(xs: number[], ddof = 1): number {
  return Math.sqrt(variance(xs, ddof))
}

// 出处：总体偏度 m3 / m2^1.5（Fisher 口径，二阶、三阶中心矩除以 n）。
export function skewness(xs: number[]): number {
  const n = xs.length
  if (n < 3) return 0
  const m = mean(xs)
  let m2 = 0
  let m3 = 0
  for (let i = 0; i < n; i++) {
    const d = xs[i]! - m
    const d2 = d * d
    m2 += d2
    m3 += d2 * d
  }
  m2 /= n
  m3 /= n
  if (m2 === 0) return 0
  return m3 / Math.pow(m2, 1.5)
}

// 出处：总体峰度（非超额）m4 / m2²，正态分布取 3。
export function kurtosis(xs: number[]): number {
  const n = xs.length
  if (n < 4) return 0
  const m = mean(xs)
  let m2 = 0
  let m4 = 0
  for (let i = 0; i < n; i++) {
    const d = xs[i]! - m
    const d2 = d * d
    m2 += d2
    m4 += d2 * d2
  }
  m2 /= n
  m4 /= n
  if (m2 === 0) return 0
  return m4 / (m2 * m2)
}

// 出处：Sharpe (1966)，mean / stdev(ddof)，每期口径，不年化。
export function sharpe(returns: number[], ddof = 1): number {
  const m = mean(returns)
  const sd = stdev(returns, ddof)
  if (sd === 0 || Number.isNaN(sd)) return 0
  return m / sd
}

// 出处：Sharpe (1966) 年化约定，sr · sqrt(periodsPerYear)。
export function annualizeSharpe(sr: number, periodsPerYear: number): number {
  return sr * Math.sqrt(periodsPerYear)
}

// 出处：Numerical Recipes 的 erfc 切比雪夫系数（Cody 精度级别），非负参数。
const ERFC_COF: number[] = [
  -1.3026537197817094, 6.4196979235649026e-1, 1.9476473204185836e-2,
  -9.561514786808631e-3, -9.46595344482036e-4, 3.66839497852761e-4,
  4.2523324806907e-5, -2.0278578112534e-5, -1.624290004647e-6,
  1.30365583558e-6, 1.5626441722e-8, -8.5238095915e-8, 6.529054439e-9,
  5.059343495e-9, -9.91364156e-10, -2.27365122e-10, 9.6467911e-11,
  2.394038e-12, -6.886027e-12, 8.94487e-13, 3.13092e-13, -1.12708e-13,
  3.81e-16, 7.106e-15, -1.523e-15, -9.4e-17, 1.21e-16, -2.8e-17,
]

function erfcNonNegative(z: number): number {
  let d = 0
  let dd = 0
  const t = 2 / (2 + z)
  const ty = 4 * t - 2
  for (let j = ERFC_COF.length - 1; j > 0; j--) {
    const tmp = d
    d = ty * d - dd + ERFC_COF[j]!
    dd = tmp
  }
  return t * Math.exp(-z * z + 0.5 * (ERFC_COF[0]! + ty * d) - dd)
}

function erfc(x: number): number {
  return x >= 0 ? erfcNonNegative(x) : 2 - erfcNonNegative(-x)
}

// 出处：标准正态分布函数 Φ(x) = erfc(-x/√2) / 2。
export function normalCdf(x: number): number {
  if (x === 0) return 0.5
  return 0.5 * erfc(-x / Math.SQRT2)
}

// Acklam 逆正态初值系数。
const ACKLAM_A: number[] = [
  -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
  1.38357751867269e2, -3.066479806614716e1, 2.506628277459239,
]
const ACKLAM_B: number[] = [
  -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
  6.680131188771972e1, -1.328068155288572e1,
]
const ACKLAM_C: number[] = [
  -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838,
  -2.549732539343734, 4.374664141464968, 2.938163982698783,
]
const ACKLAM_D: number[] = [
  7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996,
  3.754408661907416,
]

function normalInvInitial(p: number): number {
  const pLow = 0.02425
  const pHigh = 1 - pLow
  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p))
    return (
      (((((ACKLAM_C[0]! * q + ACKLAM_C[1]!) * q + ACKLAM_C[2]!) * q +
        ACKLAM_C[3]!) * q + ACKLAM_C[4]!) * q + ACKLAM_C[5]!) /
      ((((ACKLAM_D[0]! * q + ACKLAM_D[1]!) * q + ACKLAM_D[2]!) * q +
        ACKLAM_D[3]!) * q + 1)
    )
  }
  if (p <= pHigh) {
    const q = p - 0.5
    const r = q * q
    return (
      ((((((ACKLAM_A[0]! * r + ACKLAM_A[1]!) * r + ACKLAM_A[2]!) * r +
        ACKLAM_A[3]!) * r + ACKLAM_A[4]!) * r + ACKLAM_A[5]!) * q) /
      (((((ACKLAM_B[0]! * r + ACKLAM_B[1]!) * r + ACKLAM_B[2]!) * r +
        ACKLAM_B[3]!) * r + ACKLAM_B[4]!) * r + 1)
    )
  }
  const q = Math.sqrt(-2 * Math.log(1 - p))
  return -(
    (((((ACKLAM_C[0]! * q + ACKLAM_C[1]!) * q + ACKLAM_C[2]!) * q +
      ACKLAM_C[3]!) * q + ACKLAM_C[4]!) * q + ACKLAM_C[5]!) /
    ((((ACKLAM_D[0]! * q + ACKLAM_D[1]!) * q + ACKLAM_D[2]!) * q +
      ACKLAM_D[3]!) * q + 1)
  )
}

// 出处：Acklam (2003) 逆正态近似 + 一步 Newton 修正（标准正态 pdf）。
export function normalInv(p: number): number {
  if (Number.isNaN(p)) return NaN
  if (p <= 0) return -Infinity
  if (p >= 1) return Infinity
  let x = normalInvInitial(p)
  const pdf = Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI)
  if (pdf > 0) x -= (normalCdf(x) - p) / pdf
  return x
}

// 出处：Bailey & López de Prado (2012) Probabilistic Sharpe Ratio。
export function psr(
  sr: number,
  opts: { n: number; benchmark?: number; skew?: number; kurt?: number },
): number {
  const n = opts.n
  if (n < 2) return NaN
  const benchmark = opts.benchmark ?? 0
  const skew = opts.skew ?? 0
  const kurt = opts.kurt ?? 3
  const radicand = 1 - skew * sr + ((kurt - 1) / 4) * sr * sr
  if (!(radicand > 0)) return NaN
  const z = ((sr - benchmark) * Math.sqrt(n - 1)) / Math.sqrt(radicand)
  return normalCdf(z)
}

// 出处：Bailey & López de Prado (2014) 期望最大夏普（N 次独立试验）。
export function expectedMaxSharpe(nTrials: number, trialVariance: number): number {
  if (nTrials < 2 || !(trialVariance > 0)) return 0
  const a = normalInv(1 - 1 / nTrials)
  const b = normalInv(1 - 1 / (nTrials * Math.E))
  return (
    Math.sqrt(trialVariance) *
    ((1 - EULER_MASCHERONI) * a + EULER_MASCHERONI * b)
  )
}

// 出处：Bailey & López de Prado (2014) Deflated Sharpe Ratio。
export function dsr(
  sr: number,
  opts: {
    n: number
    nTrials: number
    trialVariance: number
    skew?: number
    kurt?: number
  },
): number {
  const benchmark = expectedMaxSharpe(opts.nTrials, opts.trialVariance)
  return psr(sr, {
    n: opts.n,
    benchmark,
    skew: opts.skew ?? 0,
    kurt: opts.kurt ?? 3,
  })
}

// 出处：Bailey & López de Prado (2014)，多重试验夏普的均值与横截面方差。
export function sharpeOfTrials(
  trials: number[][],
  ddof = 1,
): { sharpes: number[]; variance: number } {
  const sharpes = trials.map((trial) => sharpe(trial, ddof))
  const v = sharpes.length < 2 ? 0 : variance(sharpes, 1)
  return { sharpes, variance: v }
}

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/backtest/metrics.py:35; adapted.
// 改良：原实现按 exchange_calendars 剔除不连续区间，这里改成要求两条序列等长（同频对齐由调用方保证）。
// active = returns - benchmark；trackingError 为 active 的样本标准差（ddof 1）；te 为 0 或不可算 -> ir null。
// 给 periodsPerYear 时只把 ir 年化（ir · sqrt(periodsPerYear)），trackingError 保持每期口径。
export function informationRatio(
  returns: number[],
  benchmark: number[],
  opts?: { periodsPerYear?: number },
): { ir: number | null; activeMean: number; trackingError: number; n: number } {
  if (returns.length !== benchmark.length) {
    throw new RangeError('informationRatio: returns and benchmark must have equal length')
  }
  const active = returns.map((value, index) => value - benchmark[index]!)
  const n = active.length
  const activeMean = mean(active)
  const trackingError = stdev(active, 1)
  const periodic =
    !Number.isFinite(trackingError) || trackingError === 0 ? null : activeMean / trackingError
  const periodsPerYear = opts?.periodsPerYear
  const ir =
    periodic === null
      ? null
      : periodsPerYear === undefined
        ? periodic
        : periodic * Math.sqrt(periodsPerYear)
  return { ir, activeMean, trackingError, n }
}
