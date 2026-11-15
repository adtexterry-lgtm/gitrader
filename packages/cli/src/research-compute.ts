// SPDX-License-Identifier: CPAL-1.0
// 研究作业的计算体（第六轮 C 包）：寻优（@gitrader/optimizer 的 optimize()）与因子报告（tools/research 的 buildFactorReport）。
// 纯函数，不碰网络、账户、账本；同一份代码既在工作线程里跑（serveResearchWorker），也在没有工作线程的环境里同线程跑。
// 这个文件在 CLI 包里，所以可以 import optimizer；engine-core 保持依赖纯净（见 engine-core/src/runtime/research.ts）。
import { parentPort, workerData } from 'node:worker_threads'
import type { Candle, FactorComputeInput, OptimizeComputeInput, ResearchComputeHooks, ResearchOutcome, StrategyDef } from '@gitrader/engine-core'
import { DEFAULT_POINTS_PER_DIM, assertPlan, domainValues, optimize, spaceSize, validateSpace, walkForwardWindows } from '@gitrader/optimizer'
import type { OptimizeRequest, ParamSpace, SearchPlan, ValidationPlan } from '@gitrader/optimizer'
import { RESEARCH_LIMITS } from '@gitrader/protocol'
import { buildFactorReport } from './research/factor-report.mjs'

type Params = Record<string, number | boolean | string>

// ---- 校验（起作业之前，同步，只看规格本身，不看 K 线）----------------------------------------

/**
 * 网格的有效空间。optimizer 的网格默认每个维度最多取 11 个点、超过就等距挑着取——写了 step 的维度被悄悄抽稀，
 * 「网格组合数」就不再是用户写的那个数。这里让写了 step 的维度保留全部点；没写 step 的维度仍取 maxPointsPerDim（缺省 11）个点，
 * 并固定成 select，交给 optimizer 时 maxPointsPerDim 取最大，不再抽稀任何维度。组合数上限（500）按这份空间算。
 */
export function gridSpace(space: ParamSpace, maxPointsPerDim?: number): ParamSpace {
  const out: ParamSpace = {}
  for (const [k, sp] of Object.entries(space)) {
    out[k] = (sp.type === 'number' || sp.type === 'integer') && sp.step === undefined ? { type: 'select', options: domainValues(sp, maxPointsPerDim ?? DEFAULT_POINTS_PER_DIM) } : sp
  }
  return out
}

/** 评估次数的估计（进度分母的初值）：网格 = 组合数，随机 = trials，进化 = 种群 × 代数。超过上限 / 写错返回 { error }。 */
export function checkOptimizePlan(plan: { space: unknown; search: unknown; validation: unknown; metric: unknown; strategyParamKeys: readonly string[] }): { total: number } | { error: string } {
  try {
    if (plan.metric !== 'sharpe') return { error: 'spec.metric must be "sharpe" (the only metric this build supports)' }
    const space = plan.space as ParamSpace
    const keys = validateSpace(space)
    const declared = new Set(plan.strategyParamKeys)
    const undeclared = keys.filter((k) => !declared.has(k))
    if (undeclared.length > 0) return { error: `spec.space names parameter(s) the strategy does not declare: ${undeclared.join(', ')} (declared: ${[...declared].join(', ') || 'none'})` }
    const s = plan.search as { kind?: unknown; trials?: unknown; population?: unknown; generations?: unknown; maxPointsPerDim?: unknown }
    if (s === null || typeof s !== 'object' || Array.isArray(s)) return { error: 'spec.search must be an object: { kind: "grid" } | { kind: "random", trials } | { kind: "evolution", ... }' }
    let total: number
    if (s.kind === 'grid') total = spaceSize(gridSpace(space, s.maxPointsPerDim as number | undefined), Number.MAX_SAFE_INTEGER)
    else if (s.kind === 'random') {
      if (!Number.isInteger(s.trials) || (s.trials as number) < 1) return { error: 'spec.search.trials must be a positive integer for a random search' }
      total = s.trials as number
    } else if (s.kind === 'evolution') {
      const population = s.population === undefined ? 20 : s.population
      const generations = s.generations === undefined ? 5 : s.generations
      if (!Number.isInteger(population) || !Number.isInteger(generations) || (population as number) < 2 || (generations as number) < 1) return { error: 'spec.search population must be an integer >= 2 and generations an integer >= 1' }
      total = (population as number) * (generations as number)
    } else return { error: 'spec.search.kind must be grid, random or evolution' }
    if (total > RESEARCH_LIMITS.maxTrials) return { error: `the search would run ${total} trials; the limit is ${RESEARCH_LIMITS.maxTrials}. Narrow spec.space, coarsen the steps, or use { kind: "random", trials <= ${RESEARCH_LIMITS.maxTrials} }` }
    assertPlan(plan.validation as ValidationPlan, Number.MAX_SAFE_INTEGER)
    return { total }
  } catch (e) {
    return { error: `invalid optimization spec: ${e instanceof Error ? e.message : String(e)}` }
  }
}

