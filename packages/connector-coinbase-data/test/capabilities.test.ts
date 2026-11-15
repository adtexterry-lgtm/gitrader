// SPDX-License-Identifier: CPAL-1.0
// describe() 能力声明 + 现货目录：只读、只 spot、orderTypes 全 none、step/tick/minNotional 映射、非 online 条目剔除。
import { describe, expect, it } from 'vitest'
import { ORDER_TYPES, validateVenueCapabilities } from '@gitrader/protocol'
import { CoinbaseDataConnector } from '../src/connector'
import { FakeCoinbase, FX_NOW, productEntry } from './helpers/fake-coinbase'

const PRODUCTS_PATH = '/api/v3/brokerage/market/products'

function make() {
  const fake = new FakeCoinbase()
  const connector = new CoinbaseDataConnector({
    baseUrl: 'http://coinbase.example.test', fetchImpl: fake.fetch, clock: () => FX_NOW,
  })
  return { fake, connector }
}

describe('describe()', () => {
  it('passes the protocol schema and declares a read-only spot data source', () => {
    const { connector } = make()
    const caps = connector.describe()

    const validated = validateVenueCapabilities(caps)
    expect(validated.ok, JSON.stringify(validated)).toBe(true)

    expect(caps.venue).toBe('coinbase')
    expect(caps.environments).toEqual(['mainnet'])
    expect(caps.instrumentKinds).toEqual(['spot'])
    for (const type of ORDER_TYPES) expect(caps.orderTypes[type]).toBe('none')
    expect(caps.tif).toEqual([])
    expect(caps.triggerPriceTypes).toEqual([])
    expect(caps.rateLimits).toEqual([{ scope: 'ip', model: 'count', limit: 10, windowMs: 1000 }])
    expect(caps.history).toEqual({ maxCandles: 350, pageLimit: 350 })
    expect(caps['x-data-only']).toBe(true)
  })

  it('the connector reports the venue and mainnet environment', () => {
    const { connector } = make()
    expect(connector.venue).toBe('coinbase')
    expect(connector.environment).toBe('mainnet')
    expect(connector.status()).toMatchObject({
      venue: 'coinbase', environment: 'mainnet', source: 'rest', wsState: 'disconnected',
    })
  })
})

describe('instrument catalogue', () => {
  it('start() pulls SPOT products once and maps product_id to coinbase:<product_id>', async () => {
    const { fake, connector } = make()
    expect(connector.listInstruments()).toEqual([])
    expect(connector.getInstrument('coinbase:BTC-USD')).toBeUndefined()

    await connector.start()
    await connector.start()
    const calls = fake.callsTo(PRODUCTS_PATH)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.params.get('product_type')).toBe('SPOT')

    const ids = connector.listInstruments().map((i) => i.instrumentId)
    // delisted 条目按工单要求不进目录
    expect(ids).toEqual(['coinbase:BTC-USD', 'coinbase:ETH-USD'])
    expect(connector.getInstrument('coinbase:OLD-USD')).toBeUndefined()
  })

  it('parses quote_increment / base_increment / min sizes into protocol fields', async () => {
    const { connector } = make()
    await connector.start()
    const btc = connector.getInstrument('coinbase:BTC-USD')!

    expect(btc).toMatchObject({
      venue: 'coinbase', symbol: 'BTC-USD', displaySymbol: 'BTC-USD', kind: 'spot', base: 'BTC', quote: 'USD',
      settle: 'USD', settlement: 'linear', contractSize: '1', venueSizeUnit: 'base', assetClass: 'crypto',
      status: 'trading', price: { tick: '0.01', maxDecimals: 2 },
      size: { step: '0.00000001', decimals: 8, min: '0.00000001' }, minNotional: '1',
      orderTypes: [], tif: [], triggerPriceTypes: [],
    })
    // 现货没有资金费
    expect(btc.fundingIntervalMs).toBeUndefined()
  })

  it('falls back to protocol-permitted defaults when increments are missing or unusable', async () => {
    const fake = new FakeCoinbase()
    fake.products = [
      productEntry({ product_id: 'NODATA-USD', quote_increment: '0', base_increment: '', base_min_size: undefined, quote_min_size: '' }),
    ]
    const connector = new CoinbaseDataConnector({ fetchImpl: fake.fetch, clock: () => FX_NOW })
    await connector.start()

    const instrument = connector.getInstrument('coinbase:NODATA-USD')!
    expect(instrument.price).toEqual({ sigFigs: 5, maxDecimals: 8 })
    expect(instrument.size).toEqual({ step: '1', decimals: 0, min: '1' })
    expect(instrument.minNotional).toBeUndefined()
  })

  it('keeps the native product_id casing (no normalisation)', async () => {
    const fake = new FakeCoinbase()
    fake.products = [productEntry({ product_id: 'BTC-USDC', base_currency_id: 'BTC', quote_currency_id: 'USDC' })]
    const connector = new CoinbaseDataConnector({ fetchImpl: fake.fetch, clock: () => FX_NOW })
    await connector.start()
    expect(connector.listInstruments()[0]!.instrumentId).toBe('coinbase:BTC-USDC')
    expect(connector.getInstrument('coinbase:BTC-USDC')?.quote).toBe('USDC')
  })
})
