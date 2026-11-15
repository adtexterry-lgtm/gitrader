// SPDX-License-Identifier: CPAL-1.0
// 订阅：只支持 quote 频道，按 pollMs 轮询 /quote 回调；退订与 close() 都能停下轮询。
import { describe, expect, it } from 'vitest'
import type { StampedQuote } from '@gitrader/protocol/connector'
import { FinnhubDataConnector } from '../src/connector'
import { FakeFinnhub, FX_NOW, sleep, waitFor } from './helpers/fake-finnhub'

function make(o: Record<string, unknown> = {}) {
  const fake = new FakeFinnhub()
  const connector = new FinnhubDataConnector({
    baseUrl: 'https://finnhub.example.test/v1', fetchImpl: fake.fetch, clock: () => FX_NOW,
    env: { FINNHUB_API_KEY: 'test-finnhub-key' }, pollMs: 10, ...o,
  })
  return { fake, connector }
}

describe('quote subscription (polling)', () => {
  it('delivers quote events from polling /quote and reports the REST source', async () => {
    const { fake, connector } = make()
    const seen: StampedQuote[] = []
    const stop = connector.subscribe({ channel: 'quote', instrumentId: 'finnhub:AAPL' }, (e) => {
      if (e.channel === 'quote') seen.push(e.quote)
    })

    await waitFor(() => seen.length >= 2)
    stop()

    expect(seen[0]).toMatchObject({ instrumentId: 'finnhub:AAPL', bid: 100.5, ask: 100.5, last: 100.5 })
    expect(fake.callsTo('/quote').length).toBeGreaterThanOrEqual(2)
    expect(connector.status().source).toBe('rest')
    expect(connector.status().stale).toBe(false)
  })

  it('stops polling after the returned unsubscribe runs', async () => {
    const { fake, connector } = make()
    let events = 0
    const stop = connector.subscribe({ channel: 'quote', instrumentId: 'finnhub:AAPL' }, () => { events += 1 })
    await waitFor(() => events >= 1)
    stop()

    const callsAtStop = fake.callsTo('/quote').length
    await sleep(40)
    expect(fake.callsTo('/quote').length).toBe(callsAtStop)
  })

  it('close() stops every subscription', async () => {
    const { fake, connector } = make()
    let events = 0
    connector.subscribe({ channel: 'quote', instrumentId: 'finnhub:AAPL' }, () => { events += 1 })
    await waitFor(() => events >= 1)
    await connector.close()

    const callsAtClose = fake.callsTo('/quote').length
    await sleep(40)
    expect(fake.callsTo('/quote').length).toBe(callsAtClose)
    expect(() => connector.subscribe({ channel: 'quote', instrumentId: 'finnhub:AAPL' }, () => {})).toThrow(/closed/)
  })

  it('refuses channels it cannot serve (no WebSocket, no book stream)', () => {
    const { connector } = make()
    expect(() => connector.subscribe({ channel: 'book', instrumentId: 'finnhub:AAPL' }, () => {}))
      .toThrow(/polls quote subscriptions only/)
    expect(() => connector.subscribe({ channel: 'mids' }, () => {})).toThrow(/polls quote subscriptions only/)
  })

  it('keeps polling when a subscriber throws', async () => {
    const { connector } = make()
    let ok = 0
    connector.subscribe({ channel: 'quote', instrumentId: 'finnhub:AAPL' }, () => { throw new Error('subscriber bug') })
    const stop = connector.subscribe({ channel: 'quote', instrumentId: 'finnhub:AAPL' }, () => { ok += 1 })
    await waitFor(() => ok >= 2)
    stop()
    expect(ok).toBeGreaterThanOrEqual(2)
  })
})
