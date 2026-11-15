// SPDX-License-Identifier: CPAL-1.0
// 强制验证：walk-forward 或留出期。寻优结果没有样本外证据时，本模块会把 inSampleOnly 置真，
// 报告首屏随之打「样本内，不可作为前向证据」。
// 窗口规则与 engine-core 的 walk-forward.ts（只读参照）一致：测试窗紧接训练窗（中间可留 embargo），
// 序列末尾 blindHoldoutBars 根谁都不能碰。这里不复用它的代码——engine-core 只公开 runBacktest 一族入口。
import type { Candle } from '@gitrader/engine-core'
import { sharpe } from '@gitrader/stats'
import type { Metric } from './evaluate'
import type { Params } from './space'
import { clampWarmupBars } from './warmup'

export type ValidationPlan =
  | {
      kind: 'walk-forward'
      trainBars: number
      testBars: number
      step?: number
      embargoBars?: number
      blindHoldoutBars?: number
    }
  | { kind: 'holdout'; holdoutBars: number }

export interface WindowRange {
  index: number
  train: [number, number]
  test: [number, number]
  embargo: number
}

/** 半开区间 [a, b) 的滚动窗口；凑不出一个窗口时返回空数组（由调用方标样本内）。 */
export function walkForwardWindows(
  n: number,
  trainBars: number,
  testBars: number,
  step?: number,
  opts?: { embargoBars?: number; blindHoldoutBars?: number },
): WindowRange[] {
  const stride = step ?? testBars
  const embargo = opts?.embargoBars ?? 0
  const blind = opts?.blindHoldoutBars ?? 0
  const out: WindowRange[] = []
  if (!Number.isFinite(n) || !Number.isFinite(trainBars) || !Number.isFinite(testBars) || !Number.isFinite(stride)) return out
  if (trainBars < 1 || testBars < 1 || stride < 1) return out
  if (!Number.isFinite(embargo) || !Number.isFinite(blind) || embargo < 0 || blind < 0) return out
  const limit = n - blind
  let index = 0
  for (let start = 0; start + trainBars + embargo + testBars <= limit; start += stride) {
    out.push({
      index,
      train: [start, start + trainBars],
      test: [start + trainBars + embargo, start + trainBars + embargo + testBars],
      embargo,
    })
    index++
  }
  return out
}

export interface FoldResult {
  index: number
  train: [number, number]
  test: [number, number]
  embargo: number
  /** 测试窗前面借来的预热根数（来自测试窗之前那侧，不计分）。 */
  warmupBars: number
  bestParams: Params
  /** 训练窗内的最优分数（样本内，不能当证据）。 */
  trainScore: number
  /** 训练窗里搜索评估了多少个组合。 */
  trainTrials: number
  testScore: number
  testReturns: number[]
}

export interface HoldoutResult {
  /** 用于寻优的样本内区间。 */
  sample: [number, number]
  /** 一次都没参与寻优的留出期。 */
  holdout: [number, number]
  /** 留出期前面借来的预热根数（样本内那侧，不计分）。 */
  warmupBars: number
  bestParams: Params
  trainScore: number
  trainTrials: number
  score: number
  returns: number[]
}

export interface ValidationOutcome {
  kind: ValidationPlan['kind']
  folds: FoldResult[]
  holdout: HoldoutResult | null
  /** 样本外收益（各折顺序拼接 / 留出期收益）。 */
  oosReturns: number[]
  oosScore: number | null
  /** 平均测试分数 / 平均训练分数；训练侧 ≤ 0 或没有折 → null。 */
  efficiency: number | null
  /** true = 一份样本外证据都没有：报告首屏必须标「样本内，不可作为前向证据」。 */
  inSampleOnly: boolean
  warnings: string[]
}

