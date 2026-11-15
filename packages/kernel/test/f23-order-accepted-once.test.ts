// SPDX-License-Identifier: CPAL-1.0
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Order, OrderIntent } from '../src/proto'
import { Kernel } from '../src/kernel'
import { fileProvider } from '../src/device-key'
import { mkOrigin } from '../src/util/origin'
import { PaperVenue } from '../../venue-paper/src/venue'
import { BTC, TestMarket } from '../../venue-paper/test/helpers/test-market'
import { FakeConnector } from './helpers/fake-connector'
import type { ActorCtx } from '../src/trading'

describe('WI-F23 one order.accepted per order', () => {
  let k: Kernel, home: string, market: TestMarket, paper: PaperVenue, human: ActorCtx
  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'gitrader-f23-accepted-'))
    market = new TestMarket()
    k = await Kernel.create({ home, clock: { now: () => market.now }, deviceKeyProvider: fileProvider, scrypt: { N: 1024, r: 8, p: 1 }, timers: false })
    const source = new FakeConnector({ id: 'hyperliquid', clock: { now: () => market.now } })
    source.quote = market.quote.bind(market)
    source.context = market.context.bind(market)
    paper = new PaperVenue({ market, clock: () => market.now })
    k.registerConnector(source)
    k.registerConnector(paper)
    const session = k.auth.authenticateToken(k.auth.exchangeBoot(k.auth.mintBootToken()).sessionToken)!
    human = { principal: session, origin: mkOrigin('user:usr_local', 'order', 'ui') }
  })
  afterEach(async () => {
    await k?.stop()
    if (home) rmSync(home, { recursive: true, force: true })
  })

  const intent = (extra: Partial<OrderIntent> = {}): OrderIntent => ({
    accountId: k.accounts.find('paper')!.accountId, instrumentId: BTC, side: 'buy', type: 'limit',
    price: '79000', size: '0.003', reason: 'f23 order.accepted fixture', ...extra,
  } as OrderIntent)
  const place = async (extra: Partial<OrderIntent> = {}): Promise<Order> => {
    const result = await k.trading.place({ intent: intent(extra) }, human)
    expect(result.order).toBeDefined()
    return result.order!
  }
  const trail = (o: Order): string[] => k.ledger.trace({ orderId: o.orderId }).map((entry) => entry.type)

  it('keeps exactly one order.accepted for a resting limit order when the venue pushes open', async () => {
    const order = await place()
    expect(order.status).toBe('open')
    expect(trail(order).filter((type) => type === 'order.accepted')).toHaveLength(1)
    k.trading.onOrderUpdate(order.accountId, { venueOrderId: order.venueOrderId!, clientOrderId: order.clientOrderId, status: 'open' })
    expect(k.orders.get(order.orderId)?.status).toBe('open')
    expect(trail(order).filter((type) => type === 'order.accepted')).toHaveLength(1)
  })

  it('keeps exactly one order.accepted for an untriggered stop and records the later open as order.triggered', async () => {
    const stop = await place({ type: 'stop_market', price: undefined, triggerPrice: '78000' as never })
    expect(stop.status).toBe('untriggered')
    expect(trail(stop).filter((type) => type === 'order.accepted')).toHaveLength(1)
    k.trading.onOrderUpdate(stop.accountId, { venueOrderId: stop.venueOrderId!, clientOrderId: stop.clientOrderId, status: 'untriggered' })
    expect(trail(stop).filter((type) => type === 'order.accepted')).toHaveLength(1)
    k.trading.onOrderUpdate(stop.accountId, { venueOrderId: stop.venueOrderId!, clientOrderId: stop.clientOrderId, status: 'open' })
    expect(k.orders.get(stop.orderId)?.status).toBe('open')
    expect(trail(stop).filter((type) => type === 'order.accepted')).toHaveLength(1)
    expect(trail(stop).filter((type) => type === 'order.triggered')).toHaveLength(1)
  })
})
