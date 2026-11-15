// SPDX-License-Identifier: CPAL-1.0
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Fill, OrderIntent, Origin, ReconcileAccountView, ReconcileConfirmInput, ReconcileFindingView, ReconcileReviewItem, ReconcileSuggestion } from '../src/proto'
import { validateFill } from '../src/proto'
import { digestOf } from '../src/util/hash'
import { makeHarness, TEST_PIN } from './helpers/harness'
import type { Harness } from './helpers/harness'
import { BTC } from './helpers/fake-connector'

let h: Harness | undefined
afterEach(async () => { await h?.cleanup(); h = undefined })

function cachedView(view: ReconcileAccountView): void {
  const service = h!.k.reconcileService as unknown as {
    states: Map<string, { view: ReconcileAccountView; nextHistoryCursor: number }>
  }
  service.states.set(view.accountId, { view, nextHistoryCursor: 0 })
}

function knownDifference(id: string): ReconcileFindingView {
  return { id, code: 'identity_mismatch', severity: 'blocker', detail: 'Evidence requires review.',
    advice: { action: 'review', requiresHuman: true, why: 'Review this finding.' }, evidence: [] }
}

async function resolve(item: ReconcileReviewItem, requestId: string) {
  return h!.k.ops.call(h!.k, 'reconcile.resolve', { principal: h!.session, pin: TEST_PIN, transport: 'http', params: {
    accountId: item.accountId, itemId: item.itemId, evidenceDigest: item.evidenceDigest,
    action: 'acknowledge', reason: 'Reviewed retained evidence.', requestId,
  } })
}

