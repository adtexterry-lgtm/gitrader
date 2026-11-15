// SPDX-License-Identifier: CPAL-1.0
// 单个参数组合的评估：只调 engine-core 的公开入口 runBacktest，再按账户权益算每期收益。
// 收益口径与 engine-core 的 sweep.ts 一致（读只读参考）：prev > 0 且两边有限 → cur / prev − 1，否则记 0；
// 所有试验因此等长，可以直接喂给 CSCV PBO 的周期 × 试验矩阵。
import { runBacktest, type Candle, type StrategyDef } from '@gitrader/engine-core'
import { sharpe } from '@gitrader/stats'
import type { Params } from './space'

/** 回测选项：从公开函数签名推导，避免深引 engine-core 未导出的类型。 */
export type SimOptions = Parameters<typeof runBacktest>[3]

/** 目标函数：收益序列 → 分数（越大越好）。 */
export type Metric = (returns: readonly number[]) => number

/** 缺省目标：每期 Sharpe（@gitrader/stats 的 sharpe，ddof 1），非有限数记 0。 */
export const sharpeMetric: Metric = (returns) => {
  const value = sharpe([...returns])
  return Number.isFinite(value) ? value : 0
}

export interface EvaluateOptions {
  sim?: SimOptions
  metric?: Metric
  /**
   * 测试窗预热：先跑这么多根 K 线再开始计分（这段时间的交易照跑，成绩不累计）。
   * 缺省 0（不预热，与旧行为一致）；必须是非负整数且给计分留得下一期收益。
   */
  warmupBars?: number
}

export interface CandidateEvaluation {
  params: Params
  score: number
  /** 同一组收益的每期 Sharpe（与 score 分开记：换目标函数时过拟合指标仍用 Sharpe）。 */
  sharpe: number
  /** 计分区间的每期收益（长度 = 计分 K 线数 − 1）；预热期的收益不在里面。 */
  returns: number[]
  trades: number
  /** 本次评估跳过的预热根数：计分从 `candles[warmupBars]` 开始。 */
  warmupBars: number
  /** 策略自报的指标预热（engine-core 的 series.warmup）；只作记录，计分起点由 warmupBars 决定。 */
  indicatorWarmup: number
}

/** 权益曲线 → 每期简单收益；长度 = equity.length − 1。 */
export function equityReturns(equity: readonly { v: number }[]): number[] {
  const out: number[] = []
  for (let i = 1; i < equity.length; i++) {
    const prev = equity[i - 1]?.v
    const cur = equity[i]?.v
    if (prev === undefined || cur === undefined) continue
    out.push(prev > 0 && Number.isFinite(cur) && Number.isFinite(prev) ? cur / prev - 1 : 0)
  }
  return out
}

export function evaluateCandidate(
  strategy: StrategyDef,
  candles: readonly Candle[],
  params: Params,
  opts?: EvaluateOptions,
): CandidateEvaluation {
  if (candles.length < 2) throw new RangeError('evaluateCandidate needs at least 2 candles')
  const warmupBars = normalizeWarmupBars(opts?.warmupBars, candles.length)
  const run = runBacktest(strategy, candles, params, opts?.sim ?? {})
  const all = equityReturns(run.equity)
  // 预热期内照跑（仓位、成交、权益都真算），但计分只取预热之后的那几期收益：
  // 早段的分数不许进目标函数，否则参数可以靠数据开头的运气拿分。
  const returns = warmupBars === 0 ? all : all.slice(warmupBars)
  const metric = opts?.metric ?? sharpeMetric
  const score = metric(returns)
  return {
    params: { ...params },
    score: Number.isFinite(score) ? score : 0,
    sharpe: sharpeMetric(returns),
    returns,
    trades: run.trades.length,
    warmupBars,
    indicatorWarmup: Number.isFinite(run.series.warmup) ? Math.max(0, Math.trunc(run.series.warmup)) : 0,
  }
}

/** 预热根数校验：非负整数，且必须给计分留至少一期收益（否则这一组等于没成绩，不许静默记 0）。 */
function normalizeWarmupBars(warmupBars: number | undefined, candleCount: number): number {
  if (warmupBars === undefined) return 0
  if (!Number.isInteger(warmupBars) || warmupBars < 0) {
    throw new RangeError(`warmupBars must be a non-negative integer; got ${String(warmupBars)}`)
  }
  if (warmupBars > candleCount - 2) {
    throw new RangeError(`warmupBars ${warmupBars} leaves no scored period for ${candleCount} candles`)
  }
  return warmupBars
}

export interface SearchTarget {
  objective: (params: Params) => number
  evaluations: CandidateEvaluation[]
}

/**
 * 造一个「搜索目标 + 评估记录」对：目标函数每调一次就把整条评估记下来，
 * 供过拟合指标用（PBO 与 DSR 需要每次试验的收益序列，不能只留分数）。
 */
export function searchTarget(
  strategy: StrategyDef,
  candles: readonly Candle[],
  opts?: EvaluateOptions,
): SearchTarget {
  const evaluations: CandidateEvaluation[] = []
  const objective = (params: Params): number => {
    const evaluation = evaluateCandidate(strategy, candles, params, opts)
    evaluations.push(evaluation)
    return evaluation.score
  }
  return { objective, evaluations }
}
