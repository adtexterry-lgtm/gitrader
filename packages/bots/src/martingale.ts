// SPDX-License-Identifier: CPAL-1.0
// 马丁模板（QD 对齐：strategy_bot_recommend.py 的 martingale 参数键 multiplier(1.1-3.0) / maxLayers(2-10) /
// priceDropPct / takeProfitPct / stopLossPct / direction，与 bot_scripts/grid_runtime.py 的 waterfall 保护思路：
// 级联行情里先停手。Apache-2.0，只借参数口径与保护思路，不抄码）。
// 安全上限写在参数校验与运行时两处：最大加仓次数 maxAdds、最大总名义额 maxTotalNotional，任一触碰即停机。
// maxAdds 是「加仓次数」（不含首仓），QD 的 maxLayers 是含首仓的层数，二者换算 maxAdds = maxLayers - 1。
import { BotParamError, BotStateError } from './errors'
import { PaperLedger } from './ledger'
import { numOf, requireParams, strOf } from './params'
import { closeAllIntent, stopLossHit, takeProfitHit } from './risk'
import { assertSafetyDeclared, capsOf, checkExposure, checkMartingaleLimits, requireSafetyProvided } from './safety'
import type { BotCaps, BotContext, BotFill, BotHalt, BotParamDef, BotRuntime, BotSnapshot, OrderIntent } from './types'

export const MARTINGALE_PARAMS: readonly BotParamDef[] = [
  { key: 'direction', label: '方向', type: 'select', default: 'long', options: ['long', 'short'], help: '首次开仓方向；加仓同向' },
  { key: 'baseNotional', label: '首仓名义额(计价币)', type: 'number', default: 100, min: 1, max: 1e9, step: 1, help: '首仓金额，后续按倍数放大' },
  { key: 'multiplier', label: '加仓倍数', type: 'number', default: 1.5, min: 1.05, max: 3, step: 0.05, help: '每次加仓名义额 = 上次 × 倍数' },
  { key: 'addDropPct', label: '加仓触发回撤(%)', type: 'number', default: 2, min: 0.1, max: 50, step: 0.1, help: '价格相对上次成交价不利变动超过它才加仓' },
  { key: 'maxAdds', label: '最大加仓次数', type: 'integer', default: 4, min: 0, max: 20, step: 1, help: '安全上限（不含首仓）：加仓次数到顶即停；必填' },
  { key: 'maxTotalNotional', label: '最大总名义额(计价币)', type: 'number', default: 1_000, min: 1, max: 1e12, step: 1, help: '安全上限：累计开仓名义额超过它即停；必填' },
  { key: 'takeProfitPct', label: '止盈(%)', type: 'number', default: 3, min: 0.1, max: 100, step: 0.1, help: '按持仓均价止盈，平掉全部仓位后停机' },
  { key: 'stopLossPct', label: '止损(%)', type: 'number', default: 15, min: 0, max: 90, step: 0.5, help: '按持仓均价止损；0 关闭' },
  { key: 'maxExposureNotional', label: '最大敞口(计价币)', type: 'number', default: 2_000, min: 1, max: 1e12, step: 1, help: '安全上限：持仓名义额超过它即拒单并停机；必填' },
]

export class MartingaleBot implements BotRuntime {
  readonly template = 'martingale' as const
  readonly caps: BotCaps
  private readonly ledger: PaperLedger
  private readonly direction: 'long' | 'short'
  private readonly baseNotional: number
  private readonly multiplier: number
  private readonly addDropPct: number
  private readonly takeProfitPct: number
  private readonly stopLossPct: number
  private halt: BotHalt | null = null
  private adds = 0
  private totalNotional = 0
  private lastFillPrice = 0

  constructor(input: Record<string, unknown> | undefined) {
    assertSafetyDeclared('martingale', MARTINGALE_PARAMS)
    requireSafetyProvided('martingale', input)
    const p = requireParams(MARTINGALE_PARAMS, input)
    this.caps = capsOf('martingale', p)
    this.direction = strOf(p, 'direction') as 'long' | 'short'
    this.baseNotional = numOf(p, 'baseNotional')
    this.multiplier = numOf(p, 'multiplier')
    this.addDropPct = numOf(p, 'addDropPct')
    this.takeProfitPct = numOf(p, 'takeProfitPct')
    this.stopLossPct = numOf(p, 'stopLossPct')
    if (this.multiplier < 1) throw new BotParamError(['multiplier: must be >= 1 (a smaller add would not be a martingale)'])
    if (this.baseNotional > (this.caps.maxTotalNotional ?? 0) + 1e-9) {
      throw new BotParamError([
        `baseNotional: first order ${this.baseNotional} already exceeds maxTotalNotional ${this.caps.maxTotalNotional}`,
        'baseNotional: lower baseNotional or raise maxTotalNotional',
      ])
    }
    if (this.baseNotional > this.caps.maxExposureNotional + 1e-9) {
      throw new BotParamError([`baseNotional: first order ${this.baseNotional} already exceeds maxExposureNotional ${this.caps.maxExposureNotional}`])
    }
    this.ledger = new PaperLedger({ allowShort: this.direction === 'short' })
  }

