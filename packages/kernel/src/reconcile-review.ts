// SPDX-License-Identifier: CPAL-1.0
import type {
  Origin, ReconcileConfirmationReceipt, ReconcileResolutionInput, ReconcileResolutionReceipt,
  ReconcileResolveResult, ReconcileReviewItem, ReconcileSuggestion,
} from './proto'
import {
  makeProblem, validateFill, validateReconcileConfirmInput, validateReconcileFindingView,
  validateReconcileResolutionInput, validateReconcileResolutionReceipt, validateReconcileReviewItem,
  validateReconcileSuggestion,
} from './proto'
import { tx } from './db'
import type { Db, Docs } from './db'
import type { Ledger, LedgerDeferredEffects } from './ledger'
import type { Clock } from './util/clock'
import { KernelError } from './util/errors'
import { digestOf } from './util/hash'

const REVIEW_ITEMS = 'reconcile-review-item'
const RESOLUTION_RECEIPTS = 'reconcile-resolution-receipt'
const CORRUPT = 'reconciliation review state is corrupt'

export type ReviewSeed = Pick<ReconcileReviewItem,
  'accountId' | 'kind' | 'observedAt' | 'summary' | 'blocking' | 'finding' | 'suggestion' | 'localFillsDigest' | 'fill' | 'confirmation'>

export interface ReconcileReviewStoreDeps {
  db: Db
  docs: Docs
  ledger: Ledger
  clock: Clock
}

type ReviewKind = ReconcileReviewItem['kind']
type IdentitySource = Record<string, unknown>

const invalid = (message: string): never => { throw new KernelError(makeProblem('INVALID_PARAMS', message)) }
const corrupt = (): never => { throw new KernelError(makeProblem('STATE_FILE_CORRUPT', CORRUPT)) }
const clone = <T>(value: T): T => structuredClone(value)
function validated<T>(result: { ok: true; value: T } | { ok: false; issues: unknown }, message: string): T {
  return result.ok ? result.value : invalid(message)
}

function receiptId(accountId: string, requestId: string): string {
  return `rrr_${digestOf([accountId, requestId]).slice('sha256:'.length)}`
}

function same(a: unknown, b: unknown): boolean {
  try { return digestOf(a) === digestOf(b) } catch { return false }
}

function validConfirmationReceipt(value: unknown): value is ReconcileConfirmationReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const raw = value as Record<string, unknown>
  if (!same(Object.keys(raw).sort(), ['confirmedAt', 'confirmedBy', 'effectsState', 'fillId', 'input'].sort())) return false
  const input = validateReconcileConfirmInput(raw.input)
  return input.ok && typeof raw.fillId === 'string' && raw.fillId.length > 0
    && Number.isSafeInteger(raw.confirmedAt) && typeof raw.confirmedBy === 'string' && raw.confirmedBy.length > 0
    && ['pending', 'complete', 'failed'].includes(String(raw.effectsState))
}

/** Shared with confirmation capture: the fallback observation time is not candidate identity. */
export function reconcileCandidateDigest(suggestion: ReconcileSuggestion): string {
  const basis = [...suggestion.basis]
  const final = basis.at(-1)
  const fallbackTimestamp = /^时间取场所订单最后更新时刻 \d+（缺 updatedAt，退回场所视图生成时刻）$/u
  if (final && fallbackTimestamp.test(final)) {
    basis[basis.length - 1] = final.replace(/^(时间取场所订单最后更新时刻 )\d+(（缺 updatedAt，退回场所视图生成时刻）)$/u, '$1<observation-time>$2')
    return digestOf({ ...suggestion, ts: 0, basis })
  }
  return digestOf(suggestion)
}

function inferredBasisDigest(suggestion: ReconcileSuggestion, fillTs: number): string {
  const basis = [...suggestion.basis]
  const final = basis.at(-1)
  const fallbackTimestamp = /^时间取场所订单最后更新时刻 \d+（缺 updatedAt，退回场所视图生成时刻）$/u
  if (final && fallbackTimestamp.test(final)) {
    basis[basis.length - 1] = final.replace(/^(时间取场所订单最后更新时刻 )\d+(（缺 updatedAt，退回场所视图生成时刻）)$/u, (_match, prefix: string, suffix: string) => `${prefix}${fillTs}${suffix}`)
  }
  return digestOf(basis)
}

