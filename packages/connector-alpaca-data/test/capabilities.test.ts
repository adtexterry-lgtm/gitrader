// SPDX-License-Identifier: CPAL-1.0
// describe() 能力声明：只读、只 spot（美股）、orderTypes 全 none、原始请求计次、IEX 缺省源。
import { describe, expect, it } from 'vitest'
import { ORDER_TYPES, validateVenueCapabilities } from '@gitrader/protocol'
import { AlpacaDataConnector } from '../src/connector'
import { DATA_HOST, FX_NOW, FakeAlpaca, TRADING_HOST } from './helpers/fake-alpaca'

export function make(o: Record<string, unknown> = {}): { fake: FakeAlpaca; connector: AlpacaDataConnector } {
  const fake = new FakeAlpaca()
  const connector = new AlpacaDataConnector({
    tradingBaseUrl: `http://${TRADING_HOST}`,
    dataBaseUrl: `http://${DATA_HOST}`,
    fetchImpl: fake.fetch,
    clock: () => FX_NOW,
    ...o,
  })
  return { fake, connector }
}

describe('describe()', () => {
  it('passes the protocol schema and declares a read-only US-equity data source', () => {
    const { connector } = make()
    const caps = connector.describe()
    const validated = validateVenueCapabilities(caps)
    expect(validated.ok, JSON.stringify(validated)).toBe(true)

    expect(caps.venue).toBe('alpaca')
    expect(caps.environments).toEqual(['mainnet'])
    expect(caps.instrumentKinds).toEqual(['spot'])
    for (const type of ORDER_TYPES) expect(caps.orderTypes[type]).toBe('none')
    expect(caps.tif).toEqual([])
    expect(caps.triggerPriceTypes).toEqual([])
  })

  it('publishes request-count rate limits and the bars page limits', () => {
    const { connector } = make()
    const caps = connector.describe()
    expect(caps.rateLimits).toEqual([{
      scope: 'account', model: 'count', limit: 200, windowMs: 60_000,
      note: 'Alpaca Basic 计划每个端点族 200 次/分钟；以官方 Rate Limits 页为准',
    }])
    expect(caps.history).toEqual({ maxCandles: 10_000, pageLimit: 10_000 })
  })

  it('marks itself as data-only and publishes the feed, environment and depth shape', () => {
    const { connector } = make()
    const caps = connector.describe()
    expect(caps['x-data-only']).toBe(true)
    expect(caps['x-feed']).toBe('iex')
    expect(caps['x-environment']).toBe('paper')
    expect(caps['x-book']).toBe('top-of-book')

    const sip = make({ feed: 'sip', environment: 'live', keyId: 'AKFAKEKEY', secretKey: 'fakesecret' }).connector
    expect(sip.describe()['x-feed']).toBe('sip')
    expect(sip.describe()['x-environment']).toBe('live')
  })

  it('reports venue / mainnet / rest in status() and starts un-stale before any request', () => {
    const { connector } = make()
    expect(connector.venue).toBe('alpaca')
    expect(connector.environment).toBe('mainnet')
    expect(connector.status()).toMatchObject({
      venue: 'alpaca', environment: 'mainnet', source: 'rest', wsState: 'disconnected', stale: true, lastMessageTs: 0,
    })
  })

  it('rejects an unknown market-data feed instead of silently falling back to iex', () => {
    expect(() => make({ feed: 'nasdaq' })).toThrow(/unsupported alpaca market-data feed/)
    expect(() => make({ environment: 'prod' })).toThrow(/unsupported alpaca environment/)
  })
})
