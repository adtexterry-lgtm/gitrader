// SPDX-License-Identifier: CPAL-1.0
// 趋势模板（QD 对齐：strategy_bot_recommend.py 的 trend 参数键 maPeriod(5-200) / maType SMA|EMA /
// confirmBars(1-5) / positionPct(10-100) / direction long|short|both / 移动止盈三件；Apache-2.0，只借参数口径）。
// 语义：收盘价在均线上方（下方）连续 confirmBars 根才进场；反向穿越或移动止损出场。
// 均线只用已收盘 K 线，不看未来；预热不足时不下单（预热不是错误，读数失败才是）。
import { BotParamError, BotStateError } from './errors'
import { PaperLedger } from './ledger'
import { intOf, numOf, requireParams, strOf } from './params'
import { assertIntent, closeAllIntent, stopLossHit } from './risk'
import { assertSafetyDeclared, capsOf, checkExposure, requireSafetyProvided } from './safety'
import type { BotCaps, BotContext, BotFill, BotHalt, BotParamDef, BotRuntime, BotSnapshot, OrderIntent } from './types'

export const TREND_PARAMS: readonly BotParamDef[] = [
  { key: 'maPeriod', label: '均线周期', type: 'integer', default: 50, min: 2, max: 500, step: 1, help: '收盘价均线长度' },
  { key: 'maType', label: '均线类型', type: 'select', default: 'SMA', options: ['SMA', 'EMA'], help: '简单 / 指数移动平均' },
  { key: 'confirmBars', label: '确认根数', type: 'integer', default: 2, min: 1, max: 10, step: 1, help: '连续多少根同向才进场' },
  { key: 'positionPct', label: '仓位占敞口比例(%)', type: 'number', default: 50, min: 1, max: 100, step: 1, help: '下单名义额 = 最大敞口 × 该比例' },
  { key: 'direction', label: '方向', type: 'select', default: 'both', options: ['long', 'short', 'both'], help: '只做多 / 只做空 / 双向' },
  { key: 'trailingStopPct', label: '移动止损(%)', type: 'number', default: 5, min: 0, max: 50, step: 0.5, help: '从持仓后极值回撤该幅度即出场；0 关闭' },
  { key: 'stopLossPct', label: '止损(%)', type: 'number', default: 8, min: 0, max: 90, step: 0.5, help: '按持仓均价止损；0 关闭' },
  { key: 'maxExposureNotional', label: '最大敞口(计价币)', type: 'number', default: 10_000, min: 1, max: 1e12, step: 1, help: '安全上限：持仓名义额超过它即拒单并停机；必填' },
]

export class TrendBot implements BotRuntime {
  readonly template = 'trend' as const
  readonly caps: BotCaps
  private readonly ledger: PaperLedger
  private readonly maPeriod: number
  private readonly maType: 'SMA' | 'EMA'
  private readonly confirmBars: number
  private readonly positionPct: number
  private readonly direction: 'long' | 'short' | 'both'
  private readonly trailingStopPct: number
  private readonly stopLossPct: number
  private readonly closes: number[] = []
  private confirm = 0
  private lastSignal: 'long' | 'short' | null = null
  private extreme = 0
  private halt: BotHalt | null = null

  constructor(input: Record<string, unknown> | undefined) {
    assertSafetyDeclared('trend', TREND_PARAMS)
    requireSafetyProvided('trend', input)
    const p = requireParams(TREND_PARAMS, input)
    this.caps = capsOf('trend', p)
    this.maPeriod = intOf(p, 'maPeriod')
    this.maType = strOf(p, 'maType') as 'SMA' | 'EMA'
    this.confirmBars = intOf(p, 'confirmBars')
    this.positionPct = numOf(p, 'positionPct')
    this.direction = strOf(p, 'direction') as 'long' | 'short' | 'both'
    this.trailingStopPct = numOf(p, 'trailingStopPct')
    this.stopLossPct = numOf(p, 'stopLossPct')
    if (this.confirmBars > this.maPeriod) {
      throw new BotParamError(['confirmBars: must not exceed maPeriod (preheat would never finish)'])
    }
    this.ledger = new PaperLedger({ allowShort: this.direction !== 'long' })
  }

