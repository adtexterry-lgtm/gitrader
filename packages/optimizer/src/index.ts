// SPDX-License-Identifier: CPAL-1.0
// @gitrader/optimizer 入口：参数空间、三种搜索、过拟合指标、强制样本外验证、报告渲染。
// 只依赖 engine-core 的公开入口（runBacktest）与 stats 的公开统计函数，不改内核、不联网、无第三方依赖。
export {
  validateSpace,
  domainValues,
  snapValue,
  canonicalKey,
  randomValue,
  spaceSize,
  DEFAULT_POINTS_PER_DIM,
} from './space'
export type { ParamSpec, ParamSpace, ParamValue, Params } from './space'

export { gridSearch, randomSearch, evolutionSearch } from './search'
export type { SearchKind, SearchOutcome, TrialPoint, Objective, GridSearchSpec, RandomSearchSpec, EvolutionSearchSpec } from './search'

export { evaluateCandidate, equityReturns, searchTarget, sharpeMetric } from './evaluate'
export type { CandidateEvaluation, EvaluateOptions, Metric, SimOptions, SearchTarget } from './evaluate'

export { parameterLookbackBars, resolveWarmupBars, clampWarmupBars, WARMUP_NAME_TOKENS } from './warmup'
export type { WarmupPlan, WarmupSource } from './warmup'

export { overfitReport, describeOverfit, DEFAULT_PBO_BLOCKS } from './overfit'
export type { OverfitReport, TrialReturns } from './overfit'

export { assertPlan, runValidation, walkForwardWindows, sharpeOf } from './validation'
export type { ValidationPlan, ValidationOutcome, ValidationContext, WindowRange, FoldResult, HoldoutResult } from './validation'

export { optimize, IN_SAMPLE_BANNER } from './optimize'
export type { OptimizeRequest, OptimizeResult, SearchPlan, BestTrial } from './optimize'

export { renderReport, reportHeadline } from './report'
