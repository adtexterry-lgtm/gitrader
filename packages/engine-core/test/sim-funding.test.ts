// SPDX-License-Identifier: CPAL-1.0
// 模拟器：资金费结算、强平判定与罚金、单根成交量上限、默认参数不变。
import { describe, expect, it } from 'vitest'
import type { Candle } from '../src/types'
import { Simulator } from '../src/strategy/simulator'

/** 造一根 K 线；默认成交量足够大，不触发成交量上限。 */
const bar = (t: number, o: number, h: number, l: number, c: number, v = 1e9): Candle => ({ t, o, h, l, c, v })

describe('资金费', () => {
  it('多头在 rate > 0 时付钱，按结算价计名义', () => {
    const sim = new Simulator({ initialCash: 1000, leverage: 1, feeRate: 0, slippageBps: 0, funding: [{ t: 3_600_000, rate: 0.0001 }] })
    sim.onBar(0, bar(0, 100, 100, 100, 100), 1, 'x')
    expect(sim.pos).toBeCloseTo(10, 9)
    const c1 = bar(3_600_000, 100, 100, 100, 100)
    sim.onBar(1, c1, 1, 'x')
    expect(sim.fundingPaid).toBeCloseTo(0.1, 9)
    expect(sim.cash).toBeCloseTo(999.9, 9)
    expect(sim.funding).toHaveLength(1)
    const f = sim.funding[0]!
    expect(f.t).toBe(3_600_000)
    expect(f.rate).toBeCloseTo(0.0001, 9)
    expect(f.notional).toBeCloseTo(1000, 9)
    expect(f.paid).toBeCloseTo(0.1, 9)
    expect(sim.stats([bar(0, 100, 100, 100, 100), c1], 3_600_000).fundingPaid).toBeCloseTo(0.1, 9)
  })

  it('空头在 rate > 0 时收钱', () => {
    const sim = new Simulator({ initialCash: 1000, leverage: 1, feeRate: 0, slippageBps: 0, funding: [{ t: 3_600_000, rate: 0.0001 }] })
    sim.onBar(0, bar(0, 100, 100, 100, 100), -1, 'x')
    expect(sim.pos).toBeCloseTo(-10, 9)
    sim.onBar(1, bar(3_600_000, 100, 100, 100, 100), -1, 'x')
    expect(sim.fundingPaid).toBeCloseTo(-0.1, 9)
    expect(sim.cash).toBeCloseTo(1000.1, 9)
  })

  it('第 0 根不结算（无前一根收盘时间）', () => {
    const sim = new Simulator({ initialCash: 1000, leverage: 1, feeRate: 0, slippageBps: 0, funding: [{ t: 0, rate: 0.0001 }] })
    sim.onBar(0, bar(0, 100, 100, 100, 100), 1, 'x')
    expect(sim.fundingPaid).toBe(0)
    expect(sim.funding).toHaveLength(0)
  })
})

