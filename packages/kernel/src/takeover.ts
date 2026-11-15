// SPDX-License-Identifier: CPAL-1.0
// 接管三档（契约 §5.6）+ 杀开关 + 场所级死人开关。
//   T1 停止新开仓  halt_new     → REDUCING
//   T2 撤销挂单    cancel_all   → REDUCING（默认保留只减仓的止盈止损）
//   T3 全部平仓    flatten_all  → 完成后 HALTED（未成交部分退避重试 3 次，仍不行则告警人）
//   恢复 resume                 → 只有人，PIN 在场证明
// "暂停不等于平仓"：T1 / T2 不动持仓。Agent 的作用域不得超出其授权书；每次接管都有 takeoverId、reason 必填、全程入账。
import { FLATTEN_RETRY_LIMIT, TAKEOVER_LEVEL_INFO, makeProblem } from './proto'
import type { Account, Order, Position, TakeoverId, TakeoverLevel, TakeoverRequest, TradingScope } from './proto'
import { assertProof } from './auth'
import type { HumanProof } from './auth'
import type { AgentService } from './agents'
import { ConnectorOperationError, connectorOperationError } from './connector'
import type { ConnectorBus } from './connector'
import type { EventBus } from './events'
import type { Keystore, Signer } from './keystore'
import type { Ledger } from './ledger'
import type { AccountRegistry } from './accounts'
import { canonicalTakeoverContext } from './trading'
import type { ActorCtx, TradingService } from './trading'
import type { TradingStateService } from './trading-state'
import { ORG_SCOPE } from './trading-state'
import { KernelError } from './util/errors'
import { newId } from './util/ids'
import { mkOrigin } from './util/origin'
import type { Clock } from './util/clock'
import * as d from './util/dec'

const err = (name: Parameters<typeof makeProblem>[0], message: string): KernelError => new KernelError(makeProblem(name, message))

/** 接管回执等撤单确认的上限：超时就按「待确认」记账，最终结果看账本 `cancel_all.confirmed`。 */
const CANCEL_CONFIRM_WAIT_MS = 3000

export interface TakeoverRecord {
  takeoverId: TakeoverId
  level: TakeoverLevel
  scope: TradingScope
  accounts: string[]
  cancelled: number
  /** 撤单请求已被场所受理、但在回执生成时还没确认撤掉的数量；最终结果见账本 `cancel_all.confirmed`。 */
  cancelPending?: number
  /** 撤单级接管里保留下来的保护单张数（仅 cancel_all 且读得到场所挂单时出现）。 */
  keptProtective?: number
  closeOrders: number
  stateAfter: string
  ok: boolean
  remaining?: { accountId: string; instrumentId: string; size: string }[]
  /** fix-r2 D4：受限钥匙自保时跳过的、不属于它的仓位。 */
  skipped?: { accountId: string; instrumentId: string; reason: 'not_authorized' }[]
}

export class TakeoverService {
  constructor(private x: {
    clock: Clock; ledger: Ledger; events: EventBus; accounts: AccountRegistry; bus: ConnectorBus; tstate: TradingStateService; trading: TradingService
    agents: AgentService; keystore?: Keystore; sleep?: (ms: number) => Promise<void>; deadman?: VenueDeadman
    /** fix-r2 S1/S2：恢复前的完整性关卡（账本锁存重验、纸面状态不可信），不过就抛错。 */
    assertResumable?: (scope: TradingScope) => void
  }) { x.deadman?.bindTrading(x.trading) }

  private accountsOf(scope: TradingScope): Account[] {
    switch (scope.type) {
      case 'account': return [this.x.accounts.get(scope.id)]
      case 'mandate': { const m = this.x.agents.getMandate(scope.id); return (m?.accounts ?? []).map((a) => this.x.accounts.find(a)).filter((a): a is Account => !!a) }
      case 'group': return this.x.accounts.list().filter((a) => a.groupIds.includes(scope.id as never))
      default: return this.x.accounts.list() // org / instrument
    }
  }

  /** Agent 的作用域不得超出其授权书的 accounts（org / group 一律不行）。 */
  private checkScope(scope: TradingScope, ctx: ActorCtx): void {
    if (ctx.principal.kind !== 'agent' && ctx.principal.kind !== 'engine') return
    const m = this.x.agents.getMandate(ctx.principal.mandateId)
    if (!m) throw err('MANDATE_EXPIRED', 'no mandate')
    const ok = (scope.type === 'mandate' && scope.id === m.mandateId)
      || (scope.type === 'account' && m.accounts.includes(scope.id as never))
      || scope.type === 'instrument' // 标的作用域只作用于授权书内的账户（accountsOf 之后再过滤）
    if (!ok) throw err('MANDATE_LIMIT', 'takeover scope must stay within the agent mandate')
  }

