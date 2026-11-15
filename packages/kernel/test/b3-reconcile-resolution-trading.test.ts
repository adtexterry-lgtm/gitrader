// SPDX-License-Identifier: CPAL-1.0
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Fill, Order, OrderIntent, Origin, ReconcileConfirmInput, ReconcileReviewItem, ReconcileSuggestion } from '../src/proto'
import { validateFill } from '../src/proto'
import { FAST_SCRYPT, makeHarness } from './helpers/harness'
import type { Harness } from './helpers/harness'
import { BTC } from './helpers/fake-connector'
import { Kernel } from '../src/kernel'
import { fileProvider } from '../src/device-key'
import { digestOf } from '../src/util/hash'

let h: Harness
beforeEach(async () => { h = await makeHarness() })
afterEach(async () => { await h.cleanup() })

const openOrder = async () => {
  const intent: OrderIntent = {
    accountId: h.paper.accountId as never, instrumentId: BTC as never, side: 'buy', type: 'limit',
    tif: 'gtc', size: '0.012' as never, price: '80000' as never, leverage: 2, reason: 'review safety test',
  }
  const result = await h.k.trading.place({ intent }, h.human())
  if (!result.order?.venueOrderId) throw new Error('test order was not linked to venue identity')
  return result.order
}

const makeInput = (order: { orderId: string }, suffix = ''): ReconcileConfirmInput => ({
  offerId: `offer_${order.orderId}${suffix}`, accountId: h.paper.accountId as never,
  reportId: `report_${order.orderId}${suffix}`, suggestionId: `suggestion_${order.orderId}${suffix}`,
  fee: '0.0001' as never, feeCcy: 'USDC', liquidity: 'taker', realizedPnl: '0' as never,
} as ReconcileConfirmInput)

const makeSuggestion = (order: Order, input: ReconcileConfirmInput, ts = h.clock.now()): ReconcileSuggestion => ({
  id: input.suggestionId, orderId: order.orderId as never, venueOrderId: order.venueOrderId!,
  clientOrderId: order.clientOrderId as never, instrumentId: BTC as never, side: 'buy',
  size: '0.00001' as never, price: '80000' as never, ts, priceSource: 'venue_avg_fill_price',
  basis: ['stable reconciliation source', `时间取场所订单最后更新时刻 ${ts}（缺 updatedAt，退回场所视图生成时刻）`], inferred: true,
})

const makeFill = (order: Order, input: ReconcileConfirmInput, suggestion: ReconcileSuggestion): Fill => ({
  fillId: 'fill_review001' as never, orderId: order.orderId as never, clientOrderId: order.clientOrderId as never,
  venueFillId: `inferred_${digestOf([input.accountId, input.suggestionId]).slice('sha256:'.length)}`,
  accountId: input.accountId, instrumentId: BTC as never, side: 'buy', price: suggestion.price,
  size: suggestion.size, fee: input.fee, feeCcy: input.feeCcy, liquidity: input.liquidity,
  realizedPnl: input.realizedPnl, ts: suggestion.ts,
  inferred: { suggestionId: input.suggestionId, reportId: input.reportId, confirmedAt: h.clock.now(),
    confirmedBy: 'user:usr_local', priceSource: suggestion.priceSource, basisDigest: digestOf(suggestion.basis) },
})

function expectProblem(run: () => unknown, name: string): void {
  let caught: unknown
  try { run() } catch (error) { caught = error }
  expect(caught).toMatchObject({ problem: { name } })
}

function applyConfirmed(fill: Fill, input: ReconcileConfirmInput, itemId?: string) {
  const method = h.k.trading.applyConfirmedFill as unknown as (f: Fill, o: Origin, i: ReconcileConfirmInput, reviewItemId?: string) => unknown
  return method.call(h.k.trading, fill, h.human('reconcile.confirm').origin, input, itemId)
}

async function inferenceReview(order: Awaited<ReturnType<typeof openOrder>>, input: ReconcileConfirmInput, suggestion = makeSuggestion(order, input)) {
  return h.k.trading.reconcileReviews.record({
    accountId: input.accountId, kind: 'inferred_fill', observedAt: suggestion.ts, summary: 'Inference requires review.',
    blocking: true, suggestion, localFillsDigest: digestOf(h.k.orders.fillsForOrder(input.accountId, order.orderId)),
  })
}

