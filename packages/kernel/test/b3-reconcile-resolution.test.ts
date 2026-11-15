// SPDX-License-Identifier: CPAL-1.0
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'node:net'
import type { OrderIntent, ReconcileConfirmInput, ReconcileFindingView, ReconcileResolutionInput, ReconcileReviewItem } from '../src/proto'
import { asDecimal } from '../src/proto'
import { Kernel } from '../src/kernel'
import { fileProvider } from '../src/device-key'
import { startHttp } from '../src/http/server'
import { FAST_SCRYPT, makeAgent, makeHarness, TEST_PIN } from './helpers/harness'
import type { Harness } from './helpers/harness'
import { newClientOrderId } from '../src/util/ids'
import type { VenueFill } from '@gitrader/protocol/connector'

async function observedGap(h: Harness): Promise<{ input: ReconcileConfirmInput; view: { offerId?: string; reportId?: string; suggestions: Array<{ id: string }>; findings: Array<{ code: string }> } }> {
  await h.pinProof()
  const intent: OrderIntent = { accountId: h.paper.accountId as never, instrumentId: 'hyperliquid:BTC' as never,
    side: 'buy', type: 'limit', size: asDecimal('0.012'), price: asDecimal('80000'), tif: 'gtc', clientOrderId: newClientOrderId() }
  const placed = await h.k.ops.call(h.k, 'order.place', { principal: h.session, params: { intent }, pin: TEST_PIN, transport: 'http' }) as { order?: { orderId: string; clientOrderId: string; venueOrderId?: string; accountId: string; instrumentId: string } }
  const order = placed.order
  if (!order?.venueOrderId) throw new Error('real local placement returned no venue order identity')
  h.k.trading.onVenueFill(order.accountId, { venueOrderId: order.venueOrderId, clientOrderId: order.clientOrderId,
    venueFillId: `resolution-fixture-${order.orderId}`, instrumentId: order.instrumentId as never, side: 'buy',
    price: asDecimal('80000'), size: asDecimal('0.001'), fee: asDecimal('0.0001'), feeCcy: 'USDC',
    liquidity: 'maker', realizedPnl: asDecimal('0'), ts: h.clock.now() })
  h.sim.openOrdersOverride = [{ instrumentId: order.instrumentId as never, venueOrderId: order.venueOrderId,
    clientOrderId: order.clientOrderId as never, side: 'buy', type: 'limit', price: asDecimal('80000'), triggerPrice: null,
    size: asDecimal('0.01'), origSize: asDecimal('0.012'), reduceOnly: false, isTrigger: false, createdAt: 0 }]
  h.sim.positions.set(order.accountId, [{ accountId: order.accountId as never, instrumentId: order.instrumentId as never,
    side: 'long', size: asDecimal('0.002'), entryPrice: asDecimal('80000'), markPrice: asDecimal('80000'),
    notional: asDecimal('160'), unrealizedPnl: asDecimal('0'), realizedPnl: asDecimal('0'), leverage: 2,
    marginMode: 'cross', liquidationPrice: null, fundingSinceOpen: asDecimal('0'), openedAt: h.clock.now(), updatedAt: h.clock.now() }])
  const view = await h.k.reconcileService.refresh(order.accountId)
  const suggestion = view.suggestions[0]
  if (!view.offerId || !view.reportId || !suggestion) throw new Error(`fresh observed gap produced no offer (${view.state})`)
  return { view, input: { accountId: order.accountId as never, offerId: view.offerId, reportId: view.reportId,
    suggestionId: suggestion.id, fee: asDecimal('0'), feeCcy: 'USDC', liquidity: 'maker', realizedPnl: asDecimal('0') } }
}

async function acknowledgePendingFindings(h: Harness, accountId: string): Promise<void> {
  const pending = h.k.trading.reconcileReviews.list(accountId).filter((item) => item.kind === 'known_difference'
    && item.blocking && item.resolution === undefined && item.confirmedFillId === undefined)
  for (const [index, item] of pending.entries()) {
    await h.k.ops.call(h.k, 'reconcile.resolve', { principal: h.session, pin: TEST_PIN, transport: 'http', params: {
      accountId, itemId: item.itemId, evidenceDigest: item.evidenceDigest, action: 'acknowledge',
      reason: 'Reviewed the captured finding.', requestId: `finding-ack-${index + 1}-${item.itemId.slice(-8)}`,
    } })
  }
}