function sourceFor(kind: ReviewKind, seed: ReviewSeed): IdentitySource {
  if (kind === 'inferred_fill') {
    const suggestion = validated(validateReconcileSuggestion(seed.suggestion), 'inferred review requires a valid suggestion and local fills digest')
    if (typeof seed.localFillsDigest !== 'string') invalid('inferred review requires a valid suggestion and local fills digest')
    return { candidateDigest: reconcileCandidateDigest(suggestion), localFillsDigest: seed.localFillsDigest }
  }
  if (kind === 'known_difference') {
    const finding = validated(validateReconcileFindingView(seed.finding), 'known difference review requires a valid finding')
    return {
      id: finding.id, code: finding.code, severity: finding.severity, advice: finding.advice,
      evidence: finding.evidence.filter((evidence) => evidence.field !== 'ageMs'),
    }
  }
  if (kind === 'late_real_fill') {
    const fill = validated(validateFill(seed.fill), 'late fill review requires a valid fill')
    if (fill.accountId !== seed.accountId) invalid('late fill account does not match review account')
    return {
      accountId: fill.accountId, orderId: fill.orderId, clientOrderId: fill.clientOrderId, venueFillId: fill.venueFillId,
      instrumentId: fill.instrumentId, side: fill.side, price: fill.price, size: fill.size, fee: fill.fee, feeCcy: fill.feeCcy,
      builderFee: fill.builderFee ?? '0', liquidity: fill.liquidity, realizedPnl: fill.realizedPnl,
      liquidation: fill.liquidation === true, ts: fill.ts,
      ...(fill.legId !== undefined ? { legId: fill.legId } : {}),
      ...(fill.exitPlanId !== undefined ? { exitPlanId: fill.exitPlanId } : {}),
    }
  }
  const confirmation = validConfirmationReceipt(seed.confirmation) ? seed.confirmation : invalid('confirmation effects review requires a valid confirmation receipt')
  if (confirmation.input.accountId !== seed.accountId) invalid('confirmation receipt account does not match review account')
  return clone(confirmation) as unknown as IdentitySource
}

function identityFor(seed: ReviewSeed): { evidenceDigest: string; itemId: string } {
  const source = sourceFor(seed.kind, seed)
  const evidenceDigest = digestOf([seed.accountId, seed.kind, seed.blocking, source])
  return { evidenceDigest, itemId: `rri_${evidenceDigest.slice('sha256:'.length)}` }
}

function exactSeedKeys(seed: unknown, kind: ReviewKind): seed is ReviewSeed {
  if (!seed || typeof seed !== 'object' || Array.isArray(seed)) return false
  const required = ['accountId', 'kind', 'observedAt', 'summary', 'blocking']
  const sources: Record<ReviewKind, string[]> = {
    inferred_fill: ['suggestion', 'localFillsDigest'],
    known_difference: ['finding'],
    late_real_fill: ['fill'],
    confirmation_effects: ['confirmation'],
  }
  const keys = Object.keys(seed)
  const expected = [...required, ...sources[kind]].sort()
  return same([...keys].sort(), expected)
}

function validateResolutionInput(input: unknown): ReconcileResolutionInput {
  const value = validated(validateReconcileResolutionInput(input), 'resolution input is invalid')
  if (value.reason.trim().length === 0) invalid('resolution reason must not be blank')
  return clone(value)
}

export class ReconcileReviewStore {
  constructor(private readonly deps: ReconcileReviewStoreDeps) {}

  private readReceipt(id: string): ReconcileResolutionReceipt | undefined {
    let raw: unknown
    try { raw = this.deps.docs.get<unknown>(RESOLUTION_RECEIPTS, id) } catch { corrupt() }
    if (raw === undefined) return undefined
    const value = validateReconcileResolutionReceipt(raw)
    if (!value.ok || value.value.resolutionId !== id
      || value.value.input.reason.trim().length === 0
      || receiptId(value.value.input.accountId, value.value.input.requestId) !== id) return corrupt()
    return clone(value.value)
  }

