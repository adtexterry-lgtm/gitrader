// SPDX-License-Identifier: CPAL-1.0
// 模板共用的风险判定与小工具。全部是纯判定 + 生成意图，不发送请求。
import { BotStateError } from './errors'
import type { PaperLedger } from './ledger'
import type { OrderIntent } from './types'

/** 止损判定：按开仓均价计的持仓收益率跌破 -pct 即命中。pct<=0 视为关闭。 */
export function stopLossHit(ledger: PaperLedger, price: number, pct: number): boolean {
  if (pct <= 0 || ledger.position === 0) return false
  return ledger.returnPct(price) <= -pct
}

/** 止盈判定：持仓收益率达到 +pct 即命中。pct<=0 视为关闭。 */
export function takeProfitHit(ledger: PaperLedger, price: number, pct: number): boolean {
  if (pct <= 0 || ledger.position === 0) return false
  return ledger.returnPct(price) >= pct
}

/** 全部平仓的意图。空仓时调用是状态矛盾，抛错而不是返回空意图。 */
export function closeAllIntent(ledger: PaperLedger, price: number, reason: string): OrderIntent {
  const pos = ledger.position
  if (pos === 0) {
    throw new BotStateError('ledger-inconsistent', `close-all requested while flat (${reason})`)
  }
  if (!Number.isFinite(price) || price <= 0) {
    throw new BotStateError('order-intent-invalid', `close-all got price=${String(price)}`)
  }
  return { side: pos > 0 ? 'sell' : 'buy', price, qty: Math.abs(pos), reason }
}

/** 意图自检：价格/数量必须有限为正，方向必须合法。 */
export function assertIntent(intent: OrderIntent): void {
  if (intent.side !== 'buy' && intent.side !== 'sell') {
    throw new BotStateError('order-intent-invalid', `unknown order side ${String(intent.side)}`)
  }
  if (!Number.isFinite(intent.price) || intent.price <= 0) {
    throw new BotStateError('order-intent-invalid', `price must be a finite positive number, got ${String(intent.price)}`)
  }
  if (!Number.isFinite(intent.qty) || intent.qty <= 0) {
    throw new BotStateError('order-intent-invalid', `qty must be a finite positive number, got ${String(intent.qty)}`)
  }
}
