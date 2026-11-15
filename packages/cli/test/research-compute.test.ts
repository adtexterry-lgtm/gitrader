// SPDX-License-Identifier: CPAL-1.0
// 研究作业的计算体（第六轮 C 包）：寻优结果与 @gitrader/optimizer 的 optimize() 逐点一致、规格校验、因子报告的 Newey-West t 值。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { Candle, StrategyDef } from '@gitrader/engine-core'
import { optimize } from '@gitrader/optimizer'
import emaCross from '../../engine-core/examples/strategies/ema-cross'
import { checkOptimizePlan, computeFactors, computeOptimize, withFixedParams } from '../src/research-compute'
import { createResearchProvider } from '../src/research-provider'

const here = dirname(fileURLToPath(import.meta.url))
const candles: Candle[] = readFileSync(join(here, '..', '..', '..', 'assets', 'samples', 'btcusdt-1h.csv'), 'utf8').trim().split(/\r?\n/).slice(1).map((l) => {
  const [t, o, h, low, c, v] = l.split(',').map(Number)
  return { t: t!, o: o!, h: h!, l: low!, c: c!, v: v! }
})
const def = emaCross as unknown as StrategyDef
const SPACE = { fast: { type: 'integer', min: 5, max: 15, step: 5 }, slow: { type: 'integer', min: 20, max: 60, step: 20 } }
const SIM = { initialCash: 10000, leverage: 1, feeRate: 0.0005, slippageBps: 3 }
const base = { kind: 'optimize' as const, candles, sim: SIM, space: SPACE, search: { kind: 'grid' }, seed: 42, metric: 'sharpe', def, fixed: {} }
const hooks = () => { const calls: [number, number | undefined][] = []; return { calls, progress: (d: number, t?: number) => { calls.push([d, t]) } } }

describe('checkOptimizePlan：起作业前的同步校验', () => {
  const ok = { space: SPACE, search: { kind: 'grid' }, validation: { kind: 'holdout', holdoutBars: 300 }, metric: 'sharpe', strategyParamKeys: ['fast', 'slow', 'allowShort'] }
  it('合法计划返回预计评估次数', () => {
    expect(checkOptimizePlan(ok)).toEqual({ total: 9 })
    expect(checkOptimizePlan({ ...ok, search: { kind: 'random', trials: 450 } })).toEqual({ total: 450 })
    expect(checkOptimizePlan({ ...ok, search: { kind: 'evolution' } })).toEqual({ total: 100 })
  })
  it('三种 INVALID_PARAMS：超 500 组、策略没声明的参数、验证计划写错', () => {
    const big = { fast: { type: 'integer', min: 2, max: 100, step: 1 }, slow: { type: 'integer', min: 3, max: 400, step: 1 } }
    expect(checkOptimizePlan({ ...ok, space: big })).toMatchObject({ error: expect.stringContaining('limit is 500') })
    expect(checkOptimizePlan({ ...ok, search: { kind: 'random', trials: 501 } })).toMatchObject({ error: expect.stringContaining('501') })
    expect(checkOptimizePlan({ ...ok, search: { kind: 'evolution', population: 30, generations: 20 } })).toMatchObject({ error: expect.stringContaining('600') })
    expect(checkOptimizePlan({ ...ok, space: { nope: { type: 'integer', min: 1, max: 3 } } })).toMatchObject({ error: expect.stringContaining('nope') })
    expect(checkOptimizePlan({ ...ok, validation: { kind: 'holdout' } })).toMatchObject({ error: expect.stringContaining('holdoutBars') })
    expect(checkOptimizePlan({ ...ok, validation: { kind: 'bogus' } })).toMatchObject({ error: expect.stringContaining('unknown validation kind') })
  })
  it('写了 step 的维度不被抽稀（56 个点就是 56 组）；没写 step 的维度取 11 个点；超限按这个数算', () => {
    expect(checkOptimizePlan({ ...ok, space: { fast: { type: 'integer', min: 5, max: 60, step: 1 } } })).toEqual({ total: 56 })
    expect(checkOptimizePlan({ ...ok, space: { fast: { type: 'integer', min: 5, max: 60 } } })).toEqual({ total: 11 })
    expect(checkOptimizePlan({ ...ok, space: { fast: { type: 'integer', min: 1, max: 30, step: 1 }, slow: { type: 'integer', min: 1, max: 30, step: 1 } } })).toMatchObject({ error: expect.stringContaining('900') })
  })
  it('其它写错：metric、search 种类、空空间、min > max', () => {
    expect(checkOptimizePlan({ ...ok, metric: 'sortino' })).toMatchObject({ error: expect.stringContaining('sharpe') })
    expect(checkOptimizePlan({ ...ok, search: { kind: 'annealing' } })).toMatchObject({ error: expect.stringContaining('grid, random or evolution') })
    expect(checkOptimizePlan({ ...ok, space: {} })).toMatchObject({ error: expect.stringContaining('at least one parameter') })
    expect(checkOptimizePlan({ ...ok, space: { fast: { type: 'integer', min: 9, max: 3 } } })).toMatchObject({ error: expect.stringContaining('min must not exceed max') })
  })
})

