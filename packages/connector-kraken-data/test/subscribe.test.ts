// SPDX-License-Identifier: CPAL-1.0
// 订阅：不开 WS，按 pollMs 轮询 /derivatives/api/v3/tickers 回 quote 事件；退订 / close 之后不再回调。
import { describe, expect, it } from 'vitest'
import type { VenueEvent } from '@gitrader/protocol/connector'
import { KrakenDataConnector } from '../src/connector'
import { FakeKraken, FX_NOW, sleep, waitFor } from './helpers/fake-kraken'

function make() {
  const fake = new FakeKraken()
  const connector = new KrakenDataConnector({
    baseUrl: 'http://kraken.example.test', fetchImpl: fake.fetch, clock: () => FX_NOW, pollMs: 5,
  })
  return { fake, connector }
}

describe('subscribe', () => {
  it('polls tickers and delivers quote events without opening a websocket', async () => {
    const { fake, connector } = make()
    const events: VenueEvent[] = []
    const off = connector.subscribe({ channel: 'quote', instrumentId: 'kraken:PF_XBTUSD' }, (e) => events.push(e))

    await waitFor(() => events.length > 0)
    off()

    expect(events[0]).toMatchObject({
      channel: 'quote',
      quote: { instrumentId: 'kraken:PF_XBTUSD', bid: 82347, ask: 82348, stale: false },
    })
    expect(fake.callsTo('/derivatives/api/v3/tickers').length).toBeGreaterThan(0)
    expect(connector.status()).toMatchObject({ source: 'rest', wsState: 'disconnected', stale: false })
    await connector.close()
  })

  it('stops calling back after unsubscribe', async () => {
    const { connector } = make()
    const events: VenueEvent[] = []
    const off = connector.subscribe({ channel: 'quote', instrumentId: 'kraken:PF_XBTUSD' }, (e) => events.push(e))
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
    connector.subscribe({ channel: 'quote', instrumentId: 'kraken:PF_XBTUSD' }, (e) => events.push(e))
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
    expect(() => connector.subscribe({ channel: 'book', instrumentId: 'kraken:PF_XBTUSD' }, () => {})).toThrow(
      /kraken data connector polls quote subscriptions only/,
    )
  })
})