  private verifyResolutionLedger(item: ReconcileReviewItem, receipt: ReconcileResolutionReceipt): void {
    let rows: { entry: string }[] = []
    try {
      rows = this.deps.db.prepare(
        `SELECT entry FROM ledger WHERE type='annotation' AND account_id=?
          AND json_extract(entry, '$.payload.kind')='reconcile.resolved'
          AND json_extract(entry, '$.payload.itemId')=? ORDER BY seq`,
      ).all(item.accountId, item.itemId) as { entry: string }[]
    } catch { corrupt() }
    if (rows.length !== 1) corrupt()
    let entry: unknown
    try { entry = JSON.parse(rows[0]!.entry) } catch { corrupt() }
    const row = entry as { type?: unknown; subject?: { accountId?: unknown }; origin?: { actor?: unknown; actorType?: unknown }; payload?: Record<string, unknown> } | null
    const payload = row?.payload
    if (row?.type !== 'annotation' || row.subject?.accountId !== item.accountId
      || typeof row.origin?.actor !== 'string' || row.origin.actor !== receipt.resolvedBy
      || row.origin.actorType !== 'human' || !row.origin.actor.startsWith('user:')
      || payload?.kind !== 'reconcile.resolved' || payload.itemId !== item.itemId
      || payload.evidenceDigest !== item.evidenceDigest || payload.presence !== 'pin'
      || !same(payload.receipt, receipt)) corrupt()
  }

  private verifyConfirmedFill(item: ReconcileReviewItem): void {
    if (item.kind !== 'inferred_fill') corrupt()
    const suggestion = item.suggestion ?? corrupt()
    const confirmedFillId = item.confirmedFillId ?? corrupt()
    const expectedReceiptId = `rcpt_${digestOf([item.accountId, suggestion.id]).slice('sha256:'.length)}`
    let rawReceipt: unknown
    try { rawReceipt = this.deps.docs.get<unknown>('reconcile-confirm-receipt', expectedReceiptId) } catch { corrupt() }
    const receipt = validConfirmationReceipt(rawReceipt) ? rawReceipt : corrupt()
    if (receipt.input.accountId !== item.accountId || receipt.input.suggestionId !== suggestion.id
      || receipt.fillId !== confirmedFillId
      || `rcpt_${digestOf([receipt.input.accountId, receipt.input.suggestionId]).slice('sha256:'.length)}` !== expectedReceiptId) corrupt()
    let row: { fill_id: string; account_id: string; doc: string } | undefined
    try {
      row = this.deps.db.prepare('SELECT fill_id, account_id, doc FROM fills WHERE fill_id=? AND account_id=?').get(confirmedFillId, item.accountId) as typeof row
    } catch { corrupt() }
    const fillRow = row ?? corrupt()
    let rawFill: unknown
    try { rawFill = JSON.parse(fillRow.doc) } catch { return corrupt() }
    const fillResult = validateFill(rawFill)
    if (!fillResult.ok) return corrupt()
    const fill = fillResult.value
    const proof = fill.inferred
    if (fillRow.fill_id !== confirmedFillId || fillRow.account_id !== item.accountId
      || fill.fillId !== confirmedFillId || fill.accountId !== item.accountId
      || fill.orderId !== suggestion.orderId || fill.clientOrderId !== suggestion.clientOrderId
      || fill.instrumentId !== suggestion.instrumentId || fill.side !== suggestion.side
      || fill.price !== suggestion.price || fill.size !== suggestion.size
      || fill.fee !== receipt.input.fee || fill.feeCcy !== receipt.input.feeCcy
      || fill.liquidity !== receipt.input.liquidity || fill.realizedPnl !== receipt.input.realizedPnl
      || !proof || proof.suggestionId !== receipt.input.suggestionId || proof.reportId !== receipt.input.reportId
      || proof.confirmedAt !== receipt.confirmedAt || proof.confirmedBy !== receipt.confirmedBy
      || proof.basisDigest !== inferredBasisDigest(suggestion, fill.ts) || proof.priceSource !== suggestion.priceSource) corrupt()
  }

