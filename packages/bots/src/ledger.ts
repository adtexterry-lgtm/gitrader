// SPDX-License-Identifier: CPAL-1.0
// 纸面账本：净仓位 + 加权均价 + 已实现盈亏 + 手续费。只做记账，不下单、不查外部状态。
// 任何「账本说不通」的动作（数量非正、长仓机器人卖出超过持仓）一律抛 BotStateError：
// 宁可炸掉这一轮回测，也不把矛盾账当成正常状态继续跑。
import { BotStateError } from './errors'
import type { BotSide } from './types'

export interface LedgerOptions {
  /** 允许净仓位为负（做空模板）。长仓模板置 false：卖出超过持仓即报错。 */
  allowShort: boolean
}

export interface AppliedFill {
  side: BotSide
  price: number
  qty: number
  notional: number
  fee: number
  /** 本笔已实现盈亏（含开仓均价差，未扣手续费）。 */
  pnl: number
  position: number
}

export class PaperLedger {
  private pos = 0
  private avg = 0
  private realized = 0
  private feePaid = 0
  private fills = 0
  private readonly allowShort: boolean

  constructor(opts: LedgerOptions) {
    this.allowShort = opts.allowShort
  }

  get position(): number {
    return this.pos
  }

  get avgEntry(): number {
    return this.avg
  }

  get realizedPnl(): number {
    return this.realized
  }

  get fees(): number {
    return this.feePaid
  }

  get fillCount(): number {
    return this.fills
  }

  /** 未平仓名义额（按传入价格计）。 */
  exposure(price: number): number {
    if (!Number.isFinite(price) || price < 0) {
      throw new BotStateError('position-unreadable', `exposure asked with price=${String(price)}`)
    }
    return Math.abs(this.pos) * price
  }

  unrealized(price: number): number {
    if (this.pos === 0) return 0
    if (!Number.isFinite(price) || price <= 0) {
      throw new BotStateError('position-unreadable', `unrealized asked with price=${String(price)}`)
    }
    return (price - this.avg) * this.pos
  }

  /** 已实现盈亏占开仓均价的比例（带符号，做空时价格下跌为正）。空仓返回 0。 */
  returnPct(price: number): number {
    if (this.pos === 0) return 0
    if (!Number.isFinite(price) || price <= 0 || this.avg <= 0) {
      throw new BotStateError('position-unreadable', `returnPct asked with price=${String(price)} avg=${String(this.avg)}`)
    }
    const sign = this.pos > 0 ? 1 : -1
    return ((price - this.avg) / this.avg) * sign * 100
  }

  apply(side: BotSide, price: number, qty: number, feeRate: number): AppliedFill {
    if (!Number.isFinite(price) || price <= 0) {
      throw new BotStateError('ledger-inconsistent', `fill price must be a finite positive number, got ${String(price)}`)
    }
    if (!Number.isFinite(qty) || qty <= 0) {
      throw new BotStateError('ledger-inconsistent', `fill qty must be a finite positive number, got ${String(qty)}`)
    }
    if (!Number.isFinite(feeRate) || feeRate < 0) {
      throw new BotStateError('ledger-inconsistent', `feeRate must be a finite number >= 0, got ${String(feeRate)}`)
    }
    const signed = side === 'buy' ? qty : -qty
    const nextPos = this.pos + signed
    if (!this.allowShort && nextPos < -1e-12) {
      throw new BotStateError(
        'ledger-short-not-allowed',
        `long-only bot tried to go net short (position ${this.pos} -> ${nextPos})`,
      )
    }
    const notional = price * qty
    const fee = notional * feeRate
    let pnl = 0
    if (this.pos === 0) {
      this.pos = signed
      this.avg = price
    } else if (Math.sign(this.pos) === Math.sign(signed)) {
      const newAbs = Math.abs(this.pos) + qty
      this.avg = (this.avg * Math.abs(this.pos) + price * qty) / newAbs
      this.pos = nextPos
    } else {
      const closing = Math.min(qty, Math.abs(this.pos))
      const sign = this.pos > 0 ? 1 : -1
      pnl = (price - this.avg) * closing * sign
      this.realized += pnl
      if (Math.abs(signed) > Math.abs(this.pos) + 1e-12) {
        // 反向超过持仓：新仓以成交价为均价
        this.avg = price
      }
      this.pos = nextPos
      if (Math.abs(this.pos) < 1e-12) {
        this.pos = 0
        this.avg = 0
      }
    }
    this.feePaid += fee
    this.fills += 1
    return { side, price, qty, notional, fee, pnl, position: this.pos }
  }

  /** 权益：已实现 - 手续费 + 未实现。 */
  equity(price: number, initialCash: number): number {
    if (!Number.isFinite(initialCash)) throw new BotStateError('position-unreadable', 'initialCash must be finite')
    return initialCash + this.realized - this.feePaid + this.unrealized(price)
  }

  /** 状态自洽检查：位置与均价必须同号、有限；不满足即抛。 */
  assertConsistent(): void {
    if (!Number.isFinite(this.pos) || !Number.isFinite(this.avg) || !Number.isFinite(this.realized)) {
      throw new BotStateError('ledger-inconsistent', 'ledger holds a non-finite position, average or realized pnl')
    }
    if (this.pos !== 0 && this.avg <= 0) {
      throw new BotStateError('ledger-inconsistent', `open position ${this.pos} has no positive average entry`)
    }
    if (this.pos === 0 && this.avg !== 0) {
      throw new BotStateError('ledger-inconsistent', `flat ledger still carries average entry ${this.avg}`)
    }
  }
}
