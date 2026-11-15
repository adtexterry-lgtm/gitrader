// SPDX-License-Identifier: CPAL-1.0
// describe() 能力声明 + exchangeInfo 目录：只读、只 perp、orderTypes 全 none、过滤器解析。
import { describe, expect, it } from 'vitest'
import { ORDER_TYPES, validateVenueCapabilities } from '@gitrader/protocol'
import { BinanceDataConnector } from '../src/connector'
import { FakeBinance, FX_NOW, symbolEntry } from './helpers/fake-binance'

function make() {
  const fake = new FakeBinance()
  const connector = new BinanceDataConnector({ fetchImpl: fake.fetch, clock: () => FX_NOW })
  return { fake, connector }
}

describe('describe()', () => {
  it('passes the protocol schema and declares a read-only perp data source', () => {
    const { connector } = make()
    const caps = connector.describe()

    const validated = validateVenueCapabilities(caps)
    expect(validated.ok, JSON.stringify(validated)).toBe(true)

    expect(caps.venue).toBe('binance')
    expect(caps.environments).toEqual(['mainnet'])
    expect(caps.instrumentKinds).toEqual(['perp'])
    for (const type of ORDER_TYPES) expect(caps.orderTypes[type]).toBe('none')
    expect(caps.tif).toEqual([])
    expect(caps.triggerPriceTypes).toEqual([])
    expect(caps.rateLimits).toEqual([{ scope: 'ip', model: 'weight', limit: 2400, windowMs: 60_000 }])
    expect(caps.history).toEqual({ maxCandles: 1500, pageLimit: 1500 })
    expect(caps['x-data-only']).toBe(true)
  })

  it('the connector reports the venue and mainnet environment', () => {
    const { connector } = make()
    expect(connector.venue).toBe('binance')
    expect(connector.environment).toBe('mainnet')
    expect(connector.status()).toMatchObject({ venue: 'binance', environment: 'mainnet', source: 'rest', wsState: 'disconnected' })
  })
})

describe('exchangeInfo catalogue', () => {
  it('start() pulls exchangeInfo once and maps symbol to binance:<symbol>', async () => {
    const { fake, connector } = make()
    expect(connector.listInstruments()).toEqual([])
    expect(connector.getInstrument('binance:BTCUSDT')).toBeUndefined()

    await connector.start()
    await connector.start()
    expect(fake.callsTo('/fapi/v1/exchangeInfo')).toHaveLength(1)

    const ids = connector.listInstruments().map((i) => i.instrumentId)
    expect(ids).toEqual(['binance:BTCUSDT', 'binance:ETHUSDT']) // 交割合约与 CLOSE 状态被剔除
    expect(connector.listInstruments({ includeDelisted: true }).map((i) => i.instrumentId)).toContain('binance:OLDUSDT')
    expect(connector.getInstrument('binance:ETHUSDT')?.base).toBe('ETH')
  })

  it('parses tick / step / minNotional from filters into protocol fields', async () => {
    const { connector } = make()
    await connector.start()
    const btc = connector.getInstrument('binance:BTCUSDT')!
    expect(btc).toMatchObject({
      venue: 'binance', symbol: 'BTCUSDT', displaySymbol: 'BTC-PERP', kind: 'perp', base: 'BTC', quote: 'USDT', settle: 'USDT',
      settlement: 'linear', contractSize: '1', venueSizeUnit: 'base', assetClass: 'crypto', status: 'trading',
      price: { tick: '0.1', maxDecimals: 2 }, size: { step: '0.001', decimals: 3, min: '0.001' }, minNotional: '5',
      fundingIntervalMs: 28_800_000, orderTypes: [], tif: [], triggerPriceTypes: [],
    })
  })

  it('falls back to protocol-permitted defaults when filters are missing or unusable', async () => {
    const fake = new FakeBinance()
    fake.symbols = [symbolEntry({ symbol: 'NODATAUSDT', pricePrecision: undefined, filters: [{ filterType: 'PRICE_FILTER', tickSize: '0' }] })]
    const connector = new BinanceDataConnector({ fetchImpl: fake.fetch, clock: () => FX_NOW })
    await connector.start()
    const inst = connector.getInstrument('binance:NODATAUSDT')!
    expect(inst.price).toEqual({ sigFigs: 5, maxDecimals: 8 })
    expect(inst.size).toEqual({ step: '1', decimals: 0, min: '1' })
    expect(inst.minNotional).toBeUndefined()
  })
})
