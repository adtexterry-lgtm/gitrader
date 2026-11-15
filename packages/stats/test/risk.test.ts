// SPDX-License-Identifier: CPAL-1.0
// 风险指标手算期望：下行偏差 / Sortino / 回撤恢复 / Calmar / VaR-CVaR。
import { describe, expect, it } from 'vitest'
import { calmar, downsideDeviation, drawdownStats, sortino, varCvar } from '../src/risk'

describe('downside / sortino', () => {
  // r=[0.02,-0.01,0.03,-0.02]: 下行平方和=0.0005, /4 -> sqrt(0.000125)
  const r = [0.02, -0.01, 0.03, -0.02]
  it('下行偏差', () => expect(downsideDeviation(r)).toBeCloseTo(Math.sqrt(0.000125), 12))
  it('sortino = mean/dd，年化乘 sqrt(ppy)', () => {
    const v = 0.005 / Math.sqrt(0.000125)
    expect(sortino(r)!).toBeCloseTo(v, 10)
    expect(sortino(r, { periodsPerYear: 4 })!).toBeCloseTo(v * 2, 10)
  })
  it('mar 生效', () => expect(downsideDeviation([0.01, 0.03], 0.02)).toBeCloseTo(Math.sqrt(0.0001 / 2), 12))
  it('无下行 / 空 -> null', () => {
    expect(sortino([0.01, 0.02])).toBeNull()
    expect(sortino([])).toBeNull()
  })
})

describe('drawdownStats', () => {
  it('回撤并恢复', () => {
    const d = drawdownStats([100, 120, 90, 100, 125])
    expect(d.maxDrawdown).toBeCloseTo(0.25, 12)
    expect([d.peakIndex, d.troughIndex, d.recoveryIndex]).toEqual([1, 2, 4])
    expect([d.durationBars, d.recoveryBars]).toEqual([1, 2])
  })
  it('未恢复 -> null', () => {
    const d = drawdownStats([100, 120, 90, 110])
    expect(d.recoveryIndex).toBeNull()
    expect(d.recoveryBars).toBeNull()
  })
  it('单调上升与空输入回撤 0', () => {
    expect(drawdownStats([1, 2, 3]).maxDrawdown).toBe(0)
    expect(drawdownStats([]).maxDrawdown).toBe(0)
  })
})

describe('calmar', () => {
  it('收益/回撤', () => expect(calmar(0.3, 0.15)).toBeCloseTo(2, 12))
  it('回撤 0 或非数 -> null', () => {
    expect(calmar(0.3, 0)).toBeNull()
    expect(calmar(NaN, 0.1)).toBeNull()
  })
})

describe('varCvar', () => {
  // 20 个收益 -0.10..+0.09 步长 0.01；alpha=0.05: pos=0.95 -> q=-0.10+0.95*0.01=-0.0905
  const rs = Array.from({ length: 20 }, (_, i) => -0.1 + i * 0.01)
  it('历史法', () => {
    const x = varCvar(rs, 0.05)!
    expect(x.var).toBeCloseTo(0.0905, 12)
    expect(x.cvar).toBeCloseTo(0.1, 12) // 尾部仅 -0.10 一个
  })
  it('空或 alpha 越界 -> null', () => {
    expect(varCvar([])).toBeNull()
    expect(varCvar([0.1], 0)).toBeNull()
  })
  it('CVaR >= VaR', () => {
    const x = varCvar([-0.05, -0.02, 0.01, 0.03, -0.08], 0.4)!
    expect(x.cvar).toBeGreaterThanOrEqual(x.var)
  })
})
