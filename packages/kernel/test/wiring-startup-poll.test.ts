// SPDX-License-Identifier: CPAL-1.0
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Order, OrderIntent } from '../src/proto'
import type { VenueConnector, VenueFill, VenueOrderStatus } from '@gitrader/protocol/connector'
import type { Harness } from './helpers/harness'
import { enableLive, makeHarness } from './helpers/harness'
import { BTC, ETH } from './helpers/fake-connector'

let h: Harness | undefined
afterEach(async () => { await h?.cleanup(); h = undefined })

async function liveHarness(): Promise<Harness> {
  h = await makeHarness({ registerLive: false })
  await enableLive(h)
  h.k.registerConnector(h.live, { pollOrders: true })
  return h
}

async function placeGtc(size = '0.001', instrumentId = BTC): Promise<Order> {
  const proof = await h!.pinProof()
  const result = await h!.k.trading.place({ intent: {
    accountId: h!.liveAcct.accountId as never, instrumentId, side: 'buy', type: 'limit',
    price: '79000' as never, size: size as never, leverage: 2, tif: 'gtc',
  } as OrderIntent }, { ...h!.human(), proof })
  expect(result.order?.status, JSON.stringify({ problem: result.order?.problem })).toBe('open')
  return result.order!
}

function fill(order: Order, venueFillId: string, size = '0.0001'): VenueFill {
  return {
    venueOrderId: order.venueOrderId!, clientOrderId: order.clientOrderId, venueFillId,
    instrumentId: order.instrumentId, side: order.side, price: order.price ?? '79000',
    size: size as VenueFill['size'], fee: '0', feeCcy: 'USDC', liquidity: 'maker',
    realizedPnl: '0', ts: h!.clock.now(),
  } as VenueFill
}

async function setEmptyRemoteSnapshot(fills: VenueFill[] = []): Promise<void> {
  h!.live.openOrdersOverride = []
  const account = await h!.live.accountState(h!.k.bus.accountRef(h!.liveAcct))
  h!.live.startupResponseSequence = [{ account, openOrders: [], fills, fillsSince: h!.clock.now() - 24 * 60 * 60 * 1000, truncated: false }]
}

