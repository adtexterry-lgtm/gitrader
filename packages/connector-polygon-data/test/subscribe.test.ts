// SPDX-License-Identifier: CPAL-1.0
// 订阅：不开 WS，按 pollMs 轮询快照回调 quote 事件；退订后不再请求；非 quote 频道拒绝；close() 停轮询。
import { describe, expect, it } from 'vitest'
import { PolygonDataConnector } from '../src/connector'
import type { StampedQuote } from '@gitrader/protocol/connector'
import { API_KEY, FX_NOW, FakePolygon, HOST, waitFor } from './helpers/fake-polygon'

const ID = 'polygon:AAPL'
const SNAPSHOT_PREFIX = '/v2/snapshot/locale/us/markets/stocks/tickers/AAPL'

function make(o: Record<string, unknown> = {}): { fake: FakePolygon; connector: PolygonDataConnector } {
  const fake = new FakePolygon()
  const connector = new PolygonDataConnector({
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
  it('polls the snapshot endpoint and emits quote events', async () => {
    const { fake, connector } = make()
    const seen: StampedQuote[] = []
    const off = connector.subscribe({ channel: 'quote', instrumentId: ID }, (e) => {
      if (e.channel === 'quote') seen.push(e.quote)
    })
    await waitFor(() => seen.length >= 2)
    off()
    expect(seen[0]).toMatchObject({ instrumentId: ID, bid: 202.5, ask: 202.55, last: 202.52 })
    expect(fake.callsTo(SNAPSHOT_PREFIX).length).toBeGreaterThanOrEqual(2)
  })

  it('stops requesting after the returned unsubscribe is called twice', async () => {
    const { fake, connector } = make()
    const off = connector.subscribe({ channel: 'quote', instrumentId: ID }, () => {})
    await waitFor(() => fake.callsTo(SNAPSHOT_PREFIX).length >= 1)
    off()
    off()
    const afterUnsubscribe = fake.callsTo(SNAPSHOT_PREFIX).length
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(fake.callsTo(SNAPSHOT_PREFIX)).toHaveLength(afterUnsubscribe)
  })

  it('rejects any channel other than quote and leaves no timer behind', () => {
    const { fake, connector } = make()
    expect(() => connector.subscribe({ channel: 'candle', instrumentId: ID, interval: '1m' }, () => {}))
      .toThrow(/polls quote subscriptions only/)
    expect(() => connector.subscribe({ channel: 'orderUpdates', address: `0x${'1'.repeat(64)}` } as never, () => {}))
      .toThrow(/polls quote subscriptions only/)
    expect(fake.calls).toHaveLength(0)
  })

  it('stops polling after close()', async () => {
    const { fake, connector } = make()
    connector.subscribe({ channel: 'quote', instrumentId: ID }, () => {})
    await waitFor(() => fake.callsTo(SNAPSHOT_PREFIX).length >= 1)
    await connector.close()
    const afterClose = fake.callsTo(SNAPSHOT_PREFIX).length
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(fake.callsTo(SNAPSHOT_PREFIX)).toHaveLength(afterClose)
    await expect(connector.candles(ID, '1m')).rejects.toThrow(/is closed/)
    expect(() => connector.subscribe({ channel: 'quote', instrumentId: ID }, () => {})).toThrow(/is closed/)
  })

  it('keeps polling when a round fails and leaves lastMessageTs untouched until a round succeeds', async () => {
    const { fake, connector } = make({ pollMs: 5 })
    let round = 0
    fake.override.set(SNAPSHOT_PREFIX, () => {
      round += 1
      if (round <= 2) return new Response('boom', { status: 500 })
      return new Response(JSON.stringify({
        status: 'OK',
        ticker: { ticker: 'AAPL', lastQuote: { p: 202.5, P: 202.55, t: Date.parse('2026-10-21T13:59:58Z') * 1e6 } },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const seen: StampedQuote[] = []
    const off = connector.subscribe({ channel: 'quote', instrumentId: ID }, (e) => {
      if (e.channel === 'quote') seen.push(e.quote)
    })
    await waitFor(() => round >= 2)
    expect(seen).toHaveLength(0)
    expect(connector.status()).toMatchObject({ lastMessageTs: 0, stale: true })
    await waitFor(() => seen.length >= 1)
    off()
    expect(connector.status()).toMatchObject({ lastMessageTs: FX_NOW, stale: false })
  })
})
