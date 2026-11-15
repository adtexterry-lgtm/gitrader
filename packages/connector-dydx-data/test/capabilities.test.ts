// SPDX-License-Identifier: CPAL-1.0
// describe() 能力声明 + 永续目录：只读、只 perp、orderTypes 全 none、tickSize/stepSize 映射、ACTIVE 过滤。
import { describe, expect, it } from 'vitest'
import { ORDER_TYPES, validateVenueCapabilities } from '@gitrader/protocol'
import { DydxDataConnector } from '../src/connector'
import { FakeDydx, FX_NOW, MARKETS_FIXTURE } from './helpers/fake-dydx'

const BASE = 'http://dydx.example.test'

function make() {
  const fake = new FakeDydx()
  const connector = new DydxDataConnector({ baseUrl: BASE, fetchImpl: fake.fetch, clock: () => FX_NOW })
  return { fake, connector }
}

describe('describe()', () => {
  it('passes the protocol schema and declares a read-only perp data source', () => {
    const { connector } = make()
    const caps = connector.describe()

    const validated = validateVenueCapabilities(caps)
    expect(validated.ok, JSON.stringify(validated)).toBe(true)

    expect(caps.venue).toBe('dydx')
    expect(caps.environments).toEqual(['mainnet'])
    expect(caps.instrumentKinds).toEqual(['perp'])
    for (const type of ORDER_TYPES) expect(caps.orderTypes[type]).toBe('none')
    expect(caps.tif).toEqual([])
    expect(caps.triggerPriceTypes).toEqual([])
    expect(caps.rateLimits).toEqual([{ scope: 'ip', model: 'count', limit: 100, windowMs: 10_000 }])
    expect(caps.history).toEqual({ maxCandles: 1000, pageLimit: 1000 })
    expect(caps['x-data-only']).toBe(true)
  })

  it('the connector reports the venue and mainnet environment', () => {
    const { connector } = make()
    expect(connector.venue).toBe('dydx')
    expect(connector.environment).toBe('mainnet')
    expect(connector.status()).toMatchObject({ venue: 'dydx', environment: 'mainnet', source: 'rest', wsState: 'disconnected' })
  })
})

describe('instrument catalogue', () => {
  it('start() pulls /v4/perpetualMarkets once and maps the ticker key to dydx:<ticker>', async () => {
    const { fake, connector } = make()
    expect(connector.listInstruments()).toEqual([])
    expect(connector.getInstrument('dydx:BTC-USD')).toBeUndefined()

    await connector.start()
    await connector.start()
    const calls = fake.callsTo('/v4/perpetualMarkets')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url.startsWith(`${BASE}/v4/perpetualMarkets`)).toBe(true)

    // FINAL_SETTLEMENT 的 OLD-USD 只在 includeDelisted 里出现
    expect(connector.listInstruments().map((i) => i.instrumentId)).toEqual([
      'dydx:BTC-USD', 'dydx:ETH-USD', 'dydx:SOL-USD',
    ])
    expect(connector.listInstruments({ includeDelisted: true }).map((i) => i.instrumentId)).toContain('dydx:OLD-USD')
    expect(connector.getInstrument('dydx:OLD-USD')?.status).toBe('delisted')
    expect(connector.getInstrument('dydx:ETH-USD')?.base).toBe('ETH')
  })

  it('parses tickSize / stepSize into protocol fields and settles in USDC', async () => {
    const { connector } = make()
    await connector.start()
    const btc = connector.getInstrument('dydx:BTC-USD')!
    expect(btc).toMatchObject({
      venue: 'dydx', symbol: 'BTC-USD', displaySymbol: 'BTC-PERP', kind: 'perp', base: 'BTC', quote: 'USD',
      settle: 'USDC', settlement: 'linear', contractSize: '1', venueSizeUnit: 'base', assetClass: 'crypto',
      status: 'trading', price: { tick: '1', maxDecimals: 0 }, size: { step: '0.0001', decimals: 4, min: '0.0001' },
      fundingIntervalMs: 3_600_000, orderTypes: [], tif: [], triggerPriceTypes: [],
    })
    expect(connector.getInstrument('dydx:ETH-USD')?.price).toEqual({ tick: '0.1', maxDecimals: 1 })
    expect(connector.getInstrument('dydx:SOL-USD')?.size).toEqual({ step: '0.1', decimals: 1, min: '0.1' })
  })

  it('falls back to protocol-permitted defaults when tickSize / stepSize are missing or useless', async () => {
    const fake = new FakeDydx()
    fake.markets = {
      markets: {
        'NODATA-USD': { ticker: 'NODATA-USD', status: 'ACTIVE', tickSize: '0', stepSize: '' },
        'THIN-USD': { ticker: 'THIN-USD', status: 'ACTIVE' },
        'BROKEN-USD': null,
      },
    }
    const connector = new DydxDataConnector({ baseUrl: BASE, fetchImpl: fake.fetch, clock: () => FX_NOW })
    await connector.start()

    const nodata = connector.getInstrument('dydx:NODATA-USD')!
    expect(nodata.price).toEqual({ sigFigs: 5, maxDecimals: 8 })
    expect(nodata.size).toEqual({ step: '1', decimals: 0, min: '1' })
    expect(nodata.minNotional).toBeUndefined()
    expect(connector.getInstrument('dydx:THIN-USD')?.size.step).toBe('1')
    // 条目为 null 的市场直接丢弃
    expect(connector.listInstruments({ includeDelisted: true }).map((i) => i.instrumentId)).toEqual([
      'dydx:NODATA-USD', 'dydx:THIN-USD',
    ])
  })

  it('keeps the venue ticker casing untouched in the instrument id', async () => {
    const fake = new FakeDydx()
    fake.markets = { markets: { 'eth-USD': { ticker: 'eth-USD', status: 'ACTIVE', tickSize: '0.1', stepSize: '0.001' } } }
    const connector = new DydxDataConnector({ baseUrl: BASE, fetchImpl: fake.fetch, clock: () => FX_NOW })
    await connector.start()
    expect(connector.listInstruments().map((i) => i.instrumentId)).toEqual(['dydx:eth-USD'])
  })

  it('exposes the raw fixture keys the catalogue is built from', () => {
    expect(Object.keys(MARKETS_FIXTURE.markets)).toEqual(['BTC-USD', 'ETH-USD', 'SOL-USD', 'OLD-USD'])
  })
})
