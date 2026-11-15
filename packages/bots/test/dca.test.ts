// SPDX-License-Identifier: CPAL-1.0
// 定投模板验收：周期节奏、下跌加买、下单次数上限、止盈止损、参数互斥（次数 × 单笔 ≤ 最大敞口）。
import { describe, expect, it } from 'vitest'
import { DcaBot } from '../src/dca'
import { BotParamError } from '../src/errors'
import { runBot } from '../src/engine'
import { HOUR, T0, bar, series } from './helpers'

const base = {
  frequency: 'daily',
  notionalPerOrder: 100,
  maxOrders: 5,
  dipBuyEnabled: false,
  dipThresholdPct: 5,
  takeProfitPct: 0,
  stopLossPct: 0,
  maxExposureNotional: 1_000,
}

describe('dca bot — cadence', () => {
  it('buys once per calendar day, not once per bar', () => {
    const hourly = series([100, 100, 100, 100, 100, 100])
    const nextDay = bar(100, 100, 100, 100, 6, HOUR)
    nextDay.t = T0 + 24 * HOUR
    const run = runBot(new DcaBot(base), [...hourly, nextDay])
    expect(run.fills).toHaveLength(2)
    expect(run.fills.map((f) => f.side)).toEqual(['buy', 'buy'])
  })

  it('buys on every bar when the frequency is every_bar', () => {
    const run = runBot(new DcaBot({ ...base, frequency: 'every_bar', maxOrders: 5 }), series([100, 100, 100]))
    expect(run.fills).toHaveLength(3)
  })

  it('sizes each order by notional, not by a fixed quantity', () => {
    const run = runBot(new DcaBot({ ...base, frequency: 'every_bar', maxOrders: 2 }), series([100, 50]))
    expect(run.fills[0]!.qty).toBeCloseTo(1, 9)
    expect(run.fills[1]!.qty).toBeCloseTo(2, 9)
  })
})

describe('dca bot — dip buying', () => {
  it('adds one buy when price falls past the dip threshold', () => {
    const run = runBot(new DcaBot({ ...base, dipBuyEnabled: true, dipThresholdPct: 5 }), series([100, 94, 94]))
    expect(run.fills.map((f) => f.reason)).toEqual(['dca-period', 'dca-dip'])
    expect(run.fills).toHaveLength(2)
  })

  it('does not dip-buy when the flag is off', () => {
    const run = runBot(new DcaBot(base), series([100, 94, 90]))
    expect(run.fills).toHaveLength(1)
  })
})

describe('dca bot — caps and exits', () => {
  it('stops at maxOrders without placing an extra order', () => {
    const run = runBot(new DcaBot({ ...base, frequency: 'every_bar', maxOrders: 3 }), series([100, 100, 100, 100, 100]))
    expect(run.fills).toHaveLength(3)
    expect(run.halted?.code).toBe('max-orders')
  })

  it('takes profit once the position return reaches the target', () => {
    const run = runBot(new DcaBot({ ...base, takeProfitPct: 1 }), series([100, 102]))
    expect(run.halted?.code).toBe('take-profit')
    expect(run.snapshot.position).toBe(0)
    expect(run.realizedPnl).toBeCloseTo(2, 6)
  })

  it('stops out on the position return', () => {
    const run = runBot(new DcaBot({ ...base, stopLossPct: 3 }), series([100, 96]))
    expect(run.halted?.code).toBe('stop-loss')
    expect(run.snapshot.position).toBe(0)
  })

  it('rejects a budget that can never stay inside maxExposureNotional', () => {
    expect(() => new DcaBot({ ...base, notionalPerOrder: 100, maxOrders: 20, maxExposureNotional: 1_000 })).toThrow(BotParamError)
  })

  it('rejects maxOrders = 0', () => {
    expect(() => new DcaBot({ ...base, maxOrders: 0 })).toThrow(BotParamError)
  })
})
