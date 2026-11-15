// SPDX-License-Identifier: CPAL-1.0
// 网格模板验收：等差 / 等比线、格数与线数关系、做多 / 做空 / 中性、越界三档、每格数量与敞口校验。
import { describe, expect, it } from 'vitest'
import { GridBot, buildGridLevels } from '../src/grid'
import { BotParamError } from '../src/errors'
import { runBot } from '../src/engine'
import { HOUR, bar, series } from './helpers'

const base = { lowerPrice: 100, upperPrice: 120, gridCount: 4, qtyPerGrid: 1, stopLossPct: 0, maxExposureNotional: 1_000 }

describe('buildGridLevels', () => {
  it('produces cells + 1 boundaries for an arithmetic grid (QD levels.py semantics)', () => {
    const levels = buildGridLevels(100, 120, 4, 'arithmetic')
    expect(levels).toEqual([100, 105, 110, 115, 120])
  })

  it('spaces a geometric grid by a constant ratio and pins both endpoints', () => {
    const levels = buildGridLevels(100, 121, 2, 'geometric')
    expect(levels).toHaveLength(3)
    expect(levels[0]).toBe(100)
    expect(levels[2]).toBe(121)
    expect(levels[1]).toBeCloseTo(110, 9)
    const ratios = [levels[1]! / levels[0]!, levels[2]! / levels[1]!]
    expect(ratios[0]).toBeCloseTo(ratios[1]!, 9)
  })

  it('rejects an inverted or non-positive range instead of silently swapping it', () => {
    expect(() => buildGridLevels(120, 100, 4, 'arithmetic')).toThrow(BotParamError)
    expect(() => buildGridLevels(0, 100, 4, 'geometric')).toThrow(BotParamError)
    expect(() => buildGridLevels(100, 120, 0, 'arithmetic')).toThrow(BotParamError)
  })
})

describe('grid bot — long', () => {
  it('fills a cell on a downward cross and takes the cell profit on the upper line', () => {
    const bot = new GridBot({ ...base, gridCount: 2 })
    const run = runBot(bot, series([112, 105, 116, 121]))
    expect(run.fills.map((f) => [f.side, f.price])).toEqual([['buy', 110], ['sell', 120]])
    expect(run.realizedPnl).toBeCloseTo(10, 9)
    expect(run.snapshot.position).toBe(0)
    expect(run.halted).toBeNull()
  })

  it('never opens a cell whose line was never crossed this bar', () => {
    const bot = new GridBot({ ...base, gridCount: 4 })
    const run = runBot(bot, series([112]))
    expect(run.fills).toHaveLength(0)
  })

  it('keeps a filled cell open until the exit line is reached', () => {
    const bot = new GridBot({ ...base, gridCount: 2 })
    const run = runBot(bot, series([112, 105, 111]))
    expect(run.fills).toHaveLength(1)
    expect(run.snapshot.position).toBe(1)
    expect(run.snapshot.avgEntry).toBeCloseTo(110, 9)
  })
})

describe('grid bot — short and neutral', () => {
  it('mirrors the ladder for a short grid', () => {
    const bot = new GridBot({ ...base, gridCount: 4, gridDirection: 'short' })
    const run = runBot(bot, series([112, 116, 109]))
    expect(run.fills.map((f) => [f.side, f.price])).toEqual([['sell', 115], ['buy', 110]])
    expect(run.realizedPnl).toBeCloseTo(5, 9)
    expect(run.snapshot.position).toBe(0)
  })

  it('splits cells around the midpoint for a neutral grid', () => {
    const bot = new GridBot({ ...base, gridCount: 4, gridDirection: 'neutral' })
    const run = runBot(bot, series([112, 116, 109]))
    expect(run.fills.map((f) => [f.side, f.price])).toEqual([['sell', 115], ['buy', 110]])
    expect(run.snapshot.position).toBe(0)
  })
})