  /** fix-r2 D4：这个仓是不是这把钥匙自己的（授权书标的白名单内，且按成交归属只有它一个开仓人、净量与持仓一致）。 */
  private ownsPosition(a: Account, p: Position, actor: string, mandate: { instrumentAllowlist?: readonly string[] } | undefined): boolean {
    const allow = mandate?.instrumentAllowlist
    if (allow && allow.length > 0 && !allow.includes(p.instrumentId)) return false
    const owners = this.x.trading.positionOwnersOf(a.accountId, p.instrumentId)
    const expected = p.side === 'long' ? d.D(p.size) : d.neg(d.D(p.size))
    return owners.actors.length === 1 && owners.actors[0] === actor && d.eq(d.D(owners.net), expected)
  }

  private retryable(error: unknown): boolean { return error instanceof KernelError && error.problem.retryable === true }

  /** 等撤单确认，最多 CANCEL_CONFIRM_WAIT_MS；超时返回 undefined（回执按「待确认」计）。 */
  private async waitConfirmation(confirmation: Promise<number>): Promise<number | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), CANCEL_CONFIRM_WAIT_MS)
      timer.unref?.()
    })
    try { return await Promise.race([confirmation, timeout]) }
    finally { if (timer !== undefined) clearTimeout(timer) }
  }

  /** 场所侧会保留的保护单张数（与 ConnectorBus.cancelAll 的 keepProtective 口径一致）。 */
  private async countKeptProtective(a: Account, scope: TradingScope, keepProtective: boolean): Promise<number> {
    if (!keepProtective) return 0
    try {
      const snapshot = await this.x.bus.snapshot(a)
      const slIds = new Set(snapshot.stopLossOrderIds ?? [])
      const instrumentId = scope.type === 'instrument' ? scope.id : undefined
      return snapshot.openOrders.filter((order) => {
        if (instrumentId && order.instrumentId !== instrumentId) return false
        const knownSl = slIds.has(order.venueOrderId) || (!!order.clientOrderId && slIds.has(order.clientOrderId))
        const stop = order.type === 'stop_market' || order.type === 'stop_limit'
        const unknownTrigger = order.isTrigger === true && !stop && !order.type.startsWith('take_')
        return knownSl || (order.reduceOnly && stop) || unknownTrigger
      }).length
    } catch { return 0 }
  }

  private async freshPositions(a: Account, scope: TradingScope): Promise<Position[]> {
    const cached = await this.x.bus.snapshot(a)
    let positions = cached.positions
    if (cached.stale === true || (cached as typeof cached & { truncated?: boolean }).truncated === true) {
      let remote: Awaited<ReturnType<ConnectorBus['reconcile']>>
      try {
        remote = await this.x.bus.reconcile(a, 10_000, this.x.clock.now(), { maxRequests: 3 })
        if (remote.account.stale === true || remote.truncated === true) throw new KernelError(makeProblem('VENUE_UNAVAILABLE', 'fresh position view unavailable', { retryable: true, venue: { id: a.venue, message: 'fresh position view unavailable' } }))
      } catch (error) { throw connectorOperationError(error, 'takeover.positions', a.venue) }
      positions = remote.account.positions
    }
    return positions.filter((p) => scope.type !== 'instrument' || p.instrumentId === scope.id)
  }

  async execute(req: TakeoverRequest, ctx: ActorCtx): Promise<TakeoverRecord> {
    if (ctx.principal.kind === 'service' && ctx.origin.via !== 'internal') throw err('MANDATE_LEVEL', 'local service safety actions use the kill entry')
    return this.executeCore(req, ctx, true)
  }

  private async executeCore(req: TakeoverRequest, ctx: ActorCtx, emitCompleted: boolean, existingTakeoverId?: TakeoverId): Promise<TakeoverRecord> {
    ctx = canonicalTakeoverContext(ctx)
    if (!req.reason || !String(req.reason).trim()) throw err('INVALID_PARAMS', 'reason is required')
    if (!(req.level in TAKEOVER_LEVEL_INFO)) throw err('INVALID_PARAMS', `unknown takeover level ${String(req.level)}`)
    this.checkScope(req.scope, ctx)
    let accts = this.accountsOf(req.scope)
    if (ctx.principal.kind === 'agent' || ctx.principal.kind === 'engine') {
      const m = this.x.agents.getMandate(ctx.principal.mandateId)
      accts = accts.filter((a) => m?.accounts.includes(a.accountId as never))
    }
    const takeoverId = existingTakeoverId ?? newId('tko', this.x.clock.now())
    const subject = { takeoverId, ...(req.scope.type === 'account' ? { accountId: req.scope.id as `acct_${string}` } : req.scope.type === 'mandate' ? { mandateId: req.scope.id as `mdt_${string}` } : req.scope.type === 'instrument' ? { instrumentId: req.scope.id } : { orgId: 'org_local' as const }) } as const
    // fix-r2 D4：受限钥匙（agent / engine）的自保只收紧它自己的授权书作用域，不能把账户、别人的钥匙压成 REDUCING
    const restricted = ctx.principal.kind === 'agent' || ctx.principal.kind === 'engine'
    const mandate = restricted ? this.x.agents.getMandate((ctx.principal as { mandateId: string }).mandateId) : undefined
    const stateScope: TradingScope = restricted && mandate ? { type: 'mandate', id: mandate.mandateId } : req.scope
    const common = { level: req.level, scope: req.scope, reason: req.reason, accounts: accts.map((a) => a.accountId), ...(stateScope !== req.scope ? { stateScope } : {}), ...(ctx.principal.kind === 'service' ? { actorClass: 'system', originActorType: 'service' } : {}) }
    if (!existingTakeoverId) this.x.ledger.append({ type: 'takeover.requested', origin: ctx.origin, subject, ruleHits: [], payload: common })

    // T1：停止新开仓。收紧不需要证明，任何人 / Agent（自身作用域）/ 保护器 / 心跳超时都可以。
    // 接管只会收紧：该作用域已经是 REDUCING / HALTED 时保持原状（不能借接管把 HALTED 松成 REDUCING）。
    if (this.x.tstate.get(stateScope) === 'ACTIVE') this.x.tstate.set(stateScope, 'REDUCING', `takeover ${req.level}: ${req.reason}`, ctx.origin)
    const rec: TakeoverRecord = { takeoverId, level: req.level, scope: req.scope, accounts: common.accounts, cancelled: 0, closeOrders: 0, stateAfter: String(this.x.tstate.get(stateScope)), ok: true }

    const sleep = this.x.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
    const failedAccounts = new Set<string>()
    let firstError: unknown
    const recordAccountFailure = (a: Account, phase: string, error: unknown): void => {
      this.x.ledger.append({ type: 'takeover.failed', origin: ctx.origin, subject: { ...subject, accountId: a.accountId }, ruleHits: [], payload: { ...common, accountId: a.accountId, phase, error: error instanceof KernelError ? error.problem : String(error), ...(error instanceof ConnectorOperationError ? { errorStages: error.stages } : {}) } })
      this.x.events.publish('takeover.alert', { takeoverId, level: req.level, accountId: a.accountId, phase, error: String(error) })
    }
    if (req.level === 'cancel_all' || req.level === 'flatten_all') {
      const trustedHuman = ctx.principal.kind === 'session' && ctx.origin.actorType === 'human'
      for (const a of accts) {
        if (req.level === 'cancel_all') {
          const keepProtective = trustedHuman ? (req.keepProtective ?? true) : true
          rec.keptProtective = (rec.keptProtective ?? 0) + await this.countKeptProtective(a, req.scope, keepProtective)
        }
        for (let attempt = 0; attempt <= FLATTEN_RETRY_LIMIT; attempt++) {
          try {
            const r = await this.x.trading.takeoverCancelAll(a, { ...(req.scope.type === 'instrument' ? { instrumentId: req.scope.id } : {}), keepProtective: req.keepProtective ?? true }, ctx)
            if (r.confirmation) {
              const confirmed = await this.waitConfirmation(r.confirmation)
              if (confirmed === undefined) rec.cancelPending = (rec.cancelPending ?? 0) + r.cancelled
              else {
                rec.cancelled += confirmed
                const pending = Math.max(0, r.cancelled - confirmed)
                if (pending > 0) rec.cancelPending = (rec.cancelPending ?? 0) + pending
              }
            } else {
              rec.cancelled += r.cancelled
            }
            break
          } catch (error) {
            if (error instanceof ConnectorOperationError && (error.partialCancel?.cancelled ?? 0) > 0) {
              rec.cancelled += error.partialCancel!.cancelled
              failedAccounts.add(a.accountId)
              recordAccountFailure(a, 'cancel_all', error)
              if (!firstError) firstError = error
              break
            }
            if (this.retryable(error) && attempt < FLATTEN_RETRY_LIMIT) { await sleep(250 * 2 ** attempt); continue }
            failedAccounts.add(a.accountId)
            recordAccountFailure(a, 'cancel_all', error)
            if (!firstError) firstError = error
            break
          }
        }
      }
    }
    rec.stateAfter = String(this.x.tstate.get(stateScope))
    this.x.ledger.append({ type: 'takeover.applied', origin: ctx.origin, subject, ruleHits: [], payload: { ...common, cancelled: rec.cancelled, ...(rec.keptProtective === undefined ? {} : { keptProtective: rec.keptProtective }), tradingStateAfter: rec.stateAfter } })

    const skipped: Array<{ accountId: string; instrumentId: string; reason: 'not_authorized' }> = []
    if (req.level === 'flatten_all') {
      const remaining: NonNullable<TakeoverRecord['remaining']> = []
      for (const a of accts) {
        if (failedAccounts.has(a.accountId)) continue
        let accountRemaining: NonNullable<TakeoverRecord['remaining']> = []
        for (let attempt = 0; attempt <= FLATTEN_RETRY_LIMIT; attempt++) {
          try {
            const before = await this.freshPositions(a, req.scope)
            for (const p of before) {
              // 受限钥匙只平授权书白名单内、且按成交归属是自己的仓；别人的列进 skipped 并继续
              if (restricted && !this.ownsPosition(a, p, ctx.origin.actor, mandate)) {
                if (!skipped.some((s) => s.accountId === a.accountId && s.instrumentId === p.instrumentId)) skipped.push({ accountId: a.accountId, instrumentId: p.instrumentId, reason: 'not_authorized' })
                continue
              }
              try {
                const order: Order = await this.x.trading.takeoverReduceOnly(a, p.instrumentId, p.side === 'long' ? 'sell' : 'buy', p.size, ctx)
                if (order.status !== 'denied' && order.status !== 'rejected') rec.closeOrders++
              } catch (error) {
                // 一张被闸门拒不终止整个账户的循环（受限钥匙）；人面 / service 保持原语义（抛出后整体重试 / 失败）
                if (!restricted || this.retryable(error)) throw error
                recordAccountFailure(a, `flatten:${p.instrumentId}`, error)
              }
            }
            const skippedHere = new Set(skipped.filter((s) => s.accountId === a.accountId).map((s) => s.instrumentId))
            const after = (await this.freshPositions(a, req.scope)).filter((p) => !skippedHere.has(p.instrumentId))
            accountRemaining = after.map((p) => ({ accountId: a.accountId, instrumentId: p.instrumentId, size: p.size }))
            if (!after.length) break
            if (attempt < FLATTEN_RETRY_LIMIT) await sleep(250 * 2 ** attempt)
          } catch (error) {
            if (this.retryable(error) && attempt < FLATTEN_RETRY_LIMIT) { await sleep(250 * 2 ** attempt); continue }
            failedAccounts.add(a.accountId)
            recordAccountFailure(a, 'flatten', error)
            if (!firstError) firstError = error
            break
          }
        }
        remaining.push(...accountRemaining)
      }
      rec.remaining = remaining
      if (skipped.length) rec.skipped = skipped
      if (!firstError && remaining.length === 0) {
        this.x.tstate.set(stateScope, 'HALTED', 'flatten_all completed: ' + req.reason, ctx.origin)
        rec.stateAfter = String(this.x.tstate.get(stateScope))
      }
    }
    rec.stateAfter = String(this.x.tstate.get(stateScope))
    if (firstError) { rec.ok = false; throw firstError }
    if (req.level === 'flatten_all' && (rec.remaining?.length ?? 0) > 0) {
      rec.ok = false
      this.x.ledger.append({ type: 'takeover.failed', origin: ctx.origin, subject, ruleHits: [], payload: { ...common, remaining: rec.remaining, retries: FLATTEN_RETRY_LIMIT } })
      this.x.events.publish('takeover.alert', { takeoverId, level: req.level, remaining: rec.remaining })
      return rec
    }
    if (emitCompleted) this.x.ledger.append({ type: 'takeover.completed', origin: ctx.origin, subject, ruleHits: [], payload: { ...common, ...(rec.skipped ? { skipped: rec.skipped } : {}), cancelled: rec.cancelled, ...(rec.keptProtective === undefined ? {} : { keptProtective: rec.keptProtective }), closeOrders: rec.closeOrders, tradingStateAfter: rec.stateAfter } })
    return rec
  }

  async kill(reason: string, ctx: ActorCtx): Promise<TakeoverRecord> {
    ctx = canonicalTakeoverContext(ctx)
    if (!reason || !String(reason).trim()) throw err('INVALID_PARAMS', 'reason is required')
    if (ctx.principal.kind === 'agent' || ctx.principal.kind === 'engine') throw err('MANDATE_LIMIT', 'the kill switch is org-wide; agents use takeover within their own scope')
    const req: TakeoverRequest = { level: 'cancel_all', scope: ORG_SCOPE, reason: `kill switch: ${reason}`, keepProtective: false }
    let takeoverId: TakeoverId | undefined
    let requestedFailed = false
    let requestedError: unknown
    try {
      takeoverId = newId('tko', this.x.clock.now())
      const accounts = this.accountsOf(req.scope).map((account) => account.accountId)
      const subject = { takeoverId, orgId: 'org_local' as const }
      const common = { level: req.level, scope: req.scope, reason: req.reason, accounts, ...(ctx.principal.kind === 'service' ? { actorClass: 'system', originActorType: 'service' } : {}) }
      this.x.ledger.append({ type: 'takeover.requested', origin: ctx.origin, subject, ruleHits: [], payload: common })
    } catch (error) {
      requestedFailed = true
      requestedError = error
    }
    this.x.tstate.set(ORG_SCOPE, 'HALTED', `kill switch: ${reason}`, ctx.origin)
    let deadmanError: unknown
    let armed = 0
    try { armed = await this.x.deadman?.trip(`kill switch: ${reason}`, ctx) ?? 0 } catch (error) { deadmanError = error }
    let rec: TakeoverRecord
    try {
      if (requestedFailed) throw requestedError
      rec = await this.executeCore(req, ctx, deadmanError === undefined, takeoverId)
    }
    catch (error) { throw deadmanError ?? error }
    finally {
      // Summarize the completed arm calls after cancel-request audits; never re-arm or extend deadlines.
      if (armed > 0) this.x.ledger.append({ type: 'annotation', origin: ctx.origin, subject: { orgId: 'org_local' },
        payload: { kind: 'kill.deadman_summary', deadman: 'trip', reason: `kill switch: ${reason}`, armed, ok: true } })
    }
    rec.stateAfter = String(this.x.tstate.get(ORG_SCOPE))
    if (deadmanError) {
      rec.ok = false
      this.x.ledger.append({ type: 'takeover.failed', origin: ctx.origin, subject: { takeoverId: rec.takeoverId, orgId: 'org_local' }, ruleHits: [], payload: { level: 'cancel_all', reason: `kill switch: ${reason}`, accounts: rec.accounts, phase: 'kill.deadman', error: deadmanError instanceof KernelError ? deadmanError.problem : String(deadmanError), ...(deadmanError instanceof ConnectorOperationError ? { errorStages: deadmanError.stages } : {}) } })
      this.x.events.publish('takeover.alert', { takeoverId: rec.takeoverId, level: 'cancel_all', phase: 'kill.deadman', error: String(deadmanError) })
      throw deadmanError
    }
    return rec
  }

  /** 恢复 ACTIVE：只有人，PIN 在场证明。 */
  async resume(scope: TradingScope, reason: string, proof: HumanProof, ctx: ActorCtx): Promise<{ from: string; to: string }> {
    if (ctx.principal?.kind !== 'session') throw err('AUTH_FAILED', 'resume requires a human session')
    assertProof(proof, 'pin')
    this.x.assertResumable?.(scope)
    this.x.trading.assertReconciliationResolved(this.accountsOf(scope).map((account) => account.accountId))
    const from = this.x.tstate.get(scope)
    this.x.tstate.set(scope, 'REDUCING', `resume: ${reason}`, ctx.origin, proof)
    try {
      await this.x.deadman?.disarmAfterResume(this.accountsOf(scope), ctx.origin)
    } catch (error) {
      const problem = error instanceof KernelError ? error.problem : String(error)
      const operation = error instanceof ConnectorOperationError ? error : undefined
      this.x.ledger.append({ type: 'annotation', origin: ctx.origin, subject: { ...(scope.type === 'account' ? { accountId: scope.id as `acct_${string}` } : scope.type === 'mandate' ? { mandateId: scope.id as `mdt_${string}` } : scope.type === 'instrument' ? { instrumentId: scope.id } : { orgId: 'org_local' as const }) }, payload: { kind: 'resume.failed', scope, reason, from, tradingStateAfter: 'REDUCING', problem, ...(operation ? { errorStages: operation.stages } : {}) } })
      this.x.events.publish('takeover.alert', { phase: 'resume.disarm', scope, problem })
      throw error
    }
    try {
      this.x.trading.assertReconciliationResolved(this.accountsOf(scope).map((account) => account.accountId))
    } catch (error) {
      if (this.x.tstate.get(scope) !== 'HALTED') this.x.tstate.set(scope, 'HALTED', 'reconciliation changed during resume', ctx.origin)
      throw error
    }
    this.x.tstate.set(scope, 'ACTIVE', `resume: ${reason}`, ctx.origin, proof)
    return { from, to: 'ACTIVE' }
  }
}