export interface ValidationContext {
  candles: readonly Candle[]
  /** 在给定 K 线上跑一次寻优，返回最优参数与该次评估次数。 */
  optimizeSlice: (candles: readonly Candle[], seed: number) => { best: { params: Params } | null; trials: number }
  /**
   * 用给定参数在同一段 K 线上回测，返回分数与收益。
   * warmupBars = 这段切片里前多少根当预热不计分（切片的开头已经包含预热用的历史）。
   */
  evaluate: (candles: readonly Candle[], params: Params, warmupBars: number) => { score: number; returns: number[] }
  /** 计分前先跑不算分的 K 线根数：测试窗 / 留出期前面会向过去借这么多根当预热。 */
  warmupBars?: number
  metric: Metric
  seed: number
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0
  let sum = 0
  for (const value of values) sum += value
  return sum / values.length
}

/** 校验验证计划；未知的 kind 抛 TypeError，不落进留出期分支。 */
export function assertPlan(plan: ValidationPlan, n: number): void {
  if (plan.kind === 'walk-forward') {
    if (!Number.isInteger(plan.trainBars) || plan.trainBars < 2) throw new RangeError('walk-forward trainBars must be an integer >= 2')
    if (!Number.isInteger(plan.testBars) || plan.testBars < 2) throw new RangeError('walk-forward testBars must be an integer >= 2')
    if (plan.step !== undefined && (!Number.isInteger(plan.step) || plan.step < 1)) throw new RangeError('walk-forward step must be a positive integer')
    if (plan.embargoBars !== undefined && (!Number.isInteger(plan.embargoBars) || plan.embargoBars < 0)) throw new RangeError('walk-forward embargoBars must be a non-negative integer')
    if (plan.blindHoldoutBars !== undefined && (!Number.isInteger(plan.blindHoldoutBars) || plan.blindHoldoutBars < 0 || plan.blindHoldoutBars >= n)) {
      throw new RangeError('walk-forward blindHoldoutBars must be in [0, n)')
    }
    return
  }
  if (plan.kind === 'holdout') {
    if (!Number.isInteger(plan.holdoutBars) || plan.holdoutBars < 2) throw new RangeError('holdout holdoutBars must be an integer >= 2')
    if (n - plan.holdoutBars < 2) throw new RangeError('holdout must leave at least 2 in-sample candles')
    return
  }
  throw new TypeError(`unknown validation kind: ${String((plan as { kind?: unknown }).kind)}`)
}

function emptyOutcome(kind: ValidationPlan['kind'], warning: string): ValidationOutcome {
  return { kind, folds: [], holdout: null, oosReturns: [], oosScore: null, efficiency: null, inSampleOnly: true, warnings: [warning] }
}

/**
 * 跑验证。walk-forward：每折在训练窗寻优、把最优参数原样拿到紧随的测试窗回测；
 * 留出期：在样本内寻优，最优参数只在末尾留出期上回测一次。
 * 每折的搜索种子 = seed + 折号，因此可复现，各折也不会抽到同一批组合。
 */
