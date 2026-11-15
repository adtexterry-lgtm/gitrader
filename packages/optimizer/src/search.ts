// SPDX-License-Identifier: CPAL-1.0
// 三种搜索：网格（穷举笛卡尔积）、随机（种子决定抽样）、进化（锦标赛选择 + 均匀交叉 + 逐基因变异）。
// 目标函数由调用方注入（本包只在 optimize.ts 里把它接到 engine-core 的回测上）；这里不碰 K 线与 IO。
import { mulberry32 } from '@gitrader/stats'
import {
  canonicalKey,
  domainValues,
  randomValue,
  snapValue,
  validateSpace,
  DEFAULT_POINTS_PER_DIM,
  type ParamSpace,
  type ParamSpec,
  type ParamValue,
  type Params,
} from './space'

export type SearchKind = 'grid' | 'random' | 'evolution'

export interface TrialPoint {
  params: Params
  score: number
}

export interface SearchOutcome {
  kind: SearchKind
  /** 真正跑过目标函数的点（去重后，按评估顺序）。 */
  evaluated: TrialPoint[]
  best: TrialPoint | null
  /** 实际使用的种子；网格不用随机数，记 0。 */
  seed: number
  duplicatesSkipped: number
  /** 进化搜索跑了几代；其余两种为 0。 */
  generations: number
  /** 进化搜索每代的最优分数（网格 / 随机为空）。 */
  bestPerGeneration: number[]
}

export type Objective = (params: Params) => number

/**
 * 目标函数调用闸门：同一个参数组合只算一次（缓存），非有限分数直接抛错。
 * 不把 NaN 当最差：静默吞掉会让「最优」变成「第一个碰巧还算得出来的组合」。
 */
class Evaluator {
  readonly evaluated: TrialPoint[] = []
  duplicatesSkipped = 0
  private readonly cache = new Map<string, number>()
  private readonly objective: Objective

  constructor(objective: Objective) {
    this.objective = objective
  }

  score(params: Params): number {
    const key = canonicalKey(params)
    const hit = this.cache.get(key)
    if (hit !== undefined) {
      this.duplicatesSkipped++
      return hit
    }
    const score = this.objective({ ...params })
    if (!Number.isFinite(score)) throw new RangeError(`objective returned a non-finite score for ${key}`)
    this.cache.set(key, score)
    this.evaluated.push({ params: { ...params }, score })
    return score
  }

  /** 已算过的分数；没算过返回 undefined。 */
  cached(params: Params): number | undefined {
    return this.cache.get(canonicalKey(params))
  }
}

/** 最优试验：分数最大者，并列取评估顺序里靠前的一个（与 engine-core sweep 的约定一致）。 */
function bestOf(evaluated: readonly TrialPoint[]): TrialPoint | null {
  let best: TrialPoint | null = null
  for (const point of evaluated) {
    if (best === null || point.score > best.score) best = point
  }
  return best === null ? null : { params: { ...best.params }, score: best.score }
}

/** 按参数空间与种子抽一个完整组合。 */
function drawParams(keys: readonly string[], space: ParamSpace, rand: () => number): Params {
  const params: Params = {}
  for (const key of keys) {
    const spec = space[key]
    if (spec === undefined) throw new TypeError(`space.${key}: missing spec`)
    params[key] = randomValue(spec, rand)
  }
  return params
}

export interface GridSearchSpec {
  space: ParamSpace
  objective: Objective
  /** 每个维度的候选值上限（缺省 11）。 */
  maxPointsPerDim?: number
  /** 组合数上限，超过就抛错而不是跑一半（缺省 512）。 */
  maxTrials?: number
}

/**
 * 网格搜索：笛卡尔积穷举，第一维最慢（字典序），完全确定，不用随机数。
 * 组合数 > maxTrials 时抛 RangeError——悄悄抽样会让「网格」这个名字变成谎话。
 */