describe('强平', () => {
  const opts = { initialCash: 1000, leverage: 10, feeRate: 0, slippageBps: 0, liquidation: true, maintenanceMarginRatio: 0.05 }
  const open = (): Simulator => {
    const sim = new Simulator(opts)
    sim.onBar(0, bar(0, 100, 100, 100, 100), 1, 'x')
    expect(sim.pos).toBeCloseTo(100, 9)
    return sim
  }

  it('最不利价击穿维持保证金时强平', () => {
    const sim = open()
    sim.onBar(1, bar(1, 100, 100, 93, 95), 1, 'x')
    expect(sim.liquidations).toBe(1)
    expect(sim.pos).toBe(0)
    expect(sim.cash).toBeCloseTo(300, 9)
    expect(sim.trades[1]!.reason).toBe('liquidation')
    expect(sim.trades[1]!.price).toBeCloseTo(93, 9)
    expect(sim.equity[1]!.v).toBeCloseTo(300, 9)
    expect(sim.bankrupt).toBe(false)
  })

  it('未击穿时不清算', () => {
    const sim = open()
    sim.onBar(1, bar(1, 100, 100, 97, 98), 1, 'x')
    expect(sim.liquidations).toBe(0)
    expect(sim.pos).toBeCloseTo(100, 9)
  })

  it('强平后现金为负则归零并标记破产，之后不再成交', () => {
    const sim = open()
    sim.onBar(1, bar(1, 100, 100, 88, 90), 1, 'x')
    expect(sim.liquidations).toBe(1)
    expect(sim.cash).toBe(0)
    expect(sim.bankrupt).toBe(true)
    const n = sim.trades.length
    sim.onBar(2, bar(2, 90, 90, 90, 90), 1, 'x')
    expect(sim.trades).toHaveLength(n)
    expect(sim.equity[2]!.v).toBe(0)
  })

  it('罚金按维持保证金比例额外扣除', () => {
    const sim = new Simulator({ ...opts, liquidationPenaltyRatio: 0.1 })
    sim.onBar(0, bar(0, 100, 100, 100, 100), 1, 'x')
    sim.onBar(1, bar(1, 100, 100, 93, 95), 1, 'x')
    expect(sim.cash).toBeCloseTo(300 - 0.1 * (100 * 93 * 0.05), 9)
  })

  it('维持保证金比例缺省为 0.5 / leverage', () => {
    const sim = new Simulator({ initialCash: 1000, leverage: 10, feeRate: 0, slippageBps: 0, liquidation: true })
    sim.onBar(0, bar(0, 100, 100, 100, 100), 1, 'x')
    sim.onBar(1, bar(1, 100, 100, 93, 95), 1, 'x')
    expect(sim.liquidations).toBe(1)
    expect(sim.pos).toBe(0)
  })
})

describe('成交量上限', () => {
  it('超出部分记为未成交，成交量为上限', () => {
    const sim = new Simulator({ initialCash: 1000, leverage: 1, feeRate: 0, slippageBps: 0, maxVolumeShare: 0.5 })
    sim.onBar(0, bar(0, 100, 100, 100, 100, 4), 1, 'x')
    expect(sim.pos).toBeCloseTo(2, 9)
    expect(sim.unfilledNotional).toBeCloseTo(800, 9)
    expect(sim.wantedNotional).toBeCloseTo(1000, 9)
    expect(sim.stats([bar(0, 100, 100, 100, 100, 4)], 1).unfilledShare).toBeCloseTo(0.8, 9)
  })

  it('不传上限时全量成交', () => {
    const sim = new Simulator({ initialCash: 1000, leverage: 1, feeRate: 0, slippageBps: 0 })
    sim.onBar(0, bar(0, 100, 100, 100, 100, 4), 1, 'x')
    expect(sim.pos).toBeCloseTo(10, 9)
    expect(sim.stats([bar(0, 100, 100, 100, 100, 4)], 1).unfilledShare).toBe(0)
  })
})

describe('默认参数', () => {
  it('资金费 / 强平 / 成交量上限都不生效，费用累计与成交手续费一致', () => {
    const sim = new Simulator({ initialCash: 1000, leverage: 1, feeRate: 0.001, slippageBps: 0 })
    sim.onBar(0, bar(0, 100, 100, 100, 100), 1, 'x')
    sim.onBar(1, bar(1, 101, 103, 99, 102), 1, 'x')
    sim.onBar(2, bar(2, 102, 104, 100, 103), 0, 'x')
    const stats = sim.stats([bar(0, 100, 100, 100, 100), bar(1, 101, 103, 99, 102), bar(2, 102, 104, 100, 103)], 1)
    expect(stats.fundingPaid).toBe(0)
    expect(stats.liquidations).toBe(0)
    expect(stats.unfilledShare).toBe(0)
    const feeSum = sim.trades.reduce((a, t) => a + t.fee, 0)
    expect(stats.feesPaid).toBeCloseTo(feeSum, 9)
    expect(sim.fundingPaid).toBe(0)
    expect(sim.liquidations).toBe(0)
  })
})
