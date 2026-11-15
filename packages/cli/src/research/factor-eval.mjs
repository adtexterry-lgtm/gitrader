// SPDX-License-Identifier: CPAL-1.0
// 因子评估：前向收益、Spearman 秩相关、滚动 IC、IC 汇总与分位组收益。
// 口径逐行复制自 packages/engine-core/src/strategy/factor-eval.ts:9-244（本目录是无构建的 .mjs）。
// 约定：无效点（null、非有限数）一律剔除；有效点不足时返回 null。
import { averageRanks, mean, neweyWest, stdev } from './stats.mjs'

/** 前向收益：fwd[i] = c[i+h] / c[i] - 1；尾部 h 个为 null。 */
export function forwardReturns(candles, horizon) {
  const out = new Array(candles.length).fill(null)
  if (!Number.isInteger(horizon) || horizon < 1) return out
  for (let i = 0; i + horizon < candles.length; i++) {
    const base = candles[i].c
    if (base === 0) continue
    const value = candles[i + horizon].c / base - 1
    out[i] = Number.isFinite(value) ? value : null
  }
  return out
}

/** 相对容差：用于把浮点误差级别的差异视为零方差。 */
const VARIANCE_EPS = 1e-12

/** 数组是否（在相对容差内）为常数。 */
function isConstant(values) {
  const first = values[0]
  if (values.every((value) => value === first)) return true
  const m = mean(values)
  const scale = Math.max(1, Math.abs(m))
  return values.every((value) => Math.abs(value - m) <= VARIANCE_EPS * scale)
}

/** 只保留两边都有效的点。 */
export function pairedValid(factor, fwd) {
  const xs = []
  const ys = []
  const length = Math.min(factor.length, fwd.length)
  for (let i = 0; i < length; i++) {
    const x = factor[i]
    const y = fwd[i]
    if (x === null || x === undefined || y === null || y === undefined) continue
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue
    xs.push(x)
    ys.push(y)
  }
  return { xs, ys }
}

/** Spearman 秩相关（时间序列口径）；有效点 < 3 或任一方零方差 -> null。 */
export function rankIc(factor, fwd) {
  const { xs, ys } = pairedValid(factor, fwd)
  if (xs.length < 3) return null
  if (isConstant(xs) || isConstant(ys)) return null
  const rx = averageRanks(xs)
  const ry = averageRanks(ys)
  const mx = mean(rx)
  const my = mean(ry)
  let sxy = 0
  let sxx = 0
  let syy = 0
  for (let i = 0; i < rx.length; i++) {
    const dx = rx[i] - mx
    const dy = ry[i] - my
    sxy += dx * dy
    sxx += dx * dx
    syy += dy * dy
  }
  if (sxx <= 0 || syy <= 0) return null
  const rho = sxy / Math.sqrt(sxx * syy)
  if (!Number.isFinite(rho)) return null
  return Math.max(-1, Math.min(1, rho))
}

/** 滚动 IC：每个 i 用 [i-window+1, i] 的点算 rankIc；前 window-1 个为 null。 */
export function rollingIc(factor, fwd, window) {
  const length = Math.min(factor.length, fwd.length)
  const out = new Array(length).fill(null)
  if (!Number.isInteger(window) || window < 1) return out
  for (let i = window - 1; i < length; i++) {
    out[i] = rankIc(factor.slice(i - window + 1, i + 1), fwd.slice(i - window + 1, i + 1))
  }
  return out
}

/**
 * 对非 null 的 ic 序列汇总：均值、样本标准差、IR 与 t 统计量、正 IC 占比。
 * 不给 opts：tStat = IR × √n（与 engine-core 的 icSummary 逐字段相同，parity 测试钉着）——
 * 但滚动 IC 相邻两点共享 window−1 根数据，这个 t 把重叠当成独立样本，会虚高数倍，只能当「粗排序」，不能当显著性。
 * 给 opts.tLags：tStat 改用 Newey–West（HAC）口径，滞后 tLags（建议 window + horizon − 2），
 * 并多返回 tMethod / tLags / nEff（有效独立样本数）。
 */
