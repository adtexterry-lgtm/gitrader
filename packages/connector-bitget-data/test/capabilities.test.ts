// SPDX-License-Identifier: CPAL-1.0
// describe() 能力声明 + 合约目录：只读、只 perp、orderTypes 全 none、pricePlace / volumePlace 映射。
import { describe, expect, it } from 'vitest'
import { ORDER_TYPES, validateVenueCapabilities } from '@gitrader/protocol'
import { BitgetDataConnector } from '../src/connector'
import { FakeBitget, FX_NOW, contractEntry } from './helpers/fake-bitget'

function make() {
  const fake = new FakeBitget()
  const connector = new BitgetDataConnector({ fetchImpl: fake.fetch, clock: () => FX_NOW })
  return { fake, connector }
}

describe('describe()', () => {
  it('passes the protocol schema and declares a read-only perp data source', () => {
    const { connector } = make()
    const caps = connector.describe()

    const validated = validateVenueCapabilities(caps)
    expect(validated.ok, JSON.stringify(validated)).toBe(true)

    expect(caps.venue).toBe('bitget')
    expect(caps.environments).toEqual(['mainnet'])
    expect(caps.instrumentKinds).toEqual(['perp'])
    for (const type of ORDER_TYPES) expect(caps.orderTypes[type]).toBe('none')
    expect(caps.tif).toEqual([])
    expect(caps.triggerPriceTypes).toEqual([])
    expect(caps.rateLimits).toEqual([{ scope: 'ip', model: 'count', limit: 20, windowMs: 1000 }])
    expect(caps.history).toEqual({ maxCandles: 200, pageLimit: 200 })
    expect(caps['x-data-only']).toBe(true)
  })

  it('the connector reports the venue and mainnet environment', () => {
    const { connector } = make()
    expect(connector.venue).toBe('bitget')
    expect(connector.environment).toBe('mainnet')
    expect(connector.status()).toMatchObject({ venue: 'bitget', environment: 'mainnet', source: 'rest', wsState: 'disconnected' })
  })
})

describe('contract catalogue', () => {
  it('start() pulls contracts once with productType=USDT-FUTURES and maps symbol to bitget:<symbol>', async () => {
    const { fake, connector } = make()
    expect(connector.listInstruments()).toEqual([])
    expect(connector.getInstrument('bitget:BTCUSDT')).toBeUndefined()

    await connector.start()
    await connector.start()
    const calls = fake.callsTo('/api/v2/mix/market/contracts')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.params.get('productType')).toBe('USDT-FUTURES')

    const ids = connector.listInstruments().map((i) => i.instrumentId)
    expect(ids).toEqual(['bitget:BTCUSDT', 'bitget:ETHUSDT', 'bitget:XRPUSDT']) // offline 条目被剔除
    expect(connector.getInstrument('bitget:ETHUSDT')?.base).toBe('ETH')
  })

  it('derives tick / step / minNotional from pricePlace, priceEndStep, volumePlace and minTradeUSDT', async () => {
    const { connector } = make()
    await connector.start()
    const btc = connector.getInstrument('bitget:BTCUSDT')!
    expect(btc).toMatchObject({
      venue: 'bitget', symbol: 'BTCUSDT', displaySymbol: 'BTC-PERP', kind: 'perp', base: 'BTC', quote: 'USDT', settle: 'USDT',
      settlement: 'linear', contractSize: '1', venueSizeUnit: 'base', assetClass: 'crypto', status: 'trading',
      price: { tick: '0.1', maxDecimals: 1 }, size: { step: '0.0001', decimals: 4, min: '0.0001' },
      minNotional: '5', maxLeverage: 150, fundingIntervalMs: 28_800_000,
      orderTypes: [], tif: [], triggerPriceTypes: [],
    })
    expect(connector.getInstrument('bitget:ETHUSDT')).toMatchObject({
      price: { tick: '0.01', maxDecimals: 2 }, size: { step: '0.01', decimals: 2, min: '0.01' },
    })
    expect(connector.getInstrument('bitget:XRPUSDT')).toMatchObject({
      price: { tick: '0.0001', maxDecimals: 4 }, size: { step: '1', decimals: 0, min: '1' }, maxLeverage: 125,
    })
  })

  it('falls back to protocol-permitted defaults when the place fields are missing or unusable', async () => {
    const fake = new FakeBitget()
    fake.contracts = [contractEntry({
      symbol: 'NODATAUSDT', baseCoin: 'NODATA', pricePlace: undefined, priceEndStep: '0',
      volumePlace: undefined, minTradeNum: undefined, minTradeUSDT: undefined, maxLever: '',
    })]
    const connector = new BitgetDataConnector({ fetchImpl: fake.fetch, clock: () => FX_NOW })
    await connector.start()
    const inst = connector.getInstrument('bitget:NODATAUSDT')!
    expect(inst.price).toEqual({ sigFigs: 5, maxDecimals: 8 })
    expect(inst.size).toEqual({ step: '1', decimals: 0, min: '1' })
    expect(inst.minNotional).toBeUndefined()
    expect(inst.maxLeverage).toBeUndefined()
    expect(inst.fundingIntervalMs).toBe(28_800_000)
  })

  it('honours a venue funding interval other than 8h', async () => {
    const fake = new FakeBitget()
    fake.contracts = [contractEntry({ symbol: 'ALTUSDT', baseCoin: 'ALT', fundInterval: '4' })]
    const connector = new BitgetDataConnector({ fetchImpl: fake.fetch, clock: () => FX_NOW })
    await connector.start()
    expect(connector.getInstrument('bitget:ALTUSDT')?.fundingIntervalMs).toBe(14_400_000)
  })
})
