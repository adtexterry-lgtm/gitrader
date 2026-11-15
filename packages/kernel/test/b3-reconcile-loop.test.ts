// SPDX-License-Identifier: CPAL-1.0
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeHarness } from './helpers/harness'
import type { Harness } from './helpers/harness'
import type { AccountSnapshot, StartupSnapshot } from '@gitrader/protocol/connector'
import type { Fill, Order } from '../src/proto'
import { asDecimal } from '../src/proto'
import { mkOrigin } from '../src/util/origin'

let h: Harness
beforeEach(async () => { h = await makeHarness() })
afterEach(async () => { await h.cleanup() })

describe('B3 reconciliation service wiring', () => {
  it('exposes per-account reconciliation in the real kernel status response', () => {
    const status = h.k.status()
    expect(status).toHaveProperty('reconciliation')
  })

  it('registers an authenticated read-only reconciliation status operation', async () => {
    await expect(h.k.ops.call(h.k, 'reconcile.status', {
      principal: h.session,
      params: { accountId: h.paper.accountId },
      transport: 'ws',
      kind: 'query',
    })).resolves.toBeDefined()
    expect(h.k.ops.has('reconcile.status')).toBe(true)
  })

  it('registers a session refresh operation that returns a real account view', async () => {
    await expect(h.k.ops.call(h.k, 'reconcile.refresh', {
      principal: h.session,
      params: { accountId: h.paper.accountId },
      transport: 'ws',
      kind: 'command',
    })).resolves.toMatchObject({ accountId: h.paper.accountId })
    expect(h.k.ops.has('reconcile.refresh')).toBe(true)
  })

  it('uses one real snapshot, has no fill or ledger side effects, and rejects a too-fast explicit refresh', async () => {
    const snapshot = vi.spyOn(h.sim, 'startupSnapshot')
    const fills = vi.spyOn(h.sim, 'fills')
    const ledgerBefore = h.k.ledger.count()
    const view = await h.k.reconcileService.refresh(h.paper.accountId)

    expect(view.state).toBe('ready')
    expect(snapshot).toHaveBeenCalledTimes(1)
    expect(snapshot.mock.calls[0]?.[1]).toBe(h.clock.now() - 24 * 60 * 60 * 1000)
    await expect(h.k.reconcileService.refresh(h.paper.accountId)).rejects.toMatchObject({ problem: { name: 'BUSY' } })
    expect(snapshot).toHaveBeenCalledTimes(1)
    expect(fills).not.toHaveBeenCalled()
    expect(h.k.ledger.count()).toBe(ledgerBefore)
    h.clock.advance(10_000)
    await expect(h.k.reconcileService.refresh(h.paper.accountId)).resolves.toMatchObject({ state: 'ready' })
    expect(snapshot).toHaveBeenCalledTimes(2)
  })

  it('keeps old local terminal orders in the report after the remote 24-hour snapshot window', async () => {
    const oldTs = h.clock.now() - 48 * 60 * 60 * 1000
    const order: Order = {
      orderId: 'ord_early_local' as Order['orderId'], clientOrderId: '0123456789abcdef0123456789abcdef',
      accountId: h.paper.accountId as Order['accountId'], instrumentId: 'hyperliquid:BTC' as Order['instrumentId'],
      side: 'buy', type: 'limit', tif: 'gtc', size: asDecimal('1'), filledSize: asDecimal('1'), price: asDecimal('100'),
      triggerPrice: null, avgFillPrice: asDecimal('100'), reduceOnly: false, postOnly: false, status: 'filled', fee: asDecimal('0'),
      origin: mkOrigin('user:usr_local', 'reconcile-test', 'ui'), createdAt: oldTs, updatedAt: oldTs, submittedAt: oldTs, closedAt: oldTs + 1,
    }
    h.k.orders.upsert(order, '100', true)
    const view = await h.k.reconcileService.refresh(h.paper.accountId)

    expect(view.coverage).toMatchObject({ historyTotal: 1, historyChecked: 1, unavailable: ['fills', 'historyOrders'] })
    expect(view.verdict).not.toBe('clean')
  })

  it('does not repeat a never-settled venue call and still advances a healthy account', async () => {
    h.sim.startupResponseSequence = ['hang']
    const paperSnapshots = vi.spyOn(h.sim, 'startupSnapshot')
    const liveSnapshots = vi.spyOn(h.live, 'startupSnapshot')
    const timedOut = await h.k.reconcileService.refresh(h.paper.accountId)

    expect(timedOut.state).toBe('unavailable')
    expect(paperSnapshots).toHaveBeenCalledTimes(1)
    await expect(h.k.reconcileService.refresh(h.paper.accountId)).rejects.toMatchObject({ problem: { name: 'BUSY' } })
    h.clock.advance(10_000)
    await h.k.reconcileService.tick()
    expect(paperSnapshots).toHaveBeenCalledTimes(1)
    expect(liveSnapshots).toHaveBeenCalledTimes(1)
  }, 10_000)

  it('aborts an in-flight observation on stop and publishes no late view', async () => {
    h.live.startupResponseSequence = ['hang']
    const snapshot = vi.spyOn(h.live, 'startupSnapshot')
    const updated: unknown[] = []
    h.k.events.subscribe('reconciliation.updated', (event) => updated.push(event.data))
    const capture = h.k.reconcileService.refresh(h.liveAcct.accountId)
    await Promise.resolve()
    await h.k.reconcileService.stop()
    const stoppedView = await capture

    expect(stoppedView.state).toBe('unavailable')
    expect(stoppedView.offerId).toBeUndefined()
    expect(snapshot).toHaveBeenCalledTimes(1)
    expect(updated).toHaveLength(0)
    await expect(h.k.reconcileService.refresh(h.liveAcct.accountId)).rejects.toMatchObject({ problem: { name: 'BUSY' } })
  })

  it('exposes pending confirmation immediately through a read-only status overlay', async () => {
    h.k.docs.put('reconcile-confirm-pending', h.paper.accountId, 'rcpt_unresolved')
    const ledgerBefore = h.k.ledger.count()
    const status = h.k.reconcileService.get(h.paper.accountId)[0]

    expect(status).toMatchObject({ state: 'unavailable', verdict: 'blocked', suggestions: [] })
    expect(status?.offerId).toBeUndefined()
    expect(status?.findings).toContainEqual(expect.objectContaining({ code: 'CONFIRMATION_EFFECTS_PENDING', severity: 'blocker' }))
    expect(h.k.tstate.get({ type: 'account', id: h.paper.accountId })).toBe('ACTIVE')
    expect(h.k.ledger.count()).toBe(ledgerBefore)
  })

  it('overlays the fixed pending blocker even when the security state is damaged', () => {
    h.k.docs.put('reconcile-confirm-pending', h.paper.accountId, 'rcpt_unresolved')
    vi.spyOn(h.k, 'securityStateHealth').mockReturnValue({ ok: false, files: [], recoveryRequired: true })
    const ledgerBefore = h.k.ledger.count()
    const view = h.k.reconcileService.get(h.paper.accountId)[0]

    expect(view).toMatchObject({ state: 'unavailable', verdict: 'blocked', suggestions: [] })
    expect(view?.findings).toContainEqual(expect.objectContaining({ code: 'CONFIRMATION_EFFECTS_PENDING', severity: 'blocker' }))
    expect(h.k.tstate.get({ type: 'account', id: h.paper.accountId })).toBe('ACTIVE')
    expect(h.k.ledger.count()).toBe(ledgerBefore)
  })

  it('marks a failed refresh unavailable and preserves prior evidence times without a clean verdict', async () => {
    const first = await h.k.reconcileService.refresh(h.paper.accountId)
    expect(first.state).toBe('ready')
    expect(first.lastSuccessAt).toBeDefined()
    h.sim.startupResponseSequence = [new Error('venue unavailable')]
    h.clock.advance(10_000)
    const failed = await h.k.reconcileService.refresh(h.paper.accountId)

    expect(failed.state).toBe('unavailable')
    expect(failed.verdict).toBe('attention')
    expect(failed.offerId).toBeUndefined()
    expect(failed.lastSuccessAt).toBe(first.lastSuccessAt)
    expect(failed.lastAttemptAt).toBe(h.clock.now())
    expect(failed.coverage?.asOf).toBe(first.coverage?.asOf)
    expect(failed.coverage?.unavailable).toEqual(expect.arrayContaining(['openOrders', 'historyOrders', 'fills', 'positions']))
    // 上游报错原文保留
    expect(failed.problem?.message).toContain('venue unavailable')
  })

  it('records the attempted time when security health fails before the native snapshot', async () => {
    const snapshot = vi.spyOn(h.sim, 'startupSnapshot')
    const first = await h.k.reconcileService.refresh(h.paper.accountId)
    expect(first.state).toBe('ready')
    expect(first.lastSuccessAt).toBeDefined()
    const snapshotBefore = snapshot.mock.calls.length
    const ledgerBefore = h.k.ledger.count()
    h.clock.advance(10_000)
    vi.spyOn(h.k, 'securityStateHealth').mockReturnValue({ ok: false, files: [], recoveryRequired: true })

    const failed = await h.k.reconcileService.refresh(h.paper.accountId)

    expect(failed.state).toBe('unavailable')
    expect(failed.lastAttemptAt).toBe(h.clock.now())
    expect(failed.lastSuccessAt).toBe(first.lastSuccessAt)
    expect(failed.offerId).toBeUndefined()
    expect(failed.suggestions).toEqual([])
    expect(snapshot).toHaveBeenCalledTimes(snapshotBefore)
    expect(h.k.ledger.count()).toBe(ledgerBefore)
  })

  it('does not invent evidence timestamps or coverage after the first failed snapshot', async () => {
    h.sim.startupResponseSequence = [new Error('venue unavailable')]
    const failed = await h.k.reconcileService.refresh(h.paper.accountId)

    expect(failed.state).toBe('unavailable')
    expect(failed.verdict).toBe('attention')
    expect(failed.coverage).toBeUndefined()
    expect(failed.lastSuccessAt).toBeUndefined()
    expect(failed.lastAttemptAt).toBe(h.clock.now())
    expect(failed.offerId).toBeUndefined()
    expect(failed.suggestions).toEqual([])
  })

  it('keeps stale and truncated snapshots unavailable with no offer', async () => {
    const ref = h.k.bus.accountRef(h.paper)
    const baseline = await h.sim.startupSnapshot(ref, h.clock.now())
    const stale: StartupSnapshot = { ...baseline, account: { ...baseline.account, stale: true } }
    const truncated: StartupSnapshot = { ...baseline, truncated: true }
    h.sim.startupSnapshotCalls = 0
    h.sim.startupResponseSequence = [stale, truncated]

    const staleView = await h.k.reconcileService.refresh(h.paper.accountId)
    h.clock.advance(10_000)
    const truncatedView = await h.k.reconcileService.refresh(h.paper.accountId)

    expect(staleView.state).toBe('unavailable')
    expect(staleView.offerId).toBeUndefined()
    expect(staleView.suggestions).toEqual([])
    expect(staleView.problem?.name).toBe('VENUE_OUTCOME_UNKNOWN')
    expect(truncatedView.state).toBe('unavailable')
    expect(truncatedView.offerId).toBeUndefined()
    expect(truncatedView.suggestions).toEqual([])
    expect(truncatedView.problem?.name).toBe('VENUE_OUTCOME_UNKNOWN')
  })

  it('rotates through a history budget of twenty without claiming full coverage', async () => {
    const orders: Order[] = Array.from({ length: 22 }, (_, index) => {
      const suffix = index.toString(16).padStart(2, '0')
      const clientOrderId = `0123456789abcdef0123456789abcd${suffix}`
      return {
        orderId: `ord_budget_${index}` as Order['orderId'], clientOrderId,
        accountId: h.paper.accountId as Order['accountId'], instrumentId: 'hyperliquid:BTC' as Order['instrumentId'],
        side: 'buy', type: 'limit', tif: 'gtc', size: asDecimal('1'), filledSize: asDecimal('0'), price: asDecimal('100'),
        triggerPrice: null, avgFillPrice: null, reduceOnly: false, postOnly: false, status: 'open', fee: asDecimal('0'),
        origin: mkOrigin('user:usr_local', 'reconcile-test', 'ui'), createdAt: index + 1, updatedAt: index + 1, submittedAt: index + 1,
      }
    })
    for (const order of orders) h.k.orders.upsert(order, '100', true)
    const status = vi.spyOn(h.sim, 'orderStatus').mockResolvedValue({ found: false })

    const first = await h.k.reconcileService.refresh(h.paper.accountId)
    expect(first.coverage).toMatchObject({ historyTotal: 22, historyChecked: 20 })
    expect(first.coverage?.unavailable).toContain('historyOrders')
    expect(first.verdict).not.toBe('clean')
    const firstIds = new Set(status.mock.calls.map((call) => call[1].clientOrderId))
    expect(firstIds.size).toBe(20)

    h.clock.advance(10_000)
    const second = await h.k.reconcileService.refresh(h.paper.accountId)
    expect(second.coverage).toMatchObject({ historyTotal: 22, historyChecked: 20 })
    expect(status).toHaveBeenCalledTimes(40)
    expect(new Set(status.mock.calls.map((call) => call[1].clientOrderId)).size).toBe(22)
  })

  it('keeps one valid inferred offer through ten-second recapture and renews it after expiry', async () => {
    const order: Order = {
      orderId: 'ord_offerTtl' as Order['orderId'], clientOrderId: '0123456789abcdef0123456789abcdef',
      venueOrderId: 'venue_offer_ttl', accountId: h.paper.accountId as Order['accountId'], instrumentId: 'hyperliquid:BTC' as Order['instrumentId'],
      side: 'buy', type: 'limit', tif: 'gtc', size: asDecimal('1'), filledSize: asDecimal('0'), price: asDecimal('100'),
      triggerPrice: null, avgFillPrice: null, reduceOnly: false, postOnly: false, status: 'open', fee: asDecimal('0'),
      origin: mkOrigin('user:usr_local', 'reconcile-test', 'ui'), createdAt: 1, updatedAt: 1, submittedAt: 1,
    }
    h.k.orders.upsert(order, '100', true)
    vi.spyOn(h.sim, 'orderStatus').mockResolvedValue({
      found: true, status: 'filled', venueOrderId: 'venue_offer_ttl', filledSize: '1', avgFillPrice: '100',
    } as never)
    let securityNow = 1_000
    vi.spyOn(h.k.auth, 'now').mockImplementation(() => securityNow)
    const updated: unknown[] = []
    h.k.events.subscribe('reconciliation.updated', (event) => updated.push(event.data))

    const first = await h.k.reconcileService.refresh(h.paper.accountId)
    expect(first.suggestions).toHaveLength(1)
    expect(first.offerId).toBeDefined()
    const initialUpdates = updated.length
    securityNow += 10_000
    h.clock.advance(10_000)
    const second = await h.k.reconcileService.refresh(h.paper.accountId)
    expect(second.reportId).toBe(first.reportId)
    expect(second.offerId).toBe(first.offerId)
    expect(updated).toHaveLength(initialUpdates)

    securityNow += 20_001
    h.clock.advance(10_000)
    const third = await h.k.reconcileService.refresh(h.paper.accountId)
    expect(third.reportId).toBe(first.reportId)
    expect(third.offerId).toBeDefined()
    expect(third.offerId).not.toBe(first.offerId)
    expect(updated).toHaveLength(initialUpdates + 1)
  })

  it('assigns a new notice id when the same fixed finding resolves and later returns', async () => {
    const notices: { noticeId: string; findingId: string }[] = []
    h.k.events.subscribe('reconciliation.notice', (event) => {
      const data = event.data as { noticeId: string; findingId: string }
      notices.push({ noticeId: data.noticeId, findingId: data.findingId })
    })
    h.k.docs.put('reconcile-confirm-pending', h.paper.accountId, 'rcpt_unresolved')
    await h.k.reconcileService.refresh(h.paper.accountId)
    const fixedNotices = () => notices.filter((notice) => notice.findingId === `confirmation-effects:${h.paper.accountId}`)
    expect(fixedNotices()).toHaveLength(1)

    h.clock.advance(10_000)
    h.k.docs.delete('reconcile-confirm-pending', h.paper.accountId)
    await h.k.reconcileService.refresh(h.paper.accountId)
    expect(fixedNotices()).toHaveLength(1)

    h.clock.advance(10_000)
    h.k.docs.put('reconcile-confirm-pending', h.paper.accountId, 'rcpt_unresolved_again')
    await h.k.reconcileService.refresh(h.paper.accountId)
    expect(fixedNotices()).toHaveLength(2)
    expect(fixedNotices()[1]?.findingId).toBe(fixedNotices()[0]?.findingId)
    expect(fixedNotices()[1]?.noticeId).not.toBe(fixedNotices()[0]?.noticeId)
  })

  it('does not start an extra snapshot when old startup reconciliation releases its account counter', async () => {
    const snapshot = vi.spyOn(h.sim, 'startupSnapshot')
    const result = await h.k.startupReconcile(1000, 'kernel-sim')

    expect(result).toHaveLength(1)
    expect(snapshot).toHaveBeenCalledTimes(1)
    expect(h.k.reconcileService.get(h.paper.accountId)[0]?.state).toBe('idle')
  })

  it('runs the scanner on successive real ticks while B2 keeps only its own account busy', async () => {
    await h.cleanup()
    h = await makeHarness({ registerLive: false })
    h.k.registerConnector(h.live, { pollOrders: true })
    const order: Order = {
      orderId: 'ord_b2_busy_reconcile' as Order['orderId'], clientOrderId: '0123456789abcdef0123456789abcdef',
      venueOrderId: 'venue_b2_busy_reconcile', accountId: h.liveAcct.accountId as Order['accountId'], instrumentId: 'hyperliquid:BTC' as Order['instrumentId'],
      side: 'buy', type: 'limit', tif: 'gtc', size: asDecimal('1'), filledSize: asDecimal('0'), price: asDecimal('100'),
      triggerPrice: null, avgFillPrice: null, reduceOnly: false, postOnly: false, status: 'open', fee: asDecimal('0'),
      origin: mkOrigin('user:usr_local', 'reconcile-test', 'ui'), createdAt: h.clock.now(), updatedAt: h.clock.now(), submittedAt: h.clock.now(),
    }
    h.k.orders.upsert(order, '100', true)
    let releaseStatus!: (value: { found: false }) => void
    const pendingStatus = new Promise<{ found: false }>((resolve) => { releaseStatus = resolve })
    const status = vi.spyOn(h.live, 'orderStatus').mockReturnValue(pendingStatus)
    const paperSnapshots = vi.spyOn(h.sim, 'startupSnapshot')
    const liveSnapshots = vi.spyOn(h.live, 'startupSnapshot')

    await h.k.tickOnce()
    const livePoll = (h.k as unknown as { livePollRun?: Promise<void> }).livePollRun
    expect(livePoll).toBeDefined()
    await vi.waitFor(() => expect(paperSnapshots).toHaveBeenCalledTimes(1))
    expect(status).toHaveBeenCalledTimes(1)
    expect(liveSnapshots).not.toHaveBeenCalled()
    await expect(h.k.reconcileService.refresh(h.liveAcct.accountId)).rejects.toMatchObject({ problem: { name: 'BUSY' } })

    h.clock.advance(10_000)
    await h.k.tickOnce()
    await vi.waitFor(() => expect(paperSnapshots).toHaveBeenCalledTimes(2))
    expect(status).toHaveBeenCalledTimes(1)
    expect(liveSnapshots).not.toHaveBeenCalled()

    releaseStatus({ found: false })
    await livePoll
  })

  it('keeps notice queues per account when one account goes inactive and deduplicates stable findings', async () => {
    const makeFill = (accountId: string, suffix: string): Fill => ({
      fillId: `fill_${suffix}` as Fill['fillId'], orderId: `ord_${suffix}` as Fill['orderId'],
      clientOrderId: `0123456789abcdef0123456789abcde${suffix === 'paper' ? '1' : '2'}`,
      venueFillId: `venue-fill-${suffix}`, accountId: accountId as Fill['accountId'],
      instrumentId: 'hyperliquid:BTC' as Fill['instrumentId'], side: 'buy', price: asDecimal('100'), size: asDecimal('1'),
      fee: asDecimal('0'), feeCcy: 'USDC', liquidity: 'maker', realizedPnl: asDecimal('0'), ts: 100,
    })
    h.k.orders.insertFill(makeFill(h.paper.accountId, 'paper'))
    h.k.orders.insertFill(makeFill(h.liveAcct.accountId, 'live'))
    const notices: { accountId: string; findingId: string }[] = []
    h.k.events.subscribe('reconciliation.notice', (event) => {
      const data = event.data as { accountId: string; findingId: string }
      notices.push({ accountId: data.accountId, findingId: data.findingId })
    })

    const paperView = await h.k.reconcileService.refresh(h.paper.accountId)
    const liveView = await h.k.reconcileService.refresh(h.liveAcct.accountId)
    expect(paperView.findings.some((finding) => finding.advice.requiresHuman)).toBe(true)
    expect(liveView.findings.some((finding) => finding.advice.requiresHuman)).toBe(true)
    const paperFindingIds = paperView.findings.filter((finding) => finding.advice.requiresHuman).map((finding) => finding.id)
    const liveFindingIds = liveView.findings.filter((finding) => finding.advice.requiresHuman).map((finding) => finding.id)
    expect(paperFindingIds.length).toBeGreaterThanOrEqual(2)
    expect(liveFindingIds.length).toBeGreaterThanOrEqual(2)
    expect(notices.map((notice) => notice.accountId)).toEqual([h.paper.accountId, h.liveAcct.accountId])
    expect(new Set(notices.map((notice) => notice.findingId)).size).toBe(2)

    // The paper account has another queued finding, but cannot be scanned this round.
    h.k.accounts.get(h.paper.accountId).status = 'read_only'
    h.clock.advance(10_000)
    await h.k.reconcileService.tick()
    expect(notices.filter((notice) => notice.accountId === h.paper.accountId)).toHaveLength(1)
    const liveNotices = notices.filter((notice) => notice.accountId === h.liveAcct.accountId)
    expect(liveNotices).toHaveLength(2)
    expect(new Set(liveNotices.map((notice) => notice.findingId)).size).toBe(2)

    // Identical findings remain active on subsequent captures and are not sent again.
    h.k.accounts.get(h.paper.accountId).status = 'active'
    h.clock.advance(10_000)
    await h.k.reconcileService.tick()
    expect(notices.filter((notice) => notice.accountId === h.paper.accountId)).toHaveLength(2)
    expect(notices.filter((notice) => notice.accountId === h.liveAcct.accountId)).toHaveLength(2)
  })

  it('starts primary equity sampling before the advisory reconcile snapshot', async () => {
    const originalAccountState = h.sim.accountState.bind(h.sim)
    const oldSourceTs = h.clock.now() - 8 * 60_000
    let accountStateCalls = 0
    vi.spyOn(h.sim, 'accountState').mockImplementation(async (ref) => {
      const call = ++accountStateCalls
      const snapshot = await originalAccountState(ref)
      return call === 1 ? { ...snapshot, ts: oldSourceTs, asOf: oldSourceTs, confirmedAt: h.clock.now(), stale: false } : snapshot
    })
    let markScannerReached!: () => void
    const scannerReached = new Promise<void>((resolve) => { markScannerReached = resolve })
    const startupSnapshot = h.sim.startupSnapshot.bind(h.sim)
    const scanner = vi.spyOn(h.sim, 'startupSnapshot').mockImplementation(async (ref, since) => {
      const result = await startupSnapshot(ref, since)
      markScannerReached()
      return result
    })

    await h.k.tickOnce()
    await scannerReached
    const minute = Math.floor(h.clock.now() / 60_000)
    const sample = h.k.docs.get('equity-sample', JSON.stringify([h.paper.accountId, minute]))

    expect(sample).toMatchObject({ sourceTs: oldSourceTs, asOf: oldSourceTs })
    expect(accountStateCalls).toBeGreaterThan(1)
    expect(scanner).toHaveBeenCalled()
  })

  it('lets the healthy account scan advance while primary account sampling is pending', async () => {
    const originalAccountState = h.sim.accountState.bind(h.sim)
    const paperRef = h.k.bus.accountRef(h.paper)
    let releasePrimary!: (snapshot: AccountSnapshot) => void
    const primaryPending = new Promise<AccountSnapshot>((resolve) => { releasePrimary = resolve })
    let accountStateCalls = 0
    vi.spyOn(h.sim, 'accountState').mockImplementation((ref) => {
      if (++accountStateCalls === 1) return primaryPending
      return originalAccountState(ref)
    })
    let markLiveScanReached!: () => void
    const liveScanSignal = new Promise<void>((resolve) => { markLiveScanReached = resolve })
    const liveStartup = h.live.startupSnapshot.bind(h.live)
    const liveStartupSnapshot = vi.spyOn(h.live, 'startupSnapshot').mockImplementation(async (ref, since) => {
      markLiveScanReached()
      return liveStartup(ref, since)
    })
    let tickSettled = false
    const tick = h.k.tickOnce().finally(() => { tickSettled = true })
    let timeout: ReturnType<typeof setTimeout> | undefined

    try {
      const liveScanArrived = await Promise.race([
        liveScanSignal.then(() => true),
        new Promise<boolean>((resolve) => { timeout = setTimeout(() => resolve(false), 2_000) }),
      ])
      expect(liveScanArrived).toBe(true)
      expect(liveStartupSnapshot).toHaveBeenCalled()
      expect(tickSettled).toBe(false)
    } finally {
      if (timeout) clearTimeout(timeout)
      releasePrimary(await originalAccountState(paperRef))
      await tick
    }

    expect(tickSettled).toBe(true)
  })
})
