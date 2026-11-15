// SPDX-License-Identifier: CPAL-1.0
// GQ-02：回测强平实际强平了却回写 liquidation=false，亏损超过权益时账本不平
import { describe, expect, it } from 'vitest'
import { Simulator } from '../src/strategy/simulator'
import { auditTrades } from '../src/strategy/ledger-audit'
import type { Candle } from '../src/types'

const bar = (t: number, o: number, h: number, l: number, c: number): Candle => ({ t, o, h, l, c, v: 1e9 })

describe('GQ-02 强平封顶', () => {
  it('跌穿破产价：按破产价成交，亏损封顶在保证金，现金精确 0，穿仓单列', () => {
    const sim = new Simulator({ initialCash: 1000, leverage: 10, feeRate: 0, slippageBps: 0, liquidation: true, maintenanceMarginRatio: 0.05 })
    sim.onBar(0, bar(0, 100, 100, 100, 100), 1, 'x')          // 多头 100 @100
    sim.onBar(1, bar(1, 100, 100, 80, 85), 1, 'x')            // 最差价 80 < 破产价 90
    const liq = sim.trades[1]!
    expect(liq.reason).toBe('liquidation')
    expect(liq.price).toBeCloseTo(90, 9)                      // 手算：100 − 1000/100
    expect(liq.pnl).toBeCloseTo(-1000, 9)                     // 亏光保证金，不是 −2000
    expect(liq.fee).toBe(0)
    expect(sim.cash).toBe(0)
    expect(sim.bankrupt).toBe(true)
    expect(sim.shortfall).toBeCloseTo(1000, 9)                // 2000 − 1000
    expect(sim.shortfalls).toHaveLength(1)
    expect(sim.shortfalls[0]!.t).toBe(1)
  })

  it('空头对称：最差价（最高价）涨穿破产价', () => {
    const sim = new Simulator({ initialCash: 1000, leverage: 10, feeRate: 0, slippageBps: 0, liquidation: true, maintenanceMarginRatio: 0.05 })
    sim.onBar(0, bar(0, 100, 100, 100, 100), -1, 'x')         // 空头 100 @100
    sim.onBar(1, bar(1, 100, 120, 100, 115), -1, 'x')         // 最高价 120 > 破产价 110
    expect(sim.trades[1]!.price).toBeCloseTo(110, 9)
    expect(sim.trades[1]!.pnl).toBeCloseTo(-1000, 9)
    expect(sim.cash).toBe(0)
    expect(sim.shortfall).toBeCloseTo(1000, 9)
  })

  it('带手续费与滑点：成交价仍等于手算破产价（±1e-9），自审现金差为 0', () => {
    const sim = new Simulator({ initialCash: 1000, leverage: 10, feeRate: 0.0005, slippageBps: 2, liquidation: true, maintenanceMarginRatio: 0.05 })
    sim.onBar(0, bar(0, 100, 100, 100, 100), 1, 'x')
    const { cash, pos, entry } = sim                          // 平仓前的状态，用来手算
    sim.onBar(1, bar(1, 100, 100, 70, 80), 1, 'x')
    const bankruptcy = entry - cash / pos
    expect(sim.trades[1]!.price).toBeCloseTo(bankruptcy, 9)
    expect(sim.cash).toBe(0)
    const audit = auditTrades(sim.trades, { initialCash: 1000, reportedCash: sim.cash - sim.pos * sim.entry, marks: { default: 80 } })
    expect(Math.abs(audit.cash.mismatch!)).toBeLessThan(1e-6)   // 修前这里是 ~ −数百
  })

  it('反例：未跌穿破产价时按最差价成交，不封顶（旧行为不变）', () => {
    const sim = new Simulator({ initialCash: 1000, leverage: 10, feeRate: 0, slippageBps: 0, liquidation: true, maintenanceMarginRatio: 0.05 })
    sim.onBar(0, bar(0, 100, 100, 100, 100), 1, 'x')
    sim.onBar(1, bar(1, 100, 100, 93, 95), 1, 'x')            // 93 > 破产价 90
    expect(sim.trades[1]!.price).toBeCloseTo(93, 9)
    expect(sim.cash).toBeCloseTo(300, 9)
    expect(sim.shortfall).toBe(0)
    expect(sim.shortfalls).toHaveLength(0)
    expect(sim.bankrupt).toBe(false)
  })
})
