// SPDX-License-Identifier: CPAL-1.0
// 下单流水线：规范化 → 预检（风控闸 + 授权书）→ 账本 → 路由到场所（实盘）/ 内核模拟场所（纸面、影子）→ 订单与成交入账。
// 提案状态机（草稿 → 待审 → 批准 / 拒绝 / 过期 / 撤回）与 confirmToken（预览参数绑定，不是批准）也在这里。
// 铁律：批准提案只有人面（会话；名义额超过授权书 presenceAboveNotional 要 PIN）；Agent 没有 approve / reject 入口。
import { createHmac, randomBytes } from 'node:crypto'
import {
  CONFIRM_TOKEN_DEFAULTS, PROPOSAL_DEFAULTS, RULE_PROBLEM_DEFAULTS, makeProblem, nextProposalStatus, isTerminalProposalStatus,
} from './proto'
import type {
  Account, Fill, GateAction, GateDecision, GateInput, GateTicket, GateTarget, InstrumentId, LedgerEntryType, LedgerPrecheck, Mandate, Order, OrderIntent, OrderStatus, Origin, PrecheckResult, Problem, Proposal, ProposalEvent, ReconcileConfirmationReceipt, ReconcileConfirmInput, ReconcileConfirmResult, ReconcileReviewItem, RuleHit, Sha256Digest,
} from './proto'
import { validateFill } from './proto'
import { assertProof } from './auth'
import type { HumanProof, Principal } from './auth'
import type { AgentService } from './agents'
import { ConnectorBus, ConnectorOperationError, connectorOperationError } from './connector'
import type { AccountSnapshot, NormalizedIntent, SubmitOutcome } from './connector'
import type { CancelAck, VenueFill } from '@gitrader/protocol/connector'
import { tx } from './db'
import type { Docs, Db } from './db'
import type { EventBus } from './events'
import type { InstallKey } from './install-key'
import type { Keystore, Signer } from './keystore'
import type { Ledger, LedgerDeferredEffects } from './ledger'
import { normalizeIntent } from './normalize'
import { normalizeRiskTarget } from './normalize'
import { assembleGateInput, gateSnapshotOf } from './risk-gate/assemble'
import { adjustedGateTarget, evaluateGateStages, gateRefPrice } from './risk-gate/stages'
import { ReservationBook, budgetMargin } from './risk-gate/reservations'
import type { ReconcileResult, ReservationObservation, ReservationRecord, ValuedOpenOrder } from './risk-gate/reservations'
import { GateTicketAuthority } from './risk-gate/tickets'
import { ORG_SCOPE } from './trading-state'
import type { AccountRegistry } from './accounts'
import type { OrderStore } from './orders'
import type { ProtectorEngine } from './protectors'
import type { RiskGate, RiskService } from './risk'
import { DEFAULT_DUPLICATE_WINDOW_SEC, dayKeyOf, dayStartTs } from './risk-policy'
import type { TradingStateService } from './trading-state'
import * as d from './util/dec'
import { KernelError } from './util/errors'
import { digestOf, safeEqual, sha256Hex } from './util/hash'
import { newClientOrderId, newId } from './util/ids'
import { mkOrigin } from './util/origin'
import type { Clock } from './util/clock'
import { ReconcileReviewStore } from './reconcile-review'
import { PrecheckThrottle } from './precheck-throttle'
import { mainnetLiveBlocked, MAINNET_LIVE_ENABLED } from '@gitrader/protocol'

const brand = <T>(s: string): T => s as unknown as T
const err = (name: Parameters<typeof makeProblem>[0], message: string, extra: Partial<Problem> = {}): KernelError => new KernelError(makeProblem(name, message, extra))

export function canonicalTakeoverContext(ctx: ActorCtx): ActorCtx {
  const origin = { ...ctx.origin }
  switch (ctx.principal.kind) {
    case 'agent':
      origin.actor = brand<Origin['actor']>(`agent:${ctx.principal.keyId}`)
      origin.actorType = 'llm-agent'
      break
    case 'engine':
      origin.actor = brand<Origin['actor']>(`engine:${ctx.principal.engineId}`)
      origin.actorType = 'engine'
      break
    case 'session':
      origin.actor = brand<Origin['actor']>(`user:${ctx.principal.userId}`)
      origin.actorType = 'human'
      break
    case 'service':
      if (origin.via === 'cli' && ((origin.actorType === 'human' && origin.actor === 'user:usr_local') || (origin.actorType === 'system' && origin.actor === 'system:service'))) {
        origin.actor = brand<Origin['actor']>('system:service')
        origin.actorType = 'system'
      } else if (!origin.actor.startsWith('system:') || origin.actorType !== 'system' || origin.via !== 'internal') {
        throw err('MANDATE_LEVEL', 'service takeover requires an internal system origin')
      }
      break
  }
  return { ...ctx, origin }
}

export interface ActorCtx {
  principal: Principal
  origin: Origin
  proof?: HumanProof
}

export interface TradingDeps {
  clock: Clock
  db: Db
  docs: Docs
  ledger: Ledger
  events: EventBus
  accounts: AccountRegistry
  bus: ConnectorBus
  risk: RiskService
  gate: RiskGate
  tstate: TradingStateService
  agents: AgentService
  orders: OrderStore
  protectors: ProtectorEngine
  installKey: InstallKey
  keystore?: Keystore
  assertLiveStateHealthy?: () => void
  /** fix-r2 K2：纸面状态本次启动是否可信（摘要校验通过或全新建账）。 */
  paperTrusted?: () => boolean
  /** fix-r2 S1：下单回执附带的告警（例如纸面状态还没落盘）。 */
  persistenceWarnings?: () => string[]
}

/** fix-r2 K3：批准后正常会立刻转 executing；停在 approved 超过这个窗口 = 执行被打断。 */
export const APPROVED_EXECUTE_WINDOW_MS = 60_000
/** fix-r2 K2：纸面单从未到达场所时的固定原因串（问题码仍是 VENUE_REJECTED）。 */
export const NEVER_REACHED_MESSAGE = 'INTERRUPTED_BEFORE_VENUE: the kernel stopped before this order reached the paper venue; it was never placed'
/** fix-r2 K1：补挂止损的派生 clientOrderId（sha256(父单 clientOrderId + ':sl') 前 32 位 hex）。 */
export const derivedStopClientOrderId = (parentClientOrderId: string): string => sha256Hex(`${parentClientOrderId}:sl`).slice(0, 32)

export interface PreviewResult {
  confirmToken?: string
  normalizedIntent: NormalizedIntent
  precheck: GateDecision
  expiresAt: number
  /** fix-r2 T6：规范化时丢掉的未知字段等说明。 */
  warnings?: string[]
}
export interface PlaceResult { order?: Order; proposal?: Proposal; problem?: Problem; warnings?: string[] }

export interface ProposeInput {
  /** true = 一定进待审，不自动批准（host.proposal.create：“我要人批这单”）。 */
  forcePending?: boolean
  accountId: string
  intents: OrderIntent[]
  reason: string
  evidence?: Proposal['evidence']
}

export function problemOfPrecheck(p: PrecheckResult): Problem {
  const first = p.ruleHits.find((h) => h.action === 'deny') ?? p.ruleHits[0]
  const name = (first && RULE_PROBLEM_DEFAULTS[first.code]) ?? 'RULE_DENIED'
  const msg = p.ruleHits.map((h) => h.message ?? `${h.code}: limit ${h.limit}, actual ${h.actual} ${h.unit}`).join('; ') || 'denied'
  return makeProblem(name, msg, { ruleHits: p.ruleHits, precheckId: p.precheckId })
}

interface TokenRecord { claims: { mandateId: string | null; accountId: string; digest: Sha256Digest; authorDigest: Sha256Digest; precheckId: string; policyVersion: number; priceRef: { markPrice: string; ts: number } | null; maxDriftBps: number; expiresAt: number; nonce: string }; intent: NormalizedIntent; authorIntent: NormalizedIntent; principalKey: string; mac: string }
interface CollectedGateData {
  routeKey: string
  snapshot: AccountSnapshot
  mark?: import('./connector').MarkPrice
  cancelPriceChecks?: GateInput['cancelPriceChecks']
  openOrderValuations: Record<string, { contractSize: import('./proto').Decimal; mark?: import('./proto').Decimal }>
  valuedOpenOrders: ValuedOpenOrder[]
}
interface AssembledOrderGate {
  requiresOwnershipApproval: boolean
  account: Account
  input: GateInput
  precheck: GateDecision
  snapshot: AccountSnapshot
  mandate: Mandate | null
  normalizedIntent: NormalizedIntent
  normalization: ReturnType<typeof normalizeRiskTarget>
  timing: { assembleUs: number; decideUs: number; protectorUs: number }
}
type ExecutionStart<T = Order> = { done: T } | { pending: Promise<T> }
interface AccountQueue { running: boolean; high: Array<() => void>; normal: Array<() => void> }
interface ConfirmedFillEffects {
  ledger: LedgerDeferredEffects
  memory: Array<() => void>
  order?: Order
  fill: Fill
}
interface OrderRecord {
  intent?: NormalizedIntent
  cancelRequestedAt?: number
  unlinked?: { since: number; venue: string }
  reservation?: ReservationRecord
  amendPending?: { reservation: ReservationRecord; ticketId: string }
  supersededVenueOrderIds?: string[]
  replacementVenueOrderId?: string
}
const terminalOrder = (status: OrderStatus): boolean => ['filled', 'cancelled', 'expired', 'rejected', 'denied'].includes(status)
const CONFIRMATION_RECEIPTS = 'reconcile-confirm-receipt'
const CONFIRMATION_PENDING = 'reconcile-confirm-pending'
const LATE_REAL_EVIDENCE = 'reconcile-late-evidence'
const LATE_REAL_PENDING = 'reconcile-late-pending'

/** clientOrderId 幂等窗口：窗口内重复提交返回原订单。 */
export const CLIENT_ORDER_ID_WINDOW_MS = 10 * 60_000

export class TradingService {
  private hmacKey = randomBytes(32) // 进程内存；重启即全部失效
  private tokens = new Map<string, TokenRecord>()
  private reservations = new ReservationBook()
  private uncertainOrders = new Map<string, Set<string>>()
  private lastGateSnapshots = new Map<string, { routeKey: string; snapshot: AccountSnapshot }>()
  private killSwitch = { tripped: false }
  private orderQueues = new Map<string, AccountQueue>()
  private pendingConfirmations = new Set<string>()
  private activeConfirmationEffects = new Map<string, string>()
  private ticketAuthority: GateTicketAuthority
  private unlinkedChildren = 0
  private pendingAmends = new Map<string, { order: Order; reservation: ReservationRecord; awaitingAck: boolean; awaitingIdentity?: boolean; deferredTerminal?: { venueOrderId: string; clientOrderId: string | null; status: OrderStatus }; observedTerminal?: { venueOrderId: string; status: OrderStatus }; replacementVenueOrderId?: string }>()
  readonly reconcileReviews: ReconcileReviewStore

  constructor(private x: TradingDeps) {
    this.reconcileReviews = new ReconcileReviewStore({ db: x.db, docs: x.docs, ledger: x.ledger, clock: x.clock })
    this.ticketAuthority = new GateTicketAuthority(x.installKey, x.clock)
    x.bus.setGateAuthority(this.ticketAuthority, (violation) => {
      x.ledger.append({
        type: 'order.rejected', origin: mkOrigin('system:kernel', 'gate-ticket:violation', 'internal'),
        subject: { accountId: brand(violation.accountId) },
        payload: { kind: 'gate_ticket', action: violation.action, problem: violation.problem, ...(violation.ticketId ? { ticketId: violation.ticketId } : {}) },
      })
    })
    x.bus.setOrderStatusCallbacks((event) => this.recordUnknownStatus(event), (accountId, update) => {
      const order = this.x.orders.byClientOrderId(update.clientOrderId)
      if (order?.accountId === accountId && this.isUnlinkedChild(order.orderId)) this.onOrderUpdate(accountId, update)
    })
    this.unlinkedChildren = Number((x.db.prepare("SELECT COUNT(*) c FROM ledger WHERE type='annotation' AND json_extract(entry,'$.payload.kind')='order.child_unlinked'").get() as { c: number }).c)
    this.restoreReservations()
    for (const account of x.accounts.list()) if (this.confirmationPending(account.accountId)) this.pendingConfirmations.add(account.accountId)
  }


  /** Cumulative warning count; unresolved children remain independently marked in order-record. */
  unlinkedChildCount(): number { return this.unlinkedChildren }
  isUnlinkedChild(orderId: string): boolean { return !!this.x.docs.get<OrderRecord>('order-record', orderId)?.unlinked }

  /** Rebuild original pending sources into durable review snapshots without financial side effects. */
  recoveryReviews(accountId: string): ReconcileReviewItem[] {
    let confirmationMarker: unknown
    let lateMarker: unknown
    try {
      confirmationMarker = this.x.docs.get<unknown>(CONFIRMATION_PENDING, accountId)
      lateMarker = this.x.docs.get<unknown>(LATE_REAL_PENDING, accountId)
    } catch { throw err('STATE_FILE_CORRUPT', 'reconciliation recovery marker is corrupt') }

    const seeds: Array<Parameters<ReconcileReviewStore['record']>[0]> = []
    if (confirmationMarker !== undefined) {
      if (typeof confirmationMarker !== 'string' || confirmationMarker.length === 0) throw err('STATE_FILE_CORRUPT', 'confirmation pending marker is corrupt')
      const receipt = this.confirmationReceipt(confirmationMarker)
      if (!receipt || receipt.input.accountId !== accountId
        || `rcpt_${digestOf([receipt.input.accountId, receipt.input.suggestionId]).slice('sha256:'.length)}` !== confirmationMarker) {
        throw err('STATE_FILE_CORRUPT', 'confirmation pending marker has no matching receipt')
      }
      try {
        const confirmed = this.lookupConfirmedFill(receipt.input)
        if (!confirmed || confirmed.fillId !== receipt.fillId) throw new Error('receipt fill mismatch')
      } catch { throw err('STATE_FILE_CORRUPT', 'confirmation recovery source is corrupt') }
      if (this.activeConfirmationEffects.get(accountId) !== confirmationMarker) {
        seeds.push({ accountId: accountId as ReconcileReviewItem['accountId'], kind: 'confirmation_effects',
          observedAt: receipt.confirmedAt, summary: 'A confirmed fill has follow-up effects requiring review.', blocking: true, confirmation: receipt })
      }
    }

    let rows: Array<{ id: string; doc: string }> = []
    try {
      rows = this.x.db.prepare(`
        SELECT d.id, d.doc FROM docs d
        JOIN (SELECT id, MAX(ver) AS mv FROM docs WHERE coll=? GROUP BY id) latest
          ON latest.id=d.id AND latest.mv=d.ver
        WHERE d.coll=?
        ORDER BY d.id COLLATE BINARY
      `).all(LATE_REAL_EVIDENCE, LATE_REAL_EVIDENCE) as Array<{ id: string; doc: string }>
    } catch { throw err('STATE_FILE_CORRUPT', 'late evidence records cannot be read') }
    const accountRows: Array<{ id: string; fill: Fill }> = []
    for (const row of rows) {
      let raw: unknown
      try { raw = JSON.parse(row.doc) } catch { throw err('STATE_FILE_CORRUPT', 'late evidence record is corrupt') }
      let fill: Fill
      try { fill = this.projectLateEvidence(raw, row.id) }
      catch { throw err('STATE_FILE_CORRUPT', 'late evidence identity or source is corrupt') }
      if (fill.accountId === accountId) accountRows.push({ id: row.id, fill })
    }
    if (lateMarker === undefined && accountRows.length > 0) throw err('STATE_FILE_CORRUPT', 'late evidence exists without its pending marker')
    if (lateMarker !== undefined && lateMarker !== true) throw err('STATE_FILE_CORRUPT', 'late evidence pending marker is corrupt')
    if (lateMarker === true && accountRows.length === 0) throw err('STATE_FILE_CORRUPT', 'late evidence marker has no evidence records')
    for (const { fill } of accountRows) {
      seeds.push({ accountId: accountId as ReconcileReviewItem['accountId'], kind: 'late_real_fill', observedAt: fill.ts,
        summary: 'A real fill overlaps a previously confirmed inference.', blocking: true, fill })
    }
    try {
      return tx(this.x.db, () => seeds.map((seed) => this.reconcileReviews.record(seed)))
    } catch { throw err('STATE_FILE_CORRUPT', 'reconciliation recovery evidence is corrupt') }
  }

  /** Fail closed on raw markers and every unresolved blocking review; acknowledged markers remain intact. */
  confirmationPending(accountId: string): boolean {
    const memoryPending = this.pendingConfirmations.has(accountId)
    try {
      const recovered = this.recoveryReviews(accountId)
      const marker = this.x.docs.get<unknown>(CONFIRMATION_PENDING, accountId)
      if (typeof marker === 'string' && this.activeConfirmationEffects.get(accountId) === marker) return false
      const pending = recovered.some((item) => item.kind === 'confirmation_effects' && item.resolution === undefined)
        || (marker === undefined && memoryPending)
      if (pending) this.pendingConfirmations.add(accountId)
      else this.pendingConfirmations.delete(accountId)
      return pending
    } catch { return true }
  }

  /** Fail closed while any late real evidence for an inferred order awaits human review. */
  lateRealEvidencePending(accountId: string): boolean {
    try {
      return this.recoveryReviews(accountId).some((item) => item.kind === 'late_real_fill' && item.resolution === undefined)
    } catch { return true }
  }

  assertReconciliationResolved(accountIds: readonly string[]): void {
    for (const accountId of accountIds) {
      if (this.activeConfirmationEffects.has(accountId)) {
        throw new KernelError(makeProblem('BUSY', 'confirmation follow-up is in progress'))
      }
      this.recoveryReviews(accountId)
      if (this.confirmationPending(accountId) || this.lateRealEvidencePending(accountId)
        || this.reconcileReviews.hasBlockingPending(accountId)) {
        throw new KernelError(makeProblem('TRADING_STATE', 'review pending reconciliation items before resuming'))
      }
    }
  }

  /** Startup-only view of terminal orders whose real amendment reservation is still pending. */
  pendingTerminalAmends(accountId: string): Array<{ order: Order; replacementVenueOrderId?: string; reservationSize: string }> {
    const candidates: Array<{ order: Order; replacementVenueOrderId?: string; reservationSize: string }> = []
    for (const pending of this.pendingAmends.values()) {
      const order = this.x.orders.get(pending.order.orderId)
      if (!order || order.accountId !== accountId || !terminalOrder(order.status)) continue
      const record = this.x.docs.get<OrderRecord>('order-record', order.orderId)
      if (!record?.amendPending) continue
      candidates.push({
        order: { ...order },
        ...(pending.replacementVenueOrderId ? { replacementVenueOrderId: pending.replacementVenueOrderId } : {}),
        reservationSize: pending.reservation.size,
      })
    }
    return candidates
  }

  private linkChild(order: Order, venueOrderId: string): Order {
    const record = this.x.docs.get<OrderRecord>('order-record', order.orderId)
    if (!order.parentOrderId || !venueOrderId || !record?.unlinked) return order
    const venue = record.unlinked.venue
    const next = { ...order, venueOrderId, updatedAt: this.x.clock.now() }
    delete record.unlinked
    tx(this.x.db, () => {
      this.x.orders.upsert(next, '0', false)
      this.x.docs.put('order-record', order.orderId, record)
      this.x.ledger.append({ type: 'annotation', origin: order.origin,
        subject: { accountId: order.accountId, orderId: order.orderId, clientOrderId: order.clientOrderId },
        payload: { kind: 'order.child_linked', parentOrderId: order.parentOrderId, tpslRole: order.tpslRole, venue, venueOrderId } })
    })
    return next
  }

  private recordUnknownStatus(event: { accountId: string; venue: string; rawStatus: string; venueOrderId?: string; clientOrderId?: string | null }): void {
    const byVenue = event.venueOrderId ? this.x.orders.byVenueOrderId(event.accountId, event.venueOrderId) : undefined
    const order = byVenue?.parentOrderId ? byVenue : (event.clientOrderId ? this.x.orders.byClientOrderId(event.clientOrderId) : undefined) ?? byVenue
    if (!order || order.accountId !== event.accountId) return
    if (this.x.db.prepare("SELECT 1 FROM ledger WHERE type='order.status_unknown' AND order_id=? AND json_extract(entry,'$.payload.rawStatus')=? LIMIT 1").get(order.orderId, event.rawStatus)) return
    this.x.ledger.append({ type: 'order.status_unknown', origin: mkOrigin('system:kernel', 'venue:unknown-status', 'internal'),
      subject: { accountId: order.accountId, orderId: order.orderId, clientOrderId: order.clientOrderId },
      payload: { venue: event.venue, rawStatus: event.rawStatus, orderId: order.orderId } })
  }

  private gateOpenOrders(rows: ValuedOpenOrder[]): GateInput['snapshot']['openOrders'] | undefined {
    if (rows.some((row) => !row.reduceOnly && row.notional === undefined)) return undefined
    const summary = new Map<string, GateInput['snapshot']['openOrders'][number]>()
    for (const row of rows) {
      if (row.reduceOnly) continue
      const key = row.instrumentId + ':' + row.side, prior = summary.get(key)
      summary.set(key, { instrumentId: row.instrumentId as Order['instrumentId'], side: row.side,
        notional: d.str(d.add(d.D(prior?.notional ?? '0'), d.D(row.notional ?? '0'))), count: (prior?.count ?? 0) + 1 })
    }
    return [...summary.values()]
  }

  /** An old venue view must not make an in-flight amendment's larger reservation disappear. */
  private retainPendingAmends(accountId: string, snapshot: AccountSnapshot, rows: ValuedOpenOrder[]): void {
    for (const pending of this.pendingAmends.values()) {
      const order = this.x.orders.get(pending.order.orderId)
      if (!order || order.accountId !== accountId) continue
      const r = pending.reservation, remaining = d.max(d.ZERO, d.sub(d.D(r.size), d.D(order.filledSize)))
      const notional = d.str(d.div(d.mul(d.D(r.notional), remaining), d.D(r.size)))
      const margin = budgetMargin(d.mul(d.D(r.margin), remaining), d.D(r.size))
      const row = rows.find((item) => item.clientOrderId === order.clientOrderId || !!order.venueOrderId && item.venueOrderId === order.venueOrderId)
      const priorMargin = d.D(row?.margin ?? '0')
      const retained: ValuedOpenOrder = { venueOrderId: order.venueOrderId ?? '', clientOrderId: order.clientOrderId, instrumentId: order.instrumentId, side: order.side, reduceOnly: r.reduceOnly,
        remainingSize: d.str(d.max(d.D(row?.remainingSize ?? '0'), remaining)),
        notional: d.str(d.max(d.D(row?.notional ?? '0'), d.D(notional))), margin: d.str(d.max(priorMargin, d.D(margin))) }
      if (row) Object.assign(row, retained)
      else rows.push(retained)
      if (snapshot.availableDeductsOpenOrders && !r.reduceOnly) snapshot.available = d.str(d.max(d.ZERO, d.sub(d.D(snapshot.available), d.sub(d.D(retained.margin!), priorMargin))))
    }
  }

  private amendScope(order: Order) {
    const account = this.x.accounts.get(order.accountId)
    const scopes = [ORG_SCOPE, { type: 'account', id: order.accountId } as const, { type: 'instrument', id: order.instrumentId } as const,
      ...(order.mandateId ? [{ type: 'mandate', id: order.mandateId } as const] : [])]
    const effective = this.x.tstate.effective(scopes, account.groupIds)
    return { ...effective, state: this.killSwitch.tripped ? 'HALTED' as const : effective.state, killSwitch: this.killSwitch.tripped }
  }

  private haltedOrKilled(input: GateInput): boolean {
    return input.killSwitch.tripped || input.states.some((state) => state.state === 'HALTED' && (state.until === undefined || state.until > input.now))
  }

  private haltedFor(account: Account, instrumentId: string): boolean {
    if (this.killSwitch.tripped) return true
    const scopes = [ORG_SCOPE, { type: 'account', id: account.accountId } as const, { type: 'instrument', id: instrumentId } as const]
    return this.x.tstate.effective(scopes, account.groupIds).state === 'HALTED'
  }

  private rejectAmend(order: Order, after: { price?: string | null; size?: string; triggerPrice?: string | null }, ctx: ActorCtx, reason: string, problem: Problem, direction = 'unchanged'): never {
    this.x.ledger.append({ type: 'order.rejected', origin: ctx.origin,
      subject: { accountId: order.accountId, orderId: order.orderId, clientOrderId: order.clientOrderId },
      payload: { kind: 'amend', reason, problem, before: { price: order.price, size: order.size, triggerPrice: order.triggerPrice }, after,
        direction, scopeState: this.amendScope(order), actor: ctx.origin.actor, actorType: ctx.origin.actorType } })
    throw new KernelError(problem)
  }

  private amendAuthorization(order: Order, after: NormalizedIntent, input: GateInput, snapshot: AccountSnapshot, ctx: ActorCtx): void {
    const protective = order.tpslRole === 'tp' || order.tpslRole === 'sl'
      || order.reduceOnly === true && ['stop_market', 'stop_limit', 'take_market', 'take_limit', 'trailing_stop'].includes(order.type)
      || this.isProtectiveOrder(order, snapshot)
    const take = order.type === 'take_market' || order.type === 'take_limit' || order.tpslRole === 'tp'
    const fartherUp = take ? order.side === 'sell' : order.side === 'buy'
    const triggerChanged = (after.triggerPrice ?? null) !== (order.triggerPrice ?? null)
    const triggerLoosen = triggerChanged && (after.triggerPrice == null || order.triggerPrice == null
      || (fartherUp ? d.gt(d.D(after.triggerPrice), d.D(order.triggerPrice)) : d.lt(d.D(after.triggerPrice), d.D(order.triggerPrice))))
    const limitLoosen = ['stop_limit', 'take_limit'].includes(order.type) && after.price != null && order.price != null
      && (order.side === 'sell' ? d.gt(d.D(after.price), d.D(order.price)) : d.lt(d.D(after.price), d.D(order.price)))
    const candidate = { ...order, ...after }
    const invariantChanged = candidate.type !== order.type || candidate.side !== order.side
      || (candidate.reduceOnly === true) !== (order.reduceOnly === true) || candidate.tpslRole !== order.tpslRole
    const loosen = triggerLoosen || limitLoosen || d.lt(d.D(after.size), d.D(order.size)) || invariantChanged
    const direction = loosen ? 'loosen' : 'tighten_or_unchanged'
    if (input.actorClass === 'agent' && ['HALTED', 'REDUCING'].includes(this.amendScope(order).state)) {
      this.rejectAmend(order, after, ctx, 'scope_state', makeProblem('TRADING_STATE', 'Agent amendments are blocked in this trading state'), direction)
    }
    const haltedReduction = order.reduceOnly === true && (this.amendScope(order).state === 'HALTED' || this.amendScope(order).killSwitch)
    const staleReduction = input.actorClass === 'human' && order.reduceOnly === true
      && Object.values(evaluateGateStages({ ...input, action: 'reduce' }).byStage).flat().some((hit) => hit.code === 'STALE_PRICE' && hit.action === 'warn')
    if ((protective || haltedReduction || staleReduction) && input.actorClass === 'human') {
      try { assertProof(ctx.proof, 'pin') }
      catch (error) { this.rejectAmend(order, after, ctx, 'presence', error instanceof KernelError ? error.problem : makeProblem('ATTESTATION_REQUIRED', 'PIN presence required'), direction) }
    }
    if (protective && input.actorClass === 'agent' && loosen) {
      const evaluated = evaluateGateStages({ ...input, action: 'cancel_protective' })
      const hits = Object.values(evaluated.byStage).flat().filter((hit) => hit.action === 'deny' || hit.action === 'review')
      const first = hits[0]
      this.rejectAmend(order, after, ctx, 'protective_loosen', makeProblem(first ? RULE_PROBLEM_DEFAULTS[first.code] ?? 'NEEDS_APPROVAL' : 'NEEDS_APPROVAL',
        'protective amendment requires a human with PIN presence', { ruleHits: hits }), direction)
    }
  }

