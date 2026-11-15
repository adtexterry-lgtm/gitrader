// SPDX-License-Identifier: CPAL-1.0
// describe() 能力声明 + sessions：只读、只 spot、orderTypes 全 none、限流按官方免费档（8 / 分钟、800 / 天）。
import { describe, expect, it } from 'vitest'
import { ORDER_TYPES, validateVenueCapabilities } from '@gitrader/protocol'
import { TwelveDataDataConnector } from '../src/connector'
import { FakeTwelveData, FX_NOW, TEST_KEY } from './helpers/fake-twelvedata'

function make(o: Record<string, unknown> = {}) {
  const fake = new FakeTwelveData()
  const connector = new TwelveDataDataConnector({
    baseUrl: 'https://twelvedata.example.test', fetchImpl: fake.fetch, clock: () => FX_NOW,
    env: { TWELVEDATA_API_KEY: TEST_KEY }, ...o,
  })
  return { fake, connector }
}

describe('describe()', () => {
  it('passes the protocol schema and declares a read-only spot data source', () => {
    const { connector } = make()
    const caps = connector.describe()

    const validated = validateVenueCapabilities(caps)
    expect(validated.ok, JSON.stringify(validated)).toBe(true)

    expect(caps.venue).toBe('twelvedata')
    expect(caps.environments).toEqual(['mainnet'])
    expect(caps.instrumentKinds).toEqual(['spot'])
    for (const type of ORDER_TYPES) expect(caps.orderTypes[type]).toBe('none')
    expect(caps.tif).toEqual([])
    expect(caps.triggerPriceTypes).toEqual([])
    expect(caps.history).toEqual({ maxCandles: 5000, pageLimit: 5000 })
  })

  it('declares both free-plan credit limits (per minute and per day) with their windows', () => {
    const { connector } = make()
    const limits = connector.describe().rateLimits!
    expect(limits).toHaveLength(2)
    expect(limits[0]).toMatchObject({ scope: 'ip', model: 'count', limit: 8, windowMs: 60_000 })
    expect(limits[1]).toMatchObject({ scope: 'ip', model: 'count', limit: 800, windowMs: 86_400_000 })
  })

  it('marks itself data-only, and states there is no book and quotes are last-price based', () => {
    const { fake, connector } = make()
    const caps = connector.describe()
    expect(caps['x-data-only']).toBe(true)
    expect(caps['x-quote-basis']).toBe('last-price')
    expect(caps['x-book']).toBe('none')
    expect(connector.status()).toMatchObject({
      venue: 'twelvedata', environment: 'mainnet', source: 'rest', wsState: 'disconnected', stale: true, lastMessageTs: 0,
    })
    expect(fake.calls).toHaveLength(0)
  })
})
