// SPDX-License-Identifier: CPAL-1.0
// 参数扫描：按参数网格重复跑模拟器，输出每组的统计、CSCV 过拟合概率与最优组的去膨胀 Sharpe。纯函数，不碰 IO。
import type { Candle } from '../types'
import type { ParamDef, ParamValue, Params, StrategyDef } from './types'
import { Simulator, inferIntervalMs, type SimOptions, type SimStats } from './simulator'
import { sharpe, sharpeOfTrials, dsr, skewness, kurtosis, cscvPbo, mulberry32, type PboResult } from '@gitrader/stats'

export interface SweepAxis { key: string; values: ParamValue[] }

function axisValues(def: ParamDef, maxPoints: number): ParamValue[] {
  if (def.type === 'boolean') return [false, true]
  if (def.type === 'select') return def.options && def.options.length > 0 ? [...def.options] : [def.default]
  const { min, max, step } = def
  if (min === undefined || max === undefined || step === undefined) return [def.default]
  if (!Number.isFinite(min) || !Number.isFinite(max) || !(step > 0)) return [def.default]
  const count = Math.floor((max - min) / step + 1e-9) + 1
  if (count < 1) return [def.default]
  const values: ParamValue[] = []
  for (let i = 0; i < count; i++) {
    const raw = min + i * step
    values.push(def.type === 'integer' ? Math.round(raw) : raw)
  }
  if (values.length <= maxPoints) return values
  const picked: ParamValue[] = []
  const limit = Math.max(1, Math.floor(maxPoints))
  for (let i = 0; i < limit; i++) {
    const idx = limit === 1 ? 0 : Math.round((i * (values.length - 1)) / (limit - 1))
    const value = values[idx]!
    if (!picked.includes(value)) picked.push(value)
  }
  return picked
}

/**
 * 由参数定义生成扫描轴。
 * - 默认取所有 `hidden !== true` 的定义，按定义顺序；给了 opts.keys 则只取这些 key，按 keys 的顺序（找不到的 key 忽略）。
 * - number / integer 且 min、max 为有限数、step > 0：values = min, min+step, …（≤ max + 1e-9）；integer 每个值取 Math.round；
 *   个数超过 maxPoints（缺省 20）时等距抽样：取下标 Math.round(i * (count - 1) / (maxPoints - 1))，i = 0..maxPoints-1，去重。
 * - number / integer 缺 min / max / step → [default]。
 * - boolean → [false, true]。select → options（没有 options → [default]）。
 */
export function axesFromParams(defs: ParamDef[], opts?: { keys?: string[]; maxPoints?: number }): SweepAxis[] {
  const maxPoints = opts?.maxPoints ?? 20
  const keys = opts?.keys
  let selected: ParamDef[]
  if (keys) {
    selected = []
    for (const key of keys) {
      const def = defs.find((d) => d.key === key)
      if (def) selected.push(def)
    }
  } else selected = defs.filter((d) => d.hidden !== true)
  return selected.map((def) => ({ key: def.key, values: axisValues(def, maxPoints) }))
}

/** 笛卡尔积；第一轴最慢（字典序）。axes 为空 → [{}]。组合数 > maxTrials（缺省 512）→ 抛 RangeError。 */
export function gridCombinations(axes: SweepAxis[], maxTrials = 512): Params[] {
  let n = 1
  for (const axis of axes) n *= axis.values.length
  if (n > maxTrials) throw new RangeError(`sweep grid has ${n} trials; max ${maxTrials}`)
  if (axes.length === 0) return [{}]
  const out: Params[] = []
  const current: Params = {}
  const walk = (depth: number): void => {
    if (depth === axes.length) {
      out.push({ ...current })
      return
    }
    const axis = axes[depth]!
    for (const value of axis.values) {
      current[axis.key] = value
      walk(depth + 1)
    }
  }
  walk(0)
  return out
}

/** 笛卡尔积总数（不物化）。空轴 → 1。 */
export function countCombinations(axes: SweepAxis[]): number {
  let n = 1
  for (const axis of axes) n *= axis.values.length
  return n
}

/**
 * 不物化笛卡尔积的参数抽样：按字典序下标解码组合。
 * - 总数 ≤ maxTrials：按字典序返回全部满足 constraints 的组合。
 * - 否则对满足 constraints 的组合做蓄水池抽样（Algorithm R，随机数 mulberry32(seed)），结果按 index 升序。
 * - maxTrials ≤ 0 或非有限数 → 抛 RangeError。
 */
// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/strategy_evolution/search.py:26; adapted.
export function sampleGrid(
  axes: SweepAxis[],
  opts: { maxTrials: number; seed?: number; constraints?: (p: Params) => boolean },
): { params: Params; index: number }[] {
  const limit = Number.isFinite(opts.maxTrials) ? Math.floor(opts.maxTrials) : 0
  if (limit < 1) throw new RangeError(`maxTrials must be a positive integer; got ${opts.maxTrials}`)
  const total = countCombinations(axes)
  const constraints = opts.constraints
  const digits: number[] = new Array<number>(axes.length)
  const decode = (index: number): Params => {
    let rest = index
    for (let i = axes.length - 1; i >= 0; i--) {
      const len = axes[i]!.values.length
      digits[i] = rest % len
      rest = Math.floor(rest / len)
    }
    const params: Params = {}
    for (let i = 0; i < axes.length; i++) params[axes[i]!.key] = axes[i]!.values[digits[i]!]!
    return params
  }
  const out: { params: Params; index: number }[] = []
  if (total <= limit) {
    for (let index = 0; index < total; index++) {
      const params = decode(index)
      if (constraints && !constraints(params)) continue
      out.push({ params, index })
    }
    return out
  }
  const rand = mulberry32(opts.seed ?? 42)
  let eligible = 0
  for (let index = 0; index < total; index++) {
    const params = decode(index)
    if (constraints && !constraints(params)) continue
    if (eligible < limit) out.push({ params, index })
    else {
      const replace = Math.floor(rand() * (eligible + 1))
      if (replace < limit) out[replace] = { params, index }
    }
    eligible++
  }
  out.sort((a, b) => a.index - b.index)
  return out
}

export interface SweepTrial {
  index: number
  params: Params
  stats: SimStats
  /** 每期简单收益，长度 = equity.length - 1；前值 ≤ 0 或非有限数的那一期记 0（所有试验等长，供 PBO 矩阵用）。 */
  returns: number[]
  /** 每期 Sharpe（@gitrader/stats 的 sharpe，ddof 1）；非有限数记 0。 */
  sharpe: number
}

export interface SweepResult {
  trials: SweepTrial[]
  /** 每期 Sharpe 最大的试验（并列取下标最小）；没有试验时 null。 */
  best: { index: number; params: Params; sharpe: number } | null
  /** 各试验每期 Sharpe 的横截面方差（sharpeOfTrials）。 */
  trialVariance: number
  /** best 的去膨胀 Sharpe：trials ≥ 2 时 dsr(best.sharpe, { n: 期数, nTrials: trials.length, trialVariance, skew, kurt })；否则 null。 */
  dsr: number | null
  /** CSCV 过拟合概率：trials ≥ 2 且期数 ≥ blocks 时计算；否则 null 并 warning。 */
  pbo: PboResult | null
  warnings: string[]
}

export function runSweep(
  strategy: StrategyDef,
  candles: Candle[],
  grid: Params[],
  sim: SimOptions,
  opts?: { stepMs?: number; pboBlocks?: number },
): SweepResult {
  if (candles.length < 2) {
    return { trials: [], best: null, trialVariance: 0, dsr: null, pbo: null, warnings: ['too few candles'] }
  }
  const stepMs = opts?.stepMs ?? inferIntervalMs(candles)
  const blocks = opts?.pboBlocks ?? 16
  const warnings: string[] = []

  const trials: SweepTrial[] = []
  for (let i = 0; i < grid.length; i++) {
    let params: Params = { ...strategy.defaults, ...grid[i] }
    if (strategy.anchor) params = strategy.anchor(candles, params)
    const series = strategy.evaluate(candles, params)
    const s = new Simulator(sim)
    for (let k = 0; k < candles.length; k++) {
      const hasSignal = k > 0 && k - 1 >= series.warmup
      s.onBar(k, candles[k]!, hasSignal ? series.target[k - 1]! : null, hasSignal ? series.reasons[k - 1] || '' : '')
    }
    const stats = s.stats(candles, stepMs)
    const returns: number[] = []
    for (let j = 1; j < s.equity.length; j++) {
      const prev = s.equity[j - 1]!.v
      const cur = s.equity[j]!.v
      returns.push(prev > 0 && Number.isFinite(cur) && Number.isFinite(prev) ? cur / prev - 1 : 0)
    }
    const sr = sharpe(returns)
    trials.push({ index: i, params, stats, returns, sharpe: Number.isFinite(sr) ? sr : 0 })
  }

  let best: SweepResult['best'] = null
  for (const trial of trials) {
    if (best === null || trial.sharpe > best.sharpe) {
      best = { index: trial.index, params: trial.params, sharpe: trial.sharpe }
    }
  }

  const trialVariance = sharpeOfTrials(trials.map((t) => t.returns)).variance

  let dsrValue: number | null = null
  if (trials.length >= 2 && best) {
    const r = trials[best.index]!.returns
    const n = r.length
    const skew = n >= 3 ? skewness(r) : 0
    const kurt = n >= 4 ? kurtosis(r) : 3
    const computed = dsr(best.sharpe, { n, nTrials: trials.length, trialVariance, skew, kurt })
    if (Number.isFinite(computed)) dsrValue = computed
    else warnings.push('dsr is not finite; set to null')
  }

  let pbo: PboResult | null = null
  const periods = trials.length > 0 ? trials[0]!.returns.length : 0
  if (trials.length >= 2 && periods >= blocks) {
    const matrix: number[][] = []
    for (let t = 0; t < periods; t++) {
      const row: number[] = []
      for (const trial of trials) row.push(trial.returns[t]!)
      matrix.push(row)
    }
    pbo = cscvPbo(matrix, { blocks })
  } else {
    warnings.push(`pbo skipped: need at least ${blocks} periods and 2 trials`)
  }

  return { trials, best, trialVariance, dsr: dsrValue, pbo, warnings }
}