  private validateStoredItem(raw: unknown, expectedId: string): ReconcileReviewItem {
    const itemResult = validateReconcileReviewItem(raw)
    if (!itemResult.ok) return corrupt()
    const item = itemResult.value
    if (item.itemId !== expectedId) corrupt()
    const seed = {
      accountId: item.accountId, kind: item.kind, observedAt: item.observedAt, summary: item.summary, blocking: item.blocking,
      ...(item.finding !== undefined ? { finding: item.finding } : {}),
      ...(item.suggestion !== undefined ? { suggestion: item.suggestion } : {}),
      ...(item.localFillsDigest !== undefined ? { localFillsDigest: item.localFillsDigest } : {}),
      ...(item.fill !== undefined ? { fill: item.fill } : {}),
      ...(item.confirmation !== undefined ? { confirmation: item.confirmation } : {}),
    }
    if (!exactSeedKeys(seed, item.kind)
      || ((item.kind === 'inferred_fill' || item.kind === 'late_real_fill' || item.kind === 'confirmation_effects') && item.blocking !== true)
      || (item.kind === 'known_difference' && item.blocking !== (item.finding?.severity === 'blocker'))) return corrupt()
    const identity = (() => {
      try { return identityFor({
        ...seed,
      } as ReviewSeed) } catch { return corrupt() }
    })()
    if (item.evidenceDigest !== identity.evidenceDigest || item.itemId !== identity.itemId) corrupt()
    if (item.resolution) {
      const input = item.resolution.input
      if (item.confirmedFillId !== undefined || input.accountId !== item.accountId || input.itemId !== item.itemId
        || input.evidenceDigest !== item.evidenceDigest || item.resolution.resolutionId !== receiptId(input.accountId, input.requestId)
        || (input.action === 'reject' ? item.kind !== 'inferred_fill' : item.kind === 'inferred_fill')) corrupt()
      const receipt = this.readReceipt(item.resolution.resolutionId)
      const linkedReceipt = receipt ?? corrupt()
      if (!same(linkedReceipt, item.resolution)) corrupt()
      this.verifyResolutionLedger(item, linkedReceipt)
    }
    if (item.confirmedFillId !== undefined) {
      if (item.resolution) corrupt()
      this.verifyConfirmedFill(item)
    }
    return clone(item)
  }

  private readItemById(itemId: string): ReconcileReviewItem | undefined {
    let raw: unknown
    try { raw = this.deps.docs.get<unknown>(REVIEW_ITEMS, itemId) } catch { corrupt() }
    return raw === undefined ? undefined : this.validateStoredItem(raw, itemId)
  }

  record(seed: ReviewSeed): ReconcileReviewItem {
    if (!seed || !['inferred_fill', 'known_difference', 'late_real_fill', 'confirmation_effects'].includes(seed.kind)
      || !exactSeedKeys(seed, seed.kind)) invalid('review seed fields do not match its kind')
    if ((seed.kind === 'inferred_fill' || seed.kind === 'late_real_fill' || seed.kind === 'confirmation_effects') && seed.blocking !== true) {
      invalid('inference, late fill, and confirmation effects reviews must block')
    }
    if (seed.kind === 'known_difference' && seed.blocking !== (seed.finding?.severity === 'blocker')) {
      invalid('known difference blocking must match finding severity')
    }
    const identity = (() => {
      try { return identityFor(seed) } catch (error) { if (error instanceof KernelError) throw error; return invalid('review source is invalid') }
    })()
    const item = { ...clone(seed), ...identity } as ReconcileReviewItem
    if (!validateReconcileReviewItem(item).ok) invalid('review item is invalid')
    const prior = this.get(item.accountId, item.itemId)
    if (prior) return prior
    this.deps.docs.put(REVIEW_ITEMS, item.itemId, item)
    return clone(item)
  }

  get(accountId: string, itemId: string): ReconcileReviewItem | undefined {
    const item = this.readItemById(itemId)
    if (!item || item.accountId !== accountId) return undefined
    return clone(item)
  }

  list(accountId: string): ReconcileReviewItem[] {
    let rows: { id: string; doc: string }[] = []
    try {
      rows = this.deps.db.prepare(
        `SELECT d.id, d.doc FROM docs d
         JOIN (SELECT id, MAX(ver) AS mv FROM docs WHERE coll=? GROUP BY id) latest
           ON latest.id=d.id AND latest.mv=d.ver
         WHERE d.coll=? ORDER BY d.id COLLATE BINARY`,
      ).all(REVIEW_ITEMS, REVIEW_ITEMS) as { id: string; doc: string }[]
    } catch { corrupt() }
    const validated = rows.map((row) => {
      let raw: unknown
      try { raw = JSON.parse(row.doc) } catch { corrupt() }
      return this.validateStoredItem(raw, row.id)
    })
    return validated.filter((item) => item.accountId === accountId).map(clone)
  }

