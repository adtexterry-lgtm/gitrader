// SPDX-License-Identifier: CPAL-1.0
// 引擎验收：数据可信性检查（不可信就抛，不跳过）、敞口拒单不截断、停机不平仓、可重放。
import { describe, expect, it } from 'vitest'
import { assertCandles, inferIntervalMs, runBot } from '../src/engine'
import { GridBot } from '../src/grid'
import { DcaBot } from '../src/dca'
import { MartingaleBot } from '../src/martingale'
import { BotStateError } from '../src/errors'
import { bar, near, series } from './helpers'

const gridBase = { lowerPrice: 100, upperPrice: 120, gridCount: 2, qtyPerGrid: 1, stopLossPct: 0, maxExposureNotional: 1_000 }

describe('engine — input trust', () => {
  it('throws on a non-monotonic timestamp instead of quietly sorting', () => {
    const candles = series([100, 101, 102])
    candles[1]!.t = candles[2]!.t + 1
    expect(() => assertCandles(candles)).toThrow(BotStateError)
    try {
      assertCandles(candles)
    } catch (e) {
      expect((e as BotStateError).kind).toBe('candles-not-monotonic')
    }
  })

  it('throws on a zero/NaN price instead of skipping that bar', () => {
    const zero = series([100, 101])
    zero[1]!.c = 0
    expect(() => assertCandles(zero)).toThrow(BotStateError)
    const nan = series([100, 101])
    nan[1]!.h = Number.NaN
    expect(() => assertCandles(nan)).toThrow(BotStateError)
  })

  it('throws when high is below low or below open/close', () => {
    const inverted = [bar(100, 90, 95, 100, 0)]
    expect(() => assertCandles(inverted)).toThrow(BotStateError)
  })

  it('infers the bar interval from the data', () => {
    expect(inferIntervalMs(series([1, 1, 1], { intervalMs: 300_000 }))).toBe(300_000)
    expect(inferIntervalMs([])).toBe(60_000)
  })
})

describe('engine — exposure guard', () => {
  it('refuses the order that would breach the cap, and refuses it whole', () => {
    const bot = new GridBot({ ...gridBase, gridCount: 4, qtyPerGrid: 0.001, maxExposureNotional: 0.15 })
    const run = runBot(bot, series([112, 105, 116]))
    expect(run.fills).toHaveLength(1)
    expect(run.fills[0]!.qty).toBeCloseTo(0.001, 12)
    expect(run.halted?.code).toBe('max-exposure')
  })

  it('leaves the position open on halt instead of inventing a close', () => {
    const bot = new MartingaleBot({
      direction: 'long',
      baseNotional: 100,
      multiplier: 2,
      addDropPct: 10,
      maxAdds: 1,
      maxTotalNotional: 1_000,
      takeProfitPct: 90,
      stopLossPct: 0,
      maxExposureNotional: 2_000,
    })
    const run = runBot(bot, series([100, 89, 79, 70]))
    expect(run.halted?.code).toBe('martingale-max-adds')
    expect(run.snapshot.position).toBeGreaterThan(0)
    expect(run.fills.every((f) => f.side === 'buy')).toBe(true)
  })
})

describe('engine — mark to market after halt', () => {
  it('keeps marking a DCA position to market after the max-orders halt', () => {
    const closes = Array.from({ length: 20 }, (_, k) => 100 - 3 * k)
    const candles = series(closes, { intervalMs: 86_400_000 })
    const bot = new DcaBot({
      frequency: 'daily',
      notionalPerOrder: 100,
      maxOrders: 3,
      dipBuyEnabled: false,
      dipThresholdPct: 5,
      takeProfitPct: 0,
      stopLossPct: 0,
      maxExposureNotional: 1_000,
    })
    const run = runBot(bot, candles)
    expect(run.equity).toHaveLength(candles.length)
    expect(run.fills).toHaveLength(3)
    expect(run.halted?.code).toBe('max-orders')
    const lastClose = closes[closes.length - 1] as number
    const expected = run.initialCash + run.realizedPnl - run.fees + (lastClose - run.snapshot.avgEntry) * run.snapshot.position
    expect(near(run.finalEquity, expected)).toBe(true)
    expect(near(run.finalEquity, 9833.1, 1e-5)).toBe(true)
    expect(near(run.equity[run.equity.length - 1]!.v, run.finalEquity)).toBe(true)
  })

  it('keeps marking a martingale position to market after the max-adds halt', () => {
    const closes = [100, 89, 79, 70]
    const candles = series(closes)
    const bot = new MartingaleBot({
      direction: 'long',
      baseNotional: 100,
      multiplier: 2,
      addDropPct: 10,
      maxAdds: 1,
      maxTotalNotional: 1_000,
      takeProfitPct: 90,
      stopLossPct: 0,
      maxExposureNotional: 2_000,
    })
    const run = runBot(bot, candles)
    expect(run.equity).toHaveLength(candles.length)
    expect(run.fills).toHaveLength(2)
    expect(run.halted?.code).toBe('martingale-max-adds')
    const lastClose = closes[closes.length - 1] as number
    const expected = run.initialCash + run.realizedPnl - run.fees + (lastClose - run.snapshot.avgEntry) * run.snapshot.position
    expect(near(run.finalEquity, expected)).toBe(true)
    expect(near(run.equity[run.equity.length - 1]!.v, run.finalEquity)).toBe(true)
  })
})

describe('engine — replayability', () => {
  it('produces identical results for identical inputs', () => {
    const candles = series([112, 105, 116, 121, 108, 118])
    const a = runBot(new GridBot(gridBase), candles)
    const b = runBot(new GridBot(gridBase), candles)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('records one equity point per processed bar', () => {
    const candles = series([112, 105, 116])
    const run = runBot(new GridBot(gridBase), candles)
    expect(run.equity).toHaveLength(3)
    expect(run.equity.map((p) => p.t)).toEqual(candles.map((c) => c.t))
  })

  it('charges the fee rate it was given', () => {
    const run = runBot(new GridBot({ ...gridBase, gridCount: 2 }), series([112, 105, 121]), { feeRate: 0.001 })
    expect(run.fees).toBeGreaterThan(0)
    expect(run.finalEquity).toBeLessThan(run.initialCash + run.realizedPnl + 1e-9)
  })
})
