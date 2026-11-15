// SPDX-License-Identifier: CPAL-1.0
import { randomUUID } from 'node:crypto'
import type { Account } from './proto'
import type { Fill, ReconcileAccountView, ReconcileConfirmInput, ReconcileConfirmResult, ReconcileFindingView, ReconcileNoticeData, ReconcileResolutionInput, ReconcileResolveResult, ReconcileReviewItem, ReconcileSuggestion } from './proto'
import type { ConnectorBus } from './connector'
import type { AccountRegistry } from './accounts'
import type { OrderStore } from './orders'
import type { Docs } from './db'
import type { Ledger } from './ledger'
import type { EventBus } from './events'
import type { Clock } from './util/clock'
import type { TradingService } from './trading'
import type { ActorCtx } from './trading'
import type { TradingStateService } from './trading-state'
import { assertProof } from './auth'
import type { SecurityStateHealth } from '@gitrader/protocol'
import { asDecimal, makeProblem, validateReconcileResolutionInput } from './proto'
import { KernelError } from './util/errors'
import { systemOrigin } from './util/origin'
import { buildReconcileView } from './reconcile-view'
import type { ReconcileOrderObservation } from './reconcile-view'
import { digestOf } from './util/hash'
import { newId } from './util/ids'
import * as d from './util/dec'
import { classifyVenueStatus } from '../../exec-reconcile/src/status'
import { reconcileCandidateDigest } from './reconcile-review'
import type { ReviewSeed } from './reconcile-review'

const VENUE_LOOKBACK_MS = 24 * 60 * 60 * 1000
const HISTORY_LIMIT = 20
const ROUND_DEADLINE_MS = 5000
const MIN_INTERVAL_MS = 10_000
const CONFIRMATION_FINDING = 'CONFIRMATION_EFFECTS_PENDING'
const LATE_REAL_FINDING = 'LATE_REAL_FILL_REVIEW_REQUIRED'
const DEADLINE = Symbol('reconcile deadline')

type OrderRecordView = { supersededVenueOrderIds?: string[]; intent?: { marginMode?: 'cross' | 'isolated' } }
type PrivateCandidate = { suggestion: ReconcileSuggestion; fillsDigest: string; reviewItemId: string }
type PrivateOffer = {
  offerId: string
  reportId: string
  securityAt: number
  candidates: Map<string, PrivateCandidate>
}
type AccountState = { view: ReconcileAccountView; privateOfferAt?: number; privateOffer?: PrivateOffer; nextHistoryCursor: number }
type ConfirmWork = { input: ReconcileConfirmInput; actor: ActorCtx; offer: PrivateOffer; result?: ReconcileConfirmResult }
type CaptureForConfirmation = {
  snapshot: Awaited<ReturnType<ConnectorBus['observeSnapshot']>>
  snapshotObservedAt: number
  observations: ReconcileOrderObservation[]
  orders: ReturnType<OrderStore['forPolling']>
  fills: Fill[]
  built: ReturnType<typeof buildReconcileView>
  orderAliases: Map<string, readonly string[]>
  orderMarginModes: Map<string, 'cross' | 'isolated'>
  historyOrderIds: Array<ReturnType<OrderStore['forPolling']>[number]['orderId']>
  nextHistoryCursor: number
  startedAt: number
}

export interface ReconcileServiceDeps {
  accounts: AccountRegistry
  orders: OrderStore
  bus: ConnectorBus
  clock: Clock
  securityNow: () => number
  ledger: Ledger
  docs: Docs
  events: EventBus
  trading: TradingService
  tstate: TradingStateService
  securityHealth: () => SecurityStateHealth
  startupBusy: (accountId: string) => boolean
  log?: (message: string) => void
}

function errorView(accountId: string, prior?: ReconcileAccountView, cause?: unknown): ReconcileAccountView {
  // 上游报错原文不改写：有原因就原样接在通用说明后面
  const upstream = cause instanceof Error && cause.message ? `: ${cause.message}` : ''
  return {
    ...(prior ?? { findings: [], suggestions: [] }), accountId: accountId as ReconcileAccountView['accountId'],
    state: 'unavailable', verdict: prior?.verdict === 'blocked' ? 'blocked' : 'attention', suggestions: [], offerId: undefined,
    ...(prior?.coverage ? { coverage: { ...prior.coverage, unavailable: [...new Set([...prior.coverage.unavailable, 'openOrders', 'historyOrders', 'fills', 'positions'])] } } : {}),
    problem: makeProblem('VENUE_OUTCOME_UNKNOWN', `reconciliation evidence is unavailable${upstream}`),
  }
}

function fixedFinding(accountId: string): ReconcileFindingView {
  return {
    id: `confirmation-effects:${accountId}`, code: CONFIRMATION_FINDING, severity: 'blocker',
    detail: 'A confirmed fill committed but its follow-up work requires human review.',
    advice: { action: 'review_confirmation', requiresHuman: true, why: 'Do not repeat the confirmation or automatically retry its follow-up work.' },
    evidence: [],
  }
}

function fixedLateRealFinding(accountId: string): ReconcileFindingView {
  return {
    id: `late-real:${accountId}`, code: LATE_REAL_FINDING, severity: 'blocker',
    detail: 'A real fill arrived after a human-confirmed inference and requires review.',
    advice: { action: 'review_late_fill', requiresHuman: true, why: 'Do not book the overlapping fill again or automatically rewrite the confirmed ledger.' },
    evidence: [],
  }
}

type BuiltReconciliation = ReturnType<typeof buildReconcileView>

function subjectMatchesCandidate(finding: BuiltReconciliation['report']['findings'][number], suggestion: ReconcileSuggestion): boolean {
  const subject = finding.subject
  return subject.orderId === suggestion.orderId && subject.clientOrderId === suggestion.clientOrderId
    && subject.venueOrderId === suggestion.venueOrderId && subject.instrumentId === suggestion.instrumentId
}

function uniquelyLinked(built: BuiltReconciliation, suggestion: ReconcileSuggestion): boolean {
  const links = (built.input.links ?? []).filter((link) => link.clientOrderId === suggestion.clientOrderId && link.venueOrderId === suggestion.venueOrderId)
  return links.length === 1 && links[0]?.orderId === suggestion.orderId
}

function validCandidateForFinding(built: BuiltReconciliation, finding: BuiltReconciliation['report']['findings'][number]): ReconcileSuggestion | undefined {
  if (finding.code !== 'fill_missing_inferred' || finding.inferred !== true || finding.advice.action !== 'record_fill') return undefined
  const matches = built.view.suggestions.filter((suggestion) => subjectMatchesCandidate(finding, suggestion) && finding.subject.venueFillId === suggestion.id)
  if (matches.length !== 1 || !uniquelyLinked(built, matches[0]!)) return undefined
  return matches[0]
}

function validCandidates(built: BuiltReconciliation): ReconcileSuggestion[] {
  return built.report.findings.flatMap((finding) => {
    if (finding.code !== 'fill_missing_inferred') return []
    const suggestion = validCandidateForFinding(built, finding)
    return suggestion ? [suggestion] : []
  })
}

function exactNonnegativeDecimal(value: unknown): d.Dec | undefined {
  if (typeof value !== 'string') return undefined
  try {
    const parsed = d.D(asDecimal(value))
    return d.lt(parsed, d.ZERO) ? undefined : parsed
  } catch { return undefined }
}

