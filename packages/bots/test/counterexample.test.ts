// SPDX-License-Identifier: CPAL-1.0
// 反证用例：每条都写成「把守卫改坏就必红」的形状（精确条数 / 精确原因码 / 必抛），不是「跑通就行」。
// 本文件里的三条对应 REPORT 记录的实测反证（改坏 → 红 → 恢复）：
//   1) src/safety.ts checkMartingaleLimits 的 `addsSoFar + 1 > maxAdds` 改成 `false`
//      → 「stops at maxAdds」与「martingale: add count…」必红（成交条数会从 3 变成 5）。
//   2) src/engine.ts 敞口闸改成「截到上限继续成交」
//      → 「refuses the order that would breach the cap」必红（成交从 1 条变 2 条）。
//   3) src/grid.ts 越界 stop_loss 分支删掉
//      → 「stop_loss: halts on the first out-of-bounds close」必红（会出现成交且 halted 为 null）。
import { describe, expect, it } from 'vitest'
import { MartingaleBot } from '../src/martingale'
import { GridBot } from '../src/grid'
import { PaperLedger } from '../src/ledger'
import { BotStateError } from '../src/errors'
import { runBot } from '../src/engine'
import { series } from './helpers'

describe('counterexample 1 — martingale cap is the only thing stopping the ladder', () => {
  it('stops at exactly maxAdds adds, not one more', () => {
    const run = runBot(
      new MartingaleBot({
        direction: 'long',
        baseNotional: 100,
        multiplier: 2,
        addDropPct: 10,
        maxAdds: 2,
        maxTotalNotional: 100_000,
        takeProfitPct: 99,
        stopLossPct: 0,
        maxExposureNotional: 100_000,
      }),
      series([100, 89, 79, 70, 60, 50]),
    )
    // 首仓 + 2 次加仓 = 3；上限被改坏这里会是 6
    expect(run.fills).toHaveLength(3)
    expect(run.halted?.code).toBe('martingale-max-adds')
  })
})

describe('counterexample 2 — the exposure guard refuses, it never shrinks', () => {
  it('records exactly one fill and halts on the second cell', () => {
    const run = runBot(
      new GridBot({ lowerPrice: 100, upperPrice: 120, gridCount: 4, qtyPerGrid: 0.001, stopLossPct: 0, maxExposureNotional: 0.15 }),
      series([112, 105, 116]),
    )
    expect(run.fills).toHaveLength(1)
    expect(run.fills[0]!.qty).toBeCloseTo(0.001, 12)
    expect(run.halted?.code).toBe('max-exposure')
    expect(run.maxExposure).toBeLessThanOrEqual(0.15 + 1e-9)
  })
})

describe('counterexample 3 — out-of-bounds stop_loss while flat produces no order at all', () => {
  it('halts with zero fills when flat and the first close is below the lower bound', () => {
    const run = runBot(
      new GridBot({ lowerPrice: 100, upperPrice: 120, gridCount: 2, qtyPerGrid: 1, stopLossPct: 0, boundaryAction: 'stop_loss', maxExposureNotional: 1_000 }),
      series([112, 99, 105]),
    )
    expect(run.fills).toHaveLength(0)
    expect(run.halted?.code).toBe('grid-boundary')
  })
})

describe('counterexample 4 — a contradictory ledger read throws, never returns a guess', () => {
  it('throws when a long-only ledger is asked to go net short', () => {
    const ledger = new PaperLedger({ allowShort: false })
    expect(() => ledger.apply('sell', 100, 1, 0)).toThrow(BotStateError)
  })

  it('throws when the fill quantity is not a finite positive number', () => {
    const ledger = new PaperLedger({ allowShort: true })
    expect(() => ledger.apply('buy', 100, 0, 0)).toThrow(BotStateError)
    expect(() => ledger.apply('buy', Number.NaN, 1, 0)).toThrow(BotStateError)
  })

  it('refuses to read an average entry for a flat position after a bad mutation', () => {
    const ledger = new PaperLedger({ allowShort: false })
    ledger.apply('buy', 100, 1, 0)
    ledger.apply('sell', 110, 1, 0)
    expect(ledger.position).toBe(0)
    expect(ledger.avgEntry).toBe(0)
    expect(ledger.realizedPnl).toBeCloseTo(10, 9)
  })
})
