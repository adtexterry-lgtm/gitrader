// SPDX-License-Identifier: CPAL-1.0
// ledger-audit.ts 的单元测试：分标的已实现 / 手续费 / 浮盈 / feeDrag、现金与数量对账，全部手算。
import { describe, expect, it } from 'vitest'
import { auditTrades } from '../src/strategy/ledger-audit'
import type { BacktestTrade } from '../src/strategy/types'

type TestTrade = BacktestTrade & { instrumentId?: string }

let seq = 0

/** 造一笔成交；pnl 不参与审计，统一填 0。 */
function tr(
  side: 'buy' | 'sell',
  price: number,
  size: number,
  fee = 0,
  extra?: { instrumentId?: string },
): TestTrade {
  seq += 1
  return { t: seq, side, price, size, pnl: 0, fee, reason: 'test', ...extra }
}

describe('auditTrades 单标的已实现与费用', () => {
  it('买 1@100 卖 1@110：毛利 10、费用 0.21、净 9.79、feeDrag 0.021、turnover 210', () => {
    const trades = [tr('buy', 100, 1, 0.1), tr('sell', 110, 1, 0.11)]
    const audit = auditTrades(trades, { initialCash: 1000, reportedCash: 1009.79 })
    const ledger = audit.bySymbol['default']
    expect(ledger).toBeDefined()
    expect(ledger!.realizedPnl).toBeCloseTo(10)
    expect(ledger!.fees).toBeCloseTo(0.21)
    expect(ledger!.netRealized).toBeCloseTo(9.79)
    expect(ledger!.position).toBe(0)
    expect(ledger!.avgEntry).toBeNull()
    expect(ledger!.feeDrag).not.toBeNull()
    expect(ledger!.feeDrag!).toBeCloseTo(0.021)
    expect(ledger!.turnover).toBeCloseTo(210)

    expect(audit.totals.realizedPnl).toBeCloseTo(10)
    expect(audit.totals.fees).toBeCloseTo(0.21)
    expect(audit.totals.netRealized).toBeCloseTo(9.79)
    expect(audit.totals.turnover).toBeCloseTo(210)
    expect(audit.totals.feeDrag!).toBeCloseTo(0.021)

    expect(audit.cash.recomputed).toBeCloseTo(1009.79)
    expect(audit.cash.reported).toBeCloseTo(1009.79)
    expect(audit.cash.mismatch!).toBeCloseTo(0)

    const mismatched = auditTrades(trades, { initialCash: 1000, reportedCash: 1000 })
    expect(mismatched.cash.mismatch!).toBeCloseTo(9.79)
  })

  it('加仓按加权均价，减仓不改变均价', () => {
    const opened = auditTrades([tr('buy', 100, 1), tr('buy', 120, 1)])
    const openedLedger = opened.bySymbol['default']!
    expect(openedLedger.avgEntry).toBeCloseTo(110)
    expect(openedLedger.position).toBe(2)
    expect(openedLedger.realizedPnl).toBeCloseTo(0)

    const reduced = auditTrades([tr('buy', 100, 1), tr('buy', 120, 1), tr('sell', 130, 1)])
    const reducedLedger = reduced.bySymbol['default']!
    expect(reducedLedger.realizedPnl).toBeCloseTo(20)
    expect(reducedLedger.position).toBe(1)
    expect(reducedLedger.avgEntry).toBeCloseTo(110)
  })

  it('反手：平旧仓按旧均价，新仓均价等于反手价', () => {
    const audit = auditTrades([tr('buy', 100, 1), tr('sell', 90, 2)])
    const ledger = audit.bySymbol['default']!
    expect(ledger.realizedPnl).toBeCloseTo(-10)
    expect(ledger.position).toBe(-1)
    expect(ledger.avgEntry).toBeCloseTo(90)
  })
})

describe('auditTrades 浮盈', () => {
  it('多头 1@100，标记价 105 → 浮盈 5', () => {
    const audit = auditTrades([tr('buy', 100, 1)], { marks: { default: 105 } })
    expect(audit.bySymbol['default']!.unrealizedPnl).toBeCloseTo(5)
  })

  it('空头 −1@100，标记价 95 → 浮盈 5', () => {
    const audit = auditTrades([tr('sell', 100, 1)], { marks: { default: 95 } })
    const ledger = audit.bySymbol['default']!
    expect(ledger.position).toBe(-1)
    expect(ledger.unrealizedPnl).toBeCloseTo(5)
  })
})

describe('auditTrades 多标的与对账', () => {
  it('bySymbol 按标的拆分，totals 为各标之和', () => {
    const trades = [
      tr('buy', 100, 1, 0.1, { instrumentId: 'a' }),
      tr('sell', 110, 1, 0.11, { instrumentId: 'a' }),
      tr('buy', 50, 2, 0.2, { instrumentId: 'b' }),
      tr('sell', 60, 1, 0.12, { instrumentId: 'b' }),
    ]
    const audit = auditTrades(trades)
    expect(Object.keys(audit.bySymbol).sort()).toEqual(['a', 'b'])
    const a = audit.bySymbol['a']!
    const b = audit.bySymbol['b']!
    expect(a.realizedPnl).toBeCloseTo(10)
    expect(b.realizedPnl).toBeCloseTo(10)
    expect(a.turnover).toBeCloseTo(210)
    expect(b.turnover).toBeCloseTo(160)
    expect(b.position).toBe(1)
    expect(b.avgEntry).toBeCloseTo(50)

    expect(audit.totals.realizedPnl).toBeCloseTo(20)
    expect(audit.totals.fees).toBeCloseTo(0.53)
    expect(audit.totals.netRealized).toBeCloseTo(19.47)
    expect(audit.totals.turnover).toBeCloseTo(370)
    expect(audit.totals.unrealizedPnl).toBeCloseTo(0)
    expect(audit.totals.feeDrag!).toBeCloseTo(0.53 / 20)
  })

  it('数量对账：报告 2、重算 1 → 差异 1 且一条 warning', () => {
    const audit = auditTrades([tr('buy', 100, 1)], { reportedPositions: { default: 2 } })
    expect(audit.qtyMismatch['default']).toBeCloseTo(1)
    expect(audit.warnings.length).toBe(1)
  })

  it('数量一致时不产生差异与 warning', () => {
    const audit = auditTrades([tr('buy', 100, 1)], { reportedPositions: { default: 1 } })
    expect(audit.qtyMismatch['default']).toBeUndefined()
    expect(audit.warnings.length).toBe(0)
  })

  it('非有限数成交被跳过并 warning，不抛异常', () => {
    const audit = auditTrades([tr('buy', Number.NaN, 1, 0.1)], { initialCash: 1000 })
    expect(audit.warnings.length).toBe(1)
    expect(Object.keys(audit.bySymbol).length).toBe(0)
    expect(audit.totals.realizedPnl).toBe(0)
    expect(audit.cash.recomputed).toBeCloseTo(1000)
  })
})
