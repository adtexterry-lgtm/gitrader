// SPDX-License-Identifier: CPAL-1.0
// 订阅：不开 WS，按 pollMs 轮询 GLOBAL_QUOTE 回调 quote 事件；退订后不再请求；非 quote 频道拒绝；close() 停轮询。
import { describe, expect, it } from 'vitest'
import { AlphaVantageDataConnector } from '../src/connector'
import type { StampedQuote } from '@gitrader/protocol/connector'
import { API_KEY, FX_NOW, FakeAlphaVantage, HOST, waitFor } from './helpers/fake-alphavantage'

const ID = 'alphavantage:AAPL'

function make(o: Record<string, unknown> = {}): { fake: FakeAlphaVantage; connector: AlphaVantageDataConnector } {
  const fake = new FakeAlphaVantage()
  const connector = new AlphaVantageDataConnector({
    apiKey: API_KEY,
    baseUrl: `http://${HOST}`,
    fetchImpl: fake.fetch,
    clock: () => FX_NOW,
    pollMs: 10,
    ...o,
  })
  return { fake, connector }
}

describe('subscribe (rest polling)', () => {
  it('polls the quote endpoint and emits quote events', async () => {
    const { fake, connector } = make()
    const seen: StampedQuote[] = []
    const off = connector.subscribe({ channel: 'quote', instrumentId: ID }, (e) => {
      if (e.channel === 'quote') seen.push(e.quote)
    })
    await waitFor(() => seen.length >= 2)
    off()
    expect(seen[0]).toMatchObject({ instrumentId: ID, last: 202.52, bid: 202.52, ask: 202.52 })
    expect(fake.callsOf('GLOBAL_QUOTE').length).toBeGreaterThanOrEqual(2)
  })

  it('stops requesting after the returned unsubscribe is called twice', async () => {
    const { fake, connector } = make()
    const off = connector.subscribe({ channel: 'quote', instrumentId: ID }, () => {})
    await waitFor(() => fake.callsOf('GLOBAL_QUOTE').length >= 1)
    off()
    off()
    const afterUnsubscribe = fake.callsOf('GLOBAL_QUOTE').length
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(fake.callsOf('GLOBAL_QUOTE')).toHaveLength(afterUnsubscribe)
  })

  it('rejects any channel other than quote and leaves no timer behind', () => {
    const { fake, connector } = make()
    expect(() => connector.subscribe({ channel: 'book', instrumentId: ID }, () => {}))
      .toThrow(/polls quote subscriptions only/)
    expect(() => connector.subscribe({ channel: 'mids' }, () => {}))
      .toThrow(/polls quote subscriptions only/)
    expect(fake.calls).toHaveLength(0)
  })

  it('stops polling after close()', async () => {
    const { fake, connector } = make()
    const off = connector.subscribe({ channel: 'quote', instrumentId: ID }, () => {})
    await waitFor(() => fake.callsOf('GLOBAL_QUOTE').length >= 1)
    await connector.close()
    const afterClose = fake.callsOf('GLOBAL_QUOTE').length
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(fake.callsOf('GLOBAL_QUOTE')).toHaveLength(afterClose)
    off()
    await expect(connector.candles(ID, '1d')).rejects.toThrow(/is closed/)
  })

  it('keeps polling when a round fails and leaves lastMessageTs untouched until a round succeeds', async () => {
    const { fake, connector } = make({ pollMs: 5 })
    let round = 0
    fake.override.set('GLOBAL_QUOTE', () => {
      round += 1
      if (round <= 2) return new Response('boom', { status: 500 })
      return new Response(JSON.stringify({ 'Global Quote': { '01. symbol': 'AAPL', '05. price': '202.5200' } }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    })
    const seen: StampedQuote[] = []
    const off = connector.subscribe({ channel: 'quote', instrumentId: ID }, (e) => {
      if (e.channel === 'quote') seen.push(e.quote)
    })
    await waitFor(() => round >= 2)
    expect(seen).toHaveLength(0)
    expect(connector.status().lastMessageTs).toBe(0)
    expect(connector.status().stale).toBe(true)
    await waitFor(() => seen.length >= 1)
    off()
    expect(connector.status().lastMessageTs).toBe(FX_NOW)
    expect(connector.status().stale).toBe(false)
  })
})
