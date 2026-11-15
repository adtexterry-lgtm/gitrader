// SPDX-License-Identifier: CPAL-1.0
// 交易三态 ACTIVE / REDUCING / HALTED（契约 §1.4.10）：粘性状态（接管 / 杀开关 / 死人开关 / 启动对账失败）+ 带到期的保护器暂停。
// 生效状态取所有适用作用域里最严的一个；收紧随时可做，恢复（放宽）只有人，且要 PIN 在场证明。
import { TRADING_STATE_SEVERITY, makeProblem } from './proto'
import type { Origin, TradingScope, TradingState } from './proto'
import { assertProof } from './auth'
import type { HumanProof } from './auth'
import type { Docs } from './db'
import type { EventBus } from './events'
import type { Ledger } from './ledger'
import { KernelError } from './util/errors'
import { mkOrigin } from './util/origin'
import type { Clock } from './util/clock'

export const ORG_SCOPE: TradingScope = { type: 'org', id: 'org_local' }
export const scopeKey = (s: TradingScope): string => `${s.type}:${s.id}`

interface StateDoc { scope: TradingScope; state: TradingState; reason: string; since: number; by: string }
export interface PauseDoc { pauseId: string; scope: TradingScope; until: number; reason: string; protector: string; since: number }
export interface StateReason { scope: TradingScope; state: TradingState; reason: string; until?: number; protector?: string }

const sev = (s: TradingState): number => TRADING_STATE_SEVERITY[s]

export class TradingStateService {
  private sticky = new Map<string, StateDoc>()
  private pauses = new Map<string, PauseDoc>()

  /** 粘性状态变严时回调（REDUCING / HALTED）：GEP 宿主据此向引擎发 engine.halt（halt_new / cancel_all）。 */
  onTightened?: (scope: TradingScope, state: TradingState, reason: string) => void
  /** 人面恢复 ACTIVE 时回调：GEP 宿主据此发 engine.resume。 */
  onResumed?: (scope: TradingScope) => void
  /** 进入 HALTED 时回调（内核用它向所有已连引擎广播 halt）。 */
  onHalted?: (scope: TradingScope, reason: string) => void

  constructor(private docs: Docs, private ledger: Ledger, private events: EventBus, private clock: Clock) {
    for (const s of docs.list<StateDoc>('tstate')) this.sticky.set(scopeKey(s.scope), s)
    for (const p of docs.list<PauseDoc>('tpause')) this.pauses.set(p.pauseId, p)
  }

  get(scope: TradingScope): TradingState { return this.sticky.get(scopeKey(scope))?.state ?? 'ACTIVE' }

  /** 作用域列表里最严的状态及原因（保护器暂停只在到期前计入）。 */
  effective(scopes: TradingScope[], groupIds: readonly string[] = []): { state: TradingState; reasons: StateReason[] } {
    const now = this.clock.now()
    const reasons: StateReason[] = []
    const uniqueScopes = new Map<string, TradingScope>()
    for (const scope of scopes) uniqueScopes.set(scopeKey(scope), { ...scope })
    for (const id of groupIds) {
      const scope: TradingScope = { type: 'group', id }
      uniqueScopes.set(scopeKey(scope), scope)
    }
    for (const sc of uniqueScopes.values()) {
      const st = this.sticky.get(scopeKey(sc))
      if (st && st.state !== 'ACTIVE') reasons.push({ scope: sc, state: st.state, reason: st.reason })
      for (const p of this.pauses.values()) if (scopeKey(p.scope) === scopeKey(sc) && p.until > now) reasons.push({ scope: sc, state: 'REDUCING', reason: p.reason, until: p.until, protector: p.protector })
    }
    let state: TradingState = 'ACTIVE'
    for (const r of reasons) if (sev(r.state) > sev(state)) state = r.state
    return { state, reasons }
  }

