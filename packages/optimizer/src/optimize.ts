// SPDX-License-Identifier: CPAL-1.0
// 寻优主入口：三种搜索跑在 engine-core 的回测公开入口之上，过拟合指标与样本外验证一律强制产出。
// 顺序：先校验计划并定寻优区间（留出期 / 盲段在外）→ 区间内搜索（记下每条试验的收益）→ 过拟合指标（PBO / DSR）
// → 样本外验证（walk-forward 或留出期，自己切窗口，用全部 K 线）。
import type { Candle, StrategyDef } from '@gitrader/engine-core'
import { evaluateCandidate, searchTarget, sharpeMetric, type CandidateEvaluation, type Metric, type SimOptions } from './evaluate'
import { overfitReport, type OverfitReport } from './overfit'
import { evolutionSearch, gridSearch, randomSearch, type SearchKind, type SearchOutcome } from './search'
import { canonicalKey, validateSpace, type ParamSpace, type Params } from './space'
import { assertPlan, runValidation, type ValidationOutcome, type ValidationPlan } from './validation'
import { clampWarmupBars, resolveWarmupBars, type WarmupPlan } from './warmup'

/** 只有样本内结果时报告的第一行（逐字，测试与门禁都认这句）。 */
export const IN_SAMPLE_BANNER = '样本内，不可作为前向证据'

export type SearchPlan =
  | { kind: 'grid'; maxPointsPerDim?: number; maxTrials?: number }
  | { kind: 'random'; trials: number; maxAttemptsPerTrial?: number }
  | { kind: 'evolution'; population?: number; generations?: number; elite?: number; mutationRate?: number; tournament?: number }

export interface OptimizeRequest {
  strategy: StrategyDef
  candles: readonly Candle[]
  space: ParamSpace
  search: SearchPlan
  /** 必填：walk-forward 或留出期。没有它就没有样本外证据，本包不接受这种寻优。 */
  validation: ValidationPlan
  seed?: number
  sim?: SimOptions
  metric?: Metric
  pboBlocks?: number
  /**
   * 测试窗预热根数：每个参数组合先跑这么多根 K 线再计成绩（预热期内成交照算、成绩不累计）。
   * 缺省按参数空间推（名字带 period / lookback / window / length / bars 的维度取其最大上界，
   * 与 QuantDinger `_parameter_lookback_bars` 同一口径）；推不出来就是 0。
   */
  warmupBars?: number
}

export interface BestTrial {
  params: Params
  score: number
  sharpe: number
}

export interface OptimizeResult {
  seed: number
  searchKind: SearchKind
  /** 寻优区间内真正回测过的试验（按评估顺序，收益序列一并留着）。 */
  trials: CandidateEvaluation[]
  /** 寻优区间 [a, b)（K 线下标半开区间）；留出期与盲段不在区间内。 */
  searchRange: [number, number]
  /** 真正计分的区间 [a, b)：开头 warmupBars 根是预热，跑了但不计分。 */
  scoringRange: [number, number]
  /** 预热计划：根数与其来源（显式 / 按参数名推 / 无）。 */
  warmup: WarmupPlan
  trialCount: number
  best: BestTrial | null
  /** 强制产出的过拟合指标（PBO / DSR / 试验次数）。 */
  overfit: OverfitReport
  validation: ValidationOutcome
  /** true = 没有任何样本外证据。 */
  inSampleOnly: boolean
  /** inSampleOnly 时为 IN_SAMPLE_BANNER，否则 null。 */
  banner: string | null
  duplicatesSkipped: number
  bestPerGeneration: number[]
  warnings: string[]
}

function runSearch(
  strategy: StrategyDef,
  candles: readonly Candle[],
  space: ParamSpace,
  plan: SearchPlan,
  seed: number,
  sim: SimOptions | undefined,
  metric: Metric,
  warmupBars: number,
): { outcome: SearchOutcome; evaluations: CandidateEvaluation[] } {
  const target = searchTarget(strategy, candles, { sim, metric, warmupBars })
  let outcome: SearchOutcome
  if (plan.kind === 'grid') {
    outcome = gridSearch({ space, objective: target.objective, maxPointsPerDim: plan.maxPointsPerDim, maxTrials: plan.maxTrials })
  } else if (plan.kind === 'random') {
    outcome = randomSearch({
      space,
      objective: target.objective,
      trials: plan.trials,
      seed,
      maxAttemptsPerTrial: plan.maxAttemptsPerTrial,
    })
  } else if (plan.kind === 'evolution') {
    outcome = evolutionSearch({
      space,
      objective: target.objective,
      population: plan.population,
      generations: plan.generations,
      elite: plan.elite,
      mutationRate: plan.mutationRate,
      tournament: plan.tournament,
      seed,
    })
  } else {
    throw new TypeError(`unknown search kind: ${String((plan as { kind?: unknown }).kind)}`)
  }
  return { outcome, evaluations: target.evaluations }
}