function orderHistoryExplainsCandidate(built: BuiltReconciliation, finding: BuiltReconciliation['report']['findings'][number], candidates: readonly ReconcileSuggestion[]): boolean {
  if (finding.tags?.includes('fills_only')) return false
  const matches = candidates.filter((suggestion) => subjectMatchesCandidate(finding, suggestion))
  if (matches.length !== 1) return false
  const suggestion = matches[0]!
  const expectedStatus = finding.code === 'local_open_venue_filled' ? 'filled'
    : finding.code === 'local_open_venue_partially_recorded' ? 'partially_filled' : undefined
  if (!expectedStatus) return false
  const history = (built.input.venue.historyOrders ?? []).filter((row) => row.source === 'history'
    && row.venueOrderId === suggestion.venueOrderId && row.clientOrderId === suggestion.clientOrderId
    && row.instrumentId === suggestion.instrumentId && row.side === suggestion.side
    && classifyVenueStatus(row.status) === expectedStatus)
  if (history.length !== 1) return false
  const cumulative = exactNonnegativeDecimal(history[0]?.filledSize)
  const candidateSize = exactNonnegativeDecimal(suggestion.size)
  if (cumulative === undefined || candidateSize === undefined || d.eq(candidateSize, d.ZERO)) return false
  let localSum = d.ZERO
  try {
    for (const fill of built.input.local.fills) if (fill.orderId === suggestion.orderId) {
      const size = exactNonnegativeDecimal(fill.size)
      if (size === undefined) return false
      localSum = d.add(localSum, size)
    }
  } catch { return false }
  return d.eq(d.add(localSum, candidateSize), cumulative)
}

function signedPosition(rows: readonly { instrumentId: string; side: string; size: string }[], instrumentId: string): { net: d.Dec; direction: -1 | 0 | 1; valid: boolean } {
  let long = d.ZERO
  let short = d.ZERO
  for (const row of rows) {
    if (row.instrumentId !== instrumentId) continue
    const size = exactNonnegativeDecimal(row.size)
    if (size === undefined || (row.side !== 'long' && row.side !== 'short')) return { net: d.ZERO, direction: 0, valid: false }
    if (row.side === 'long') long = d.add(long, size)
    else short = d.add(short, size)
  }
  if (d.gt(long, d.ZERO) && d.gt(short, d.ZERO)) return { net: d.ZERO, direction: 0, valid: false }
  const net = d.sub(long, short)
  return { net, direction: d.gt(net, d.ZERO) ? 1 : d.lt(net, d.ZERO) ? -1 : 0, valid: true }
}

function positionDifferenceExplained(built: BuiltReconciliation, finding: BuiltReconciliation['report']['findings'][number], candidates: readonly ReconcileSuggestion[]): boolean {
  const instrumentId = finding.subject.instrumentId
  if (!instrumentId || !['position_size_mismatch', 'position_missing_locally', 'position_missing_at_venue'].includes(finding.code)) return false
  const sameInstrument = candidates.filter((suggestion) => suggestion.instrumentId === instrumentId)
  if (!sameInstrument.length || new Set(sameInstrument.map((candidate) => candidate.id)).size !== sameInstrument.length
    || new Set(sameInstrument.map((candidate) => candidate.orderId)).size !== sameInstrument.length) return false
  const local = signedPosition(built.input.local.positions, instrumentId)
  const venue = signedPosition(built.input.venue.positions, instrumentId)
  if (!local.valid || !venue.valid || local.direction !== 0 && venue.direction !== 0 && local.direction !== venue.direction) return false
  let candidateNet = d.ZERO
  for (const candidate of sameInstrument) {
    const size = exactNonnegativeDecimal(candidate.size)
    if (size === undefined || d.eq(size, d.ZERO)) return false
    candidateNet = d.add(candidateNet, candidate.side === 'buy' ? size : d.neg(size))
  }
  return d.eq(d.add(local.net, candidateNet), venue.net)
}

function blockersExplained(built: BuiltReconciliation): boolean {
  const candidates = validCandidates(built)
  return built.report.findings.filter((finding) => finding.severity === 'blocker').every((finding) => {
    if (finding.code === 'fill_missing_inferred') return validCandidateForFinding(built, finding) !== undefined
    if (finding.code === 'local_open_venue_filled' || finding.code === 'local_open_venue_partially_recorded') {
      return orderHistoryExplainsCandidate(built, finding, candidates)
    }
    return positionDifferenceExplained(built, finding, candidates)
  })
}

export class ReconcileService {
  private readonly states = new Map<string, AccountState>()
  private readonly running = new Set<string>()
  private readonly nativePending = new Set<string>()
  private readonly lastStarted = new Map<string, number>()
  private readonly noticeIdentity = new Map<string, { accountId: string; findingId: string; noticeId: string }>()
  private readonly noticeQueues = new Map<string, string[]>()
  private readonly activeNoticeIds = new Set<string>()
  private stopped = false
  private scanning = false
  private activeWrapper?: string
  private readonly abort = new AbortController()

  constructor(private readonly x: ReconcileServiceDeps) {}

  async confirm(input: ReconcileConfirmInput, actor: ActorCtx): Promise<ReconcileConfirmResult> {
    if (!actor || actor.principal?.kind !== 'session') throw new KernelError(makeProblem('AUTH_FAILED', 'reconciliation confirmation requires a session'))
    assertProof(actor.proof, 'pin')
    if (!this.x.securityHealth().ok) throw new KernelError(makeProblem('STATE_FILE_CORRUPT', 'security state file is corrupt; restore the original file and restart'))
    const accepted = this.validateConfirmInput(input)
    const recorded = this.x.trading.lookupConfirmedFill(accepted)
    if (recorded) return recorded

    const account = this.x.accounts.get(accepted.accountId)
    if (this.stopped || this.activeWrapper !== undefined || this.running.has(account.accountId) || this.nativePending.has(account.accountId) || this.x.startupBusy(account.accountId)) {
      throw new KernelError(makeProblem('BUSY', 'reconciliation capture is already running for this account'))
    }
    const state = this.states.get(account.accountId)
    if (this.x.trading.confirmationPending(account.accountId) || this.x.trading.lateRealEvidencePending(account.accountId)) {
      this.clearOffer(account, state?.view, this.x.clock.now())
      this.publishSafetyMarkers(account)
      throw new KernelError(makeProblem('INVALID_PARAMS', 'reconciliation requires human review before a new confirmation'))
    }

    const offer = state?.privateOffer
    const selected = offer?.candidates.get(accepted.suggestionId)
    const selectedReview = selected && this.validInferenceReview(account.accountId, selected)
    const securityNow = this.x.securityNow()
    const elapsed = offer ? securityNow - offer.securityAt : -1
    if (!offer || state?.view.state !== 'ready' || !state.view.reportId
      || state.view.offerId !== accepted.offerId || offer.offerId !== accepted.offerId || offer.reportId !== accepted.reportId
      || state.view.reportId !== accepted.reportId || !selected || !selectedReview
      || !Number.isSafeInteger(securityNow) || elapsed < 0 || elapsed > 30_000) {
      this.clearOffer(account, state?.view, this.x.clock.now())
      throw new KernelError(makeProblem('INVALID_PARAMS', 'the reconciliation offer changed or expired; refresh the account and review it again'))
    }
    const last = this.lastStarted.get(account.accountId)
    if (last === undefined || securityNow - last < MIN_INTERVAL_MS) {
      throw new KernelError(makeProblem('BUSY', 'reconciliation refresh is available after the per-account interval'))
    }

    const work: ConfirmWork = { input: accepted, actor, offer }
    await this.scanAccount(account.accountId, false, work)
    if (!work.result) throw new KernelError(makeProblem('BUSY', 'the reconciliation confirmation was stopped before commit'))
    return work.result
  }

