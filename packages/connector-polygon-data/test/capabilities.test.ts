// SPDX-License-Identifier: CPAL-1.0
// describe() 能力声明：只读、只 spot（美股）、orderTypes 全 none、5 次/分钟、一档盘口（NBBO）、14 个周期全支持。
import { describe, expect, it } from 'vitest'
import { ORDER_TYPES, validateVenueCapabilities } from '@gitrader/protocol'
import { PolygonDataConnector } from '../src/connector'
import { API_KEY, FX_NOW, FakePolygon, HOST } from './helpers/fake-polygon'

export function make(o: Record<string, unknown> = {}): { fake: FakePolygon; connector: PolygonDataConnector } {
  const fake = new FakePolygon()
  const connector = new PolygonDataConnector({
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

    expect(caps.venue).toBe('polygon')
    expect(caps.environments).toEqual(['mainnet'])
    expect(caps.instrumentKinds).toEqual(['spot'])
    for (const type of ORDER_TYPES) expect(caps.orderTypes[type]).toBe('none')
    expect(caps.tif).toEqual([])
    expect(caps.triggerPriceTypes).toEqual([])
  })

  it('publishes the free-tier per-minute cap and the 50000 aggregate page', () => {
    const { connector } = make()
    const caps = connector.describe()
    expect(caps.rateLimits).toEqual([{
      scope: 'account', model: 'count', limit: 5, windowMs: 60_000,
      note: 'Polygon 免费档 5 次/分钟；付费套餐更高，以官方 Pricing 页为准',
    }])
    expect(caps.history).toEqual({ maxCandles: 50_000, pageLimit: 50_000 })
  })

  it('marks itself data-only with a top-of-book NBBO quote and all 14 protocol intervals', () => {
    const { connector } = make()
    const caps = connector.describe()
    expect(caps['x-data-only']).toBe(true)
    expect(caps['x-book']).toBe('top-of-book')
    expect(caps['x-quote']).toBe('nbbo')
    expect(caps['x-intervals']).toEqual([
      '1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '8h', '12h', '1d', '3d', '1w', '1M',
    ])
    expect(caps['x-base-url']).toBe('https://api.massive.com')
  })

  it('reports venue / mainnet / rest in status() and starts un-stale before any request', () => {
    const { connector } = make()
    expect(connector.venue).toBe('polygon')
    expect(connector.environment).toBe('mainnet')
    expect(connector.status()).toMatchObject({
      venue: 'polygon', environment: 'mainnet', source: 'rest', wsState: 'disconnected', stale: true, lastMessageTs: 0,
    })
  })

  it('refuses to build without an API key and reads POLYGON_API_KEY from the environment', () => {
    expect(() => make({ apiKey: undefined, env: {} })).toThrow(/needs an API key in POLYGON_API_KEY/)
    expect(make({ apiKey: undefined, env: { POLYGON_API_KEY: 'FROM_ENV' } }).connector.market.http.authenticated).toBe(true)
  })
})