describe('grid bot — boundary handling', () => {
  it('pause: stops new cells below the lower bound but keeps the run alive', () => {
    const bot = new GridBot({ ...base, gridCount: 4, boundaryAction: 'pause' })
    const run = runBot(bot, series([112, 99, 99, 112, 105]))
    expect(run.halted).toBeNull()
    expect(run.snapshot.detail.paused).toBe(false)
    const fillsBeforeReturn = run.fills.filter((f) => f.i <= 2)
    expect(fillsBeforeReturn).toHaveLength(0)
    expect(run.fills.length).toBeGreaterThan(0)
  })

  it('stop_loss while flat: halts on the first out-of-bounds close and emits no order', () => {
    const bot = new GridBot({ ...base, gridCount: 2, boundaryAction: 'stop_loss' })
    const run = runBot(bot, series([112, 99]))
    expect(run.fills).toHaveLength(0)
    expect(run.halted?.code).toBe('grid-boundary')
  })

  it('stop_loss closes the open position at the boundary close before halting', () => {
    const bot = new GridBot({ lowerPrice: 100, upperPrice: 120, gridCount: 2, qtyPerGrid: 1, stopLossPct: 0, boundaryAction: 'stop_loss', maxExposureNotional: 1_000 })
    const run = runBot(bot, series([112, 105, 99]))
    const sells = run.fills.filter((f) => f.side === 'sell')
    expect(sells).toHaveLength(1)
    expect(sells[0]!.qty).toBeCloseTo(1, 12)
    expect(sells[0]!.price).toBe(99)
    expect(run.snapshot.position).toBe(0)
    expect(run.halted?.code).toBe('grid-boundary')
  })

  it('hold: keeps running and opens cells again once price is back inside', () => {
    const bot = new GridBot({ ...base, gridCount: 2, boundaryAction: 'hold' })
    const run = runBot(bot, series([112, 99, 112, 105]))
    expect(run.halted).toBeNull()
    expect(run.fills.map((f) => [f.side, f.price])).toEqual([['buy', 110]])
  })

  it('triggers only on the side that matters for the grid direction', () => {
    const longBot = new GridBot({ ...base, gridCount: 2, boundaryAction: 'stop_loss' })
    const above = runBot(longBot, series([112, 121]))
    expect(above.halted).toBeNull()
    const shortBot = new GridBot({ ...base, gridCount: 2, gridDirection: 'short', boundaryAction: 'stop_loss' })
    const below = runBot(shortBot, series([112, 99]))
    expect(below.halted).toBeNull()
  })
})

describe('grid bot — parameter safety', () => {
  it('rejects a single cell that already exceeds the exposure cap', () => {
    expect(() => new GridBot({ ...base, qtyPerGrid: 100, maxExposureNotional: 1_000 })).toThrow(BotParamError)
  })

  it('rejects an inverted range at construction time', () => {
    expect(() => new GridBot({ ...base, lowerPrice: 130, upperPrice: 120 })).toThrow(BotParamError)
  })

  it('rejects a grid count below two cells', () => {
    expect(() => new GridBot({ ...base, gridCount: 1 })).toThrow(BotParamError)
  })

  it('stops when the position stop loss is hit', () => {
    const bot = new GridBot({ ...base, gridCount: 2, stopLossPct: 5 })
    const run = runBot(bot, series([112, 105, 100]))
    expect(run.halted?.code).toBe('stop-loss')
  })
})

describe('grid bot — same-bar exposure', () => {
  it('counts every same-bar open intent against the cap and halts itself', () => {
    const bot = new GridBot({ ...base, lowerPrice: 100, upperPrice: 130, gridCount: 3, qtyPerGrid: 1, stopLossPct: 0, maxExposureNotional: 300 })
    const candles = [bar(131, 131, 131, 131, 0), bar(131, 131, 99, 105, 1)]
    const intents = bot.onBar({ i: 1, bar: candles[1]!, prev: candles[0]!, intervalMs: HOUR })
    expect(intents).toHaveLength(2)
    expect(intents.every((intent) => intent.side === 'buy')).toBe(true)
    expect(bot.snapshot(105).halted?.code).toBe('max-exposure')
  })
})

describe('grid bot — bar path', () => {
  it('does not complete a round trip inside a single wide bar', () => {
    const bot = new GridBot({ ...base, gridCount: 2 })
    const wide = [bar(112, 120, 105, 105, 0), bar(105, 120, 105, 120, 1)]
    const run = runBot(bot, wide)
    // 第 0 根：先向下穿越 110 线买入，即使同一根的高点也摸到 120，也不在同一根里卖出
    expect(run.fills.filter((f) => f.i === 0)).toHaveLength(1)
    expect(run.fills[0]!.side).toBe('buy')
    expect(run.fills.filter((f) => f.i === 0 && f.side === 'sell')).toHaveLength(0)
    expect(run.fills).toHaveLength(2)
  })
})
