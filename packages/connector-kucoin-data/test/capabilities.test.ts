// SPDX-License-Identifier: CPAL-1.0
// describe() 能力声明 + 合约目录：只读、只看 USDT 永续（status Open 且非反向）、tickSize/lotSize/multiplier 映射。
import { describe, expect, it } from 'vitest'
import { ORDER_TYPES, validateVenueCapabilities } from '@gitrader/protocol'
import type { InstrumentId } from '@gitrader/protocol'
import { KucoinDataConnector } from '../src/connector'
import { FakeKucoin, FX_NOW, contract } from './helpers/fake-kucoin'

function make() {
  const fake = new FakeKucoin()
  const connector = new KucoinDataConnector({ baseUrl: 'http://kucoin.example.test', fetchImpl: fake.fetch, clock: () => FX_NOW })
  return { fake, connector }
}

describe('describe()', () => {
  it('passes the protocol schema and declares a read-only perp data source', () => {
    const { connector } = make()
    const caps = connector.describe()

    const validated = validateVenueCapabilities(caps)
    expect(validated.ok, JSON.stringify(validated)).toBe(true)

    expect(caps.venue).toBe('kucoin')
    expect(caps.environments).toEqual(['mainnet'])
    expect(caps.instrumentKinds).toEqual(['perp'])
    for (const type of ORDER_TYPES) expect(caps.orderTypes[type]).toBe('none')
    expect(caps.tif).toEqual([])
    expect(caps.triggerPriceTypes).toEqual([])
    expect(caps.rateLimits).toEqual([{ scope: 'ip', model: 'count', limit: 30, windowMs: 3000 }])
    expect(caps.history).toEqual({ maxCandles: 200, pageLimit: 200 })
    expect(caps['x-data-only']).toBe(true)
  })

  it('the connector reports the venue and mainnet environment', () => {
    const { connector } = make()
    expect(connector.venue).toBe('kucoin')
    expect(connector.environment).toBe('mainnet')
    expect(connector.status()).toMatchObject({ venue: 'kucoin', environment: 'mainnet', source: 'rest', wsState: 'disconnected' })
  })
})

describe('instrument catalogue', () => {
  it('start() pulls contracts once and keeps only Open non-inverse USDT perpetuals', async () => {
    const { fake, connector } = make()
    expect(connector.listInstruments()).toEqual([])
    expect(connector.getInstrument('kucoin:XBTUSDTM')).toBeUndefined()

    await connector.start()
    await connector.start()
    expect(fake.callsTo('/api/v1/contracts/active')).toHaveLength(1)

    const ids = connector.listInstruments().map((i) => i.instrumentId)
    // 反向合约 ETHUSDM、CancelOnly 的 OLDUSDTM 都不进目录
    expect(ids).toEqual(['kucoin:ETHUSDTM', 'kucoin:SOLUSDTM', 'kucoin:XBTUSDTM'])
    expect(connector.listInstruments({ includeDelisted: true }).map((i) => i.instrumentId)).toEqual(ids)
    expect(connector.getInstrument('kucoin:ETHUSDM')).toBeUndefined()
    expect(connector.getInstrument('kucoin:ETHUSDTM')?.base).toBe('ETH')
  })

  it('maps tickSize / lotSize / multiplier onto protocol fields', async () => {
    const { connector } = make()
    await connector.start()
    const btc = connector.getInstrument('kucoin:XBTUSDTM')!
    expect(btc).toMatchObject({
      venue: 'kucoin', symbol: 'XBTUSDTM', displaySymbol: 'XBT-PERP', kind: 'perp', base: 'XBT', quote: 'USDT',
      settle: 'USDT', settlement: 'linear', contractSize: '0.001', venueSizeUnit: 'contract', assetClass: 'crypto',
      status: 'trading', price: { tick: '0.1', maxDecimals: 1 }, size: { step: '1', decimals: 0, min: '1' },
      maxLeverage: 125, fundingIntervalMs: 28_800_000, orderTypes: [], tif: [], triggerPriceTypes: [],
    })
    // ETH 的 tick / multiplier 与 XBT 不同，逐条验一遍，防止映射写死
    expect(connector.getInstrument('kucoin:ETHUSDTM')).toMatchObject({
      price: { tick: '0.01', maxDecimals: 2 }, contractSize: '0.01', maxLeverage: 100,
    })
    const sol = connector.getInstrument('kucoin:SOLUSDTM')!
    expect(sol.price.tick).toBe('0.001')
    expect(sol.contractSize).toBe('0.1')
    expect(sol.instrumentId).toBe('kucoin:SOLUSDTM' as InstrumentId)
  })

  it('falls back to protocol-permitted defaults when tick / lot / multiplier are unusable', async () => {
    const fake = new FakeKucoin()
    fake.contracts = [contract({ symbol: 'NODATAUSDTM', baseCurrency: 'NODATA', tickSize: 0, lotSize: '', multiplier: 0 })]
    const connector = new KucoinDataConnector({ baseUrl: 'http://kucoin.example.test', fetchImpl: fake.fetch, clock: () => FX_NOW })
    await connector.start()

    const inst = connector.getInstrument('kucoin:NODATAUSDTM')!
    expect(inst.price).toEqual({ sigFigs: 5, maxDecimals: 8 })
    expect(inst.size).toEqual({ step: '1', decimals: 0, min: '1' })
    expect(inst.contractSize).toBe('1')
    expect(inst.minNotional).toBeUndefined()
  })

  it('derives base / quote from the symbol when the venue leaves the currency fields empty', async () => {
    const fake = new FakeKucoin()
    fake.contracts = [contract({ symbol: 'ABCUSDTM', baseCurrency: '', quoteCurrency: '', settleCurrency: '' })]
    const connector = new KucoinDataConnector({ baseUrl: 'http://kucoin.example.test', fetchImpl: fake.fetch, clock: () => FX_NOW })
    await connector.start()

    const inst = connector.getInstrument('kucoin:ABCUSDTM')!
    expect(inst.base).toBe('ABC')
    expect(inst.quote).toBe('USDT')
    expect(inst.settle).toBe('USDT')
    expect(inst.displaySymbol).toBe('ABC-PERP')
  })
})
