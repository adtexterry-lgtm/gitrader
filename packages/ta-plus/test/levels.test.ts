// SPDX-License-Identifier: CPAL-1.0
// 价位估计参照：QuantDinger backend_api_python/app/services/market/technical_indicators.py:106-152（Apache-2.0）。
// 期望值经收口代理 2026-10-22 用 Python Fraction 按定义独立重算一致（重算脚本不入库）；
// 夹具为 21 根：c = 100 + (i mod 7)，h = c+1，l = c−1：
//   上一根 (i=19) 为 105/106/104 → pivot = (106+104+105)/3 = 105，r1 = 106，s1 = 104，r2 = 107，s2 = 103
//   近 20 根 swingHigh = 107、swingLow = 99；布林 (20,2) 的上下轨见下；
//   support = (s1 + swingLow + bbLower)/3，resistance = (r1 + swingHigh + bbUpper)/3。
// 手算 support = (104 + 99 + 99.288653084738)/3 = 100.762884361…

import { describe, expect, it } from 'vitest'
import { levels } from '../src/index'
import { levelBars } from './fixtures-t1b'

describe('支撑 / 阻力（QD 定义式）', () => {
  it('levels 的枢轴与 R1/S1/R2/S2 就是上一根的经典枢轴价', () => {
    const out = levels(levelBars())
    expect(out.pivot).toBeCloseTo(105, 12)
    expect(out.r1).toBeCloseTo(106, 12)
    expect(out.s1).toBeCloseTo(104, 12)
    expect(out.r2).toBeCloseTo(107, 12)
    expect(out.s2).toBeCloseTo(103, 12)
  })

  it('levels 的摆动高低点取近 period 根的极值', () => {
    const out = levels(levelBars())
    expect(out.swingHigh).toBeCloseTo(107, 12)
    expect(out.swingLow).toBeCloseTo(99, 12)
  })

  it('levels 的布林轨用总体标准差（÷period，不是 ÷(period−1)）', () => {
    const out = levels(levelBars())
    expect(out.bbUpper).toBeCloseTo(107.011346915262, 10)
    expect(out.bbLower).toBeCloseTo(99.288653084738, 10)
    // 轨道关于窗口均值对称（均值在此独立算一遍）
    const closes = levelBars().map((bar) => bar.c)
    const middle = closes.slice(-20).reduce((a, b) => a + b, 0) / 20
    expect(out.bbUpper - middle).toBeCloseTo(middle - out.bbLower, 10)
  })

  it('support / resistance 是三路均值（手算 100.762884… / 106.670449…）', () => {
    const out = levels(levelBars())
    expect(out.support).toBeCloseTo(100.762884361579, 10)
    expect(out.resistance).toBeCloseTo(106.670448971754, 10)
    expect(out.support).toBeLessThan(out.pivot)
    expect(out.resistance).toBeGreaterThan(out.pivot)
  })

  it('levels 明确标注为估计值（method / isEstimate），不冒充观测值', () => {
    const out = levels(levelBars())
    expect(out.method).toBe('pivot_swing_bb_avg')
    expect(out.isEstimate).toBe(true)
  })

  it('K 线不足 period+1 根抛 RangeError；multiplier ≤ 0 抛 RangeError', () => {
    expect(() => levels(levelBars(20), { period: 20 })).toThrow(RangeError)
    expect(() => levels(levelBars(), { multiplier: 0 })).toThrow(RangeError)
    expect(() => levels(levelBars(), { multiplier: -1 })).toThrow(RangeError)
    expect(() => levels(levelBars(), { period: 0 })).toThrow(RangeError)
  })
})
