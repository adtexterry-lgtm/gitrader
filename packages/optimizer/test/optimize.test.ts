// SPDX-License-Identifier: CPAL-1.0
// 端到端：三种搜索跑在 engine-core 真实回测上，强制过拟合指标与样本外验证都在。
import { describe, expect, it } from 'vitest'
import { IN_SAMPLE_BANNER, optimize, type OptimizeRequest } from '../src/optimize'
import { canonicalKey } from '../src/space'
import { bars, simOptions, smaCross, smaSpace } from './fixtures'

function request(overrides: Partial<OptimizeRequest> = {}): OptimizeRequest {
  return {
    strategy: smaCross,
    candles: bars(200),
    space: smaSpace,
    search: { kind: 'grid' },
    validation: { kind: 'walk-forward', trainBars: 100, testBars: 40, step: 40 },
    seed: 13,
    sim: simOptions,
    ...overrides,
  }
}

describe('optimize · 强制项', () => {
  it('没有 validation 直接抛 TypeError（不接受只跑样本内）', () => {
    const bad = { ...request(), validation: undefined } as unknown as OptimizeRequest
    expect(() => optimize(bad)).toThrowError(/validation is required/)
  })

  it('K 线不足 2 根、参数空间非法都抛错', () => {
    expect(() => optimize(request({ candles: bars(1) }))).toThrowError(RangeError)
    expect(() => optimize(request({ space: {} }))).toThrowError(TypeError)
  })

  it('每次寻优都返回试验次数、PBO、DSR（或写明缺口），不因调用方没要求就省掉', () => {
    const result = optimize(request())
    expect(result.trialCount).toBeGreaterThan(0)
    expect(result.overfit.trials).toBe(result.trialCount)
    expect(result.overfit.pbo).not.toBeNull()
    expect(result.overfit.dsr).not.toBeNull()
    expect(result.overfit.pbo!).toBeGreaterThanOrEqual(0)
    expect(result.overfit.pbo!).toBeLessThanOrEqual(1)
    expect(result.overfit.dsr!).toBeGreaterThanOrEqual(0)
    expect(result.overfit.dsr!).toBeLessThanOrEqual(1)
    expect(result.trials.every((trial) => trial.returns.length === result.overfit.periods)).toBe(true)
  })
})

describe('optimize · 三种搜索都跑在回测上', () => {
  it('网格：24 个组合全跑，最优来自真实回测，样本外证据存在', () => {
    const result = optimize(request())
    expect(result.searchKind).toBe('grid')
    expect(result.trialCount).toBe(24)
    expect(new Set(result.trials.map((trial) => canonicalKey(trial.params))).size).toBe(24)
    expect(result.best).not.toBeNull()
    expect(result.validation.kind).toBe('walk-forward')
    expect(result.validation.folds.length).toBe(2)
    // 每折 40 根 K 线 → 权益序列 40 点 → 39 期收益（一期一根，首根无前值）
    expect(result.validation.oosReturns.length).toBe(78)
    expect(result.inSampleOnly).toBe(false)
    expect(result.banner).toBeNull()
  })

  it('随机：试验数等于请求值，种子记进结果', () => {
    const result = optimize(request({ search: { kind: 'random', trials: 10 }, seed: 29 }))
    expect(result.searchKind).toBe('random')
    expect(result.trialCount).toBe(10)
    expect(result.seed).toBe(29)
    expect(result.overfit.trials).toBe(10)
  })

  it('进化：逐代记录最优分数，总评估不超过 population × generations', () => {
    const result = optimize(request({ search: { kind: 'evolution', population: 8, generations: 3 }, seed: 4 }))
    expect(result.searchKind).toBe('evolution')
    expect(result.bestPerGeneration.length).toBe(3)
    expect(result.trialCount).toBeLessThanOrEqual(24)
    expect(result.best).not.toBeNull()
  })

  it('留出期：寻优只用样本内，留出期收益长度 = 留出根数 - 1', () => {
    const result = optimize(request({ validation: { kind: 'holdout', holdoutBars: 50 } }))
    expect(result.validation.holdout?.sample).toEqual([0, 150])
    expect(result.validation.holdout?.holdout).toEqual([150, 200])
    expect(result.validation.oosReturns.length).toBe(49)
    expect(result.inSampleOnly).toBe(false)
    expect(result.banner).toBeNull()
  })

  it('凑不出 walk-forward 窗口时标样本内并挂横幅', () => {
    const result = optimize(request({ validation: { kind: 'walk-forward', trainBars: 180, testBars: 40 } }))
    expect(result.validation.folds).toEqual([])
    expect(result.inSampleOnly).toBe(true)
    expect(result.banner).toBe(IN_SAMPLE_BANNER)
    expect(result.warnings.join('')).toContain('样本内')
  })
})

describe('optimize · 寻优区间（留出期与盲段不参与）', () => {
  it('holdout 40：searchRange [0, 160)，PBO/DSR 用 159 期，best 与留出期验证的最优参数一致', () => {
    const result = optimize(request({ validation: { kind: 'holdout', holdoutBars: 40 } }))
    expect(result.searchRange).toEqual([0, 160])
    expect(result.overfit.periods).toBe(159)
    expect(result.trials.every((trial) => trial.returns.length === 159)).toBe(true)
    expect(result.best).not.toBeNull()
    expect(result.validation.holdout).not.toBeNull()
    expect(result.best!.params).toEqual(result.validation.holdout!.bestParams)
  })

  it('walk-forward blindHoldoutBars 20：searchRange [0, 180)，PBO/DSR 用 179 期', () => {
    const result = optimize(request({
      validation: { kind: 'walk-forward', trainBars: 100, testBars: 40, step: 40, blindHoldoutBars: 20 },
    }))
    expect(result.searchRange).toEqual([0, 180])
    expect(result.overfit.periods).toBe(179)
    expect(result.trials.every((trial) => trial.returns.length === 179)).toBe(true)
  })

  it('重复抽取不计入试验次数：2 个取值的空间请求 10 次，trials 仍等于唯一组合数', () => {
    const result = optimize(request({
      space: { allowShort: { type: 'boolean' } },
      search: { kind: 'random', trials: 10 },
      validation: { kind: 'holdout', holdoutBars: 40 },
    }))
    expect(result.duplicatesSkipped).toBeGreaterThan(0)
    expect(result.trialCount).toBe(2)
    expect(result.overfit.trials).toBe(2)
    expect(result.overfit.trials).toBe(result.trialCount)
  })
})