describe('computeOptimize 与寻优库逐点一致（样本 CSV，ema-cross）', () => {
  it('holdout 300：9 组，best = {fast 15, slow 20}，分数 / PBO / DSR / 样本外分数同值，试验明细逐条对得上', () => {
    const h = hooks()
    const out = computeOptimize({ ...base, validation: { kind: 'holdout', holdoutBars: 300 } }, h)
    const lib = optimize({ strategy: def, candles, space: SPACE as never, search: { kind: 'grid' }, validation: { kind: 'holdout', holdoutBars: 300 }, seed: 42, sim: SIM })
    const s = out.summary as any // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(s.trialCount).toBe(lib.trialCount)
    expect(s.trialCount).toBe(9)
    expect(s.best.params).toEqual({ fast: 15, slow: 20 })
    expect(s.best.score).toBe(lib.best!.score)
    expect(s.overfit.pbo).toBe(lib.overfit.pbo)
    expect(s.overfit.dsr).toBe(lib.overfit.dsr)
    expect(s.validation).toMatchObject({ kind: 'holdout', folds: 0, oosScore: lib.validation.oosScore, inSampleOnly: false })
    expect(s.banner).toBeNull()
    expect(out.parts.trials).toHaveLength(9)
    expect(out.parts.folds).toBeUndefined()
    expect((out.parts.trials as any[])[0]).toEqual({ params: lib.trials[0]!.params, score: lib.trials[0]!.score, sharpe: lib.trials[0]!.sharpe, trades: lib.trials[0]!.trades }) // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(JSON.stringify(s)).not.toContain('"returns"')
    expect(h.calls.at(-1)![0]).toBeGreaterThan(9)
    expect(h.calls[0]![1]).toBeGreaterThan(9)
  })
  it('walk-forward 600/200：4 折，样本外分数同值，folds 明细带训练 / 测试窗与最优参数', () => {
    const out = computeOptimize({ ...base, validation: { kind: 'walk-forward', trainBars: 600, testBars: 200 } }, hooks())
    const lib = optimize({ strategy: def, candles, space: SPACE as never, search: { kind: 'grid' }, validation: { kind: 'walk-forward', trainBars: 600, testBars: 200 }, seed: 42, sim: SIM })
    const s = out.summary as any // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(s.validation).toMatchObject({ kind: 'walk-forward', folds: 4, oosScore: lib.validation.oosScore })
    expect(out.parts.folds).toHaveLength(4)
    expect((out.parts.folds as any[])[0]).toMatchObject({ index: 0, train: [0, 600], test: [600, 800] }) // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(Object.keys((out.parts.folds as object[])[0]!).sort()).toEqual(['bestParams', 'index', 'test', 'testScore', 'train', 'trainScore'])
  })
  it('固定参数并进策略：不在 space 里的参数取固定值（allowShort=false 与默认 true 的结果不同）', () => {
    const a = computeOptimize({ ...base, validation: { kind: 'holdout', holdoutBars: 300 } }, hooks())
    const b = computeOptimize({ ...base, fixed: { allowShort: false }, validation: { kind: 'holdout', holdoutBars: 300 } }, hooks())
    expect((a.summary as any).best.score).not.toBe((b.summary as any).best.score) // eslint-disable-line @typescript-eslint/no-explicit-any
    const wrapped = withFixedParams(def, { allowShort: false, fast: 7 })
    expect(wrapped.params.find((p) => p.key === 'allowShort')!.default).toBe(false)
    expect(wrapped.params.find((p) => p.key === 'fast')!.default).toBe(7)
    expect(def.params.find((p) => p.key === 'fast')!.default).not.toBe(7)
  })
})

describe('computeFactors：Newey-West t 值', () => {
  it('h=11 w=60：口径写进摘要，MIN60 的 t 在稳健量级（旧口径 98.39），明细按 |ic| 降序且数量 = 目录条数', () => {
    const out = computeFactors({ kind: 'factor_report', candles, horizon: 11, window: 60, quantiles: 5, top: 20 }, hooks())
    const s = out.summary as any // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(s).toMatchObject({ tMethod: 'newey-west', tLags: 69, horizon: 11, window: 60 })
    const items = out.parts.factors as any[] // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(items).toHaveLength(s.catalogSize)
    const ics = items.map((x) => (x.ic === null ? -1 : Math.abs(x.ic)))
    expect(ics).toEqual([...ics].sort((x, y) => y - x))
    const min60 = items.find((x) => x.factorId === 'min_n' && x.period === 60)
    expect(Math.abs(min60.tStat)).toBeGreaterThan(5)
    expect(Math.abs(min60.tStat)).toBeLessThan(98.39 / 3)
    expect(min60).toMatchObject({ tMethod: 'newey-west', tLags: 69 })
    expect(Object.keys(min60).sort()).toEqual(['factorId', 'ic', 'ir', 'monotonicity', 'nEff', 'period', 'positiveShare', 'spread', 'tLags', 'tMethod', 'tStat'])
    expect(Buffer.byteLength(JSON.stringify(s))).toBeLessThan(8000)
  })
})

describe('createResearchProvider（同线程分支，无 workerUrl）', () => {
  it('compute 异步返回与 computeOptimize 相同的结果；取消后 reject', async () => {
    const p = createResearchProvider()
    const input = { kind: 'optimize' as const, strategy: { def, params: {} }, candles, sim: SIM, space: SPACE, search: { kind: 'grid' }, validation: { kind: 'holdout', holdoutBars: 300 }, seed: 42, metric: 'sharpe' }
    const out = await p.compute(input, hooks()).done
    expect((out.summary as any).best.params).toEqual({ fast: 15, slow: 20 }) // eslint-disable-line @typescript-eslint/no-explicit-any
    const h = p.compute(input, hooks())
    h.cancel()
    await expect(h.done).rejects.toThrow(/cancelled/)
    expect(p.checkOptimize({ kind: 'optimize', space: SPACE, search: { kind: 'grid' }, validation: { kind: 'holdout', holdoutBars: 300 }, metric: 'sharpe', strategyParamKeys: ['fast', 'slow'] })).toEqual({ total: 9 })
  })
})
