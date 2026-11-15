// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest'
import {
  validateReconcileAccountView,
  validateReconcileResolutionInput,
  validateReconcileResolutionReceipt,
  validateReconcileResolveResult,
  validateReconcileReviewItem,
  formatIssues,
} from '../src/validate'

const digest = `sha256:${'a'.repeat(64)}`
const accountId = 'acct_abc'
const input = {
  accountId,
  itemId: 'review-1',
  evidenceDigest: digest,
  action: 'acknowledge' as const,
  reason: 'Reviewed evidence',
  requestId: 'request-1',
}
const receipt = { resolutionId: 'resolution-1', input, resolvedAt: 100, resolvedBy: 'user:local' }
const fill = {
  fillId: 'fill_abc', orderId: 'ord_abc', clientOrderId: 'b'.repeat(32), venueFillId: 'venue-fill-1', accountId,
  instrumentId: 'venue:instrument', side: 'buy', price: '10', size: '2', fee: '0', feeCcy: 'USD',
  liquidity: 'maker', realizedPnl: '0', ts: 90,
}
const review = {
  itemId: 'review-1', accountId, kind: 'late_real_fill', evidenceDigest: digest, observedAt: 100,
  summary: 'Late evidence observed', blocking: true,
}
const confirmedReview = {
  ...review, kind: 'inferred_fill' as const, confirmedFillId: fill.fillId, fill,
  suggestion: { id: 'suggestion-1', orderId: 'ord_abc', venueOrderId: 'venue-order-1', clientOrderId: 'b'.repeat(32),
    instrumentId: 'venue:instrument', side: 'buy' as const, size: '2', price: '10', ts: 90,
    priceSource: 'venue_avg_fill_price' as const, basis: [], inferred: true as const },
  confirmation: { input: { accountId, offerId: 'offer-1', reportId: 'report-1', suggestionId: 'suggestion-1', fee: '0', feeCcy: 'USD', liquidity: 'maker' as const, realizedPnl: '0' },
    fillId: fill.fillId, confirmedAt: 100, confirmedBy: 'user:local', effectsState: 'complete' as const },
}
const view = { accountId, state: 'ready', findings: [], suggestions: [] }

describe('reconciliation resolution protocol', () => {
  it('accepts pending, resolved, and confirmed review snapshots', () => {
    expect(validateReconcileAccountView({ ...view, reviews: [review] }).ok).toBe(true)
    expect(validateReconcileAccountView({ ...view, reviews: [{ ...review, resolution: receipt }] }).ok).toBe(true)
    const confirmedView = validateReconcileAccountView({ ...view, reviews: [confirmedReview] })
    expect(confirmedView.ok, confirmedView.ok ? '' : formatIssues(confirmedView.issues)).toBe(true)
    expect(validateReconcileReviewItem({ ...review, resolution: receipt }).ok).toBe(true)
    expect(validateReconcileReviewItem(confirmedReview).ok).toBe(true)
  })

  it('keeps legacy account views valid without reviews', () => {
    expect(validateReconcileAccountView(view).ok).toBe(true)
  })

  it('validates each resolution payload schema', () => {
    expect(validateReconcileResolutionInput(input).ok).toBe(true)
    expect(validateReconcileResolutionReceipt(receipt).ok).toBe(true)
    expect(validateReconcileResolveResult({ receipt, alreadyRecorded: true }).ok).toBe(true)
  })

  it('rejects invalid actions, prefixed digests, and empty required identifiers', () => {
    expect(validateReconcileResolutionInput({ ...input, action: 'skip' }).ok).toBe(false)
    expect(validateReconcileResolutionInput({ ...input, evidenceDigest: 'a'.repeat(64) }).ok).toBe(false)
    expect(validateReconcileResolutionInput({ ...input, requestId: '' }).ok).toBe(false)
    expect(validateReconcileResolutionInput({ ...input, requestId: 'r'.repeat(129) }).ok).toBe(false)
    expect(validateReconcileResolutionInput({ ...input, reason: '' }).ok).toBe(false)
    expect(validateReconcileResolutionInput({ ...input, reason: 'r'.repeat(501) }).ok).toBe(false)
    expect(validateReconcileResolutionInput({ ...input, extra: true }).ok).toBe(false)
  })

  it('rejects unknown review fields and numeric financial values', () => {
    expect(validateReconcileReviewItem({ ...review, extra: true }).ok).toBe(false)
    expect(validateReconcileReviewItem({ ...review, kind: 'inferred_fill', fill: { ...fill, price: 10 } }).ok).toBe(false)
  })
})