describe('P1-2 reconcile resolution status projection', () => {
  it('removes resolved blockers from status only after every blocker is acknowledged, while keeping review history immutable', async () => {
    h = await makeHarness()
    await h.pinProof()
    const findings = [knownDifference('finding-a'), knownDifference('finding-b')]
    const items = findings.map((finding) => h!.k.trading.reconcileReviews.record({ accountId: h!.paper.accountId,
      kind: 'known_difference', observedAt: h!.clock.now(), summary: 'Blocking evidence.', blocking: true, finding }))
    cachedView({ accountId: h.paper.accountId, state: 'ready', verdict: 'blocked', findings, suggestions: [] })
    const accountScope = { type: 'account', id: h.paper.accountId } as const

    await resolve(items[0]!, 'resolve-one')
    expect(() => h!.k.trading.assertReconciliationResolved([h!.paper.accountId])).toThrow()
    const partial = h.k.reconcileService.get(h.paper.accountId)[0]!
    expect(partial.verdict).toBe('blocked')
    expect(partial.findings.filter((finding) => finding.severity === 'blocker').map((finding) => finding.id)).toEqual(['finding-b'])
    expect(partial.reviews?.find((review) => review.itemId === items[0]!.itemId)).toMatchObject({ blocking: true, resolution: { input: { action: 'acknowledge' } } })
    h.k.tstate.set(accountScope, 'HALTED', 'reconcile review pending', h.human().origin, await h.pinProof())
    await expect(h.k.ops.call(h.k, 'trading_state.resume', { principal: h.session, pin: TEST_PIN, transport: 'http',
      params: { scope: accountScope, reason: 'resume after first review' } })).rejects.toMatchObject({ problem: { name: 'TRADING_STATE' } })

    await resolve(items[1]!, 'resolve-two')
    const final = h.k.reconcileService.get(h.paper.accountId)[0]!
    expect(final.findings.filter((finding) => finding.severity === 'blocker')).toEqual([])
    expect(final.verdict).toBe('clean')
    expect(final.reviews?.filter((review) => review.blocking)).toHaveLength(2)
    expect(final.reviews?.every((review) => review.blocking && review.resolution !== undefined)).toBe(true)
    expect(() => h!.k.trading.assertReconciliationResolved([h!.paper.accountId])).not.toThrow()
  })

  it('clears a resolved confirmation safety overlay without claiming a fresh venue capture', async () => {
    h = await makeHarness()
    await h.pinProof()
    const intent: OrderIntent = { accountId: h.paper.accountId as never, instrumentId: BTC as never,
      side: 'buy', type: 'limit', size: '0.012' as never, price: '80000' as never, tif: 'gtc',
      clientOrderId: '0123456789abcdef0123456789abcdef' as never }
    const placed = await h.k.trading.place({ intent }, h.human())
    const order = placed.order
    if (!order?.venueOrderId) throw new Error('test order was not linked to venue identity')
    const input: ReconcileConfirmInput = { accountId: h.paper.accountId as never, offerId: `offer_${order.orderId}`,
      reportId: `report_${order.orderId}`, suggestionId: `suggestion_${order.orderId}`,
      fee: '0.0001' as never, feeCcy: 'USDC', liquidity: 'taker', realizedPnl: '0' as never }
    const suggestion: ReconcileSuggestion = { id: input.suggestionId, orderId: order.orderId as never,
      venueOrderId: order.venueOrderId, clientOrderId: order.clientOrderId as never, instrumentId: BTC as never,
      side: 'buy', size: '0.00001' as never, price: '80000' as never, ts: h.clock.now(),
      priceSource: 'venue_avg_fill_price', basis: ['stable reconciliation source'], inferred: true }
    const inference = h.k.trading.reconcileReviews.record({ accountId: input.accountId, kind: 'inferred_fill',
      observedAt: h.clock.now(), summary: 'Inference requires review.', blocking: true, suggestion,
      localFillsDigest: digestOf(h.k.orders.fillsForOrder(input.accountId, order.orderId)) })
    const fill: Fill = { fillId: 'fill_review001' as never, orderId: order.orderId as never,
      clientOrderId: order.clientOrderId as never, venueFillId: `inferred_${digestOf([input.accountId, input.suggestionId]).slice('sha256:'.length)}`,
      accountId: input.accountId, instrumentId: BTC as never, side: 'buy', price: suggestion.price,
      size: suggestion.size, fee: input.fee, feeCcy: input.feeCcy, liquidity: input.liquidity,
      realizedPnl: input.realizedPnl, ts: suggestion.ts,
      inferred: { suggestionId: input.suggestionId, reportId: input.reportId, confirmedAt: h.clock.now(),
        confirmedBy: 'user:usr_local', priceSource: suggestion.priceSource, basisDigest: digestOf(suggestion.basis) } }
    const valid = validateFill(fill)
    if (!valid.ok) throw new Error('confirmation fixture fill is invalid')
    const onFill = vi.spyOn(h.k.protectors, 'onFill').mockImplementation(() => { throw new Error('injected follow-up failure') })
    const applyConfirmed = h.k.trading.applyConfirmedFill as unknown as (f: Fill, o: Origin, i: ReconcileConfirmInput, reviewItemId?: string) => unknown
    applyConfirmed.call(h.k.trading, fill, h.human('reconcile.confirm').origin, input, inference.itemId)
    onFill.mockRestore()
    const effects = h.k.trading.recoveryReviews(input.accountId).find((review) => review.kind === 'confirmation_effects')!
    const safetyView = h.k.reconcileService.get(input.accountId)[0]!
    expect(safetyView).toMatchObject({ state: 'unavailable', verdict: 'blocked', problem: { name: 'VENUE_OUTCOME_UNKNOWN' } })
    cachedView(safetyView)

    await resolve(effects, 'resolve-confirm-effects')
    const final = h.k.reconcileService.get(input.accountId)[0]!
    expect(h.k.trading.confirmationPending(input.accountId)).toBe(false)
    expect(final.state).toBe('idle')
    expect(final.findings.some((finding) => finding.code === 'CONFIRMATION_EFFECTS_PENDING')).toBe(false)
    expect(final.verdict).not.toBe('blocked')
    expect(final.problem).toBeUndefined()
    expect(final.reviews?.find((review) => review.itemId === effects.itemId)).toMatchObject({ blocking: true, resolution: { input: { action: 'acknowledge' } } })
  })
})
