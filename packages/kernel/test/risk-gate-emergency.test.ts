// SPDX-License-Identifier: CPAL-1.0
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StartupSnapshot } from '@gitrader/protocol/connector'
import { asDecimal, type AccountId } from '@gitrader/protocol'
import { KernelError } from '../src/util/errors'
import { makeProblem } from '../src/proto'
import type { OrderIntent, Problem } from '../src/proto'
import { newClientOrderId } from '../src/util/ids'
import { makeHarness } from './helpers/harness'
import type { Harness } from './helpers/harness'
import { BTC } from './helpers/fake-connector'

let h: Harness | undefined
afterEach(async () => { vi.useRealTimers(); await h?.cleanup() })

async function snapshotFor(harness: Harness, stale: boolean, truncated: boolean): Promise<StartupSnapshot> {
  const ref = harness.k.bus.accountRef(harness.paper)
  const account = await harness.sim.accountState(ref)
  return { account: { ...account, stale }, openOrders: await harness.sim.openOrders(ref), fills: [], fillsSince: harness.clock.now(), truncated }
}

const upstreamProblem = () => makeProblem('VENUE_REJECTED', 'upstream operation failed', {
  retryable: false,
  venue: { id: 'source-venue', code: 'Q7', message: 'source response detail' },
})
const intent = (accountId: AccountId): OrderIntent => ({ accountId, instrumentId: BTC, side: 'buy', type: 'limit', size: asDecimal('0.001'), price: asDecimal('80000'), tif: 'gtc', clientOrderId: newClientOrderId() })

function addOrder(harness: Harness, id: string, fields: Partial<{ type: string; reduceOnly: boolean; isTrigger: boolean }> = {}): void {
  harness.sim.orders.push({ venueOrderId: `venue_${id}`, clientOrderId: `cl_${id}`, accountId: harness.paper.accountId, instrumentId: BTC, side: 'sell', type: fields.type ?? 'limit', size: '0.001', price: '80000', reduceOnly: fields.reduceOnly ?? false, isTrigger: fields.isTrigger ?? false, status: 'open', createdAt: harness.clock.now() })
}

class ProblemError extends Error {
  constructor(readonly problem: Problem) { super(problem.venue?.message ?? problem.message) }
}

