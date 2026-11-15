// SPDX-License-Identifier: CPAL-1.0
// 回归与相关：CORREL、BETA、LINEARREG_SLOPE / _INTERCEPT（转发 engine-core）、_ANGLE、TSF（时间序列预测）。
// 口径出处：TA-Lib `ta_CORREL.c`（窗口 Pearson；退化（分母为 0）时 TA-Lib 输出 0.0，本包输出 null）、
//           `ta_LINEARREG_SLOPE.c` / `_INTERCEPT.c` / `_ANGLE.c`（角度 = atan(slope) 转度）、
//           `ta_TSF.c`（= intercept + slope × period，即在窗口外一格的回归预测）。
// 与 engine-core 的关系（批 9 收尾）：
//   - `linRegSlope` / `linRegIntercept` 与 engine-core `linearRegression().slope / .intercept` 同口径同值
//     （横轴 = 窗口内序号 0..period−1，首个非 null 在下标 period−1），改为直接转发，同值性由
//     test/engine-core-parity.test.ts 逐项比对。转发的差异只有「非法周期怎么办」：engine-core 返回全 null，
//     本包包装函数先抛 RangeError（并要求 period ≥ 2，回归至少要两个点）。
//   - `correl` 与 engine-core `rollingCorr` 口径**相近但不同**（输入形状、null 窗口处理、默认周期），
//     `beta` 在 engine-core 没有对应实现；两者保留本包实现，差异见 README「与 engine-core 的差异」。
// BETA 的差异：TA-Lib `ta_BETA.c` 输入两条价格，内部先转成单根收益率（指数在 inReal0、个股在 inReal1），
//           lookback = period（批 8 收口按 ta_BETA.c 复核过此点，本批未联网重读源码）；本包 `beta` 不做转换，
//           直接对传入序列回归——要得到常规意义的 beta，调用方先用 `simpleReturns` 把价格转成收益率。
// 约定：窗口含当根，period ≥ 2（回归至少要两个点）；两序列长度不等直接抛错。
import { linearRegression } from '../../engine-core/src/strategy/ta/overlap'
import type { Series } from './types'
import { assertPeriod, nullSeries } from './internal'

function assertSameLength(a: readonly number[], b: readonly number[]): void {
  if (a.length !== b.length) {
    throw new RangeError(`两个序列必须等长，实际为 ${String(a.length)} 与 ${String(b.length)}`)
  }
}

/** 窗口内两个序列的离差平方和与交叉项和。 */
function windowSums(
  a: readonly number[],
  b: readonly number[],
  start: number,
  period: number,
): { sxy: number; sxx: number; syy: number; meanA: number; meanB: number } {
  let meanA = 0
  let meanB = 0
  for (let j = start; j < start + period; j++) {
    meanA += a[j]!
    meanB += b[j]!
  }
  meanA /= period
  meanB /= period
  let sxy = 0
  let sxx = 0
  let syy = 0
  for (let j = start; j < start + period; j++) {
    const da = a[j]! - meanA
    const db = b[j]! - meanB
    sxy += da * db
    sxx += da * da
    syy += db * db
  }
  return { sxy, sxx, syy, meanA, meanB }
}

/** 滚动 Pearson 相关系数（−1..1）；任一窗口方差为 0 处为 null。 */
export function correl(a: readonly number[], b: readonly number[], period = 20): Series {
  assertRegressionPeriod(period)
  assertSameLength(a, b)
  const out = nullSeries(a.length)
  for (let i = period - 1; i < a.length; i++) {
    const { sxy, sxx, syy } = windowSums(a, b, i - period + 1, period)
    if (sxx === 0 || syy === 0) continue
    out[i] = sxy / Math.sqrt(sxx * syy)
  }
  return out
}

/**
 * 滚动 Beta：a 对基准序列 b 的回归斜率 = Σ(a−ā)(b−b̄) ÷ Σ(b−b̄)²；基准方差为 0 处为 null。
 * 与 TA-Lib `ta_BETA` 的区别：TA-Lib 接收两条价格，内部先转成单根收益率（指数在 inReal0、
 * 个股在 inReal1），lookback = period；本包直接对传入序列回归，要得到常规意义的 beta，
 * 调用方先用 `simpleReturns` 转成收益率再传入。
 */
