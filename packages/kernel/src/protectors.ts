// SPDX-License-Identifier: CPAL-1.0
// 保护器引擎（契约 §1.4.10）：止损次数、回撤暂停、低收益锁定、连续失败熔断。可叠加；触发 = 作用域进入 REDUCING 若干分钟 + 入账"撞了哪条规则"。
// cooldown 是下单前检查，在风控闸里。插件提供的保护器（protector.evaluate）经插件宿主接入，只能拒绝或收紧。
import type { Fill, Order, Protector, RuleHit, TradingScope } from './proto'
import type { EventBus } from './events'
import type { Ledger } from './ledger'
import type { OrderStore } from './orders'
import type { RiskService } from './risk'
import type { TradingStateService } from './trading-state'
import * as d from './util/dec'
import { mkOrigin } from './util/origin'
import type { Clock } from './util/clock'

const STOP_TYPES = new Set(['stop_market', 'stop_limit', 'trailing_stop'])

export class ProtectorEngine {
  private failures = new Map<string, number>()
  private equity = new Map<string, { ts: number; v: d.Dec }[]>()

  constructor(private risk: RiskService, private tstate: TradingStateService, private orders: OrderStore, private ledger: Ledger, private events: EventBus, private clock: Clock) {}

  private protectors(): Protector[] { return this.risk.current()?.protectors ?? [] }

  private trigger(p: Protector, accountId: string, scope: TradingScope, minutes: number, limit: string, actual: string, unit: string, message: string): void {
    const policyId = this.risk.current()?.policyId ?? 'pol_none'
    const hit: RuleHit = { ruleId: `${policyId}#${p.kind}`, code: 'PROTECTOR', message, limit: limit as RuleHit['limit'], actual: actual as RuleHit['actual'], unit, action: 'deny', scope: scope.type }
    const origin = mkOrigin('system:protector', `protector:${p.kind}`, 'internal')
    this.ledger.append({ type: 'protector.triggered', origin, subject: { accountId: accountId as `acct_${string}`, ...(scope.type === 'instrument' ? { instrumentId: scope.id } : {}) }, ruleHits: [hit], payload: { protector: p.kind, scope, pauseMin: minutes } })
    this.tstate.pause(scope, minutes, message, p.kind, origin)
    this.events.publish('risk.denials', { accountId, hit })
  }

  /** 成交后：止损次数 / 低收益锁定。 */
  onFill(order: Order | undefined, fill: Fill, equity?: d.Dec): void {
    const now = this.clock.now()
    for (const p of this.protectors()) {
      if (p.kind === 'stoploss_guard' && order && (STOP_TYPES.has(order.type) || order.tpslRole === 'sl') && d.isNeg(d.D(fill.realizedPnl))) {
        const since = now - p.windowMin * 60_000
        const stops = this.orders.fillsSince(fill.accountId, since).filter((f) => {
          if (!d.isNeg(d.D(f.realizedPnl))) return false
          if (p.scope === 'instrument' && f.instrumentId !== fill.instrumentId) return false
          const o = this.orders.get(f.orderId)
          return !!o && (STOP_TYPES.has(o.type) || o.tpslRole === 'sl')
        }).length
        if (stops >= p.maxStoplosses) {
          const scope: TradingScope = p.scope === 'instrument' ? { type: 'instrument', id: fill.instrumentId } : { type: 'account', id: fill.accountId }
          this.trigger(p, fill.accountId, scope, p.pauseMin, String(p.maxStoplosses), String(stops), 'stoplosses', `stoploss guard: ${stops} stop-losses within ${p.windowMin} min`)
        }
      }
      if (p.kind === 'low_profit_lock' && equity && d.gt(equity, d.ZERO)) {
        const since = now - p.windowHours * 3_600_000
        const mine = this.orders.fillsSince(fill.accountId, since).filter((f) => f.instrumentId === fill.instrumentId && !d.isZero(d.D(f.realizedPnl)))
        if (mine.length > 0) {
          const ratio = d.div(mine.reduce((s, f) => d.add(s, d.D(f.realizedPnl)), d.ZERO), equity)
          if (d.lt(ratio, d.D(p.minProfitRatio))) this.trigger(p, fill.accountId, { type: 'instrument', id: fill.instrumentId }, p.lockMin, p.minProfitRatio, d.str(ratio), 'ratio', `low profit lock: ${fill.instrumentId} realized ${d.str(ratio)} < ${p.minProfitRatio}`)
        }
      }
    }
  }

  /** 下单结果：场所拒绝 / 超时算失败；成功清零。 */
  onSubmitOutcome(accountId: string, ok: boolean): void {
    if (ok) { this.failures.delete(accountId); return }
    const n = (this.failures.get(accountId) ?? 0) + 1
    this.failures.set(accountId, n)
    for (const p of this.protectors()) {
      if (p.kind === 'max_consecutive_failures' && n >= p.count) {
        this.failures.set(accountId, 0)
        this.trigger(p, accountId, { type: 'account', id: accountId }, p.pauseMin, String(p.count), String(n), 'failures', `${n} consecutive order failures`)
      }
    }
  }

  /** 权益采样（快照时调用）：回撤暂停。 */
  onEquity(accountId: string, equity: d.Dec): void {
    const now = this.clock.now()
    const pts = this.equity.get(accountId) ?? []
    pts.push({ ts: now, v: equity })
    const maxWin = Math.max(24, ...this.protectors().map((p) => (p.kind === 'drawdown_pause' ? p.windowHours : 0))) * 3_600_000
    while (pts.length && (pts[0] as { ts: number }).ts < now - maxWin) pts.shift()
    this.equity.set(accountId, pts)
    for (const p of this.protectors()) {
      if (p.kind !== 'drawdown_pause') continue
      const win = pts.filter((x) => x.ts >= now - p.windowHours * 3_600_000)
      const peak = win.reduce((m, x) => d.max(m, x.v), d.ZERO)
      if (d.gt(peak, d.ZERO)) {
        const dd = d.div(d.sub(peak, equity), peak)
        if (d.gte(dd, d.D(p.maxDrawdownRatio))) this.trigger(p, accountId, { type: 'account', id: accountId }, p.pauseMin, p.maxDrawdownRatio, d.str(dd), 'ratio', `drawdown ${d.str(dd)} within ${p.windowHours} h`)
      }
    }
  }
}
