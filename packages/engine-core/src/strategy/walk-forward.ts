// SPDX-License-Identifier: CPAL-1.0
// Walk-forward：滚动窗口训练窗参数扫描 → 测试窗样本外仿真 → 各折样本外收益拼接与效率比。纯函数，不碰 IO。
import type { Candle } from '../types'
import type { Params, StrategyDef } from './types'
import { runSweep } from './sweep'
import { Simulator, inferIntervalMs, type SimOptions, type SimStats } from './simulator'
import { sharpe } from '@gitrader/stats'

/** 半开区间 [start, end) 的 candles 下标。 */
export interface WalkForwardWindow {
  index: number
  train: [number, number]
  test: [number, number]
  /** 训练窗结束与测试窗开始之间空出的根数；> 0 时才有该字段。 */
  embargo?: number
}

/** 滚动窗口选项：embargo 间隔与序列末尾的盲留出段。 */
export interface WalkForwardWindowOptions {
  embargoBars?: number
  blindHoldoutBars?: number
}

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/strategy_evolution/walk_forward.py:66; adapted (rolling windows instead of fixed train_start).
/**
 * 滚动窗口：start = 0, step, 2·step, …；step 缺省 = testBars。
 * 测试窗 = [trainEnd + embargo, trainEnd + embargo + testBars)；末尾 blindHoldoutBars 根保留给盲段，
 * 任何一个窗口都不得进入 [n − blind, n)，条件为 start + trainBars + embargoBars + testBars <= n − blindHoldoutBars。
 */
export function walkForwardWindows(
  n: number,
  trainBars: number,
  testBars: number,
  step?: number,
  opts?: WalkForwardWindowOptions,
): WalkForwardWindow[] {
  const out: WalkForwardWindow[] = []
  if (!Number.isFinite(n) || !Number.isFinite(trainBars) || !Number.isFinite(testBars)) return out
  if (trainBars <= 0 || testBars <= 0) return out
  const stride = step ?? testBars
  if (!Number.isFinite(stride) || stride <= 0) return out
  const embargo = opts?.embargoBars ?? 0
  const blind = opts?.blindHoldoutBars ?? 0
  if (!Number.isFinite(embargo) || !Number.isFinite(blind)) return out
  if (embargo < 0 || blind < 0) return out
  if (blind >= n) return out
  const limit = n - blind
  let index = 0
  for (let start = 0; start + trainBars + embargo + testBars <= limit; start += stride) {
    const window: WalkForwardWindow = {
      index,
      train: [start, start + trainBars],
      test: [start + trainBars + embargo, start + trainBars + embargo + testBars],
    }
    if (embargo > 0) window.embargo = embargo
    out.push(window)
    index++
  }
  return out
}

export interface WalkForwardFold {
  window: WalkForwardWindow
  bestParams: Params
  /** 训练窗 runSweep 的 best.sharpe（每期）。 */
  trainSharpe: number
  /** 测试窗用 bestParams 单独仿真后的每期 Sharpe（@gitrader/stats 的 sharpe，非有限数记 0）。 */
  testSharpe: number
  /** 测试窗每期收益（与 sweep 同口径：prev > 0 ? cur/prev − 1 : 0），长度 = testBars − 1。 */
  testReturns: number[]
  testStats: SimStats
}

export interface WalkForwardResult {
  folds: WalkForwardFold[]
  /** 各折 testReturns 顺序拼接。 */
  oosReturns: number[]
  /** 对 oosReturns 算每期 Sharpe；非有限数记 0。 */
  oosSharpe: number
  /** 平均测试 Sharpe / 平均训练 Sharpe；折数为 0 或平均训练 Sharpe ≤ 0 → null。 */
  efficiency: number | null
  /** 盲留出段 [n − blind, n)；没有盲段 → null。 */
  holdout: [number, number] | null
  /** 实际使用的 embargo 根数；未给选项 → 0。 */
  embargoBars: number
  warnings: string[]
}

function mean(values: number[]): number {
  if (values.length === 0) return 0
  let sum = 0
  for (const v of values) sum += v
  return sum / values.length
}

function emptyResult(
  warning: string,
  embargoBars = 0,
  holdout: [number, number] | null = null,
): WalkForwardResult {
  return { folds: [], oosReturns: [], oosSharpe: 0, efficiency: null, holdout, embargoBars, warnings: [warning] }
}