  async resolve(inputValue: ReconcileResolutionInput, actor: ActorCtx): Promise<ReconcileResolveResult> {
    if (!actor || actor.principal?.kind !== 'session') throw new KernelError(makeProblem('AUTH_FAILED', 'reconciliation resolution requires a session'))
    assertProof(actor.proof, 'pin')
    if (!this.x.securityHealth().ok) throw new KernelError(makeProblem('STATE_FILE_CORRUPT', 'security state file is corrupt; restore the original file and restart'))
    const checked = validateReconcileResolutionInput(inputValue)
    if (!checked.ok || checked.value.reason.trim().length === 0) throw new KernelError(makeProblem('INVALID_PARAMS', 'resolution input is invalid'))
    const input = checked.value
    const account = this.x.accounts.get(input.accountId)
    const prior = this.x.trading.reconcileReviews.lookup(input)
    if (prior) return prior
    if (this.stopped) throw new KernelError(makeProblem('BUSY', 'reconciliation service is stopped'))
    this.x.trading.recoveryReviews(account.accountId)
    const result = this.x.trading.reconcileReviews.resolve(input, actor.origin)
    const previous = this.states.get(account.accountId)
    const next = this.get(account.accountId)[0]
    if (next) {
      if (input.action === 'reject') this.clearOffer(account, next, this.x.clock.now())
      else {
        this.states.set(account.accountId, { ...(previous ?? { nextHistoryCursor: 0 }), view: next })
        this.publishView(account.accountId, previous?.view, next)
      }
    }
    return result
  }

  private validateConfirmInput(value: unknown): ReconcileConfirmInput {
    const fields = ['accountId', 'offerId', 'reportId', 'suggestionId', 'fee', 'feeCcy', 'liquidity', 'realizedPnl'] as const
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new KernelError(makeProblem('INVALID_PARAMS', 'confirmation input must be an object'))
    const input = value as Record<string, unknown>
    if (Object.keys(input).length !== fields.length || Object.keys(input).some((key) => !(fields as readonly string[]).includes(key))) {
      throw new KernelError(makeProblem('INVALID_PARAMS', 'confirmation requires exactly the eight reconciliation input fields'))
    }
    for (const field of fields) if (typeof input[field] !== 'string' || input[field] === '') throw new KernelError(makeProblem('INVALID_PARAMS', `${field} is required`))
    const rawFee = input.fee as string
    const rawRealizedPnl = input.realizedPnl as string
    let fee: ReconcileConfirmInput['fee']
    let realizedPnl: ReconcileConfirmInput['realizedPnl']
    try {
      fee = asDecimal(rawFee)
      realizedPnl = asDecimal(rawRealizedPnl)
      if (d.lt(d.D(fee), d.ZERO)) throw new KernelError(makeProblem('INVALID_PARAMS', 'fee must be non-negative'))
    }
    catch (error) { if (error instanceof KernelError) throw error; throw new KernelError(makeProblem('INVALID_PARAMS', 'fee and realizedPnl must be decimal strings')) }
    const feeCcy = input.feeCcy as string
    if (!/^[A-Z0-9]{1,20}$/.test(feeCcy)) throw new KernelError(makeProblem('INVALID_PARAMS', 'feeCcy must be 1-20 uppercase letters or digits'))
    if (input.liquidity !== 'maker' && input.liquidity !== 'taker') throw new KernelError(makeProblem('INVALID_PARAMS', 'liquidity must be maker or taker'))
    return {
      accountId: input.accountId as ReconcileConfirmInput['accountId'], offerId: input.offerId as string,
      reportId: input.reportId as string, suggestionId: input.suggestionId as string, fee, feeCcy,
      liquidity: input.liquidity, realizedPnl,
    }
  }

  get(accountId?: string): ReconcileAccountView[] {
    const accounts = accountId ? this.x.accounts.list().filter((a) => a.accountId === accountId) : this.x.accounts.list()
    const healthy = this.x.securityHealth().ok
    return accounts.map((a) => {
      const view = structuredClone(this.states.get(a.accountId)?.view ?? { accountId: a.accountId, state: 'idle', findings: [], suggestions: [] } as ReconcileAccountView)
      let reviews: ReconcileReviewItem[]
      try {
        this.x.trading.recoveryReviews(a.accountId)
        reviews = this.x.trading.reconcileReviews.list(a.accountId)
      } catch {
        const corrupt: ReconcileAccountView = { ...view, accountId: a.accountId as ReconcileAccountView['accountId'], state: 'unavailable', verdict: 'blocked',
          findings: view.findings.filter((finding) => finding.code !== CONFIRMATION_FINDING && finding.code !== LATE_REAL_FINDING),
          suggestions: [], reviews: [], offerId: undefined, problem: makeProblem('STATE_FILE_CORRUPT', 'reconciliation review state is corrupt') }
        const confirmationPending = this.x.trading.confirmationPending(a.accountId)
        const latePending = this.x.trading.lateRealEvidencePending(a.accountId)
        const safe = this.safetyCopy(a, corrupt, confirmationPending, latePending)
        return { ...safe, problem: makeProblem('STATE_FILE_CORRUPT', 'reconciliation review state is corrupt') }
      }
      view.reviews = reviews
      const pending = this.x.trading.confirmationPending(a.accountId)
      const latePending = this.x.trading.lateRealEvidencePending(a.accountId)
      const resolvedFindingIds = new Set(reviews
        .filter((review) => review.resolution !== undefined || review.confirmedFillId !== undefined)
        .map((review) => review.finding?.id)
        .filter((id): id is string => id !== undefined))
      view.findings = view.findings.filter((finding) => !resolvedFindingIds.has(finding.id)
        && (pending || finding.code !== CONFIRMATION_FINDING)
        && (latePending || finding.code !== LATE_REAL_FINDING))
      const unresolvedBlocking = reviews.some((review) => review.blocking
        && review.resolution === undefined && review.confirmedFillId === undefined)
      const resolvedSafetyProblem = !pending && !latePending && !unresolvedBlocking
        && (view.problem?.message === 'reconciliation requires human review'
          || view.problem?.message === 'confirmation follow-up requires human review')
      if (resolvedSafetyProblem) {
        view.state = 'idle'
        view.suggestions = []
        delete view.offerId
        delete view.problem
      }
      if (unresolvedBlocking || view.findings.some((finding) => finding.severity === 'blocker')) view.verdict = 'blocked'
      else if (!view.problem && (view.state !== 'unavailable' || resolvedSafetyProblem)) {
        view.verdict = view.findings.some((finding) => finding.severity === 'warn') ? 'attention' : 'clean'
      }
      const safeView = healthy ? view : this.unavailableCopy(view)
      return this.safetyCopy(a, safeView, pending, latePending)
    })
  }