  onBar(ctx: BotContext): OrderIntent[] {
    this.assertState()
    if (this.halt) return []
    const price = ctx.bar.c
    if (!Number.isFinite(price) || price <= 0) {
      throw new BotStateError('candle-invalid', `bar close must be a finite positive number, got ${String(price)}`)
    }

    if (stopLossHit(this.ledger, price, this.stopLossPct)) {
      this.halt = { code: 'stop-loss', detail: `position return ${this.ledger.returnPct(price).toFixed(4)}% hit stopLossPct ${this.stopLossPct}` }
      return [closeAllIntent(this.ledger, price, 'martingale-stop-loss')]
    }
    if (takeProfitHit(this.ledger, price, this.takeProfitPct)) {
      this.halt = { code: 'take-profit', detail: `position return ${this.ledger.returnPct(price).toFixed(4)}% hit takeProfitPct ${this.takeProfitPct}` }
      return [closeAllIntent(this.ledger, price, 'martingale-take-profit')]
    }

    if (this.ledger.position === 0 && this.totalNotional === 0) {
      const first = checkExposure(this.caps, 0, price, this.signedQty(this.baseNotional / price))
      if (!first.ok) {
        this.halt = { code: first.code, detail: first.detail }
        return []
      }
      return [this.openIntent(price, this.baseNotional, 'martingale-open')]
    }
    if (this.ledger.position === 0) return []

    const adverse = this.direction === 'long'
      ? price <= this.lastFillPrice * (1 - this.addDropPct / 100)
      : price >= this.lastFillPrice * (1 + this.addDropPct / 100)
    if (!adverse) return []

    const nextNotional = this.baseNotional * Math.pow(this.multiplier, this.adds + 1)
    const verdict = checkMartingaleLimits(this.caps, this.adds, this.totalNotional, nextNotional)
    if (!verdict.ok) {
      // 停机，不改小数量继续加：截断会让「最大总名义额」形同虚设
      this.halt = { code: verdict.code, detail: verdict.detail }
      return []
    }
    const exposure = checkExposure(this.caps, this.ledger.position, price, this.signedQty(nextNotional / price))
    if (!exposure.ok) {
      this.halt = { code: exposure.code, detail: exposure.detail }
      return []
    }
    return [this.openIntent(price, nextNotional, 'martingale-add')]
  }

  onFill(fill: BotFill): void {
    this.assertState()
    this.ledger.apply(fill.side, fill.price, fill.qty, fill.feeRate)
    this.ledger.assertConsistent()
    if (fill.reason === 'martingale-open' || fill.reason === 'martingale-add') {
      if (fill.reason === 'martingale-add') this.adds += 1
      this.totalNotional += fill.notional
      this.lastFillPrice = fill.price
    }
  }

  snapshot(price: number): BotSnapshot {
    this.assertState()
    return {
      template: 'martingale',
      position: this.ledger.position,
      avgEntry: this.ledger.avgEntry,
      realizedPnl: this.ledger.realizedPnl,
      fees: this.ledger.fees,
      exposure: this.ledger.exposure(price),
      halted: this.halt,
      detail: {
        adds: this.adds,
        maxAdds: this.caps.maxAdds ?? 0,
        totalNotional: this.totalNotional,
        maxTotalNotional: this.caps.maxTotalNotional ?? 0,
        lastFillPrice: this.lastFillPrice,
      },
    }
  }

  equity(price: number, initialCash: number): number {
    return this.ledger.equity(price, initialCash)
  }

  private signedQty(qty: number): number {
    return this.direction === 'long' ? qty : -qty
  }

  private openIntent(price: number, notional: number, reason: string): OrderIntent {
    const qty = notional / price
    if (!Number.isFinite(qty) || qty <= 0) {
      throw new BotStateError('order-intent-invalid', `computed qty ${String(qty)} from notional ${notional} at ${price}`)
    }
    return { side: this.direction === 'long' ? 'buy' : 'sell', price, qty, reason }
  }

  private assertState(): void {
    if (this.adds < 0 || (this.caps.maxAdds !== undefined && this.adds > this.caps.maxAdds)) {
      throw new BotStateError('position-unreadable', `martingale add counter out of range: ${this.adds}`)
    }
    if (this.totalNotional < 0 || !Number.isFinite(this.totalNotional)) {
      throw new BotStateError('position-unreadable', `martingale total notional is not a finite non-negative number: ${String(this.totalNotional)}`)
    }
    this.ledger.assertConsistent()
  }
}