export function gridSearch(spec: GridSearchSpec): SearchOutcome {
  const keys = validateSpace(spec.space)
  const maxPoints = spec.maxPointsPerDim ?? DEFAULT_POINTS_PER_DIM
  const maxTrials = spec.maxTrials ?? 512
  if (!Number.isFinite(maxTrials) || maxTrials < 1) throw new RangeError(`maxTrials must be a positive integer; got ${spec.maxTrials}`)

  const axes: { key: string; values: ParamValue[] }[] = []
  let total = 1
  for (const key of keys) {
    const axisSpec = spec.space[key]
    if (axisSpec === undefined) continue
    const values = domainValues(axisSpec, maxPoints)
    axes.push({ key, values })
    total *= values.length
  }
  if (total > maxTrials) throw new RangeError(`grid has ${total} trials; max ${maxTrials}`)

  const evaluator = new Evaluator(spec.objective)
  const walk = (depth: number, current: Params): void => {
    if (depth === axes.length) {
      evaluator.score(current)
      return
    }
    const axis = axes[depth]
    if (axis === undefined) return
    for (const value of axis.values) {
      current[axis.key] = value
      walk(depth + 1, current)
    }
  }
  walk(0, {})

  return {
    kind: 'grid',
    evaluated: evaluator.evaluated,
    best: bestOf(evaluator.evaluated),
    seed: 0,
    duplicatesSkipped: evaluator.duplicatesSkipped,
    generations: 0,
    bestPerGeneration: [],
  }
}

export interface RandomSearchSpec {
  space: ParamSpace
  objective: Objective
  /** 需要多少个**不重复**的评估点。 */
  trials: number
  seed?: number
  /** 每个点的重抽上限（空间太小、撞重复时用），缺省 50。 */
  maxAttemptsPerTrial?: number
}

/**
 * 随机搜索：每维按取值域均匀抽（数值型夹到域内并贴 step 网格）。
 * 同一 seed 逐点复现；先抽满 trials 个不重复组合，抽不到的重复点不计入评估。
 */
export function randomSearch(spec: RandomSearchSpec): SearchOutcome {
  const keys = validateSpace(spec.space)
  const trials = Math.floor(spec.trials)
  if (!Number.isFinite(trials) || trials < 1) throw new RangeError(`trials must be a positive integer; got ${spec.trials}`)
  const seed = spec.seed ?? 42
  const maxAttempts = spec.maxAttemptsPerTrial ?? 50
  if (!Number.isFinite(maxAttempts) || maxAttempts < 1) throw new RangeError('maxAttemptsPerTrial must be a positive integer')

  const rand = mulberry32(seed)
  const evaluator = new Evaluator(spec.objective)
  const budget = trials * maxAttempts + maxAttempts
  let attempts = 0
  while (evaluator.evaluated.length < trials && attempts < budget) {
    attempts++
    evaluator.score(drawParams(keys, spec.space, rand))
  }

  return {
    kind: 'random',
    evaluated: evaluator.evaluated,
    best: bestOf(evaluator.evaluated),
    seed,
    duplicatesSkipped: evaluator.duplicatesSkipped,
    generations: 0,
    bestPerGeneration: [],
  }
}

export interface EvolutionSearchSpec {
  space: ParamSpace
  objective: Objective
  population?: number
  generations?: number
  elite?: number
  mutationRate?: number
  /** 锦标赛规模（每选一次取 tournament 个个体里最好的）。 */
  tournament?: number
  seed?: number
}

function assertEvolution(spec: EvolutionSearchSpec, population: number, generations: number, elite: number, mutationRate: number, tournament: number): void {
  if (!Number.isInteger(population) || population < 2) throw new RangeError(`population must be an integer >= 2; got ${spec.population}`)
  if (!Number.isInteger(generations) || generations < 1) throw new RangeError(`generations must be a positive integer; got ${spec.generations}`)
  if (!Number.isInteger(elite) || elite < 0 || elite >= population) throw new RangeError(`elite must be in [0, population); got ${spec.elite}`)
  if (!(Number.isFinite(mutationRate) && mutationRate >= 0 && mutationRate <= 1)) throw new RangeError(`mutationRate must be in [0, 1]; got ${spec.mutationRate}`)
  if (!Number.isInteger(tournament) || tournament < 2 || tournament > population) throw new RangeError(`tournament must be an integer in [2, population]; got ${spec.tournament}`)
}

/** 单个基因变异：数值型走 step（没给 step 用跨度的 1/10）左右扰动，select 换选项，boolean 取反。 */
function mutateValue(spec: ParamSpec, value: ParamValue, rand: () => number): ParamValue {
  if (spec.type === 'boolean') return !(value === true)
  if (spec.type === 'select') {
    if (spec.options.length < 2) return value
    const idx = Math.min(spec.options.length - 1, Math.floor(rand() * spec.options.length))
    return spec.options[idx] ?? value
  }
  const span = spec.step ?? (spec.max - spec.min) / 10
  const current = typeof value === 'number' ? value : spec.min
  const delta = (rand() * 2 - 1) * (span > 0 ? span : 1)
  return snapValue(spec, current + delta)
}

