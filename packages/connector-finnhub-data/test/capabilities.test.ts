// SPDX-License-Identifier: CPAL-1.0
// describe() 能力声明 + sessions：只读、只 spot、orderTypes 全 none、限流按官方免费档 60 次 / 分钟。
import { describe, expect, it } from 'vitest'
import { ORDER_TYPES, validateVenueCapabilities } from '@gitrader/protocol'
import { FinnhubDataConnector } from '../src/connector'
import { FakeFinnhub, FX_NOW, TEST_KEY } from './helpers/fake-finnhub'

function make(o: Record<string, unknown> = {}) {
  const fake = new FakeFinnhub()
  const connector = new FinnhubDataConnector({
    baseUrl: 'https://finnhub.example.test/v1',
    fetchImpl: fake.fetch,
    clock: () => FX_NOW,
    env: { FINNHUB_API_KEY: TEST_KEY },
    ...o,
  })
  return { fake, connector }
}

describe('describe()', () => {
  it('passes the protocol schema and declares a read-only spot data source', () => {
    const { connector } = make()
    const caps = connector.describe()

    const validated = validateVenueCapabilities(caps)
    expect(validated.ok, JSON.stringify(validated)).toBe(true)

    expect(caps.venue).toBe('finnhub')
    expect(caps.environments).toEqual(['mainnet'])
    expect(caps.instrumentKinds).toEqual(['spot'])
    for (const type of ORDER_TYPES) expect(caps.orderTypes[type]).toBe('none')
    expect(caps.tif).toEqual([])
    expect(caps.triggerPriceTypes).toEqual([])
    expect(caps.rateLimits).toEqual([{ scope: 'ip', model: 'count', limit: 60, windowMs: 60_000 }])
    expect(caps.history).toEqual({ maxCandles: 5000, pageLimit: 5000 })
  })

  it('marks itself data-only and states how quotes and books are derived', () => {
    const { connector } = make()
    const caps = connector.describe()
    expect(caps['x-data-only']).toBe(true)
    // 官方 /quote 只有最新成交价：bid = ask = last，价差未知
    expect(caps['x-quote-basis']).toBe('last-price')
    expect(caps['x-book']).toBe('top-of-book')
  })

  it('the connector reports the venue and mainnet environment without touching HTTP', () => {
    const { fake, connector } = make()
    expect(connector.venue).toBe('finnhub')
    expect(connector.environment).toBe('mainnet')
    expect(connector.status()).toMatchObject({
      venue: 'finnhub', environment: 'mainnet', source: 'rest', wsState: 'disconnected', stale: true, lastMessageTs: 0,
    })
    expect(fake.calls).toHaveLength(0)
  })
})
