// SPDX-License-Identifier: CPAL-1.0
// 因子评估：前向收益、Spearman 秩相关（时间序列 / 滚动 / 横截面）、IC 汇总与分组收益。
// 约定：无效点（null、非有限数）一律剔除；有效点不足时返回 null。
import { mean, stdev } from '@gitrader/stats'
import type { Candle } from '../types'
import type { FactorDef } from './factors'

/** 前向收益：fwd[i] = c[i+h] / c[i] - 1；尾部 h 个为 null。 */
export function forwardReturns(candles: readonly Candle[], horizon: number): Array<number | null> {
  const out = new Array<number | null>(candles.length).fill(null)
  if (!Number.isInteger(horizon) || horizon < 1) return out
  for (let i = 0; i + horizon < candles.length; i++) {
    const base = candles[i]!.c
    if (base === 0) continue
    const value = candles[i + horizon]!.c / base - 1
    out[i] = Number.isFinite(value) ? value : null
  }
  return out
}

/** 平均秩（1 起）；并列取平均名次，排序稳定。 */
function averageRanks(values: number[]): number[] {
  const order = values.map((_, index) => index)
  order.sort((a, b) => {
    const diff = values[a]! - values[b]!
    return diff === 0 ? a - b : diff
  })
  const ranks = new Array<number>(values.length).fill(0)
  let i = 0
  while (i < order.length) {
    let j = i
    while (j + 1 < order.length && values[order[j + 1]!]! === values[order[i]!]!) j++
    const rank = (i + j) / 2 + 1
    for (let k = i; k <= j; k++) ranks[order[k]!] = rank
    i = j + 1
  }
  return ranks
}

/** 相对容差：用于把浮点误差级别的差异视为零方差。 */
const VARIANCE_EPS = 1e-12

/** 数组是否（在相对容差内）为常数。 */
function isConstant(values: number[]): boolean {
  const first = values[0]!
  if (values.every((value) => value === first)) return true
  const m = mean(values)
  const scale = Math.max(1, Math.abs(m))
  return values.every((value) => Math.abs(value - m) <= VARIANCE_EPS * scale)
}