  private clearPendingAmend(orderId: string, deferMemory = false): void {
    if (!deferMemory) this.pendingAmends.delete(orderId)
    const record = this.x.docs.get<OrderRecord>('order-record', orderId)
    if (record?.amendPending) { delete record.amendPending; this.x.docs.put('order-record', orderId, record) }
  }

  private replaceOrderReservation(order: Order, reservation: ReservationRecord, unknown = false): void {
    this.reservations.release(order.accountId, order.clientOrderId)
    const retainTerminalPending = unknown && this.pendingAmends.has(order.orderId)
    if (terminalOrder(order.status) && !retainTerminalPending || this.isUnlinkedChild(order.orderId)) return
    this.reservations.reserve(reservation)
    this.reservations.markRecorded(order.accountId, order.clientOrderId)
    const status = !unknown && ['open', 'untriggered', 'partially_filled'].includes(order.status)
      ? order.status as 'open' | 'untriggered' | 'partially_filled' : 'unknown'
    this.reservations.outcome(order.accountId, order.clientOrderId, { status, filledSize: order.filledSize, ...(order.venueOrderId ? { venueOrderId: order.venueOrderId } : {}) })
  }

  private restoreReservations(): void {
    const histories = new Map<string, { reservation?: ReservationRecord; observation?: ReservationObservation; released: boolean }>()
    for (const entry of this.x.ledger.iterate()) {
      if (!entry.subject.accountId || !entry.subject.clientOrderId) continue
      const key = `${entry.subject.accountId}\u0000${entry.subject.clientOrderId}`
      if (entry.type === 'order.intent' || entry.type === 'order.amended') {
        const reservation = (entry.payload as { reservation?: ReservationRecord } | undefined)?.reservation
        histories.set(key, { ...(reservation ? { reservation } : {}), released: false })
        continue
      }
      if (entry.type !== 'annotation') continue
      const payload = entry.payload as { kind?: string; state?: ReservationObservation } | undefined
      const history = histories.get(key)
      if (!history) continue
      if (payload?.kind === 'reservation.observation' && payload.state) history.observation = payload.state
      if (payload?.kind === 'reservation.released') history.released = true
    }
    const rows = this.x.db.prepare(`
      SELECT o.doc,o.notional FROM orders o
      WHERE o.status IN ('new','submitted','open','untriggered','partially_filled')
        OR EXISTS (
          SELECT 1 FROM docs d
          WHERE d.coll='order-record' AND d.id=o.order_id
            AND d.ver=(SELECT MAX(d2.ver) FROM docs d2 WHERE d2.coll='order-record' AND d2.id=o.order_id)
            AND json_type(d.doc, '$.amendPending')='object'
        )
    `).all() as { doc: string; notional: string }[]
    for (const row of rows) {
      const order = JSON.parse(row.doc) as Order
      const key = `${order.accountId}\u0000${order.clientOrderId}`
      const history = histories.get(key)
      const internal = this.x.docs.get<OrderRecord>('order-record', order.orderId)
      if (internal?.unlinked) continue
      if (internal?.amendPending) this.pendingAmends.set(order.orderId, { order, reservation: internal.amendPending.reservation, awaitingAck: false, ...(internal.replacementVenueOrderId ? { replacementVenueOrderId: internal.replacementVenueOrderId } : {}) })
      if (history?.released && !internal?.amendPending) continue
      const persisted = internal?.amendPending?.reservation ?? internal?.reservation ?? history?.reservation
      let notional: string | undefined
      try { const value = d.D(row.notional); if (d.gt(value, d.ZERO)) notional = d.str(value) } catch { /* invalid legacy estimate stays uncertain */ }
      const record: ReservationRecord = persisted ?? {
        accountId: order.accountId, clientOrderId: order.clientOrderId, ...(order.mandateId ? { mandateId: order.mandateId } : {}),
        instrumentId: order.instrumentId, side: order.side, size: order.size, notional: (notional ?? '0') as never,
        margin: (order.reduceOnly ? '0' : notional ?? '0') as never, issuedAt: order.createdAt, expiresAt: order.createdAt + 30_000,
        supportsExpiry: false, reduceOnly: order.reduceOnly === true,
      }
      this.reservations.reserve(record)
      this.reservations.markRecorded(order.accountId, order.clientOrderId)
      if (!persisted && !notional && !order.reduceOnly) {
        const ids = this.uncertainOrders.get(order.accountId) ?? new Set<string>()
        ids.add(order.clientOrderId); this.uncertainOrders.set(order.accountId, ids)
      }
      if (order.status === 'open' || order.status === 'untriggered' || order.status === 'partially_filled') this.reservations.outcome(order.accountId, order.clientOrderId, { status: order.status, filledSize: order.filledSize, ...(order.venueOrderId ? { venueOrderId: order.venueOrderId } : {}) })
      else this.reservations.outcome(order.accountId, order.clientOrderId, { status: 'unknown', filledSize: order.filledSize, ...(order.venueOrderId ? { venueOrderId: order.venueOrderId } : {}) })
      if (history?.observation) this.reservations.restoreObservation(order.accountId, order.clientOrderId, history.observation)
    }
  }

  // ================================================================
  // 取数
  // ================================================================
  /** 日亏基线：每个"日"（dailyResetAt）的第一次快照记下权益。 */
  dayBaseline(account: Account, equity: string): string {
    const now = this.x.clock.now()
    const key = dayKeyOf(now, this.x.risk.current()?.dailyResetAt ?? '00:00Z')
    const cur = this.x.docs.get<{ dayKey: string; equity: string }>('day', account.accountId)
    if (cur && cur.dayKey === key) return cur.equity
    this.x.docs.put('day', account.accountId, { dayKey: key, equity })
    return equity
  }

  private mandateOf(ctx: ActorCtx): Mandate | null {
    if (ctx.principal.kind !== 'agent' && ctx.principal.kind !== 'engine') return null
    return this.x.agents.effective(ctx.principal.mandateId) ?? null
  }

  /** 该钥匙 / 授权书是否已吊销：失败原因说「钥匙已撤销」，不说「授权书过期」。 */
  private keyRevoked(ctx: ActorCtx): boolean {
    if (ctx.principal.kind !== 'agent' && ctx.principal.kind !== 'engine') return false
    if (this.x.agents.getMandate(ctx.principal.mandateId)?.status === 'revoked') return true
    return ctx.principal.kind === 'agent' && this.x.agents.getKey(ctx.principal.keyId)?.status === 'revoked'
  }

  private signerFor(account: Account): Signer | undefined {
    if (account.mode !== 'live') return undefined
    this.x.assertLiveStateHealthy?.()
    const ks = this.x.keystore
    if (!ks) throw err('VENUE_AUTH', 'no keystore available for live trading')
    if (!ks.isUnlocked()) throw err('VENUE_AUTH', 'keystore is locked: unlock it with your PIN before live trading')
    if (account.signer.type === 'api-key' || account.signer.type === 'gateway-session') return undefined
    if (!account.signer.credentialRef) throw err('VENUE_AUTH', `account ${account.alias} has no signerRef; import an API wallet first`)
    try { return ks.getSigner(account.signer.credentialRef) } catch (e) { // 钱包撤销 / 过期 / 不存在：按场所鉴权失败处理，订单不会到达场所
      throw err('VENUE_AUTH', e instanceof KernelError ? e.problem.message : String(e))
    }
  }

  private async precheck(account: Account, n: NormalizedIntent, ctx: ActorCtx, path: 'direct' | 'proposal' | 'approved', mandate: Mandate | null, dryRun = true): Promise<AssembledOrderGate> {
    const data = await this.collectGateData(account, n)
    return this.assembleOrderGate(data, account, n, ctx, path, this.reservations.fork(), dryRun, false, mandate?.mandateId)
  }