  list(): { sticky: StateDoc[]; pauses: PauseDoc[] } {
    const now = this.clock.now()
    return { sticky: [...this.sticky.values()].filter((s) => s.state !== 'ACTIVE'), pauses: [...this.pauses.values()].filter((p) => p.until > now) }
  }

  private subjectOf(scope: TradingScope): Record<string, string> {
    switch (scope.type) {
      case 'account': return { accountId: scope.id }
      case 'mandate': return { mandateId: scope.id }
      case 'instrument': return { instrumentId: scope.id }
      default: return { orgId: 'org_local' }
    }
  }

  /**
   * 设置粘性状态。收紧（更严）随时可做；放宽（含恢复 ACTIVE）必须 PIN 在场证明——这是 Agent 工具面之外的人面动作。
   */
  set(scope: TradingScope, state: TradingState, reason: string, origin: Origin, proof?: HumanProof): { from: TradingState; to: TradingState; changed: boolean } {
    if (!reason || !reason.trim()) throw new KernelError(makeProblem('INVALID_PARAMS', 'reason is required'))
    const from = this.get(scope)
    if (sev(state) < sev(from)) assertProof(proof, 'pin')
    if (state === from) return { from, to: state, changed: false }
    const now = this.clock.now()
    const doc: StateDoc = { scope, state, reason, since: now, by: origin.actor }
    this.docs.put('tstate', scopeKey(scope), doc)
    this.sticky.set(scopeKey(scope), doc)
    this.ledger.append({
      type: 'trading_state.changed', origin, subject: this.subjectOf(scope),
      payload: { scope, from, to: state, reason, ...(sev(state) < sev(from) ? { presence: proof?.presence } : {}) },
    })
    this.events.publish('risk.state', { scope, from, to: state, reason, ts: now })
    if (sev(state) > sev(from)) this.onTightened?.(scope, state, reason)
    if (state === 'HALTED') this.onHalted?.(scope, reason)
    if (state === 'ACTIVE') this.onResumed?.(scope)
    return { from, to: state, changed: true }
  }

  /** 保护器暂停：到期自动恢复（保护器自己的语义，不是 ACTIVE 的人面恢复）。 */
  pause(scope: TradingScope, minutes: number, reason: string, protector: string, origin: Origin): PauseDoc {
    const now = this.clock.now()
    const existing = [...this.pauses.values()].find((p) => scopeKey(p.scope) === scopeKey(scope) && p.protector === protector && p.until > now)
    const until = now + minutes * 60_000
    const doc: PauseDoc = { pauseId: existing?.pauseId ?? `pause_${scopeKey(scope)}_${protector}_${now}`, scope, until: Math.max(until, existing?.until ?? 0), reason, protector, since: existing?.since ?? now }
    this.docs.put('tpause', doc.pauseId, doc)
    this.pauses.set(doc.pauseId, doc)
    this.ledger.append({
      type: 'trading_state.changed', origin, subject: this.subjectOf(scope),
      payload: { scope, from: 'ACTIVE', to: 'REDUCING', reason, pausedUntil: doc.until, protector },
    })
    this.events.publish('risk.state', { scope, to: 'REDUCING', reason, until: doc.until, protector, ts: now })
    return doc
  }

  /** 清理到期暂停（并写账本）。由内核定时器调用。 */
  tick(): number {
    const now = this.clock.now()
    let n = 0
    for (const p of [...this.pauses.values()]) {
      if (p.until > now) continue
      this.pauses.delete(p.pauseId)
      this.docs.delete('tpause', p.pauseId)
      this.ledger.append({
        type: 'trading_state.changed', origin: mkOrigin('system:protector', `protector:${p.protector}`, 'internal'),
        subject: this.subjectOf(p.scope), payload: { scope: p.scope, from: 'REDUCING', to: 'ACTIVE', reason: `pause ended: ${p.reason}`, protector: p.protector },
      })
      this.events.publish('risk.state', { scope: p.scope, to: 'ACTIVE', reason: 'pause ended', ts: now })
      n++
    }
    return n
  }
}