function startupEntries() {
  return [...h!.k.ledger.iterate()].filter((entry) => entry.type === 'startup.reconciled')
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

describe('Kernel startup live order polling', () => {
  it('polls fills for a recent closed local order when the remote snapshot is empty', async () => {
    const h = await liveHarness()
    const order = await placeGtc()
    h.k.trading.onOrderUpdate(h.liveAcct.accountId, { venueOrderId: order.venueOrderId!, clientOrderId: order.clientOrderId, status: 'cancelled' })
    await setEmptyRemoteSnapshot()
    const pollFills = vi.spyOn(h.k.bus, 'pollFills').mockResolvedValue([])

    const result = await h.k.startupReconcile(1_000, 'hyperliquid')

    expect(result[0]?.ok).toBe(true)
    expect(pollFills).toHaveBeenCalledTimes(1)
    expect(pollFills.mock.calls[0]?.[2]).toMatchObject({ instrumentId: BTC })
    expect(pollFills.mock.calls[0]?.[1]).toBe(h.clock.now() - 24 * 60 * 60 * 1000)
  })

  it('looks up a missing remote open order with its instrument and existing venue id without halting', async () => {
    const h = await liveHarness()
    const order = await placeGtc()
    await setEmptyRemoteSnapshot()
    const orderStatus = vi.spyOn(h.live as VenueConnector, 'orderStatus').mockImplementation(async (_ref, key) => ({
      found: true, status: 'open', venueOrderId: key.venueOrderId,
    } as VenueOrderStatus))

    const result = await h.k.startupReconcile(1_000, 'hyperliquid')

    expect(orderStatus).toHaveBeenCalledTimes(1)
    expect(orderStatus.mock.calls[0]?.[1]).toMatchObject({ instrumentId: BTC, venueOrderId: order.venueOrderId })
    expect(result[0]?.ok).toBe(true)
    expect(h.k.tstate.get({ type: 'account', id: h.liveAcct.accountId })).toBe('ACTIVE')
  })

  it('looks up all local opens without the normal 100-order list cap', async () => {
    const h = await liveHarness()
    for (let i = 0; i < 101; i++) {
      await placeGtc('0.0002')
      h.clock.advance(11_000)
    }
    await setEmptyRemoteSnapshot()
    const orderStatus = vi.spyOn(h.live as VenueConnector, 'orderStatus').mockImplementation(async (_ref, key) => ({
      found: true, status: 'open', venueOrderId: key.venueOrderId,
    } as VenueOrderStatus))

    const result = await h.k.startupReconcile(1_000, 'hyperliquid')

    expect(orderStatus).toHaveBeenCalledTimes(101)
    expect(result[0]?.ok).toBe(true)
    expect(startupEntries().at(-1)?.payload).toMatchObject({ unresolved: [], venueOpenOrders: 0 })
  }, 60_000)

  it('counts snapshot and per-instrument fills while the normal pipeline deduplicates repeats', async () => {
    const h = await liveHarness()
    const order = await placeGtc()
    const sameFill = fill(order, 'startup-snapshot-and-poll')
    await setEmptyRemoteSnapshot([sameFill])
    vi.spyOn(h.live as VenueConnector, 'orderStatus').mockResolvedValue({ found: true, status: 'open', venueOrderId: order.venueOrderId } as VenueOrderStatus)
    vi.spyOn(h.live as VenueConnector, 'fills').mockResolvedValue([sameFill])

    const result = await h.k.startupReconcile(1_000, 'hyperliquid')

    expect(result[0]?.ok).toBe(true)
    expect(h.k.ledger.query({ types: ['fill'] })).toHaveLength(1)
    expect(startupEntries().at(-1)?.payload).toMatchObject({ backfilledFills: 2, ok: true })
  })

  it('halts on a real per-instrument backfill failure', async () => {
    const h = await liveHarness()
    await placeGtc()
    await setEmptyRemoteSnapshot()
    vi.spyOn(h.live as VenueConnector, 'orderStatus').mockResolvedValue({ found: true, status: 'open' } as VenueOrderStatus)
    vi.spyOn(h.live as VenueConnector, 'fills').mockRejectedValue(new Error('synthetic backfill failure'))

    const result = await h.k.startupReconcile(1_000, 'hyperliquid')

    expect(result[0]?.ok).toBe(false)
    expect(startupEntries().at(-1)?.payload).toMatchObject({ ok: false, error: 'synthetic backfill failure' })
    expect(h.k.tstate.get({ type: 'account', id: h.liveAcct.accountId })).toBe('HALTED')
  })

  it('does not continue from a pending reconcile after stop', async () => {
    const h = await liveHarness()
    await placeGtc()
    const snapshot = { account: await h.live.accountState(h.k.bus.accountRef(h.liveAcct)), openOrders: [], fills: [], fillsSince: h.clock.now(), truncated: false }
    const pending = deferred<Awaited<ReturnType<typeof h.k.bus.reconcile>>>()
    const reconcile = vi.spyOn(h.k.bus, 'reconcile').mockImplementation(() => pending.promise)
    const orderStatus = vi.spyOn(h.live as VenueConnector, 'orderStatus')
    const pollFills = vi.spyOn(h.k.bus, 'pollFills')
    const append = vi.spyOn(h.k.ledger, 'append')
    const running = h.k.startupReconcile(1_000, 'hyperliquid')
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledTimes(1))

    await h.k.stop()
    pending.resolve(snapshot)
    const result = await running

    expect(result).toEqual([])
    expect(orderStatus).not.toHaveBeenCalled()
    expect(pollFills).not.toHaveBeenCalled()
    expect(append.mock.calls.some(([entry]) => entry.type === 'startup.reconciled')).toBe(false)
  })

  it('does not apply a pending lookup result or start fills after stop', async () => {
    const h = await liveHarness()
    const order = await placeGtc()
    await setEmptyRemoteSnapshot()
    const pending = deferred<VenueOrderStatus>()
    const orderStatus = vi.spyOn(h.live as VenueConnector, 'orderStatus').mockImplementation(() => pending.promise)
    const pollFills = vi.spyOn(h.k.bus, 'pollFills')
    const append = vi.spyOn(h.k.ledger, 'append')
    const running = h.k.startupReconcile(1_000, 'hyperliquid')
    await vi.waitFor(() => expect(orderStatus).toHaveBeenCalledTimes(1))

    await h.k.stop()
    pending.resolve({ found: true, status: 'cancelled', venueOrderId: order.venueOrderId } as VenueOrderStatus)
    const result = await running

    expect(result).toEqual([])
    expect(pollFills).not.toHaveBeenCalled()
    expect(append.mock.calls.some(([entry]) => entry.type === 'startup.reconciled')).toBe(false)
    expect(h.k.tstate.get({ type: 'account', id: h.liveAcct.accountId })).toBe('ACTIVE')
  })

  it('does not apply pending fills or request the next instrument after stop', async () => {
    const h = await liveHarness()
    const btc = await placeGtc()
    h.clock.advance(11_000)
    const eth = await placeGtc('0.001', ETH)
    await setEmptyRemoteSnapshot()
    vi.spyOn(h.live as VenueConnector, 'orderStatus').mockImplementation(async (_ref, key) => ({
      found: true, status: 'open', venueOrderId: key.venueOrderId,
    } as VenueOrderStatus))
    const pending = deferred<VenueFill[]>()
    const requested: string[] = []
    vi.spyOn(h.live as VenueConnector, 'fills').mockImplementation((_ref, _since, options) => {
      requested.push(options?.instrumentId ?? '')
      return pending.promise
    })
    const events: unknown[] = []
    h.k.events.subscribe('account.fills', (event) => events.push(event))
    const append = vi.spyOn(h.k.ledger, 'append')
    const running = h.k.startupReconcile(1_000, 'hyperliquid')
    await vi.waitFor(() => expect(requested).toHaveLength(1))

    await h.k.stop()
    pending.resolve([fill(btc, 'late-startup-fill')])
    const result = await running

    expect(result).toEqual([])
    expect(requested).toEqual([BTC])
    expect(events).toEqual([])
    expect(append.mock.calls.some(([entry]) => entry.type === 'startup.reconciled')).toBe(false)
    expect(h.k.tstate.get({ type: 'account', id: h.liveAcct.accountId })).toBe('ACTIVE')
    expect(eth.instrumentId).toBe(ETH)
  })

  it('checks abort before every snapshot fill and before final reconciliation state', async () => {
    const h = await liveHarness()
    const btc = await placeGtc()
    h.clock.advance(11_000)
    const eth = await placeGtc('0.001', ETH)
    await setEmptyRemoteSnapshot([fill(btc, 'snapshot-fill-one'), fill(eth, 'snapshot-fill-two')])
    vi.spyOn(h.live as VenueConnector, 'orderStatus').mockImplementation(async (_ref, key) => ({
      found: true, status: 'open', venueOrderId: key.venueOrderId,
    } as VenueOrderStatus))
    const onVenueFill = vi.spyOn(h.k.trading, 'onVenueFill')
    const append = vi.spyOn(h.k.ledger, 'append')
    let stopped: Promise<void> | undefined
    h.k.events.subscribe('account.fills', () => { stopped ??= h.k.stop() })
    const pollFills = vi.spyOn(h.k.bus, 'pollFills')

    const result = await h.k.startupReconcile(1_000, 'hyperliquid')
    await stopped

    expect(result).toEqual([])
    expect(onVenueFill).toHaveBeenCalledTimes(1)
    expect(pollFills).not.toHaveBeenCalled()
    expect(append.mock.calls.some(([entry]) => entry.type === 'startup.reconciled')).toBe(false)
    expect(h.k.tstate.get({ type: 'account', id: h.liveAcct.accountId })).toBe('ACTIVE')
  })

  it('does not write final counts or HALT when a snapshot fill listener stops the kernel', async () => {
    const h = await liveHarness()
    const order = await placeGtc()
    await setEmptyRemoteSnapshot([fill(order, 'snapshot-stop-final-guard')])
    vi.spyOn(h.live as VenueConnector, 'orderStatus').mockResolvedValue({ found: true, status: 'open', venueOrderId: order.venueOrderId } as VenueOrderStatus)
    const append = vi.spyOn(h.k.ledger, 'append')
    let stopped: Promise<void> | undefined
    h.k.events.subscribe('account.fills', () => { stopped ??= h.k.stop() })

    const result = await h.k.startupReconcile(1_000, 'hyperliquid')
    await stopped

    expect(result).toEqual([])
    expect(append.mock.calls.some(([entry]) => entry.type === 'startup.reconciled')).toBe(false)
    expect(h.k.tstate.get({ type: 'account', id: h.liveAcct.accountId })).toBe('ACTIVE')
  })
})