describe('emergency operation failure evidence', () => {
  it('uses native cancel-all for an explicit human full cancel when the stale remote view fails', async () => {
    h = await makeHarness()
    await h.k.trading.place({ intent: intent(h.paper.accountId) }, h.human())
    addOrder(h, 'protected', { type: 'stop_market', reduceOnly: true, isTrigger: true })
    h.sim.accountSnapshotOverrides = { stale: true }
    h.sim.openOrdersOverride = undefined
    const source = upstreamProblem()
    h.sim.startupResponseSequence = [new KernelError(source)]

    const result = await h.k.trading.cancelAll({ accountId: h.paper.accountId, keepProtective: false }, h.human())
    expect(result.cancelled).toBe(2)
    expect(h.sim.cancelAllCalls).toHaveLength(1)
    expect(h.sim.orders.every((order) => order.status === 'cancelled')).toBe(true)
    const entry = [...h.k.ledger.iterate()].reverse().find((item) => item.type === 'order.cancelled')!
    expect(entry.payload).toMatchObject({ gate: { ticketId: expect.any(String) }, viewFailure: { problem: source, stages: ['reconcile', 'cancel_all'] } })
    const decision = (entry.payload as { gate: { decision: { precheckId: string } } }).gate.decision
    expect(h.k.risk.replay(decision.precheckId).status).toBe('identical')
  })

  it('never uses native full cancel for a protective-preserving human request after remote failure', async () => {
    h = await makeHarness()
    h.sim.accountSnapshotOverrides = { stale: true }
    h.sim.openOrdersOverride = undefined
    h.sim.startupResponseSequence = [new Error('remote view unavailable')]
    await expect(h.k.trading.cancelAll({ accountId: h.paper.accountId }, h.human())).rejects.toMatchObject({ problem: { name: 'VENUE_UNAVAILABLE' } })
    expect(h.sim.cancelAllCalls).toHaveLength(0)
    expect(h.sim.cancelCalls).toHaveLength(0)
  })

  it('system full-cancel request preserves protectives and audits partial work when the remote view fails', async () => {
    h = await makeHarness()
    const placed = await h.k.trading.place({ intent: intent(h.paper.accountId) }, h.human())
    addOrder(h, 'reduce', { reduceOnly: true })
    addOrder(h, 'trigger', { isTrigger: true })
    addOrder(h, 'known_sl', { type: 'stop_market', reduceOnly: true, isTrigger: true })
    addOrder(h, 'unknown', { type: 'unknown' })
    h.sim.accountSnapshotOverrides = { stale: true }
    h.sim.openOrdersOverride = undefined
    const source = upstreamProblem()
    h.sim.startupResponseSequence = [new KernelError(source)]

    await expect(h.k.trading.systemCancelAll(h.paper, { keepProtective: false })).rejects.toMatchObject({ problem: source, stages: ['reconcile', 'cancel_all'] })
    expect(h.sim.cancelAllCalls).toHaveLength(0)
    expect(h.sim.cancelCalls).toHaveLength(1)
    expect(h.sim.cancelCalls[0]?.map((target) => target.clientOrderId)).toEqual([placed.order!.clientOrderId])
    expect(h.k.orders.get(placed.order!.orderId)?.status).toBe('cancelled')
    expect(h.sim.orders.filter((order) => order.clientOrderId !== placed.order!.clientOrderId).every((order) => order.status === 'open')).toBe(true)
    const entries = [...h.k.ledger.iterate()].slice(-2)
    expect(entries.map((entry) => entry.type)).toEqual(['order.cancelled', 'order.rejected'])
    const partial = entries[0]!
    const rejected = entries[1]!
    expect(partial.payload).toMatchObject({ kind: 'cancel.partial', cancelled: 1, viewFailure: { problem: source }, gate: { ticketId: expect.any(String) } })
    expect(rejected.payload).toMatchObject({ partialCancelled: 1, errorStages: ['reconcile', 'cancel_all'], problem: source, gate: { ticketId: expect.any(String) } })
    expect((partial.payload as { gate: { ticketId: string } }).gate.ticketId).toBe((rejected.payload as { gate: { ticketId: string } }).gate.ticketId)
  })

  it.each([false, true])('handles cached-view read failures without claiming unconfirmed cancellations (keepProtective=%s)', async (keepProtective) => {
    h = await makeHarness()
    addOrder(h, 'cached')
    const base = await h.k.bus.snapshot(h.paper)
    const stale = { ...base, ...(await snapshotFor(h, true, false)).account }
    h.k.bus.snapshot = (async () => stale) as unknown as typeof h.k.bus.snapshot
    const source = upstreamProblem()
    h.sim.accountState = async () => { throw new KernelError(source) }
    h.sim.openOrders = async () => { throw new Error('cached open orders unavailable') }

    if (!keepProtective) {
      const result = await h.k.trading.cancelAll({ accountId: h.paper.accountId, keepProtective }, h.human())
      expect(result.cancelled).toBe(1)
      const entry = [...h.k.ledger.iterate()].reverse().find((item) => item.type === 'order.cancelled')!
      expect(entry.payload).toMatchObject({ viewFailure: { problem: source, stages: ['cancel_all.cached_view'] } })
      expect(h.sim.cancelAllCalls).toHaveLength(1)
    } else {
      await expect(h.k.trading.cancelAll({ accountId: h.paper.accountId, keepProtective }, h.human())).rejects.toMatchObject({ problem: source, stages: ['cancel_all.cached_view', 'cancel_all'] })
      expect(h.sim.cancelAllCalls).toHaveLength(0)
      expect(h.sim.cancelCalls).toHaveLength(0)
      expect(h.sim.orders.find((order) => order.clientOrderId === 'cl_cached')?.status).toBe('open')
    }
  })

  it('bounds stale reconciliation to three requests and uses a zero fills window', async () => {
    h = await makeHarness()
    const stale = await snapshotFor(h, true, false)
    const fresh = await snapshotFor(h, false, false)
    h.sim.startupResponseSequence = [stale, stale, stale, fresh]
    const now = h.clock.now()
    const since: number[] = []
    const original = h.sim.startupSnapshot.bind(h.sim)
    h.sim.startupSnapshot = async (ref, fillsSince) => { since.push(fillsSince); return original(ref, fillsSince) }

    await expect(h.k.bus.reconcile(h.paper, 700, now, { maxRequests: 3 })).rejects.toMatchObject({
      problem: { name: 'VENUE_OUTCOME_UNKNOWN', retryable: true },
      last: { stale: true, truncated: false },
    })
    expect(h.sim.startupSnapshotCalls).toBe(3)
    expect(since).toEqual([now, now, now])
  })

  it('stops at the second fresh response and clears the single hanging-query timer', async () => {
    h = await makeHarness()
    const stale = await snapshotFor(h, true, false)
    const fresh = await snapshotFor(h, false, false)
    h.sim.startupResponseSequence = [stale, fresh]
    await expect(h.k.bus.reconcile(h.paper, 500, h.clock.now(), { maxRequests: 3 })).resolves.toMatchObject({ account: { stale: false } })
    expect(h.sim.startupSnapshotCalls).toBe(2)

    h.sim.startupSnapshotCalls = 0
    h.sim.startupResponseSequence = ['hang']
    vi.useFakeTimers()
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout')
    const pending = h.k.bus.reconcile(h.paper, 50, h.clock.now(), { maxRequests: 3 })
    const timedOut = expect(pending).rejects.toMatchObject({ problem: { name: 'VENUE_OUTCOME_UNKNOWN' } })
    await vi.advanceTimersByTimeAsync(50)
    await timedOut
    expect(h.sim.startupSnapshotCalls).toBe(1)
    expect(clearTimeoutSpy).toHaveBeenCalled()
  })

  it('preserves upstream KernelError problem fields and wraps plain errors without replacing their message', async () => {
    h = await makeHarness()
    const source = upstreamProblem()
    h.sim.startupResponseSequence = [new KernelError(source)]
    let caught: unknown
    try { await h.k.bus.reconcile(h.paper, 200, h.clock.now(), { maxRequests: 3 }) } catch (error) { caught = error }
    expect(caught).toBeInstanceOf(KernelError)
    if (!(caught instanceof KernelError)) throw new Error('expected connector operation error')
    expect(caught.problem).toEqual(source)
    expect(caught).toMatchObject({ stages: ['reconcile'] })

    h.sim.startupSnapshotCalls = 0
    h.sim.startupResponseSequence = [new Error('plain source detail')]
    caught = undefined
    try { await h.k.bus.reconcile(h.paper, 200, h.clock.now(), { maxRequests: 3 }) } catch (error) { caught = error }
    expect(caught).toMatchObject({
      problem: { name: 'VENUE_UNAVAILABLE', message: 'plain source detail', retryable: true, venue: { message: 'plain source detail' } },
      stages: ['reconcile'],
    })

    h.sim.startupSnapshotCalls = 0
    h.sim.startupResponseSequence = [new ProblemError(source)]
    caught = undefined
    try { await h.k.bus.reconcile(h.paper, 200, h.clock.now(), { maxRequests: 3 }) } catch (error) { caught = error }
    expect(caught).toMatchObject({ problem: source, stages: ['reconcile'] })
  })

  it('keeps the cancellation ticket and exact upstream failure through stale-view ledger audit', async () => {
    h = await makeHarness()
    h.sim.accountSnapshotOverrides = { stale: true }
    const source = upstreamProblem()
    h.sim.startupResponseSequence = [new KernelError(source)]
    let caught: unknown
    try { await h.k.trading.systemCancelAll(h.paper, { keepProtective: false }) } catch (error) { caught = error }
    expect(caught).toBeInstanceOf(KernelError)
    if (!(caught instanceof KernelError)) throw new Error('expected connector operation error')
    expect(caught.problem).toEqual(source)
    expect(caught).toMatchObject({ stages: ['reconcile', 'cancel_all'] })
    const entry = [...h.k.ledger.iterate()].reverse().find((item) => item.type === 'order.rejected' && (item.payload as { kind?: string }).kind === 'cancel.failed')!
    expect(entry.payload).toMatchObject({ problem: source, errorStages: ['reconcile', 'cancel_all'], gate: { ticketId: expect.any(String), decision: { verdict: 'allow' } } })
  })

  it('preserves schedule failure evidence and startup reconciliation problem fields', async () => {
    h = await makeHarness()
    const source = upstreamProblem()
    h.sim.scheduleCancel = async () => { throw new KernelError(source) }
    const result = await h.k.trading.systemScheduleCancel(h.paper, h.clock.now() + 60_000)
    expect(result).toEqual({ ok: false, problem: source })
    const schedule = [...h.k.ledger.iterate()].reverse().find((item) => item.type === 'order.rejected')!
    expect(schedule.payload).toMatchObject({ problem: source, errorStages: ['deadman.schedule'], gate: { ticketId: expect.any(String) } })

    h.live.startupSnapshotCalls = 0
    h.live.startupResponseSequence = [new KernelError(source)]
    await h.k.startupReconcile(200, 'hyperliquid')
    const startup = [...h.k.ledger.iterate()].reverse().find((item) => item.type === 'startup.reconciled')!
    expect(startup.payload).toMatchObject({ ok: false, problem: source, errorStages: ['reconcile'] })
  })

  it('uses a zero fills window for takeover position reconciliation', async () => {
    h = await makeHarness()
    const fresh = await snapshotFor(h, false, false)
    h.sim.accountSnapshotOverrides = { stale: true }
    h.sim.startupResponseSequence = [fresh, fresh]
    const requestedSince: number[] = []
    const original = h.sim.startupSnapshot.bind(h.sim)
    h.sim.startupSnapshot = async (ref, fillsSince) => { requestedSince.push(fillsSince); return original(ref, fillsSince) }
    const now = h.clock.now()
    await h.k.takeover.execute({ level: 'flatten_all', scope: { type: 'account', id: h.paper.accountId }, reason: 'bounded positions' }, h.human())
    expect(h.sim.startupSnapshotCalls).toBe(3)
    expect(requestedSince).toEqual([now, now, now])
  })
})
