// SPDX-License-Identifier: CPAL-1.0
// 定投模板（QD 对齐：strategy_bot_recommend.py 的 dca 参数键 frequency / dipBuyEnabled / dipThreshold，
// 与 strategy_evolution/parameter_space.py 的 _DCA_SPECS 区间；Apache-2.0，只借参数口径不抄码）。
// 语义：按周期买入固定名义额；可选「下跌加买」；下单次数、最大敞口两个上限写进参数校验与运行时。
// 定投只做多，卖出只用于止盈 / 止损平仓。
import { BotParamError, BotStateError } from './errors'
import { PaperLedger } from './ledger'
import { boolOf, intOf, numOf, requireParams, strOf } from './params'
import { closeAllIntent, stopLossHit, takeProfitHit } from './risk'
import { assertSafetyDeclared, capsOf, checkExposure, requireSafetyProvided } from './safety'
import type { BotCaps, BotContext, BotFill, BotHalt, BotParamDef, BotRuntime, BotSnapshot, OrderIntent } from './types'

export const DCA_PARAMS: readonly BotParamDef[] = [
  {
    key: 'frequency',
    label: '定投周期',
    type: 'select',
    default: 'daily',
    options: ['every_bar', 'hourly', '4h', 'daily', 'weekly'],
    help: '按 K 线周期换算的买入节奏',
  },
  { key: 'notionalPerOrder', label: '每期金额(计价币)', type: 'number', default: 100, min: 1, max: 1e9, step: 1, help: '每期买入的名义额' },
  { key: 'maxOrders', label: '最大下单次数', type: 'integer', default: 30, min: 1, max: 500, step: 1, help: '安全上限：累计买入次数达到它即停；必填' },
  { key: 'dipBuyEnabled', label: '下跌加买', type: 'boolean', default: false, help: '价格从上次买入价回落超过阈值时加买一次' },
  { key: 'dipThresholdPct', label: '回落阈值(%)', type: 'number', default: 3, min: 0.1, max: 50, step: 0.1, help: '下跌加买的触发幅度' },
  { key: 'takeProfitPct', label: '止盈(%)', type: 'number', default: 20, min: 0, max: 500, step: 0.5, help: '按持仓收益率止盈；0 关闭' },
  { key: 'stopLossPct', label: '止损(%)', type: 'number', default: 25, min: 0, max: 90, step: 0.5, help: '按持仓收益率止损；0 关闭' },
  { key: 'maxExposureNotional', label: '最大敞口(计价币)', type: 'number', default: 3_000, min: 1, max: 1e12, step: 1, help: '安全上限：持仓名义额超过它即拒单并停机；必填' },
]

const FREQ_MS: Record<string, number> = {
  hourly: 3_600_000,
  '4h': 14_400_000,
  daily: 86_400_000,
  weekly: 604_800_000,
}

export class DcaBot implements BotRuntime {
  readonly template = 'dca' as const
  readonly caps: BotCaps
  private readonly ledger = new PaperLedger({ allowShort: false })
  private readonly frequency: string
  private readonly notionalPerOrder: number
  private readonly maxOrders: number
  private readonly dipBuyEnabled: boolean
  private readonly dipThresholdPct: number
  private readonly takeProfitPct: number
  private readonly stopLossPct: number
  private halt: BotHalt | null = null
  private orders = 0
  private lastBuyPrice = 0
  private lastPeriod = -1

  constructor(input: Record<string, unknown> | undefined) {
    assertSafetyDeclared('dca', DCA_PARAMS)
    requireSafetyProvided('dca', input)
    const p = requireParams(DCA_PARAMS, input)
    this.caps = capsOf('dca', p)
    this.frequency = strOf(p, 'frequency')
    this.notionalPerOrder = numOf(p, 'notionalPerOrder')
    this.maxOrders = intOf(p, 'maxOrders')
    this.dipBuyEnabled = boolOf(p, 'dipBuyEnabled')
    this.dipThresholdPct = numOf(p, 'dipThresholdPct')
    this.takeProfitPct = numOf(p, 'takeProfitPct')
    this.stopLossPct = numOf(p, 'stopLossPct')
    if (this.notionalPerOrder * this.maxOrders > this.caps.maxExposureNotional + 1e-9) {
      throw new BotParamError([
        `maxOrders: ${this.maxOrders} x ${this.notionalPerOrder} exceeds maxExposureNotional ${this.caps.maxExposureNotional}`,
        'maxOrders: lower maxOrders / notionalPerOrder, or raise maxExposureNotional',
      ])
    }
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
      return [closeAllIntent(this.ledger, price, 'dca-stop-loss')]
    }
    if (takeProfitHit(this.ledger, price, this.takeProfitPct)) {
      this.halt = { code: 'take-profit', detail: `position return ${this.ledger.returnPct(price).toFixed(4)}% hit takeProfitPct ${this.takeProfitPct}` }
      return [closeAllIntent(this.ledger, price, 'dca-take-profit')]
    }

    const period = this.periodIndex(ctx)
    const due = period !== this.lastPeriod
    const dip = this.dipBuyEnabled && this.lastBuyPrice > 0 && price <= this.lastBuyPrice * (1 - this.dipThresholdPct / 100)
    if (!due && !dip) return []

    if (this.orders >= this.maxOrders) {
      this.halt = { code: 'max-orders', detail: `orders ${this.orders} reached maxOrders ${this.maxOrders}` }
      return []
    }

    const qty = this.notionalPerOrder / price
    const verdict = checkExposure(this.caps, this.ledger.position, price, qty)
    if (!verdict.ok) {
      this.halt = { code: verdict.code, detail: verdict.detail }
      return []
    }
    if (due) this.lastPeriod = period
    return [{ side: 'buy', price, qty, reason: dip && !due ? 'dca-dip' : 'dca-period' }]
  }

  onFill(fill: BotFill): void {
    this.assertState()
    this.ledger.apply(fill.side, fill.price, fill.qty, fill.feeRate)
    this.ledger.assertConsistent()
    if (fill.side === 'buy') {
      this.orders += 1
      this.lastBuyPrice = fill.price
    }
  }

  snapshot(price: number): BotSnapshot {
    this.assertState()
    return {
      template: 'dca',
      position: this.ledger.position,
      avgEntry: this.ledger.avgEntry,
      realizedPnl: this.ledger.realizedPnl,
      fees: this.ledger.fees,
      exposure: this.ledger.exposure(price),
      halted: this.halt,
      detail: { orders: this.orders, lastBuyPrice: this.lastBuyPrice, frequency: this.frequency, maxOrders: this.maxOrders },
    }
  }

  equity(price: number, initialCash: number): number {
    return this.ledger.equity(price, initialCash)
  }

  private periodIndex(ctx: BotContext): number {
    const periodMs = FREQ_MS[this.frequency] ?? 0
    if (periodMs <= 0) return ctx.i
    if (!Number.isFinite(ctx.intervalMs) || ctx.intervalMs <= 0) {
      throw new BotParamError(['intervalMs: must be a positive number of milliseconds'])
    }
    return Math.floor(ctx.bar.t / periodMs)
  }

  private assertState(): void {
    if (this.caps.maxExposureNotional <= 0) throw new BotParamError(['maxExposureNotional: must be > 0'], 'maxExposureNotional')
    if (!Number.isInteger(this.orders) || this.orders < 0 || this.orders > this.maxOrders) {
      throw new BotStateError('position-unreadable', `dca order counter out of range: ${String(this.orders)}`)
    }
    this.ledger.assertConsistent()
  }
}
