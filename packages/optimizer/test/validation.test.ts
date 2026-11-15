// SPDX-License-Identifier: CPAL-1.0
// 强制验证：窗口切法、embargo / 盲留出、walk-forward 与留出期的样本外语义、凑不出窗口时的样本内标记。
import { describe, expect, it } from 'vitest'
import { sharpeMetric } from '../src/evaluate'
import { runValidation, walkForwardWindows, type ValidationPlan } from '../src/validation'
import { bars } from './fixtures'

describe('walkForwardWindows', () => {
  it('测试窗紧接训练窗，embargo 与盲留出段都不许被碰', () => {
    const windows = walkForwardWindows(240, 100, 40, 40, { embargoBars: 2, blindHoldoutBars: 20 })
    expect(windows.length).toBe(2)
    expect(windows[0]?.train).toEqual([0, 100])
    expect(windows[0]?.test).toEqual([102, 142])
    expect(windows[1]?.train).toEqual([40, 140])
    expect(windows[1]?.test).toEqual([142, 182])
    for (const window of windows) {
      expect(window.test[1]).toBeLessThanOrEqual(240 - 20)
      expect(window.embargo).toBe(2)
    }
  })

  it('训练 + 测试超过序列长度时一个窗口都不给', () => {
    expect(walkForwardWindows(100, 80, 40)).toEqual([])
    expect(walkForwardWindows(100, 0, 40)).toEqual([])
    expect(walkForwardWindows(100, 10, 10, 0)).toEqual([])
  })

  it('step 大于 testBars 时窗口之间留空隙，位置仍确定', () => {
    const windows = walkForwardWindows(120, 40, 20, 40)
    expect(windows.map((window) => window.test)).toEqual([
      [40, 60],
      [80, 100],
    ])
  })
})

describe('runValidation · walk-forward', () => {
  const context = (n: number) => ({
    candles: bars(n),
    seed: 3,
    metric: sharpeMetric,
    optimizeSlice: () => ({ best: { params: { fast: 4, slow: 20 } }, trials: 7 }),
    evaluate: (slice: readonly { c: number }[]) => ({ score: 1.5, returns: slice.map(() => 0.001) }),
  })

  it('每折只在训练窗寻优，测试窗与训练窗不重叠，样本外收益按折拼接', () => {
    const outcome = runValidation({ kind: 'walk-forward', trainBars: 100, testBars: 40, embargoBars: 2 }, context(240))
    expect(outcome.kind).toBe('walk-forward')
    expect(outcome.folds.length).toBe(3)
    for (const fold of outcome.folds) {
      expect(fold.test[0]).toBeGreaterThanOrEqual(fold.train[1] + fold.embargo)
      expect(fold.trainTrials).toBe(7)
      expect(fold.testReturns.length).toBe(40)
      expect(fold.bestParams).toEqual({ fast: 4, slow: 20 })
    }
    expect(outcome.oosReturns.length).toBe(120)
    expect(outcome.inSampleOnly).toBe(false)
    expect(outcome.efficiency).toBeCloseTo(1, 12)
  })

  it('凑不出窗口时标样本内、带提示，不伪造样本外收益', () => {
    const outcome = runValidation({ kind: 'walk-forward', trainBars: 200, testBars: 100 }, context(240))
    expect(outcome.folds).toEqual([])
    expect(outcome.oosReturns).toEqual([])
    expect(outcome.inSampleOnly).toBe(true)
    expect(outcome.warnings.length).toBe(1)
  })

  it('非法窗口参数抛 RangeError', () => {
    const ctx = context(240)
    expect(() => runValidation({ kind: 'walk-forward', trainBars: 1, testBars: 40 }, ctx)).toThrowError(RangeError)
    expect(() => runValidation({ kind: 'walk-forward', trainBars: 100, testBars: 40, step: 0 }, ctx)).toThrowError(RangeError)
    expect(() => runValidation({ kind: 'walk-forward', trainBars: 100, testBars: 40, blindHoldoutBars: 240 }, ctx)).toThrowError(RangeError)
  })

  it('未知 kind 抛 TypeError，不落进留出期分支报 holdoutBars', () => {
    const bogus = { kind: 'bogus' } as unknown as ValidationPlan
    expect(() => runValidation(bogus, context(240))).toThrowError(TypeError)
    expect(() => runValidation(bogus, context(240))).toThrowError(/unknown validation kind: bogus/)
  })
})

describe('runValidation · holdout', () => {
  it('留出期不参与寻优，收益长度 = 留出根数 - 1', () => {
    const ctx = {
      candles: bars(200),
      seed: 5,
      metric: sharpeMetric,
      optimizeSlice: () => ({ best: { params: { fast: 6, slow: 30 } }, trials: 9 }),
      evaluate: (slice: readonly { c: number }[]) => ({ score: 0.25, returns: new Array(Math.max(0, slice.length - 1)).fill(0.0005) }),
    }
    const outcome = runValidation({ kind: 'holdout', holdoutBars: 50 }, ctx)
    expect(outcome.kind).toBe('holdout')
    expect(outcome.holdout?.sample).toEqual([0, 150])
    expect(outcome.holdout?.holdout).toEqual([150, 200])
    expect(outcome.oosReturns.length).toBe(49)
    expect(outcome.inSampleOnly).toBe(false)
    expect(outcome.folds).toEqual([])
  })

  it('留出期太小或大到没剩样本内都抛 RangeError', () => {
    const ctx = {
      candles: bars(60),
      seed: 5,
      metric: sharpeMetric,
      optimizeSlice: () => ({ best: null, trials: 0 }),
      evaluate: () => ({ score: 0, returns: [] }),
    }
    expect(() => runValidation({ kind: 'holdout', holdoutBars: 1 }, ctx)).toThrowError(RangeError)
    expect(() => runValidation({ kind: 'holdout', holdoutBars: 59 }, ctx)).toThrowError(RangeError)
  })
})
