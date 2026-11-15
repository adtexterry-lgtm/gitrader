// SPDX-License-Identifier: CPAL-1.0
// 订阅：不开 WS，按 pollMs 轮询 /market/ticker 回 quote 事件；退订 / close 之后不再回调。
import { describe, expect, it } from 'vitest'
import type { VenueEvent } from '@gitrader/protocol/connector'
import { OkxDataConnector } from '../src/connector'
import { FakeOkx, FX_NOW, sleep, waitFor } from './helpers/fake-okx'

function make() {
  const fake = new FakeOkx()
  const connector = new OkxDataConnector({
    baseUrl: 'http://okx.example.test', fetchImpl: fake.fetch, clock: () => FX_NOW, pollMs: 5,
  })
  return { fake, connector }
}

describe('subscribe', () => {
  it('polls ticker and delivers quote events without opening a websocket', async () => {
    const { fake, connector } = make()
    const events: VenueEvent[] = []
    const off = connector.subscribe({ channel: 'quote', instrumentId: 'okx:BTC-USDT-SWAP' }, (e) => events.push(e))

    await waitFor(() => events.length > 0)
    off()

    expect(events[0]).toMatchObject({
      channel: 'quote',
      quote: { instrumentId: 'okx:BTC-USDT-SWAP', bid: 100.1, ask: 100.2, stale: false },
    })
    expect(fake.callsTo('/api/v5/market/ticker')[0]!.params.get('instId')).toBe('BTC-USDT-SWAP')
    expect(connector.status()).toMatchObject({ source: 'rest', wsState: 'disconnected', stale: false })
    await connector.close()
  })

  it('stops calling back after unsubscribe', async () => {
    const { connector } = make()
    const events: VenueEvent[] = []
    const off = connector.subscribe({ channel: 'quote', instrumentId: 'okx:BTC-USDT-SWAP' }, (e) => events.push(e))
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
    connector.subscribe({ channel: 'quote', instrumentId: 'okx:BTC-USDT-SWAP' }, (e) => events.push(e))
    await waitFor(() => events.length > 0)

    await connector.close()
    const calls = fake.calls.length
    const seen = events.length
    await sleep(40)
    expect(events.length).toBe(seen)
    expect(fake.calls.length).toBe(calls)
  })

  it('refuses channels it cannot serve over REST polling', () => {
    const { connector } = make()
    expect(() => connector.subscribe({ channel: 'book', instrumentId: 'okx:BTC-USDT-SWAP' }, () => {})).toThrow(
      /okx data connector polls quote subscriptions only/,
    )
  })
})