// ---- 寻优 ---------------------------------------------------------------------------------

/** 固定参数并进策略定义：缺省值改成固定值（寻优点只覆盖 space 里的键），validateParams 看到的原始参数也先补上固定值。 */
export function withFixedParams(def: StrategyDef, fixed: Params): StrategyDef {
  const keys = Object.keys(fixed)
  if (keys.length === 0) return def
  return {
    ...def,
    params: def.params.map((p) => (p.key in fixed ? { ...p, default: fixed[p.key]! } : p)),
    ...(def.validateParams ? { validateParams: (raw: Params) => def.validateParams!({ ...fixed, ...raw }) } : {}),
  }
}

/** optimize() 的结果 → 摘要（不含明细）+ 明细（trials / folds）。 */
export function computeOptimize(input: Omit<OptimizeComputeInput, 'strategy'> & { def: StrategyDef; fixed: Params }, hooks: ResearchComputeHooks): ResearchOutcome {
  const plan = input.validation as unknown as ValidationPlan
  const search: SearchPlan = { ...(input.search as unknown as SearchPlan) }
  let space = input.space as unknown as ParamSpace
  if (search.kind === 'grid') {
    space = gridSpace(space, search.maxPointsPerDim)
    search.maxPointsPerDim = Number.MAX_SAFE_INTEGER
    search.maxTrials = Math.min(search.maxTrials ?? RESEARCH_LIMITS.maxTrials, RESEARCH_LIMITS.maxTrials)
  }
  const trialsEstimate = checkOptimizePlan({ space: input.space, search: input.search, validation: plan, metric: 'sharpe', strategyParamKeys: input.def.params.map((p) => p.key) })
  const perSearch = 'total' in trialsEstimate ? trialsEstimate.total : 0
  const n = input.candles.length
  // 进度分母：主搜索 + 验证里每折（或留出期）再搜一遍 + 每折两次复评
  const folds = plan.kind === 'walk-forward' ? walkForwardWindows(n, plan.trainBars, plan.testBars, plan.step, { embargoBars: plan.embargoBars, blindHoldoutBars: plan.blindHoldoutBars }).length : 1
  hooks.progress(0, perSearch * (1 + folds) + 2 * folds)
  let calls = 0
  const base = withFixedParams(input.def, input.fixed)
  const counted: StrategyDef = { ...base, evaluate: (c, p) => { if (++calls % 8 === 0) hooks.progress(calls); return base.evaluate(c, p) } }
  const request: OptimizeRequest = {
    strategy: counted, candles: input.candles, space, search, validation: plan, seed: input.seed,
    sim: input.sim as OptimizeRequest['sim'], ...(input.warmupBars !== undefined ? { warmupBars: input.warmupBars } : {}),
  }
  const res = optimize(request)
  hooks.progress(calls, calls)
  const v = res.validation
  return {
    summary: {
      searchKind: res.searchKind,
      trialCount: res.trialCount,
      duplicatesSkipped: res.duplicatesSkipped,
      best: res.best === null ? null : { params: res.best.params, score: res.best.score, sharpe: res.best.sharpe },
      overfit: { trials: res.overfit.trials, pbo: res.overfit.pbo, dsr: res.overfit.dsr, deflatedBenchmark: res.overfit.deflatedBenchmark, probLossOos: res.overfit.probLossOos, missing: res.overfit.missing },
      validation: {
        kind: v.kind, folds: v.folds.length, oosScore: v.oosScore, efficiency: v.efficiency, inSampleOnly: v.inSampleOnly,
        ...(v.holdout ? { holdout: { sample: v.holdout.sample, window: v.holdout.holdout, score: v.holdout.score, trainScore: v.holdout.trainScore, bestParams: v.holdout.bestParams } } : {}),
      },
      banner: res.banner,
      warmup: res.warmup,
      warnings: res.warnings,
    },
    parts: {
      trials: res.trials.map((t) => ({ params: t.params, score: t.score, sharpe: t.sharpe, trades: t.trades })),
      ...(v.kind === 'walk-forward' ? { folds: v.folds.map((f) => ({ index: f.index, train: f.train, test: f.test, bestParams: f.bestParams, trainScore: f.trainScore, testScore: f.testScore })) } : {}),
    },
  }
}