  hasBlockingPending(accountId: string): boolean {
    return this.list(accountId).some((item) => item.blocking && item.resolution === undefined && item.confirmedFillId === undefined)
  }

  lookup(inputValue: ReconcileResolutionInput): ReconcileResolveResult | undefined {
    const input = validateResolutionInput(inputValue)
    const id = receiptId(input.accountId, input.requestId)
    const receipt = this.readReceipt(id)
    if (!receipt) {
      const item = this.readItemById(input.itemId)
      if (item?.accountId === input.accountId && item.resolution?.input.requestId === input.requestId) corrupt()
      return undefined
    }
    if (!same(receipt.input, input)) invalid('resolution request id conflicts with a prior request')
    const item = this.readItemById(input.itemId)
    if (!item || item.accountId !== input.accountId || !same(item.resolution, receipt)) corrupt()
    return { receipt: clone(receipt), alreadyRecorded: true }
  }

  resolve(inputValue: ReconcileResolutionInput, origin: Origin): ReconcileResolveResult {
    const input = validateResolutionInput(inputValue)
    const prior = this.lookup(input)
    if (prior) return prior
    if (this.deps.db.isTransaction) invalid('resolution must own the outer transaction')

    const deferred: LedgerDeferredEffects = this.deps.ledger.createDeferredEffects()
    let result: ReconcileResolveResult | undefined
    try {
      tx(this.deps.db, () => {
        const repeated = this.lookup(input)
        if (repeated) { result = repeated; return }
        const item = this.readItemById(input.itemId) ?? invalid('review item does not exist for this account')
        if (item.accountId !== input.accountId) return invalid('review item does not exist for this account')
        if (item.evidenceDigest !== input.evidenceDigest) invalid('review evidence has changed')
        if (item.resolution || item.confirmedFillId !== undefined) invalid('review item has already been handled')
        if (input.action === 'reject' ? item.kind !== 'inferred_fill' : item.kind === 'inferred_fill') invalid('resolution action is not allowed for this review kind')

        const receipt: ReconcileResolutionReceipt = {
          resolutionId: receiptId(input.accountId, input.requestId), input: clone(input),
          resolvedAt: this.deps.clock.now(), resolvedBy: origin.actor,
        }
        const resolved = { ...item, resolution: receipt }
        this.deps.docs.put(RESOLUTION_RECEIPTS, receipt.resolutionId, receipt)
        this.deps.docs.put(REVIEW_ITEMS, resolved.itemId, resolved)
        this.deps.ledger.append({
          type: 'annotation', origin, subject: { accountId: input.accountId },
          payload: { kind: 'reconcile.resolved', receipt, itemId: item.itemId, evidenceDigest: item.evidenceDigest, presence: 'pin' },
        }, deferred)
        const persisted = this.readItemById(item.itemId)
        if (!persisted || !same(persisted.resolution, receipt)) corrupt()
        result = { receipt: clone(receipt), alreadyRecorded: false }
      })
    } catch (error) {
      this.deps.ledger.restoreGateRenewalsAfterRollback()
      deferred.entries.length = 0
      throw error
    }
    if (!result) return corrupt()
    if (deferred.entries.length > 0) this.deps.ledger.publishDeferredEffects(deferred)
    return clone(result)
  }

  markConfirmed(accountId: string, itemId: string, fillId: string): void {
    if (!this.deps.db.isTransaction) invalid('confirmation marking requires the caller transaction')
    if (typeof fillId !== 'string' || fillId.length === 0) invalid('confirmed fill id is required')
    const item = this.readItemById(itemId)
    if (!item || item.accountId !== accountId || item.kind !== 'inferred_fill' || item.resolution || item.confirmedFillId !== undefined) {
      invalid('only a pending inferred fill review can be confirmed')
    }
    const confirmed = { ...item, confirmedFillId: fillId }
    if (!validateReconcileReviewItem(confirmed).ok) invalid('confirmed review item is invalid')
    this.deps.docs.put(REVIEW_ITEMS, itemId, confirmed)
    const persisted = this.readItemById(itemId)
    if (!persisted || persisted.confirmedFillId !== fillId) corrupt()
  }
}