export function runWalkForward(
  strategy: StrategyDef,
  candles: Candle[],
  grid: Params[],
  sim: SimOptions,
  opts: {
    trainBars: number
    testBars: number
    step?: number
    pboBlocks?: number
    embargoBars?: number
    blindHoldoutBars?: number
  },
): WalkForwardResult {
  const { trainBars, testBars } = opts
  const embargoBars = opts.embargoBars ?? 0
  const blindHoldoutBars = opts.blindHoldoutBars ?? 0
  if (
    !Number.isFinite(trainBars) ||
    !Number.isFinite(testBars) ||
    trainBars < 2 ||
    testBars < 2 ||
    grid.length === 0 ||
    !Number.isFinite(embargoBars) ||
    !Number.isFinite(blindHoldoutBars) ||
    embargoBars < 0 ||
    blindHoldoutBars < 0 ||
    blindHoldoutBars >= candles.length
  ) {
    return emptyResult('invalid walk-forward options')
  }

  const holdout: [number, number] | null =
    blindHoldoutBars > 0 ? [candles.length - blindHoldoutBars, candles.length] : null

  const windows = walkForwardWindows(candles.length, trainBars, testBars, opts.step, {
    embargoBars,
    blindHoldoutBars,
  })
  if (windows.length === 0) return emptyResult('not enough candles for one window', embargoBars, holdout)

  const stepMs = inferIntervalMs(candles)
  const warnings: string[] = []
  const folds: WalkForwardFold[] = []

  for (const window of windows) {
    const [a, b] = window.train
    const [c, d] = window.test
    const train = candles.slice(a, b)
    const sweep = runSweep(strategy, train, grid, sim, { pboBlocks: opts.pboBlocks })
    const best = sweep.best
    if (best === null) {
      warnings.push(`fold ${window.index}: sweep has no best trial; skipped`)
      continue
    }

    const test = candles.slice(c, d)
    let params: Params = { ...strategy.defaults, ...best.params }
    if (strategy.anchor) params = strategy.anchor(test, params)
    const series = strategy.evaluate(test, params)
    const s = new Simulator(sim)
    for (let k = 0; k < test.length; k++) {
      const hasSignal = k > 0 && k - 1 >= series.warmup
      s.onBar(k, test[k]!, hasSignal ? series.target[k - 1]! : null, hasSignal ? series.reasons[k - 1] || '' : '')
    }
    const testStats = s.stats(test, stepMs)

    const testReturns: number[] = []
    for (let j = 1; j < s.equity.length; j++) {
      const prev = s.equity[j - 1]!.v
      const cur = s.equity[j]!.v
      testReturns.push(prev > 0 && Number.isFinite(cur) && Number.isFinite(prev) ? cur / prev - 1 : 0)
    }

    const rawTestSharpe = sharpe(testReturns)
    const testSharpe = Number.isFinite(rawTestSharpe) ? rawTestSharpe : 0
    if (!Number.isFinite(rawTestSharpe)) warnings.push(`fold ${window.index}: test sharpe is not finite; set to 0`)

    const trainSharpe = Number.isFinite(best.sharpe) ? best.sharpe : 0
    if (!Number.isFinite(best.sharpe)) warnings.push(`fold ${window.index}: train sharpe is not finite; set to 0`)

    folds.push({ window, bestParams: best.params, trainSharpe, testSharpe, testReturns, testStats })
  }

  const oosReturns: number[] = []
  for (const fold of folds) {
    for (const r of fold.testReturns) oosReturns.push(r)
  }

  const rawOosSharpe = sharpe(oosReturns)
  const oosSharpe = Number.isFinite(rawOosSharpe) ? rawOosSharpe : 0
  if (!Number.isFinite(rawOosSharpe)) warnings.push('oos sharpe is not finite; set to 0')

  let efficiency: number | null = null
  if (folds.length > 0) {
    const avgTest = mean(folds.map((f) => f.testSharpe))
    const avgTrain = mean(folds.map((f) => f.trainSharpe))
    if (avgTrain > 0) {
      const ratio = avgTest / avgTrain
      if (Number.isFinite(ratio)) efficiency = ratio
      else warnings.push('efficiency is not finite; set to null')
    }
  }

  return { folds, oosReturns, oosSharpe, efficiency, holdout, embargoBars, warnings }
}