  private async collectGateData(account: Account, n: Pick<NormalizedIntent, 'instrumentId'> | string | undefined, providedSnapshot?: AccountSnapshot): Promise<CollectedGateData> {
    const sampledAccount = structuredClone(account)
    const routeKey = this.x.bus.snapshotRouteKey(sampledAccount)
    const deadlineAt = performance.now() + 10_000
    const maxMarkAgeMs = this.x.risk.current()?.failClosed.stalePriceMs ?? 5_000
    const fallback = (): CollectedGateData => {
      const prior = this.lastGateSnapshots.get(account.accountId)
      const snapshot = prior?.routeKey === routeKey
        ? { ...structuredClone(prior.snapshot), stale: true }
        : { accountId: account.accountId, ts: this.x.clock.now(), equity: '0' as never, available: '0' as never, positions: [], openOrders: [], stale: true }
      return { routeKey, snapshot, openOrderValuations: {}, valuedOpenOrders: [] }
    }
    const read = async (): Promise<CollectedGateData> => {
      const snapshot = providedSnapshot ? structuredClone(providedSnapshot) : await this.x.bus.snapshot(sampledAccount)
      const instrumentId = typeof n === 'string' ? n : n?.instrumentId
      const markOptions = { deadline: deadlineAt, maxAgeMs: maxMarkAgeMs }
      const mark = instrumentId ? await this.x.bus.gateMark(instrumentId, { ...markOptions, allowStale: true }).catch(() => undefined) : undefined
      const openOrderValuations: CollectedGateData['openOrderValuations'] = {}
      const valuedOpenOrders: ValuedOpenOrder[] = []
      const markCache = new Map<string, Promise<import('./connector').MarkPrice | undefined>>()
      const markFor = (instrumentId: string) => {
        let value = markCache.get(instrumentId)
        if (!value) { value = this.x.bus.gateMark(instrumentId, markOptions).catch(() => undefined); markCache.set(instrumentId, value) }
        return value
      }
      for (const order of snapshot.openOrders ?? []) {
        let notional: string | undefined
        let margin: string | undefined
        if (!order.reduceOnly) {
          const inst = this.x.bus.instrument(order.instrumentId)
          const ownMark = order.price !== null && order.price !== undefined ? undefined : order.instrumentId === instrumentId ? mark : await markFor(order.instrumentId)
          const price = gateRefPrice(order, ownMark?.price)
          if (inst) openOrderValuations[order.instrumentId] = { contractSize: inst.contractSize, ...(ownMark ? { mark: ownMark.price } : {}) }
          if (inst && price !== undefined) {
            notional = d.str(d.mul(d.mul(d.D(order.size), d.D(price)), d.D(inst.contractSize)))
            const candidate = order.clientOrderId ? this.x.orders.byClientOrderId(order.clientOrderId) : undefined
            const local = candidate?.accountId === account.accountId && candidate.instrumentId === order.instrumentId ? candidate : undefined
            const leverage = local?.leverage && local.leverage > 0 ? String(local.leverage) : '1'
            margin = budgetMargin(d.mul(d.D(notional), d.ONE), d.D(leverage))
          }
        }
        valuedOpenOrders.push({ venueOrderId: order.venueOrderId, clientOrderId: order.clientOrderId, instrumentId: order.instrumentId, side: order.side, remainingSize: order.size as never, reduceOnly: order.reduceOnly, ...(notional === undefined ? {} : { notional: notional as never }), ...(margin === undefined ? {} : { margin: margin as never }) })
      }
      this.retainPendingAmends(account.accountId, snapshot, valuedOpenOrders)
      return { routeKey, snapshot, ...(mark ? { mark } : {}), openOrderValuations, valuedOpenOrders }
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(err('VENUE_OUTCOME_UNKNOWN', 'gate data collection timed out')), Math.max(0, deadlineAt - performance.now())) })
    try {
      const result = await Promise.race([read(), deadline])
      this.lastGateSnapshots.set(account.accountId, { routeKey, snapshot: structuredClone(result.snapshot) })
      return result
    } catch {
      this.x.bus.invalidateSnapshot(account.accountId)
      return fallback()
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  private writeReconcileEvidence(accountId: string, result: ReconcileResult): void {
    this.x.ledger.append({ type: 'annotation', origin: mkOrigin('system:kernel', 'reservation:reconcile', 'internal'), subject: { accountId: brand(accountId) }, payload: { kind: 'reservation_reconcile', ...result } })
  }

  private applyReconciliation(accountId: string, book: ReservationBook, result: ReconcileResult, rows: ValuedOpenOrder[], fresh: boolean): Set<string> {
    const uncertain = new Set(this.uncertainOrders.get(accountId) ?? [])
    for (const clientOrderId of result.released) uncertain.delete(clientOrderId)
    if (fresh && result.complete && uncertain) for (const row of rows) {
      if (!row.clientOrderId || row.reduceOnly || row.margin === undefined || row.notional === undefined || d.lte(d.D(row.remainingSize), d.ZERO) || d.lte(d.D(row.notional), d.ZERO)) continue
      uncertain.delete(row.clientOrderId)
    }
    if (book === this.reservations) {
      for (const observation of result.observations) this.x.ledger.append({
        type: 'annotation', origin: mkOrigin('system:kernel', 'reservation:reconcile', 'internal'),
        subject: { accountId: brand(accountId), clientOrderId: brand(observation.clientOrderId) },
        payload: { kind: 'reservation.observation', state: observation.state },
      })
      for (const release of result.unknownReleases) this.x.ledger.append({
        type: 'annotation', origin: mkOrigin('system:kernel', 'reservation:reconcile', 'internal'),
        subject: { accountId: brand(accountId), clientOrderId: brand(release.clientOrderId) },
        payload: { kind: 'reservation.released', reason: release.reason, evidence: release.evidence, missingSince: release.missingSince, lastObservationAt: release.lastObservationAt },
      })
      const unknownReleaseIds = new Set(result.unknownReleases.map((release) => release.clientOrderId))
      for (const clientOrderId of result.released) {
        if (unknownReleaseIds.has(clientOrderId)) continue
        const order = this.x.orders.byClientOrderId(clientOrderId)
        if (order?.accountId === accountId && !this.isUnlinkedChild(order.orderId) && !['filled', 'cancelled', 'rejected', 'expired', 'denied'].includes(order.status)) this.onOrderUpdate(accountId, { venueOrderId: order.venueOrderId ?? '', clientOrderId, status: 'expired' }, { origin: mkOrigin('system:kernel', 'reservation:expire', 'internal') })
      }
      if (uncertain.size > 0) this.uncertainOrders.set(accountId, uncertain)
      else this.uncertainOrders.delete(accountId)
      if (result.changed || result.released.length || result.retainedUnknown.length) this.writeReconcileEvidence(accountId, result)
    }
    return uncertain
  }

  private assembleControlGate(data: CollectedGateData, account: Account, target: GateTarget, action: GateAction, ctx: ActorCtx, book: ReservationBook, instrumentId?: string, explicitMandateId?: string) {
    account = structuredClone(this.x.accounts.get(account.accountId))
    if (account.status !== 'active') throw err('ACCOUNT_NOT_BOUND', `account ${account.alias} is ${account.status}`)
    if (data.routeKey !== this.x.bus.snapshotRouteKey(account)) throw err('STALE_PRICE', 'account route changed while gate data was collected', { retryable: true })
    const started = performance.now(), now = this.x.clock.now(), policy = this.x.risk.current() ?? null
    const mandateId = explicitMandateId ?? ((ctx.principal.kind === 'agent' || ctx.principal.kind === 'engine') ? ctx.principal.mandateId : undefined)
    const verified = mandateId ? this.x.agents.verifyMandate(mandateId) : true
    const mandate = mandateId ? this.x.agents.effective(mandateId, now) ?? null : null
    const mandateIntegrity = { ok: !mandateId || (verified && !!mandate), problems: !mandateId || (verified && mandate) ? [] : ['mandate verification failed'] }
    const confirmedFresh = data.snapshot.confirmedAt === undefined || now - data.snapshot.confirmedAt <= (policy?.failClosed.staleAccountMs ?? 30_000)
    const truncated = data.snapshot.truncated === true
    const fresh = !data.snapshot.stale && !truncated && confirmedFresh
    const rec = book.reconcileReservations({ accountId: account.accountId, now, fresh, observationAt: data.snapshot.confirmedAt ?? data.snapshot.asOf ?? data.snapshot.ts, truncated, availableDeductsOpenOrders: data.snapshot.availableDeductsOpenOrders ?? false, openOrders: data.valuedOpenOrders })
    const uncertain = this.applyReconciliation(account.accountId, book, rec, data.valuedOpenOrders, fresh)
    const snapshot = { ...data.snapshot, gateOpenOrders: this.gateOpenOrders(data.valuedOpenOrders), stale: !!data.snapshot.stale || !book.complete(account.accountId) || uncertain.size > 0 }
    const dayStart = dayStartTs(now, policy?.dailyResetAt ?? '00:00Z'), reserved = book.view(account.accountId, now, dayStart)
    const scopeInstrumentId = target.kind === 'order' ? target.intent.instrumentId : target.kind === 'leverage' ? target.instrumentId : instrumentId ?? (target.kind === 'cancel_all' ? target.instrumentId : undefined)
    const scopes = [ORG_SCOPE, { type: 'account', id: account.accountId } as const, ...(scopeInstrumentId ? [{ type: 'instrument', id: scopeInstrumentId } as const] : []), ...(mandate ? [{ type: 'mandate', id: mandate.mandateId } as const] : [])]
    const states = this.x.tstate.effective(scopes, account.groupIds).reasons
    const budget = this.x.bus.budget(account.venue), policyIntegrity = this.x.risk.integrity
    const dayKey = dayKeyOf(now, policy?.dailyResetAt ?? '00:00Z'), day = this.x.docs.get<{ dayKey: string; equity: string }>('day', account.accountId)
    const pending = book.pendingCounts(account.accountId, now, dayStart), mandatePending = mandate ? book.pendingCounts(account.accountId, now, dayStart, mandate.mandateId) : { ordersToday: 0, ordersLastMinute: 0 }
    const stats = { ...(day?.dayKey === dayKey ? { dayStartEquity: day.equity as never } : {}), dailyNotional: d.str(this.x.orders.notionalSince(account.accountId, dayStart)) as never, mandateDailyNotional: (mandate ? d.str(this.x.orders.notionalSince(account.accountId, dayStart, mandate.mandateId)) : '0') as never, ordersLastMinute: this.x.orders.countSince(account.accountId, now - 60_000) + pending.ordersLastMinute, ordersToday: this.x.orders.countSince(account.accountId, dayStart) + pending.ordersToday, mandateOrdersToday: mandate ? this.x.orders.countSince(account.accountId, dayStart, mandate.mandateId) + mandatePending.ordersToday : 0, mandateOrdersLastMinute: mandate ? this.x.orders.countSince(account.accountId, now - 60_000, mandate.mandateId) + mandatePending.ordersLastMinute : 0, ...(this.x.orders.lastOpenTs(account.accountId) !== undefined ? { lastOpenTs: this.x.orders.lastOpenTs(account.accountId)! } : {}) }
    const input = assembleGateInput({ target, action, account, snapshot, ...(data.openOrderValuations ? { openOrderValuations: data.openOrderValuations } : {}), ...(data.cancelPriceChecks === undefined ? {} : { cancelPriceChecks: data.cancelPriceChecks }), ...(scopeInstrumentId ? { inst: this.x.bus.instrument(scopeInstrumentId) } : {}), policy, policyIntegrity, mandateIntegrity, mandate, states, stats, ...(budget ? { rate: { used: budget.used(), limit: budget.limit } } : {}), reserved, path: 'direct', actorType: ctx.origin.actorType, now, precheckId: newId('pck'), dryRun: false, killSwitch: this.killSwitch, venueRules: snapshot.rules })
    const boundary = performance.now(), precheck = this.x.gate.decide(input)
    return { account, input, precheck, snapshot, mandate, timing: { assembleUs: Math.max(0, (boundary - started) * 1000), decideUs: Math.max(0, (performance.now() - boundary) * 1000), protectorUs: 0 } }
  }

  private async collectCancelPriceChecks(instrumentIds: readonly string[], ctx: ActorCtx): Promise<GateInput['cancelPriceChecks']> {
    const ids = [...new Set(instrumentIds)].sort()
    const maxAgeMs = this.x.risk.current()?.failClosed.stalePriceMs ?? 5_000
    const cacheOnly = ctx.principal.kind !== 'agent' && ctx.principal.kind !== 'engine'
    return Promise.all(ids.map(async (instrumentId) => {
      const mark = await this.x.bus.gateMark(instrumentId as never, { allowStale: true, ...(cacheOnly ? { cacheOnly: true } : { deadline: performance.now() + 3_000 }), maxAgeMs }).catch(() => undefined)
      const quote = this.x.bus.instrument(instrumentId as never)?.quote
      return { instrumentId: instrumentId as never, ...(quote ? { quote } : {}), ...(mark && mark.source === 'venue_mark' ? { mark: { price: mark.price, ts: mark.ts, source: 'venue_mark' as const } } : {}) }
    }))
  }

  /** Synchronous post-read assembly: no service read may be inserted after this point before decide. */
  private assembleOrderGate(data: CollectedGateData, account: Account, n: NormalizedIntent, ctx: ActorCtx, path: 'direct' | 'proposal' | 'approved', book: ReservationBook, dryRun: boolean, commitState: boolean, explicitMandateId?: string, action?: 'amend'): AssembledOrderGate {
    account = structuredClone(this.x.accounts.get(account.accountId))
    if (account.status !== 'active') throw err('ACCOUNT_NOT_BOUND', `account ${account.alias} is ${account.status}`)
    if (data.routeKey !== this.x.bus.snapshotRouteKey(account)) throw err('STALE_PRICE', 'account route changed while gate data was collected', { retryable: true })
    const started = performance.now()
    const now = this.x.clock.now()
    const inst = this.x.bus.instrument(n.instrumentId)
    if (!inst) throw this.unknownInstrument(n.instrumentId)
    const policy = this.x.risk.current() ?? null
    const policyIntegrity = this.x.risk.integrity
    const mandateId = explicitMandateId ?? ((ctx.principal.kind === 'agent' || ctx.principal.kind === 'engine') ? ctx.principal.mandateId : undefined)
    const mandateVerified = mandateId ? this.x.agents.verifyMandate(mandateId) : true
    const mandate = mandateId ? this.x.agents.effective(mandateId, now) ?? null : null
    const mandateIntegrity = mandateId ? { ok: mandateVerified && !!mandate, problems: mandateVerified && mandate ? [] as string[] : ['mandate verification failed'] } : { ok: true, problems: [] as string[] }
    const dayStart = dayStartTs(now, policy?.dailyResetAt ?? '00:00Z')
    const key = dayKeyOf(now, policy?.dailyResetAt ?? '00:00Z')
    const currentDay = this.x.docs.get<{ dayKey: string; equity: string }>('day', account.accountId)
    const confirmedFresh = data.snapshot.confirmedAt === undefined || now - data.snapshot.confirmedAt <= (policy?.failClosed.staleAccountMs ?? 30_000)
    const truncated = data.snapshot.truncated === true
    const fresh = !data.snapshot.stale && !truncated && confirmedFresh
    const reconciliation = book.reconcileReservations({ accountId: account.accountId, now, fresh, observationAt: data.snapshot.confirmedAt ?? data.snapshot.asOf ?? data.snapshot.ts, truncated, availableDeductsOpenOrders: data.snapshot.availableDeductsOpenOrders ?? false, openOrders: data.valuedOpenOrders })
    const uncertain = this.applyReconciliation(account.accountId, book, reconciliation, data.valuedOpenOrders, fresh)
    const snapshot = { ...data.snapshot, gateOpenOrders: this.gateOpenOrders(data.valuedOpenOrders), stale: !!data.snapshot.stale || !book.complete(account.accountId) || uncertain.size > 0 }
    const reductionSize = book.reductionSize(account.accountId, n.instrumentId, n.side)
    const normalization = normalizeRiskTarget(n, snapshot.positions.map((p) => ({ instrumentId: p.instrumentId, side: p.side, size: p.size, notional: p.notional, leverage: p.leverage })), reductionSize)
    if (normalization.action === 'open' && inst.status === 'reduce_only') throw err('INSTRUMENT_UNKNOWN', `instrument ${inst.instrumentId} is reduce-only`)
    const inputIntent = normalization.intent
    const pending = book.pendingCounts(account.accountId, now, dayStart)
    const mandatePending = mandate ? book.pendingCounts(account.accountId, now, dayStart, mandate.mandateId) : { ordersToday: 0, ordersLastMinute: 0 }
    const dayStartEquity = currentDay?.dayKey === key ? currentDay.equity : snapshot.equity
    const reserved = book.view(account.accountId, now, dayStart)
    const baseline = fresh && book.complete(account.accountId)
      ? commitState ? this.dayBaseline(account, snapshot.equity) : dayStartEquity
      : currentDay?.dayKey === key ? currentDay.equity : undefined
    if (commitState && fresh && book.complete(account.accountId)) this.x.protectors.onEquity(account.accountId, d.D(snapshot.equity))
    const scopes = [ORG_SCOPE, { type: 'account', id: account.accountId } as const, { type: 'instrument', id: n.instrumentId } as const, ...(mandate ? [{ type: 'mandate', id: mandate.mandateId } as const] : [])]
    const states = this.x.tstate.effective(scopes, account.groupIds).reasons
    const budget = this.x.bus.budget(account.venue)
    const stats = {
      ...(baseline === undefined ? {} : { dayStartEquity: baseline as never }),
      dailyNotional: d.str(this.x.orders.notionalSince(account.accountId, dayStart)) as never,
      mandateDailyNotional: (mandate ? d.str(this.x.orders.notionalSince(account.accountId, dayStart, mandate.mandateId)) : '0') as never,
      ordersLastMinute: this.x.orders.countSince(account.accountId, now - 60_000) + pending.ordersLastMinute,
      ...this.duplicateStats(account, inputIntent, now),
      ordersToday: this.x.orders.countSince(account.accountId, dayStart) + pending.ordersToday,
      mandateOrdersToday: mandate ? this.x.orders.countSince(account.accountId, dayStart, mandate.mandateId) + mandatePending.ordersToday : 0,
      mandateOrdersLastMinute: mandate ? this.x.orders.countSince(account.accountId, now - 60_000, mandate.mandateId) + mandatePending.ordersLastMinute : 0,
      ...(this.x.orders.lastOpenTs(account.accountId) !== undefined ? { lastOpenTs: this.x.orders.lastOpenTs(account.accountId)! } : {}),
    }
    const effectivePath = path === 'direct' && ctx.principal.kind === 'engine' && account.mode === 'live' && mandate?.level === 'L2' ? 'proposal' : path
    let input = assembleGateInput({ ...(action ? { action, target: { kind: 'order', intent: inputIntent } as GateTarget } : { intent: inputIntent }), account, inst, snapshot, ...(data.openOrderValuations ? { openOrderValuations: data.openOrderValuations } : {}), ...(normalization.originalTargetDigest ? { originalTargetDigest: normalization.originalTargetDigest } : {}), ...(data.mark ? { mark: data.mark } : {}), mandate, policy, policyIntegrity, mandateIntegrity, states, stats, ...(budget ? { rate: { used: budget.used(), limit: budget.limit } } : {}), reserved, reservedReductionSize: reductionSize, path: effectivePath, actorType: ctx.origin.actorType, now, precheckId: newId('pck'), dryRun, killSwitch: this.killSwitch, venueRules: snapshot.rules })
    const markStale = !!input.mark && input.now - input.mark.ts > (input.policy?.failClosed.stalePriceMs ?? 5_000)
    if (path === 'approved' && ctx.principal.kind === 'session' && ctx.proof?.presence === 'pin' && input.action === 'reduce' && (this.haltedOrKilled(input) || markStale)) input = { ...input, actorClass: 'human' }
    const boundary = performance.now()
    const assembleUs = Math.max(0, (boundary - started) * 1000)
    const precheck = this.x.gate.decide(input)
    const decideUs = Math.max(0, (performance.now() - boundary) * 1000)
    if (input.target.kind !== 'order') throw err('INTERNAL_ERROR', 'order gate assembly returned a non-order target')
    const requiresOwnershipApproval = this.reductionAuthorization(input, ctx, dryRun)
    return { account, input, precheck, snapshot, mandate, normalizedIntent: input.target.intent, normalization, requiresOwnershipApproval, timing: { assembleUs, decideUs, protectorUs: 0 } }
  }

  /** 业务授权层：他人或归属未知的减仓走开仓白名单 / 档位；实际风控票仍是 reduce。 */
  private reductionAuthorization(input: GateInput, ctx: ActorCtx, dryRun: boolean): boolean {
    if (input.actorClass !== 'agent' || input.target.kind !== 'order' || !(input.action === 'reduce' || input.action === 'amend' && input.target.intent.reduceOnly)) return false
    const intent = input.target.intent
    const owners = this.x.orders.positionOwners(input.account.accountId, intent.instrumentId)
    const pos = input.snapshot.positions.find((p) => p.instrumentId === intent.instrumentId)
    const expected = pos ? (pos.side === 'long' ? d.D(pos.size) : d.neg(d.D(pos.size))) : d.ZERO
    const own = owners.actors.length === 1 && owners.actors[0] === ctx.origin.actor && d.eq(d.D(owners.net), expected)
    if (own) return false
    const authorityInput: GateInput = { ...input, action: 'open', path: input.path === 'direct' && input.mandate?.level === 'L2' ? 'proposal' : input.path }
    const evaluated = evaluateGateStages(authorityInput)
    const hits = (['MANDATE', 'ALLOWLIST', 'APPROVAL', 'LLM'] as const).flatMap((stage) => evaluated.byStage[stage] ?? []).filter((hit) => hit.action === 'deny' || hit.action === 'review')
    const denied = hits.find((hit) => hit.action === 'deny')
    const pending = !denied && hits.some((hit) => hit.action === 'review')
    if (!dryRun) this.x.ledger.append({
      type: 'annotation', origin: ctx.origin,
      subject: { accountId: input.account.accountId, instrumentId: intent.instrumentId, clientOrderId: intent.clientOrderId, precheckId: input.precheckId },
      payload: { kind: 'reduction.authorization', actor: ctx.origin.actor, source: 'fills+orders.origin', owners: owners.actors, ledgerNet: owners.net, snapshotNet: d.str(expected), classification: 'other_or_unknown', required: 'open', path: input.path, result: denied ? 'denied' : pending ? 'pending' : 'allowed', policyVersion: input.policy?.version, mandateId: input.mandate?.mandateId, mandateVersion: input.mandate?.version, ruleHits: hits },
    })
    if (denied) throw err(RULE_PROBLEM_DEFAULTS[denied.code] ?? 'RULE_DENIED', `other-owner reduction: ${denied.message ?? denied.code}`, { ruleHits: hits })
    return pending
  }

  /** 只预检不落账、不发令牌（host.risk.precheck）。 */
  async precheckIntent(intent: OrderIntent, ctx: ActorCtx): Promise<GateDecision> {
    const account = this.x.accounts.get(intent.accountId)
    const mandate = this.mandateOf(ctx)
    const n = this.normalize(account, intent, ctx)
    const checked = await this.precheck(account, n, ctx, 'direct', mandate)
    if (checked.requiresOwnershipApproval) throw err('NEEDS_APPROVAL', 'other-owner reduction requires a human-approved proposal')
    return checked.precheck
  }

  /** 防重复报单：窗口内是否已有同标的同方向同价同量的订单（市价单价格为空互相比较）。 */
  private duplicateStats(account: Account, n: NormalizedIntent, now: number): { duplicateOf?: string } {
    const win = (this.x.risk.effectiveLimits(now).duplicateIntentWindowSec ?? DEFAULT_DUPLICATE_WINDOW_SEC) * 1000
    if (win <= 0 || n.reduceOnly) return {}
    const twin = this.x.orders.since(account.accountId, now - win).find((o) => o.clientOrderId !== n.clientOrderId && o.instrumentId === n.instrumentId && o.side === n.side && o.size === n.size && (o.price ?? null) === (n.price ?? null) && o.type === n.type)
    return twin ? { duplicateOf: twin.orderId } : {}
  }

  /** clientOrderId 幂等：同 id 在时间窗内重复提交 → 返回原订单，不重发；参数不同的复用 → 拒绝；超窗口的旧 id 也不能再用。 */
  private idempotent(n: NormalizedIntent): Order | undefined {
    const prior = this.x.docs.get<{ orderId: string; digest: string; originalDigest?: string; submissionDigest?: string; ts: number }>('cloid', n.clientOrderId)
    if (!prior) return undefined
    if (prior.digest !== digestOf(n) && prior.originalDigest !== digestOf(n) && prior.submissionDigest !== digestOf(n)) throw err('INVALID_PARAMS', 'clientOrderId was already used with different order parameters')
    if (this.x.clock.now() - prior.ts > CLIENT_ORDER_ID_WINDOW_MS) throw err('INVALID_PARAMS', 'clientOrderId was already used (idempotency window elapsed); use a new id')
    return this.x.orders.get(prior.orderId)
  }

  /** fix-r3 ADR-23：取不到标的时，目录还在加载报可重试的「行情未就绪」，否则仍是 INSTRUMENT_UNKNOWN。 */
  private unknownInstrument(id: InstrumentId): KernelError {
    if (this.x.bus.catalogLoading(id)) {
      const venue = id.slice(0, Math.max(0, id.indexOf(':')))
      // UX-10：目录加载不出来是因为场所连不上（熔断打开）时，说「连不上」，不说「还在加载」。
      if (this.x.bus.venueUnreachable(venue)) {
        return new KernelError({
          ...makeProblem('VENUE_UNAVAILABLE', `cannot reach ${venue} (network down or exchange unreachable); retry later`),
          retryable: true,
          venue: { id: venue, message: 'circuit open: venue unreachable' },
        })
      }
      return new KernelError({
        ...makeProblem('VENUE_UNAVAILABLE', `market data not ready: the ${venue} instrument list is still loading; retry in 3 s`),
        retryable: true,
        retryAfterMs: 3000,
        venue: { id: venue, message: 'instrument list is still loading' },
      })
    }
    return err('INSTRUMENT_UNKNOWN', `unknown instrument ${id}`)
  }

  private normalize(account: Account, intent: OrderIntent, ctx: ActorCtx): NormalizedIntent {
    if (intent.accountId !== account.accountId) throw err('ACCOUNT_NOT_BOUND', 'intent.accountId mismatch')
    if (account.status !== 'active') throw err('ACCOUNT_NOT_BOUND', `account ${account.alias} is ${account.status}`)
    if (ctx.origin.actorType !== 'human') {
      const r = intent.reason
      if (typeof r !== 'string' || r.trim().length < 1 || r.length > 2000) throw err('INVALID_PARAMS', 'reason (1-2000 characters) is required for non-human actors')
    }
    const inst = this.x.bus.instrument(intent.instrumentId)
    if (!inst) throw this.unknownInstrument(intent.instrumentId)
    const mark = this.x.bus.mark(intent.instrumentId)
    const warnings: string[] = []
    const n = normalizeIntent(intent, inst, { ...(mark ? { mark: mark.price } : {}), defaultMaxSlippageBps: this.x.risk.effectiveLimits().maxSlippageBps, deferRiskClassification: true, now: this.x.clock.now(), warnings })
    this.normalizeWarnings = warnings
    return n
  }
  /** fix-r2 T6：最近一次规范化丢掉的未知字段说明（同步取走，进回执 warnings）。 */
  private normalizeWarnings: string[] = []
  private takeNormalizeWarnings(): string[] { const w = this.normalizeWarnings; this.normalizeWarnings = []; return w }

  private writePrecheckLedger(account: Account, n: NormalizedIntent, pc: GateDecision, ctx: ActorCtx, mandate: Mandate | null, extra: { orderId?: string; proposalId?: string; input?: GateInput; timing?: AssembledOrderGate['timing']; normalization?: ReturnType<typeof normalizeRiskTarget>; path?: 'preview' | 'proposal' } = {}): void {
    if (pc.dryRun) return
    const type = pc.verdict === 'deny' ? 'risk.denied' : 'risk.precheck'
    // fix-r2 L3（ADR-18）：只读预览每主体每分钟前 20 条逐条入账，其余计数进汇总条（提案 / 下单路径永远逐条）
    if ((extra.path ?? 'preview') === 'preview' && !this.precheckThrottle.admit(ctx.origin.actor, pc.ruleHits.map((h) => h.code), pc.precheckId)) {
      if (pc.verdict === 'deny') this.x.events.publish('risk.denials', { accountId: account.accountId, precheckId: pc.precheckId, ruleHits: pc.ruleHits, ts: this.x.clock.now(), summarized: true })
      return
    }
    this.x.ledger.append({
      type, origin: ctx.origin,
      subject: { accountId: brand(account.accountId), instrumentId: n.instrumentId, clientOrderId: n.clientOrderId, precheckId: pc.precheckId, ...(mandate ? { mandateId: mandate.mandateId } : {}), ...(extra.orderId ? { orderId: brand(extra.orderId) } : {}), ...(extra.proposalId ? { proposalId: brand(extra.proposalId) } : {}) },
      precheck: { precheckId: pc.precheckId, verdict: pc.verdict, policyVersion: pc.policyVersion, estimates: pc.estimates },
      ...(pc.decision !== 'ALLOW' ? { ruleHits: pc.ruleHits } : {}),
      payload: {
        intent: n, path: extra.path ?? 'preview',
        ...(extra.input ? { gate: { decision: pc, snapshot: gateSnapshotOf(extra.input), target: extra.input.target } } : {}),
        ...(extra.timing ? { timing: extra.timing } : {}),
        ...(extra.normalization && (extra.normalization.originalTargetDigest || extra.normalization.warnings.length) ? { normalization: { ...(extra.normalization.originalTargetDigest ? { originalTargetDigest: extra.normalization.originalTargetDigest } : {}), warnings: extra.normalization.warnings } } : {}),
      },
    })
    if (pc.verdict === 'deny') this.x.events.publish('risk.denials', { accountId: account.accountId, precheckId: pc.precheckId, ruleHits: pc.ruleHits, ts: this.x.clock.now(), ...(extra.orderId ? { orderId: extra.orderId } : {}) })
  }

  // ================================================================
  // order.preview / order.place
  // ================================================================
  async preview(intent: OrderIntent, ctx: ActorCtx, ttlMs: number = CONFIRM_TOKEN_DEFAULTS.ttlMs): Promise<PreviewResult> {
    const account = this.x.accounts.get(intent.accountId)
    const mandate = this.mandateOf(ctx)
    const n = this.normalize(account, intent, ctx)
    const normalizeWarnings = this.takeNormalizeWarnings()
    const assembled = await this.precheck(account, n, ctx, 'direct', mandate, false)
    const { precheck } = assembled
    const adjusted = adjustedGateTarget(assembled.input.target, precheck.applied)
    if (adjusted.kind !== 'order') throw err('INTERNAL_ERROR', 'preview adjustment returned a non-order target')
    const previewIntent = adjusted.intent
    const currentMandate = assembled.mandate
    this.writePrecheckLedger(account, previewIntent, precheck, ctx, currentMandate, { input: assembled.input, timing: assembled.timing, normalization: assembled.normalization })
    if (assembled.requiresOwnershipApproval) throw err('NEEDS_APPROVAL', 'other-owner reduction requires a human-approved proposal')
    const now = this.x.clock.now()
    const expiresAt = now + Math.min(Math.max(ttlMs, CONFIRM_TOKEN_DEFAULTS.minTtlMs), CONFIRM_TOKEN_DEFAULTS.maxTtlMs)
    const extraWarnings = normalizeWarnings.length ? { warnings: normalizeWarnings } : {}
    if (precheck.verdict === 'deny') return { normalizedIntent: previewIntent, precheck, expiresAt, ...extraWarnings }
    const tokenIntent = precheck.decision === 'LIMIT' ? { ...n, size: previewIntent.size } : n
    return { confirmToken: this.mintToken(tokenIntent, n, precheck, currentMandate, ctx, expiresAt), normalizedIntent: previewIntent, precheck, expiresAt, ...extraWarnings }
  }

  private mintToken(n: NormalizedIntent, authorIntent: NormalizedIntent, pc: PrecheckResult, mandate: Mandate | null, ctx: ActorCtx, expiresAt: number): string {
    const nonce = randomBytes(12).toString('base64url')
    const claims = {
      mandateId: mandate?.mandateId ?? null, accountId: n.accountId, digest: digestOf(n), authorDigest: digestOf(authorIntent), precheckId: pc.precheckId, policyVersion: pc.policyVersion,
      priceRef: pc.priceRef ? { markPrice: pc.priceRef.markPrice, ts: pc.priceRef.ts } : null, maxDriftBps: this.x.risk.maxDriftBps(), expiresAt, nonce,
    }
    const mac = createHmac('sha256', this.hmacKey).update(JSON.stringify(claims)).digest('base64url')
    this.tokens.set(nonce, { claims, intent: n, authorIntent, principalKey: principalKey(ctx.principal), mac })
    for (const [k, v] of this.tokens) if (v.claims.expiresAt < this.x.clock.now()) this.tokens.delete(k)
    return `ctk_${nonce}.${mac}`
  }

  private consumeToken(token: string, ctx: ActorCtx): TokenRecord {
    const m = /^ctk_([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(String(token ?? ''))
    const rec = m ? this.tokens.get(m[1] as string) : undefined
    if (!m || !rec) throw err('CONFIRM_TOKEN_INVALID', 'confirmToken is unknown, already used, or from a previous kernel run')
    this.tokens.delete(m[1] as string) // 一次性：无论成败都作废
    const mac = createHmac('sha256', this.hmacKey).update(JSON.stringify(rec.claims)).digest('base64url')
    if (!safeEqual(mac, m[2] as string) || !safeEqual(mac, rec.mac)) throw err('CONFIRM_TOKEN_INVALID', 'confirmToken signature mismatch')
    if (rec.claims.expiresAt < this.x.clock.now()) throw err('CONFIRM_TOKEN_INVALID', 'confirmToken expired')
    if (rec.principalKey !== principalKey(ctx.principal)) throw err('CONFIRM_TOKEN_INVALID', 'confirmToken was issued to a different caller')
    if (digestOf(rec.intent) !== rec.claims.digest) throw err('CONFIRM_TOKEN_INVALID', 'confirmToken intent digest mismatch')
    return rec
  }

  /**
   * 下单。两种调用形状：
   *   { confirmToken }  不再接收意图参数，只用令牌里绑定的规范化意图（实盘必须这样）；
   *   { intent }        人工手动单（仍过风控闸），或 L1+ 纸面 / 影子（可省略预览）。
   */
  async place(args: { confirmToken?: string; intent?: OrderIntent }, ctx: ActorCtx): Promise<PlaceResult> {
    let n: NormalizedIntent
    let authorIntent: NormalizedIntent
    let claims: TokenRecord['claims'] | undefined
    let intentWarnings: string[] = []
    if (args.confirmToken !== undefined) {
      if (args.intent !== undefined) throw err('INVALID_PARAMS', 'order.place accepts either confirmToken or intent, not both')
      const rec = this.consumeToken(args.confirmToken, ctx)
      n = rec.intent
      authorIntent = rec.authorIntent
      claims = rec.claims
    } else {
      if (!args.intent) throw err('INVALID_PARAMS', 'order.place requires confirmToken or intent')
      const acct = this.x.accounts.get(args.intent.accountId)
      // LLM Agent 的实盘单必须 preview → confirmToken → place；引擎（actorType = engine，确定性代码）在宿主内部一步完成：预检 → 授权书 → 够级别就下、不够转提案（host.order.place 语义）
      if (acct.mode === 'live' && ctx.origin.actorType !== 'human' && ctx.origin.actorType !== 'engine') throw err('CONFIRM_TOKEN_INVALID', 'live orders from non-human actors must go through order.preview and a confirmToken')
      n = this.normalize(acct, args.intent, ctx)
      authorIntent = n
      intentWarnings = this.takeNormalizeWarnings()
    }
    const result = await this.runOrder({ n, authorIntent, ctx, path: 'direct', ...(claims ? { claims } : {}) })
    const warnings = [...intentWarnings, ...(this.x.persistenceWarnings?.() ?? [])]
    return warnings.length ? { ...result, warnings } : result
  }

  // ================================================================
  // 执行
  // ================================================================
  private async withAccountQueue<T>(accountId: string, job: () => Promise<ExecutionStart<T>>, priority: 'high' | 'normal' = 'normal'): Promise<T> {
    const queue = this.orderQueues.get(accountId) ?? { running: false, high: [], normal: [] }
    this.orderQueues.set(accountId, queue)
    if (queue.running) await new Promise<void>((resolve) => { queue[priority].push(resolve) })
    else queue.running = true
    let started!: ExecutionStart<T>
    try {
      started = await job()
    } finally {
      const next = queue.high.shift() ?? queue.normal.shift()
      if (next) next()
      else {
        queue.running = false
        if (this.orderQueues.get(accountId) === queue) this.orderQueues.delete(accountId)
      }
    }
    return 'done' in started ? started.done : started.pending
  }

  private orderQueuePriority(n: NormalizedIntent, ctx: ActorCtx): 'high' | 'normal' {
    const trustedSystem = ctx.principal.kind === 'service' && ctx.origin.actor.startsWith('system:') && ctx.origin.actorType === 'system' && ctx.origin.via === 'internal'
    if (ctx.principal.kind === 'session' || trustedSystem || n.reduceOnly === true) return 'high'
    try {
      const account = this.x.accounts.get(n.accountId)
      const cached = this.lastGateSnapshots.get(account.accountId)
      if (!cached || cached.routeKey !== this.x.bus.snapshotRouteKey(account) || cached.snapshot.stale === true || cached.snapshot.truncated === true) return 'normal'
      const policy = this.x.risk.current()
      const observedAt = cached.snapshot.confirmedAt ?? cached.snapshot.asOf ?? cached.snapshot.ts
      const age = this.x.clock.now() - observedAt
      if (age < 0 || age > (policy?.failClosed.staleAccountMs ?? 30_000)) return 'normal'
      const position = cached.snapshot.positions.find((item) => item.instrumentId === n.instrumentId)
      if (!position) return 'normal'
      const opposite = position.side === 'long' ? n.side === 'sell' : n.side === 'buy'
      if (!opposite || !d.gt(d.D(n.size), d.ZERO)) return 'normal'
      const available = d.max(d.ZERO, d.sub(d.D(position.size), d.D(this.reservations.reductionSize(account.accountId, n.instrumentId, n.side))))
      return d.lte(d.D(n.size), available) ? 'high' : 'normal'
    } catch {
      return 'normal'
    }
  }

  private async runOrder(a: { n: NormalizedIntent; authorIntent: NormalizedIntent; ctx: ActorCtx; path: 'direct' | 'approved'; proposalId?: string; claims?: TokenRecord['claims']; priceBounds?: Proposal['priceBounds']; mandateId?: string }): Promise<PlaceResult> {
    const accountId = a.n.accountId
    return this.withAccountQueue<PlaceResult>(accountId, async (): Promise<ExecutionStart<PlaceResult>> => {
      const prior = this.idempotent(a.authorIntent)
      if (prior) return { done: { order: prior } }
      let reservedId: string | undefined
      let durable = false
      try {
      const currentAccount = this.x.accounts.get(accountId)
      if (mainnetLiveBlocked(currentAccount)) {
        throw err('CAPABILITY_UNSUPPORTED', `0.1.1 does not support mainnet live trading; see Known limitations. 0.1.1 不支持主网实盘交易，见已知限制。 (gate=${MAINNET_LIVE_ENABLED})`)
      }
      const data = await this.collectGateData(currentAccount, a.n)
      const effectiveMandateId = a.mandateId ?? ((a.ctx.principal.kind === 'agent' || a.ctx.principal.kind === 'engine') ? a.ctx.principal.mandateId : undefined)
      const assembled = this.assembleOrderGate(data, currentAccount, a.n, a.ctx, a.path, this.reservations, false, true, effectiveMandateId)
      const decision = assembled.precheck
      const stalePriceWarning = decision.ruleHits.some((hit) => hit.code === 'STALE_PRICE' && hit.action === 'warn')
      if (decision.verdict === 'allow' && assembled.input.actorClass === 'human' && assembled.input.action === 'reduce' && (this.haltedOrKilled(assembled.input) || stalePriceWarning)) assertProof(a.ctx.proof, 'pin')
      const claims = a.claims
      if (claims) {
        if (claims.accountId !== assembled.account.accountId || claims.authorDigest !== digestOf(a.authorIntent) || (claims.mandateId ?? null) !== (assembled.mandate?.mandateId ?? null)) throw err('CONFIRM_TOKEN_INVALID', 'preview binding changed; preview again')
        if (decision.policyVersion !== claims.policyVersion) throw err('CONFIRM_TOKEN_INVALID', 'risk policy changed since preview; preview again')
        if (claims.priceRef) {
          const mark = assembled.input.mark
          if (!mark) throw err('STALE_PRICE', 'no venue mark available to validate preview drift', { retryable: true })
          const ref = d.D(claims.priceRef.markPrice)
          const drift = d.mul(d.div(d.abs(d.sub(d.D(mark.price), ref)), ref), d.D('10000'))
          const maxDriftBps = Math.min(claims.maxDriftBps, this.x.risk.maxDriftBps())
          if (d.gt(drift, d.D(maxDriftBps))) throw err('PRICE_DRIFT', `price moved ${d.toNumber(drift).toFixed(1)} bps since preview (max ${maxDriftBps})`)
        }
      }
      if (a.priceBounds) {
        const mark = assembled.input.mark
        if (!mark) throw err('STALE_PRICE', 'no venue mark available to validate approved price bound', { retryable: true })
        const ref = d.D(a.priceBounds.referencePrice)
        const drift = d.mul(d.div(d.abs(d.sub(d.D(mark.price), ref)), ref), d.D('10000'))
        const maxDriftBps = Math.min(a.priceBounds.maxDriftBps, this.x.risk.maxDriftBps())
        if (d.gt(drift, d.D(maxDriftBps))) throw err('PRICE_DRIFT', `price moved ${d.toNumber(drift).toFixed(1)} bps beyond the approved bound (${maxDriftBps})`)
      }
      if (a.path === 'approved' && decision.ruleHits.some((hit) => hit.code === 'REDUCE_ONLY_MISMATCH')) {
        throw err('NEEDS_APPROVAL', 'approved reduceOnly target no longer matches the current position', { ruleHits: decision.ruleHits, precheckId: decision.precheckId })
      }
      if (decision.verdict === 'review' || (decision.verdict !== 'deny' && assembled.requiresOwnershipApproval)) {
        const mismatchReview = decision.ruleHits.some((hit) => hit.code === 'REDUCE_ONLY_MISMATCH')
        const target = mismatchReview ? assembled.input.target : adjustedGateTarget(assembled.input.target, decision.applied)
        if (target.kind !== 'order') throw err('INTERNAL_ERROR', 'review gate returned a non-order target')
        this.writePrecheckLedger(assembled.account, target.intent, decision, a.ctx, assembled.mandate, { input: assembled.input, timing: assembled.timing, normalization: assembled.normalization, path: 'proposal' })
        if (!assembled.mandate) throw err('NEEDS_APPROVAL', `gate review requires approval: ${decision.escalation?.reason ?? 'gate review'}`, { ruleHits: decision.ruleHits, precheckId: decision.precheckId })
        const proposal = await this.createProposal(assembled.account, [target.intent], target.intent.reason ?? '', undefined, a.ctx, assembled.mandate, this.precheckSummary(decision))
        return { done: { proposal, problem: makeProblem('NEEDS_APPROVAL', `needs human approval: ticket ${proposal.ticket}`, { ruleHits: decision.ruleHits, precheckId: decision.precheckId }) } }
      }
      const target = decision.decision === 'LIMIT' ? adjustedGateTarget(assembled.input.target, decision.applied) : assembled.input.target
      if (target.kind !== 'order') throw err('INTERNAL_ERROR', 'order execution gate returned a non-order target')
      const n = target.intent
      if (decision.verdict === 'deny') {
        if (decision.ruleHits.some((hit) => hit.code === 'INTENT_EXPIRED')) this.x.bus.budget(assembled.account.venue)?.charge(5)
        return { pending: this.startPreparedOrder({ account: assembled.account, n, ctx: a.ctx, mandate: assembled.mandate, precheck: decision, path: a.path, gateInput: assembled.input, timing: assembled.timing, normalization: assembled.normalization, authorIntent: a.authorIntent }).then((order) => ({ order })) }
      }
      if (decision.verdict === 'allow') {
        const ticket = this.ticketAuthority.issue(assembled.input, decision, target)
        const instrument = this.x.bus.instrument(n.instrumentId)
        if (!instrument) throw this.unknownInstrument(n.instrumentId)
        const refPrice = gateRefPrice(n, assembled.input.mark?.price)
        const notional = refPrice ? d.mul(d.mul(d.D(n.size), d.D(refPrice)), d.D(instrument.contractSize)) : d.ZERO
        const position = assembled.input.snapshot.positions.find((item) => item.instrumentId === n.instrumentId)
        const currentNotional = position ? d.max(d.ZERO, d.D(position.notional)) : d.ZERO
        const oldLeverage = position?.leverage && position.leverage > 0 ? d.D(position.leverage) : d.ONE
        const newLeverage = n.leverage && n.leverage > 0 ? d.D(n.leverage) : oldLeverage
        const marginNumerator = n.reduceOnly ? d.ZERO : d.add(d.mul(notional, oldLeverage), d.max(d.ZERO, d.mul(currentNotional, d.sub(oldLeverage, newLeverage))))
        const marginDenominator = n.reduceOnly ? d.ONE : d.mul(newLeverage, oldLeverage)
        const reservation: ReservationRecord = {
          accountId, clientOrderId: n.clientOrderId, ...(assembled.mandate ? { mandateId: assembled.mandate.mandateId } : {}),
          instrumentId: n.instrumentId, side: n.side, size: n.size as never,
          margin: n.reduceOnly ? '0' as never : budgetMargin(marginNumerator, marginDenominator),
          notional: n.reduceOnly ? '0' as never : d.str(notional) as never,
          issuedAt: this.x.clock.now(), expiresAt: ticket.expiresAt, supportsExpiry: this.x.bus.supportsOrderExpiry(assembled.account), reduceOnly: n.reduceOnly === true,
        }
        this.reservations.reserve(reservation)
        reservedId = n.clientOrderId
        let proposalId = a.proposalId
        let tracking: Proposal | undefined
        if (assembled.account.mode === 'live' && assembled.mandate && !proposalId) {
          tracking = await this.createProposal(assembled.account, [n], n.reason ?? '', undefined, a.ctx, assembled.mandate, this.precheckSummary(decision), { autoApprove: true })
          proposalId = tracking.proposalId
        }
        const pending = this.startPreparedOrder({ account: assembled.account, n, ctx: a.ctx, mandate: assembled.mandate, precheck: decision, path: a.path, proposalId, ticket, reservation, gateInput: assembled.input, timing: assembled.timing, normalization: assembled.normalization, authorIntent: a.authorIntent, authorDigest: claims?.authorDigest, submissionDigest: claims?.digest ?? digestOf(n), onRecorded: () => { durable = true } }).then(async (order) => {
          if (tracking) await this.finishProposal(tracking.proposalId, [order])
          return { order, ...(proposalId ? { proposal: this.getProposal(proposalId) } : {}) }
        }).catch((error: unknown) => {
          if (reservedId && !durable) this.reservations.release(accountId, reservedId)
          throw error
        })
        return { pending }
      }
      throw err('INTERNAL_ERROR', 'unsupported order gate verdict')
      } catch (error) {
        if (reservedId && !durable) this.reservations.release(accountId, reservedId)
        throw error
      }
    }, this.orderQueuePriority(a.n, a.ctx))
  }

  private precheckSummary(decision: GateDecision): PrecheckResult {
    return { precheckId: decision.precheckId, verdict: decision.verdict, policyVersion: decision.policyVersion, ruleHits: decision.ruleHits, estimates: decision.estimates, ...(decision.priceRef ? { priceRef: decision.priceRef } : {}), ...(decision.expiresAt !== undefined ? { expiresAt: decision.expiresAt } : {}) }
  }

  private async executeOrder(a: { account: Account; n: NormalizedIntent; ctx: ActorCtx; mandate: Mandate | null; precheck?: GateDecision; path: 'direct' | 'approved'; proposalId?: string }): Promise<Order> {
    const result = await this.runOrder({ n: a.n, authorIntent: a.n, ctx: a.ctx, path: a.path, ...(a.proposalId ? { proposalId: a.proposalId } : {}), ...(a.mandate?.mandateId ? { mandateId: a.mandate.mandateId } : {}) })
    if (!result.order) throw err('NEEDS_APPROVAL', result.problem?.message ?? 'needs human approval', { ruleHits: result.problem?.ruleHits })
    return result.order
  }

  private async boundedOrderLookup(account: Account, clientOrderId: string, order?: Partial<Pick<Order, 'createdAt' | 'instrumentId' | 'venueOrderId'>>): Promise<Awaited<ReturnType<ConnectorBus['lookup']>>> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        this.x.bus.lookup(account, clientOrderId, order ? { ...(order.createdAt === undefined ? {} : { sinceMs: order.createdAt }), ...(order.instrumentId ? { instrumentId: order.instrumentId } : {}), ...(order.venueOrderId ? { venueOrderId: order.venueOrderId } : {}) } : {}),
        new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), 10_000) }),
      ])
    } catch { return null }
    finally { if (timer !== undefined) clearTimeout(timer) }
  }

  private async startPreparedOrder(a: { account: Account; n: NormalizedIntent; ctx: ActorCtx; mandate: Mandate | null; precheck: GateDecision; path: 'direct' | 'approved'; proposalId?: string; ticket?: GateTicket; reservation?: ReservationRecord; gateInput?: GateInput; timing?: AssembledOrderGate['timing']; normalization?: ReturnType<typeof normalizeRiskTarget>; authorIntent?: NormalizedIntent; authorDigest?: Sha256Digest; submissionDigest?: Sha256Digest; onRecorded?: () => void }): Promise<Order> {
    const { account, n, ctx, mandate, precheck } = a
    const now = this.x.clock.now()
    const orderId = newId('ord', now)
    const inst = this.x.bus.instrument(n.instrumentId)
    const refPrice = gateRefPrice(n, a.gateInput?.mark?.price ?? precheck.priceRef?.markPrice)
    const notional = refPrice ? d.str(d.mul(d.mul(d.D(n.size), d.D(refPrice)), d.D(inst?.contractSize ?? '1'))) : '0'
    const opening = !n.reduceOnly
    const order: Order = {
      orderId, clientOrderId: n.clientOrderId, venueOrderId: null, accountId: account.accountId, instrumentId: n.instrumentId, side: n.side, type: n.type, tif: n.tif,
      size: n.size, filledSize: '0' as never, price: n.price ?? null, triggerPrice: n.triggerPrice ?? null, avgFillPrice: null,
      ...(n.reduceOnly !== undefined ? { reduceOnly: n.reduceOnly } : {}), ...(n.postOnly !== undefined ? { postOnly: n.postOnly } : {}), ...(n.leverage !== undefined ? { leverage: n.leverage } : {}),
      status: 'new', fee: '0' as never, ...(a.proposalId ? { proposalId: brand(a.proposalId) } : {}), ...(mandate ? { mandateId: mandate.mandateId } : {}), precheckId: precheck.precheckId,
      origin: ctx.origin, createdAt: now, updatedAt: now,
    }
    const subject = { accountId: brand<`acct_${string}`>(account.accountId), instrumentId: n.instrumentId, orderId, clientOrderId: n.clientOrderId, precheckId: precheck.precheckId, ...(mandate ? { mandateId: mandate.mandateId } : {}), ...(a.proposalId ? { proposalId: brand<`prop_${string}`>(a.proposalId) } : {}) }
    const pcLedger = { precheckId: precheck.precheckId, verdict: precheck.verdict, policyVersion: precheck.policyVersion, estimates: precheck.estimates }
    const gatePayload = a.gateInput ? { gate: { decision: precheck, snapshot: gateSnapshotOf(a.gateInput), target: a.gateInput.target, ...(a.ticket ? { ticketId: a.ticket.ticketId } : {}) }, ...(a.reservation ? { reservation: a.reservation } : {}), ...(a.timing ? { timing: a.timing } : {}), ...(a.normalization && (a.normalization.originalTargetDigest || a.normalization.warnings.length) ? { normalization: { ...(a.normalization.originalTargetDigest ? { originalTargetDigest: a.normalization.originalTargetDigest } : {}), warnings: a.normalization.warnings } } : {}) } : {}
    // 发往场所之前的所有写（幂等键 + 意图账本 + 订单状态 + 提交账本）并成一个事务：一次 fsync；先落意图再调连接器的顺序不变
    const pre = tx<{ done: Order } | { connectorId: string; signer: Signer | undefined }>(this.x.db, () => {
      this.x.docs.put('cloid', n.clientOrderId, { orderId, digest: digestOf(n), originalDigest: a.authorDigest ?? digestOf(a.authorIntent ?? n), submissionDigest: a.submissionDigest ?? digestOf(n), ts: now })
      this.x.docs.put('order-record', orderId, { intent: n, ...(a.reservation ? { reservation: a.reservation } : {}) } satisfies OrderRecord)
      this.x.ledger.append({ type: 'order.intent', origin: ctx.origin, subject, precheck: pcLedger, ...(precheck.decision !== 'ALLOW' ? { ruleHits: precheck.ruleHits } : {}), payload: { intent: n, path: a.path, ...gatePayload } })
      if (precheck.verdict === 'deny') {
        const problem = problemOfPrecheck(precheck)
        const denied: Order = { ...order, status: 'denied', problem, closedAt: now }
        this.x.orders.upsert(denied, notional, opening)
        this.x.ledger.append({ type: 'risk.denied', origin: ctx.origin, subject, precheck: pcLedger, ruleHits: precheck.ruleHits, payload: { ...gatePayload, problem: { code: problem.code, name: problem.name, message: problem.message } } })
        return { done: denied }
      }
      const connectorId = this.x.bus.routeFor(account).venue
      let signer: Signer | undefined
      try { signer = this.signerFor(account) } catch (e) {
        if (!(e instanceof KernelError)) throw e
        if (a.ticket) this.reservations.release(account.accountId, n.clientOrderId)
        const rejected: Order = { ...order, status: 'rejected', problem: e.problem, closedAt: now }
        this.x.orders.upsert(rejected, notional, opening)
        this.x.ledger.append({ type: 'order.rejected', origin: ctx.origin, subject, payload: { problem: e.problem, stage: 'signer' } })
        return { done: rejected }
      }
      this.x.orders.upsert({ ...order, status: 'submitted', submittedAt: now }, notional, opening)
      this.x.ledger.append({ type: 'order.submitted', origin: ctx.origin, subject, payload: { venue: connectorId, mode: account.mode } })
      return { connectorId, signer }
    })

    if (!('done' in pre) && a.ticket) {
      this.reservations.markRecorded(account.accountId, n.clientOrderId)
      this.reservations.outcome(account.accountId, n.clientOrderId, { status: 'submitted' })
      a.onRecorded?.()
    }

    if ('done' in pre) {
      const closed = pre.done
      if (closed.status === 'denied') {
        this.x.events.publish('account.orders', closed)
        this.x.events.publish('risk.denials', { accountId: account.accountId, orderId, ruleHits: precheck.ruleHits, ts: now })
      }
      return closed
    }
    const { connectorId, signer } = pre
    let res: SubmitOutcome
    try {
      const currentTime = this.x.clock.now()
      const targetDeadlineExpired = n.expiresAt !== undefined && (!Number.isSafeInteger(n.expiresAt) || n.expiresAt <= currentTime + 2_000)
      if (a.ticket && (currentTime >= a.ticket.expiresAt || targetDeadlineExpired)) {
        this.reservations.release(account.accountId, n.clientOrderId)
        if (targetDeadlineExpired) this.x.bus.budget(account.venue)?.charge(5)
        const problem = makeProblem('GATE_TICKET_EXPIRED', 'gate ticket expired before connector invocation')
        const rejected: Order = { ...order, status: 'rejected', problem, submittedAt: now, closedAt: this.x.clock.now(), updatedAt: this.x.clock.now() }
        tx(this.x.db, () => { this.x.orders.upsert(rejected, notional, opening); this.x.ledger.append({ type: 'order.rejected', origin: ctx.origin, subject, payload: { problem, stage: 'ticket' } }) })
        return rejected
      }
      res = await this.x.bus.submit(account, n, { ...(signer ? { signer } : {}), ...(a.ticket ? { ticket: a.ticket } : {}) })
    } catch (e) {
      // Once submit was invoked, thrown connector or signer-window errors are uncertain; retain the reservation.
      res = { outcome: 'unknown', problem: makeProblem('VENUE_OUTCOME_UNKNOWN', e instanceof Error ? e.message : String(e), { venue: { id: connectorId, message: e instanceof Error ? e.message : String(e) } }) }
    }
    const fillProblem = this.x.orders.get(orderId)?.problem
    if (fillProblem?.message.startsWith('fill_id_conflict:')) throw new KernelError(fillProblem)
    const attestation = account.mode === 'live' ? 'venue-confirmed' : 'kernel-observed'
    const venueRef = (nativeOrderId?: string) => ({ venue: connectorId, ...(nativeOrderId ? { nativeOrderId } : {}), ...(res.receiptHash ? { receiptHash: (res.receiptHash.startsWith('sha256:') ? res.receiptHash : `sha256:${res.receiptHash}`) as `sha256:${string}` } : {}) })
    this.recordChildren(order, n, res)

    if (res.outcome === 'rejected') {
      const problem = res.problem ?? makeProblem('VENUE_REJECTED', 'venue rejected the order', { venue: { id: connectorId, message: '' } })
      this.reservations.outcome(account.accountId, n.clientOrderId, { status: 'rejected' })
      const current = this.x.orders.get(orderId) ?? order
      const rejected: Order = ['filled', 'cancelled', 'expired', 'denied'].includes(current.status) ? current : { ...current, status: 'rejected', problem, submittedAt: now, closedAt: this.x.clock.now(), updatedAt: this.x.clock.now() }
      tx(this.x.db, () => {
        this.x.orders.upsert(rejected, notional, opening)
        this.x.ledger.append({ type: 'order.rejected', origin: ctx.origin, subject, payload: { problem }, attestation, venueRef: venueRef() })
      })
      this.x.protectors.onSubmitOutcome(account.accountId, false)
      this.x.events.publish('account.orders', rejected)
      return rejected
    }

    if (res.outcome === 'unknown') {
      // 结果未知（3006）：绝不盲目重发——先按 clientOrderId 查，查到补记，查不到写 reconciliation: pending
      this.reservations.outcome(account.accountId, n.clientOrderId, { status: 'unknown' })
      const found = await this.boundedOrderLookup(account, n.clientOrderId, this.x.orders.get(orderId))
      if (!found) {
        const current = this.x.orders.get(orderId) ?? order
        if (['filled', 'cancelled', 'rejected', 'expired', 'denied'].includes(current.status)) return current
        if (current.status === 'partially_filled') return current
        const pend: Order = { ...current, status: 'submitted', problem: res.problem ?? makeProblem('VENUE_OUTCOME_UNKNOWN', 'outcome unknown'), submittedAt: now, updatedAt: this.x.clock.now() }
        tx(this.x.db, () => {
          this.x.orders.upsert(pend, notional, opening)
          this.x.ledger.append({ type: 'reconciliation', origin: mkOrigin('system:kernel', 'order:outcome-unknown', 'internal'), subject, payload: { recon: { status: 'unverifiable', against: 'venue', pending: true }, reason: 'order outcome unknown; queried by clientOrderId, not found; will not resend' }, attestation: 'kernel-observed' })
        })
        this.x.protectors.onSubmitOutcome(account.accountId, false)
        this.x.events.publish('account.orders', pend)
        return pend
      }
      res = { outcome: 'accepted', status: found.status, ...(found.venueOrderId ? { venueOrderId: found.venueOrderId } : {}), ...(found.filledSize ? { filledSize: found.filledSize } : {}), avgFillPrice: null }
    }

    // 成交事件可能在 submit 返回之前就到了（模拟场所同步推送）：以库里的最新状态为底，只补上场所回执里的信息。
    const cur = this.x.orders.get(orderId) ?? order
    const terminalCurrent = ['filled', 'cancelled', 'rejected', 'expired', 'denied'].includes(cur.status)
    const filledSize = this.hasRecordedInferredFill(cur) ? cur.filledSize : d.str(d.max(d.D(cur.filledSize), d.D(res.filledSize ?? '0')))
    const status: OrderStatus = terminalCurrent ? cur.status
      : d.gte(d.D(filledSize), d.D(cur.size)) ? 'filled'
        : d.gt(d.D(filledSize), d.ZERO) ? 'partially_filled' : (res.status ?? 'open')
    const accepted: Order = {
      ...cur, status, venueOrderId: res.venueOrderId ?? cur.venueOrderId ?? null, submittedAt: now, updatedAt: this.x.clock.now(),
      filledSize: filledSize as never,
      ...(cur.avgFillPrice == null && res.avgFillPrice !== undefined ? { avgFillPrice: res.avgFillPrice } : {}),
    }
    if (status === 'denied') this.reservations.release(account.accountId, n.clientOrderId)
    else this.reservations.outcome(account.accountId, n.clientOrderId, { status: status as 'submitted' | 'open' | 'untriggered' | 'partially_filled' | 'filled' | 'cancelled' | 'rejected' | 'expired', filledSize: accepted.filledSize, ...(accepted.venueOrderId ? { venueOrderId: accepted.venueOrderId } : {}) })
    // 先校验缓存成交，冲突审计不进入可能回滚的回执事务。
    const fills = accepted.venueOrderId ? this.preparePendingFills(accepted) : []
    // 场所回执之后的写（订单状态 + 结果账本 + 同步成交）并成一个事务：一次 fsync
    tx(this.x.db, () => {
      this.x.orders.upsert(accepted, notional, opening)
      this.x.ledger.append({ type: 'order.accepted', origin: ctx.origin, subject, payload: { status, venueOrderId: res.venueOrderId ?? null }, attestation, venueRef: venueRef(res.venueOrderId) })
      for (const fill of fills) this.applyFillTx(fill)
    })
    if (accepted.venueOrderId) this.pendingFills.delete(`${account.accountId}|${accepted.venueOrderId}`)
    this.x.protectors.onSubmitOutcome(account.accountId, true)
    const final = this.x.orders.get(orderId) ?? accepted
    this.x.events.publish('account.orders', final)
    return final
  }

  private recordChildren(parent: Order, intent: NormalizedIntent, result: SubmitOutcome): void {
    for (const ack of result.acks ?? []) this.recordChildAck(parent, intent, ack)
  }

  /**
   * fix-r2 K1（ADR-14）：启动时领养场所上「本地没有记录」的子单。与下单时的子单同一个构造器（recordChildAck），
   * 同事务多写一条 annotation order.child_adopted。只由启动对账在纸面账户上调用。
   */
  adoptVenueChild(parent: Order, intent: NormalizedIntent, row: { venueOrderId: string; clientOrderId: string | null }, role: 'tp' | 'sl'): Order | undefined {
    const ack = { intentIndex: 0, role, clientOrderId: row.clientOrderId ?? '', venueOrderId: row.venueOrderId, status: 'untriggered' as const, filledSize: '0' as never, avgFillPrice: null, builder: { attached: false } }
    return this.recordChildAck(parent, intent, ack as never, { kind: 'order.child_adopted', evidence: 'startup.venue_open_order' })
  }

  /**
   * fix-r2 K1（ADR-14）：给「意图带止损、已成交、从未有过止损子单」的父单补挂一张只减仓止损（系统来源，过完整闸门）。
   * clientOrderId = sha256(父单 clientOrderId + ':sl') 前 32 位：派生 id 一旦用过就永不再补。返回下单结果；被拒时 order.status 为 denied / rejected。
   */
  async placeProtectiveStop(parent: Order, leg: { triggerPrice: string; price?: string }, size: string): Promise<PlaceResult & { skipped?: true }> {
    const clientOrderId = derivedStopClientOrderId(parent.clientOrderId)
    if (this.x.orders.byClientOrderId(clientOrderId) || this.x.docs.get('cloid', clientOrderId)) return { skipped: true }
    const account = this.x.accounts.get(parent.accountId)
    const ctx: ActorCtx = { principal: { kind: 'service' }, origin: mkOrigin('system:kernel', 'startup:protect', 'internal') }
    const intent = {
      accountId: account.accountId, instrumentId: parent.instrumentId, side: parent.side === 'buy' ? 'sell' : 'buy',
      type: leg.price !== undefined ? 'stop_limit' : 'stop_market', size, triggerPrice: leg.triggerPrice, ...(leg.price !== undefined ? { price: leg.price } : {}),
      reduceOnly: true, clientOrderId, reason: 'protective stop re-placed after a kernel restart (the original stop was never recorded)',
    } as unknown as OrderIntent
    const n = this.normalize(account, intent, ctx)
    const result = await this.runOrder({ n, authorIntent: n, ctx, path: 'direct' })
    const order = result.order ? this.x.orders.get(result.order.orderId) ?? result.order : undefined
    if (order && order.status !== 'denied' && order.status !== 'rejected') {
      const linked: Order = { ...order, parentOrderId: parent.orderId, tpslRole: 'sl' }
      tx(this.x.db, () => {
        this.x.orders.upsert(linked, '0', false)
        this.x.ledger.append({ type: 'annotation', origin: ctx.origin, subject: { accountId: brand(account.accountId), instrumentId: parent.instrumentId, orderId: order.orderId, clientOrderId },
          payload: { kind: 'order.child_replaced', parentOrderId: parent.orderId, tpslRole: 'sl', clientOrderId, orderId: order.orderId, triggerPrice: leg.triggerPrice, size } })
      })
      this.x.events.publish('account.orders', linked)
      return { ...result, order: linked }
    }
    return { ...result, ...(order ? { order } : {}) }
  }

  /**
   * fix-r2 K2（ADR-15）：纸面单从未到达场所 → 本地终态并释放预留。前提（纸面、可信、无场所单号、场所查无）由调用方判定。
   * recovery = 启动收敛（rejected，原因 INTERRUPTED_BEFORE_VENUE）；cancel = 撤一张场所从没见过的单（cancelled，reason never_reached_venue）。
   */
  convergeNeverReached(order: Order, via: 'recovery' | 'cancel', origin: Origin): Order {
    const now = this.x.clock.now()
    const subject = { accountId: brand<`acct_${string}`>(order.accountId), instrumentId: order.instrumentId, orderId: order.orderId, clientOrderId: order.clientOrderId }
    const problem = makeProblem('VENUE_REJECTED', NEVER_REACHED_MESSAGE, { venue: { id: ConnectorBus.SIM_ID, message: 'order unknown at the paper venue after a kernel restart' } })
    const next: Order = via === 'recovery'
      ? { ...order, status: 'rejected', problem, closedAt: now, updatedAt: now }
      : { ...order, status: 'cancelled', closedAt: now, updatedAt: now }
    tx(this.x.db, () => {
      this.x.orders.upsert(next, '0', !order.reduceOnly)
      if (via === 'recovery') {
        this.x.ledger.append({ type: 'order.rejected', origin, subject, payload: { problem, stage: 'recovery' } })
        // 从没下出去的单：把 clientOrderId 让出来，Agent 按「结果未知就用同一个 id 重发」的规矩重发时能真正下一次（账本里原条目不动，只改订单投影的唯一键）
        this.x.db.prepare('UPDATE orders SET client_order_id=? WHERE order_id=?').run(`${order.clientOrderId}:interrupted:${order.orderId}`, order.orderId)
        this.x.docs.delete('cloid', order.clientOrderId)
      } else this.x.ledger.append({ type: 'order.cancelled', origin, subject, payload: { status: 'cancelled', reason: 'never_reached_venue' } })
    })
    this.reservations.release(order.accountId, order.clientOrderId)
    const uncertain = this.uncertainOrders.get(order.accountId); uncertain?.delete(order.clientOrderId); if (uncertain?.size === 0) this.uncertainOrders.delete(order.accountId)
    this.x.events.publish('account.orders', next)
    return next
  }

  /** 撤单 / 启动收敛共用的前提：纸面账户、纸面状态可信、本地单没有场所单号且还停在 new / submitted。 */
  neverReachedCandidate(account: Account, order: Order): boolean {
    return account.mode !== 'live' && this.x.paperTrusted?.() === true && !order.venueOrderId && (order.status === 'new' || order.status === 'submitted')
  }

  private recordChildAck(parent: Order, intent: NormalizedIntent, ack: NonNullable<SubmitOutcome['acks']>[number], adopted?: { kind: 'order.child_adopted'; evidence: string }): Order | undefined {
    {
      if (ack.role !== 'tp' && ack.role !== 'sl') return undefined
      const leg = ack.role === 'tp' ? intent.tpsl?.takeProfit : intent.tpsl?.stopLoss
      if (!leg) return undefined
      const now = this.x.clock.now()
      // Some venues return the parent's cloid (or none) for children. Never share a local id.
      const clientOrderId = /^[0-9a-f]{32}$/.test(ack.clientOrderId) && ack.clientOrderId !== parent.clientOrderId
        ? ack.clientOrderId : newClientOrderId()
      const child: Order = {
        orderId: newId('ord', now), clientOrderId, venueOrderId: ack.venueOrderId,
        accountId: parent.accountId, instrumentId: parent.instrumentId, parentOrderId: parent.orderId, tpslRole: ack.role,
        side: parent.side === 'buy' ? 'sell' : 'buy', reduceOnly: true,
        type: ack.role === 'tp' ? (leg.price === undefined ? 'take_market' : 'take_limit') : (leg.price === undefined ? 'stop_market' : 'stop_limit'),
        tif: 'gtc', size: parent.size, price: leg.price ?? null, triggerPrice: leg.triggerPrice,
        filledSize: ack.filledSize, avgFillPrice: ack.avgFillPrice, fee: '0' as never,
        status: ack.status === 'unknown' ? 'submitted' : ack.status,
        ...(ack.problem ? { problem: ack.problem } : {}),
        ...(ack.status === 'rejected' || ack.status === 'filled' ? { closedAt: now } : {}),
        ...(parent.mandateId ? { mandateId: parent.mandateId } : {}),
        ...(parent.proposalId ? { proposalId: parent.proposalId } : {}),
        ...(parent.precheckId ? { precheckId: parent.precheckId } : {}),
        origin: parent.origin, createdAt: now, submittedAt: now, updatedAt: now,
      }
      const fills = this.preparePendingFills(child)
      tx(this.x.db, () => {
        this.x.orders.upsert(child, '0', false)
        if (!child.venueOrderId) {
          const venue = this.x.accounts.get(child.accountId).venue
          this.x.docs.put('order-record', child.orderId, { unlinked: { since: now, venue } } satisfies OrderRecord)
          this.x.ledger.append({ type: 'annotation', origin: parent.origin, subject: { accountId: child.accountId, orderId: child.orderId, clientOrderId },
            payload: { kind: 'order.child_unlinked', parentOrderId: parent.orderId, tpslRole: ack.role, venue } })
        }
        this.x.ledger.append({
          type: child.status === 'rejected' ? 'order.rejected' : child.status === 'submitted' ? 'order.submitted' : 'order.accepted',
          origin: parent.origin, subject: { accountId: child.accountId, instrumentId: child.instrumentId, orderId: child.orderId, clientOrderId },
          payload: { parentOrderId: parent.orderId, tpslRole: ack.role, status: child.status, venueOrderId: child.venueOrderId, ...(ack.problem ? { problem: ack.problem } : {}) },
        })
        if (adopted) this.x.ledger.append({ type: 'annotation', origin: mkOrigin('system:kernel', 'startup:adopt', 'internal'), subject: { accountId: child.accountId, instrumentId: child.instrumentId, orderId: child.orderId, clientOrderId },
          payload: { kind: adopted.kind, parentOrderId: parent.orderId, tpslRole: ack.role, venueOrderId: child.venueOrderId, evidence: adopted.evidence } })
        for (const fill of fills) this.applyFillTx(fill)
      })
      if (!child.venueOrderId) this.unlinkedChildren++
      const key = `${child.accountId}|${child.venueOrderId}`
      this.pendingFills.delete(key)
      const update = this.pendingOrderUpdates.get(key)
      if (update) { this.pendingOrderUpdates.delete(key); this.onOrderUpdate(child.accountId, update) }
      const recorded = this.x.orders.get(child.orderId) ?? child
      this.x.events.publish('account.orders', recorded)
      return recorded
    }
  }

  // ================================================================
  // 幂等查询：MCP / 引擎调用超时后，用 clientOrderId 查结果，不要重发
  // ================================================================
  /**
   * 按 clientOrderId（或 orderId）查订单：内核里的当前状态 + 全链账本条目类型；订单还停在“已提交、结果未知”时顺手向场所查一次并补记。
   * 找不到订单但有一张含这个 clientOrderId 的提案（授权书额度不足转提案）时，返回提案的票号与状态。
   * 授权主体（Agent 钥匙 / 引擎）只查得到自己授权书覆盖账户里的单；查不到一律回 found:false（不泄露别的账户有没有）。
   */
  async lookup(args: { clientOrderId?: string; orderId?: string }, ctx: ActorCtx): Promise<{ found: boolean; order?: Order; proposal?: { ticket: string; status: string; proposalId: string }; trail?: string[]; refreshedFromVenue?: boolean }> {
    if (!args.clientOrderId && !args.orderId) throw err('INVALID_PARAMS', 'clientOrderId or orderId is required')
    const mandate = this.mandateOf(ctx)
    const visible = (accountId: string): boolean => !(ctx.principal.kind === 'agent' || ctx.principal.kind === 'engine') || (!!mandate && mandate.accounts.includes(accountId as never))
    let o = args.orderId ? this.x.orders.get(args.orderId) : this.x.orders.byClientOrderId(String(args.clientOrderId))
    let refreshed = false
    if (o && visible(o.accountId) && !terminalOrder(o.status) && (o.status === 'submitted' || this.x.docs.get<OrderRecord>('order-record', o.orderId)?.cancelRequestedAt !== undefined)) {
      const account = this.x.accounts.find(o.accountId)
      if (account) {
        try {
          const q = await this.boundedOrderLookup(account, o.clientOrderId, o)
          if (q) { this.onOrderUpdate(account.accountId, { venueOrderId: q.venueOrderId ?? o.venueOrderId ?? '', clientOrderId: o.clientOrderId, status: q.status }); refreshed = true; o = this.x.orders.get(o.orderId) ?? o }
        } catch { /* 场所不可达：返回内核已知的状态 */ }
      }
    }
    if (o && visible(o.accountId)) return { found: true, order: o, trail: this.x.ledger.trace({ orderId: o.orderId }).map((e) => e.type), ...(refreshed ? { refreshedFromVenue: true } : {}) }
    if (args.clientOrderId) {
      const p = this.x.docs.list<Proposal>('proposal', { limit: 1000 }).find((x) => visible(String(x.accountId)) && Array.isArray(x.intents) && (x.intents as OrderIntent[]).some((i) => i.clientOrderId === args.clientOrderId))
      if (p) return { found: false, proposal: { ticket: p.ticket, status: p.status, proposalId: p.proposalId } }
    }
    return { found: false }
  }

  // ================================================================
  // 成交与订单事件（来自连接器）
  // ================================================================
  private seenFills = new Map<string, Fill>()
  /** FIFO fast path plus durable (accountId, venueFillId) uniqueness. */
  applyFill(f: Fill, origin?: Origin): boolean {
    const key = JSON.stringify([f.accountId, f.venueFillId])
    if (!this.validateFill(f, origin, this.seenFills.get(key) ?? this.x.orders.fillWithId(f))) return false
    // Persistent uniqueness remains authoritative after FIFO eviction or a restart.
    const inserted = tx(this.x.db, () => this.applyFillTx(f, origin))
    if (inserted) {
      this.seenFills.set(key, structuredClone(f))
      if (this.seenFills.size > 10000) this.seenFills.delete(this.seenFills.keys().next().value!)
    }
    return inserted
  }

  private sameConfirmationInput(left: ReconcileConfirmInput, right: ReconcileConfirmInput): boolean {
    try {
      return left.offerId === right.offerId && left.accountId === right.accountId && left.reportId === right.reportId
        && left.suggestionId === right.suggestionId && left.feeCcy === right.feeCcy && left.liquidity === right.liquidity
        && d.eq(d.D(left.fee), d.D(right.fee)) && d.eq(d.D(left.realizedPnl), d.D(right.realizedPnl))
    } catch { return false }
  }

  private sameConfirmedFill(left: Fill, right: Fill): boolean {
    try {
      const a = left.inferred, b = right.inferred
      return left.fillId === right.fillId && left.accountId === right.accountId && left.venueFillId === right.venueFillId
        && left.orderId === right.orderId && left.clientOrderId === right.clientOrderId && left.instrumentId === right.instrumentId
        && left.side === right.side && left.feeCcy === right.feeCcy && left.liquidity === right.liquidity && left.ts === right.ts
        && d.eq(d.D(left.price), d.D(right.price)) && d.eq(d.D(left.size), d.D(right.size)) && d.eq(d.D(left.fee), d.D(right.fee))
        && d.eq(d.D(left.realizedPnl), d.D(right.realizedPnl)) && d.eq(d.D(left.builderFee ?? '0'), d.D(right.builderFee ?? '0'))
        && !!left.liquidation === !!right.liquidation && !!a && !!b && a.suggestionId === b.suggestionId && a.reportId === b.reportId
        && a.confirmedAt === b.confirmedAt && a.confirmedBy === b.confirmedBy && a.priceSource === b.priceSource && a.basisDigest === b.basisDigest
    } catch { return false }
  }

  private confirmationReceipt(receiptId: string): ReconcileConfirmationReceipt | undefined {
    try {
      const receipt = this.x.docs.get<ReconcileConfirmationReceipt>(CONFIRMATION_RECEIPTS, receiptId)
      if (receipt === undefined) return undefined
      if (!receipt || typeof receipt !== 'object' || !receipt.input || typeof receipt.fillId !== 'string'
        || !Number.isSafeInteger(receipt.confirmedAt) || typeof receipt.confirmedBy !== 'string'
        || !['pending', 'complete', 'failed'].includes(receipt.effectsState)) {
        throw new Error('invalid receipt')
      }
      return receipt
    } catch {
      throw new KernelError(makeProblem('STATE_FILE_CORRUPT', 'confirmation receipt state is corrupt'))
    }
  }

  /** Read-only idempotent receipt lookup; it never repeats financial or post-commit effects. */
  lookupConfirmedFill(input: ReconcileConfirmInput): ReconcileConfirmResult | undefined {
    const receiptId = `rcpt_${digestOf([input.accountId, input.suggestionId]).slice('sha256:'.length)}`
    const receipt = this.confirmationReceipt(receiptId)
    if (!receipt) return undefined
    let prior: Fill | undefined
    try {
      if (`rcpt_${digestOf([receipt.input.accountId, receipt.input.suggestionId]).slice('sha256:'.length)}` !== receiptId) throw new Error('receipt key mismatch')
      prior = this.x.orders.fillWithId({ accountId: receipt.input.accountId, venueFillId: '', fillId: receipt.fillId as Fill['fillId'] })
      if (!prior || prior.fillId !== receipt.fillId || prior.accountId !== receipt.input.accountId) throw new Error('receipt fill mismatch')
      this.validateConfirmedFill(prior, receipt.input)
      const proof = prior.inferred
      if (!proof || proof.confirmedAt !== receipt.confirmedAt || proof.confirmedBy !== receipt.confirmedBy) throw new Error('receipt proof mismatch')
    } catch {
      throw new KernelError(makeProblem('STATE_FILE_CORRUPT', 'confirmation receipt does not match its durable fill'))
    }
    if (!this.sameConfirmationInput(receipt.input, input)) throw new KernelError(makeProblem('INVALID_PARAMS', 'confirmation receipt conflicts with accepted input'))
    return { fillId: receipt.fillId, alreadyRecorded: true }
  }

  private pendingConfirmationId(accountId: string): string | undefined {
    try {
      const value = this.x.docs.get<unknown>(CONFIRMATION_PENDING, accountId)
      if (value === undefined) return undefined
      if (typeof value !== 'string' || value.length === 0) throw new Error('invalid pending index')
      const receipt = this.confirmationReceipt(value)
      if (!receipt || receipt.input.accountId !== accountId
        || `rcpt_${digestOf([receipt.input.accountId, receipt.input.suggestionId]).slice('sha256:'.length)}` !== value) throw new Error('invalid pending receipt')
      const confirmed = this.lookupConfirmedFill(receipt.input)
      if (!confirmed || confirmed.fillId !== receipt.fillId) throw new Error('pending receipt fill is missing')
      const item = this.reconcileReviews.list(accountId).find((row) => row.kind === 'confirmation_effects'
        && row.confirmation !== undefined && digestOf(row.confirmation) === digestOf(receipt))
      return item?.resolution?.input.action === 'acknowledge' ? undefined : value
    } catch {
      throw new KernelError(makeProblem('STATE_FILE_CORRUPT', 'confirmation pending index is corrupt'))
    }
  }

  private assertConfirmationReview(itemId: string, fill: Fill, input: ReconcileConfirmInput): void {
    const item = this.reconcileReviews.get(input.accountId, itemId)
    const suggestion = item?.kind === 'inferred_fill' ? item.suggestion : undefined
    const proof = fill.inferred
    const expectedVenueFillId = suggestion ? `inferred_${digestOf([input.accountId, suggestion.id]).slice('sha256:'.length)}` : undefined
    const localFillsDigest = suggestion ? digestOf(this.x.orders.fillsForOrder(input.accountId, suggestion.orderId)) : undefined
    const order = suggestion ? this.x.orders.get(suggestion.orderId) : undefined
    if (!item || item.resolution !== undefined || item.confirmedFillId !== undefined || !suggestion || !proof
      || item.accountId !== input.accountId || suggestion.id !== input.suggestionId
      || suggestion.orderId !== fill.orderId || suggestion.clientOrderId !== fill.clientOrderId
      || suggestion.venueOrderId !== order?.venueOrderId
      || suggestion.instrumentId !== fill.instrumentId || suggestion.side !== fill.side
      || suggestion.size !== fill.size || suggestion.price !== fill.price
      || suggestion.priceSource !== proof.priceSource || proof.suggestionId !== input.suggestionId
      || proof.reportId !== input.reportId || fill.accountId !== input.accountId
      || fill.venueFillId !== expectedVenueFillId || item.localFillsDigest !== localFillsDigest) {
      throw new KernelError(makeProblem('INVALID_PARAMS', 'confirmed fill does not match its pending inference review'))
    }
  }

  private hasOtherBlockingReview(accountId: string, allowedItemId: string): boolean {
    const recovery = this.recoveryReviews(accountId)
    const pendingRecoveryIds = new Set(recovery.filter((item) => item.kind === 'confirmation_effects' || item.kind === 'late_real_fill')
      .map((item) => item.itemId))
    return this.reconcileReviews.list(accountId).some((item) => item.itemId !== allowedItemId
      && pendingRecoveryIds.has(item.itemId) && item.blocking && item.resolution === undefined && item.confirmedFillId === undefined)
  }

  private validateConfirmedFill(fill: Fill, input: ReconcileConfirmInput): void {
    const inferred = fill.inferred
    let financialMatch = false
    try {
      financialMatch = d.eq(d.D(fill.fee), d.D(input.fee)) && d.eq(d.D(fill.realizedPnl), d.D(input.realizedPnl))
    } catch { /* invalid decimals fail closed below */ }
    if (!input.offerId || !input.accountId || !input.reportId || !input.suggestionId || !input.feeCcy
      || !inferred || inferred.suggestionId !== input.suggestionId || inferred.reportId !== input.reportId
      || fill.accountId !== input.accountId || fill.feeCcy !== input.feeCcy || fill.liquidity !== input.liquidity || !financialMatch
      || !Number.isSafeInteger(inferred.confirmedAt) || !inferred.confirmedBy || !inferred.basisDigest) {
      throw new KernelError(makeProblem('INVALID_PARAMS', 'confirmed fill does not match its accepted reconciliation input'))
    }
    const order = this.x.orders.get(fill.orderId)
    if (!order || order.accountId !== fill.accountId || order.clientOrderId !== fill.clientOrderId || order.instrumentId !== fill.instrumentId) {
      throw new KernelError(makeProblem('INVALID_PARAMS', 'confirmed fill does not identify a local order'))
    }
  }

  /** Internal entry for the already-authenticated local reconciliation confirmation. */
  applyConfirmedFill(fill: Fill, origin: Origin, input: ReconcileConfirmInput, reviewItemId?: string): ReconcileConfirmResult {
    if (this.x.db.isTransaction) throw new KernelError(makeProblem('INVALID_PARAMS', 'confirmed fill must own the outer transaction'))
    this.validateConfirmedFill(fill, input)
    const receiptId = `rcpt_${digestOf([input.accountId, input.suggestionId]).slice('sha256:'.length)}`
    const existing = this.confirmationReceipt(receiptId)
    if (existing) {
      if (!this.sameConfirmationInput(existing.input, input)) throw new KernelError(makeProblem('INVALID_PARAMS', 'confirmation receipt conflicts with accepted input'))
      const prior = this.x.orders.fillWithId({ accountId: input.accountId, venueFillId: '', fillId: existing.fillId as Fill['fillId'] })
      if (!prior || prior.fillId !== existing.fillId || !this.sameConfirmedFill(prior, fill)) {
        throw new KernelError(makeProblem('STATE_FILE_CORRUPT', 'confirmation receipt does not match its durable fill'))
      }
      return { fillId: existing.fillId, alreadyRecorded: true }
    }
    if (reviewItemId !== undefined) {
      this.assertConfirmationReview(reviewItemId, fill, input)
      if (this.hasOtherBlockingReview(input.accountId, reviewItemId)) throw new KernelError(makeProblem('BUSY', 'another reconciliation review is pending'))
    }
    const pendingId = this.pendingConfirmationId(input.accountId)
    if (pendingId !== undefined) {
      if (!this.confirmationReceipt(pendingId)) throw new KernelError(makeProblem('STATE_FILE_CORRUPT', 'confirmation pending index has no receipt'))
      throw new KernelError(makeProblem('BUSY', 'another confirmation has unresolved effects for this account'))
    }
    if (this.x.orders.fillWithId(fill)) throw new KernelError(makeProblem('STATE_FILE_CORRUPT', 'confirmed fill exists without its durable receipt'))

    const receipt: ReconcileConfirmationReceipt = {
      input: structuredClone(input), fillId: fill.fillId, confirmedAt: fill.inferred!.confirmedAt,
      confirmedBy: fill.inferred!.confirmedBy, effectsState: 'pending',
    }
    const effects: ConfirmedFillEffects = { ledger: this.x.ledger.createDeferredEffects(), memory: [], fill }
    try {
      tx(this.x.db, () => {
        if (this.confirmationReceipt(receiptId)) throw new KernelError(makeProblem('BUSY', 'confirmation receipt was concurrently recorded'))
        if (this.pendingConfirmationId(input.accountId) !== undefined) throw new KernelError(makeProblem('BUSY', 'another confirmation has unresolved effects for this account'))
        if (reviewItemId !== undefined) {
          this.assertConfirmationReview(reviewItemId, fill, input)
          if (this.hasOtherBlockingReview(input.accountId, reviewItemId)) throw new KernelError(makeProblem('BUSY', 'another reconciliation review is pending'))
        }
        if (this.x.orders.fillWithId(fill)) throw new KernelError(makeProblem('STATE_FILE_CORRUPT', 'confirmed fill exists without its durable receipt'))
        this.x.docs.put(CONFIRMATION_RECEIPTS, receiptId, receipt)
        this.x.docs.put(CONFIRMATION_PENDING, input.accountId, receiptId)
        if (!this.applyFillTx(fill, origin, effects)) throw new KernelError(makeProblem('VENUE_REJECTED', 'confirmed fill was already recorded'))
        if (reviewItemId !== undefined) this.reconcileReviews.markConfirmed(input.accountId, reviewItemId, fill.fillId)
      })
    } catch (error) {
      this.x.ledger.restoreGateRenewalsAfterRollback()
      effects.ledger.entries.length = 0
      throw error
    }

    this.activeConfirmationEffects.set(input.accountId, receiptId)
    try {
      this.pendingConfirmations.add(input.accountId)
      const seenKey = JSON.stringify([fill.accountId, fill.venueFillId])
      this.seenFills.set(seenKey, structuredClone(fill))
      if (this.seenFills.size > 10000) this.seenFills.delete(this.seenFills.keys().next().value!)
      let followupFailed = false
      for (const effect of effects.memory) {
        try { effect() } catch { followupFailed = true }
      }
      this.x.ledger.publishDeferredEffects(effects.ledger)
      try { this.x.protectors.onFill(effects.order, fill) } catch { followupFailed = true }
      if (effects.order) this.x.events.publish('account.orders', effects.order)
      this.x.events.publish('account.fills', fill)
      if (followupFailed) {
        this.retainPendingConfirmation(receiptId, input.accountId)
        return { fillId: fill.fillId, alreadyRecorded: false }
      }
      try {
        tx(this.x.db, () => {
          const current = this.confirmationReceipt(receiptId)
          if (!current || current.fillId !== fill.fillId || !this.sameConfirmationInput(current.input, input)
            || this.pendingConfirmationId(input.accountId) !== receiptId) {
            throw new KernelError(makeProblem('STATE_FILE_CORRUPT', 'confirmation completion does not match its pending receipt'))
          }
          this.x.docs.put(CONFIRMATION_RECEIPTS, receiptId, { ...current, effectsState: 'complete' })
          this.x.docs.delete(CONFIRMATION_PENDING, input.accountId)
        })
        this.pendingConfirmations.delete(input.accountId)
      } catch {
        this.retainPendingConfirmation(receiptId, input.accountId)
      }
      return { fillId: fill.fillId, alreadyRecorded: false }
    } finally {
      if (this.activeConfirmationEffects.get(input.accountId) === receiptId) this.activeConfirmationEffects.delete(input.accountId)
    }
  }

  private retainPendingConfirmation(receiptId: string, accountId: string): void {
    this.pendingConfirmations.add(accountId)
    try {
      tx(this.x.db, () => {
        const current = this.confirmationReceipt(receiptId)
        if (current && current.effectsState !== 'failed') this.x.docs.put(CONFIRMATION_RECEIPTS, receiptId, { ...current, effectsState: 'failed' })
      })
    } catch { /* pending receipt and index remain the durable recovery source */ }
    try { this.x.tstate.set({ type: 'account', id: accountId }, 'HALTED', 'reconcile_confirmation_pending', mkOrigin('system:kernel', 'reconcile.confirmation-pending', 'internal')) }
    catch { /* in-memory pending state remains fail-closed */ }
  }

  private hasRecordedInferredFill(f: Pick<Fill, 'accountId' | 'orderId'>): boolean {
    return this.x.orders.fillsForOrder(f.accountId, f.orderId).some((fill) => fill.inferred !== undefined)
  }

  private lateRealIdentity(f: Fill) {
    return {
      accountId: f.accountId, orderId: f.orderId, clientOrderId: f.clientOrderId, venueFillId: f.venueFillId,
      instrumentId: f.instrumentId, side: f.side, price: d.str(d.D(f.price)), size: d.str(d.D(f.size)), fee: d.str(d.D(f.fee)),
      feeCcy: f.feeCcy, builderFee: d.str(d.D(f.builderFee ?? '0')), liquidity: f.liquidity,
      realizedPnl: d.str(d.D(f.realizedPnl)), liquidation: f.liquidation === true, ts: f.ts,
      ...(f.legId !== undefined ? { legId: f.legId } : {}), ...(f.exitPlanId !== undefined ? { exitPlanId: f.exitPlanId } : {}),
    }
  }

  /** Project the persisted venue evidence onto a schema-valid review reference without changing its raw record. */
  private projectLateEvidence(raw: unknown, expectedEvidenceId?: string): Fill {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)
      || typeof (raw as { fillId?: unknown }).fillId !== 'string'
      || (raw as { fillId: string }).fillId.length === 0) throw new Error('late evidence source is malformed')
    const source = raw as Fill
    const identity = this.lateRealIdentity(source)
    const evidenceId = `late_${digestOf(identity).slice('sha256:'.length)}`
    if (expectedEvidenceId !== undefined && evidenceId !== expectedEvidenceId) throw new Error('late evidence key does not match source')
    const fillId = `fill_${digestOf(identity).slice('sha256:'.length, 'sha256:'.length + 26)}` as Fill['fillId']
    const projected = validateFill({ ...source, fillId })
    if (!projected.ok || projected.value.inferred !== undefined) throw new Error('late evidence source is invalid')
    return projected.value
  }

  private recordLateRealEvidence(f: Fill): void {
    if (this.x.db.isTransaction) throw new KernelError(makeProblem('VENUE_REJECTED', 'late real evidence must be recorded before the fill transaction'))
    const identity = this.lateRealIdentity(f)
    const evidenceId = `late_${digestOf(identity).slice('sha256:'.length)}`
    const evidence: Fill = {
      fillId: f.fillId, orderId: f.orderId, clientOrderId: f.clientOrderId, venueFillId: f.venueFillId,
      accountId: f.accountId, instrumentId: f.instrumentId, side: f.side,
      price: identity.price as Fill['price'], size: identity.size as Fill['size'], fee: identity.fee as Fill['fee'], feeCcy: f.feeCcy,
      builderFee: identity.builderFee as Fill['builderFee'], liquidity: f.liquidity,
      realizedPnl: identity.realizedPnl as Fill['realizedPnl'], liquidation: identity.liquidation, ts: f.ts,
      ...(f.legId !== undefined ? { legId: f.legId } : {}), ...(f.exitPlanId !== undefined ? { exitPlanId: f.exitPlanId } : {}),
    }
    const reviewFill = this.projectLateEvidence(evidence, evidenceId)
    const deferred = this.x.ledger.createDeferredEffects()
    let added = false
    let shouldHalt = false
    try {
      tx(this.x.db, () => {
        const prior = this.x.docs.get<unknown>(LATE_REAL_EVIDENCE, evidenceId)
        if (prior === undefined) {
          this.x.docs.put(LATE_REAL_EVIDENCE, evidenceId, evidence)
          const item = this.reconcileReviews.record({ accountId: f.accountId, kind: 'late_real_fill', observedAt: evidence.ts,
            summary: 'A real fill overlaps a previously confirmed inference.', blocking: true, fill: reviewFill })
          if (item.resolution === undefined && item.confirmedFillId === undefined) {
            this.x.docs.put(LATE_REAL_PENDING, f.accountId, true)
            shouldHalt = true
          }
          this.x.ledger.append({
            type: 'annotation', origin: mkOrigin('system:kernel', 'reconcile:late-real-evidence', 'internal'),
            subject: { accountId: f.accountId, orderId: f.orderId, clientOrderId: f.clientOrderId },
            payload: { kind: 'reconcile.late_real_evidence', evidenceId },
          }, deferred)
          added = true
        } else {
          const priorFill = this.projectLateEvidence(prior, evidenceId)
          if (priorFill.accountId !== f.accountId
            || digestOf(this.lateRealIdentity(priorFill)) !== digestOf(identity)) throw new Error('late evidence identity conflicts with stored evidence')
          const item = this.reconcileReviews.record({ accountId: f.accountId, kind: 'late_real_fill', observedAt: priorFill.ts,
            summary: 'A real fill overlaps a previously confirmed inference.', blocking: true, fill: priorFill })
          if (item.resolution === undefined && item.confirmedFillId === undefined) {
            if (this.x.docs.get<unknown>(LATE_REAL_PENDING, f.accountId) !== true) this.x.docs.put(LATE_REAL_PENDING, f.accountId, true)
            shouldHalt = true
          }
        }
      })
    } catch {
      this.x.ledger.restoreGateRenewalsAfterRollback()
      deferred.entries.length = 0
      throw new KernelError(makeProblem('STATE_FILE_CORRUPT', 'late real evidence could not be recorded safely'))
    }
    if (added) this.x.ledger.publishDeferredEffects(deferred)
    if (shouldHalt) {
      try { this.x.tstate.set({ type: 'account', id: f.accountId }, 'HALTED', 'reconcile_late_real_evidence', mkOrigin('system:kernel', 'reconcile:late-real-evidence', 'internal')) }
      catch { /* the durable marker keeps confirmation fail-closed */ }
    }
  }

  private validateFill(f: Fill, origin?: Origin, prior = this.x.orders.fillWithId(f)): boolean {
    if (f.inferred !== undefined) throw new KernelError(makeProblem('INVALID_PARAMS', 'inferred fills require the trusted confirmation path'))
    if (prior) {
      const same = (['accountId', 'venueFillId', 'orderId', 'clientOrderId', 'instrumentId', 'side', 'feeCcy', 'liquidity', 'ts'] as const).every((key) => prior[key] === f[key])
        && (['price', 'size', 'fee', 'realizedPnl'] as const).every((key) => d.eq(d.D(prior[key]), d.D(f[key])))
        && d.eq(d.D(prior.builderFee ?? '0'), d.D(f.builderFee ?? '0')) && !!prior.liquidation === !!f.liquidation
      if (same) return false
      // 必须在成交事务之外入账，随后抛错不得把异常记录回滚。
      this.x.ledger.append({ type: 'annotation', origin: origin ?? mkOrigin('system:kernel', 'venue:fill-conflict', 'internal'), subject: { accountId: f.accountId, orderId: f.orderId, clientOrderId: f.clientOrderId }, payload: { reason: 'fill_id_conflict', venueFillId: f.venueFillId, existingOrderId: prior.orderId, incomingOrderId: f.orderId } })
      const problem = makeProblem('VENUE_REJECTED', 'fill_id_conflict: venue fill id belongs to a different fill')
      const order = this.x.orders.get(f.orderId)
      if (order) this.x.orders.upsert({ ...order, problem }, '0', !order.reduceOnly)
      this.x.tstate.set({ type: 'account', id: f.accountId }, 'HALTED', 'fill_id_conflict', mkOrigin('system:kernel', 'venue:fill-conflict', 'internal'))
      throw new KernelError(problem)
    }
    if (this.hasRecordedInferredFill(f)) {
      this.recordLateRealEvidence(f)
      return false
    }
    return true
  }
  private applyFillTx(f: Fill, origin?: Origin, confirmed?: ConfirmedFillEffects): boolean {
    if (f.inferred !== undefined && !confirmed) throw new KernelError(makeProblem('INVALID_PARAMS', 'inferred fills require the trusted confirmation path'))
    if (!confirmed && f.inferred === undefined && this.hasRecordedInferredFill(f)) {
      throw new KernelError(makeProblem('VENUE_REJECTED', 'late real evidence requires human review'))
    }
    if (!this.x.orders.insertFill(f)) return false
    const o = this.x.orders.get(f.orderId) ?? this.x.orders.byClientOrderId(f.clientOrderId)
    if (o) {
      // 集成修补（H）：已成交量 = 该订单已入库成交之和，与场所回执里的成交量取大。
      // 原来是"回执量 + 每条成交"累加：Hyperliquid 的 IOC 回执带 filled.totalSz，随后 userFills 又推同一笔 → 订单记成两倍、与持仓对不上。
      const own = this.x.orders.fillsForOrder(o.accountId, o.orderId)
      const sum = own.reduce((s, x) => d.add(s, d.D(x.size)), d.ZERO)
      const filled = d.gte(sum, d.D(o.filledSize)) ? sum : d.D(o.filledSize)
      const fillNotional = own.reduce((s, x) => d.add(s, d.mul(d.D(x.size), d.D(x.price))), d.ZERO)
      const avg = d.gt(sum, d.ZERO) ? d.div(fillNotional, sum, 12) : d.D(o.avgFillPrice ?? f.price)
      const status: OrderStatus = d.gte(filled, d.D(o.size)) ? 'filled' : terminalOrder(o.status) ? o.status : 'partially_filled'
      if (o.status === 'untriggered') this.x.ledger.append({
        type: 'order.triggered', origin: o.parentOrderId ? o.origin : origin ?? mkOrigin('system:kernel', 'venue:fill-trigger', 'internal'),
        subject: { accountId: o.accountId, instrumentId: o.instrumentId, orderId: o.orderId, clientOrderId: o.clientOrderId },
        payload: { status: 'open', evidence: 'fill', venueTs: f.ts },
      }, confirmed?.ledger)
      const next: Order = { ...o, filledSize: d.str(filled), avgFillPrice: d.str(avg), fee: d.str(d.add(d.D(o.fee), d.D(f.fee))), status, updatedAt: this.x.clock.now(), ...(status === 'filled' ? { closedAt: this.x.clock.now() } : {}) }
      this.x.orders.upsert(next, d.str(d.mul(d.D(o.size), d.D(o.price ?? f.price))), !o.reduceOnly)
      const pendingAmend = this.pendingAmends.get(o.orderId)
      if (terminalOrder(status) && !pendingAmend) {
        this.clearPendingAmend(o.orderId, !!confirmed)
        if (confirmed) confirmed.memory.push(() => this.pendingAmends.delete(o.orderId))
      }
      const reservationEffect = () => {
        if (status === 'denied' || status === 'new') this.reservations.release(o.accountId, o.clientOrderId)
        else if (pendingAmend) this.reservations.outcome(o.accountId, o.clientOrderId, { status: 'unknown', filledSize: next.filledSize, ...(next.venueOrderId ? { venueOrderId: next.venueOrderId } : {}) })
        else this.reservations.outcome(o.accountId, o.clientOrderId, { status, filledSize: next.filledSize, ...(next.venueOrderId ? { venueOrderId: next.venueOrderId } : {}) })
      }
      if (confirmed) {
        confirmed.memory.push(reservationEffect)
        confirmed.order = next
      } else {
        reservationEffect()
        this.x.events.publish('account.orders', next)
        this.x.protectors.onFill(next, f)
      }
    }
    this.x.ledger.append({
      type: 'fill', origin: origin ?? (o?.parentOrderId ? o.origin : mkOrigin(`venue:${(o ? this.x.accounts.find(o.accountId)?.venue : undefined) ?? 'unknown'}`, 'venue:fill', 'internal')),
      subject: { accountId: brand(f.accountId), instrumentId: f.instrumentId, orderId: brand(f.orderId), clientOrderId: f.clientOrderId, fillId: f.fillId },
      payload: { price: f.price, size: f.size, side: f.side, fee: f.fee, feeCcy: f.feeCcy, liquidity: f.liquidity, realizedPnl: f.realizedPnl, venueTs: f.ts, ...(f.liquidation ? { liquidation: true } : {}), ...(confirmed ? { inferred: f.inferred } : {}) },
      attestation: confirmed ? 'user-asserted' : o && this.x.accounts.find(o.accountId)?.mode === 'live' ? 'venue-confirmed' : 'kernel-observed',
      venueRef: { venue: this.x.accounts.find(f.accountId)?.venue ?? 'unknown', nativeFillId: f.venueFillId },
    }, confirmed?.ledger)
    if (!confirmed) this.x.events.publish('account.fills', f)
    return true
  }

  /** 来自总线的成交：按 clientOrderId（有就用）或 venueOrderId 找到内核订单；订单还没记下场所单号（成交先于回执）就先缓存。 */
  private pendingFills = new Map<string, { fill: VenueFill; accountId: string; at: number }[]>()
  private pendingOrderUpdates = new Map<string, { venueOrderId: string; clientOrderId: string | null; status: OrderStatus }>()
  onVenueFill(accountId: string, vf: VenueFill): void {
    if ((vf as VenueFill & { inferred?: unknown }).inferred !== undefined) {
      throw new KernelError(makeProblem('INVALID_PARAMS', 'venue fills cannot supply inferred confirmation provenance'))
    }
    const venueOrder = this.x.orders.byVenueOrderId(accountId, vf.venueOrderId)
    let o = venueOrder?.parentOrderId ? venueOrder : (vf.clientOrderId ? this.x.orders.byClientOrderId(vf.clientOrderId) : undefined) ?? venueOrder
    if (!o) {
      const matches = this.x.db.prepare(`
        SELECT o.doc FROM orders o
        JOIN docs d ON d.coll='order-record' AND d.id=o.order_id
          AND d.ver=(SELECT MAX(d2.ver) FROM docs d2 WHERE d2.coll='order-record' AND d2.id=o.order_id)
        JOIN json_each(d.doc, '$.supersededVenueOrderIds') sid
        WHERE o.account_id=? AND o.instrument_id=? AND sid.value=? AND sid.type='text'
        LIMIT 2
      `).all(accountId, vf.instrumentId, vf.venueOrderId) as { doc: string }[]
      if (matches.length === 1) {
        const candidate = JSON.parse(matches[0]!.doc) as Order
        if (!vf.clientOrderId || vf.clientOrderId === candidate.clientOrderId) o = candidate
      }
    }
    if (o && (o.accountId !== accountId || o.instrumentId !== vf.instrumentId)) return
    if (o && vf.clientOrderId === o.clientOrderId) o = this.linkChild(o, vf.venueOrderId)
    // 纸面场所强平是场所自己建的单（clientOrderId 为空），内核没有对应订单：补一条订单记录 + annotation，再走正常成交路径。
    // 实盘账户或不是强平的外来单一律保持原行为（进缓存、60 秒后丢弃）。
    if (!o && vf.liquidation === true) {
      const account = this.x.accounts.find(accountId)
      if (account && account.mode !== 'live') o = this.recordPaperLiquidationOrder(account, vf)
    }
    if (!o || (o.status === 'submitted' && !o.venueOrderId)) {
      const list = this.pendingFills.get(`${accountId}|${vf.venueOrderId}`) ?? []
      list.push({ fill: vf, accountId, at: this.x.clock.now() })
      this.pendingFills.set(`${accountId}|${vf.venueOrderId}`, list)
      for (const [k, v] of this.pendingFills) if (v.every((x) => this.x.clock.now() - x.at > 60_000)) this.pendingFills.delete(k) // 场所侧外来订单：不属于内核，一分钟后丢弃
      return
    }
    this.applyFill(this.fillForOrder(vf, o))
  }
  /** 给纸面场所的强平成交补一条内核订单记录（系统来源，clientOrderId 以 liq- 开头），并留一条 paper.liquidation 注解。 */
  private recordPaperLiquidationOrder(account: Account, vf: VenueFill): Order {
    const now = this.x.clock.now()
    const origin = mkOrigin('system:paper-liquidation', 'venue:liquidation', 'internal')
    const order: Order = {
      orderId: newId('ord', now), clientOrderId: brand(`liq-${vf.venueOrderId}`), venueOrderId: vf.venueOrderId,
      accountId: account.accountId, instrumentId: vf.instrumentId, side: vf.side, type: 'market', tif: 'ioc',
      size: vf.size, filledSize: '0' as never, price: null, triggerPrice: null, avgFillPrice: null,
      reduceOnly: true, status: 'submitted', fee: '0' as never,
      origin, createdAt: now, submittedAt: now, updatedAt: now,
    }
    tx(this.x.db, () => {
      this.x.orders.upsert(order, '0', false)
      this.x.ledger.append({
        type: 'annotation', origin,
        subject: { accountId: account.accountId, instrumentId: vf.instrumentId, orderId: order.orderId, clientOrderId: order.clientOrderId },
        payload: { kind: 'paper.liquidation', orderId: order.orderId, venueOrderId: vf.venueOrderId, instrumentId: vf.instrumentId, side: vf.side, size: vf.size, price: vf.price },
      })
    })
    return order
  }
  private fillForOrder(vf: VenueFill, o: Order): Fill {
    const venueFillId = vf.venueFillId || `fallback:${digestOf([o.orderId, vf.ts, d.str(d.D(vf.size)), d.str(d.D(vf.price))]).slice(7)}`
    return { fillId: newId('fill'), orderId: o.orderId, clientOrderId: o.clientOrderId, accountId: o.accountId, venueFillId, instrumentId: vf.instrumentId, side: vf.side, price: vf.price, size: vf.size, fee: vf.fee, feeCcy: vf.feeCcy, ...(vf.builderFee ? { builderFee: vf.builderFee } : {}), liquidity: vf.liquidity, realizedPnl: vf.realizedPnl, ...(vf.liquidation ? { liquidation: true } : {}), ts: vf.ts }
  }
  private preparePendingFills(o: Order): Fill[] {
    const fills: Fill[] = []
    for (const { fill: vf } of this.pendingFills.get(`${o.accountId}|${o.venueOrderId}`) ?? []) {
      if ((vf as VenueFill & { inferred?: unknown }).inferred !== undefined) {
        throw new KernelError(makeProblem('INVALID_PARAMS', 'venue fills cannot supply inferred confirmation provenance'))
      }
      // 回执的场所单号不能覆盖事件明确给出的订单关联。
      if (!o.parentOrderId && vf.clientOrderId && vf.clientOrderId !== o.clientOrderId) continue
      if (vf.instrumentId !== o.instrumentId) continue
      const fill = this.fillForOrder(vf, o)
      const prior = fills.find((candidate) => candidate.venueFillId === fill.venueFillId) ?? this.x.orders.fillWithId(fill)
      if (this.validateFill(fill, undefined, prior)) fills.push(fill)
    }
    return fills
  }

  /** 连接器推来的订单状态变化（撤销 / 过期 / 触发 / 场所侧成交后的状态）。 */
  onOrderUpdate(accountId: string, u: { venueOrderId: string; clientOrderId: string | null; status: OrderStatus }, audit: { origin?: Origin; writeLedger?: boolean; confirmedCancelVenueOrderId?: string } = {}): void {
    const venueOrder = this.x.orders.byVenueOrderId(accountId, u.venueOrderId)
    let o = venueOrder?.parentOrderId ? venueOrder : (u.clientOrderId ? this.x.orders.byClientOrderId(u.clientOrderId) : undefined) ?? venueOrder
    if (o && o.accountId !== accountId) return
    if (o && u.venueOrderId && this.x.docs.get<OrderRecord>('order-record', o.orderId)?.supersededVenueOrderIds?.includes(u.venueOrderId)) return
    if (!o) {
      this.pendingOrderUpdates.set(`${accountId}|${u.venueOrderId}`, u)
      if (this.pendingOrderUpdates.size > 10000) this.pendingOrderUpdates.delete(this.pendingOrderUpdates.keys().next().value!)
      return
    }
    const pendingAmend = this.pendingAmends.get(o.orderId)
    if (pendingAmend && terminalOrder(u.status) && u.venueOrderId) pendingAmend.observedTerminal = { venueOrderId: u.venueOrderId, status: u.status }
    const awaitingAmendResolution = !!pendingAmend && (pendingAmend.awaitingAck || pendingAmend.awaitingIdentity)
    const confirmedCancel = !!pendingAmend && awaitingAmendResolution && u.status === 'cancelled'
      && !!audit.confirmedCancelVenueOrderId && audit.confirmedCancelVenueOrderId === u.venueOrderId
      && audit.confirmedCancelVenueOrderId === pendingAmend.order.venueOrderId
      && audit.confirmedCancelVenueOrderId === o.venueOrderId
    if (awaitingAmendResolution && !confirmedCancel && terminalOrder(u.status) && pendingAmend?.order.venueOrderId && u.venueOrderId === pendingAmend.order.venueOrderId) {
      pendingAmend.deferredTerminal = { venueOrderId: u.venueOrderId, clientOrderId: u.clientOrderId, status: u.status }
      return
    }
    if (u.clientOrderId === o.clientOrderId && u.venueOrderId) {
      o = this.linkChild(o, u.venueOrderId)
      if (!o.parentOrderId && o.venueOrderId !== u.venueOrderId) {
        o = { ...o, venueOrderId: u.venueOrderId, updatedAt: this.x.clock.now() }
        this.x.orders.upsert(o, '0', !o.reduceOnly)
        this.x.events.publish('account.orders', o)
      }
    }
    if (u.venueOrderId && this.pendingFills.has(`${accountId}|${u.venueOrderId}`)) {
      const bound = { ...o, venueOrderId: o.venueOrderId ?? u.venueOrderId }
      const fills = this.preparePendingFills(bound)
      tx(this.x.db, () => {
        this.x.orders.upsert(bound, '0', !bound.reduceOnly)
        for (const fill of fills) this.applyFillTx(fill)
      })
      this.pendingFills.delete(`${accountId}|${u.venueOrderId}`)
      o = this.x.orders.get(bound.orderId) ?? bound
    }
    if (o && ['filled', 'cancelled', 'rejected', 'expired'].includes(u.status) && !confirmedCancel) {
      this.clearPendingAmend(o.orderId)
      const uncertain = this.uncertainOrders.get(accountId); uncertain?.delete(o.clientOrderId); if (uncertain?.size === 0) this.uncertainOrders.delete(accountId)
    }
    if (o) {
      if (confirmedCancel) this.reservations.outcome(accountId, o.clientOrderId, { status: 'unknown', filledSize: o.filledSize, ...(o.venueOrderId ? { venueOrderId: o.venueOrderId } : {}) })
      else if (['filled', 'cancelled', 'rejected', 'expired'].includes(u.status)) this.reservations.outcome(accountId, o.clientOrderId, { status: u.status as 'filled' | 'cancelled' | 'rejected' | 'expired', ...(o.venueOrderId ? { venueOrderId: o.venueOrderId } : {}) })
      else if (u.status === 'open' || u.status === 'untriggered' || u.status === 'partially_filled') this.reservations.outcome(accountId, o.clientOrderId, { status: u.status, filledSize: o.filledSize, ...(u.venueOrderId ? { venueOrderId: u.venueOrderId } : {}) })
    }
    const confirmedReplacementTerminal = !!pendingAmend?.replacementVenueOrderId
      && pendingAmend.replacementVenueOrderId === u.venueOrderId && pendingAmend.replacementVenueOrderId === o.venueOrderId
      && ['cancelled', 'expired', 'rejected'].includes(u.status)
    if (o.status === u.status || terminalOrder(o.status) && !confirmedReplacementTerminal) return
    if (u.status === 'filled' || u.status === 'partially_filled') return // 成交状态由成交事件推进（避免和 fill 双算）
    const next: Order = { ...o, status: u.status, venueOrderId: o.venueOrderId ?? u.venueOrderId, updatedAt: this.x.clock.now(), ...(['cancelled', 'expired', 'rejected'].includes(u.status) ? { closedAt: this.x.clock.now() } : {}) }
    // 一单一条 order.accepted：场所回执落账时（trading.ts 的 accepted 写入）已经记过一条；场所随后推 open / untriggered，
    // 或者下单回执还没落账（账本只有 order.submitted、没有 accepted / reconciliation）时场所先同步推来 open / untriggered，
    // 后者由回执负责记账，所以两种情况都只更新订单状态与推送事件，不再写第二条。
    const trail = this.x.ledger.trace({ orderId: o.orderId })
    const acceptedWritten = trail.some((entry) => entry.type === 'order.accepted')
    // 子单（止损 / 止盈）由 recordChildAck 落账（可能只写 order.submitted），没有「回执」这一步：不按等回执处理
    const awaitingReceipt = !o.parentOrderId && (o.status === 'new' || o.status === 'submitted') && !acceptedWritten
      && !trail.some((entry) => entry.type === 'reconciliation')
    const skipAccepted = (u.status === 'open' || u.status === 'untriggered')
      && (acceptedWritten || o.status === 'open' || o.status === 'untriggered' || awaitingReceipt)
    const type = u.status === 'open' && o.status === 'untriggered' ? 'order.triggered'
      : skipAccepted ? undefined
        : ({ cancelled: 'order.cancelled', expired: 'order.expired', untriggered: 'order.accepted', rejected: 'order.rejected', open: 'order.accepted' } as Record<string, LedgerEntryType>)[u.status]
    tx(this.x.db, () => {
      this.x.orders.upsert(next, '0', !o.reduceOnly) // 名义额沿用首次写入的值（upsert 不改 notional 列）
      // fix-r4 C11：子单 accepted/triggered 等沿用父单 origin（谁开的仓谁挂的止损）；撤销/过期记真正的触发主体，兜底场所，永不回落父单的 Agent。
      const venueOrigin = (): Origin => mkOrigin(`venue:${this.x.accounts.find(o.accountId)?.venue ?? 'unknown'}`, 'venue:order-update', 'internal')
      const entryOrigin = !o.parentOrderId ? audit.origin ?? venueOrigin()
        : u.status === 'cancelled' || u.status === 'expired' ? audit.origin ?? this.causeOf(o) ?? venueOrigin() : o.origin
      if (type && audit.writeLedger !== false) this.x.ledger.append({ type, origin: entryOrigin, subject: { accountId: brand(o.accountId), instrumentId: o.instrumentId, orderId: o.orderId, clientOrderId: o.clientOrderId }, payload: { status: u.status } })
    })
    this.x.events.publish('account.orders', next)
  }

  // ================================================================
  // 撤单 / 平仓
  // ================================================================
  async amend(ctx: ActorCtx, req: { accountId: string; orderId?: string; clientOrderId?: string; price?: string; size?: string; triggerPrice?: string }): Promise<{ order: Order }> {
    ctx = canonicalTakeoverContext(ctx)
    return this.withAccountQueue(req.accountId, async (): Promise<ExecutionStart<{ order: Order }>> => {
      const find = (): Order => {
        const order = req.orderId ? this.x.orders.get(req.orderId) : req.clientOrderId ? this.x.orders.byClientOrderId(req.clientOrderId) : undefined
        if (!order || order.accountId !== req.accountId) throw err('INVALID_PARAMS', 'order not found for this account')
        if (ctx.principal.kind !== 'session' && ctx.origin.actor !== order.origin.actor) {
          this.rejectAmend(order, { price: req.price ?? order.price, size: req.size ?? order.size, triggerPrice: req.triggerPrice ?? order.triggerPrice }, ctx, 'not_owner',
            makeProblem('EXPERIMENT_FORBIDDEN', 'only the order owner or a human can amend'))
        }
        if (terminalOrder(order.status)) throw err('INVALID_PARAMS', 'cannot amend a terminal order')
        const record = this.x.docs.get<OrderRecord>('order-record', order.orderId)
        if (record?.unlinked) throw err('INVALID_PARAMS', 'child order is not linked to the venue; cancel its parent or use cancel-all')
        if (record?.amendPending) throw err('INVALID_PARAMS', 'an amendment for this order is still pending')
        return order
      }
      let order = find()
      if (req.price === undefined && req.size === undefined && req.triggerPrice === undefined) throw err('INVALID_PARAMS', 'amend requires price, size or triggerPrice')
      for (const value of [req.price, req.size, req.triggerPrice]) {
        if (value !== undefined && (typeof value !== 'string' || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value) || !d.gt(d.D(value), d.ZERO))) throw err('INVALID_PARAMS', 'amend values must be positive decimal strings')
      }
      const account = this.x.accounts.get(order.accountId)
      this.requireTradeLevel(ctx, account)
      const data = await this.collectGateData(account, order.instrumentId)
      order = find()
      const record = this.x.docs.get<OrderRecord>('order-record', order.orderId) ?? {}
      const intent: OrderIntent = {
        ...(record.intent ?? {}), accountId: order.accountId, instrumentId: order.instrumentId, side: order.side, type: order.type,
        size: order.size, tif: order.tif, clientOrderId: order.clientOrderId, reduceOnly: order.reduceOnly,
        ...(order.price == null ? {} : { price: order.price }), ...(order.triggerPrice == null ? {} : { triggerPrice: order.triggerPrice }),
        ...(order.postOnly === undefined ? {} : { postOnly: order.postOnly }), ...(order.leverage === undefined ? {} : { leverage: order.leverage }),
        reason: record.intent?.reason ?? 'amend existing order',
        ...(req.price === undefined ? {} : { price: req.price as never }), ...(req.size === undefined ? {} : { size: req.size as never }),
        ...(req.triggerPrice === undefined ? {} : { triggerPrice: req.triggerPrice as never }),
      }
      if (req.price !== undefined && !['limit', 'stop_limit', 'take_limit'].includes(order.type)) throw err('INVALID_PARAMS', 'this order type has no limit price')
      if (req.triggerPrice !== undefined && !['stop_market', 'stop_limit', 'take_market', 'take_limit', 'trailing_stop'].includes(order.type)) throw err('INVALID_PARAMS', 'this order type has no trigger price')
      const n = this.normalize(account, intent, ctx)
      if (d.lt(d.D(n.size), d.D(order.filledSize))) throw err('INVALID_PARAMS', 'new size is below already filled size')
      const own = (row: { clientOrderId?: string | null; venueOrderId?: string | null }) => row.clientOrderId === order.clientOrderId || !!order.venueOrderId && row.venueOrderId === order.venueOrderId
      const book = this.reservations.fork()
      book.release(order.accountId, order.clientOrderId)
      const isolated = { ...data, snapshot: { ...data.snapshot, openOrders: data.snapshot.openOrders.filter((row) => !own(row)) },
        valuedOpenOrders: data.valuedOpenOrders.filter((row) => !own(row)) }
      const assembled = this.assembleOrderGate(isolated, account, n, ctx, 'direct', book, false, false, undefined, 'amend')
      this.amendAuthorization(order, n, assembled.input, data.snapshot, ctx)
      this.writePrecheckLedger(assembled.account, n, assembled.precheck, ctx, assembled.mandate, { orderId: order.orderId, input: assembled.input, timing: assembled.timing, normalization: assembled.normalization })
      if (assembled.precheck.verdict !== 'allow' || assembled.requiresOwnershipApproval) throw new KernelError(assembled.precheck.verdict === 'deny' ? problemOfPrecheck(assembled.precheck) : makeProblem('NEEDS_APPROVAL', 'amend requires human approval'))
      const target = adjustedGateTarget(assembled.input.target, assembled.precheck.applied)
      if (target.kind !== 'order') throw err('INTERNAL_ERROR', 'amend needs an order gate target')
      const amended = target.intent
      this.amendAuthorization(order, amended, assembled.input, data.snapshot, ctx)
      const signer = this.signerOpt(assembled.account)
      const ticket = this.ticketAuthority.issue(assembled.input, assembled.precheck, target)
      const ref = gateRefPrice(amended, data.mark?.price)
      const notional = ref ? d.str(d.mul(d.mul(d.D(amended.size), d.D(ref)), d.D(this.x.bus.instrument(amended.instrumentId)?.contractSize ?? '1'))) : '0'
      const reservation: ReservationRecord = {
        accountId: order.accountId, clientOrderId: order.clientOrderId, ...(order.mandateId ? { mandateId: order.mandateId } : {}),
        instrumentId: order.instrumentId, side: order.side, size: amended.size, reduceOnly: amended.reduceOnly === true,
        notional: (amended.reduceOnly ? '0' : notional) as never, margin: amended.reduceOnly ? '0' as never : budgetMargin(d.D(notional), d.D(amended.leverage ?? 1)),
        issuedAt: this.x.clock.now(), expiresAt: ticket.expiresAt, supportsExpiry: this.x.bus.supportsOrderExpiry(assembled.account),
      }
      const history = this.x.ledger.trace({ orderId: order.orderId }).reverse().find((entry) => (entry.type === 'order.intent' || entry.type === 'order.amended') && (entry.payload as { reservation?: ReservationRecord })?.reservation)
      const oldNotional = (this.x.db.prepare('SELECT notional FROM orders WHERE order_id=?').get(order.orderId) as { notional: string }).notional
      const old = record.reservation ?? (history?.payload as { reservation?: ReservationRecord } | undefined)?.reservation ?? {
        ...reservation, size: order.size, notional: (order.reduceOnly ? '0' : oldNotional) as never,
        margin: order.reduceOnly ? '0' as never : budgetMargin(d.D(oldNotional), d.D(order.leverage ?? 1)), issuedAt: order.createdAt,
      }
      const held: ReservationRecord = { ...reservation, size: d.str(d.max(d.D(old.size), d.D(reservation.size))),
        notional: d.str(d.max(d.D(old.notional), d.D(reservation.notional))), margin: d.str(d.max(d.D(old.margin), d.D(reservation.margin))) }
      delete record.replacementVenueOrderId
      tx(this.x.db, () => {
        this.x.docs.put('order-record', order.orderId, { ...record, reservation: old, amendPending: { reservation: held, ticketId: ticket.ticketId } } satisfies OrderRecord)
        this.x.ledger.append({ type: 'annotation', origin: ctx.origin,
          subject: { accountId: order.accountId, orderId: order.orderId, clientOrderId: order.clientOrderId, ...(order.mandateId ? { mandateId: order.mandateId } : {}) },
          payload: { kind: 'amend.issued', ticketId: ticket.ticketId, reservation: held } })
      })
      this.pendingAmends.set(order.orderId, { order, reservation: held, awaitingAck: false })
      this.replaceOrderReservation(order, held, true)
      const pending = (async (): Promise<{ order: Order }> => {
        const reject = async (problem: Problem, unknown: boolean, skipRefresh = false): Promise<never> => {
          const current = this.x.orders.get(order.orderId) ?? order
          const latest = this.x.docs.get<OrderRecord>('order-record', order.orderId) ?? record
          const deferredTerminal = this.pendingAmends.get(order.orderId)?.deferredTerminal
          if (!unknown) {
            delete latest.amendPending
            latest.reservation = old
            this.pendingAmends.delete(order.orderId)
          } else {
            const pendingState = this.pendingAmends.get(order.orderId)
            if (pendingState) delete pendingState.deferredTerminal
          }
          tx(this.x.db, () => {
            this.x.docs.put('order-record', order.orderId, latest)
            this.x.ledger.append({ type: unknown ? 'annotation' : 'order.rejected', origin: ctx.origin,
              subject: { accountId: order.accountId, orderId: order.orderId, clientOrderId: order.clientOrderId },
              payload: { kind: unknown ? 'amend.unknown' : 'amend', problem, reservation: unknown ? held : old } })
          })
          this.replaceOrderReservation(current, unknown ? held : old, unknown)
          if (unknown && !skipRefresh) {
            const refreshed = await this.boundedOrderLookup(assembled.account, order.clientOrderId, {
              instrumentId: order.instrumentId,
              ...(order.venueOrderId ? { venueOrderId: order.venueOrderId } : {}),
            })
            if (refreshed) this.onOrderUpdate(assembled.account.accountId, {
              venueOrderId: refreshed.venueOrderId ?? order.venueOrderId ?? '',
              clientOrderId: order.clientOrderId,
              status: refreshed.status,
            })
          }
          if (!unknown && deferredTerminal) this.onOrderUpdate(assembled.account.accountId, deferredTerminal)
          throw new KernelError(problem)
        }
        let result: Awaited<ReturnType<ConnectorBus['amend']>>
        const pendingState = this.pendingAmends.get(order.orderId)
        if (pendingState) pendingState.awaitingAck = true
        try { result = await this.x.bus.amend(assembled.account, amended, { ...signer, ticket, ...(order.venueOrderId ? { venueOrderId: order.venueOrderId } : {}) }) }
        catch (error) {
          if (pendingState) pendingState.awaitingAck = false
          const problem = connectorOperationError(error, 'amend', assembled.account.venue).problem
          const definite = !['VENUE_OUTCOME_UNKNOWN', 'VENUE_UNAVAILABLE', 'INTERNAL_ERROR'].includes(problem.name)
          return reject(definite ? problem : makeProblem('VENUE_OUTCOME_UNKNOWN', 'amend outcome is unknown; reservation retained'), !definite)
        }
        if (pendingState) pendingState.awaitingAck = false
        const ack = result.acks.find((item) => item.role === undefined || item.role === 'parent')
        if (ack?.status === 'rejected') return reject(ack.problem ?? makeProblem('VENUE_REJECTED', 'amend rejected'), false)
        if (!ack || ack.status === 'unknown') return reject(makeProblem('VENUE_OUTCOME_UNKNOWN', 'amend outcome is unknown; reservation retained'), true)
        const ackVenueOrderId = typeof ack.venueOrderId === 'string' && ack.venueOrderId.length > 0 ? ack.venueOrderId : undefined
        const currentBeforeLookup = this.x.orders.get(order.orderId) ?? order
        const recordBeforeLookup = this.x.docs.get<OrderRecord>('order-record', order.orderId) ?? record
        const originalVenueOrderId = order.venueOrderId
        if (ackVenueOrderId && recordBeforeLookup.supersededVenueOrderIds?.includes(ackVenueOrderId)) {
          return reject(makeProblem('VENUE_OUTCOME_UNKNOWN', 'amend outcome is unknown; reservation retained'), true, true)
        }
        const ackReplacementId = ackVenueOrderId && originalVenueOrderId && ackVenueOrderId !== originalVenueOrderId ? ackVenueOrderId : undefined
        const currentReplacementId = currentBeforeLookup.venueOrderId && originalVenueOrderId && currentBeforeLookup.venueOrderId !== originalVenueOrderId
          ? currentBeforeLookup.venueOrderId : undefined
        if (ackReplacementId && currentReplacementId && ackReplacementId !== currentReplacementId) {
          return reject(makeProblem('VENUE_OUTCOME_UNKNOWN', 'amend outcome is unknown; reservation retained'), true, true)
        }
        const explicitVenueOrderId = ackReplacementId ?? currentReplacementId
        const lookupVenueOrderId = explicitVenueOrderId ?? currentBeforeLookup.venueOrderId ?? originalVenueOrderId
        if (explicitVenueOrderId && originalVenueOrderId && explicitVenueOrderId !== originalVenueOrderId) {
          const superseded = [...new Set([...(recordBeforeLookup.supersededVenueOrderIds ?? []), originalVenueOrderId])]
          const identified = { ...currentBeforeLookup, venueOrderId: explicitVenueOrderId }
          if (pendingState) pendingState.replacementVenueOrderId = explicitVenueOrderId
          tx(this.x.db, () => {
            this.x.orders.upsert(identified, '0', !identified.reduceOnly)
            this.x.docs.put('order-record', order.orderId, { ...recordBeforeLookup, supersededVenueOrderIds: superseded, replacementVenueOrderId: explicitVenueOrderId })
          })
        }
        if (pendingState) pendingState.awaitingIdentity = true
        const refreshed = await this.boundedOrderLookup(assembled.account, order.clientOrderId, { instrumentId: order.instrumentId, ...(lookupVenueOrderId ? { venueOrderId: lookupVenueOrderId } : {}) })
        if (pendingState) pendingState.awaitingIdentity = false
        if (refreshed?.venueOrderId && explicitVenueOrderId && refreshed.venueOrderId !== explicitVenueOrderId) {
          return reject(makeProblem('VENUE_OUTCOME_UNKNOWN', 'amend outcome is unknown; reservation retained'), true, true)
        }
        const currentAfterLookup = this.x.orders.get(order.orderId) ?? currentBeforeLookup
        const recordAfterLookup = this.x.docs.get<OrderRecord>('order-record', order.orderId) ?? recordBeforeLookup
        const candidateVenueOrderId = explicitVenueOrderId ?? refreshed?.venueOrderId ?? currentAfterLookup.venueOrderId ?? originalVenueOrderId
        if (candidateVenueOrderId && recordAfterLookup.supersededVenueOrderIds?.includes(candidateVenueOrderId)) {
          return reject(makeProblem('VENUE_OUTCOME_UNKNOWN', 'amend outcome is unknown; reservation retained'), true, true)
        }
        if (currentAfterLookup.venueOrderId && currentAfterLookup.venueOrderId !== candidateVenueOrderId
          && currentAfterLookup.venueOrderId !== originalVenueOrderId) {
          return reject(makeProblem('VENUE_OUTCOME_UNKNOWN', 'amend outcome is unknown; reservation retained'), true, true)
        }
        const replaced = !!candidateVenueOrderId && !!originalVenueOrderId && candidateVenueOrderId !== originalVenueOrderId
        if ((candidateVenueOrderId && candidateVenueOrderId !== currentAfterLookup.venueOrderId || replaced) && !explicitVenueOrderId) {
          const superseded = replaced
            ? [...new Set([...(recordAfterLookup.supersededVenueOrderIds ?? []), originalVenueOrderId!])]
            : recordAfterLookup.supersededVenueOrderIds
          const identified = { ...currentAfterLookup, venueOrderId: candidateVenueOrderId }
          if (replaced && pendingState) pendingState.replacementVenueOrderId = candidateVenueOrderId
          tx(this.x.db, () => {
            this.x.orders.upsert(identified, '0', !identified.reduceOnly)
            this.x.docs.put('order-record', order.orderId, { ...recordAfterLookup, ...(superseded ? { supersededVenueOrderIds: superseded } : {}), ...(replaced ? { replacementVenueOrderId: candidateVenueOrderId } : {}) })
          })
        }
        const deferredTerminal = pendingState?.deferredTerminal
        if (pendingState) delete pendingState.deferredTerminal
        if (!replaced && deferredTerminal) this.onOrderUpdate(assembled.account.accountId, deferredTerminal)
        const current = this.x.orders.get(order.orderId) ?? order
        const filledSize = this.hasRecordedInferredFill(current) ? current.filledSize : d.str(d.max(d.D(current.filledSize), d.D(ack.filledSize)))
        const observedTerminal = pendingState?.observedTerminal
        const latestRecord = this.x.docs.get<OrderRecord>('order-record', order.orderId) ?? recordBeforeLookup
        const observedCurrentTerminal = !!replaced && !!observedTerminal && observedTerminal.venueOrderId === current.venueOrderId
          && !latestRecord.supersededVenueOrderIds?.includes(observedTerminal.venueOrderId)
        const calculatedStatus: OrderStatus = d.gte(d.D(filledSize), d.D(amended.size)) ? 'filled'
          : d.gt(d.D(filledSize), d.ZERO) ? 'partially_filled' : ack.status === 'untriggered' ? 'untriggered' : 'open'
        const status: OrderStatus = replaced
          ? observedCurrentTerminal ? observedTerminal!.status : calculatedStatus
          : terminalOrder(current.status) ? current.status : calculatedStatus
        const next: Order = { ...current, price: amended.price ?? null, size: amended.size, triggerPrice: amended.triggerPrice ?? null, filledSize, status,
          venueOrderId: candidateVenueOrderId ?? current.venueOrderId,
          updatedAt: this.x.clock.now(), ...(status === 'filled' ? { closedAt: this.x.clock.now() } : {}) }
        if (!terminalOrder(status)) delete next.closedAt
        const latest = this.x.docs.get<OrderRecord>('order-record', order.orderId) ?? record
        delete latest.amendPending
        tx(this.x.db, () => {
          this.x.orders.amend(next, notional)
          this.x.docs.put('order-record', order.orderId, { ...latest, intent: amended, reservation })
          this.x.ledger.append({ type: 'order.amended', origin: ctx.origin,
            subject: { accountId: next.accountId, orderId: next.orderId, clientOrderId: next.clientOrderId, precheckId: assembled.precheck.precheckId, ...(next.mandateId ? { mandateId: next.mandateId } : {}) },
            precheck: this.controlPrecheck(assembled.precheck),
            payload: { kind: 'amend', orderId: next.orderId, reservation, before: { price: order.price, size: order.size, triggerPrice: order.triggerPrice }, after: { price: next.price, size: next.size, triggerPrice: next.triggerPrice },
              gate: { decision: assembled.precheck, snapshot: gateSnapshotOf(assembled.input), target, ticketId: ticket.ticketId } } })
        })
        this.pendingAmends.delete(order.orderId)
        this.replaceOrderReservation(next, reservation)
        this.x.bus.invalidateSnapshot(next.accountId)
        this.x.events.publish('account.orders', next)
        return { order: next }
      })()
      return { pending }
    })
  }

  private async confirmCancel(account: Account, order: Order, audit: { origin?: Origin; writeLedger?: boolean; onConfirmed?: (confirmed: boolean) => void } = {}): Promise<boolean> {
    const record = this.x.docs.get<OrderRecord>('order-record', order.orderId) ?? {}
    this.x.docs.put('order-record', order.orderId, { ...record, cancelRequestedAt: this.x.clock.now() })
    // Even if a synchronous venue push already closed it, the query can recover a racing fill.
    const result = await this.boundedOrderLookup(account, order.clientOrderId, order)
    if (result) {
      const confirmedCancelVenueOrderId = result.status === 'cancelled' && !!result.venueOrderId
        && result.venueOrderId === order.venueOrderId && this.x.orders.get(order.orderId)?.venueOrderId === result.venueOrderId
        ? result.venueOrderId : undefined
      this.onOrderUpdate(account.accountId, { venueOrderId: result.venueOrderId ?? order.venueOrderId ?? '', clientOrderId: order.clientOrderId, status: result.status },
        { ...audit, ...(confirmedCancelVenueOrderId ? { confirmedCancelVenueOrderId } : {}) })
    }
    const confirmed = this.x.orders.get(order.orderId)?.status === 'cancelled'
    audit.onConfirmed?.(confirmed)
    return confirmed
  }

  private async confirmCancels(account: Account, acks: CancelAck[], origin: Origin, onComplete?: (confirmed: number) => void): Promise<number> {
    let confirmed = 0, completed = 0, cursor = 0
    const accepted = acks.filter((ack) => ack.ok)
    const finish = (cancelled: boolean) => {
      if (cancelled) confirmed++
      if (++completed === accepted.length) onComplete?.(confirmed)
    }
    await Promise.all(Array.from({ length: Math.min(8, accepted.length) }, async () => {
      for (;;) {
        const ack = accepted[cursor++]
        if (!ack) return
        const local = (ack.target.venueOrderId ? this.x.orders.byVenueOrderId(account.accountId, ack.target.venueOrderId) : undefined)
          ?? (ack.target.clientOrderId ? this.x.orders.byClientOrderId(ack.target.clientOrderId) : undefined)
        if (local?.accountId === account.accountId && !this.isUnlinkedChild(local.orderId)) {
          await this.confirmCancel(account, local, { origin, writeLedger: false, onConfirmed: finish })
        } else {
          const state = await this.boundedOrderLookup(account, ack.target.clientOrderId ?? '', { ...(ack.target.venueOrderId ? { venueOrderId: ack.target.venueOrderId } : {}) })
          finish(state?.status === 'cancelled')
        }
      }
    }))
    return confirmed
  }

  private requireTradeLevel(ctx: ActorCtx, account: Account): Mandate | null {
    const m = this.mandateOf(ctx)
    if (ctx.principal.kind === 'agent' || ctx.principal.kind === 'engine') {
      const revoked = this.keyRevoked(ctx)
      if (!m || revoked) throw err('MANDATE_EXPIRED', revoked ? '这把钥匙已被撤销（key revoked）' : 'no effective mandate')
      const lv = Number(m.level.slice(1))
      if (lv < 1) throw err('MANDATE_LEVEL', 'read-only mandate cannot cancel or close')
      if (account.mode === 'live' && lv < 3) throw err('MANDATE_LEVEL', 'direct live order actions need L3+')
      if (!m.accounts.includes(account.accountId as never)) throw err('MANDATE_LIMIT', 'account is not covered by this mandate')
    }
    return m
  }

  private cancelLog = new Map<string, number[]>()
  /** fix-r4 C11 撤单触发主体登记：key = orderId | acct:<账户>[:<标的>]；过期不认，防泄漏。 */
  private cancelCauses = new Map<string, { origin: Origin; until: number }>()
  private noteCause(key: string, origin: Origin, ttlMs: number): () => void {
    const now = this.x.clock.now()
    for (const [k, v] of this.cancelCauses) if (v.until <= now) this.cancelCauses.delete(k)
    const entry = { origin, until: now + ttlMs }
    this.cancelCauses.set(key, entry)
    return () => { if (this.cancelCauses.get(key) === entry) this.cancelCauses.delete(key) }
  }
  private causeOf(o: Order): Origin | undefined {
    const now = this.x.clock.now()
    for (const key of [o.orderId, `acct:${o.accountId}:${o.instrumentId}`, `acct:${o.accountId}`]) {
      const v = this.cancelCauses.get(key)
      if (v && v.until > now) return v.origin
    }
    return undefined
  }
  /** 平仓引起的保护单回收：人触发 → system:kernel 且 requestId 指向人（同 systemCancelAll 款）；Agent / 系统自己平仓照实记。 */
  private noteCloseCause(accountId: string, instrumentId: string, origin: Origin): void {
    const cause = origin.actorType === 'human' ? mkOrigin('system:kernel', 'system.protective-cleanup', 'internal', { requestId: origin.requestId, ...(origin.causation ? { causation: structuredClone(origin.causation) } : {}) }) : origin
    this.noteCause(`acct:${accountId}:${instrumentId}`, cause, 30_000)
  }
  /** 最近一分钟该账户的撤单次数（风险状态块的占用条）。 */
  cancelsLastMinute(accountId: string): number { return (this.cancelLog.get(`acct:${accountId}`) ?? []).filter((t) => t > this.x.clock.now() - 60_000).length }
  /** 撤单频率上限（每账户 / 每 Agent 钥匙每分钟）。超限拒绝并入账 risk.denied。接管发起的撤单不受限（自保动作）。 */
  private cancelRateHits(account: Account, mandate: Mandate | null): RuleHit[] {
    const now = this.x.clock.now()
    const caps: [number | undefined, string, string, string][] = [
      [this.x.risk.effectiveLimits(now).maxCancelsPerMinute, `acct:${account.accountId}`, `${this.x.risk.current()?.policyId ?? 'pol_none'}#maxCancelsPerMinute`, 'account'],
      [mandate?.limits.maxCancelsPerMinute, `mdt:${mandate?.mandateId}`, `${mandate?.mandateId}#maxCancelsPerMinute`, 'mandate'],
    ]
    const hits: RuleHit[] = []
    for (const [cap, key, ruleId, scope] of caps) {
      if (cap === undefined) continue
      const log = (this.cancelLog.get(key) ?? []).filter((t) => t > now - 60_000)
      this.cancelLog.set(key, log)
      if (log.length + 1 > cap) hits.push({ ruleId, code: scope === 'mandate' ? 'MANDATE_LIMIT' : 'RATE_BUDGET', limit: String(cap) as never, actual: String(log.length + 1) as never, unit: 'cancels/min', action: 'deny', scope })
    }
    return hits
  }

  async cancel(args: { accountId: string; orderId?: string; clientOrderId?: string }, ctx: ActorCtx): Promise<{ ok: boolean; problem?: Problem }> {
    return this.withAccountQueue(args.accountId, async () => {
      const account = this.x.accounts.get(args.accountId), o = args.orderId ? this.x.orders.get(args.orderId) : args.clientOrderId ? this.x.orders.byClientOrderId(args.clientOrderId) : undefined
      if (!o || o.accountId !== account.accountId) throw err('ACCOUNT_NOT_BOUND', 'order not found for this account')
      if (this.isUnlinkedChild(o.orderId)) throw err('INVALID_PARAMS', 'child order is not linked to the venue; cancel its parent or use cancel-all')
      const actual = structuredClone(this.x.accounts.get(account.accountId)), data = await this.collectGateData(actual, undefined)
      const venueOrder = data.snapshot.openOrders.find((row) => row.clientOrderId === o.clientOrderId || (!!o.venueOrderId && row.venueOrderId === o.venueOrderId))
      const role: 'sl' | 'tp' | undefined = this.isProtectiveOrder(o, data.snapshot) || (venueOrder?.isTrigger === true && venueOrder.type !== 'take_market' && venueOrder.type !== 'take_limit' && venueOrder.type !== 'stop_market' && venueOrder.type !== 'stop_limit') ? 'sl' : o.tpslRole === 'tp' ? 'tp' : undefined
      const target: GateTarget = { kind: 'cancel', targets: [{ orderId: o.orderId, clientOrderId: o.clientOrderId, ...(role ? { tpslRole: role } : {}) }] }
      const cancelPriceChecks = await this.collectCancelPriceChecks([o.instrumentId], ctx)
      const assembled = this.assembleControlGate({ ...data, ...(cancelPriceChecks === undefined ? {} : { cancelPriceChecks }) }, actual, target, role === 'sl' ? 'cancel_protective' : 'cancel', ctx, this.reservations, o.instrumentId)
      if (assembled.precheck.decision !== 'ALLOW') { this.writeControlReject(assembled, ctx, o, 'gate'); throw new KernelError(problemOfPrecheck(assembled.precheck)) }
      const trustedSystem = ctx.principal.kind === 'service' && ctx.origin.actor.startsWith('system:') && ctx.origin.actorType === 'system' && ctx.origin.via === 'internal'
      const mandate = this.requireTradeLevel(ctx, assembled.account), hits = trustedSystem ? [] : this.cancelRateHits(assembled.account, mandate)
      if (hits.length) { const name = RULE_PROBLEM_DEFAULTS[hits[0]!.code] ?? 'RULE_DENIED'; const problem = makeProblem(name, hits.map((h) => `${h.code}: ${h.limit}/${h.unit}`).join('; '), { ruleHits: hits }); this.writeControlReject(assembled, ctx, o, 'cancelRateGuard', problem); throw new KernelError(problem) }
      const ticket = this.ticketAuthority.issue(assembled.input, assembled.precheck, target)
      const signer = this.signerOpt(assembled.account)
      if (!trustedSystem) this.recordCancelUse(assembled.account, mandate)
      const clearCause = this.noteCause(o.orderId, ctx.origin, 60_000)
      const pending = this.x.bus.cancel(assembled.account, { instrumentId: o.instrumentId, orderId: o.orderId, clientOrderId: o.clientOrderId, ...(o.venueOrderId ? { venueOrderId: o.venueOrderId } : {}), ...(role ? { tpslRole: role } : {}) }, { ...signer, ticket }).then(async (r) => {
        // fix-r2 K2：撤一张纸面场所从没见过的本地单 → 本地收敛为 cancelled，算成功（不把场所的「不认识」当错误抛给人）
        const current = this.x.orders.get(o.orderId) ?? o
        if (!r.ok && this.neverReachedCandidate(assembled.account, current) && !(await this.boundedOrderLookup(assembled.account, current.clientOrderId, current))) {
          this.convergeNeverReached(current, 'cancel', ctx.origin)
          return { ok: true }
        }
        const pushed = this.x.orders.get(o.orderId)?.status === 'cancelled'
        const confirmed = r.ok && await this.confirmCancel(assembled.account, o, { origin: ctx.origin, writeLedger: false })
        this.x.ledger.append({ type: r.ok ? confirmed && !pushed ? 'order.cancelled' : 'annotation' : 'order.rejected', origin: ctx.origin, subject: { accountId: brand(assembled.account.accountId), instrumentId: o.instrumentId, orderId: o.orderId, clientOrderId: o.clientOrderId, precheckId: assembled.precheck.precheckId }, precheck: this.controlPrecheck(assembled.precheck), ...(assembled.precheck.decision !== 'ALLOW' ? { ruleHits: assembled.precheck.ruleHits } : {}), payload: { kind: confirmed ? 'cancel.confirmed' : 'cancel.requested', action: 'cancel', ok: r.ok, confirmed, gate: { decision: assembled.precheck, snapshot: gateSnapshotOf(assembled.input), target, ticketId: ticket.ticketId }, timing: assembled.timing, ...(r.problem ? { problem: r.problem } : {}) } })
        return r.problem ? { ok: r.ok, problem: r.problem } : { ok: r.ok }
      }).finally(clearCause)
      return { pending }
    }, 'high')
  }

  private isProtectiveOrder(order: Order, snapshot?: AccountSnapshot): boolean {
    if (order.tpslRole === 'sl') return true
    if (snapshot?.stopLossOrderIds?.some((id) => id === order.venueOrderId || id === order.clientOrderId)) return true
    return order.reduceOnly === true && (order.type === 'stop_market' || order.type === 'stop_limit')
  }

  private writeControlReject(assembled: ReturnType<TradingService['assembleControlGate']>, ctx: ActorCtx, order: Order | undefined, kind: string, problem?: Problem): void {
    const summary = this.controlPrecheck(assembled.precheck)
    if (kind === 'cancelRateGuard' && problem) this.x.ledger.append({ type: 'risk.denied', origin: ctx.origin, subject: { accountId: brand(assembled.account.accountId), ...(order ? { orderId: brand(order.orderId) } : {}), precheckId: assembled.precheck.precheckId }, precheck: summary, ruleHits: problem.ruleHits ?? [], payload: { kind, problem, cancelRateGuard: { ruleHits: problem.ruleHits ?? [] } } })
    this.x.ledger.append({ type: 'order.rejected', origin: ctx.origin, subject: { accountId: brand(assembled.account.accountId), ...(order ? { orderId: brand(order.orderId), clientOrderId: order.clientOrderId, instrumentId: order.instrumentId } : {}), precheckId: assembled.precheck.precheckId }, precheck: summary, ...(assembled.precheck.decision !== 'ALLOW' ? { ruleHits: assembled.precheck.ruleHits } : {}), payload: { kind, ...(problem ? { problem } : {}), ...(kind === 'cancelRateGuard' && problem ? { cancelRateGuard: { ruleHits: problem.ruleHits ?? [] } } : {}), gate: { decision: assembled.precheck, snapshot: gateSnapshotOf(assembled.input), target: assembled.input.target }, timing: assembled.timing } })
  }

  private controlPrecheck(decision: GateDecision): LedgerPrecheck {
    return { precheckId: decision.precheckId, verdict: decision.verdict, policyVersion: decision.policyVersion, estimates: decision.estimates }
  }

  private recordCancelUse(account: Account, mandate: Mandate | null): void {
    const now = this.x.clock.now()
    const caps: [number | undefined, string][] = [[this.x.risk.effectiveLimits(now).maxCancelsPerMinute, `acct:${account.accountId}`], [mandate?.limits.maxCancelsPerMinute, `mdt:${mandate?.mandateId}`]]
    for (const [cap, key] of caps) if (cap !== undefined) this.cancelLog.set(key, [...(this.cancelLog.get(key) ?? []).filter((t) => t > now - 60_000), now])
  }

  private signerOpt(account: Account): { signer?: Signer } {
    const s = this.signerFor(account)
    return s ? { signer: s } : {}
  }

  async cancelAll(args: { accountId: string; instrumentId?: string; keepProtective?: boolean }, ctx: ActorCtx): Promise<{ cancelled: number }> {
    return this.runCancelAll(args, ctx, false)
  }

  private async runCancelAll(args: { accountId: string; instrumentId?: string; keepProtective?: boolean }, ctx: ActorCtx, bypassCancelRate: boolean): Promise<{ cancelled: number; confirmation?: Promise<number> }> {
    return this.withAccountQueue(args.accountId, async () => {
      const account = this.x.accounts.get(args.accountId), keepProtective = args.keepProtective ?? true
      const action: GateAction = keepProtective ? 'cancel' : 'cancel_protective'
      const target: GateTarget = { kind: 'cancel_all', ...(args.instrumentId ? { instrumentId: args.instrumentId as never } : {}), keepProtective }
      const data = await this.collectGateData(account, undefined)
      const cancelInstruments = args.instrumentId ? [args.instrumentId] : (data.snapshot.openOrders ?? []).map((order) => order.instrumentId)
      const cancelPriceChecks = await this.collectCancelPriceChecks(cancelInstruments, ctx)
      const assembled = this.assembleControlGate({ ...data, ...(cancelPriceChecks === undefined ? {} : { cancelPriceChecks }) }, account, target, action, ctx, this.reservations, args.instrumentId)
      if (assembled.precheck.decision !== 'ALLOW') { this.writeControlReject(assembled, ctx, undefined, 'gate'); throw new KernelError(problemOfPrecheck(assembled.precheck)) }
      const isSystem = ctx.principal.kind === 'service' && ctx.origin.actor.startsWith('system:') && ctx.origin.actorType === 'system' && ctx.origin.via === 'internal'
      const mandate = isSystem ? null : this.requireTradeLevel(ctx, assembled.account)
      const hits = isSystem || bypassCancelRate ? [] : this.cancelRateHits(assembled.account, mandate)
      if (hits.length) { const name = RULE_PROBLEM_DEFAULTS[hits[0]!.code] ?? 'RULE_DENIED'; const problem = makeProblem(name, hits.map((h) => `${h.code}: ${h.limit}/${h.unit}`).join('; '), { ruleHits: hits }); this.writeControlReject(assembled, ctx, undefined, 'cancelRateGuard', problem); throw new KernelError(problem) }
      const ticket = this.ticketAuthority.issue(assembled.input, assembled.precheck, target)
      const signer = this.signerOpt(assembled.account)
      if (!isSystem) this.recordCancelUse(assembled.account, mandate)
      const settle = async (result: { acks: CancelAck[]; cancelled: number; viewFailure?: unknown; failure?: { problem: Problem; errorStages: string[] } }, partial = false, afterConfirm?: () => void): Promise<{ cancelled: number; confirmation?: Promise<number> }> => {
        const subject = { accountId: brand<Account['accountId']>(assembled.account.accountId), ...(args.instrumentId ? { instrumentId: args.instrumentId as never } : {}), precheckId: assembled.precheck.precheckId }
        const audit = { action: 'cancel_all', requested: result.cancelled, ...(result.viewFailure ? { viewFailure: result.viewFailure } : {}), ...(result.failure ? { failure: result.failure } : {}),
          gate: { decision: assembled.precheck, snapshot: gateSnapshotOf(assembled.input), target, ticketId: ticket.ticketId }, timing: assembled.timing }
        let summaryWritten = false
        const writeConfirmed = (confirmed: number) => {
          if (summaryWritten) return
          summaryWritten = true
          this.x.ledger.append({ type: confirmed > 0 || !bypassCancelRate && result.cancelled === 0 ? 'order.cancelled' : 'annotation',
            origin: ctx.origin, subject, precheck: this.controlPrecheck(assembled.precheck),
            payload: { kind: partial ? 'cancel.partial' : 'cancel_all.confirmed', ...audit, cancelled: confirmed, confirmed } })
          afterConfirm?.()
        }
        const confirm = async () => {
          // Publish at the last confirmed terminal update, before unwinding the worker promises.
          const confirmed = result.acks.some((ack) => ack.ok) ? await this.confirmCancels(assembled.account, result.acks, ctx.origin, writeConfirmed) : 0
          writeConfirmed(confirmed)
          return { cancelled: confirmed }
        }
        if (!bypassCancelRate) return confirm()
        this.x.ledger.append({ type: 'annotation', origin: ctx.origin, subject, precheck: this.controlPrecheck(assembled.precheck),
          payload: { ...audit, kind: 'cancel_all.requested', confirmation: 'pending', ...(partial ? { partial: true } : {}) } })
        // One confirm() call, whose outcome is both audited here and handed to the caller for the takeover receipt.
        const confirmation = confirm().then((r) => r.cancelled).catch(() => {
          try {
            this.x.ledger.append({ type: 'annotation', origin: ctx.origin, subject,
              payload: { ...audit, kind: 'cancel_all.confirmation_failed', confirmation: 'unknown' } })
            afterConfirm?.()
          } catch { /* The ledger can already be closed during shutdown. */ }
          return 0
        })
        // Hidden from enumeration: a Promise is not part of the serializable cancel-all result shape.
        const out: { cancelled: number; confirmation?: Promise<number> } = { cancelled: result.cancelled }
        Object.defineProperty(out, 'confirmation', { value: confirmation, enumerable: false })
        return out
      }
      // 只有真会撤保护单（keepProtective=false）才登记账户级归因；否则窗口内场所自发撤的 OCO 兄弟单会被误记给调用者
      const clearCause = keepProtective ? () => undefined : this.noteCause(`acct:${args.accountId}${args.instrumentId ? ':' + args.instrumentId : ''}`, ctx.origin, 60_000)
      const pending = this.x.bus.cancelAll(assembled.account, { ...(args.instrumentId ? { instrumentId: args.instrumentId as never } : {}), keepProtective, ...signer, ticket })
        .then((result) => settle(result))
        .catch(async (error: unknown) => {
          const operation = connectorOperationError(error, 'cancel_all', assembled.account.venue)
          const partial = operation.partialCancel
          const viewFailure = operation.viewFailure
          const writeRejected = () => this.x.ledger.append({ type: 'order.rejected', origin: ctx.origin, subject: { accountId: brand(assembled.account.accountId), ...(args.instrumentId ? { instrumentId: args.instrumentId as never } : {}), precheckId: assembled.precheck.precheckId }, precheck: this.controlPrecheck(assembled.precheck), payload: { kind: 'cancel.failed', gate: { decision: assembled.precheck, snapshot: gateSnapshotOf(assembled.input), target, ticketId: ticket.ticketId }, problem: operation.problem, errorStages: operation.stages, ...(partial ? { partialCancelled: partial.cancelled } : {}), ...(viewFailure ? { viewFailure } : {}), timing: assembled.timing } })
          // Persist failure in the pending annotation immediately; final evidence follows confirmation.
          if (partial) await settle({ ...partial, ...(viewFailure ? { viewFailure } : {}), failure: { problem: operation.problem, errorStages: operation.stages } }, true, bypassCancelRate ? writeRejected : undefined)
          if (!partial || !bypassCancelRate) writeRejected()
          throw operation
        }).finally(clearCause)
      return { pending }
    }, 'high')
  }

  setKillSwitchState(state: GateInput['killSwitch']): void { this.killSwitch = structuredClone(state) }

  async systemCancelAll(account: Account, options: { instrumentId?: string; keepProtective?: boolean } = {}, origin?: Origin): Promise<{ cancelled: number }> {
    const ctx: ActorCtx = { principal: { kind: 'service' }, origin: mkOrigin('system:kernel', 'system.cancelAll', 'internal', origin ? { requestId: origin.requestId, ...(origin.causation ? { causation: structuredClone(origin.causation) } : {}) } : {}) }
    return this.runCancelAll({ accountId: account.accountId, ...options, keepProtective: true }, ctx, true)
  }

  /** 接管内部撤单：沿真实调用者做门禁出票，只跳过普通撤单计数门槛。 */
  async takeoverCancelAll(account: Account, options: { instrumentId?: string; keepProtective?: boolean }, ctx: ActorCtx): Promise<{ cancelled: number; confirmation?: Promise<number> }> {
    ctx = canonicalTakeoverContext(ctx)
    const trustedHuman = ctx.principal.kind === 'session' && ctx.origin.actorType === 'human'
    const scopedOptions = trustedHuman ? options : { ...options, keepProtective: true }
    return this.runCancelAll({ accountId: account.accountId, ...scopedOptions }, ctx, true)
  }

  async systemScheduleCancel(account: Account, atMs: number | null, origin?: Origin): Promise<{ ok: boolean; problem?: Problem }> {
    return this.withAccountQueue(account.accountId, async () => {
      const ctx: ActorCtx = { principal: { kind: 'service' }, origin: mkOrigin('system:kernel', 'system.scheduleCancel', 'internal', origin ? { requestId: origin.requestId, ...(origin.causation ? { causation: structuredClone(origin.causation) } : {}) } : {}) }
      const sampled = structuredClone(this.x.accounts.get(account.accountId)), now = this.x.clock.now()
      const neutral: AccountSnapshot = { accountId: sampled.accountId, ts: now, equity: '0' as never, available: '0' as never, positions: [], openOrders: [], stale: true }
      const data = await this.collectGateData(sampled, undefined, neutral), target: GateTarget = { kind: 'deadman', atMs }
      const assembled = this.assembleControlGate(data, sampled, target, atMs === null ? 'deadman_disarm' : 'deadman_arm', ctx, this.reservations.fork())
      if (assembled.precheck.decision !== 'ALLOW') { this.writeControlReject(assembled, ctx, undefined, 'gate'); throw new KernelError(problemOfPrecheck(assembled.precheck)) }
      const ticket = this.ticketAuthority.issue(assembled.input, assembled.precheck, target)
      const gate = { decision: assembled.precheck, snapshot: gateSnapshotOf(assembled.input), target, ticketId: ticket.ticketId }
      const subject = { accountId: assembled.account.accountId, precheckId: assembled.precheck.precheckId }
      const writeAudit = (result: { ok: boolean; problem?: Problem }, thrown?: Problem): void => {
        if (result.ok && atMs !== null) this.x.ledger.recordGateRenewal(assembled.account.accountId, assembled.timing)
        const problem = thrown ?? result.problem
        const errorStages = thrown ? (thrown instanceof ConnectorOperationError ? thrown.stages : ['deadman.schedule']) : problem ? ['deadman.schedule'] : undefined
        this.x.ledger.append({
          type: result.ok ? 'annotation' : 'order.rejected', origin: ctx.origin, subject,
          precheck: this.controlPrecheck(assembled.precheck),
          ...(assembled.precheck.decision !== 'ALLOW' ? { ruleHits: assembled.precheck.ruleHits } : {}),
          payload: { action: atMs === null ? 'deadman_disarm' : 'deadman_arm', result, ...(problem ? { problem } : {}), ...(errorStages ? { errorStages } : {}), gate, timing: assembled.timing },
        })
      }
      const pending = Promise.resolve().then(() => this.x.bus.scheduleCancel(assembled.account, atMs, this.signerOpt(assembled.account).signer, ticket)).then((result) => {
        writeAudit(result)
        return result
      }).catch((error: unknown) => {
        const operation = connectorOperationError(error, 'deadman.schedule', assembled.account.venue)
        writeAudit({ ok: false, problem: operation.problem }, operation.problem)
        throw operation
      })
      return { pending }
    }, 'high')
  }

  async reconcileReservations(view: AccountSnapshot): Promise<ReconcileResult> {
    return this.withAccountQueue(view.accountId, async () => {
      const account = structuredClone(this.x.accounts.get(view.accountId)), data = await this.collectGateData(account, undefined, view)
      const current = structuredClone(this.x.accounts.get(view.accountId))
      if (data.routeKey !== this.x.bus.snapshotRouteKey(current)) throw err('STALE_PRICE', 'account route changed while reservation reconciliation ran', { retryable: true })
      const now = this.x.clock.now(), policy = this.x.risk.current() ?? null
      const confirmedFresh = data.snapshot.confirmedAt === undefined || now - data.snapshot.confirmedAt <= (policy?.failClosed.staleAccountMs ?? 30_000)
      const truncated = data.snapshot.truncated === true
      const fresh = !data.snapshot.stale && !truncated && confirmedFresh
      const result = this.reservations.reconcileReservations({ accountId: view.accountId, now, fresh, observationAt: data.snapshot.confirmedAt ?? data.snapshot.asOf ?? data.snapshot.ts, truncated, availableDeductsOpenOrders: data.snapshot.availableDeductsOpenOrders ?? false, openOrders: data.valuedOpenOrders })
      this.applyReconciliation(view.accountId, this.reservations, result, data.valuedOpenOrders, fresh)
      return { done: result }
    }, 'high')
  }

  /** 平仓 = 只减仓市价单，仍过风控闸（纯减仓永远放行，除非 HALTED）。 */
  async closePosition(args: { accountId: string; instrumentId: string; size?: string; reason?: string; clientOrderId?: string }, ctx: ActorCtx): Promise<PlaceResult> {
    const account = this.x.accounts.get(args.accountId)
    const snap = (await this.collectGateData(account, args.instrumentId)).snapshot
    const pos = snap.positions.find((p) => p.instrumentId === args.instrumentId)
    if (!pos) throw err('INVALID_PARAMS', `no open position in ${args.instrumentId}`)
    const size = args.size ? d.str(d.min(d.D(args.size), d.D(pos.size))) : pos.size
    this.noteCloseCause(account.accountId, args.instrumentId, ctx.origin)
    const intent: OrderIntent = { accountId: account.accountId as never, instrumentId: args.instrumentId, side: pos.side === 'long' ? 'sell' : 'buy', type: 'market', size: size as never, reduceOnly: true, reason: args.reason ?? 'close position', ...(args.clientOrderId ? { clientOrderId: args.clientOrderId } : {}) }
    if (account.mode === 'live' && ctx.principal.kind === 'agent') {
      const pv = await this.preview(intent, ctx)
      if (!pv.confirmToken) return { order: await this.recordDenied(account, pv, ctx, intent) }
      return this.place({ confirmToken: pv.confirmToken }, ctx)
    }
    this.requireTradeLevel(ctx, account)
    return this.place({ intent }, ctx)
  }

  private async recordDenied(account: Account, _pv: PreviewResult, ctx: ActorCtx, authorIntent: OrderIntent): Promise<Order> {
    const n = this.normalize(account, authorIntent, ctx)
    const result = await this.runOrder({ n, authorIntent: n, ctx, path: 'direct' })
    if (!result.order) throw err('NEEDS_APPROVAL', result.problem?.message ?? 'needs human approval', { ruleHits: result.problem?.ruleHits })
    return result.order
  }

  /** 接管内部减仓：保留调用者身份，显式 reduceOnly 并走完整评估/出票链。 */
  async takeoverReduceOnly(account: Account, instrumentId: string, side: 'buy' | 'sell', size: string, ctx: ActorCtx): Promise<Order> {
    ctx = canonicalTakeoverContext(ctx)
    this.noteCloseCause(account.accountId, instrumentId, ctx.origin)
    const n = this.normalize(account, { accountId: account.accountId as never, instrumentId, side, type: 'market', size: size as never, reduceOnly: true, reason: 'takeover' }, ctx)
    return this.executeOrder({ account, n, ctx, mandate: null, path: 'direct' })
  }

  /** 系统来源减仓保留既有公开语义。 */
  async systemReduceOnly(account: Account, instrumentId: string, side: 'buy' | 'sell', size: string, origin: Origin): Promise<Order> {
    const ctx: ActorCtx = { principal: { kind: 'service' }, origin: mkOrigin('system:kernel', 'system.reduceOnly', 'internal', { requestId: origin.requestId, ...(origin.causation ? { causation: structuredClone(origin.causation) } : {}) }) }
    return this.takeoverReduceOnly(account, instrumentId, side, size, ctx)
  }

  // ================================================================
  // 提案
  // ================================================================
  private nextTicket(): string {
    const dt = new Date(this.x.clock.now())
    const day = `${dt.getFullYear()}${String(dt.getMonth() + 1).padStart(2, '0')}${String(dt.getDate()).padStart(2, '0')}`
    this.x.db.prepare('INSERT INTO ticket_seq(day,n) VALUES(?,1) ON CONFLICT(day) DO UPDATE SET n=n+1').run(day)
    const n = (this.x.db.prepare('SELECT n FROM ticket_seq WHERE day=?').get(day) as { n: number }).n
    return `T-${day}-${String(n).padStart(4, '0')}`
  }

  private transition(p: Proposal, ev: ProposalEvent): Proposal {
    const to = nextProposalStatus(p.status, ev)
    if (!to) throw err('INVALID_PARAMS', `proposal ${p.ticket}: ${ev} is not allowed from ${p.status}`)
    return { ...p, status: to }
  }
  private saveProposal(p: Proposal): Proposal {
    this.x.docs.put('proposal', p.proposalId, p)
    // fix-r2 K3：本进程正在执行的提案（启动恢复不碰它们）
    if (p.status === 'executing' || p.status === 'approved') this.liveProposals.add(p.proposalId)
    else this.liveProposals.delete(p.proposalId)
    return p
  }
  private liveProposals = new Set<string>()
  private readonly precheckThrottle = new PrecheckThrottle({
    now: () => this.x.clock.now(),
    write: (note) => { this.x.ledger.append({ type: 'annotation', origin: mkOrigin('system:kernel', 'precheck:summary', 'internal'), subject: { orgId: 'org_local' }, payload: { ...note } }) },
  })
  /** fix-r2 D4：按成交归属的仓位开仓人（受限钥匙自保判断用）。 */
  positionOwnersOf(accountId: string, instrumentId: string): { net: string; actors: string[] } { return this.x.orders.positionOwners(accountId, instrumentId) }
  /** fix-r2 L3：结算预览汇总（定时任务与关机时调用）。 */
  flushPrecheckSummaries(force = false): void { this.precheckThrottle.flush(force) }

  getProposal(idOrTicket: string): Proposal | undefined {
    return this.x.docs.get<Proposal>('proposal', idOrTicket) ?? this.x.docs.list<Proposal>('proposal', { limit: 1000 }).find((p) => p.ticket === idOrTicket)
  }
  listProposals(q: { status?: string; mandateId?: string; limit?: number } = {}): Proposal[] {
    return this.x.docs.list<Proposal>('proposal', { limit: 1000 }).filter((p) => (!q.status || p.status === q.status) && (!q.mandateId || p.mandateId === q.mandateId)).slice(0, q.limit ?? 50)
  }

  /** Agent 提案（kind=order）。预检 deny → 状态 denied；纸面 / 影子账户在授权书范围内自动批准；实盘进待审。 */
  async propose(input: ProposeInput, ctx: ActorCtx): Promise<Proposal> {
    if (ctx.principal.kind !== 'agent' && ctx.principal.kind !== 'engine') throw err('MANDATE_LEVEL', 'proposals are created by agent keys or bound engines')
    const mandate = this.mandateOf(ctx)
    const revoked = this.keyRevoked(ctx)
    if (!mandate || revoked) throw err('MANDATE_EXPIRED', revoked ? '这把钥匙已被撤销（key revoked）' : 'no effective mandate')
    const account = this.x.accounts.get(input.accountId)
    if (mainnetLiveBlocked(account)) {
      throw err('CAPABILITY_UNSUPPORTED', '0.1.1 does not support mainnet live trading; see Known limitations. 0.1.1 不支持主网实盘交易，见已知限制。')
    }
    if (!Array.isArray(input.intents) || input.intents.length < 1 || input.intents.length > PROPOSAL_DEFAULTS.maxIntents) throw err('INVALID_PARAMS', `intents must contain 1-${PROPOSAL_DEFAULTS.maxIntents} legs`)
    if (typeof input.reason !== 'string' || input.reason.trim().length < 1 || input.reason.length > 2000) throw err('INVALID_PARAMS', 'reason (1-2000 characters) is required')
    const legs = input.intents.map((i) => this.normalize(account, { ...i, reason: i.reason ?? input.reason }, ctx))
    // 多腿预检：任一腿 deny 则整体 deny（合并 ruleHits）
    let combined: PrecheckResult | undefined
    let ownershipPending = false
    const proposalLegs: NormalizedIntent[] = []
    for (const leg of legs) {
      const data = await this.collectGateData(account, leg)
      const assembled = this.assembleOrderGate(data, account, leg, ctx, 'proposal', this.reservations.fork(), false, false, mandate.mandateId)
      const decision = assembled.precheck
      ownershipPending ||= assembled.requiresOwnershipApproval
      const target = adjustedGateTarget(assembled.input.target, decision.applied)
      if (target.kind !== 'order') throw err('INTERNAL_ERROR', 'proposal gate returned a non-order target')
      proposalLegs.push(target.intent)
      this.writePrecheckLedger(assembled.account, target.intent, decision, ctx, assembled.mandate, { input: assembled.input, timing: assembled.timing, normalization: assembled.normalization, path: 'proposal' })
      const summary = this.precheckSummary(decision)
      if (!combined) combined = summary
      else combined = { ...combined, verdict: decision.verdict === 'deny' || combined.verdict === 'deny' ? 'deny' : decision.verdict === 'review' || combined.verdict === 'review' ? 'review' : 'allow', ruleHits: [...combined.ruleHits, ...decision.ruleHits] }
    }
    const forcePending = input.forcePending || ownershipPending || (mandate.level === 'L2' && proposalLegs.some((leg) => !leg.reduceOnly))
    return this.createProposal(account, proposalLegs, input.reason, input.evidence, ctx, mandate, combined as PrecheckResult, { autoApprove: !forcePending && account.mode !== 'live' && combined!.verdict === 'allow' })
  }

  private async createProposal(account: Account, legs: NormalizedIntent[], reason: string, evidence: Proposal['evidence'] | undefined, ctx: ActorCtx, mandate: Mandate | null, precheck: PrecheckResult, opts: { autoApprove?: boolean } = {}): Promise<Proposal> {
    const revoked = this.keyRevoked(ctx)
    if (!mandate || revoked) throw err('MANDATE_EXPIRED', revoked ? '这把钥匙已被撤销（key revoked）' : 'proposals need a mandate')
    const now = this.x.clock.now()
    const ttl = (mandate.approval?.pendingTtlSec ?? PROPOSAL_DEFAULTS.pendingTtlMs / 1000) * 1000
    const ref = precheck.priceRef
    let p: Proposal = {
      proposalId: newId('prop', now), ticket: this.nextTicket() as never, kind: 'order', status: 'draft', accountId: account.accountId as never,
      intents: legs, intentsDigest: digestOf(legs), reason: reason || legs[0]?.reason || 'n/a', ...(evidence ? { evidence } : {}), precheck,
      ...(ref ? { priceBounds: { referencePrice: ref.markPrice, maxDriftBps: this.x.risk.maxDriftBps() } } : {}),
      mandateId: mandate.mandateId, expiresAt: now + ttl, decision: null, execution: null, origin: ctx.origin,
    }
    const subject = { proposalId: p.proposalId, ticket: p.ticket, accountId: brand<`acct_${string}`>(account.accountId), mandateId: mandate.mandateId, precheckId: precheck.precheckId }
    const pcL = { precheckId: precheck.precheckId, verdict: precheck.verdict, policyVersion: precheck.policyVersion, estimates: precheck.estimates }
    if (precheck.verdict === 'deny') {
      p = this.transition(p, 'precheck_deny')
      this.saveProposal(p)
      this.x.ledger.append({ type: 'proposal.created', origin: ctx.origin, subject, precheck: pcL, ruleHits: precheck.ruleHits, payload: { status: p.status, intentsDigest: p.intentsDigest, reason: p.reason } })
      this.x.events.publish('proposal.created', p)
      return p
    }
    p = this.transition(p, 'submit')
    this.saveProposal(p)
    this.x.ledger.append({ type: 'proposal.created', origin: ctx.origin, subject, precheck: pcL, ...(precheck.verdict !== 'allow' ? { ruleHits: precheck.ruleHits } : {}), payload: { status: p.status, intentsDigest: p.intentsDigest, reason: p.reason, legs: legs.length } })
    // 推送给工作台的提案带上 approvalNeedsPin（与 proposal.list / get 视图同口径），免得实时卡片在刷新前误画锁
    let needsPin = true
    try { needsPin = this.approvalNeedsPin(p.proposalId) } catch { /* 判断出错按要 PIN */ }
    this.x.events.publish('proposal.created', { ...p, approvalNeedsPin: needsPin })
    if (opts.autoApprove) {
      p = this.transition(p, 'approve')
      p = { ...p, decision: { by: `mandate:${mandate.mandateId}`, at: now, note: 'auto-approved by mandate' } }
      this.saveProposal(p)
      this.x.ledger.append({ type: 'proposal.decided', origin: mkOrigin(`mandate:${mandate.mandateId}`, 'mandate:auto-approve', 'internal', { onBehalfOf: 'user:usr_local' }), subject, payload: { decision: 'approved', by: p.decision?.by } })
      if (account.mode !== 'live') {
        // 纸面 / 影子：授权书自动批准后直接执行
        p = this.transition(p, 'execute')
        this.saveProposal(p)
        const orders: Order[] = []
        for (const leg of legs) {
          orders.push(await this.executeOrder({ account, n: leg, ctx, mandate, path: 'direct', proposalId: p.proposalId }))
        }
        return this.finishProposal(p.proposalId, orders)
      }
      // 实盘（L3/L4 授权书自动批准）：由调用方执行下单，再 finishProposal
      p = this.transition(p, 'execute')
      this.saveProposal(p)
    }
    return p
  }

  /** 执行结束：记 executed / failed。 */
  async finishProposal(proposalId: string, orders: Order[], problem?: Problem): Promise<Proposal> {
    const cur = this.x.docs.get<Proposal>('proposal', proposalId)!
    const failedOrder = orders.find((o) => o.status === 'denied' || o.status === 'rejected')
    const failure = problem ?? failedOrder?.problem
    const ev: ProposalEvent = failure ? 'execute_fail' : 'execute_ok'
    let p = this.transition(cur, ev)
    p = { ...p, execution: { orderIds: orders.map((o) => o.orderId), at: this.x.clock.now(), result: failure ? failedOrder?.status ?? 'failed' : 'ok', ...(failure ? { problem: failure } : {}) } }
    this.saveProposal(p)
    const type: 'proposal.failed' | 'proposal.executed' = failure ? 'proposal.failed' : 'proposal.executed'
    this.x.ledger.append({ type, origin: mkOrigin('system:kernel', 'proposal:execute', 'internal'), subject: { proposalId: p.proposalId, ticket: p.ticket, mandateId: p.mandateId }, ...(failure?.ruleHits ? { ruleHits: failure.ruleHits } : {}), payload: { orderIds: p.execution?.orderIds, result: p.execution?.result } })
    this.x.events.publish(type, p)
    return p
  }

  /** 批准这张票是否必须 PIN 在场证明（超过授权书额度，或 HALT 下只减仓）。 */
  approvalNeedsPin(idOrTicket: string): boolean {
    const p = this.getProposal(idOrTicket)
    if (!p) return false
    const legs = p.intents as NormalizedIntent[]
    const threshold = this.x.agents.effective(p.mandateId)?.approval?.presenceAboveNotional
    const aboveThreshold = threshold !== undefined && d.gt(this.approvalNotional(legs, p.priceBounds?.referencePrice), d.D(threshold))
    const account = this.x.accounts.get(p.accountId as string)
    const haltedReduction = legs.some((leg) => leg.reduceOnly === true && this.haltedFor(account, leg.instrumentId))
    return aboveThreshold || haltedReduction
  }

  private approvalNotional(legs: NormalizedIntent[], fallbackPrice?: string): d.Dec {
    return legs.reduce((sum, leg) => {
      const instrument = this.x.bus.instrument(leg.instrumentId)
      if (!instrument) throw this.unknownInstrument(leg.instrumentId)
      const notional = d.mul(d.mul(d.D(leg.size), d.D(gateRefPrice(leg, fallbackPrice) ?? '0')), d.D(instrument.contractSize))
      return d.add(sum, notional)
    }, d.ZERO)
  }

  /** 人面批准。名义额超过授权书 presenceAboveNotional → 必须 PIN。执行时重新预检并检查价格边界。 */
  async approve(idOrTicket: string, proof: HumanProof, ctx: ActorCtx, note?: string): Promise<Proposal> {
    assertProof(proof, 'session')
    let p = this.getProposal(idOrTicket)
    if (!p) throw err('INVALID_PARAMS', `no such proposal: ${idOrTicket}`)
    const account = this.x.accounts.get(p.accountId as string)
    if (account.mode === 'live') this.x.assertLiveStateHealthy?.()
    const now = this.x.clock.now()
    if (p.status === 'pending' && p.expiresAt <= now) { await this.tick(); throw err('PROPOSAL_EXPIRED', `proposal ${p.ticket} expired`) }
    if (p.status !== 'pending') throw err('INVALID_PARAMS', `proposal ${p.ticket} is ${p.status}, not pending`)
    const legs = p.intents as NormalizedIntent[]
    if (digestOf(legs) !== p.intentsDigest) throw err('INVALID_PARAMS', 'proposal intents were modified after submission (digest mismatch)')
    const total = d.str(this.approvalNotional(legs, p.priceBounds?.referencePrice))
    if (this.approvalNeedsPin(idOrTicket)) assertProof(proof, 'pin')
    p = this.transition(p, 'approve')
    const attDigest = p.intentsDigest
    p = { ...p, decision: { by: 'user:usr_local', at: now, attestation: { method: proof.presence, by: 'usr_local', at: now, digest: attDigest, sig: this.x.installKey.sign(attDigest) }, ...(note ? { note } : {}) } }
    // fix-r2 K3：批准文档与 proposal.decided 账本同一个事务（崩在两者之间不会留下「文档已批、账本没记」）
    const approved = p
    tx(this.x.db, () => {
      this.saveProposal(approved)
      this.x.ledger.append({ type: 'proposal.decided', origin: ctx.origin, subject: { proposalId: approved.proposalId, ticket: approved.ticket, mandateId: approved.mandateId, accountId: brand(account.accountId) }, payload: { decision: 'approved', presence: proof.presence, notional: total }, attestation: 'user-asserted' })
    })
    this.x.events.publish('proposal.decided', p)
    // 执行：批准后的价格边界 + 重新预检
    p = this.transition(p, 'execute')
    this.saveProposal(p)
    const orders: Order[] = []
    const agentCtx: ActorCtx = { principal: ctx.principal, origin: { ...p.origin, onBehalfOf: 'user:usr_local' }, proof }
    for (const leg of legs) {
      let result: PlaceResult
      try { result = await this.runOrder({ n: leg, authorIntent: leg, ctx: agentCtx, path: 'approved', proposalId: p.proposalId, mandateId: p.mandateId, priceBounds: p.priceBounds }) }
      catch (error) {
        if (!(error instanceof KernelError)) throw error
        return this.finishProposal(p.proposalId, orders, error.problem)
      }
      if (!result.order) throw err('NEEDS_APPROVAL', result.problem?.message ?? 'needs human approval', { ruleHits: result.problem?.ruleHits })
      orders.push(result.order)
      if (orders[orders.length - 1]!.status === 'denied' || orders[orders.length - 1]!.status === 'rejected') break
    }
    return this.finishProposal(p.proposalId, orders)
  }

  /** 拒绝无门槛。 */
  reject(idOrTicket: string, proof: HumanProof, ctx: ActorCtx, note?: string): Proposal {
    assertProof(proof, 'session')
    let p = this.getProposal(idOrTicket)
    if (!p) throw err('INVALID_PARAMS', `no such proposal: ${idOrTicket}`)
    p = this.transition(p, 'reject')
    const at = this.x.clock.now()
    const text = typeof note === 'string' && note ? note.slice(0, 500) : undefined // ADR-9：≤ 500 字，截断不改写
    const attDigest = digestOf({ proposalId: p.proposalId, decision: 'rejected', note: text ?? '' })
    p = { ...p, decision: { by: 'user:usr_local', at, attestation: { method: proof.presence, by: 'usr_local', at, digest: attDigest, sig: this.x.installKey.sign(attDigest) }, ...(text ? { note: text } : {}) } }
    this.saveProposal(p)
    this.x.ledger.append({ type: 'proposal.decided', origin: ctx.origin, subject: { proposalId: p.proposalId, ticket: p.ticket, mandateId: p.mandateId }, payload: { decision: 'rejected', ...(text ? { note: text } : {}) }, attestation: 'user-asserted' })
    this.x.events.publish('proposal.decided', p)
    return p
  }

  /** 提出者撤回（Agent 自保动作）。 */
  withdraw(idOrTicket: string, ctx: ActorCtx): Proposal {
    let p = this.getProposal(idOrTicket)
    if (!p) throw err('INVALID_PARAMS', `no such proposal: ${idOrTicket}`)
    if ((ctx.principal.kind !== 'agent' && ctx.principal.kind !== 'engine') || p.origin.actor !== ctx.origin.actor) throw err('MANDATE_LIMIT', 'only the proposer can withdraw a proposal')
    p = this.transition(p, 'withdraw')
    this.saveProposal(p)
    this.x.ledger.append({ type: 'proposal.withdrawn', origin: ctx.origin, subject: { proposalId: p.proposalId, ticket: p.ticket, mandateId: p.mandateId }, payload: {} })
    this.x.events.publish('proposal.withdrawn', p)
    return p
  }

  /**
   * fix-r2 K3：启动后收敛被崩溃打断的提案（不自动重放任何订单——要做就由 Agent 重新提案、人重新批）。
   *   executing + 有订单 → 按订单终态 execute_ok / execute_fail；executing + 无订单 → failed（reason interrupted）；
   *   approved（没有订单）→ 账本缺 proposal.decided 就先补上，然后 execute_window_timeout → expired（reason interrupted）。
   */
  async recoverInterruptedProposals(): Promise<number> {
    let n = 0
    for (const p of this.x.docs.list<Proposal>('proposal', { limit: 1000 })) {
      if ((p.status !== 'approved' && p.status !== 'executing') || this.liveProposals.has(p.proposalId)) continue
      const orders = (this.x.db.prepare('SELECT doc FROM orders WHERE proposal_id=? ORDER BY created_at').all(p.proposalId) as { doc: string }[]).map((r) => JSON.parse(r.doc) as Order)
      if (p.status === 'executing' && orders.length > 0) { await this.finishProposal(p.proposalId, orders); n++; continue }
      if (p.status === 'executing') { this.closeInterrupted(p, 'execute_fail', 'interrupted'); n++; continue }
      if (!this.x.ledger.query({ proposalId: p.proposalId, types: ['proposal.decided'], limit: 1 }).length && p.decision) {
        this.x.ledger.append({ type: 'proposal.decided', origin: mkOrigin('system:kernel', 'proposal:recover', 'internal'), subject: { proposalId: p.proposalId, ticket: p.ticket, mandateId: p.mandateId, accountId: brand(String(p.accountId)) },
          payload: { decision: 'approved', presence: p.decision.attestation?.method ?? 'session', recovered: true, ...(p.decision.attestation ? { attestation: p.decision.attestation } : {}) }, attestation: 'user-asserted' })
      }
      this.closeInterrupted(p, 'execute_window_timeout', 'interrupted')
      n++
    }
    return n
  }

  private closeInterrupted(p0: Proposal, ev: 'execute_fail' | 'execute_window_timeout', reason: 'interrupted' | 'execute_window'): void {
    const p = this.transition(p0, ev)
    const type = ev === 'execute_fail' ? 'proposal.failed' as const : 'proposal.expired' as const
    const problem = makeProblem('VENUE_OUTCOME_UNKNOWN', `proposal execution was interrupted (${reason}); no order was placed; propose again`, { venue: { id: 'gitrader-kernel', message: reason } })
    const saved = ev === 'execute_fail' ? { ...p, execution: { orderIds: [], at: this.x.clock.now(), result: 'failed', problem } } : p
    tx(this.x.db, () => {
      this.saveProposal(saved as Proposal)
      this.x.ledger.append({ type, origin: mkOrigin('system:kernel', 'proposal:recover', 'internal'), subject: { proposalId: p.proposalId, ticket: p.ticket, mandateId: p.mandateId }, payload: { reason, orderIds: [] } })
    })
    this.x.events.publish(type, saved)
  }

  /** 待批超时 → expired；批准后超过执行窗口仍停在 approved → expired（execute_window）。 */
  async tick(): Promise<number> {
    const now = this.x.clock.now()
    let n = 0
    this.precheckThrottle.flush()
    for (const p0 of this.x.docs.list<Proposal>('proposal', { limit: 1000 })) {
      if (p0.status === 'approved' && p0.decision && !this.liveProposals.has(p0.proposalId) && now - p0.decision.at > APPROVED_EXECUTE_WINDOW_MS) { this.closeInterrupted(p0, 'execute_window_timeout', 'execute_window'); n++; continue }
      if (p0.status !== 'pending' || p0.expiresAt > now || isTerminalProposalStatus(p0.status)) continue
      const p = this.transition(p0, 'pending_timeout')
      this.saveProposal(p)
      this.x.ledger.append({ type: 'proposal.expired', origin: mkOrigin('system:kernel', 'proposal:expire', 'internal'), subject: { proposalId: p.proposalId, ticket: p.ticket, mandateId: p.mandateId }, payload: { expiresAt: p.expiresAt } })
      this.x.events.publish('proposal.expired', p)
      n++
    }
    return n
  }
}

const principalKey = (p: Principal): string => (p.kind === 'agent' ? `agent:${p.keyId}` : p.kind === 'engine' ? `engine:${p.engineId}` : p.kind === 'session' ? `session:${p.sessionId}` : 'service')

export { newClientOrderId, ConnectorBus }