function crossover(a: Params, b: Params, rand: () => number): Params {
  const child: Params = {}
  for (const key of Object.keys(a)) {
    const from = rand() < 0.5 ? a : b
    const value = from[key]
    if (value !== undefined) child[key] = value
  }
  return child
}

/** 按分数降序、键升序排序（并列用 canonicalKey 决出，与 Map / 插入顺序无关）。 */
function rankIndividuals(population: readonly Params[], evaluator: Evaluator): Params[] {
  return population
    .map((params) => ({ params, score: evaluator.cached(params) ?? -Infinity, key: canonicalKey(params) }))
    .sort((x, y) => (y.score - x.score) || (x.key < y.key ? -1 : x.key > y.key ? 1 : 0))
    .map((item) => item.params)
}

/**
 * 进化搜索：seeded 初代 → 逐代「精英保留 + 锦标赛选择 + 均匀交叉 + 逐基因变异」。
 * 目标函数仍只由缓存闸门调用，一代里重复的基因不会重复回测。
 * 预算 = population × generations 次评估（上限，去重后可能更少）。
 */
export function evolutionSearch(spec: EvolutionSearchSpec): SearchOutcome {
  const keys = validateSpace(spec.space)
  const populationSize = spec.population ?? 20
  const generations = spec.generations ?? 5
  const elite = spec.elite ?? Math.min(2, populationSize - 1)
  const mutationRate = spec.mutationRate ?? 0.2
  const tournament = spec.tournament ?? Math.min(3, populationSize)
  assertEvolution(spec, populationSize, generations, elite, mutationRate, tournament)

  const seed = spec.seed ?? 42
  const rand = mulberry32(seed)
  const evaluator = new Evaluator(spec.objective)

  let population: Params[] = []
  let guard = 0
  while (population.length < populationSize && guard < populationSize * 50) {
    guard++
    const candidate = drawParams(keys, spec.space, rand)
    const key = canonicalKey(candidate)
    if (population.some((individual) => canonicalKey(individual) === key)) continue
    population.push(candidate)
  }
  // 空间太小、抽不出足够不重复的个体：用已抽到的个体循环填满（评估仍走缓存）。
  if (population.length === 0) population.push(drawParams(keys, spec.space, rand))
  while (population.length < populationSize) {
    const pick = population[population.length % Math.max(1, population.length)]
    if (pick === undefined) break
    population.push({ ...pick })
  }

  const bestPerGeneration: number[] = []
  for (let generation = 0; generation < generations; generation++) {
    for (const individual of population) evaluator.score(individual)
    const ranked = rankIndividuals(population, evaluator)
    const generationBest = evaluator.cached(ranked[0] ?? {}) ?? 0
    bestPerGeneration.push(generationBest)
    if (generation === generations - 1) break

    const next: Params[] = ranked.slice(0, elite).map((individual) => ({ ...individual }))
    while (next.length < populationSize) {
      const pickOne = (): Params => {
        let winner: Params | null = null
        let winnerScore = -Infinity
        for (let t = 0; t < tournament; t++) {
          const idx = Math.min(ranked.length - 1, Math.floor(rand() * ranked.length))
          const candidate = ranked[idx]
          if (candidate === undefined) continue
          const score = evaluator.cached(candidate) ?? -Infinity
          if (winner === null || score > winnerScore) {
            winner = candidate
            winnerScore = score
          }
        }
        return winner ?? ranked[0] ?? {}
      }
      const parentA = pickOne()
      const parentB = pickOne()
      const child = crossover(parentA, parentB, rand)
      for (const key of keys) {
        const geneSpec = spec.space[key]
        const value = child[key]
        if (geneSpec === undefined || value === undefined) continue
        if (rand() < mutationRate) child[key] = mutateValue(geneSpec, value, rand)
      }
      next.push(child)
    }
    population = next
  }

  return {
    kind: 'evolution',
    evaluated: evaluator.evaluated,
    best: bestOf(evaluator.evaluated),
    seed,
    duplicatesSkipped: evaluator.duplicatesSkipped,
    generations,
    bestPerGeneration,
  }
}
