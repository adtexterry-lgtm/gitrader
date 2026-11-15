// SPDX-License-Identifier: CPAL-1.0
// 订阅：不开 WS，按 pollMs 轮询快照回 quote 事件；退订 / close 之后不再回调；其它频道一律 CAPABILITY_UNSUPPORTED。
import { describe, expect, it } from 'vitest'
import type { VenueEvent } from '@gitrader/protocol/connector'
import { AlpacaDataConnector } from '../src/connector'
import { ProblemError } from '../src/parse'
import { DATA_HOST, FX_NOW, FakeAlpaca, TRADING_HOST, sleep, waitFor } from './helpers/fake-alpaca'

const ID = 'alpaca:AAPL'
const SNAPSHOT_PATH = '/v2/stocks/AAPL/snapshot'

function make(): { fake: FakeAlpaca; connector: AlpacaDataConnector } {
  const fake = new FakeAlpaca()
  const connector = new AlpacaDataConnector({
    tradingBaseUrl: `http://${TRADING_HOST}`,
    dataBaseUrl: `http://${DATA_HOST}`,
    fetchImpl: fake.fetch,
    clock: () => FX_NOW,
    pollMs: 5,
    env: {},
  })
  return { fake, connector }
}

describe('subscribe', () => {
  it('polls the snapshot and delivers quote events without opening a websocket', async () => {
    const { fake, connector } = make()
    const events: VenueEvent[] = []
    const off = connector.subscribe({ channel: 'quote', instrumentId: ID }, (e) => events.push(e))

    await waitFor(() => events.length > 0)
    off()

    expect(events[0]).toMatchObject({
      channel: 'quote',
      quote: { instrumentId: ID, bid: 202.5, ask: 202.55, last: 202.52, stale: false },
    })
    expect(fake.callsTo(DATA_HOST, SNAPSHOT_PATH)[0]!.params.get('feed')).toBe('iex')
    expect(connector.status()).toMatchObject({ source: 'rest', wsState: 'disconnected' })
    await connector.close()
  })

  it('stops calling back after unsubscribe', async () => {
    const { connector } = make()
    const events: VenueEvent[] = []
    const off = connector.subscribe({ channel: 'quote', instrumentId: ID }, (e) => events.push(e))
    await waitFor(() => events.length >= 2)
    off()

    const seen = events.length
    await sleep(40)
    expect(events.length).toBe(seen)
    await connector.close()
  })

  it('stops polling after close()', async () => {
    const { connector } = make()
    const events: VenueEvent[] = []
    connector.subscribe({ channel: 'quote', instrumentId: ID }, (e) => events.push(e))
    await waitFor(() => events.length > 0)
    await connector.close()

    const seen = events.length
    await sleep(40)
    expect(events.length).toBe(seen)
  })

  it('rejects channels it cannot serve (no L2 / no candle stream)', () => {
    const { connector } = make()
    for (const spec of [
      { channel: 'book', instrumentId: ID },
      { channel: 'candle', instrumentId: ID, interval: '1m' },
      { channel: 'mids' },
    ] as const) {
      let caught: unknown
      try {
        connector.subscribe(spec as never, () => {})
      } catch (e) {
        caught = e
      }
      expect(caught, spec.channel).toBeInstanceOf(ProblemError)
      expect((caught as ProblemError).problem).toMatchObject({ name: 'CAPABILITY_UNSUPPORTED' })
    }
  })

  it('refuses subscriptions on a closed connector', async () => {
    const { connector } = make()
    await connector.close()
    expect(() => connector.subscribe({ channel: 'quote', instrumentId: ID }, () => {})).toThrow(/is closed/)
  })
})