  onBar(ctx: BotContext): OrderIntent[] {
    this.assertState()
    const price = ctx.bar.c
    if (!Number.isFinite(price) || price <= 0) {
      throw new BotStateError('candle-invalid', `bar close must be a finite positive number, got ${String(price)}`)
    }
    this.closes.push(price)
    if (this.halt) return []
    const ma = this.movingAverage()
    if (ma === null) return []

    const signal: 'long' | 'short' | null = price > ma ? 'long' : price < ma ? 'short' : null
    if (signal !== null && signal === this.lastSignal) this.confirm += 1
    else if (signal !== null) { this.lastSignal = signal; this.confirm = 1 } else this.confirm = 0

    if (this.ledger.position !== 0) {
      const pos = this.ledger.position
      this.extreme = pos > 0 ? Math.max(this.extreme, price) : Math.min(this.extreme, price)
      if (stopLossHit(this.ledger, price, this.stopLossPct)) {
        this.halt = { code: 'stop-loss', detail: `position return ${this.ledger.returnPct(price).toFixed(4)}% hit stopLossPct ${this.stopLossPct}` }
        return [closeAllIntent(this.ledger, price, 'trend-stop-loss')]
      }
      if (this.trailingStopPct > 0) {
        const trailHit = pos > 0
          ? price <= this.extreme * (1 - this.trailingStopPct / 100)
          : price >= this.extreme * (1 + this.trailingStopPct / 100)
        if (trailHit) {
          this.halt = { code: 'trailing-stop', detail: `price ${price} retraced ${this.trailingStopPct}% from ${this.extreme}` }
          return [closeAllIntent(this.ledger, price, 'trend-trailing-stop')]
        }
      }
      const flipped = (pos > 0 && signal === 'short') || (pos < 0 && signal === 'long')
      if (flipped) {
        this.halt = { code: 'trend-signal-flat', detail: `close crossed the moving average against the position (ma=${ma})` }
        return [closeAllIntent(this.ledger, price, 'trend-flip')]
      }
      return []
    }

    if (this.confirm < this.confirmBars || signal === null) return []
    if (signal === 'long' && this.direction === 'short') return []
    if (signal === 'short' && this.direction === 'long') return []
    const notional = this.caps.maxExposureNotional * (this.positionPct / 100)
    const qty = notional / price
    const signed = signal === 'long' ? qty : -qty
    const verdict = checkExposure(this.caps, this.ledger.position, price, signed)
    if (!verdict.ok) {
      this.halt = { code: verdict.code, detail: verdict.detail }
      return []
    }
    const intent: OrderIntent = { side: signal === 'long' ? 'buy' : 'sell', price, qty, reason: signal === 'long' ? 'trend-enter-long' : 'trend-enter-short' }
    assertIntent(intent)
    return [intent]
  }

  onFill(fill: BotFill): void {
    this.assertState()
    this.ledger.apply(fill.side, fill.price, fill.qty, fill.feeRate)
    this.ledger.assertConsistent()
    if (fill.reason.startsWith('trend-enter')) this.extreme = fill.price
  }

  snapshot(price: number): BotSnapshot {
    this.assertState()
    return {
      template: 'trend',
      position: this.ledger.position,
      avgEntry: this.ledger.avgEntry,
      realizedPnl: this.ledger.realizedPnl,
      fees: this.ledger.fees,
      exposure: this.ledger.exposure(price),
      halted: this.halt,
      detail: { maPeriod: this.maPeriod, maType: this.maType, confirm: this.confirm, bars: this.closes.length, extreme: this.extreme },
    }
  }

  equity(price: number, initialCash: number): number {
    return this.ledger.equity(price, initialCash)
  }

  /** 均线：预热不足返回 null（不是错误）。EMA 用前 maPeriod 根的简单均值做种子。 */
  private movingAverage(): number | null {
    if (this.closes.length < this.maPeriod) return null
    if (this.maType === 'SMA') {
      let sum = 0
      for (let k = this.closes.length - this.maPeriod; k < this.closes.length; k++) sum += this.closes[k] as number
      return sum / this.maPeriod
    }
    const k = 2 / (this.maPeriod + 1)
    let ema = 0
    for (let i = 0; i < this.maPeriod; i++) ema += this.closes[i] as number
    ema /= this.maPeriod
    for (let i = this.maPeriod; i < this.closes.length; i++) ema = (this.closes[i] as number) * k + ema * (1 - k)
    return ema
  }

  private assertState(): void {
    if (!Number.isFinite(this.extreme)) throw new BotStateError('position-unreadable', 'trend extreme price is not finite')
    if (this.confirm < 0) throw new BotStateError('position-unreadable', `trend confirm counter is negative: ${this.confirm}`)
    this.ledger.assertConsistent()
  }
}
