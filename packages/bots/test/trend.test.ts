// SPDX-License-Identifier: CPAL-1.0
// 趋势模板验收：预热不下单、确认根数、多空方向、反向穿越出场、移动止损、仓位比例。
import { describe, expect, it } from 'vitest'
import { TrendBot } from '../src/trend'
import { BotParamError } from '../src/errors'
import { runBot } from '../src/engine'
import { series } from './helpers'

const base = {
  maPeriod: 3,
  maType: 'SMA',
  confirmBars: 1,
  positionPct: 100,
  direction: 'both',
  trailingStopPct: 0,
  stopLossPct: 0,
  maxExposureNotional: 1_000,
}

describe('trend bot — signals', () => {
  it('places no order during moving-average preheat', () => {
    const run = runBot(new TrendBot(base), series([10, 10]))
    expect(run.fills).toHaveLength(0)
    expect(run.halted).toBeNull()
  })

  it('enters long after a close above the average', () => {
    const run = runBot(new TrendBot(base), series([10, 10, 10, 11, 12]))
    expect(run.fills).toHaveLength(1)
    expect(run.fills[0]!.side).toBe('buy')
    expect(run.fills[0]!.price).toBe(11)
    expect(run.snapshot.position).toBeGreaterThan(0)
  })

  it('waits for the confirmation bars before entering', () => {
    const one = runBot(new TrendBot({ ...base, confirmBars: 1 }), series([10, 10, 10, 11, 12]))
    const two = runBot(new TrendBot({ ...base, confirmBars: 2 }), series([10, 10, 10, 11, 12]))
    expect(one.fills[0]!.i).toBe(3)
    expect(two.fills[0]!.i).toBe(4)
  })

  it('enters short when the close is below the average', () => {
    const run = runBot(new TrendBot({ ...base, direction: 'short' }), series([10, 10, 10, 9, 8]))
    expect(run.fills).toHaveLength(1)
    expect(run.fills[0]!.side).toBe('sell')
    expect(run.snapshot.position).toBeLessThan(0)
  })

  it('refuses to go long when the direction is short-only', () => {
    const run = runBot(new TrendBot({ ...base, direction: 'short' }), series([10, 10, 10, 11, 12]))
    expect(run.fills).toHaveLength(0)
  })

  it('sizes the position from positionPct of the exposure cap', () => {
    const run = runBot(new TrendBot({ ...base, positionPct: 50 }), series([10, 10, 10, 11]))
    expect(run.fills[0]!.qty).toBeCloseTo(500 / 11, 9)
  })

  it('works with an EMA as well as an SMA', () => {
    const run = runBot(new TrendBot({ ...base, maType: 'EMA' }), series([10, 10, 10, 11, 12]))
    expect(run.fills.length).toBeGreaterThan(0)
  })
})

describe('trend bot — exits', () => {
  it('exits on an opposite close across the average', () => {
    const run = runBot(new TrendBot(base), series([10, 10, 10, 11, 9]))
    expect(run.halted?.code).toBe('trend-signal-flat')
    expect(run.snapshot.position).toBe(0)
    expect(run.realizedPnl).toBeLessThan(0)
  })

  it('exits on a trailing stop retracement', () => {
    const run = runBot(new TrendBot({ ...base, trailingStopPct: 5 }), series([10, 10, 10, 11, 12, 11.3]))
    expect(run.halted?.code).toBe('trailing-stop')
    expect(run.snapshot.position).toBe(0)
  })

  it('never opens more than the exposure cap allows', () => {
    const run = runBot(new TrendBot({ ...base, maxExposureNotional: 100 }), series([10, 10, 10, 11, 8]))
    expect(run.maxExposure).toBeLessThanOrEqual(100 + 1e-9)
  })

  it('rejects a confirmation window longer than the average period', () => {
    expect(() => new TrendBot({ ...base, maPeriod: 3, confirmBars: 5 })).toThrow(BotParamError)
  })

  it('rejects an out-of-range moving-average period', () => {
    expect(() => new TrendBot({ ...base, maPeriod: 1 })).toThrow(BotParamError)
  })
})