function lateVenueFill(order: { accountId: string; orderId: string; clientOrderId: string; venueOrderId: string; instrumentId: string }, id: string, size: string, ts: number): VenueFill {
  return { venueFillId: id, venueOrderId: order.venueOrderId, clientOrderId: order.clientOrderId,
    instrumentId: order.instrumentId as never, side: 'buy', price: asDecimal('81000'), size: asDecimal(size),
    fee: asDecimal('0.0001'), feeCcy: 'USDC', liquidity: 'maker', realizedPnl: asDecimal('0'), ts }
}

async function confirmObservedGap(h: Harness): Promise<{ order: { accountId: string; orderId: string; clientOrderId: string; venueOrderId: string; instrumentId: string }; input: ReconcileConfirmInput; fillId: string; review: ReconcileReviewItem }> {
  const observed = await observedGap(h)
  const review = h.k.trading.reconcileReviews.list(observed.input.accountId).find((item) => item.kind === 'inferred_fill' && item.suggestion?.id === observed.input.suggestionId)
  if (!review) throw new Error('observed inference review was not persisted')
  const orderId = review.suggestion!.orderId
  const current = h.k.orders.get(orderId)
  if (!current?.venueOrderId) throw new Error('confirmed review no longer identifies its linked local order')
  h.clock.advance(10_000)
  const result = await h.k.ops.call(h.k, 'reconcile.confirm', { principal: h.session, pin: TEST_PIN, transport: 'http', params: observed.input }) as { fillId: string }
  return { order: { accountId: current.accountId, orderId: current.orderId, clientOrderId: current.clientOrderId,
    venueOrderId: current.venueOrderId, instrumentId: current.instrumentId }, input: observed.input, fillId: result.fillId, review }
}