function resolve(item: ReconcileReviewItem, action: 'acknowledge' | 'reject' = 'acknowledge') {
  return h.k.trading.reconcileReviews.resolve({ accountId: item.accountId, itemId: item.itemId,
    evidenceDigest: item.evidenceDigest, action, reason: 'Reviewed retained evidence.', requestId: `request_${item.itemId}` }, h.human('reconcile.resolve').origin)
}

describe('TradingService durable reconciliation review integration', () => {
  it('materializes failed confirmation effects, keeps the marker, and ACK suppresses pending without replay', async () => {
    const order = await openOrder()
    const input = makeInput(order)
    const observedSuggestion = makeSuggestion(order, input, h.clock.now() - 10)
    const fillSuggestion = makeSuggestion(order, input, h.clock.now())
    const item = await inferenceReview(order, input, observedSuggestion)
    const fill = makeFill(order, input, fillSuggestion)
    const fillCheck = validateFill(fill)
    if (!fillCheck.ok) throw new Error(JSON.stringify(fillCheck.issues))
    let callbackPending: boolean | undefined
    let callbackEffectsCount: number | undefined
    let callbackResumeProblem: string | undefined
    const onFill = vi.spyOn(h.k.protectors, 'onFill').mockImplementation(() => {
      callbackPending = h.k.trading.confirmationPending(input.accountId)
      callbackEffectsCount = h.k.trading.recoveryReviews(input.accountId).filter((row) => row.kind === 'confirmation_effects').length
      try { h.k.trading.assertReconciliationResolved([input.accountId]) }
      catch (error) { callbackResumeProblem = (error as { problem?: { name?: string } }).problem?.name }
      throw new Error('injected protector follow-up failure')
    })

    expect(applyConfirmed(fill, input, item.itemId)).toEqual({ fillId: fill.fillId, alreadyRecorded: false })
    const recovered = h.k.trading.recoveryReviews(input.accountId)
    const effects = recovered.find((row) => row.kind === 'confirmation_effects')!
    const receiptId = `rcpt_${digestOf([input.accountId, input.suggestionId]).slice('sha256:'.length)}`
    const markerBefore = h.k.docs.get('reconcile-confirm-pending', input.accountId)
    const financialRows = h.k.db.prepare("SELECT COUNT(*) AS n FROM ledger WHERE type='fill'").get() as { n: number }
    expect(effects.confirmation?.effectsState).toBe('failed')
    expect(callbackPending).toBe(false)
    expect(callbackEffectsCount).toBe(0)
    expect(callbackResumeProblem).toBe('BUSY')
    expect(h.k.docs.get('reconcile-confirm-pending', input.accountId)).toBe(receiptId)
    expect(h.k.orders.fillWithId(fill)).toMatchObject({ price: fill.price, size: fill.size, fee: fill.fee, realizedPnl: fill.realizedPnl })
    expect(h.k.trading.confirmationPending(input.accountId)).toBe(true)

    resolve(effects)
    expect(h.k.docs.get('reconcile-confirm-pending', input.accountId)).toBe(markerBefore)
    expect(h.k.docs.get<{ effectsState: string }>('reconcile-confirm-receipt', receiptId)?.effectsState).toBe('failed')
    expect(h.k.trading.confirmationPending(input.accountId)).toBe(false)
    expect(h.k.trading.reconcileReviews.get(input.accountId, effects.itemId)?.resolution).toBeDefined()
    expect(h.k.db.prepare("SELECT COUNT(*) AS n FROM ledger WHERE type='fill'").get()).toEqual(financialRows)

    const docsBeforeRetry = h.k.db.prepare('SELECT COUNT(*) AS n FROM docs').get()
    const ledgerBeforeRetry = h.k.db.prepare('SELECT COUNT(*) AS n FROM ledger').get()
    expect(applyConfirmed(fill, input, item.itemId)).toEqual({ fillId: fill.fillId, alreadyRecorded: true })
    expect(h.k.db.prepare('SELECT COUNT(*) AS n FROM docs').get()).toEqual(docsBeforeRetry)
    expect(h.k.db.prepare('SELECT COUNT(*) AS n FROM ledger').get()).toEqual(ledgerBeforeRetry)
    expect(onFill).toHaveBeenCalledTimes(1)
    expect(h.k.trading.confirmationPending(input.accountId)).toBe(false)
    onFill.mockRestore()

    const original = h.k
    await original.stop()
    const reopened = await Kernel.create({ home: h.home, clock: h.clock, scrypt: FAST_SCRYPT, deviceKeyProvider: fileProvider, timers: false, sleep: async () => undefined })
    h.k = reopened
    try {
      expect(h.k.trading.confirmationPending(input.accountId)).toBe(false)
      const restartDocsBeforeRetry = h.k.db.prepare('SELECT COUNT(*) AS n FROM docs').get()
      const restartLedgerBeforeRetry = h.k.db.prepare('SELECT COUNT(*) AS n FROM ledger').get()
      expect(applyConfirmed(fill, input, item.itemId)).toEqual({ fillId: fill.fillId, alreadyRecorded: true })
      expect(h.k.db.prepare('SELECT COUNT(*) AS n FROM docs').get()).toEqual(restartDocsBeforeRetry)
      expect(h.k.db.prepare('SELECT COUNT(*) AS n FROM ledger').get()).toEqual(restartLedgerBeforeRetry)
    } finally {
      h.k = original
      await reopened.stop()
    }
  })

  it('clears late pending only after every evidence item is acknowledged; duplicate ACK does not re-HALT', async () => {
    const order = await openOrder()
    const input = makeInput(order)
    const suggestion = makeSuggestion(order, input)
    expect(applyConfirmed(makeFill(order, input, suggestion), input)).toMatchObject({ alreadyRecorded: false })
    expect(h.k.trading.recoveryReviews(input.accountId).filter((row) => row.kind === 'confirmation_effects')).toEqual([])
    const base = { venueOrderId: order.venueOrderId!, clientOrderId: order.clientOrderId, instrumentId: BTC as never,
      side: 'buy' as const, price: '80000' as never, size: '0.00001' as never, fee: '0' as never,
      feeCcy: 'USDC', liquidity: 'maker' as const, realizedPnl: '0' as never }
    const first = { ...base, venueFillId: 'venue_late_one', ts: h.clock.now() + 1 }
    const second = { ...base, venueFillId: 'venue_late_two', price: '80001' as never, ts: h.clock.now() + 2 }
    h.k.trading.onVenueFill(input.accountId, first)
    h.k.trading.onVenueFill(input.accountId, second)

    const recovered = h.k.trading.recoveryReviews(input.accountId).filter((row) => row.kind === 'late_real_fill')
    expect(recovered).toHaveLength(2)
    expect(h.k.trading.lateRealEvidencePending(input.accountId)).toBe(true)
    resolve(recovered[0]!)
    expect(h.k.trading.lateRealEvidencePending(input.accountId)).toBe(true)
    resolve(recovered[1]!)
    expect(h.k.trading.lateRealEvidencePending(input.accountId)).toBe(false)

    const ledgerBeforeDuplicate = h.k.ledger.head()
    const setState = vi.spyOn(h.k.tstate, 'set')
    h.k.trading.onVenueFill(input.accountId, first)
    expect(h.k.ledger.head()).toEqual(ledgerBeforeDuplicate)
    expect(setState).not.toHaveBeenCalled()
    expect(h.k.trading.lateRealEvidencePending(input.accountId)).toBe(false)

    h.k.trading.onVenueFill(input.accountId, { ...first, price: '80002' as never, ts: h.clock.now() + 3 })
    expect(h.k.trading.recoveryReviews(input.accountId).filter((row) => row.kind === 'late_real_fill')).toHaveLength(3)
    expect(h.k.trading.lateRealEvidencePending(input.accountId)).toBe(true)
    expect(setState).toHaveBeenCalled()
    setState.mockRestore()
  })

  it('requires supplied pending inference proof and rolls markConfirmed back with a failed fill transaction', async () => {
    const order = await openOrder()
    const input = makeInput(order)
    const suggestion = makeSuggestion(order, input)
    const item = await inferenceReview(order, input, suggestion)
    const fill = makeFill(order, input, suggestion)
    expect(h.k.trading.confirmationPending(input.accountId)).toBe(false)
    expectProblem(() => h.k.trading.assertReconciliationResolved([input.accountId]), 'TRADING_STATE')
    const changedFill = { ...fill, price: '80001' as never }
    expectProblem(() => applyConfirmed(changedFill, input, item.itemId), 'INVALID_PARAMS')
    expect(h.k.orders.fillWithId(fill)).toBeUndefined()

    h.k.db.exec("CREATE TRIGGER fail_review_confirm_fill BEFORE INSERT ON ledger WHEN NEW.type='fill' BEGIN SELECT RAISE(ABORT, 'injected fill write failure'); END")
    try {
      expect(() => applyConfirmed(fill, input, item.itemId)).toThrow()
      expect(h.k.orders.fillWithId(fill)).toBeUndefined()
      expect(h.k.docs.get('reconcile-confirm-receipt', `rcpt_${digestOf([input.accountId, input.suggestionId]).slice('sha256:'.length)}`)).toBeUndefined()
      expect(h.k.trading.reconcileReviews.get(input.accountId, item.itemId)?.confirmedFillId).toBeUndefined()
    } finally { h.k.db.exec('DROP TRIGGER fail_review_confirm_fill') }

    expect(applyConfirmed(fill, input, item.itemId)).toMatchObject({ alreadyRecorded: false })
    expect(h.k.trading.reconcileReviews.get(input.accountId, item.itemId)?.confirmedFillId).toBe(fill.fillId)

    const rejectedInput = makeInput(order, '-rejected')
    const rejectedSuggestion = makeSuggestion(order, rejectedInput)
    const rejectedItem = await inferenceReview(order, rejectedInput, rejectedSuggestion)
    const rejectedFill = makeFill(order, rejectedInput, rejectedSuggestion)
    resolve(rejectedItem, 'reject')
    const fillsBeforeRejectedConfirmation = h.k.orders.fillsForOrder(rejectedInput.accountId, order.orderId).length
    const ledgerFillsBeforeRejectedConfirmation = (h.k.db.prepare("SELECT COUNT(*) AS n FROM ledger WHERE type='fill'").get() as { n: number }).n
    expectProblem(() => applyConfirmed(rejectedFill, rejectedInput, rejectedItem.itemId), 'INVALID_PARAMS')
    expect(h.k.orders.fillsForOrder(rejectedInput.accountId, order.orderId)).toHaveLength(fillsBeforeRejectedConfirmation)
    expect((h.k.db.prepare("SELECT COUNT(*) AS n FROM ledger WHERE type='fill'").get() as { n: number }).n).toBe(ledgerFillsBeforeRejectedConfirmation)
  })

  it('fails closed on an orphaned marker and does not invent a review item', async () => {
    const accountId = h.paper.accountId
    h.k.docs.put('reconcile-confirm-pending', accountId, 'rcpt_missing_source')
    expectProblem(() => h.k.trading.recoveryReviews(accountId), 'STATE_FILE_CORRUPT')
    expect(h.k.trading.confirmationPending(accountId)).toBe(true)
    expect(h.k.trading.reconcileReviews.list(accountId)).toEqual([])
  })

  it('fails closed on malformed late-evidence economics', async () => {
    const accountId = h.paper.accountId
    h.k.docs.put('reconcile-late-evidence', 'late_malformed_source', {
      fillId: 'raw_local_1', orderId: 'ord_local001', clientOrderId: 'c'.repeat(32), venueFillId: 'venue_bad_evidence',
      accountId, instrumentId: BTC, side: 'buy', price: 'not-a-price', size: '0.00001', fee: '0', feeCcy: 'USDC',
      liquidity: 'maker', realizedPnl: '0', ts: h.clock.now(),
    })
    h.k.docs.put('reconcile-late-pending', accountId, true)
    expectProblem(() => h.k.trading.recoveryReviews(accountId), 'STATE_FILE_CORRUPT')
  })

  it('preserves raw local fill references while projecting valid late review evidence', async () => {
    const order = await openOrder()
    const input = makeInput(order)
    const suggestion = makeSuggestion(order, input)
    const inferred = makeFill(order, input, suggestion)
    expect(applyConfirmed(inferred, input)).toMatchObject({ alreadyRecorded: false })
    const { inferred: _proof, ...baseReal } = makeFill(order, input, suggestion)
    const rawReal = { ...baseReal, fillId: 'fill_direct_late_probe' as never, venueFillId: 'venue_direct_late_probe' }
    const fillCount = h.k.orders.fillsForOrder(input.accountId, order.orderId).length
    const ledgerFillCount = (h.k.db.prepare("SELECT COUNT(*) AS n FROM ledger WHERE type='fill'").get() as { n: number }).n

    expect(h.k.trading.applyFill(rawReal, h.human('reconcile.confirm').origin)).toBe(false)
    const rawRow = h.k.db.prepare("SELECT id, doc FROM docs WHERE coll='reconcile-late-evidence'").get() as { id: string; doc: string }
    expect(JSON.parse(rawRow.doc).fillId).toBe(rawReal.fillId)
    const projected = h.k.trading.recoveryReviews(input.accountId).find((row) => row.kind === 'late_real_fill')!
    expect(projected.fill?.fillId).toMatch(/^fill_[0-9a-f]{26}$/)
    if (!projected.fill) throw new Error('late evidence review lacks its projected fill')
    expect(validateFill(projected.fill).ok).toBe(true)
    expect(h.k.orders.fillsForOrder(input.accountId, order.orderId)).toHaveLength(fillCount)
    expect((h.k.db.prepare("SELECT COUNT(*) AS n FROM ledger WHERE type='fill'").get() as { n: number }).n).toBe(ledgerFillCount)

    expect(h.k.trading.applyFill({ ...rawReal, price: '80001' as never, venueFillId: 'venue_direct_late_changed' }, h.human('reconcile.confirm').origin)).toBe(false)
    expect(h.k.trading.recoveryReviews(input.accountId).filter((row) => row.kind === 'late_real_fill')).toHaveLength(2)
    expect(h.k.trading.lateRealEvidencePending(input.accountId)).toBe(true)
    expect(h.k.tstate.get({ type: 'account', id: input.accountId })).toBe('HALTED')
    expect(h.k.orders.fillsForOrder(input.accountId, order.orderId)).toHaveLength(fillCount)
  })

  it('scans and materializes more than 1000 late evidence rows', async () => {
    const order = await openOrder()
    const accountId = h.paper.accountId
    const base = { orderId: order.orderId, clientOrderId: order.clientOrderId, instrumentId: BTC as never,
      side: 'buy' as const, price: '80000' as never, size: '0.00001' as never, fee: '0' as never,
      feeCcy: 'USDC', liquidity: 'maker' as const, realizedPnl: '0' as never }
    for (let index = 0; index < 1001; index++) {
      const fill: Fill = { ...base, fillId: 'fill_review001' as never, accountId,
        venueFillId: `venue_bulk_${index}`, ts: h.clock.now() + index }
      const identity = { accountId: fill.accountId, orderId: fill.orderId, clientOrderId: fill.clientOrderId,
        venueFillId: fill.venueFillId, instrumentId: fill.instrumentId, side: fill.side,
        price: fill.price, size: fill.size, fee: fill.fee, feeCcy: fill.feeCcy, builderFee: '0',
        liquidity: fill.liquidity, realizedPnl: fill.realizedPnl, liquidation: false, ts: fill.ts }
      const id = `late_${digestOf(identity).slice('sha256:'.length)}`
      h.k.docs.put('reconcile-late-evidence', id, fill)
    }
    h.k.docs.put('reconcile-late-pending', accountId, true)
    expect(h.k.trading.recoveryReviews(accountId).filter((row) => row.kind === 'late_real_fill')).toHaveLength(1001)
  })
})