/**
 * 参数寻优。任何一条都不可省：
 * - validation 缺失 / 为 null → TypeError（强制配样本外验证）。
 * - 过拟合指标总会出现在返回值里；算不出的项是 null 且带 missing 原因。
 * - 同一 seed + 同一输入 → 逐点相同的结果（网格不用随机数，seed 记 0）。
 */
export function optimize(request: OptimizeRequest): OptimizeResult {
  if (request === null || typeof request !== 'object') throw new TypeError('optimize needs a request object')
  if (request.validation === undefined || request.validation === null) {
    throw new TypeError('optimize: validation is required (walk-forward or holdout); in-sample-only runs are not accepted')
  }
  const { strategy, candles, space, search, validation } = request
  if (strategy === undefined) throw new TypeError('optimize: strategy is required')
  if (candles.length < 2) throw new RangeError('optimize needs at least 2 candles')
  validateSpace(space)
  if (search === undefined || search === null) throw new TypeError('optimize: search plan is required')
  assertPlan(validation, candles.length)

  const seed = request.seed ?? 42
  const metric = request.metric ?? sharpeMetric
  // 预热计划：显式给了就用，否则按参数名推（QD `_parameter_lookback_bars` 同款上界）。
  const warmup = resolveWarmupBars(space, request.warmupBars)

  // 寻优区间：holdout 去掉末尾留出期；walk-forward 去掉末尾盲段。
  // 主搜索、试验次数、best、PBO / DSR 都只用这一段；runValidation 拿全部 K 线，自己切窗口。
  const searchEnd = validation.kind === 'holdout'
    ? candles.length - validation.holdoutBars
    : candles.length - (validation.blindHoldoutBars ?? 0)
  const searchRange: [number, number] = [0, searchEnd]
  // 物理隔离：搜索阶段只拿到 candles[0, searchEnd) 这一段，留出期 / 盲段的 K 线根本不在手上。
  const searchCandles = candles.slice(0, searchEnd)
  if (warmup.bars > 0 && warmup.bars > searchEnd - 2) {
    throw new RangeError(
      `warmupBars ${warmup.bars} leaves no scored period in the search range [0, ${searchEnd})`,
    )
  }
  const scoringRange: [number, number] = [warmup.bars, searchEnd]

  const { outcome, evaluations } = runSearch(strategy, searchCandles, space, search, seed, request.sim, metric, warmup.bars)

  const bestIndexInEvaluations = (): number => {
    const best = outcome.best
    if (best === null) return -1
    const key = canonicalKey(best.params)
    for (let i = 0; i < evaluations.length; i++) {
      const evaluation = evaluations[i]
      if (evaluation !== undefined && canonicalKey(evaluation.params) === key) return i
    }
    return -1
  }
  const bestIndex = bestIndexInEvaluations()
  const overfit = overfitReport(
    evaluations.map((evaluation) => ({ returns: evaluation.returns })),
    bestIndex < 0 ? 0 : bestIndex,
    { blocks: request.pboBlocks },
  )

  const validationOutcome = runValidation(validation, {
    candles,
    seed,
    metric,
    warmupBars: warmup.bars,
    optimizeSlice: (slice, sliceSeed) => {
      const inner = runSearch(
        strategy,
        slice,
        space,
        search,
        sliceSeed,
        request.sim,
        metric,
        clampWarmupBars(warmup.bars, slice.length),
      )
      return {
        best: inner.outcome.best === null ? null : { params: inner.outcome.best.params },
        trials: inner.outcome.evaluated.length,
      }
    },
    evaluate: (slice, params, sliceWarmupBars) => {
      const scored = evaluateCandidate(strategy, slice, params, { sim: request.sim, metric, warmupBars: sliceWarmupBars })
      return { score: scored.score, returns: scored.returns }
    },
  })

  const bestEvaluation = bestIndex >= 0 ? evaluations[bestIndex] : undefined
  const best: BestTrial | null = bestEvaluation === undefined
    ? null
    : { params: { ...bestEvaluation.params }, score: bestEvaluation.score, sharpe: bestEvaluation.sharpe }

  const warnings: string[] = [...validationOutcome.warnings]
  if (outcome.evaluated.length === 0) warnings.push('搜索没有产出任何试验')
  if (warmup.bars === 0) warnings.push('未设预热（warmupBars=0）：指标未齐的头几根也计分，参数可能靠数据开头的运气拿分')
  if (validationOutcome.inSampleOnly) warnings.push('没有样本外证据：报告首屏标「样本内，不可作为前向证据」')

  return {
    seed: outcome.kind === 'grid' ? 0 : seed,
    searchKind: outcome.kind,
    trials: evaluations,
    searchRange,
    scoringRange,
    warmup,
    trialCount: evaluations.length,
    best,
    overfit,
    validation: validationOutcome,
    inSampleOnly: validationOutcome.inSampleOnly,
    banner: validationOutcome.inSampleOnly ? IN_SAMPLE_BANNER : null,
    duplicatesSkipped: outcome.duplicatesSkipped,
    bestPerGeneration: outcome.bestPerGeneration,
    warnings,
  }
}
