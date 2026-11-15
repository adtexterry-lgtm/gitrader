// SPDX-License-Identifier: CPAL-1.0
// 种子复现：同 seed 逐点相同，换 seed 序列不同；网格不用随机数，seed 记 0。
import { describe, expect, it } from 'vitest'
import { optimize, type OptimizeRequest } from '../src/optimize'
import { canonicalKey } from '../src/space'
import { bars, simOptions, smaCross, smaSpace } from './fixtures'

function request(overrides: Partial<OptimizeRequest> = {}): OptimizeRequest {
  return {
    strategy: smaCross,
    candles: bars(200),
    space: smaSpace,
    search: { kind: 'evolution', population: 6, generations: 2 },
    validation: { kind: 'holdout', holdoutBars: 40 },
    seed: 77,
    sim: simOptions,
    ...overrides,
  }
}

// 指纹刻意不含 result.seed：只比对「跑了哪些组合、分数多少」，否则「种子没被搜索用上」这种错误会被 seed 字段掩盖。
function fingerprint(result: ReturnType<typeof optimize>): string {
  return JSON.stringify({
    trials: result.trials.map((trial) => [canonicalKey(trial.params), trial.score]),
    best: result.best,
    pbo: result.overfit.pbo,
    dsr: result.overfit.dsr,
    trialVariance: result.overfit.trialVariance,
    oos: result.validation.oosReturns,
  })
}

describe('种子复现', () => {
  it('进化搜索：同一 seed 的全部试验、最优、PBO/DSR、样本外收益逐位相同', () => {
    const first = optimize(request())
    const second = optimize(request())
    expect(fingerprint(first)).toBe(fingerprint(second))
    expect(first.trialCount).toBeGreaterThan(0)
  })

  it('进化搜索：换 seed 后试验序列不同（说明种子真的在用）', () => {
    const a = optimize(request({ seed: 77 }))
    const b = optimize(request({ seed: 78 }))
    expect(fingerprint(a)).not.toBe(fingerprint(b))
  })

  it('随机搜索：换 seed 后试验序列不同（种子真的进了抽样）', () => {
    const first = optimize(request({ search: { kind: 'random', trials: 12 }, seed: 77 }))
    const second = optimize(request({ search: { kind: 'random', trials: 12 }, seed: 78 }))
    expect(fingerprint(first)).not.toBe(fingerprint(second))
  })

  it('随机搜索：同一 seed 逐点复现，试验顺序也一致', () => {
    const plan = { search: { kind: 'random', trials: 12 } } as const
    const first = optimize(request(plan))
    const second = optimize(request(plan))
    expect(fingerprint(first)).toBe(fingerprint(second))
    expect(first.seed).toBe(77)
  })

  it('网格搜索不用随机数：结果里 seed 记 0，两次完全一致', () => {
    const first = optimize(request({ search: { kind: 'grid' }, seed: 999 }))
    const second = optimize(request({ search: { kind: 'grid' }, seed: 1 }))
    expect(first.seed).toBe(0)
    expect(second.seed).toBe(0)
    expect(fingerprint(first)).toBe(fingerprint(second))
  })

  it('不传 seed 时用缺省 42，并在结果里写明', () => {
    const result = optimize(request({ seed: undefined }))
    expect(result.seed).toBe(42)
  })
})
