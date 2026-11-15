// SPDX-License-Identifier: CPAL-1.0
// 订阅：不开 WS，按 pollMs 轮询盘口 + 最近成交回 quote 事件；退订 / close 之后不再回调。
import { describe, expect, it } from 'vitest'
import type { VenueEvent } from '@gitrader/protocol/connector'
import { DydxDataConnector } from '../src/connector'
import { FakeDydx, FX_NOW, sleep, waitFor } from './helpers/fake-dydx'

const BASE = 'http://dydx.example.test'

function make() {
  const fake = new FakeDydx()
  const connector = new DydxDataConnector({ baseUrl: BASE, fetchImpl: fake.fetch, clock: () => FX_NOW, pollMs: 5 })
  return { fake, connector }
}

describe('subscribe', () => {
  it('polls the book and the last trade, delivering quote events without opening a websocket', async () => {
    const { fake, connector } = make()
    const events: VenueEvent[] = []
    const off = connector.subscribe({ channel: 'quote', instrumentId: 'dydx:BTC-USD' }, (e) => events.push(e))

    await waitFor(() => events.length > 0)
    off()

    expect(events[0]).toMatchObject({
      channel: 'quote',
      quote: { instrumentId: 'dydx:BTC-USD', bid: 82379, ask: 82400, last: 82350, stale: false },
    })
    expect(fake.callsOfKind('orderbook').length).toBeGreaterThan(0)
    expect(fake.callsOfKind('trades').length).toBeGreaterThan(0)
    expect(connector.status()).toMatchObject({ source: 'rest', wsState: 'disconnected', stale: false })
    await connector.close()
  })

  it('stops calling back after unsubscribe', async () => {
    const { connector } = make()
    const events: VenueEvent[] = []
    const off = connector.subscribe({ channel: 'quote', instrumentId: 'dydx:BTC-USD' }, (e) => events.push(e))
    await waitFor(() => events.length > 0)

    off()
    const seen = events.length
    await sleep(40)
    expect(events.length).toBe(seen)
    await connector.close()
  })

  it('close() stops every running poll', async () => {
    const { fake, connector } = make()
    const events: VenueEvent[] = []
    connector.subscribe({ channel: 'quote', instrumentId: 'dydx:BTC-USD' }, (e) => events.push(e))
    await waitFor(() => events.length > 0)

    await connector.close()
    const calls = fake.calls.length
    const seen = events.length
    await sleep(40)
    expect(events.length).toBe(seen)
    expect(fake.calls.length).toBe(calls)
  })

  it('survives a failed poll round and keeps polling', async () => {
    const { fake, connector } = make()
    const events: VenueEvent[] = []
    fake.override.set('orderbook', () => new Response('boom', { status: 500 }))
    connector.subscribe({ channel: 'quote', instrumentId: 'dydx:BTC-USD' }, (e) => events.push(e))
    await sleep(30)
    expect(events).toHaveLength(0)

    fake.override.delete('orderbook')
    await waitFor(() => events.length > 0)
    expect(events[0]).toMatchObject({ channel: 'quote', quote: { bid: 82379, ask: 82400 } })
    await connector.close()
  })

  it('refuses channels it cannot serve over REST polling', () => {
    const { connector } = make()
    expect(() => connector.subscribe({ channel: 'book', instrumentId: 'dydx:BTC-USD' }, () => {})).toThrow(
      /dydx data connector polls quote subscriptions only/,
    )
    expect(() => connector.subscribe({ channel: 'mids' }, () => {})).toThrow(/quote subscriptions only/)
    void connector.close()
  })
})