// ---- 因子报告 -----------------------------------------------------------------------------

const sig = (x: number | null | undefined): number | null => (typeof x === 'number' && Number.isFinite(x) ? Number(x.toPrecision(8)) : null)

export function computeFactors(input: FactorComputeInput, hooks: ResearchComputeHooks): ResearchOutcome {
  hooks.progress(0, 1)
  const r = buildFactorReport({ candles: input.candles, horizon: input.horizon, window: input.window, quantiles: input.quantiles, top: input.top })
  const row = (f: (typeof r.all)[number]) => ({
    factorId: f.factorId, period: f.period, ic: sig(f.ic), ir: sig(f.rolling.ir), tStat: sig(f.rolling.tStat), tMethod: r.tMethod, tLags: r.tLags,
    nEff: sig(f.rolling.nEff), positiveShare: sig(f.rolling.positiveShare), spread: sig(f.spread), monotonicity: sig(f.monotonicity),
  })
  const all = r.all.map(row)
  hooks.progress(1, 1)
  return {
    summary: {
      horizon: r.horizon, window: r.window, quantiles: r.quantiles, catalogSize: r.catalogSize, withIc: r.withIc, tMethod: r.tMethod, tLags: r.tLags,
      best: all[0] ?? null,
      top: all.slice(0, Math.min(input.top, 20)),
      warnings: r.warnings,
    },
    parts: { factors: all },
  }
}

// ---- 工作线程 -----------------------------------------------------------------------------

/** 走线的策略：有源码就按源码在线程里重建；内置策略（机器人模板）没有源码，按 id 从注入的清单里取。 */
export interface WireStrategy {
  meta: Omit<StrategyDef, 'evaluate' | 'anchor' | 'validateParams' | 'notionalCap'>
  source?: string
  builtinId?: string
  hasAnchor: boolean
  params: Params
}
export type WireRequest =
  | (Omit<OptimizeComputeInput, 'strategy'> & { strategy: WireStrategy })
  | FactorComputeInput
export type WorkerMessage =
  | { t: 'progress'; done: number; total?: number }
  | { t: 'done'; outcome: ResearchOutcome }
  | { t: 'error'; message: string }

async function rehydrate(w: WireStrategy, builtins: readonly StrategyDef[]): Promise<StrategyDef> {
  if (w.source === undefined) {
    const def = builtins.find((b) => b.id === w.builtinId)
    if (!def) throw new Error(`strategy "${w.builtinId ?? w.meta.id}" has no source and is not a built-in in this engine`)
    return def
  }
  const mod = await import('data:text/javascript;base64,' + Buffer.from(w.source, 'utf8').toString('base64'))
  const raw = (mod.default ?? mod.strategy) as { evaluate: StrategyDef['evaluate']; anchor?: StrategyDef['anchor'] }
  return { ...w.meta, evaluate: (c, p) => raw.evaluate(c, p), ...(w.hasAnchor ? { anchor: (c: Candle[], p: Params) => raw.anchor!(c, p) } : {}) }
}

/** 在研究工作线程里跑一次（launcher 在 workerData.gitraderRole === 'research' 时调用）。 */
export function serveResearchWorker(opts: { builtins?: readonly StrategyDef[] } = {}): void {
  const req = (workerData as { request: WireRequest }).request
  const post = (m: WorkerMessage): void => parentPort!.postMessage(m)
  let last = 0
  const hooks: ResearchComputeHooks = { progress: (done, total) => { const now = Date.now(); if (total !== undefined || now - last >= 100) { last = now; post({ t: 'progress', done, ...(total !== undefined ? { total } : {}) }) } } }
  void (async () => {
    try {
      if (req.kind === 'factor_report') return post({ t: 'done', outcome: computeFactors(req, hooks) })
      const { strategy, ...rest } = req
      const def = await rehydrate(strategy, opts.builtins ?? [])
      post({ t: 'done', outcome: computeOptimize({ ...rest, def, fixed: strategy.params }, hooks) })
    } catch (e) {
      post({ t: 'error', message: e instanceof Error ? e.message : String(e) })
    }
  })()
}