// =====================================================================================
// 场所级死人开关 = 常驻看门狗（契约 §5.6 第三层）。
// 只要某个实盘账户“有实盘挂单”或“有开启了实盘的授权书（L2+ 且覆盖该账户）”，内核就定期续期：
// 每 refreshSec（默认 10 分钟）把“到点全撤”的时间推到 windowSec（默认 20 分钟）之后。内核进程死亡 → 场所在窗口内撤掉全部挂单（持仓不会被平）。
// HL 的 scheduleCancel：取消时间须在 5 s 之后；每天最多“触发” 10 次——触发 = 真的到点撤单。续期（重新设置时间）不算触发，所以定期续期不会耗掉每日额度。
// 杀开关与 HALTED 时立即 trip：把取消时间设成最短延迟（minDelaySec + 2 s）。没有挂单也没有实盘授权书时不续期，并清除已设的取消时间。
// 需要：连接器 deadman 能力有效开启、钥匙库已解锁，且账户为 API-key 或具有可用钱包签名器；仍经原风险票据。
// =====================================================================================
export const WATCHDOG_DEFAULTS = { windowSec: 20 * 60, refreshSec: 10 * 60, enabled: true }

export class VenueDeadman {
  private nextAt = new Map<string, number>()
  private retryAt = new Map<string, number>()
  private armed = new Set<string>()
  failures = 0
  private trading?: TradingService

