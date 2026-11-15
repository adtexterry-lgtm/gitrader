// SPDX-License-Identifier: CPAL-1.0
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Fill, ReconcileFindingView, ReconcileReviewItem, ReconcileSuggestion, ReconcileResolutionInput } from '../src/proto'
import { makeHarness, FAST_SCRYPT, type Harness } from './helpers/harness'
import { tx } from '../src/db'
import { mkOrigin } from '../src/util/origin'
import { Kernel } from '../src/kernel'
import { fileProvider } from '../src/device-key'
import { digestOf } from '../src/util/hash'

const digest = `sha256:${'a'.repeat(64)}`
const candidate = (ts = 10): ReconcileSuggestion => ({
  id: 'suggestion-1', orderId: 'ord_abc' as ReconcileSuggestion['orderId'], venueOrderId: 'venue-order-1',
  clientOrderId: 'a'.repeat(32) as ReconcileSuggestion['clientOrderId'], instrumentId: 'paper:BTC/USDT' as ReconcileSuggestion['instrumentId'],
  side: 'buy', size: '2' as ReconcileSuggestion['size'], price: '10' as ReconcileSuggestion['price'], ts,
  priceSource: 'venue_avg_fill_price', basis: ['stable', `时间取场所订单最后更新时刻 ${ts}（缺 updatedAt，退回场所视图生成时刻）`], inferred: true,
})
const finding = (id: string, severity: ReconcileFindingView['severity'] = 'warn', age = '10', detail = 'Difference observed'): ReconcileFindingView => ({
  id, code: 'KNOWN_DIFFERENCE', severity, detail,
  advice: { action: 'review', requiresHuman: true, why: 'Review the local evidence.' },
  evidence: [{ report: 'report-1', id: 'field-1', field: 'ageMs', value: age }],
})
const lateFill = (accountId: string, fillId = 'fill_local1', price = '10'): Fill => ({
  fillId: fillId as Fill['fillId'], orderId: 'ord_abc' as Fill['orderId'], clientOrderId: 'a'.repeat(32) as Fill['clientOrderId'],
  venueFillId: 'venue-fill-1', accountId: accountId as Fill['accountId'], instrumentId: 'paper:BTC/USDT' as Fill['instrumentId'],
  side: 'buy', price: price as Fill['price'], size: '2' as Fill['size'], fee: '0' as Fill['fee'], feeCcy: 'USD', liquidity: 'maker',
  realizedPnl: '0' as Fill['realizedPnl'], ts: 20,
})
const confirmation = (accountId: string, fillId = 'fill_abc') => ({
  input: { accountId: accountId as Fill['accountId'], offerId: 'offer-1', reportId: 'report-1', suggestionId: 'suggestion-1', fee: '0' as Fill['fee'], feeCcy: 'USD', liquidity: 'maker' as const, realizedPnl: '0' as Fill['realizedPnl'] },
  fillId: fillId as Fill['fillId'], confirmedAt: 30, confirmedBy: 'user:usr_local', effectsState: 'failed' as const,
})

async function loadStore() {
  const module = await import('../src/reconcile-review')
  return module.ReconcileReviewStore
}

async function makeStore(h: Harness) {
  const ReconcileReviewStore = await loadStore()
  return new ReconcileReviewStore({ db: h.k.db, docs: h.k.docs, ledger: h.k.ledger, clock: h.clock })
}

function resolutionInput(accountId: ReconcileReviewItem['accountId'], itemId: string, evidenceDigest: string, overrides: Partial<ReconcileResolutionInput> = {}): ReconcileResolutionInput {
  return { accountId, itemId, evidenceDigest, action: 'acknowledge', reason: 'Reviewed the retained evidence.', requestId: 'request-1', ...overrides }
}

