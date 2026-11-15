// SPDX-License-Identifier: CPAL-1.0
// 蒙特卡洛成交盈亏重排 / 重抽样的路径分布。
import { describe, expect, it } from 'vitest'
import { monteCarloTrades } from '../src/strategy/monte-carlo'

describe('monteCarloTrades', () => {
  it('全盈利序列终值恒定、无回撤', () => {
    const r = monteCarloTrades([1, 1, 1], { paths: 50 })
    expect(r.finalQuantiles).toEqual({ q05: 3, q25: 3, q50: 3, q75: 3, q95: 3 })
    expect(r.maxDrawdownQuantiles).toEqual({ q05: 0, q25: 0, q50: 0, q75: 0, q95: 0 })
    expect(r.lossShare).toBe(0)
    expect(r.originalFinal).toBe(3)
    expect(r.originalMaxDrawdown).toBe(0)
  })

  it('全亏损序列终值 −2、最大回撤 2、亏损占比 1', () => {
    const r = monteCarloTrades([-1, -1])
    expect(r.finalQuantiles).toEqual({ q05: -2, q25: -2, q50: -2, q75: -2, q95: -2 })
    expect(r.maxDrawdownQuantiles).toEqual({ q05: 2, q25: 2, q50: 2, q75: 2, q95: 2 })
    expect(r.lossShare).toBe(1)
    expect(r.originalFinal).toBe(-2)
    expect(r.originalMaxDrawdown).toBe(2)
  })

  it('permute 下终值等于原序列之和，回撤落在排列边界内', () => {
    const r = monteCarloTrades([2, -1, 2, -1], { mode: 'permute', paths: 200 })
    expect(r.finalQuantiles.q05).toBe(2)
    expect(r.finalQuantiles.q95).toBe(2)
    expect(r.maxDrawdownQuantiles.q95).toBeLessThanOrEqual(2)
    expect(r.maxDrawdownQuantiles.q05).toBeGreaterThanOrEqual(1)
    expect(r.originalMaxDrawdown).toBe(1)
  })

  it('bootstrap 下终值分布不再恒定', () => {
    const r = monteCarloTrades([2, -1, 2, -1], { mode: 'bootstrap', paths: 400, seed: 7 })
    expect(r.finalQuantiles.q05).toBeLessThan(r.finalQuantiles.q95)
    expect(r.finalQuantiles.q50).toBeGreaterThanOrEqual(0)
    expect(r.finalQuantiles.q50).toBeLessThanOrEqual(4)
  })

  it('initialCash 下回撤按比例、ruinDrawdown 统计触及比例', () => {
    const r = monteCarloTrades([10, -20, 10], { initialCash: 100 })
    expect(r.originalMaxDrawdown).toBeCloseTo(20 / 110)
    expect(r.originalFinal).toBe(100)

    const ruin01 = monteCarloTrades([10, -20, 10], { initialCash: 100, ruinDrawdown: 0.1 })
    expect(ruin01.ruinShare).toBe(1)

    const ruin05 = monteCarloTrades([10, -20, 10], { initialCash: 100, ruinDrawdown: 0.5 })
    expect(ruin05.ruinShare).toBe(0)
  })

  it('同 seed 可复现，不同 seed 结果不同', () => {
    const opts = { mode: 'bootstrap' as const, paths: 100, seed: 1 }
    const a = monteCarloTrades([2, -1, 3, -4, 5], opts)
    const b = monteCarloTrades([2, -1, 3, -4, 5], opts)
    expect(a).toEqual(b)

    const c = monteCarloTrades([2, -1, 3, -4, 5], { ...opts, seed: 2 })
    expect(c).not.toEqual(a)
  })

  it('空数组与含 NaN 的输入', () => {
    const empty = monteCarloTrades([])
    expect(empty.paths).toBe(1000)
    expect(empty.finalQuantiles.q50).toBe(0)
    expect(monteCarloTrades([], { paths: 7 }).paths).toBe(7)
    expect(monteCarloTrades([NaN, 1])).toEqual(monteCarloTrades([1]))
  })
})
