// SPDX-License-Identifier: CPAL-1.0
import { afterEach, describe, expect, it, vi } from 'vitest'
import { asDecimal } from '@gitrader/protocol'
import type { StartupSnapshot, VenueOpenOrder } from '@gitrader/protocol/connector'
import type { Order } from '../src/proto'
import { makeHarness } from './helpers/harness'
import type { Harness } from './helpers/harness'
import { BTC } from './helpers/fake-connector'
import { newClientOrderId, newId } from '../src/util/ids'
import { mkOrigin } from '../src/util/origin'

let h: Harness | undefined
afterEach(async () => { await h?.cleanup() })

const localOpenOrder = (harness: Harness): Order => ({
  orderId: newId('ord') as Order['orderId'],
  clientOrderId: newClientOrderId() as Order['clientOrderId'],
  accountId: harness.liveAcct.accountId,
  instrumentId: BTC,
  side: 'buy', type: 'limit', tif: 'gtc',
  size: asDecimal('0.001'), filledSize: asDecimal('0'), price: asDecimal('80000'),
  status: 'open', fee: asDecimal('0'), origin: mkOrigin('user:usr_local', 'test', 'ui'),
  createdAt: harness.clock.now(), updatedAt: harness.clock.now(),
})

const rowFor = (order: Order): VenueOpenOrder => {
  if (order.type !== 'limit') throw new Error('startup fixture requires a limit order')
  return {
    instrumentId: order.instrumentId, venueOrderId: 'venue_startup_order', clientOrderId: order.clientOrderId,
    side: order.side, type: order.type, price: order.price ?? null, triggerPrice: null,
    size: order.size, origSize: order.size, reduceOnly: false, isTrigger: false, createdAt: order.createdAt,
  }
}

async function snapshotFor(harness: Harness, openOrders: VenueOpenOrder[], stale: boolean, truncated: boolean): Promise<StartupSnapshot> {
  const account = await harness.live.accountState(harness.k.bus.accountRef(harness.liveAcct))
  return { account: { ...account, stale }, openOrders, fills: [], fillsSince: harness.clock.now() - 86_400_000, truncated }
}

describe('startup reconciliation freshness', () => {
  it('passes each local order instrument and existing venue id into startup lookup', async () => {
    h = await makeHarness()
    const order = { ...localOpenOrder(h), venueOrderId: 'existing-venue-order' }
    h.k.orders.upsert(order, '80', true)
    h.live.reconcileResult = []
    const status = vi.spyOn(h.live, 'orderStatus').mockResolvedValue({ found: true, status: 'open', venueOrderId: order.venueOrderId })

    const result = await h.k.startupReconcile(1000, 'hyperliquid')

    expect(result).toEqual([{ account: order.accountId, ok: true }])
    expect(status).toHaveBeenCalledWith(expect.anything(), {
      clientOrderId: order.clientOrderId,
      venueOrderId: 'existing-venue-order',
      instrumentId: order.instrumentId,
    })
  })

  it('waits for a fresh complete remote view before lookup or fill backfill', async () => {
    h = await makeHarness()
    const order = localOpenOrder(h)
    h.k.orders.upsert(order, '80', true)
    const stale = await snapshotFor(h, [], true, false)
    const fresh = await snapshotFor(h, [rowFor(order)], false, false)
    h.live.startupResponseSequence = [stale, fresh]

    const result = await h.k.startupReconcile(1000, 'hyperliquid')
    expect(result).toEqual([{ account: h.liveAcct.accountId, ok: true }])
    expect(h.live.startupSnapshotCalls).toBe(2)
    expect(h.live.orderStatusCalls).toBe(0)
    expect(h.k.orders.get(order.orderId)?.status).toBe('open')
    expect([...h.k.ledger.iterate()].some((entry) => entry.type === 'startup.reconciled' && (entry.payload as { ok?: boolean }).ok === true)).toBe(true)
  })

  it.each([
    { name: 'stale account', stale: true, truncated: false },
    { name: 'truncated fills', stale: false, truncated: true },
  ])('keeps the account halted and skips reconciliation work on %s timeout', async ({ stale, truncated }) => {
    h = await makeHarness()
    const order = localOpenOrder(h)
    h.k.orders.upsert(order, '80', true)
    const incomplete = await snapshotFor(h, [], stale, truncated)
    h.live.startupResponseSequence = [incomplete, 'hang']

    const result = await h.k.startupReconcile(150, 'hyperliquid')
    expect(result).toHaveLength(1)
    expect(result[0]?.ok).toBe(false)
    expect(h.live.startupSnapshotCalls).toBe(2)
    expect(h.live.orderStatusCalls).toBe(0)
    expect(h.k.orders.get(order.orderId)?.status).toBe('open')
    expect(h.k.tstate.get({ type: 'account', id: h.liveAcct.accountId })).toBe('HALTED')
    const entry = [...h.k.ledger.iterate()].reverse().find((item) => item.type === 'startup.reconciled')!
    expect(entry.payload).toMatchObject({ ok: false, stale, truncated })
  })
})