type KnownSeed = Pick<ReconcileReviewItem, 'accountId' | 'observedAt' | 'summary' | 'blocking' | 'finding'> & { kind: 'known_difference' }
function knownSeed(accountId: ReconcileReviewItem['accountId'], id = 'finding-1', overrides: Partial<KnownSeed> = {}): KnownSeed {
  return { accountId, kind: 'known_difference', observedAt: 100, summary: 'Known difference', blocking: false, finding: finding(id), ...overrides }
}

function expectProblem(run: () => unknown, name: string): void {
  let caught: unknown
  try { run() } catch (error) { caught = error }
  expect(caught).toMatchObject({ problem: { name } })
}

describe('durable reconciliation review store', () => {
  let h: Harness

  beforeEach(async () => { h = await makeHarness({ registerLive: false }) })
  afterEach(async () => { await h.cleanup() })

  it('loads the per-item store against the real temporary kernel database', async () => {
    const store = await makeStore(h)
    expect(store).toBeDefined()
  })

  it('deduplicates stable snapshots and preserves the first observation through resolution', async () => {
    const store = await makeStore(h)
    const accountId = h.paper.accountId
    const first = store.record(knownSeed(accountId, 'finding-stable', { observedAt: 101, summary: 'First summary', finding: finding('finding-stable', 'warn', '10', 'First detail') }))
    const input = resolutionInput(accountId, first.itemId, first.evidenceDigest)
    const resolved = store.resolve(input, mkOrigin('user:usr_local', 'reconcile.resolve', 'ui'))
    const repeated = store.record(knownSeed(accountId, 'finding-stable', { observedAt: 202, summary: 'Changed summary', finding: finding('finding-stable', 'warn', '99', 'Changed detail') }))

    expect(repeated).toEqual({ ...first, resolution: resolved.receipt })
    expect(repeated.observedAt).toBe(101)
    expect(repeated.summary).toBe('First summary')
    expect(repeated.finding?.evidence[0]?.value).toBe('10')
  })

  it('normalizes fallback candidate time and local fill ids but creates new identity for economic changes', async () => {
    const store = await makeStore(h)
    const accountId = h.paper.accountId
    const suggestion = candidate(10)
    const inference = store.record({ accountId, kind: 'inferred_fill', observedAt: 100, summary: 'Inference', blocking: true, suggestion, localFillsDigest: digest })
    const repeatedInference = store.record({ accountId, kind: 'inferred_fill', observedAt: 200, summary: 'Later scan', blocking: true, suggestion: candidate(20), localFillsDigest: digest })
    const late = store.record({ accountId, kind: 'late_real_fill', observedAt: 100, summary: 'Late fill', blocking: true, fill: lateFill(accountId, 'fill_local1') })
    const repeatedLate = store.record({ accountId, kind: 'late_real_fill', observedAt: 200, summary: 'Later scan', blocking: true, fill: lateFill(accountId, 'fill_local2') })
    const changedLate = store.record({ accountId, kind: 'late_real_fill', observedAt: 200, summary: 'Changed economics', blocking: true, fill: lateFill(accountId, 'fill_local3', '11') })

    expect(repeatedInference.itemId).toBe(inference.itemId)
    expect(repeatedInference.observedAt).toBe(100)
    expect(repeatedLate.itemId).toBe(late.itemId)
    expect(changedLate.itemId).not.toBe(late.itemId)
  })

  it('requires kind-specific evidence, matching account sources, and blocking semantics', async () => {
    const store = await makeStore(h)
    const accountId = h.paper.accountId
    expectProblem(() => store.record({ accountId, kind: 'inferred_fill', observedAt: 1, summary: 'Missing source', blocking: true }), 'INVALID_PARAMS')
    expectProblem(() => store.record({ accountId, kind: 'inferred_fill', observedAt: 1, summary: 'Missing digest', blocking: true, suggestion: candidate() }), 'INVALID_PARAMS')
    expectProblem(() => store.record(knownSeed(accountId, 'blocker', { blocking: false, finding: finding('blocker', 'blocker') })), 'INVALID_PARAMS')
    expectProblem(() => store.record({ accountId, kind: 'late_real_fill', observedAt: 1, summary: 'Wrong account', blocking: true, fill: lateFill('acct_other') }), 'INVALID_PARAMS')
    expectProblem(() => store.record({ accountId, kind: 'confirmation_effects', observedAt: 1, summary: 'Wrong account', blocking: true, confirmation: confirmation('acct_other') }), 'INVALID_PARAMS')
    expectProblem(() => store.record({ ...knownSeed(accountId), suggestion: candidate() }), 'INVALID_PARAMS')
  })

  it('resolves once, returns the durable receipt on exact retry, and leaves financial counts unchanged', async () => {
    const store = await makeStore(h)
    const accountId = h.paper.accountId
    const item = store.record(knownSeed(accountId, 'resolve-once'))
    const before = {
      orders: (h.k.db.prepare('SELECT COUNT(*) AS n FROM orders').get() as { n: number }).n,
      fills: (h.k.db.prepare('SELECT COUNT(*) AS n FROM fills').get() as { n: number }).n,
      financialEntries: (h.k.db.prepare("SELECT COUNT(*) AS n FROM ledger WHERE type IN ('fill','funding','liquidation','position.snapshot','order.intent','order.placed')").get() as { n: number }).n,
      head: h.k.ledger.head().seq,
      receipts: (h.k.db.prepare("SELECT COUNT(*) AS n FROM docs WHERE coll='reconcile-resolution-receipt'").get() as { n: number }).n,
    }
    const input = resolutionInput(accountId, item.itemId, item.evidenceDigest)
    const origin = mkOrigin('user:usr_local', 'reconcile.resolve', 'ui')
    expect(store.lookup(input)).toBeUndefined()
    expect((h.k.db.prepare("SELECT COUNT(*) AS n FROM docs WHERE coll='reconcile-resolution-receipt'").get() as { n: number }).n).toBe(before.receipts)
    const first = store.resolve(input, origin)
    const lookedUp = store.lookup(input)
    const reorderedLookup = store.lookup({ requestId: input.requestId, reason: input.reason, action: input.action,
      evidenceDigest: input.evidenceDigest, itemId: input.itemId, accountId: input.accountId })
    const retry = store.resolve(input, origin)
    const after = {
      orders: (h.k.db.prepare('SELECT COUNT(*) AS n FROM orders').get() as { n: number }).n,
      fills: (h.k.db.prepare('SELECT COUNT(*) AS n FROM fills').get() as { n: number }).n,
      financialEntries: (h.k.db.prepare("SELECT COUNT(*) AS n FROM ledger WHERE type IN ('fill','funding','liquidation','position.snapshot','order.intent','order.placed')").get() as { n: number }).n,
      head: h.k.ledger.head().seq,
      annotations: (h.k.db.prepare("SELECT COUNT(*) AS n FROM ledger WHERE account_id=? AND type='annotation' AND json_extract(entry, '$.payload.kind')='reconcile.resolved'").get(accountId) as { n: number }).n,
      receipts: (h.k.db.prepare("SELECT COUNT(*) AS n FROM docs WHERE coll='reconcile-resolution-receipt'").get() as { n: number }).n,
    }

    expect(first.alreadyRecorded).toBe(false)
    expect(lookedUp).toEqual({ ...first, alreadyRecorded: true })
    expect(reorderedLookup).toEqual({ ...first, alreadyRecorded: true })
    expect(retry).toEqual({ ...first, alreadyRecorded: true })
    expect(after).toMatchObject({ orders: before.orders, fills: before.fills, financialEntries: before.financialEntries, head: before.head + 1, annotations: 1, receipts: 1 })
    expect(store.get(accountId, item.itemId)?.resolution).toEqual(first.receipt)
  })

  it('rejects request collisions, stale digests, illegal actions, and foreign account access', async () => {
    const store = await makeStore(h)
    const accountId = h.paper.accountId
    const item = store.record(knownSeed(accountId, 'conflict'))
    const origin = mkOrigin('user:usr_local', 'reconcile.resolve', 'ui')
    const originalInput = resolutionInput(accountId, item.itemId, item.evidenceDigest)
    store.resolve(originalInput, origin)
    const conflict = resolutionInput(accountId, item.itemId, item.evidenceDigest, { reason: 'Different request content' })
    expectProblem(() => store.resolve(conflict, origin), 'INVALID_PARAMS')
    expectProblem(() => store.lookup(conflict), 'INVALID_PARAMS')
    const pending = store.record(knownSeed(accountId, 'pending'))
    expectProblem(() => store.resolve(resolutionInput(accountId, pending.itemId, digest, { requestId: 'request-stale' }), origin), 'INVALID_PARAMS')
    expectProblem(() => store.resolve(resolutionInput(accountId, pending.itemId, pending.evidenceDigest, { action: 'reject', requestId: 'request-reject' }), origin), 'INVALID_PARAMS')
    expect(store.get('acct_foreign' as typeof accountId, pending.itemId)).toBeUndefined()
    expect(store.list('acct_foreign' as typeof accountId)).toEqual([])
    expectProblem(() => store.resolve(resolutionInput('acct_foreign', pending.itemId, pending.evidenceDigest, { requestId: 'request-foreign' }), origin), 'INVALID_PARAMS')
  })

  it('records confirmation on a pending inference and prevents later rejection', async () => {
    const store = await makeStore(h)
    const accountId = h.paper.accountId
    const item = store.record({ accountId, kind: 'inferred_fill', observedAt: 1, summary: 'Inference', blocking: true, suggestion: candidate(), localFillsDigest: digest })
    const receipt = confirmation(accountId)
    const fill: Fill = {
      ...lateFill(accountId, 'fill_abc'), venueFillId: `inferred_${digestOf([accountId, 'suggestion-1']).slice('sha256:'.length)}`,
      inferred: { suggestionId: 'suggestion-1', reportId: 'report-1', confirmedAt: receipt.confirmedAt,
        confirmedBy: receipt.confirmedBy, priceSource: 'venue_avg_fill_price', basisDigest: digestOf(candidate(20).basis) },
    }
    const receiptId = `rcpt_${digestOf([accountId, 'suggestion-1']).slice('sha256:'.length)}`
    tx(h.k.db, () => {
      h.k.docs.put('reconcile-confirm-receipt', receiptId, { ...receipt, fillId: fill.fillId })
      h.k.orders.insertFill(fill)
      store.markConfirmed(accountId, item.itemId, fill.fillId)
    })

    expect(store.get(accountId, item.itemId)?.confirmedFillId).toBe('fill_abc')
    expectProblem(() => store.resolve(resolutionInput(accountId, item.itemId, item.evidenceDigest, { action: 'reject' }), mkOrigin('user:usr_local', 'reconcile.resolve', 'ui')), 'INVALID_PARAMS')
    const badBasisProof = { ...fill, inferred: { ...fill.inferred!, basisDigest: digest } }
    h.k.db.prepare('UPDATE fills SET doc=? WHERE fill_id=?').run(JSON.stringify(badBasisProof), fill.fillId)
    expectProblem(() => store.get(accountId, item.itemId), 'STATE_FILE_CORRUPT')
    h.k.db.prepare('UPDATE fills SET doc=? WHERE fill_id=?').run(JSON.stringify(fill), fill.fillId)
    const changedEconomics = { ...fill, price: '11' as Fill['price'] }
    h.k.db.prepare('UPDATE fills SET doc=? WHERE fill_id=?').run(JSON.stringify(changedEconomics), fill.fillId)
    expectProblem(() => store.get(accountId, item.itemId), 'STATE_FILE_CORRUPT')
  })

  it.each(['receipt', 'annotation'] as const)('fails closed when a resolved item has no %s proof', async (missingProof) => {
    const store = await makeStore(h)
    const accountId = h.paper.accountId
    const item = store.record(knownSeed(accountId, `missing-${missingProof}`))
    const input = resolutionInput(accountId, item.itemId, item.evidenceDigest)
    if (missingProof === 'receipt') {
      const receipt = store.resolve(input, mkOrigin('user:usr_local', 'reconcile.resolve', 'ui')).receipt
      h.k.docs.delete('reconcile-resolution-receipt', receipt.resolutionId)
    } else {
      const receipt = {
        resolutionId: `rrr_${digestOf([accountId, input.requestId]).slice('sha256:'.length)}`,
        input, resolvedAt: h.clock.now(), resolvedBy: 'user:usr_local',
      }
      h.k.docs.put('reconcile-resolution-receipt', receipt.resolutionId, receipt)
      h.k.docs.put('reconcile-review-item', item.itemId, { ...item, resolution: receipt })
    }

    expectProblem(() => store.get(accountId, item.itemId), 'STATE_FILE_CORRUPT')
    expectProblem(() => store.list(accountId), 'STATE_FILE_CORRUPT')
    expectProblem(() => store.hasBlockingPending(accountId), 'STATE_FILE_CORRUPT')
    expectProblem(() => store.lookup(resolutionInput(accountId, item.itemId, item.evidenceDigest)), 'STATE_FILE_CORRUPT')
  })

  it('fails closed when an inference points at a confirmed fill without matching durable proof', async () => {
    const store = await makeStore(h)
    const accountId = h.paper.accountId
    const item = store.record({ accountId, kind: 'inferred_fill', observedAt: 1, summary: 'Inference', blocking: true, suggestion: candidate(), localFillsDigest: digest })
    h.k.docs.put('reconcile-review-item', item.itemId, { ...item, confirmedFillId: 'fill_missing' })

    expectProblem(() => store.get(accountId, item.itemId), 'STATE_FILE_CORRUPT')
    expectProblem(() => store.hasBlockingPending(accountId), 'STATE_FILE_CORRUPT')
  })

  it.each(['docs', 'ledger'] as const)('rolls back receipt, terminal state, and events when %s writes fail', async (failurePoint) => {
    const store = await makeStore(h)
    const accountId = h.paper.accountId
    const item = store.record(knownSeed(accountId, `rollback-${failurePoint}`))
    const events: unknown[] = []
    const unsubscribe = h.k.events.subscribe('ledger.entry', (event) => events.push(event))
    const originalPut = h.k.docs.put.bind(h.k.docs)
    const originalAppend = h.k.ledger.append.bind(h.k.ledger)
    const putSpy = vi.spyOn(h.k.docs, 'put').mockImplementation((coll, id, doc, ver) => {
      if (failurePoint === 'docs' && coll === 'reconcile-review-item') throw new Error('injected docs failure')
      return originalPut(coll, id, doc, ver)
    })
    const appendSpy = vi.spyOn(h.k.ledger, 'append').mockImplementation((input, deferred) => {
      const entry = originalAppend(input, deferred)
      if (failurePoint === 'ledger' && input.payload?.kind === 'reconcile.resolved') throw new Error('injected ledger failure')
      return entry
    })

    expect(() => store.resolve(resolutionInput(accountId, item.itemId, item.evidenceDigest), mkOrigin('user:usr_local', 'reconcile.resolve', 'ui'))).toThrow()
    expect((h.k.db.prepare("SELECT COUNT(*) AS n FROM docs WHERE coll='reconcile-resolution-receipt'").get() as { n: number }).n).toBe(0)
    expect(store.get(accountId, item.itemId)?.resolution).toBeUndefined()
    expect(events).toEqual([])

    putSpy.mockRestore()
    appendSpy.mockRestore()
    unsubscribe()
  })

  it('reopens resolved evidence and idempotency receipts after kernel restart', async () => {
    const store = await makeStore(h)
    const accountId = h.paper.accountId
    const item = store.record(knownSeed(accountId, 'restart'))
    const input = resolutionInput(accountId, item.itemId, item.evidenceDigest)
    const origin = mkOrigin('user:usr_local', 'reconcile.resolve', 'ui')
    const receipt = store.resolve(input, origin).receipt
    await h.k.stop()
    const reopened = await Kernel.create({ home: h.home, clock: h.clock, scrypt: FAST_SCRYPT, deviceKeyProvider: fileProvider, timers: false, sleep: async () => undefined })
    try {
      const ReconcileReviewStore = await loadStore()
      const afterRestart = new ReconcileReviewStore({ db: reopened.db, docs: reopened.docs, ledger: reopened.ledger, clock: h.clock })
      expect(afterRestart.get(accountId, item.itemId)?.resolution).toEqual(receipt)
      expect(afterRestart.resolve(input, origin)).toEqual({ receipt, alreadyRecorded: true })
    } finally { await reopened.stop() }
  })

  it('lists every account item past Docs.list default limit and sees blocking pending work', async () => {
    const store = await makeStore(h)
    const accountId = h.paper.accountId
    for (let index = 0; index < 1001; index += 1) {
      const id = `finding-${String(index).padStart(4, '0')}`
      const severity = index === 1000 ? 'blocker' : 'warn'
      store.record(knownSeed(accountId, id, { blocking: severity === 'blocker', finding: finding(id, severity) }))
    }

    const items = store.list(accountId)
    expect(items).toHaveLength(1001)
    expect(items.map((item) => item.itemId)).toEqual([...items].map((item) => item.itemId).sort())
    expect(store.hasBlockingPending(accountId)).toBe(true)
  })

  it.each(['missing', 'foreign'] as const)('validates every current catalog row before account filtering when accountId is %s', async (damage) => {
    const store = await makeStore(h)
    const accountA = h.paper.accountId
    const accountB = 'acct_foreign' as ReconcileReviewItem['accountId']
    const keepA = store.record(knownSeed(accountA, `keep-a-${damage}`))
    const damaged = store.record(knownSeed(accountA, `damaged-a-${damage}`))
    const pendingB = store.record(knownSeed(accountB, `pending-b-${damage}`))
    const stored = { ...damaged } as Record<string, unknown>
    if (damage === 'missing') delete stored.accountId
    else stored.accountId = accountB
    h.k.docs.put('reconcile-review-item', damaged.itemId, stored)
    const docsBefore = (h.k.db.prepare('SELECT COUNT(*) AS n FROM docs').get() as { n: number }).n
    const ledgerBefore = h.k.ledger.head().seq

    expectProblem(() => store.get(accountA, damaged.itemId), 'STATE_FILE_CORRUPT')
    expectProblem(() => store.list(accountA), 'STATE_FILE_CORRUPT')
    expectProblem(() => store.hasBlockingPending(accountA), 'STATE_FILE_CORRUPT')
    expect(store.get(accountB, pendingB.itemId)).toEqual(pendingB)
    expect(keepA.itemId).not.toBe(damaged.itemId)
    expect((h.k.db.prepare('SELECT COUNT(*) AS n FROM docs').get() as { n: number }).n).toBe(docsBefore)
    expect(h.k.ledger.head().seq).toBe(ledgerBefore)
  })

  it('filters valid other-account pending items only after validating the catalog', async () => {
    const store = await makeStore(h)
    const accountA = h.paper.accountId
    const accountB = 'acct_foreign' as ReconcileReviewItem['accountId']
    const itemA = store.record(knownSeed(accountA, 'scope-a'))
    const itemB = store.record(knownSeed(accountB, 'scope-b', { blocking: true, finding: finding('scope-b', 'blocker') }))

    expect(store.list(accountA)).toEqual([itemA])
    expect(store.hasBlockingPending(accountA)).toBe(false)
    expect(store.list(accountB)).toEqual([itemB])
    expect(store.hasBlockingPending(accountB)).toBe(true)
  })
})