  constructor(
    private x: { clock: Clock; bus: ConnectorBus; accounts: AccountRegistry; keystore?: Keystore; ledger: Ledger; needed?: (a: Account) => boolean },
    private opts: { windowSec: number; refreshSec: number; enabled: boolean } = WATCHDOG_DEFAULTS,
  ) {}

  bindTrading(trading: TradingService): void {
    if (this.trading && this.trading !== trading) throw err('INVALID_PARAMS', 'venue deadman is already bound to another trading service')
    this.trading = trading
  }

  private schedule(a: Account, atMs: number | null, origin: ActorCtx['origin']): Promise<{ ok: boolean; problem?: import('./proto').Problem }> {
    if (!this.trading) throw err('GATE_TICKET_INVALID', 'venue deadman requires a bound trading service')
    return this.trading.systemScheduleCancel(a, atMs, origin)
  }

  private signer(a: Account): Signer | undefined {
    if (!a.signer.credentialRef || !this.x.keystore?.isUnlocked()) return undefined
    try { return this.x.keystore.getSigner(a.signer.credentialRef) } catch { return undefined }
  }

  private canCall(a: Account): boolean {
    if (!this.x.keystore?.isUnlocked()) return false
    if (a.signer.type === 'api-key' || a.signer.type === 'gateway-session') return true
    return a.signer.type === 'api-wallet' && this.signer(a) !== undefined
  }

