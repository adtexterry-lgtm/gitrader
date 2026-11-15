// SPDX-License-Identifier: CPAL-1.0
// 回测证据统计附件：每期收益、Sharpe / PSR / DSR、偏度峰度、循环块自助法区间。
import { describe, expect, it } from 'vitest'
import { dsr, psr, sharpe, skewness } from '@gitrader/stats'
import { periodReturns, summarizeEvidence } from '../src/strategy/evidence'
import { summarizeEvidence as summarizeFromStrategy } from '../src/strategy'

const H = 3_600_000
const D = 86_400_000

const equityA = [
  { t: 0, v: 100 },
  { t: H, v: 110 },
  { t: 2 * H, v: 99 },
  { t: 3 * H, v: 108.9 },
]

describe('periodReturns', () => {
  it('每期简单收益按相邻权益点计算', () => {
    const returns = periodReturns(equityA)
    expect(returns).toHaveLength(3)
    expect(returns[0]).toBeCloseTo(0.1, 10)
    expect(returns[1]).toBeCloseTo(-0.1, 10)
    expect(returns[2]).toBeCloseTo(0.1, 10)
  })

  it('跳过前值为零或非有限数的期', () => {
    expect(
      periodReturns([
        { t: 0, v: 100 },
        { t: H, v: 0 },
        { t: 2 * H, v: 50 },
      ]),
    ).toEqual([-1])
  })
})

describe('summarizeEvidence', () => {
  it('用例 A：手工数值与 psr 一致', () => {
    const returns = periodReturns(equityA)
    const summary = summarizeEvidence({ equity: equityA })

    expect(summary.periods).toBe(3)
    expect(summary.periodMs).toBe(H)
    expect(summary.periodsPerYear).toBe(8760)
    expect(summary.sharpe).toBeCloseTo(0.288675, 5)
    expect(summary.sharpeAnnualized).toBeCloseTo(27.019, 2)
    expect(summary.skewness).toBeCloseTo(-0.7071, 3)
    expect(summary.kurtosis).toBeCloseTo(3, 6)
    expect(summary.psr).not.toBeNull()
    expect(summary.psr!).toBeCloseTo(0.6427, 3)
    expect(summary.psr!).toBeCloseTo(
      psr(sharpe(returns), { n: 3, skew: skewness(returns), kurt: summary.kurtosis }),
      10,
    )
    expect(summary.dsr).toBeNull()
    expect(summary.sharpeCi95).toBeNull()
    expect(summary.trialCount).toBe(1)
    expect(summary.warnings).toEqual([])
  })

  it('用例 B：多试验时给出 DSR，且不高于 PSR', () => {
    const returns = periodReturns(equityA)
    const summary = summarizeEvidence({ equity: equityA, trialCount: 10, trialVariance: 0.01 })

    expect(summary.dsr).not.toBeNull()
    expect(summary.dsr!).toBeCloseTo(0.566, 2)
    expect(summary.dsr!).toBeLessThan(summary.psr!)
    expect(summary.dsr!).toBeCloseTo(
      dsr(sharpe(returns), {
        n: 3,
        nTrials: 10,
        trialVariance: 0.01,
        skew: skewness(returns),
        kurt: summary.kurtosis,
      }),
      10,
    )
  })

  it('用例 C：自助法区间包含样本 Sharpe，且由种子决定', () => {
    let v = 100
    const eq: { t: number; v: number }[] = [{ t: 0, v }]
    for (let i = 1; i <= 40; i++) {
      v *= 1 + (i % 2 ? 0.02 : -0.01)
      eq.push({ t: i * D, v })
    }

    const first = summarizeEvidence({ equity: eq })
    expect(first.periods).toBe(40)
    expect(first.periodMs).toBe(D)
    expect(first.periodsPerYear).toBe(365)
    expect(first.sharpe).toBeCloseTo(0.32914, 4)
    expect(first.sharpeAnnualized).toBeCloseTo(6.288, 2)

    const ci = first.sharpeCi95
    expect(ci).not.toBeNull()
    expect(Number.isFinite(ci![0])).toBe(true)
    expect(Number.isFinite(ci![1])).toBe(true)
    expect(ci![0]).toBeLessThan(ci![1])
    expect(ci![0]).toBeLessThanOrEqual(first.sharpe)
    expect(first.sharpe).toBeLessThanOrEqual(ci![1])

    const second = summarizeEvidence({ equity: eq })
    expect(second).toEqual(first)

    const seeded = summarizeEvidence({ equity: eq, seed: 2 })
    expect(seeded.sharpeCi95).not.toEqual(first.sharpeCi95)
  })

  it('用例 D：收益不足两期时退化', () => {
    const summary = summarizeEvidence({ equity: [{ t: 0, v: 100 }] })
    expect(summary.periods).toBe(0)
    expect(summary.sharpe).toBe(0)
    expect(summary.psr).toBeNull()
    expect(summary.dsr).toBeNull()
    expect(summary.sharpeCi95).toBeNull()
    expect(summary.warnings).toEqual(['fewer than 2 returns'])
  })

  it('用例 E：零方差收益的推断量为空并给出提示', () => {
    const equity = [0, 1, 2, 3].map((i) => ({ t: i * H, v: 100 }))
    const summary = summarizeEvidence({ equity })

    expect(summary.sharpe).toBe(0)
    expect(summary.psr).toBeNull()
    expect(summary.warnings.length).toBeGreaterThan(0)
    for (const warning of summary.warnings) expect(warning).toContain(' is not finite')
  })
})

describe('strategy 入口导出', () => {
  it('用例 F：与 evidence 模块导出同一函数', () => {
    expect(summarizeFromStrategy).toBe(summarizeEvidence)
  })
})