export function beta(a: readonly number[], b: readonly number[], period = 20): Series {
  assertRegressionPeriod(period)
  assertSameLength(a, b)
  const out = nullSeries(a.length)
  for (let i = period - 1; i < a.length; i++) {
    const { sxy, syy } = windowSums(a, b, i - period + 1, period)
    if (syy === 0) continue
    out[i] = sxy / syy
  }
  return out
}

/** 回归的最小周期：两个点才拟合得出一条直线。 */
function assertRegressionPeriod(period: number): void {
  assertPeriod(period)
  if (period < 2) throw new RangeError(`period 必须 ≥ 2（回归至少要两个点），实际为 ${String(period)}`)
}

/**
 * 窗口线性回归的斜率（横轴为窗口内序号 0..period−1）。转发 engine-core `linearRegression().slope`（同口径同值）；
 * engine-core 只读数组，这里断言去掉 readonly 修饰避免复制。
 */
export function linRegSlope(values: readonly number[], period = 14): Series {
  assertRegressionPeriod(period)
  // R1-PERF-07：长窗口走滑动更新（O(n)）；短窗口仍转发 engine-core 原实现（逐位同值，test/engine-core-parity.test.ts 钉着）。
  if (period > LONG_WINDOW && values.length >= period) return linRegSlopeSliding(values, period)
  return linearRegression(values as number[], period).slope
}

/** 超过这个窗口长度才用滑动更新；以内转发 engine-core（朴素两遍法，逐位同值）。linRegAngle / tsf 仍用两遍法斜率，输出与改动前逐位一致。 */
const LONG_WINDOW = 32

/**
 * 滑动最小二乘斜率：斜率 = Σ(k−x̄)·y_k / Σ(k−x̄)²。窗口右移一格时
 *   T' = T + (x̄+1)·y_出 + x̄·y_入 − Y，Y' = Y − y_出 + y_入（Y 为窗口和）。
 * 数据先减去每 period 根重算一次的窗口均值（平移不改斜率），把累加误差压在 period·ε 量级。
 */
function linRegSlopeSliding(values: readonly number[], period: number): Series {
  const n = values.length
  const out = nullSeries(n)
  const xbar = (period - 1) / 2
  const sxx = (period * (period * period - 1)) / 12
  let c = 0
  let sumY = 0
  let t = 0
  for (let i = period - 1; i < n; i++) {
    const start = i - period + 1
    if (start % period === 0) {
      let mean = 0
      for (let j = start; j < start + period; j++) mean += values[j]!
      c = mean / period
      sumY = 0
      t = 0
      for (let k = 0; k < period; k++) {
        const y = values[start + k]! - c
        sumY += y
        t += (k - xbar) * y
      }
    } else {
      const yo = values[start - 1]! - c
      const yn = values[i]! - c
      t += (xbar + 1) * yo + xbar * yn - sumY
      sumY += yn - yo
    }
    out[i] = t / sxx
  }
  return out
}

/** 窗口线性回归的截距（横轴 0 处，即窗口最左边一根的拟合值）。转发 engine-core `linearRegression().intercept`。 */
export function linRegIntercept(values: readonly number[], period = 14): Series {
  assertRegressionPeriod(period)
  return linearRegression(values as number[], period).intercept
}

/** 窗口线性回归的斜率角度：atan(slope) 转成度（−90..90）。 */
export function linRegAngle(values: readonly number[], period = 14): Series {
  assertRegressionPeriod(period)
  const slope = linearRegression(values as number[], period).slope
  const out = nullSeries(values.length)
  for (let i = 0; i < values.length; i++) {
    const b = slope[i]
    if (b === null || b === undefined) continue
    out[i] = (Math.atan(b) * 180) / Math.PI
  }
  return out
}

/** 时间序列预测：intercept + slope × period，即窗口后一格的回归值。 */
export function tsf(values: readonly number[], period = 14): Series {
  assertRegressionPeriod(period)
  const slope = linearRegression(values as number[], period).slope
  const intercept = linRegIntercept(values, period)
  const out = nullSeries(values.length)
  for (let i = 0; i < values.length; i++) {
    const b = slope[i]
    const a = intercept[i]
    if (b === null || b === undefined || a === null || a === undefined) continue
    out[i] = a + b * period
  }
  return out
}