/** 只保留两边都有效的点。 */
function pairedValid(
  factor: ReadonlyArray<number | null>,
  fwd: ReadonlyArray<number | null>,
): { xs: number[]; ys: number[] } {
  const xs: number[] = []
  const ys: number[] = []
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

/** Spearman 秩相关（时间序列口径）：只取两边都非 null 的点；有效点 < 3 或任一方零方差 -> null。 */
export function rankIc(
  factor: ReadonlyArray<number | null>,
  fwd: ReadonlyArray<number | null>,
): number | null {
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
    const dx = rx[i]! - mx
    const dy = ry[i]! - my
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
export function rollingIc(
  factor: ReadonlyArray<number | null>,
  fwd: ReadonlyArray<number | null>,
  window: number,
): Array<number | null> {
  const length = Math.min(factor.length, fwd.length)
  const out = new Array<number | null>(length).fill(null)
  if (!Number.isInteger(window) || window < 1) return out
  for (let i = window - 1; i < length; i++) {
    out[i] = rankIc(factor.slice(i - window + 1, i + 1), fwd.slice(i - window + 1, i + 1))
  }
  return out
}

export interface IcSummary {
  n: number
  mean: number
  std: number
  ir: number | null
  tStat: number | null
  positiveShare: number
}

/** 对非 null 的 ic 序列汇总：均值、样本标准差、IR 与 t 统计量、正 IC 占比。 */
export function icSummary(ics: ReadonlyArray<number | null>): IcSummary {
  const values: number[] = []
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
  return {
    n,
    mean: m,
    std: sd,
    ir,
    tStat,
    positiveShare: n === 0 ? 0 : positive / n,
  }
}

export interface QuantileReturns {
  buckets: { q: number; n: number; meanFwd: number }[]
  spread: number | null
}

/** 按因子值升序等分 q 组，每组统计前向收益均值；spread = 最高组 - 最低组。 */
export function quantileReturns(
  factor: ReadonlyArray<number | null>,
  fwd: ReadonlyArray<number | null>,
  q: number,
): QuantileReturns {
  const { xs, ys } = pairedValid(factor, fwd)
  if (!Number.isInteger(q) || q < 1 || xs.length < q) {
    return { buckets: [], spread: null }
  }
  const pairs = xs.map((value, index) => ({ factor: value, fwd: ys[index]! }))
  pairs.sort((a, b) => a.factor - b.factor || 0)
  const buckets: { q: number; n: number; meanFwd: number }[] = []
  for (let b = 0; b < q; b++) {
    const start = Math.floor((b * pairs.length) / q)
    const end = Math.floor(((b + 1) * pairs.length) / q)
    let sum = 0
    for (let k = start; k < end; k++) sum += pairs[k]!.fwd
    const count = end - start
    buckets.push({ q: b + 1, n: count, meanFwd: count === 0 ? 0 : sum / count })
  }
  const low = buckets[0]!
  const high = buckets[buckets.length - 1]!
  const spread = high.meanFwd - low.meanFwd
  return { buckets, spread: Number.isFinite(spread) ? spread : null }
}

/** 横截面 IC：同一时刻多标的的因子值与前向收益（数组对齐），同 rankIc 规则。 */
export function crossSectionalIc(
  factorByAsset: ReadonlyArray<number | null>,
  fwdByAsset: ReadonlyArray<number | null>,
): number | null {
  return rankIc(factorByAsset, fwdByAsset)
}

export interface FactorReport {
  id: string
  horizon: number
  ic: number | null
  rolling: IcSummary
  quantiles: QuantileReturns
}

/** 一站式因子评估：全样本 IC、滚动 IC 汇总与分组收益；缺省 horizon 5、window 60、quantiles 5。 */
export function evaluateFactor(
  candles: readonly Candle[],
  def: FactorDef,
  opts?: {
    horizon?: number
    window?: number
    quantiles?: number
    params?: Record<string, number>
  },
): FactorReport {
  const horizon = opts?.horizon ?? 5
  const window = opts?.window ?? 60
  const q = opts?.quantiles ?? 5
  const values = def.compute(candles, opts?.params)
  const fwd = forwardReturns(candles, horizon)
  return {
    id: def.id,
    horizon,
    ic: rankIc(values, fwd),
    rolling: icSummary(rollingIc(values, fwd, window)),
    quantiles: quantileReturns(values, fwd, q),
  }
}

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/strategy_v2/factor_research.py:81; adapted.
// IC 衰减：对每个 horizon 用 forwardReturns + rankIc 重算一次 IC；无效点由 rankIc 剔除。
export function icDecay(
  factor: ReadonlyArray<number | null>,
  candles: readonly Candle[],
  horizons: number[],
): { horizon: number; ic: number | null }[] {
  return horizons.map((horizon) => ({
    horizon,
    ic: rankIc(factor, forwardReturns(candles, horizon)),
  }))
}

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/strategy_v2/factor_research.py:239; adapted.
// 分组单调性：bucket 序号与 meanFwd 的 Spearman 秩相关（分层序号升序为正）；少于 3 组 -> null。
export function quantileMonotonicity(
  buckets: { q: number; meanFwd: number }[],
): number | null {
  if (buckets.length < 3) return null
  return rankIc(
    buckets.map((_, index) => index),
    buckets.map((bucket) => bucket.meanFwd),
  )
}

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/strategy_v2/factor_research.py:548; adapted.
// 同组去均值中性化：null 原样保留，组内只有一个有效值时结果为 0；非有限值原样输出且不参与组均值。
// groups 为 null / 缺省的点归入同一个「无分组」桶（对应原实现的 Unclassified）。
export function neutralize(
  values: ReadonlyArray<number | null>,
  groups: ReadonlyArray<string | null>,
): Array<number | null> {
  const buckets = new Map<string | null | undefined, { sum: number; count: number }>()
  for (let i = 0; i < values.length; i++) {
    const value = values[i]
    if (value === null || value === undefined || !Number.isFinite(value)) continue
    const key = groups[i]
    const bucket = buckets.get(key)
    if (bucket === undefined) buckets.set(key, { sum: value, count: 1 })
    else {
      bucket.sum += value
      bucket.count += 1
    }
  }
  const out = new Array<number | null>(values.length).fill(null)
  for (let i = 0; i < values.length; i++) {
    const value = values[i]
    if (value === null || value === undefined) continue
    if (!Number.isFinite(value)) {
      out[i] = value
      continue
    }
    const bucket = buckets.get(groups[i])!
    out[i] = value - bucket.sum / bucket.count
  }
  return out
}
