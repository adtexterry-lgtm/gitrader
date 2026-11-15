// SPDX-License-Identifier: CPAL-1.0
// 马丁模板验收：倍数加仓、最大加仓次数、最大总名义额、最大敞口、止盈止损、参数互斥。
// 安全上限的用例都写成「精确条数」而不是「至少一条」——这样一旦上限判断被改坏，用例必红。
import { describe, expect, it } from 'vitest'
import { MartingaleBot } from '../src/martingale'
import { BotParamError } from '../src/errors'
import { runBot } from '../src/engine'
import { series } from './helpers'

const base = {
  direction: 'long',
  baseNotional: 100,
  multiplier: 2,
  addDropPct: 10,
  maxAdds: 2,
  maxTotalNotional: 1_000,
  takeProfitPct: 50,
  stopLossPct: 50,
  maxExposureNotional: 2_000,
}

describe('martingale bot — add ladder', () => {
  it('adds on the configured adverse move with a geometric notional ladder', () => {
    const run = runBot(new MartingaleBot(base), series([100, 89, 79]))
    expect(run.fills.map((f) => Number(f.notional.toFixed(6)))).toEqual([100, 200, 400])
    expect(run.fills.every((f) => f.side === 'buy')).toBe(true)
    expect(run.snapshot.detail.adds).toBe(2)
    expect(run.snapshot.detail.totalNotional).toBeCloseTo(700, 9)
  })

  it('does not add while price is not adverse enough', () => {
    const run = runBot(new MartingaleBot(base), series([100, 105, 106]))
    expect(run.fills).toHaveLength(1)
    expect(run.snapshot.detail.adds).toBe(0)
  })
})

describe('martingale bot — safety caps (exact counts)', () => {
  it('stops at maxAdds and leaves the position untouched', () => {
    const run = runBot(new MartingaleBot(base), series([100, 89, 79, 70, 60]))
    expect(run.fills).toHaveLength(3)
    expect(run.halted?.code).toBe('martingale-max-adds')
    expect(run.fills.some((f) => f.side === 'sell')).toBe(false)
    expect(run.snapshot.position).toBeGreaterThan(0)
  })

  it('stops when the next add would exceed maxTotalNotional', () => {
    const run = runBot(new MartingaleBot({ ...base, maxAdds: 5, maxTotalNotional: 500 }), series([100, 89, 79, 70]))
    expect(run.fills).toHaveLength(2)
    expect(run.halted?.code).toBe('martingale-max-notional')
    expect(run.snapshot.detail.totalNotional).toBeCloseTo(300, 9)
  })

  it('stops when the next add would exceed maxExposureNotional', () => {
    const run = runBot(
      new MartingaleBot({ ...base, maxAdds: 5, maxTotalNotional: 5_000, maxExposureNotional: 350 }),
      series([100, 89, 79, 70]),
    )
    expect(run.fills).toHaveLength(2)
    expect(run.halted?.code).toBe('max-exposure')
  })

  it('halts instead of shrinking the order when the cap is hit (no silent truncation)', () => {
    const run = runBot(new MartingaleBot(base), series([100, 89, 79, 70]))
    const notionals = run.fills.map((f) => Number(f.notional.toFixed(6)))
    expect(notionals).toEqual([100, 200, 400])
    expect(notionals[notionals.length - 1]).toBe(400)
  })
})

describe('martingale bot — exits', () => {
  it('takes profit on the average entry and flattens', () => {
    const run = runBot(new MartingaleBot({ ...base, maxAdds: 0, takeProfitPct: 0.5 }), series([100, 101]))
    expect(run.fills.map((f) => f.side)).toEqual(['buy', 'sell'])
    expect(run.halted?.code).toBe('take-profit')
    expect(run.snapshot.position).toBe(0)
    expect(run.realizedPnl).toBeCloseTo(1, 6)
  })

  it('stops out on the average entry and flattens', () => {
    const run = runBot(new MartingaleBot({ ...base, maxAdds: 0, stopLossPct: 5 }), series([100, 94]))
    expect(run.halted?.code).toBe('stop-loss')
    expect(run.snapshot.position).toBe(0)
    expect(run.realizedPnl).toBeCloseTo(-6, 6)
  })

  it('mirrors the ladder for a short martingale', () => {
    const run = runBot(new MartingaleBot({ ...base, direction: 'short', maxAdds: 1 }), series([100, 111, 125]))
    expect(run.fills.every((f) => f.side === 'sell')).toBe(true)
    expect(run.fills).toHaveLength(2)
    expect(run.snapshot.position).toBeLessThan(0)
  })
})

describe('martingale bot — parameter rejection', () => {
  it('rejects a first order larger than maxTotalNotional', () => {
    expect(() => new MartingaleBot({ ...base, baseNotional: 600, maxTotalNotional: 500 })).toThrow(BotParamError)
  })

  it('rejects a first order larger than maxExposureNotional', () => {
    expect(() => new MartingaleBot({ ...base, baseNotional: 300, maxExposureNotional: 200 })).toThrow(BotParamError)
  })

  it('rejects a multiplier below 1 (that would not be a martingale)', () => {
    expect(() => new MartingaleBot({ ...base, multiplier: 0.5 })).toThrow(BotParamError)
  })

  it('rejects a negative maxAdds', () => {
    expect(() => new MartingaleBot({ ...base, maxAdds: -1 })).toThrow(BotParamError)
  })
})
