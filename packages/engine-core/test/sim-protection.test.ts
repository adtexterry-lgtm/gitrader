// SPDX-License-Identifier: CPAL-1.0
// 模拟器接线：仓位保护规则（止损 / 止盈 / 移动止损 / 时限）先于策略生效，手数归一（lotStep）与最小手数。
import { describe, expect, it } from 'vitest'
import type { Candle } from '../src/types'
import { Simulator } from '../src/strategy/simulator'

/** 造一根 K 线；默认成交量足够大，不触发成交量上限。 */
const bar = (t: number, o: number, h: number, l: number, c: number, v = 1e9): Candle => ({ t, o, h, l, c, v })

const STEP = 3_600_000
const simOpts = { initialCash: 1000, leverage: 1, feeRate: 0, slippageBps: 0 }

describe('保护先于策略', () => {
  it('止损：bar 2 低点打穿 98，按 98 平仓；本根策略目标被忽略，下一根才能重新开仓', () => {
    const candles = [
      bar(0, 100, 101, 99, 100),
      bar(STEP, 100, 101, 99, 100),
      bar(2 * STEP, 99, 99.5, 97, 98),
      bar(3 * STEP, 98, 99, 97.5, 98.5),
    ]
    const sim = new Simulator({ ...simOpts, protection: { stopLossPct: 0.02 } })
    sim.onBar(0, candles[0]!, null, '')
    expect(sim.pos).toBe(0)
    expect(sim.protectionState).toBeNull()

    sim.onBar(1, candles[1]!, 1, 'signal')
    expect(sim.pos).toBeCloseTo(10, 9)
    expect(sim.protectionState).toMatchObject({ side: 'long', entryPrice: 100, entryBar: 1 })

    // 本根 target 仍为 1，但保护先出场，不为策略重新开仓
    sim.onBar(2, candles[2]!, 1, 'signal')
    expect(sim.pos).toBe(0)
    expect(sim.protectionState).toBeNull()
    const last = sim.trades[sim.trades.length - 1]!
    expect(last.reason).toBe('protection:stop_loss')
    expect(last.price).toBeCloseTo(98, 9)
    expect(last.side).toBe('sell')
    expect(sim.trades).toHaveLength(2)
    expect(sim.stats(candles, STEP).protectionExits).toBe(1)

    // 下一根 target 仍为 1 → 开盘 98 重新开仓
    sim.onBar(3, candles[3]!, 1, 'signal')
    expect(sim.pos).toBeCloseTo(10, 9)
    expect(sim.protectionState).toMatchObject({ side: 'long', entryPrice: 98, entryBar: 3 })
    expect(sim.stats(candles, STEP).protectionExits).toBe(1)
  })

  it('止盈：bar 2 高点 106 打到 105，按 105 平仓', () => {
    const candles = [
      bar(0, 100, 100, 100, 100),
      bar(STEP, 100, 101, 99, 100),
      bar(2 * STEP, 101, 106, 100.5, 105),
    ]
    const sim = new Simulator({ ...simOpts, protection: { takeProfitPct: 0.05 } })
    sim.onBar(0, candles[0]!, null, '')
    sim.onBar(1, candles[1]!, 1, 'signal')
    expect(sim.pos).toBeCloseTo(10, 9)
    sim.onBar(2, candles[2]!, 1, 'signal')
    expect(sim.pos).toBe(0)
    const last = sim.trades[sim.trades.length - 1]!
    expect(last.reason).toBe('protection:take_profit')
    expect(last.price).toBeCloseTo(105, 9)
    expect(sim.stats(candles, STEP).protectionExits).toBe(1)
  })

  it('移动止损：涨到 110 后回落到 108.5，在 110·0.99 = 108.9 平仓', () => {
    const candles = [
      bar(0, 100, 100, 100, 100),
      bar(STEP, 100, 102, 100, 102),
      bar(2 * STEP, 102, 104, 102, 104),
      bar(3 * STEP, 104, 107, 104, 107),
      bar(4 * STEP, 107, 110, 107, 110),
      bar(5 * STEP, 110, 110.5, 108.5, 108.6),
    ]
    const sim = new Simulator({ ...simOpts, protection: { trailing: { activationPct: 0.03, trailPct: 0.01 } } })
    sim.onBar(0, candles[0]!, null, '')
    sim.onBar(1, candles[1]!, 1, 'signal')
    expect(sim.pos).toBeCloseTo(10, 9)
    sim.onBar(2, candles[2]!, 1, 'signal')
    sim.onBar(3, candles[3]!, 1, 'signal')
    sim.onBar(4, candles[4]!, 1, 'signal')
    expect(sim.pos).toBeCloseTo(10, 9)
    expect(sim.protectionState?.trailingArmed).toBe(true)
    sim.onBar(5, candles[5]!, 1, 'signal')
    expect(sim.pos).toBe(0)
    const last = sim.trades[sim.trades.length - 1]!
    expect(last.reason).toBe('protection:trailing_stop')
    expect(last.price).toBeCloseTo(108.9, 9)
    expect(sim.stats(candles, STEP).protectionExits).toBe(1)
  })

  it('时限：开仓后第 2 根收盘平仓', () => {
    const candles = [
      bar(0, 100, 100, 100, 100),
      bar(STEP, 100, 100, 100, 100),
      bar(2 * STEP, 100, 100, 100, 100),
      bar(3 * STEP, 100, 101, 100, 100.5),
    ]
    const sim = new Simulator({ ...simOpts, protection: { maxHoldBars: 2 } })
    sim.onBar(0, candles[0]!, null, '')
    sim.onBar(1, candles[1]!, 1, 'signal')
    expect(sim.protectionState?.entryBar).toBe(1)
    sim.onBar(2, candles[2]!, 1, 'signal')
    expect(sim.pos).toBeCloseTo(10, 9)
    sim.onBar(3, candles[3]!, 1, 'signal')
    expect(sim.pos).toBe(0)
    const last = sim.trades[sim.trades.length - 1]!
    expect(last.reason).toBe('protection:time_limit')
    expect(last.price).toBeCloseTo(100.5, 9)
    expect(sim.stats(candles, STEP).protectionExits).toBe(1)
  })
})

