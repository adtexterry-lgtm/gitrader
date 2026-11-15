// SPDX-License-Identifier: CPAL-1.0
// 回测账目审计：从逐笔成交重算分标的的已实现盈亏 / 手续费 / 浮盈 / feeDrag，
// 并按 QD 的加仓 / 减仓 / 反手均价法则维护仓位，附现金与数量对账。
import type { BacktestTrade } from './types'

/** 浮点比较容差（仓位视为 0 的阈值）。 */
const EPS = 1e-12
/** 数量对账允许的误差。 */
const MISMATCH_EPS = 1e-8

export interface SymbolLedger {
  instrumentId: string
  realizedPnl: number
  fees: number
  netRealized: number
  unrealizedPnl: number
  position: number
  avgEntry: number | null
  /** fees / |grossRealized|，分母 0 → null */
  feeDrag: number | null
  /** Σ price·size */
  turnover: number
}

export interface LedgerAudit {
  bySymbol: Record<string, SymbolLedger>
  totals: Omit<SymbolLedger, 'instrumentId' | 'avgEntry' | 'position'>
  cash: { reported: number | null; recomputed: number; mismatch: number | null }
  qtyMismatch: Record<string, number>
  warnings: string[]
}

/** 每标的重算过程中的中间状态。 */
interface SymbolState {
  position: number
  avgEntry: number
  realizedPnl: number
  fees: number
  turnover: number
}

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/strategy_v2/runtime.py:2812; adapted.
/** 加仓按加权平均、减仓保持原均价、反手后新仓均价 = 反手成交价。 */
function nextAverageCost(
  oldAmount: number,
  oldCost: number,
  delta: number,
  fillPrice: number,
): number {
  const newAmount = oldAmount + delta
  if (Math.abs(newAmount) <= EPS) return 0
  if (Math.abs(oldAmount) <= EPS || oldAmount * delta > 0) {
    return (oldAmount * oldCost + delta * fillPrice) / newAmount
  }
  if (oldAmount * newAmount < 0) return fillPrice
  return oldCost
}

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/strategy_v2/runtime.py:1524; adapted.
/** 手续费按量分摊：本笔成交中平掉旧仓的数量占比。 */
function closingQuantity(oldAmount: number, delta: number): number {
  if (oldAmount * delta >= 0) return 0
  return Math.min(Math.abs(oldAmount), Math.abs(delta))
}

function feeDragOf(fees: number, grossRealized: number): number | null {
  if (Math.abs(grossRealized) <= 0) return null
  return fees / Math.abs(grossRealized)
}

function isFiniteTrade(trade: BacktestTrade): boolean {
  return (
    Number.isFinite(trade.price) &&
    Number.isFinite(trade.size) &&
    Number.isFinite(trade.fee)
  )
}

/**
 * 从逐笔成交重算：按 QD 的加仓 / 减仓 / 反手均价法则（runtime.py:2812 附近，读源码）维护每标的仓位与均价；
 * 已实现盈亏按量分摊手续费；marks 给出各标的末期标记价算浮盈；initialCash 给出时重算现金并与 reportedCash 对比。
 */
export function auditTrades(
  trades: readonly (BacktestTrade & { instrumentId?: string })[],
  opts?: {
    initialCash?: number
    reportedCash?: number
    marks?: Record<string, number>
    reportedPositions?: Record<string, number>
  },
): LedgerAudit {
  const warnings: string[] = []
  const states = new Map<string, SymbolState>()
  const cashFlow = { value: 0 }

  for (let index = 0; index < trades.length; index += 1) {
    const trade = trades[index]
    if (trade === undefined) continue
    if (!isFiniteTrade(trade)) {
      warnings.push(
        `成交 #${index} 含非有限数（price=${String(trade.price)} size=${String(trade.size)} fee=${String(trade.fee)}），已跳过`,
      )
      continue
    }

    const instrumentId = trade.instrumentId ?? 'default'
    let state = states.get(instrumentId)
    if (state === undefined) {
      state = { position: 0, avgEntry: 0, realizedPnl: 0, fees: 0, turnover: 0 }
      states.set(instrumentId, state)
    }

    const oldAmount = state.position
    const delta = trade.side === 'buy' ? trade.size : -trade.size
    const closed = closingQuantity(oldAmount, delta)

    // Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/strategy_v2/runtime.py:1524; adapted.
    // 已实现盈亏按平掉的旧仓数量与旧仓均价计算（手续费另计）。
    if (closed > EPS) {
      const direction = oldAmount > 0 ? 1 : -1
      state.realizedPnl += (trade.price - state.avgEntry) * closed * direction
    }

    state.avgEntry = nextAverageCost(oldAmount, state.avgEntry, delta, trade.price)
    state.position = oldAmount + delta
    if (Math.abs(state.position) <= EPS) {
      state.position = 0
      state.avgEntry = 0
    }
    state.fees += trade.fee
    state.turnover += trade.price * trade.size

    const signedQuantity = delta
    cashFlow.value -= signedQuantity * trade.price + trade.fee
  }

  const marks = opts?.marks
  const bySymbol: Record<string, SymbolLedger> = {}
  for (const [instrumentId, state] of states) {
    const position = Math.abs(state.position) <= EPS ? 0 : state.position
    const mark = marks?.[instrumentId]
    const unrealizedPnl =
      position !== 0 && mark !== undefined && Number.isFinite(mark)
        ? (mark - state.avgEntry) * position
        : 0
    bySymbol[instrumentId] = {
      instrumentId,
      realizedPnl: state.realizedPnl,
      fees: state.fees,
      netRealized: state.realizedPnl - state.fees,
      unrealizedPnl,
      position,
      avgEntry: position === 0 ? null : state.avgEntry,
      feeDrag: feeDragOf(state.fees, state.realizedPnl),
      turnover: state.turnover,
    }
  }

  let realizedPnl = 0
  let fees = 0
  let unrealizedPnl = 0
  let turnover = 0
  for (const ledger of Object.values(bySymbol)) {
    realizedPnl += ledger.realizedPnl
    fees += ledger.fees
    unrealizedPnl += ledger.unrealizedPnl
    turnover += ledger.turnover
  }
  const totals = {
    realizedPnl,
    fees,
    netRealized: realizedPnl - fees,
    unrealizedPnl,
    feeDrag: feeDragOf(fees, realizedPnl),
    turnover,
  }

  // Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/strategy_v2/runtime.py:2188; adapted.
  const initialCash = opts?.initialCash
  const recomputedCash = (initialCash ?? 0) + cashFlow.value
  const reportedCash = opts?.reportedCash ?? null
  const cash = {
    reported: reportedCash,
    recomputed: recomputedCash,
    mismatch:
      reportedCash !== null && initialCash !== undefined
        ? recomputedCash - reportedCash
        : null,
  }

  const qtyMismatch: Record<string, number> = {}
  const reportedPositions = opts?.reportedPositions
  if (reportedPositions !== undefined) {
    for (const [instrumentId, reported] of Object.entries(reportedPositions)) {
      if (!Number.isFinite(reported)) {
        warnings.push(`标的 ${instrumentId} 的对账数量非有限数（${String(reported)}），已跳过`)
        continue
      }
      const recomputed = bySymbol[instrumentId]?.position ?? 0
      const difference = reported - recomputed
      if (Math.abs(difference) > MISMATCH_EPS) {
        qtyMismatch[instrumentId] = difference
        warnings.push(
          `标的 ${instrumentId} 数量不一致：重算 ${recomputed}，报告 ${reported}，差 ${difference}`,
        )
      }
    }
  }

  return { bySymbol, totals, cash, qtyMismatch, warnings }
}
