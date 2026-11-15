// SPDX-License-Identifier: CPAL-1.0
// 订阅：不开 WS，按 pollMs 轮询 market/detail/merged 回 quote 事件；退订 / close 之后不再回调。
import { describe, expect, it } from 'vitest'
import type { VenueEvent } from '@gitrader/protocol/connector'
import { HtxDataConnector } from '../src/connector'
import { FakeHtx, FX_NOW, sleep, waitFor } from './helpers/fake-htx'

function make() {
  const fake = new FakeHtx()
  const connector = new HtxDataConnector({
    baseUrl: 'https://htx.example.test', fetchImpl: fake.fetch, clock: () => FX_NOW, pollMs: 5,
  })
  return { fake, connector }
}

describe('subscribe', () => {
  it('polls the merged ticker and delivers quote events without opening a websocket', async () => {
    const { fake, connector } = make()
    const events: VenueEvent[] = []
    const off = connector.subscribe({ channel: 'quote', instrumentId: 'htx:BTC-USDT' }, (e) => events.push(e))

    await waitFor(() => events.length > 0)
    off()

    expect(events[0]).toMatchObject({
      channel: 'quote',
      quote: { instrumentId: 'htx:BTC-USDT', bid: 13082.9, ask: 13084.2, stale: false },
    })
    expect(fake.callsTo('/linear-swap-ex/market/detail/merged')[0]!.params.get('contract_code')).toBe('BTC-USDT')
    expect(connector.status()).toMatchObject({ source: 'rest', wsState: 'disconnected', stale: false })
    await connector.close()
  })

  it('stops calling back after unsubscribe', async () => {
    const { connector } = make()
    const events: VenueEvent[] = []
    const off = connector.subscribe({ channel: 'quote', instrumentId: 'htx:BTC-USDT' }, (e) => events.push(e))
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
    connector.subscribe({ channel: 'quote', instrumentId: 'htx:BTC-USDT' }, (e) => events.push(e))
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
    expect(() => connector.subscribe({ channel: 'book', instrumentId: 'htx:BTC-USDT' }, () => {})).toThrow(
      /htx data connector polls quote subscriptions only/,
    )
  })

  it('refuses to subscribe after close()', async () => {
    const { connector } = make()
    await connector.close()
    expect(() => connector.subscribe({ channel: 'quote', instrumentId: 'htx:BTC-USDT' }, () => {})).toThrow(
      /htx data connector is closed/,
    )
  })
})