  private targets(only?: Account[]): Account[] {
    return (only ?? this.x.accounts.list()).filter((a) => a.mode === 'live' && a.status === 'active' && this.x.bus.hasDeadman(a))
  }

  /** 看门狗续期（由内核定时器每秒调用，真正动作只在到期时发生）。 */
  async tick(): Promise<number> {
    if (!this.opts.enabled) return 0
    const now = this.x.clock.now()
    let n = 0
    for (const a of this.targets()) {
      const needed = this.x.needed ? this.x.needed(a) : true
      if ((this.retryAt.get(a.accountId) ?? 0) > now) continue
      if (!needed) {
        if (!this.armed.has(a.accountId)) { this.nextAt.delete(a.accountId); this.retryAt.delete(a.accountId); continue }
        if (!this.canCall(a)) continue
        const result = await this.schedule(a, null, mkOrigin('system:kernel', 'deadman.tick', 'internal'))
        if (result.ok) { this.armed.delete(a.accountId); this.nextAt.delete(a.accountId); this.retryAt.delete(a.accountId) }
        else { this.failures++; this.nextAt.set(a.accountId, now + 5000); this.retryAt.set(a.accountId, now + 5000) }
        continue
      }
      if ((this.nextAt.get(a.accountId) ?? 0) > now) continue
      if (!this.canCall(a)) continue
      const r = await this.schedule(a, now + this.opts.windowSec * 1000, mkOrigin('system:kernel', 'deadman.tick', 'internal'))
      if (r.ok) { this.nextAt.set(a.accountId, now + this.opts.refreshSec * 1000); this.retryAt.delete(a.accountId); this.armed.add(a.accountId); n++ } else { this.failures++; this.nextAt.set(a.accountId, now + 5000); this.retryAt.set(a.accountId, now + 5000) }
    }
    return n
  }

