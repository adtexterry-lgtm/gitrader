// SPDX-License-Identifier: CPAL-1.0
// 仓位保护：参数归一、跳空成交、盘中优先级、移动止损、时限、空头镜像、无配置。
import { describe, expect, it } from 'vitest'
import {
  evaluateProtection,
  normalizeProtection,
  openProtection,
  type ProtectionConfig,
} from '../src/strategy/protection'

const bar = (index: number, o: number, h: number, l: number, c: number) => ({ index, o, h, l, c, v: 0 })

describe('normalizeProtection', () => {
  it('归一百分数、字符串、trailing 平铺字段与小数', () => {
    // QD 的 _ratio 用「绝对值是否 > 1」区分两种写法：2 → 0.02，0.02 原样保留；
    // 边界收紧到 ≥ 1，所以 trailingTrailPct: 1 → 0.01。
    expect(
      normalizeProtection({
        stopLossPct: 2,
        takeProfitPct: '5%',
        trailingActivationPct: 3,
        trailingTrailPct: 1,
        maxHoldBars: 10,
      }),
    ).toEqual({
      stopLossPct: 0.02,
      takeProfitPct: 0.05,
      trailing: { activationPct: 0.03, trailPct: 0.01 },
      maxHoldBars: 10,
    })
    expect(normalizeProtection({ stopLossPct: 0.02 }).stopLossPct).toBe(0.02)
    expect(normalizeProtection({ trailing: { activationPct: 3, trailPct: 1 } }).trailing).toEqual({
      activationPct: 0.03,
      trailPct: 0.01,
    })
    expect(normalizeProtection({})).toEqual({})
  })

  it('非法值抛 RangeError 且消息含字段名', () => {
    expect(() => normalizeProtection({ stopLossPct: -1 })).toThrow(RangeError)
    expect(() => normalizeProtection({ stopLossPct: -1 })).toThrow(/stopLossPct/)
    expect(() => normalizeProtection({ takeProfitPct: 'abc' })).toThrow(/takeProfitPct/)
    expect(() => normalizeProtection({ maxHoldBars: -2 })).toThrow(/maxHoldBars/)
  })
})

describe('evaluateProtection', () => {
  it('多头止损：盘中按触发价，跳空按开盘价', () => {
    const state = openProtection('long', 100, 0)
    const cfg: ProtectionConfig = { stopLossPct: 0.02 }

    const touched = evaluateProtection(state, bar(0, 99.5, 100, 97, 98), cfg)
    expect(touched.exit).toEqual({ reason: 'stop_loss', price: 98 })

    const gapped = evaluateProtection(state, bar(0, 95, 96, 94, 95), cfg)
    expect(gapped.exit).toEqual({ reason: 'stop_loss', price: 95 })
  })

  it('多头止盈：盘中按触发价成交', () => {
    const state = openProtection('long', 100, 0)
    const out = evaluateProtection(state, bar(0, 101, 106, 100, 104), { takeProfitPct: 0.05 })
    expect(out.exit).toEqual({ reason: 'take_profit', price: 105 })
  })

  it('同根同时触及止损与止盈时按 QD 优先级取止损', () => {
    const state = openProtection('long', 100, 0)
    const out = evaluateProtection(state, bar(0, 100, 106, 97, 100), { stopLossPct: 0.02, takeProfitPct: 0.05 })
    expect(out.exit).toEqual({ reason: 'stop_loss', price: 98 })
  })

  it('移动止损：先激活再按最高价回撤触发', () => {
    const cfg: ProtectionConfig = { trailing: { activationPct: 0.03, trailPct: 0.01 } }
    const first = evaluateProtection(openProtection('long', 100, 0), bar(0, 100, 104, 100, 104), cfg)
    expect(first.exit).toBeNull()
    expect(first.state.trailingArmed).toBe(true)
    expect(first.state.highestSinceEntry).toBe(104)

    const second = evaluateProtection(first.state, bar(1, 104, 104, 102.9, 103), cfg)
    expect(second.exit?.reason).toBe('trailing_stop')
    expect(second.exit?.price).toBeCloseTo(104 * 0.99, 10)

    const idle = evaluateProtection(openProtection('long', 100, 0), bar(0, 100, 102, 100, 102), cfg)
    expect(idle.exit).toBeNull()
    expect(idle.state.trailingArmed).toBe(false)
    const shallow = evaluateProtection(idle.state, bar(1, 101, 102, 100, 101), cfg)
    expect(shallow.exit).toBeNull()
  })

  it('时限：持仓满 maxHoldBars 根后按收盘价出场', () => {
    const cfg: ProtectionConfig = { maxHoldBars: 3 }
    const state = openProtection('long', 100, 10)
    expect(evaluateProtection(state, bar(12, 100, 101, 99, 100), cfg).exit).toBeNull()
    expect(evaluateProtection(state, bar(13, 100, 101, 99, 100.5), cfg).exit).toEqual({
      reason: 'time_limit',
      price: 100.5,
    })
  })

  it('空头镜像：止损与止盈方向相反', () => {
    const state = openProtection('short', 100, 0)
    expect(evaluateProtection(state, bar(0, 101, 102.5, 100.5, 102), { stopLossPct: 0.02 }).exit).toEqual({
      reason: 'stop_loss',
      price: 102,
    })
    expect(evaluateProtection(state, bar(0, 96, 96.5, 94.9, 95.2), { takeProfitPct: 0.05 }).exit).toEqual({
      reason: 'take_profit',
      price: 95,
    })
  })

  it('无配置：永不出场，最高 / 最低照常更新', () => {
    const cfg = normalizeProtection({})
    const first = evaluateProtection(openProtection('long', 100, 0), bar(0, 100, 105, 95, 101), cfg)
    expect(first.exit).toBeNull()
    expect(first.state.highestSinceEntry).toBe(105)
    expect(first.state.lowestSinceEntry).toBe(95)
    const second = evaluateProtection(first.state, bar(1, 101, 103, 93, 94), cfg)
    expect(second.exit).toBeNull()
    expect(second.state.highestSinceEntry).toBe(105)
    expect(second.state.lowestSinceEntry).toBe(93)
  })
})
