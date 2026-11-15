// SPDX-License-Identifier: CPAL-1.0
// 订阅：不开 WS，按 pollMs 轮询 /mix/market/ticker 回 quote 事件；退订 / close 之后不再回调。
import { describe, expect, it } from 'vitest'
import type { VenueEvent } from '@gitrader/protocol/connector'
import { BitgetDataConnector } from '../src/connector'
import { FakeBitget, FX_NOW, sleep, waitFor } from './helpers/fake-bitget'

function make() {
  const fake = new FakeBitget()
  const connector = new BitgetDataConnector({
    baseUrl: 'http://bitget.example.test', fetchImpl: fake.fetch, clock: () => FX_NOW, pollMs: 5,
  })
  return { fake, connector }
}

describe('subscribe', () => {
  it('polls ticker and delivers quote events without opening a websocket', async () => {
    const { fake, connector } = make()
    const events: VenueEvent[] = []
    const off = connector.subscribe({ channel: 'quote', instrumentId: 'bitget:BTCUSDT' }, (e) => events.push(e))

    await waitFor(() => events.length > 0)
    off()

    expect(events[0]).toMatchObject({
      channel: 'quote',
      quote: { instrumentId: 'bitget:BTCUSDT', bid: 82396.1, ask: 82396.2, stale: false },
    })
    const call = fake.callsTo('/api/v2/mix/market/ticker')[0]!
    expect(call.params.get('symbol')).toBe('BTCUSDT')
    expect(call.params.get('productType')).toBe('USDT-FUTURES')
    expect(connector.status()).toMatchObject({ source: 'rest', wsState: 'disconnected', stale: false })
    await connector.close()
  })

  it('stops calling back after unsubscribe', async () => {
    const { connector } = make()
    const events: VenueEvent[] = []
    const off = connector.subscribe({ channel: 'quote', instrumentId: 'bitget:BTCUSDT' }, (e) => events.push(e))
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
    connector.subscribe({ channel: 'quote', instrumentId: 'bitget:BTCUSDT' }, (e) => events.push(e))
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
    expect(() => connector.subscribe({ channel: 'book', instrumentId: 'bitget:BTCUSDT' }, () => {})).toThrow(
      /bitget data connector polls quote subscriptions only/,
    )
  })

  it('reports a stale feed when no tick has landed within staleMs', async () => {
    const fake = new FakeBitget()
    const t = { now: FX_NOW }
    const connector = new BitgetDataConnector({ fetchImpl: fake.fetch, clock: () => t.now, pollMs: 60_000 })
    const off = connector.subscribe({ channel: 'quote', instrumentId: 'bitget:BTCUSDT' }, () => {})
    await waitFor(() => connector.quote('bitget:BTCUSDT') !== undefined)
    off()
    t.now += 20_000
    expect(connector.status().stale).toBe(true)
    await connector.close()
  })
})