  /** Reassert pending confirmation halts before startup begins any other work. */
  initialize(): void {
    if (!this.x.securityHealth().ok) return
    for (const account of this.x.accounts.list()) this.publishSafetyMarkers(account)
  }

  async refresh(accountId: string): Promise<ReconcileAccountView> {
    const account = this.x.accounts.get(accountId)
    const securityNow = this.monotonicNow(accountId)
    const last = this.lastStarted.get(accountId)
    if (this.stopped || this.activeWrapper !== undefined || this.running.has(accountId) || this.nativePending.has(accountId) || this.x.startupBusy(accountId)) {
      throw new KernelError(makeProblem('BUSY', 'reconciliation capture is already running for this account'))
    }
    if (last !== undefined && securityNow - last < MIN_INTERVAL_MS) throw new KernelError(makeProblem('BUSY', 'reconciliation refresh is available after the per-account interval'))
    return this.scanAccount(account.accountId, false)
  }

  async tick(): Promise<void> {
    if (this.stopped || this.scanning || this.activeWrapper !== undefined) return
    this.scanning = true
    try {
      const now = this.monotonicNow()
      for (const account of this.x.accounts.list()) {
        if (this.stopped) return
        if (account.status !== 'active' || this.x.startupBusy(account.accountId) || this.nativePending.has(account.accountId) || this.running.has(account.accountId)) continue
        if (this.holdsOriginalReviewWindow(account.accountId)) continue
        const started = this.lastStarted.get(account.accountId)
        if (started !== undefined && now - started < MIN_INTERVAL_MS) continue
        await this.scanAccount(account.accountId, false)
      }
    } finally { this.scanning = false }
  }

  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    this.abort.abort()
    const deadline = Date.now() + 250
    while (this.running.size > 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10))
  }

  private async scanAccount(accountId: string, startup: boolean, confirming?: ConfirmWork): Promise<ReconcileAccountView> {
    const account = this.x.accounts.get(accountId)
    if (this.stopped) return this.stoppedCopy(this.states.get(accountId)?.view ?? errorView(accountId))
    if (this.activeWrapper !== undefined || this.running.has(accountId) || this.nativePending.has(accountId) || (!startup && this.x.startupBusy(accountId))) {
      throw new KernelError(makeProblem('BUSY', 'reconciliation capture is already running for this account'))
    }
    this.running.add(accountId)
    this.activeWrapper = accountId
    const startedAt = this.x.clock.now()
    const securityNow = this.monotonicNow(accountId)
    const deadlineAt = Date.now() + ROUND_DEADLINE_MS
    this.lastStarted.set(accountId, securityNow)
    const before = this.states.has(accountId) ? structuredClone(this.states.get(accountId)!.view) : undefined
    this.updateState(accountId, { ...(before ?? { accountId: account.accountId, findings: [], suggestions: [] }), state: 'running', lastAttemptAt: startedAt })
    try {
      const health = this.x.securityHealth()
      if (!health.ok) {
        if (confirming) throw new KernelError(makeProblem('STATE_FILE_CORRUPT', 'security state file is corrupt; restore the original file and restart'))
        return this.fail(accountId, before, startedAt)
      }
      if (this.x.trading.confirmationPending(accountId) || this.x.trading.lateRealEvidencePending(accountId)) {
        const marked = this.publishSafetyMarkers(account)
        if (confirming) throw new KernelError(makeProblem('INVALID_PARAMS', 'reconciliation requires human review before a new confirmation'))
        return marked ?? this.fail(accountId, before, startedAt)
      }
      const firstOrders = this.x.orders.forPolling(accountId, 0)
      const initialAliases = new Map<string, readonly string[]>()
      for (const order of firstOrders) {
        const record = this.x.docs.get<OrderRecordView>('order-record', order.orderId)
        if (record?.supersededVenueOrderIds) initialAliases.set(order.orderId, record.supersededVenueOrderIds)
      }
      const snapshotPromise = this.trackNative(accountId, () => this.x.bus.observeSnapshot(account, startedAt - VENUE_LOOKBACK_MS))
      const snapshot = await this.withDeadline(snapshotPromise, deadlineAt, this.abort.signal)
      if (this.stopped) return confirming ? this.stopConfirmation(account, before, startedAt) : this.stoppedCopy(before ?? errorView(accountId))
      if (snapshot === DEADLINE || !snapshot) {
        if (confirming) throw new KernelError(makeProblem('VENUE_OUTCOME_UNKNOWN', 'fresh reconciliation evidence is unavailable'))
        return this.fail(accountId, before, startedAt)
      }
      const snapshotObservedAt = this.x.clock.now()
      const openIdentities = new Set<string>()
      for (const row of snapshot.openOrders) {
        if (row.clientOrderId) openIdentities.add(`c:${row.clientOrderId}`)
        openIdentities.add(`v:${row.venueOrderId}`)
      }
      const historyOrders = firstOrders.filter((order) => {
        const identities = [...(order.venueOrderId ? [order.venueOrderId] : []), ...(initialAliases.get(order.orderId) ?? [])]
        return !openIdentities.has(`c:${order.clientOrderId}`) && !identities.some((id) => openIdentities.has(`v:${id}`))
      })
      const startCursor = historyOrders.length ? (this.states.get(accountId)?.nextHistoryCursor ?? 0) % historyOrders.length : 0
      const regularSelection = Array.from({ length: Math.min(HISTORY_LIMIT, historyOrders.length) }, (_, i) => historyOrders[(startCursor + i) % historyOrders.length]!)
      const targetOrderId = confirming?.offer.candidates.get(confirming.input.suggestionId)?.suggestion.orderId
      const priority = targetOrderId ? historyOrders.find((order) => order.orderId === targetOrderId) : undefined
      const selected = priority
        ? [priority, ...regularSelection.filter((order) => order.orderId !== priority.orderId)].slice(0, HISTORY_LIMIT)
        : regularSelection
      const observations: ReconcileOrderObservation[] = []
      for (const order of selected) {
        if (this.stopped || this.abort.signal.aborted) return confirming ? this.stopConfirmation(account, before, startedAt) : this.stoppedCopy(before ?? errorView(accountId))
        const pending = this.trackNative(accountId, () => this.x.bus.lookup(account, order.clientOrderId, {
          instrumentId: order.instrumentId, ...(order.venueOrderId ? { venueOrderId: order.venueOrderId } : {}), observeOnly: true,
        }))
        const result = await this.withDeadline(pending, deadlineAt, this.abort.signal)
        if (this.stopped) return confirming ? this.stopConfirmation(account, before, startedAt) : this.stoppedCopy(before ?? errorView(accountId))
        if (result === DEADLINE) {
          if (confirming) throw new KernelError(makeProblem('VENUE_OUTCOME_UNKNOWN', 'fresh reconciliation evidence is unavailable'))
          return this.fail(accountId, before, startedAt)
        }
        observations.push({ orderId: order.orderId, observedAt: this.x.clock.now(), result: result ? {
          status: result.status, ...(result.venueOrderId ? { venueOrderId: result.venueOrderId } : {}),
          ...(result.filledSize ? { filledSize: result.filledSize } : {}), ...(result.avgFillPrice ? { avgFillPrice: result.avgFillPrice } : {}),
        } : null })
      }
      if (this.stopped || this.abort.signal.aborted) return confirming ? this.stopConfirmation(account, before, startedAt) : this.stoppedCopy(before ?? errorView(accountId))
      if (!this.x.securityHealth().ok) {
        if (confirming) throw new KernelError(makeProblem('STATE_FILE_CORRUPT', 'security state file is corrupt; restore the original file and restart'))
        return this.fail(accountId, before, startedAt)
      }
      const capturedAt = this.x.clock.now()
      const orders = this.x.orders.forPolling(accountId, 0)
      const fills = this.x.orders.fillsSince(accountId, 0)
      const orderAliases = new Map<string, readonly string[]>()
      const orderMarginModes = new Map<string, 'cross' | 'isolated'>()
      for (const order of orders) {
        const record = this.x.docs.get<OrderRecordView>('order-record', order.orderId)
        if (record?.supersededVenueOrderIds) orderAliases.set(order.orderId, record.supersededVenueOrderIds)
        if (record?.intent?.marginMode) orderMarginModes.set(order.orderId, record.intent.marginMode)
      }
      const currentHistoryOrders = orders.filter((order) => {
        const identities = [...(order.venueOrderId ? [order.venueOrderId] : []), ...(orderAliases.get(order.orderId) ?? [])]
        return !openIdentities.has(`c:${order.clientOrderId}`) && !identities.some((id) => openIdentities.has(`v:${id}`))
      })
      const currentHistoryIds = new Set(currentHistoryOrders.map((order) => order.orderId))
      const built = buildReconcileView({
        accountId: accountId as ReconcileAccountView['accountId'], orders, fills, orderAliases, orderMarginModes,
        snapshot, snapshotObservedAt, historyOrderIds: currentHistoryOrders.map((order) => order.orderId), observations: observations.filter((observation) => currentHistoryIds.has(observation.orderId)),
        unavailable: snapshot.fillsSince > 0 ? ['fills'] : [], now: capturedAt,
      })
      const capturedReviews = this.captureReviews(accountId, built, orders, snapshotObservedAt)
      built.view.reviews = capturedReviews
      built.view.suggestions = built.view.suggestions.filter((suggestion) => {
        const order = orders.find((candidate) => candidate.orderId === suggestion.orderId && candidate.accountId === accountId)
        if (!order) return false
        const localFillsDigest = digestOf(this.x.orders.fillsForOrder(accountId, order.orderId))
        return !capturedReviews.some((item) => item.kind === 'inferred_fill' && item.resolution?.input.action === 'reject'
          && item.evidenceDigest === digestOf([accountId, 'inferred_fill', true, { candidateDigest: reconcileCandidateDigest(suggestion), localFillsDigest }]))
      })
      if (this.x.trading.confirmationPending(accountId)) {
        this.assertConfirmationHalt(account)
        if (confirming) throw new KernelError(makeProblem('INVALID_PARAMS', 'reconciliation requires human review before a new confirmation'))
        return this.publishConfirmationPending(account)
      }
      if (this.x.trading.lateRealEvidencePending(accountId)) {
        this.assertLateRealHalt(account)
        const marked = this.publishSafetyMarkers(account)
        if (confirming) throw new KernelError(makeProblem('INVALID_PARAMS', 'reconciliation requires human review before a new confirmation'))
        return marked ?? this.fail(accountId, before, startedAt)
      }
      if (confirming) {
        const capture: CaptureForConfirmation = {
          snapshot, snapshotObservedAt, observations, orders, fills, built, orderAliases, orderMarginModes,
          historyOrderIds: currentHistoryOrders.map((order) => order.orderId), nextHistoryCursor: historyOrders.length ? (startCursor + selected.length) % historyOrders.length : 0,
          startedAt,
        }
        const view = this.commitConfirmation(account, confirming, capture)
        if (this.stopped) return this.stoppedCopy(view)
        this.states.set(accountId, {
          view, nextHistoryCursor: capture.nextHistoryCursor,
          privateOfferAt: undefined, privateOffer: undefined,
        })
        this.publishView(accountId, before, view)
        this.publishNextNotice(account, view.findings)
        return structuredClone(view)
      }
      const view = this.withOffer(accountId, built.view, securityNow)
      view.lastAttemptAt = startedAt
      view.lastSuccessAt = capturedAt
      const previous = this.states.get(accountId)
      const privateOfferAt = view.offerId && previous?.view.offerId === view.offerId ? previous.privateOfferAt : (view.offerId ? securityNow : undefined)
      const privateOffer = this.capturePrivateOffer(accountId, view, orders, securityNow, previous?.privateOffer)
      const state: AccountState = { view, privateOfferAt, privateOffer, nextHistoryCursor: historyOrders.length ? (startCursor + selected.length) % historyOrders.length : 0 }
      this.states.set(accountId, state)
      this.publishView(accountId, before, view)
      this.publishNextNotice(account, view.findings)
      return structuredClone(view)
    } catch (error) {
      if (confirming) {
        if (confirming.result) {
          if (!this.stopped) {
            this.x.log?.('reconciliation confirmation committed; status projection unavailable')
            try { return this.fail(accountId, before, startedAt) } catch { /* the committed result remains authoritative */ }
          }
          return this.stoppedCopy(before ?? errorView(accountId))
        }
        this.clearOffer(account, this.states.get(accountId)?.view ?? before, this.x.clock.now())
        throw error
      }
      return this.stopped ? this.stoppedCopy(before ?? errorView(accountId)) : this.fail(accountId, before, startedAt, error)
    } finally { this.running.delete(accountId); if (this.activeWrapper === accountId) this.activeWrapper = undefined }
  }

  private capturePrivateOffer(accountId: string, view: ReconcileAccountView, orders: ReturnType<OrderStore['forPolling']>, securityAt: number, prior?: PrivateOffer): PrivateOffer | undefined {
    if (!view.offerId || !view.reportId) return undefined
    if (prior?.offerId === view.offerId && prior.reportId === view.reportId) return prior
    const candidates = new Map<string, PrivateCandidate>()
    for (const suggestion of view.suggestions) {
      const order = orders.find((candidate) => candidate.orderId === suggestion.orderId && candidate.accountId === accountId)
      if (!order) continue
      const fillsDigest = digestOf(this.x.orders.fillsForOrder(accountId, order.orderId))
      const review = this.x.trading.reconcileReviews.list(accountId).find((item) => item.kind === 'inferred_fill'
        && item.localFillsDigest === fillsDigest && item.evidenceDigest === digestOf([accountId, 'inferred_fill', true,
          { candidateDigest: reconcileCandidateDigest(suggestion), localFillsDigest: fillsDigest }])
        && item.resolution === undefined && item.confirmedFillId === undefined)
      if (!review) continue
      candidates.set(suggestion.id, { suggestion: structuredClone(suggestion), fillsDigest, reviewItemId: review.itemId })
    }
    return { offerId: view.offerId, reportId: view.reportId, securityAt, candidates }
  }

  private validInferenceReview(accountId: string, candidate: PrivateCandidate): ReconcileReviewItem | undefined {
    const item = this.x.trading.reconcileReviews.get(accountId, candidate.reviewItemId)
    if (!item || item.kind !== 'inferred_fill' || item.resolution !== undefined || item.confirmedFillId !== undefined
      || item.localFillsDigest !== candidate.fillsDigest || !item.suggestion
      || reconcileCandidateDigest(item.suggestion) !== reconcileCandidateDigest(candidate.suggestion)) return undefined
    return item
  }

  private captureReviews(accountId: string, built: BuiltReconciliation, orders: ReturnType<OrderStore['forPolling']>, observedAt: number): ReconcileReviewItem[] {
    const seeds: ReviewSeed[] = []
    for (const suggestion of built.view.suggestions) {
      const order = orders.find((candidate) => candidate.orderId === suggestion.orderId && candidate.accountId === accountId)
      if (!order) continue
      seeds.push({ accountId: accountId as ReconcileReviewItem['accountId'], kind: 'inferred_fill', observedAt,
        summary: `Unrecorded fill candidate ${suggestion.id} for local order ${suggestion.orderId}.`, blocking: true,
        suggestion, localFillsDigest: digestOf(this.x.orders.fillsForOrder(accountId, order.orderId)) })
    }
    for (const finding of built.report.findings) {
      if (!finding.advice.requiresHuman) continue
      if (validCandidateForFinding(built, finding)) continue
      const stableEvidence = finding.evidence.filter((evidence) => evidence.field !== 'ageMs')
      const viewId = `rcf_${digestOf({ code: finding.code, severity: finding.severity, subject: finding.subject,
        advice: finding.advice, evidence: stableEvidence }).slice('sha256:'.length)}`
      const viewFinding = built.view.findings.find((candidate) => candidate.id === viewId)
      if (!viewFinding) continue
      seeds.push({ accountId: accountId as ReconcileReviewItem['accountId'], kind: 'known_difference', observedAt,
        summary: finding.detail, blocking: finding.severity === 'blocker', finding: viewFinding })
    }
    for (const seed of seeds) this.x.trading.reconcileReviews.record(seed)
    return this.x.trading.reconcileReviews.list(accountId)
  }

  private clearOffer(account: Account, source?: ReconcileAccountView, attemptedAt?: number): void {
    if (this.stopped) return
    const previous = this.states.get(account.accountId)
    const view: ReconcileAccountView = structuredClone(source ?? previous?.view ?? { accountId: account.accountId as ReconcileAccountView['accountId'], state: 'idle', findings: [], suggestions: [] })
    delete view.offerId
    view.suggestions = []
    if (attemptedAt !== undefined) view.lastAttemptAt = attemptedAt
    this.states.set(account.accountId, {
      view, nextHistoryCursor: previous?.nextHistoryCursor ?? 0,
      privateOfferAt: undefined, privateOffer: undefined,
    })
    this.publishView(account.accountId, previous?.view, view)
  }

  private stopConfirmation(account: Account, prior: ReconcileAccountView | undefined, attemptedAt: number): ReconcileAccountView {
    const view = this.stoppedCopy(prior ?? errorView(account.accountId))
    delete view.offerId
    view.suggestions = []
    view.lastAttemptAt = attemptedAt
    this.clearOffer(account, view, attemptedAt)
    return structuredClone(this.states.get(account.accountId)?.view ?? view)
  }

  private commitConfirmation(account: Account, work: ConfirmWork, capture: CaptureForConfirmation): ReconcileAccountView {
    const { input, offer } = work
    const currentSecurityAt = this.x.securityNow()
    const original = offer.candidates.get(input.suggestionId)
    const originalReview = original && this.validInferenceReview(account.accountId, original)
    const current = capture.built.view.suggestions.find((suggestion) => suggestion.id === input.suggestionId)
    const order = original && capture.orders.find((candidate) => candidate.orderId === original.suggestion.orderId && candidate.accountId === account.accountId)
    const targetObservation = original && capture.observations.find((observation) => observation.orderId === original.suggestion.orderId)
    const currentFillsDigest = order ? digestOf(this.x.orders.fillsForOrder(account.accountId, order.orderId)) : undefined
    const coverage = capture.built.view.coverage
    const validFillWindow = Number.isSafeInteger(capture.snapshot.fillsSince) && capture.snapshot.fillsSince >= 0
    const fillWindowShortened = !validFillWindow || capture.snapshot.fillsSince > capture.startedAt - VENUE_LOOKBACK_MS
    const unusableCoverage = !coverage || coverage.truncated || !Array.isArray(capture.snapshot.account.positions)
      || fillWindowShortened || coverage.unavailable.some((source) => ['positions', 'openOrders'].includes(source))
    const invalidCapture = this.stopped || this.abort.signal.aborted || !this.x.securityHealth().ok
      || this.x.trading.confirmationPending(account.accountId) || this.x.trading.lateRealEvidencePending(account.accountId)
      || !original || !originalReview || !current || !order
      || capture.built.view.state !== 'ready'
      || unusableCoverage || reconcileCandidateDigest(original.suggestion) !== reconcileCandidateDigest(current)
      || original.fillsDigest !== currentFillsDigest
      || !Number.isSafeInteger(currentSecurityAt) || currentSecurityAt < offer.securityAt || currentSecurityAt - offer.securityAt > 30_000
      || !Number.isSafeInteger(offer.securityAt) || input.offerId !== offer.offerId || input.reportId !== offer.reportId
      || input.suggestionId !== original.suggestion.id
    if (invalidCapture) {
      if (!this.x.securityHealth().ok) throw new KernelError(makeProblem('STATE_FILE_CORRUPT', 'security state file is corrupt; restore the original file and restart'))
      if (this.x.trading.confirmationPending(account.accountId) || this.x.trading.lateRealEvidencePending(account.accountId)) {
        this.publishSafetyMarkers(account)
        throw new KernelError(makeProblem('INVALID_PARAMS', 'reconciliation requires human review before a new confirmation'))
      }
      throw new KernelError(makeProblem('INVALID_PARAMS', 'the reconciliation offer changed or expired; refresh the account and review it again'))
    }
    if (!blockersExplained(capture.built)) {
      this.clearOffer(account, capture.built.view, capture.startedAt)
      throw new KernelError(makeProblem('INVALID_PARAMS', 'reconciliation requires human review before a new confirmation'))
    }
    const openTarget = capture.snapshot.openOrders.some((row) => row.venueOrderId === original.suggestion.venueOrderId
      && row.clientOrderId === original.suggestion.clientOrderId && row.instrumentId === original.suggestion.instrumentId)
    if (!openTarget && (!targetObservation || !targetObservation.result)) {
      throw new KernelError(makeProblem('INVALID_PARAMS', 'the reconciliation offer changed or expired; refresh the account and review it again'))
    }
    const suggestion = original.suggestion
    const fill: Fill = {
      fillId: newId('fill') as Fill['fillId'], orderId: suggestion.orderId, clientOrderId: suggestion.clientOrderId,
      venueFillId: `inferred_${digestOf([account.accountId, suggestion.id]).slice('sha256:'.length)}`,
      accountId: account.accountId as Fill['accountId'], instrumentId: suggestion.instrumentId, side: suggestion.side,
      price: suggestion.price, size: suggestion.size, fee: input.fee as Fill['fee'], feeCcy: input.feeCcy,
      liquidity: input.liquidity, realizedPnl: input.realizedPnl as Fill['realizedPnl'], ts: suggestion.ts,
      inferred: {
        suggestionId: suggestion.id, reportId: offer.reportId, confirmedAt: currentSecurityAt,
        confirmedBy: work.actor.origin.actor, priceSource: suggestion.priceSource, basisDigest: digestOf(suggestion.basis),
      },
    }
    if (this.stopped || this.abort.signal.aborted || !this.x.securityHealth().ok
      || this.x.trading.confirmationPending(account.accountId) || this.x.trading.lateRealEvidencePending(account.accountId)) {
      if (!this.x.securityHealth().ok) throw new KernelError(makeProblem('STATE_FILE_CORRUPT', 'security state file is corrupt; restore the original file and restart'))
      if (this.x.trading.confirmationPending(account.accountId) || this.x.trading.lateRealEvidencePending(account.accountId)) {
        this.publishSafetyMarkers(account)
        throw new KernelError(makeProblem('INVALID_PARAMS', 'reconciliation requires human review before a new confirmation'))
      }
      throw new KernelError(makeProblem('BUSY', 'reconciliation confirmation was stopped before commit'))
    }
    work.result = this.x.trading.applyConfirmedFill(fill, work.actor.origin, input, original.reviewItemId)
    const afterOrders = this.x.orders.forPolling(account.accountId, 0)
    const afterFills = this.x.orders.fillsSince(account.accountId, 0)
    const after = buildReconcileView({
      accountId: account.accountId as ReconcileAccountView['accountId'], orders: afterOrders, fills: afterFills,
      orderAliases: capture.orderAliases, orderMarginModes: capture.orderMarginModes,
      snapshot: capture.snapshot, snapshotObservedAt: capture.snapshotObservedAt,
      historyOrderIds: capture.historyOrderIds, observations: capture.observations,
      unavailable: capture.snapshot.fillsSince > 0 ? ['fills'] : [], now: this.x.clock.now(),
    }).view
    after.lastAttemptAt = capture.startedAt
    after.lastSuccessAt = this.x.clock.now()
    if (this.x.trading.confirmationPending(account.accountId) || this.x.trading.lateRealEvidencePending(account.accountId)) {
      this.assertConfirmationHalt(account)
      if (this.x.trading.lateRealEvidencePending(account.accountId)) this.assertLateRealHalt(account)
      return this.publishSafetyMarkers(account) ?? after
    }
    return this.withoutConfirmationOffer(after)
  }

  private withoutConfirmationOffer(view: ReconcileAccountView): ReconcileAccountView {
    const next = structuredClone(view)
    delete next.offerId
    return next
  }

  private async withDeadline<T>(promise: Promise<T>, deadlineAt: number, signal: AbortSignal): Promise<T | typeof DEADLINE> {
    const remaining = Math.max(0, deadlineAt - Date.now())
    let timer: ReturnType<typeof setTimeout> | undefined
    let abortListener: (() => void) | undefined
    const timeout = new Promise<typeof DEADLINE>((resolve) => {
      timer = setTimeout(() => resolve(DEADLINE), remaining)
      abortListener = () => resolve(DEADLINE)
      signal.addEventListener('abort', abortListener, { once: true })
      if (signal.aborted) resolve(DEADLINE)
    })
    try { return await Promise.race([promise, timeout]) }
    finally { if (timer) clearTimeout(timer); if (abortListener) signal.removeEventListener('abort', abortListener) }
  }

  private trackNative<T>(accountId: string, start: () => Promise<T>): Promise<T> {
    this.nativePending.add(accountId)
    let native: Promise<T>
    try { native = start() } catch (error) { this.nativePending.delete(accountId); return Promise.reject(error) }
    return Promise.resolve(native).then((value) => { this.nativePending.delete(accountId); return value }, (error: unknown) => { this.nativePending.delete(accountId); throw error })
  }

  private fail(accountId: string, prior?: ReconcileAccountView, attemptedAt?: number, cause?: unknown): ReconcileAccountView {
    if (this.stopped) return this.stoppedCopy(prior ?? errorView(accountId))
    const view = errorView(accountId, prior, cause)
    if (attemptedAt !== undefined) view.lastAttemptAt = attemptedAt
    const priorState = this.states.get(accountId)
    this.states.set(accountId, { view, privateOfferAt: undefined, privateOffer: undefined, nextHistoryCursor: priorState?.nextHistoryCursor ?? 0 })
    this.publishView(accountId, prior, view)
    return structuredClone(view)
  }

  private withOffer(accountId: string, source: ReconcileAccountView, securityNow: number): ReconcileAccountView {
    const previous = this.states.get(accountId)
    const view = structuredClone(source)
    if (view.state !== 'ready' || view.suggestions.length === 0 || view.findings.some((finding) => finding.code === CONFIRMATION_FINDING)) {
      delete view.offerId
      if (previous) previous.privateOfferAt = undefined
      return view
    }
    const expired = previous?.privateOfferAt === undefined || (securityNow >= previous.privateOfferAt && securityNow - previous.privateOfferAt > 30_000)
    const sameReport = previous?.view.reportId === view.reportId
    if (sameReport && !expired && previous?.view.offerId) {
      view.offerId = previous.view.offerId
      if (previous.privateOffer?.offerId === view.offerId && previous.privateOffer.reportId === view.reportId) {
        view.suggestions = [...previous.privateOffer.candidates.values()].map((candidate) => structuredClone(candidate.suggestion))
      }
    } else {
      view.offerId = `rco_${randomUUID().replaceAll('-', '')}`
    }
    return view
  }

  private updateState(accountId: string, view: ReconcileAccountView): void {
    const previous = this.states.get(accountId)
    this.states.set(accountId, { view, nextHistoryCursor: previous?.nextHistoryCursor ?? 0, privateOfferAt: previous?.privateOfferAt, privateOffer: previous?.privateOffer })
  }

  private publishView(accountId: string, prior: ReconcileAccountView | undefined, view: ReconcileAccountView): void {
    const material = (value: ReconcileAccountView | undefined): unknown => value && ({
      accountId: value.accountId, state: value.state, reportId: value.reportId, verdict: value.verdict, offerId: value.offerId,
      problemCode: value.problem?.name,
      coverage: value.coverage && { truncated: value.coverage.truncated, unavailable: value.coverage.unavailable,
        historyChecked: value.coverage.historyChecked, historyTotal: value.coverage.historyTotal },
      findings: value.findings.map((finding) => finding.id), suggestions: value.suggestions.map((suggestion) => suggestion.id),
      reviews: (value.reviews ?? []).map((item) => [item.itemId, item.resolution?.resolutionId, item.confirmedFillId]),
    })
    if (JSON.stringify(material(prior)) !== JSON.stringify(material(view))) this.x.events.publish('reconciliation.updated', { accountId, view: structuredClone(view) })
  }

  private publishNextNotice(account: Account, findings: readonly ReconcileFindingView[]): void {
    const prefix = `${account.accountId}\u0000`
    const next = new Set(findings.filter((finding) => finding.advice.requiresHuman).map((finding) => `${prefix}${finding.id}`))
    for (const key of this.activeNoticeIds) if (key.startsWith(prefix) && !next.has(key)) {
      this.activeNoticeIds.delete(key)
      this.noticeIdentity.delete(key)
    }
    for (const finding of findings) {
      if (!finding.advice.requiresHuman) continue
      const identityKey = `${prefix}${finding.id}`
      this.activeNoticeIds.add(identityKey)
      if (this.noticeIdentity.has(identityKey)) continue
      const noticeId = `rcn_${randomUUID().replaceAll('-', '')}`
      this.noticeIdentity.set(identityKey, { accountId: account.accountId, findingId: finding.id, noticeId })
      const queue = this.noticeQueues.get(account.accountId) ?? []
      queue.push(identityKey)
      this.noticeQueues.set(account.accountId, queue)
    }
    const queue = this.noticeQueues.get(account.accountId) ?? []
    while (queue.length) {
      const key = queue.shift()!
      const entry = this.noticeIdentity.get(key)
      if (!entry) continue
      const target = this.x.accounts.find(entry.accountId)
      const finding = target?.accountId === account.accountId ? findings.find((candidate) => candidate.id === entry.findingId) : undefined
      if (!target || !finding) { this.noticeIdentity.delete(key); continue }
      const payload: ReconcileNoticeData = {
        noticeId: entry.noticeId, accountId: target.accountId as ReconcileNoticeData['accountId'], accountAlias: target.alias,
        findingId: finding.id, code: finding.code, severity: finding.severity, summary: finding.detail, why: finding.advice.why,
      }
      this.x.events.publish('reconciliation.notice', payload)
      break
    }
    this.noticeQueues.set(account.accountId, queue)
  }

  private assertConfirmationHalt(account: Account): void {
    if (!this.x.securityHealth().ok) return
    const origin = systemOrigin('reconcile:confirmation-pending')
    if (this.x.tstate.list().sticky.some((entry) => entry.scope.type === 'account' && entry.scope.id === account.accountId && entry.state === 'HALTED' && entry.reason === 'reconcile_confirmation_pending')) return
    try { this.x.tstate.set({ type: 'account', id: account.accountId }, 'HALTED', 'reconcile_confirmation_pending', origin) }
    catch { /* durable receipt/index remains the source of truth */ }
  }

  private assertLateRealHalt(account: Account): void {
    if (!this.x.securityHealth().ok) return
    const origin = systemOrigin('reconcile:late-real-evidence')
    if (this.x.tstate.list().sticky.some((entry) => entry.scope.type === 'account' && entry.scope.id === account.accountId && entry.state === 'HALTED' && entry.reason === 'reconcile_late_real_evidence')) return
    try { this.x.tstate.set({ type: 'account', id: account.accountId }, 'HALTED', 'reconcile_late_real_evidence', origin) }
    catch { /* durable late-evidence index remains the source of truth */ }
  }

  private safetyCopy(account: Account, prior: ReconcileAccountView, confirmationPending: boolean, latePending: boolean): ReconcileAccountView {
    if (!confirmationPending && !latePending) return prior
    const findings = prior.findings.filter((finding) => finding.code !== CONFIRMATION_FINDING && finding.code !== LATE_REAL_FINDING)
    if (confirmationPending) findings.push(fixedFinding(account.accountId))
    if (latePending) findings.push(fixedLateRealFinding(account.accountId))
    return {
      ...prior, accountId: account.accountId as ReconcileAccountView['accountId'], state: 'unavailable', verdict: 'blocked',
      findings, suggestions: [], offerId: undefined,
      problem: makeProblem('VENUE_OUTCOME_UNKNOWN', 'reconciliation requires human review'),
    }
  }

  private publishSafetyMarkers(account: Account): ReconcileAccountView | undefined {
    const confirmationPending = this.x.trading.confirmationPending(account.accountId)
    const latePending = this.x.trading.lateRealEvidencePending(account.accountId)
    if (!confirmationPending && !latePending) return undefined
    if (confirmationPending) this.assertConfirmationHalt(account)
    if (latePending) this.assertLateRealHalt(account)
    const previous = this.states.get(account.accountId)
    const source: ReconcileAccountView = previous?.view ?? { accountId: account.accountId as ReconcileAccountView['accountId'], state: 'idle', findings: [], suggestions: [] }
    const view = this.safetyCopy(account, source, confirmationPending, latePending)
    this.states.set(account.accountId, {
      view, nextHistoryCursor: previous?.nextHistoryCursor ?? 0,
      privateOfferAt: undefined, privateOffer: undefined,
    })
    this.publishView(account.accountId, previous?.view, view)
    this.publishNextNotice(account, view.findings)
    return structuredClone(view)
  }

  private publishConfirmationPending(account: Account): ReconcileAccountView {
    return this.publishSafetyMarkers(account) ?? this.pendingCopy(account, this.states.get(account.accountId)?.view ?? errorView(account.accountId))
  }

  private monotonicNow(accountId?: string): number {
    const now = this.x.securityNow()
    const last = accountId ? this.lastStarted.get(accountId) : undefined
    return last === undefined || now >= last ? now : last
  }

  private holdsOriginalReviewWindow(accountId: string): boolean {
    const state = this.states.get(accountId)
    const offer = state?.privateOffer
    const rawSecurityNow = this.x.securityNow()
    if (!offer || state?.view.state !== 'ready' || state.view.offerId !== offer.offerId
      || state.view.reportId !== offer.reportId || offer.candidates.size === 0
      || !Number.isSafeInteger(rawSecurityNow) || !Number.isSafeInteger(offer.securityAt)) return false
    const elapsed = rawSecurityNow - offer.securityAt
    if (elapsed < 0 || elapsed > 30_000 || !this.x.securityHealth().ok) return false
    return !this.x.trading.confirmationPending(accountId) && !this.x.trading.lateRealEvidencePending(accountId)
  }

  private pendingCopy(account: Account, prior: ReconcileAccountView): ReconcileAccountView {
    const findings = [...prior.findings.filter((finding) => finding.code !== CONFIRMATION_FINDING), fixedFinding(account.accountId)]
    return {
      ...prior, accountId: account.accountId as ReconcileAccountView['accountId'], state: 'unavailable', verdict: 'blocked',
      findings, suggestions: [], problem: makeProblem('VENUE_OUTCOME_UNKNOWN', 'confirmation follow-up requires human review'), offerId: undefined,
    }
  }

  private unavailableCopy(prior: ReconcileAccountView): ReconcileAccountView {
    return { ...prior, state: 'unavailable', verdict: 'blocked', suggestions: [], offerId: undefined,
      problem: makeProblem('STATE_FILE_CORRUPT', 'security state file is corrupt; restore the original file and restart') }
  }

  private stoppedCopy(prior: ReconcileAccountView): ReconcileAccountView {
    return { ...prior, state: 'unavailable', verdict: prior.verdict === 'blocked' ? 'blocked' : 'attention', suggestions: [], offerId: undefined,
      ...(prior.coverage ? { coverage: this.unavailableCoverage(prior.coverage) } : {}),
      problem: makeProblem('VENUE_OUTCOME_UNKNOWN', 'reconciliation capture stopped') }
  }

  private unavailableCoverage(prior: NonNullable<ReconcileAccountView['coverage']>): NonNullable<ReconcileAccountView['coverage']> {
    return { ...prior, unavailable: [...new Set([...prior.unavailable, 'openOrders', 'historyOrders', 'fills', 'positions'])] }
  }
}

