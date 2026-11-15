// SPDX-License-Identifier: CPAL-1.0
// 三种搜索：网格的确定性与预算闸门、随机 / 进化的种子复现、进化确实在改进。
import { describe, expect, it } from 'vitest'
import { evolutionSearch, gridSearch, randomSearch } from '../src/search'
import { canonicalKey, type ParamSpace } from '../src/space'
import { quadObjective, quadSpace } from './fixtures'

describe('gridSearch', () => {
  it('按字典序枚举，第一维最慢', () => {
    const space: ParamSpace = { a: { type: 'select', options: ['x', 'y'] }, b: { type: 'integer', min: 1, max: 2, step: 1 } }
    const outcome = gridSearch({ space, objective: () => 0 })
    expect(outcome.evaluated.map((point) => `${point.params.a}${point.params.b}`)).toEqual(['x1', 'x2', 'y1', 'y2'])
    expect(outcome.seed).toBe(0)
    expect(outcome.kind).toBe('grid')
  })

  it('组合数超过 maxTrials 抛 RangeError（不偷偷抽样）', () => {
    expect(() => gridSearch({ space: quadSpace, objective: () => 0, maxTrials: 10 })).toThrowError(/grid has 66 trials/)
  })

  it('能精确找到纯目标的全局最优 (x=3, y=2)，分数 0', () => {
    const outcome = gridSearch({ space: quadSpace, objective: quadObjective })
    expect(outcome.best).not.toBeNull()
    expect(outcome.best?.params).toEqual({ x: 3, y: 2 })
    expect(outcome.best?.score).toBeCloseTo(0, 12)
    expect(outcome.evaluated.length).toBe(66)
  })

  it('目标函数返回非有限分数时抛错，不把 NaN 当最差', () => {
    expect(() => gridSearch({ space: quadSpace, objective: () => Number.NaN })).toThrowError(/non-finite/)
  })
})

describe('randomSearch', () => {
  it('同一 seed 逐点复现（参数与分数全等）', () => {
    const a = randomSearch({ space: quadSpace, objective: quadObjective, trials: 12, seed: 7 })
    const b = randomSearch({ space: quadSpace, objective: quadObjective, trials: 12, seed: 7 })
    expect(a.evaluated).toEqual(b.evaluated)
    expect(a.seed).toBe(7)
  })

  it('不同 seed 抽到不同序列', () => {
    const a = randomSearch({ space: quadSpace, objective: quadObjective, trials: 12, seed: 7 })
    const b = randomSearch({ space: quadSpace, objective: quadObjective, trials: 12, seed: 8 })
    expect(a.evaluated).not.toEqual(b.evaluated)
  })

  it('评估点数等于 trials，且没有重复组合', () => {
    const outcome = randomSearch({ space: quadSpace, objective: quadObjective, trials: 15, seed: 3 })
    expect(outcome.evaluated.length).toBe(15)
    const keys = new Set(outcome.evaluated.map((point) => canonicalKey(point.params)))
    expect(keys.size).toBe(15)
  })

  it('抽到的点都在合法域内（数值贴网格、布尔合法）', () => {
    const outcome = randomSearch({ space: quadSpace, objective: quadObjective, trials: 20, seed: 11 })
    for (const point of outcome.evaluated) {
      const x = point.params.x
      const y = point.params.y
      expect(typeof x).toBe('number')
      expect(Number.isInteger(x)).toBe(true)
      expect(Number.isInteger(y)).toBe(true)
      expect(Number(x)).toBeGreaterThanOrEqual(0)
      expect(Number(x)).toBeLessThanOrEqual(10)
      expect(Number(y)).toBeGreaterThanOrEqual(0)
      expect(Number(y)).toBeLessThanOrEqual(5)
    }
  })

  it('trials 非法时抛 RangeError', () => {
    expect(() => randomSearch({ space: quadSpace, objective: () => 0, trials: 0 })).toThrowError(RangeError)
  })
})

describe('evolutionSearch', () => {
  it('每代最优分数不下降，最后收敛到最优点附近', () => {
    const outcome = evolutionSearch({ space: quadSpace, objective: quadObjective, population: 12, generations: 6, seed: 5 })
    expect(outcome.bestPerGeneration.length).toBe(6)
    for (let i = 1; i < outcome.bestPerGeneration.length; i++) {
      expect(outcome.bestPerGeneration[i]!).toBeGreaterThanOrEqual(outcome.bestPerGeneration[i - 1]!)
    }
    expect(outcome.best).not.toBeNull()
    expect(Math.abs(Number(outcome.best?.params.x) - 3)).toBeLessThanOrEqual(1)
    expect(Math.abs(Number(outcome.best?.params.y) - 2)).toBeLessThanOrEqual(1)
  })

  it('同一 seed 逐点复现，不同 seed 轨迹不同', () => {
    const a = evolutionSearch({ space: quadSpace, objective: quadObjective, population: 10, generations: 4, seed: 21 })
    const b = evolutionSearch({ space: quadSpace, objective: quadObjective, population: 10, generations: 4, seed: 21 })
    const c = evolutionSearch({ space: quadSpace, objective: quadObjective, population: 10, generations: 4, seed: 22 })
    expect(a.evaluated).toEqual(b.evaluated)
    expect(a.bestPerGeneration).toEqual(b.bestPerGeneration)
    expect(a.evaluated).not.toEqual(c.evaluated)
  })

  it('elite 越界、tournament 过大、mutationRate 越界都抛 RangeError', () => {
    const base = { space: quadSpace, objective: () => 0, population: 8, generations: 2 }
    expect(() => evolutionSearch({ ...base, elite: 8 })).toThrowError(RangeError)
    expect(() => evolutionSearch({ ...base, tournament: 9 })).toThrowError(RangeError)
    expect(() => evolutionSearch({ ...base, mutationRate: 1.5 })).toThrowError(RangeError)
  })

  it('评估预算不超过 population × generations', () => {
    const outcome = evolutionSearch({ space: quadSpace, objective: quadObjective, population: 8, generations: 3, seed: 9 })
    expect(outcome.evaluated.length).toBeLessThanOrEqual(24)
    expect(outcome.generations).toBe(3)
  })
})
