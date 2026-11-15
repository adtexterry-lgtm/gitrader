// SPDX-License-Identifier: CPAL-1.0
// describe() 能力声明：只读、只 spot（美股）、orderTypes 全 none、按次计 25 次/天、无盘口、只支持 8 个周期。
import { describe, expect, it } from 'vitest'
import { ORDER_TYPES, validateVenueCapabilities } from '@gitrader/protocol'
import { AlphaVantageDataConnector } from '../src/connector'
import { API_KEY, FX_NOW, FakeAlphaVantage, HOST } from './helpers/fake-alphavantage'

export function make(o: Record<string, unknown> = {}): { fake: FakeAlphaVantage; connector: AlphaVantageDataConnector } {
  const fake = new FakeAlphaVantage()
  const connector = new AlphaVantageDataConnector({
    apiKey: API_KEY,
    baseUrl: `http://${HOST}`,
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

    expect(caps.venue).toBe('alphavantage')
    expect(caps.environments).toEqual(['mainnet'])
    expect(caps.instrumentKinds).toEqual(['spot'])
    for (const type of ORDER_TYPES) expect(caps.orderTypes[type]).toBe('none')
    expect(caps.tif).toEqual([])
    expect(caps.triggerPriceTypes).toEqual([])
  })

  it('publishes the free-tier daily cap and the compact page size', () => {
    const { connector } = make()
    const caps = connector.describe()
    expect(caps.rateLimits).toEqual([{
      scope: 'ip', model: 'count', limit: 25, windowMs: 86_400_000,
      note: 'Alpha Vantage 免费档 25 次/天（官方 Support 页）；付费档更高，以官方页面为准',
    }])
    expect(caps.history).toEqual({ maxCandles: 20_000, pageLimit: 100 })
  })

  it('marks itself data-only, without an order book, and lists the supported intervals', () => {
    const { connector } = make()
    const caps = connector.describe()
    expect(caps['x-data-only']).toBe(true)
    expect(caps['x-book']).toBe('none')
    expect(caps['x-quote']).toBe('last-only')
    expect(caps['x-intervals']).toEqual(['1m', '5m', '15m', '30m', '1h', '1d', '1w', '1M'])
    expect(caps['x-base-url']).toBe('https://www.alphavantage.co')
  })

  it('reports venue / mainnet / rest in status() and starts un-stale before any request', () => {
    const { connector } = make()
    expect(connector.venue).toBe('alphavantage')
    expect(connector.environment).toBe('mainnet')
    expect(connector.status()).toMatchObject({
      venue: 'alphavantage', environment: 'mainnet', source: 'rest', wsState: 'disconnected', stale: true, lastMessageTs: 0,
    })
  })

  it('refuses to build without an API key (never falls back to an unauthenticated request)', () => {
    expect(() => make({ apiKey: undefined, env: {} })).toThrow(/needs an API key in ALPHAVANTAGE_API_KEY/)
  })

  it('reads the key from the documented environment variable names', () => {
    expect(make({ apiKey: undefined, env: { ALPHA_VANTAGE_API_KEY: 'FROM_FALLBACK' } }).connector.market.http.authenticated).toBe(true)
    expect(make({ apiKey: undefined, env: { ALPHAVANTAGE_API_KEY: 'FROM_PRIMARY' } }).connector.market.http.authenticated).toBe(true)
  })
})