export function icSummary(ics, opts = {}) {
  const values = []
  for (const ic of ics) {
    if (ic === null || ic === undefined) continue
    if (!Number.isFinite(ic)) continue
    values.push(ic)
  }
  const n = values.length
  const m = n === 0 ? 0 : mean(values)
  const sd = n < 2 ? 0 : stdev(values, 1)
  const ir = n < 2 || sd === 0 || !Number.isFinite(sd) ? null : m / sd
  const tStat = ir === null ? null : ir * Math.sqrt(n)
  let positive = 0
  for (const value of values) if (value > 0) positive++
  const base = { n, mean: m, std: sd, ir, tStat, positiveShare: n === 0 ? 0 : positive / n }
  if (opts.tLags === undefined) return base
  const nw = ir === null ? null : neweyWest(values, opts.tLags)
  return { ...base, tStat: nw === null ? null : nw.t, tMethod: 'newey-west', tLags: opts.tLags, nEff: nw === null ? null : nw.nEff }
}

/** 按因子值升序等分 q 组，每组统计前向收益均值；spread = 最高组 - 最低组。 */
export function quantileReturns(factor, fwd, q) {
  const { xs, ys } = pairedValid(factor, fwd)
  if (!Number.isInteger(q) || q < 1 || xs.length < q) return { buckets: [], spread: null }
  const pairs = xs.map((value, index) => ({ factor: value, fwd: ys[index] }))
  pairs.sort((a, b) => a.factor - b.factor || 0)
  const buckets = []
  for (let b = 0; b < q; b++) {
    const start = Math.floor((b * pairs.length) / q)
    const end = Math.floor(((b + 1) * pairs.length) / q)
    let sum = 0
    for (let k = start; k < end; k++) sum += pairs[k].fwd
    const count = end - start
    buckets.push({ q: b + 1, n: count, meanFwd: count === 0 ? 0 : sum / count })
  }
  const low = buckets[0]
  const high = buckets[buckets.length - 1]
  const spread = high.meanFwd - low.meanFwd
  return { buckets, spread: Number.isFinite(spread) ? spread : null }
}

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/strategy_v2/factor_research.py:81; adapted.
/** IC 衰减：对每个 horizon 用 forwardReturns + rankIc 重算一次。 */
export function icDecay(factor, candles, horizons) {
  return horizons.map((horizon) => ({ horizon, ic: rankIc(factor, forwardReturns(candles, horizon)) }))
}

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/strategy_v2/factor_research.py:239; adapted.
/** 分组单调性：bucket 序号与 meanFwd 的 Spearman 秩相关；少于 3 组 -> null。 */
export function quantileMonotonicity(buckets) {
  if (buckets.length < 3) return null
  return rankIc(
    buckets.map((_, index) => index),
    buckets.map((bucket) => bucket.meanFwd),
  )
}

/**
 * 一站式因子评估（全样本 IC、滚动 IC 汇总、分位组收益、单调性）。
 * 缺省 horizon 5、window 60、quantiles 5；与 factor-eval.ts:197-219 的 evaluateFactor 同口径。
 */
export function evaluateFactor(candles, def, opts = {}) {
  const horizon = opts.horizon ?? 5
  const window = opts.window ?? 60
  const quantiles = opts.quantiles ?? 5
  const values = def.compute(candles, opts.params)
  const fwd = forwardReturns(candles, horizon)
  const quantile = quantileReturns(values, fwd, quantiles)
  return {
    id: def.id,
    horizon,
    ic: rankIc(values, fwd),
    rolling: icSummary(rollingIc(values, fwd, window)),
    quantiles: quantile,
    monotonicity: quantileMonotonicity(quantile.buckets),
  }
}