  /** 立刻武装"到点全撤"（杀开关 / HALTED）：最短延迟 + 余量。accounts 缺省 = 全部实盘账户。 */
  async trip(reason: string, ctx: ActorCtx, accounts?: Account[]): Promise<number> {
    let n = 0
    let firstError: unknown
    for (const a of this.targets(accounts)) {
      const caps = this.x.bus.capabilities(a.venue)
      const at = this.x.clock.now() + ((caps?.deadman?.minDelaySec ?? 5) + 2) * 1000
      try {
        const r = await this.schedule(a, at, ctx.origin)
        if (!r.ok) throw new KernelError(r.problem ?? makeProblem('VENUE_UNAVAILABLE', 'deadman trip failed', { retryable: true }))
        this.x.ledger.append({ type: 'annotation', origin: ctx.origin, subject: { accountId: a.accountId as `acct_${string}` }, payload: { deadman: 'trip', reason, scheduledAt: at, ok: true } })
        n++; this.retryAt.delete(a.accountId); this.nextAt.set(a.accountId, Number.MAX_SAFE_INTEGER); this.armed.add(a.accountId)
      } catch (error) {
        const local = connectorOperationError(error, 'deadman.trip', a.venue)
        this.x.ledger.append({ type: 'annotation', origin: ctx.origin, subject: { accountId: a.accountId as `acct_${string}` }, payload: { deadman: 'trip', reason, scheduledAt: at, ok: false, problem: local.problem, errorStages: local.stages } })
        if (!firstError) firstError = local
      }
    }
    if (firstError) throw firstError
    return n
  }

