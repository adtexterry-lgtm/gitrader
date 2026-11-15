// SPDX-License-Identifier: CPAL-1.0
// 订阅：不开 WS，按 pollMs 轮询 ticker 回 quote 事件；退订 / close 之后不再回调。
import { describe, expect, it } from 'vitest'
import type { VenueEvent } from '@gitrader/protocol/connector'
import { CoinbaseDataConnector } from '../src/connector'
import { FakeCoinbase, FX_NOW, sleep, waitFor } from './helpers/fake-coinbase'

const TICKER_PATH = '/api/v3/brokerage/market/products/BTC-USD/ticker'

function make() {
  const fake = new FakeCoinbase()
  const connector = new CoinbaseDataConnector({
    baseUrl: 'http://coinbase.example.test', fetchImpl: fake.fetch, clock: () => FX_NOW, pollMs: 5,
  })
  return { fake, connector }
}

describe('subscribe', () => {
  it('polls ticker and delivers quote events without opening a websocket', async () => {
    const { fake, connector } = make()
    const events: VenueEvent[] = []
    const off = connector.subscribe({ channel: 'quote', instrumentId: 'coinbase:BTC-USD' }, (e) => events.push(e))

    await waitFor(() => events.length > 0)
    off()

    expect(events[0]).toMatchObject({
      channel: 'quote',
      quote: { instrumentId: 'coinbase:BTC-USD', bid: 82363.57, ask: 82363.58, last: 82363.33, stale: false },
    })
    expect(fake.callsTo(TICKER_PATH)[0]!.params.get('limit')).toBe('1')
    expect(connector.status()).toMatchObject({ source: 'rest', wsState: 'disconnected', stale: false })
    await connector.close()
  })

  it('stops calling back after unsubscribe', async () => {
    const { connector } = make()
    const events: VenueEvent[] = []
    const off = connector.subscribe({ channel: 'quote', instrumentId: 'coinbase:BTC-USD' }, (e) => events.push(e))
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
    connector.subscribe({ channel: 'quote', instrumentId: 'coinbase:BTC-USD' }, (e) => events.push(e))
    await waitFor(() => events.length > 0)

    await connector.close()
    const calls = fake.calls.length
    const seen = events.length
    await sleep(40)
    expect(events.length).toBe(seen)
    expect(fake.calls.length).toBe(calls)
  })

  it('refuses channels it cannot serve over REST polling, and refuses to start after close', async () => {
    const { connector } = make()
    expect(() => connector.subscribe({ channel: 'book', instrumentId: 'coinbase:BTC-USD' }, () => {})).toThrow(
      /coinbase data connector polls quote subscriptions only/,
    )
    await connector.close()
    expect(() => connector.subscribe({ channel: 'quote', instrumentId: 'coinbase:BTC-USD' }, () => {})).toThrow(
      /coinbase data connector is closed/,
    )
  })
})
