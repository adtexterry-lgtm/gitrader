// SPDX-License-Identifier: CPAL-1.0
// 订阅：不开 WS，按 pollMs 轮询 /v5/market/tickers 回 quote 事件；退订 / close 之后不再回调。
import { describe, expect, it } from 'vitest'
import type { VenueEvent } from '@gitrader/protocol/connector'
import { BybitDataConnector } from '../src/connector'
import { FakeBybit, FX_NOW, sleep, waitFor } from './helpers/fake-bybit'

function make() {
  const fake = new FakeBybit()
  const connector = new BybitDataConnector({
    baseUrl: 'http://bybit.example.test', fetchImpl: fake.fetch, clock: () => FX_NOW, pollMs: 5,
  })
  return { fake, connector }
}

describe('subscribe', () => {
  it('polls tickers and delivers quote events without opening a websocket', async () => {
    const { fake, connector } = make()
    const events: VenueEvent[] = []
    const off = connector.subscribe({ channel: 'quote', instrumentId: 'bybit:BTCUSDT' }, (e) => events.push(e))

    await waitFor(() => events.length > 0)
    off()

    expect(events[0]).toMatchObject({
      channel: 'quote',
      quote: { instrumentId: 'bybit:BTCUSDT', bid: 82428.5, ask: 82428.6, stale: false },
    })
    const call = fake.callsTo('/v5/market/tickers')[0]!
    expect(call.params.get('symbol')).toBe('BTCUSDT')
    expect(call.params.get('category')).toBe('linear')
    expect(connector.status()).toMatchObject({ source: 'rest', wsState: 'disconnected', stale: false })
    await connector.close()
  })

  it('stops calling back after unsubscribe', async () => {
    const { connector } = make()
    const events: VenueEvent[] = []
    const off = connector.subscribe({ channel: 'quote', instrumentId: 'bybit:BTCUSDT' }, (e) => events.push(e))
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
    connector.subscribe({ channel: 'quote', instrumentId: 'bybit:BTCUSDT' }, (e) => events.push(e))
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
    expect(() => connector.subscribe({ channel: 'book', instrumentId: 'bybit:BTCUSDT' }, () => {})).toThrow(
      /bybit data connector polls quote subscriptions only/,
    )
  })
})