  async disarmAfterResume(accts: Account[], origin?: ActorCtx['origin']): Promise<void> {
    let firstError: unknown
    for (const a of accts) {
      if (!this.x.bus.hasDeadman(a)) continue
      if (!this.canCall(a) && !this.armed.has(a.accountId)) continue
      try {
        const result = await this.schedule(a, null, origin ?? mkOrigin('system:kernel', 'deadman.resume', 'internal'))
        if (!result.ok) throw new KernelError(result.problem ?? makeProblem('VENUE_UNAVAILABLE', 'deadman disarm failed', { retryable: true }))
        this.nextAt.delete(a.accountId)
        this.retryAt.delete(a.accountId)
        this.armed.delete(a.accountId)
      } catch (error) {
        const local = connectorOperationError(error, 'deadman.disarm', a.venue)
        this.failures++
        this.nextAt.delete(a.accountId)
        this.retryAt.set(a.accountId, this.x.clock.now() + 5000)
        this.x.ledger.append({ type: 'annotation', origin: origin ?? mkOrigin('system:kernel', 'deadman.resume', 'internal'), subject: { accountId: a.accountId as `acct_${string}` }, payload: { deadman: 'disarm', ok: false, problem: local.problem, errorStages: local.stages } })
        if (!firstError) firstError = local
      }
    }
    if (firstError) throw firstError
  }
}