describe('不给 protection 时行为不变', () => {
  it('旧用例的 stats 与成交快照逐字段一致（另加 protectionExits = 0）', () => {
    const candles = [
      bar(0, 100, 100, 100, 100),
      bar(60_000, 101, 103, 99, 102),
      bar(120_000, 102, 104, 100, 103),
      bar(180_000, 100, 101, 95, 96),
      bar(240_000, 96, 98, 94, 97),
      bar(300_000, 97, 99, 96, 98),
    ]
    const wants = [null, 1, 1, 1, -1, 0]
    const sim = new Simulator({ initialCash: 1000, leverage: 1, feeRate: 0.0005, slippageBps: 5 })
    for (let i = 0; i < candles.length; i++) sim.onBar(i, candles[i]!, wants[i]!, 'sig')
    expect(sim.stats(candles, 60_000)).toEqual({
      totalReturnRatio: -0.063235,
      annualizedRatio: -1,
      maxDrawdownRatio: 0.080515,
      sharpe: -258.549,
      sortino: -268.606,
      winRatio: 0,
      profitFactor: 0,
      trades: 2,
      avgHoldBars: 2,
      fills: 3,
      spanDays: 0.004,
      finalEquity: 936.76,
      fundingPaid: 0,
      feesPaid: 1.929718,
      liquidations: 0,
      protectionExits: 0,
      unfilledShare: 0,
    })
    expect(sim.trades).toEqual([
      { t: 60_000, side: 'buy', price: 101.0505, size: 9.896042077970916, pnl: -0.5000000000000001, fee: 0.5000000000000001, reason: 'sig' },
      { t: 240_000, side: 'sell', price: 95.952, size: 19.791823713426226, pnl: -51.40450306901007, fee: 0.9495325344753366, reason: 'sig' },
      { t: 300_000, side: 'buy', price: 97.04849999999999, size: 9.89578163545531, pnl: -11.330909945300908, fee: 0.48018538202424227, reason: 'sig' },
    ])
  })
})

describe('手数归一', () => {
  it('lotStep 0.1：价格 95 时 10.526… 归一为 10.5', () => {
    const candles = [bar(0, 95, 95, 95, 95)]
    const sim = new Simulator({ ...simOpts, lotStep: 0.1 })
    sim.onBar(0, candles[0]!, 1, 'signal')
    expect(sim.pos).toBeCloseTo(10.5, 9)
    expect(sim.trades).toHaveLength(1)
    expect(sim.trades[0]!.size).toBeCloseTo(10.5, 9)
    expect(sim.unfilledNotional).toBe(0)
  })

  it('minLot 20：归一到 10.5 小于最小手数 → 不成交，未成交名义 > 0', () => {
    const candles = [bar(0, 95, 95, 95, 95)]
    const sim = new Simulator({ ...simOpts, lotStep: 0.1, minLot: 20 })
    sim.onBar(0, candles[0]!, 1, 'signal')
    expect(sim.pos).toBe(0)
    expect(sim.trades).toHaveLength(0)
    expect(sim.unfilledNotional).toBeGreaterThan(0)
    expect(sim.unfilledNotional).toBeCloseTo(1000, 6)
    expect(sim.stats(candles, STEP).fills).toBe(0)
  })
})