describe('B3-R1 public reconciliation resolution', () => {
  let h: Harness | undefined
  afterEach(async () => { await h?.cleanup(); h = undefined })

  it('routes a strict session-and-PIN acknowledgement through the durable store', async () => {
    h = await makeHarness()
    await h.pinProof()
    const finding: ReconcileFindingView = {
      id: 'finding-known-difference', code: 'position_difference', severity: 'warn',
      detail: 'The observed positions differ.',
      advice: { action: 'review', requiresHuman: true, why: 'Review the observed difference.' }, evidence: [],
    }
    const item = h.k.trading.reconcileReviews.record({ accountId: h.paper.accountId, kind: 'known_difference',
      observedAt: h.clock.now(), summary: 'Observed position difference.', blocking: false, finding })
    const input: ReconcileResolutionInput = {
      accountId: h.paper.accountId, itemId: item.itemId, evidenceDigest: item.evidenceDigest,
      action: 'acknowledge', reason: 'Reviewed the original evidence.', requestId: 'request-resolution-1',
    }
    const op = h.k.ops.spec('reconcile.resolve')
    expect(op).toMatchObject({ auth: 'session', presence: 'pin', kind: 'command' })
    await expect(h.k.ops.call(h.k, 'reconcile.resolve', {
      principal: h.session, params: input, transport: 'http',
    })).rejects.toMatchObject({ problem: { name: 'ATTESTATION_REQUIRED' } })
    const result = await h.k.ops.call(h.k, 'reconcile.resolve', {
      principal: h.session, params: input, pin: TEST_PIN, transport: 'http',
    })
    expect(result).toMatchObject({ alreadyRecorded: false, receipt: { input, resolvedBy: 'user:usr_local' } })
    expect(h.k.trading.reconcileReviews.get(input.accountId, item.itemId)?.resolution).toEqual((result as { receipt: unknown }).receipt)
    expect(h.k.reconcileService.get(input.accountId)[0]?.reviews).toContainEqual(expect.objectContaining({ itemId: item.itemId }))
    const ledgerBeforeRepeat = h.k.ledger.head()
    const repeated = await h.k.ops.call(h.k, 'reconcile.resolve', {
      principal: h.session, params: { requestId: input.requestId, reason: input.reason, action: input.action,
        evidenceDigest: input.evidenceDigest, itemId: input.itemId, accountId: input.accountId }, pin: TEST_PIN, transport: 'http',
    })
    expect(repeated).toMatchObject({ alreadyRecorded: true, receipt: (result as { receipt: unknown }).receipt })
    expect(h.k.ledger.head()).toEqual(ledgerBeforeRepeat)
  })

  it('rejects unknown fields at the public operation boundary', async () => {
    h = await makeHarness()
    await h.pinProof()
    await expect(h.k.ops.call(h.k, 'reconcile.resolve', {
      principal: h.session, params: { accountId: h.paper.accountId, itemId: 'rri_missing', evidenceDigest: 'sha256:bad',
        action: 'acknowledge', reason: 'Review', requestId: 'request-extra', extra: true }, pin: TEST_PIN, transport: 'http',
    })).rejects.toMatchObject({ problem: { name: 'INVALID_PARAMS' } })
  })

  it('keeps both real resume aliases blocked before any state write while a blocking review is pending', async () => {
    h = await makeHarness()
    const proof = await h.pinProof()
    const finding: ReconcileFindingView = {
      id: 'finding-blocking-difference', code: 'identity_mismatch', severity: 'blocker',
      detail: 'The local and venue identities differ.',
      advice: { action: 'review', requiresHuman: true, why: 'Resolve the evidence before resuming.' }, evidence: [],
    }
    h.k.trading.reconcileReviews.record({ accountId: h.paper.accountId, kind: 'known_difference',
      observedAt: h.clock.now(), summary: 'Blocking identity difference.', blocking: true, finding })
    const scope = { type: 'account', id: h.paper.accountId } as const
    h.k.tstate.set(scope, 'HALTED', 'test recovery pending', h.human().origin, proof)
    const ledgerBefore = h.k.ledger.head()
    for (const name of ['trading_state.resume', 'risk.resume']) {
      await expect(h.k.ops.call(h.k, name, {
        principal: h.session, params: { scope, reason: 'resume after review' }, pin: TEST_PIN, transport: 'http',
      })).rejects.toMatchObject({ problem: { name: 'TRADING_STATE' } })
      expect(h.k.tstate.get(scope)).toBe('HALTED')
    }
    expect(h.k.ledger.head()).toEqual(ledgerBefore)
  })

  it('returns a fixed unavailable status when a persisted review is corrupt', async () => {
    h = await makeHarness()
    const finding: ReconcileFindingView = {
      id: 'finding-corrupt-review', code: 'position_difference', severity: 'warn', detail: 'Observed difference.',
      advice: { action: 'review', requiresHuman: true, why: 'Review the evidence.' }, evidence: [],
    }
    const item = h.k.trading.reconcileReviews.record({ accountId: h.paper.accountId, kind: 'known_difference',
      observedAt: h.clock.now(), summary: 'Corruption probe.', blocking: false, finding })
    h.k.docs.put('reconcile-review-item', item.itemId, { ...item, summary: 77 })
    const view = h.k.reconcileService.get(h.paper.accountId)[0]
    expect(view).toMatchObject({ state: 'unavailable', verdict: 'blocked', problem: { name: 'STATE_FILE_CORRUPT' }, suggestions: [] })
    expect(JSON.stringify(view)).not.toContain('summary":77')
  })

  it('keeps status readable with a corrupt confirmation marker and reports fixed corruption state', async () => {
    h = await makeHarness()
    h.k.docs.put('reconcile-confirm-pending', h.paper.accountId, 'corrupt-sentinel')
    const view = h.k.reconcileService.get(h.paper.accountId)[0]
    expect(view).toMatchObject({ state: 'unavailable', verdict: 'blocked', problem: { name: 'STATE_FILE_CORRUPT' }, suggestions: [] })
    expect(view?.offerId).toBeUndefined()
    expect(view?.findings).toContainEqual(expect.objectContaining({ code: 'CONFIRMATION_EFFECTS_PENDING', severity: 'blocker' }))
    expect(JSON.stringify(view)).not.toContain('corrupt-sentinel')
  })

  it('rejects the observed candidate, clears its cached offer, and keeps the same evidence suppressed', async () => {
    h = await makeHarness()
    const { input, view } = await observedGap(h)
    const item = h.k.trading.reconcileReviews.list(input.accountId).find((candidate) => candidate.kind === 'inferred_fill')
    expect(item?.suggestion?.id).toBe(input.suggestionId)
    const fillsBefore = h.k.orders.fills({ accountId: input.accountId, limit: 1000 }).length
    const financialLedgerBefore = h.k.ledger.query({ types: ['fill'], accountId: input.accountId }).length
    const rejected = await h.k.ops.call(h.k, 'reconcile.resolve', {
      principal: h.session, pin: TEST_PIN, transport: 'http', params: { accountId: input.accountId,
        itemId: item!.itemId, evidenceDigest: item!.evidenceDigest, action: 'reject',
        reason: 'The observed inference is not accepted.', requestId: 'reject-observed-gap-1' },
    })
    expect(rejected).toMatchObject({ alreadyRecorded: false })
    const immediate = h.k.reconcileService.get(input.accountId)[0]
    expect(immediate?.offerId).toBeUndefined()
    expect(immediate?.suggestions).toEqual([])
    expect(immediate?.findings.some((finding) => finding.code === 'fill_missing_inferred')).toBe(true)
    expect(h.k.trading.reconcileReviews.get(input.accountId, item!.itemId)).toMatchObject({
      suggestion: { id: input.suggestionId }, resolution: { input: { action: 'reject' } },
    })

    h.clock.advance(10_000)
    const next = await h.k.reconcileService.refresh(input.accountId)
    expect(next).toMatchObject({ suggestions: [] })
    expect(next.offerId).toBeUndefined()
    await expect(h.k.ops.call(h.k, 'reconcile.confirm', {
      principal: h.session, pin: TEST_PIN, transport: 'http', params: input,
    })).rejects.toMatchObject({ problem: { name: 'INVALID_PARAMS' } })
    expect(h.k.orders.fills({ accountId: input.accountId, limit: 1000 })).toHaveLength(fillsBefore)
    expect(h.k.ledger.query({ types: ['fill'], accountId: input.accountId })).toHaveLength(financialLedgerBefore)
    expect(view.offerId).toBe(input.offerId)
  })

  it('confirms a valid observed inference through the public operation and binds its review', async () => {
    h = await makeHarness()
    const { input } = await observedGap(h)
    const item = h.k.trading.reconcileReviews.list(input.accountId).find((candidate) => candidate.kind === 'inferred_fill')
    expect(item?.suggestion?.id).toBe(input.suggestionId)
    const fillsBefore = h.k.orders.fills({ accountId: input.accountId, limit: 1000 }).length
    h.clock.advance(10_000)
    const result = await h.k.ops.call(h.k, 'reconcile.confirm', {
      principal: h.session, pin: TEST_PIN, transport: 'http', params: input,
    }) as { fillId: string; alreadyRecorded: boolean }
    expect(result).toMatchObject({ alreadyRecorded: false })
    expect(h.k.orders.fills({ accountId: input.accountId, limit: 1000 })).toHaveLength(fillsBefore + 1)
    expect(h.k.trading.reconcileReviews.get(input.accountId, item!.itemId)).toMatchObject({ confirmedFillId: result.fillId })
  })

  it('requires individual late acknowledgements before either resume alias can restore the account', async () => {
    h = await makeHarness()
    const harness = h
    await h.pinProof()
    const confirmed = await confirmObservedGap(h)
    await acknowledgePendingFindings(h, confirmed.order.accountId)
    expect(h.k.trading.reconcileReviews.get(confirmed.order.accountId, confirmed.review.itemId)).toMatchObject({ confirmedFillId: confirmed.fillId })
    const orderEconomicsBefore = h.k.orders.get(confirmed.order.orderId)
    const fillsBefore = h.k.orders.fills({ accountId: confirmed.order.accountId, limit: 1000 })
    const financialLedgerBefore = h.k.ledger.query({ types: ['fill'], accountId: confirmed.order.accountId, limit: 1000 })
    const ledgerPrefixBefore = h.k.db.prepare('SELECT seq, entry FROM ledger ORDER BY seq').all() as Array<{ seq: number; entry: string }>
    const firstLate = lateVenueFill(confirmed.order, 'late-two-item-01', '0.001', h.clock.now() + 1)
    const secondLate = lateVenueFill(confirmed.order, 'late-two-item-02', '0.002', h.clock.now() + 2)
    h.k.trading.onVenueFill(confirmed.order.accountId, firstLate)
    h.k.trading.onVenueFill(confirmed.order.accountId, secondLate)
    const lateViews = await h.k.ops.call(h.k, 'reconcile.status', {
      principal: h.session, params: { accountId: confirmed.order.accountId }, transport: 'http', kind: 'query',
    }) as Array<{ reviews?: ReconcileReviewItem[] }>
    let lateItems = lateViews[0]?.reviews?.filter((item) => item.kind === 'late_real_fill') ?? []
    expect(lateItems).toHaveLength(2)
    const initialPrefix = h.k.tstate.get({ type: 'org', id: 'org_local' })

    const resolveLate = async (item: ReconcileReviewItem, suffix: string) => harness.k.ops.call(harness.k, 'reconcile.resolve', {
      principal: harness.session, pin: TEST_PIN, transport: 'http', params: { accountId: confirmed.order.accountId,
        itemId: item.itemId, evidenceDigest: item.evidenceDigest, action: 'acknowledge',
        reason: 'Reviewed this distinct late fill.', requestId: `late-ack-${suffix}` },
    })
    await resolveLate(lateItems[0]!, 'one')
    const paperScope = { type: 'account', id: confirmed.order.accountId } as const
    for (const name of ['trading_state.resume', 'risk.resume']) {
      await expect(h.k.ops.call(h.k, name, { principal: h.session, pin: TEST_PIN, transport: 'http',
        params: { scope: paperScope, reason: 'resume after first late acknowledgement' } }))
        .rejects.toMatchObject({ problem: { name: 'TRADING_STATE' } })
      expect(h.k.tstate.get(paperScope)).toBe('HALTED')
    }
    const otherScope = { type: 'account', id: h.liveAcct.accountId } as const
    await expect(h.k.ops.call(h.k, 'trading_state.resume', { principal: h.session, pin: TEST_PIN, transport: 'http',
      params: { scope: otherScope, reason: 'resume unaffected account' } })).resolves.toMatchObject({ to: 'ACTIVE' })
    expect(h.k.tstate.get({ type: 'org', id: 'org_local' })).toBe(initialPrefix)

    await resolveLate(lateItems[1]!, 'two')
    expect(h.k.tstate.get(paperScope)).toBe('HALTED')
    await expect(h.k.ops.call(h.k, 'trading_state.resume', { principal: h.session, pin: TEST_PIN, transport: 'http',
      params: { scope: paperScope, reason: 'resume after both acknowledgements' } })).resolves.toMatchObject({ to: 'ACTIVE' })
    expect(h.k.tstate.get(paperScope)).toBe('ACTIVE')

    h.k.trading.onVenueFill(confirmed.order.accountId, firstLate)
    const afterViews = await h.k.ops.call(h.k, 'reconcile.status', {
      principal: h.session, params: { accountId: confirmed.order.accountId }, transport: 'http', kind: 'query',
    }) as Array<{ reviews?: ReconcileReviewItem[] }>
    lateItems = afterViews[0]?.reviews?.filter((item) => item.kind === 'late_real_fill') ?? []
    expect(lateItems).toHaveLength(2)
    expect(lateItems.every((item) => item.resolution !== undefined)).toBe(true)
    expect(h.k.tstate.get(paperScope)).toBe('ACTIVE')
    expect(h.k.orders.fills({ accountId: confirmed.order.accountId, limit: 1000 })).toEqual(fillsBefore)
    expect(h.k.ledger.query({ types: ['fill'], accountId: confirmed.order.accountId, limit: 1000 })).toEqual(financialLedgerBefore)
    expect(h.k.orders.get(confirmed.order.orderId)).toMatchObject({
      filledSize: orderEconomicsBefore?.filledSize, avgFillPrice: orderEconomicsBefore?.avgFillPrice,
      fee: orderEconomicsBefore?.fee, size: orderEconomicsBefore?.size, price: orderEconomicsBefore?.price,
    })
    const ledgerAfter = h.k.db.prepare('SELECT seq, entry FROM ledger ORDER BY seq').all() as Array<{ seq: number; entry: string }>
    expect(ledgerAfter.slice(0, ledgerPrefixBefore.length)).toEqual(ledgerPrefixBefore)
  })

  it('blocks the final ACTIVE transition when new late evidence arrives during deadman disarm', async () => {
    h = await makeHarness()
    await h.pinProof()
    const confirmed = await confirmObservedGap(h)
    await acknowledgePendingFindings(h, confirmed.order.accountId)
    const firstLate = lateVenueFill(confirmed.order, 'late-resume-race-01', '0.001', h.clock.now() + 1)
    h.k.trading.onVenueFill(confirmed.order.accountId, firstLate)
    const initial = h.k.trading.reconcileReviews.list(confirmed.order.accountId).find((item) => item.kind === 'late_real_fill')
    if (!initial) throw new Error('the first authentic late fill was not persisted')
    await h.k.ops.call(h.k, 'reconcile.resolve', { principal: h.session, pin: TEST_PIN, transport: 'http', params: {
      accountId: confirmed.order.accountId, itemId: initial.itemId, evidenceDigest: initial.evidenceDigest,
      action: 'acknowledge', reason: 'Reviewed the first late fill.', requestId: 'late-race-ack-first',
    } })
    const fillsBeforeRace = h.k.orders.fills({ accountId: confirmed.order.accountId, limit: 1000 })
    const financialLedgerBeforeRace = h.k.ledger.query({ types: ['fill'], accountId: confirmed.order.accountId, limit: 1000 })
    let reachedDisarm!: () => void
    let releaseDisarm!: () => void
    const disarmReached = new Promise<void>((resolve) => { reachedDisarm = resolve })
    const disarmGate = new Promise<void>((resolve) => { releaseDisarm = resolve })
    const disarmSpy = vi.spyOn(h.k.deadman, 'disarmAfterResume').mockImplementation(async () => {
      reachedDisarm()
      await disarmGate
    })
    const scope = { type: 'account', id: confirmed.order.accountId } as const
    let resumeError: unknown
    try {
      const resume = h.k.ops.call(h.k, 'trading_state.resume', { principal: h.session, pin: TEST_PIN, transport: 'http',
        params: { scope, reason: 'resume while late evidence changes' } }).catch((error: unknown) => { resumeError = error })
      await disarmReached
      const secondLate = lateVenueFill(confirmed.order, 'late-resume-race-02', '0.002', h.clock.now() + 2)
      h.k.trading.onVenueFill(confirmed.order.accountId, secondLate)
      releaseDisarm()
      await resume
    } finally {
      releaseDisarm()
      disarmSpy.mockRestore()
    }
    expect(resumeError).toMatchObject({ problem: { name: 'TRADING_STATE' } })
    expect(h.k.tstate.get(scope)).toBe('HALTED')
    const reviews = h.k.trading.reconcileReviews.list(confirmed.order.accountId)
    expect(reviews.find((item) => item.itemId === initial.itemId)?.resolution?.input.action).toBe('acknowledge')
    expect(reviews.filter((item) => item.kind === 'late_real_fill' && item.resolution === undefined)).toHaveLength(1)
    expect(h.k.orders.fills({ accountId: confirmed.order.accountId, limit: 1000 })).toEqual(fillsBeforeRace)
    expect(h.k.ledger.query({ types: ['fill'], accountId: confirmed.order.accountId, limit: 1000 })).toEqual(financialLedgerBeforeRace)
  })

  it('requires real HTTP session authority and returns only a clean receipt for a captured review', async () => {
    h = await makeHarness()
    const { input } = await observedGap(h)
    const item = h.k.trading.reconcileReviews.list(input.accountId).find((candidate) => candidate.kind === 'inferred_fill')
    if (!item) throw new Error('captured inference review was not persisted')
    const server = await startHttp(h.k, { port: 0 })
    try {
      const address = server.server.address() as AddressInfo
      const host = address.family === 'IPv6' ? `[${address.address}]` : address.address
      const endpoint = `http://${host}:${address.port}`
      const bootstrap = h.k.auth.mintBootToken()
      const sessionResponse = await fetch(`${endpoint}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ bootstrap }) })
      const sessionBody = await sessionResponse.json() as { sessionToken?: string }
      expect(sessionResponse.status).toBe(200)
      if (!sessionBody.sessionToken) throw new Error('HTTP bootstrap did not issue a session')
      const sessionHeaders = { authorization: `Bearer ${sessionBody.sessionToken}`, 'content-type': 'application/json' }
      const serviceToken = h.k.auth.rotateServiceToken()
      const agent = await makeAgent(h, 'paper')
      const resolution: ReconcileResolutionInput = { accountId: input.accountId, itemId: item.itemId,
        evidenceDigest: item.evidenceDigest, action: 'reject', reason: 'Reviewed the captured inference.', requestId: 's3-http-resolution' }
      const fillsBefore = h.k.orders.fills({ accountId: input.accountId, limit: 1000 })
      const stateBefore = h.k.tstate.get({ type: 'account', id: input.accountId })
      const denied: Array<{ status: number; name?: string }> = []
      const post = async (headers: Record<string, string>, params: unknown, pin?: string) => {
        const response = await fetch(`${endpoint}/api/op/reconcile.resolve`, { method: 'POST',
          headers: { ...headers, ...(pin === undefined ? {} : { 'x-gitrader-pin': pin }) },
          body: JSON.stringify({ params }) })
        return { status: response.status, body: await response.json() as { result?: unknown; error?: { name?: string; message?: string } } }
      }
      for (const attempt of [
        await post({ 'content-type': 'application/json' }, resolution, TEST_PIN),
        await post(sessionHeaders, resolution),
        await post(sessionHeaders, resolution, '000000'),
        await post({ authorization: `Bearer ${serviceToken}`, 'content-type': 'application/json' }, resolution, TEST_PIN),
        await post({ authorization: `Bearer ${agent.token}`, 'content-type': 'application/json' }, resolution, TEST_PIN),
      ]) denied.push({ status: attempt.status, name: attempt.body.error?.name })
      expect(denied.map((attempt) => attempt.name)).toEqual(['AUTH_FAILED', 'ATTESTATION_REQUIRED', 'AUTH_FAILED', 'AUTH_FAILED', 'AUTH_FAILED'])
      expect(denied.every((attempt) => attempt.status >= 400)).toBe(true)
      expect(h.k.trading.reconcileReviews.get(input.accountId, item.itemId)?.resolution).toBeUndefined()
      expect(h.k.orders.fills({ accountId: input.accountId, limit: 1000 })).toEqual(fillsBefore)
      expect(h.k.tstate.get({ type: 'account', id: input.accountId })).toBe(stateBefore)

      const malformed: unknown[] = [
        { ...resolution, accountId: 7 },
        [resolution],
        { ...resolution, extra: true, secretProbe: 's3-input-canary' },
        { ...resolution, evidenceDigest: 'sha256:s3-bad-digest' },
        { ...resolution, reason: '   ' },
      ]
      const invalidResults = [] as Array<{ status: number; name?: string; body: string }>
      for (const params of malformed) {
        const response = await post(sessionHeaders, params, TEST_PIN)
        invalidResults.push({ status: response.status, name: response.body.error?.name, body: JSON.stringify(response.body) })
      }
      expect(invalidResults.every((result) => result.status === 400 && result.name === 'INVALID_PARAMS')).toBe(true)
      expect(invalidResults.every((result) => !result.body.includes('s3-input-canary') && !result.body.includes(item.itemId))).toBe(true)
      expect(h.k.trading.reconcileReviews.get(input.accountId, item.itemId)?.resolution).toBeUndefined()
      expect(h.k.orders.fills({ accountId: input.accountId, limit: 1000 })).toEqual(fillsBefore)

      const accepted = await post(sessionHeaders, resolution, TEST_PIN)
      expect(accepted.status).toBe(200)
      expect(accepted.body.result).toMatchObject({ alreadyRecorded: false, receipt: { input: resolution } })
      const statusResponse = await fetch(`${endpoint}/api/op/reconcile.status`, { method: 'POST', headers: sessionHeaders,
        body: JSON.stringify({ params: { accountId: input.accountId } }) })
      const statusBody = await statusResponse.json() as { result?: Array<{ reviews?: ReconcileReviewItem[] }> }
      expect(statusResponse.status).toBe(200)
      expect(statusBody.result?.[0]?.reviews?.find((review) => review.itemId === item.itemId)?.resolution).toEqual(
        (accepted.body.result as { receipt: unknown }).receipt)
    } finally {
      await server.close()
    }
  })

  it('allows a local reject during fresh capture, then keeps stopped new decisions BUSY and exact retry read-only', async () => {
    h = await makeHarness()
    const { input } = await observedGap(h)
    const item = h.k.trading.reconcileReviews.list(input.accountId).find((candidate) => candidate.kind === 'inferred_fill')
    if (!item) throw new Error('captured inference review was not persisted')
    const finding: ReconcileFindingView = { id: 'finding-stopped-new-decision', code: 'position_difference', severity: 'warn',
      detail: 'A second captured finding remains pending.', advice: { action: 'review', requiresHuman: true, why: 'Review the captured evidence.' }, evidence: [] }
    const newItem = h.k.trading.reconcileReviews.record({ accountId: input.accountId, kind: 'known_difference',
      observedAt: h.clock.now(), summary: 'A second captured finding remains pending.', blocking: false, finding })
    const rejection: ReconcileResolutionInput = { accountId: input.accountId, itemId: item.itemId, evidenceDigest: item.evidenceDigest,
      action: 'reject', reason: 'The captured inference is rejected.', requestId: 's3-pending-capture-reject' }
    const fillsBefore = h.k.orders.fills({ accountId: input.accountId, limit: 1000 })
    h.clock.advance(10_000)
    let enterCapture!: () => void
    let releaseCapture!: () => void
    const captureEntered = new Promise<void>((resolve) => { enterCapture = resolve })
    const captureGate = new Promise<void>((resolve) => { releaseCapture = resolve })
    const originalSnapshot = h.sim.startupSnapshot.bind(h.sim)
    h.sim.startupSnapshot = async (ref, since) => {
      const snapshot = await originalSnapshot(ref, since)
      enterCapture()
      await captureGate
      return snapshot
    }
    let confirmError: unknown
    let accepted: unknown
    try {
      const confirmPending = h.k.ops.call(h.k, 'reconcile.confirm', { principal: h.session, pin: TEST_PIN, transport: 'http', params: input })
        .catch((error: unknown) => { confirmError = error })
      await captureEntered
      accepted = await h.k.ops.call(h.k, 'reconcile.resolve', { principal: h.session, pin: TEST_PIN, transport: 'http', params: rejection })
      releaseCapture()
      await confirmPending
    } finally {
      releaseCapture()
      h.sim.startupSnapshot = originalSnapshot
    }
    expect(accepted).toMatchObject({ alreadyRecorded: false, receipt: { input: rejection } })
    expect(confirmError).toMatchObject({ problem: { name: 'INVALID_PARAMS' } })
    expect(h.k.trading.reconcileReviews.get(input.accountId, item.itemId)).toMatchObject({ resolution: { input: { action: 'reject' } } })
    expect(h.k.reconcileService.get(input.accountId)[0]?.findings.some((candidate) => candidate.code === 'fill_missing_inferred')).toBe(true)
    expect(h.k.orders.fills({ accountId: input.accountId, limit: 1000 })).toEqual(fillsBefore)

    await h.k.reconcileService.stop()
    const beforeRetry = h.k.ledger.head()
    const retry = await h.k.ops.call(h.k, 'reconcile.resolve', { principal: h.session, pin: TEST_PIN, transport: 'http', params: rejection })
    expect(retry).toMatchObject({ alreadyRecorded: true, receipt: (accepted as { receipt: unknown }).receipt })
    expect(h.k.ledger.head()).toEqual(beforeRetry)
    await expect(h.k.ops.call(h.k, 'reconcile.resolve', { principal: h.session, pin: TEST_PIN, transport: 'http', params: {
      accountId: input.accountId, itemId: newItem.itemId, evidenceDigest: newItem.evidenceDigest, action: 'acknowledge',
      reason: 'A new local decision after stop.', requestId: 's3-stopped-new-decision',
    } })).rejects.toMatchObject({ problem: { name: 'BUSY' } })
    expect(h.k.trading.reconcileReviews.get(input.accountId, newItem.itemId)?.resolution).toBeUndefined()
  })

  it('replays a durable public resolution after reopening with a fresh session and PIN proof', async () => {
    h = await makeHarness()
    const { input } = await observedGap(h)
    const item = h.k.trading.reconcileReviews.list(input.accountId).find((candidate) => candidate.kind === 'inferred_fill')
    if (!item) throw new Error('captured inference review was not persisted')
    const resolution: ReconcileResolutionInput = { accountId: input.accountId, itemId: item.itemId, evidenceDigest: item.evidenceDigest,
      action: 'reject', reason: 'Rejected before restart.', requestId: 's3-restart-resolution' }
    const first = await h.k.ops.call(h.k, 'reconcile.resolve', { principal: h.session, pin: TEST_PIN, transport: 'http', params: resolution }) as { receipt: unknown; alreadyRecorded: boolean }
    expect(first.alreadyRecorded).toBe(false)
    const originalFills = h.k.orders.fills({ accountId: input.accountId, limit: 1000 })
    await h.k.stop()
    const reopened = await Kernel.create({ home: h.home, clock: h.clock, scrypt: FAST_SCRYPT, deviceKeyProvider: fileProvider, timers: false, sleep: async () => undefined })
    h.k = reopened
    try {
      const freshSession = h.k.auth.authenticateToken(h.k.auth.exchangeBoot(h.k.auth.mintBootToken()).sessionToken)
      if (!freshSession || freshSession.kind !== 'session') throw new Error('reopened kernel did not issue a fresh human session')
      const freshPinProof = await h.k.auth.pinProof(freshSession, TEST_PIN, 'ui')
      const status = await h.k.ops.call(h.k, 'reconcile.status', { principal: freshSession, transport: 'http', kind: 'query', params: { accountId: input.accountId } }) as Array<{ reviews?: ReconcileReviewItem[] }>
      expect(status[0]?.reviews?.find((review) => review.itemId === item.itemId)).toMatchObject({ resolution: first.receipt })
      const ledgerBeforeRetry = h.k.ledger.head()
      const reordered = { requestId: resolution.requestId, reason: resolution.reason, action: resolution.action,
        evidenceDigest: resolution.evidenceDigest, itemId: resolution.itemId, accountId: resolution.accountId }
      const retry = await h.k.ops.call(h.k, 'reconcile.resolve', { principal: freshSession, pin: TEST_PIN, transport: 'http', params: reordered }) as { receipt: unknown; alreadyRecorded: boolean }
      expect(retry).toEqual({ alreadyRecorded: true, receipt: first.receipt })
      expect(h.k.ledger.head()).toEqual(ledgerBeforeRetry)
      expect(h.k.orders.fills({ accountId: input.accountId, limit: 1000 })).toEqual(originalFills)
      await expect(h.k.ops.call(h.k, 'reconcile.resolve', { principal: freshSession, pin: TEST_PIN, transport: 'http', params: {
        ...resolution, reason: 'Changed payload with the same request id.',
      } })).rejects.toMatchObject({ problem: { name: 'INVALID_PARAMS' } })
      expect(h.k.trading.reconcileReviews.get(input.accountId, item.itemId)?.resolution).toEqual(first.receipt)
      expect(freshPinProof.presence).toBe('pin')
    } finally {
      await reopened.stop()
    }
  })
})
