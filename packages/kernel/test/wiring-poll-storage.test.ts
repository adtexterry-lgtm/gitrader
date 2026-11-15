// SPDX-License-Identifier: CPAL-1.0
import { afterEach, describe, expect, it } from 'vitest'
import type { Order } from '@gitrader/protocol'
import { makeHarness } from './helpers/harness'

describe('OrderStore.forPolling', () => {
  let cleanup: (() => Promise<void>) | undefined
  afterEach(async () => { await cleanup?.(); cleanup = undefined })

  it('keeps all old open orders and fresh valid terminal orders, isolated by account without a result cap', async () => {
    const h = await makeHarness()
    cleanup = h.cleanup
    const sinceMs = 100
    const add = (id: string, accountId: string, status: string, updatedAt: number): Order => {
      const order = {
        orderId: id as Order['orderId'], clientOrderId: `client-${id}` as Order['clientOrderId'],
        venueOrderId: `venue-${id}`, accountId: accountId as Order['accountId'], instrumentId: 'hyperliquid:BTC' as Order['instrumentId'],
        side: 'buy', type: 'limit', tif: 'gtc', size: '1', filledSize: '0', status, fee: '0', origin: h.human().origin,
        createdAt: 1, updatedAt,
      } as Order
      h.k.orders.upsert(order, '1', true)
      return order
    }
    const openIds: string[] = []
    for (let i = 0; i < 1005; i++) openIds.push(add(`old-open-${String(i).padStart(4, '0')}`, h.liveAcct.accountId, 'open', 1).orderId)
    const freshTerminals = [
      add('fresh-filled', h.liveAcct.accountId, 'filled', sinceMs),
      add('fresh-cancelled', h.liveAcct.accountId, 'cancelled', 120),
      add('fresh-expired', h.liveAcct.accountId, 'expired', 130),
    ]
    add('fresh-rejected', h.liveAcct.accountId, 'rejected', 140)
    add('fresh-denied', h.liveAcct.accountId, 'denied', 150)
    add('old-filled', h.liveAcct.accountId, 'filled', 99)
    add('other-account-open', h.paper.accountId, 'open', 200)

    const actual = h.k.orders.forPolling(h.liveAcct.accountId, sinceMs)
    const ids = actual.map((o) => o.orderId)
    expect(ids).toHaveLength(1008)
    expect(ids).toEqual(expect.arrayContaining([...openIds, ...freshTerminals.map((o) => o.orderId)]))
    expect(ids).not.toContain('fresh-rejected')
    expect(ids).not.toContain('fresh-denied')
    expect(ids).not.toContain('old-filled')
    expect(ids).not.toContain('other-account-open')
    expect(h.k.orders.forPolling(h.liveAcct.accountId, sinceMs).map((o) => o.orderId)).toEqual(ids)
  })
})