export function runValidation(plan: ValidationPlan, ctx: ValidationContext): ValidationOutcome {
  const n = ctx.candles.length
  assertPlan(plan, n)
  // 预热根数：测试窗 / 留出期前面向过去借这么多根（只借窗口之前那侧，绝不碰窗口之后的数据）。
  const warmup = clampWarmupBars(ctx.warmupBars ?? 0, n)

  if (plan.kind === 'walk-forward') {
    const windows = walkForwardWindows(n, plan.trainBars, plan.testBars, plan.step, {
      embargoBars: plan.embargoBars,
      blindHoldoutBars: plan.blindHoldoutBars,
    })
    if (windows.length === 0) {
      return emptyOutcome('walk-forward', `walk-forward 凑不出一个窗口（n=${n}，训练 ${plan.trainBars} + 测试 ${plan.testBars}）`)
    }
    const warnings: string[] = []
    const folds: FoldResult[] = []
    for (const window of windows) {
      const [a, b] = window.train
      const [c, d] = window.test
      const train = ctx.candles.slice(a, b)
      // 测试窗的预热前缀取 [c - warmup, d)：起点早于测试窗（属于训练窗那侧的历史），
      // 计分仍从 c 开始，所以样本外收益的长度不变，只是指标在窗口开头就已经是齐的。
      const testFrom = Math.max(0, c - warmup)
      const test = ctx.candles.slice(testFrom, d)
      const testWarmup = clampWarmupBars(c - testFrom, test.length)
      const search = ctx.optimizeSlice(train, ctx.seed + window.index)
      if (search.best === null) {
        warnings.push(`fold ${window.index}: 训练窗没有可用试验，跳过`)
        continue
      }
      const scored = ctx.evaluate(test, search.best.params, testWarmup)
      folds.push({
        index: window.index,
        train: window.train,
        test: window.test,
        embargo: window.embargo,
        warmupBars: testWarmup,
        bestParams: { ...search.best.params },
        trainScore: ctx.evaluate(train, search.best.params, clampWarmupBars(warmup, train.length)).score,
        trainTrials: search.trials,
        testScore: scored.score,
        testReturns: scored.returns,
      })
    }
    if (folds.length === 0) return emptyOutcome('walk-forward', 'walk-forward 没有产出任何有效折')

    const oosReturns: number[] = []
    for (const fold of folds) for (const r of fold.testReturns) oosReturns.push(r)
    const oosMetric = ctx.metric(oosReturns)
    const oosScore = Number.isFinite(oosMetric) ? oosMetric : null
    if (oosScore === null) warnings.push('样本外分数不可计算，记 null')

    const avgTest = mean(folds.map((fold) => fold.testScore))
    const avgTrain = mean(folds.map((fold) => fold.trainScore))
    const efficiency = avgTrain > 0 ? avgTest / avgTrain : null

    return {
      kind: 'walk-forward',
      folds,
      holdout: null,
      oosReturns,
      oosScore,
      efficiency,
      inSampleOnly: oosReturns.length === 0,
      warnings,
    }
  }

  const sampleEnd = n - plan.holdoutBars
  const sample = ctx.candles.slice(0, sampleEnd)
  // 留出期同样向过去借预热：前缀取 [sampleEnd - warmup, n)，全部是样本内（已经在寻优里用过）的历史，
  // 计分仍只覆盖留出期本身（长度 = holdoutBars − 1）。
  const holdoutFrom = Math.max(0, sampleEnd - warmup)
  const held = ctx.candles.slice(holdoutFrom, n)
  const holdoutWarmup = clampWarmupBars(sampleEnd - holdoutFrom, held.length)
  const search = ctx.optimizeSlice(sample, ctx.seed)
  if (search.best === null) {
    return emptyOutcome('holdout', '留出期寻优没有产出有效试验（样本内只有样本内结果）')
  }
  const scored = ctx.evaluate(held, search.best.params, holdoutWarmup)
  const holdout: HoldoutResult = {
    sample: [0, sampleEnd],
    holdout: [sampleEnd, n],
    warmupBars: holdoutWarmup,
    bestParams: { ...search.best.params },
    trainScore: ctx.evaluate(sample, search.best.params, clampWarmupBars(warmup, sample.length)).score,
    trainTrials: search.trials,
    score: scored.score,
    returns: scored.returns,
  }
  const oosScore = Number.isFinite(scored.score) ? scored.score : null
  return {
    kind: 'holdout',
    folds: [],
    holdout,
    oosReturns: scored.returns,
    oosScore,
    efficiency: null,
    inSampleOnly: scored.returns.length === 0,
    warnings: oosScore === null ? ['留出期分数不可计算，记 null'] : [],
  }
}

/** 收益序列的每期 Sharpe（验证里给「测试窗 Sharpe」用；非有限数记 0）。 */
export function sharpeOf(returns: readonly number[]): number {
  const value = sharpe([...returns])
  return Number.isFinite(value) ? value : 0
}
