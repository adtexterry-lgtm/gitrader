// SPDX-License-Identifier: CPAL-1.0
// 订阅：不开 WS，按 pollMs 轮询 /api/v1/ticker 回 quote 事件；退订 / close 之后不再回调。
import { describe, expect, it } from 'vitest'
import type { VenueEvent } from '@gitrader/protocol/connector'
import { KucoinDataConnector } from '../src/connector'
import { FakeKucoin, FX_NOW, sleep, waitFor } from './helpers/fake-kucoin'

function make() {
  const fake = new FakeKucoin()
  const connector = new KucoinDataConnector({
    baseUrl: 'http://kucoin.example.test', fetchImpl: fake.fetch, clock: () => FX_NOW, pollMs: 5,
  })
  return { fake, connector }
}

describe('subscribe', () => {
  it('polls ticker and delivers quote events without opening a websocket', async () => {
    const { fake, connector } = make()
    const events: VenueEvent[] = []
    const off = connector.subscribe({ channel: 'quote', instrumentId: 'kucoin:XBTUSDTM' }, (e) => events.push(e))

    await waitFor(() => events.length > 0)
    off()

    expect(events[0]).toMatchObject({
      channel: 'quote',
      quote: { instrumentId: 'kucoin:XBTUSDTM', bid: 82_407.2, ask: 82_407.3, ts: FX_NOW, stale: false },
    })
    expect(fake.callsTo('/api/v1/ticker')[0]!.params.get('symbol')).toBe('XBTUSDTM')
    expect(connector.status()).toMatchObject({ source: 'rest', wsState: 'disconnected', stale: false })
    await connector.close()
  })

  it('keeps polling on the configured interval', async () => {
    const { fake, connector } = make()
    const events: VenueEvent[] = []
    const off = connector.subscribe({ channel: 'quote', instrumentId: 'kucoin:XBTUSDTM' }, (e) => events.push(e))

    await waitFor(() => events.length >= 3)
    off()
    expect(fake.callsTo('/api/v1/ticker').length).toBeGreaterThanOrEqual(3)
    await connector.close()
  })

  it('stops calling back after unsubscribe', async () => {
    const { connector } = make()
    const events: VenueEvent[] = []
    const off = connector.subscribe({ channel: 'quote', instrumentId: 'kucoin:XBTUSDTM' }, (e) => events.push(e))
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
    connector.subscribe({ channel: 'quote', instrumentId: 'kucoin:XBTUSDTM' }, (e) => events.push(e))
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
    expect(() => connector.subscribe({ channel: 'book', instrumentId: 'kucoin:XBTUSDTM' }, () => {})).toThrow(
      /kucoin data connector polls quote subscriptions only/,
    )
  })
})
