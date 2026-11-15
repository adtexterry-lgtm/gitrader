// SPDX-License-Identifier: CPAL-1.0
// describe() 能力声明 + 合约目录：只读、只收 USDC 结算的线性永续 / 交割、orderTypes 全 none、BTC / ETH / USDC 三次清单合并。
import { describe, expect, it } from 'vitest'
import { ORDER_TYPES, validateVenueCapabilities } from '@gitrader/protocol'
import { DeribitDataConnector } from '../src/connector'
import { FakeDeribit, FX_NOW, instrumentEntry } from './helpers/fake-deribit'

function make() {
  const fake = new FakeDeribit()
  const connector = new DeribitDataConnector({ baseUrl: 'http://deribit.example.test', fetchImpl: fake.fetch, clock: () => FX_NOW })
  return { fake, connector }
}

describe('describe()', () => {
  it('passes the protocol schema and declares a read-only perp + future data source', () => {
    const { connector } = make()
    const caps = connector.describe()

    const validated = validateVenueCapabilities(caps)
    expect(validated.ok, JSON.stringify(validated)).toBe(true)

    expect(caps.venue).toBe('deribit')
    expect(caps.environments).toEqual(['mainnet'])
    expect(caps.instrumentKinds).toEqual(['perp', 'future'])
    for (const type of ORDER_TYPES) expect(caps.orderTypes[type]).toBe('none')
    expect(caps.tif).toEqual([])
    expect(caps.triggerPriceTypes).toEqual([])
    expect(caps.rateLimits).toEqual([{ scope: 'ip', model: 'count', limit: 20, windowMs: 1_000 }])
    expect(caps.history).toEqual({ maxCandles: 1000, pageLimit: 1000 })
    expect(caps['x-data-only']).toBe(true)
  })

  it('the connector reports the venue and mainnet environment', () => {
    const { connector } = make()
    expect(connector.venue).toBe('deribit')
    expect(connector.environment).toBe('mainnet')
    expect(connector.status()).toMatchObject({ venue: 'deribit', environment: 'mainnet', source: 'rest', wsState: 'disconnected' })
  })
})

describe('get_instruments catalogue', () => {
  it('start() merges the BTC / ETH / USDC lists exactly once and keeps native instrument names', async () => {
    const { fake, connector } = make()
    expect(connector.listInstruments()).toEqual([])
    expect(connector.getInstrument('deribit:BTC_USDC-PERPETUAL')).toBeUndefined()

    await connector.start()
    await connector.start()

    const calls = fake.callsTo('/api/v2/public/get_instruments')
    expect(calls).toHaveLength(3)
    expect(calls.map((c) => c.params.get('currency'))).toEqual(['BTC', 'ETH', 'USDC'])
    expect(calls.map((c) => c.params.get('kind'))).toEqual(['future', 'future', 'future'])

    expect(connector.listInstruments().map((i) => i.instrumentId)).toEqual([
      'deribit:BTC_USDC-30OCT26', 'deribit:BTC_USDC-PERPETUAL', 'deribit:ETH_USDC-PERPETUAL',
    ])
  })

  it('leaves coin-margined and non-future entries out of the catalogue', async () => {
    const { connector } = make()
    await connector.start()

    // settlement_currency 是标的币（BTC / ETH 本位）→ 一律排除，即使 is_active 为 true
    expect(connector.getInstrument('deribit:BTC-PERPETUAL')).toBeUndefined()
    expect(connector.getInstrument('deribit:BTC-30OCT26')).toBeUndefined()
    expect(connector.getInstrument('deribit:ETH-PERPETUAL')).toBeUndefined()
    // 期权与未激活条目照旧剔除
    expect(connector.getInstrument('deribit:BTC-30OCT26-80000-C')).toBeUndefined()
    expect(connector.getInstrument('deribit:BTC-24OCT26')).toBeUndefined()

    const listed = connector.listInstruments()
    expect(listed.every((i) => i.settlement === 'linear' && i.settle === 'USDC')).toBe(true)
    expect(listed).toHaveLength(3)
  })

  it('maps a USDC perpetual onto kind perp with linear settlement and base-denominated sizes', async () => {
    const { connector } = make()
    await connector.start()
    const perp = connector.getInstrument('deribit:BTC_USDC-PERPETUAL')!

    expect(perp).toMatchObject({
      instrumentId: 'deribit:BTC_USDC-PERPETUAL', venue: 'deribit', symbol: 'BTC_USDC-PERPETUAL', displaySymbol: 'BTC-PERP',
      kind: 'perp', base: 'BTC', quote: 'USDC', settle: 'USDC', settlement: 'linear', contractSize: '0.001',
      venueSizeUnit: 'base', assetClass: 'crypto', status: 'trading',
      price: { tick: '0.5', maxDecimals: 1 }, size: { step: '0.001', decimals: 3, min: '0.001' },
      fundingIntervalMs: 28_800_000, orderTypes: [], tif: [], triggerPriceTypes: [],
    })
  })

  it('maps dated futures onto kind future without a funding interval', async () => {
    const { connector } = make()
    await connector.start()
    const future = connector.getInstrument('deribit:BTC_USDC-30OCT26')!

    expect(future).toMatchObject({
      symbol: 'BTC_USDC-30OCT26', displaySymbol: 'BTC_USDC-30OCT26', kind: 'future', base: 'BTC', quote: 'USDC',
      settle: 'USDC', settlement: 'linear', contractSize: '0.001', venueSizeUnit: 'base',
      price: { tick: '2.5', maxDecimals: 1 }, size: { step: '0.001', decimals: 3, min: '0.001' },
    })
    expect(future.fundingIntervalMs).toBeUndefined()
  })

  it('reads ETH tick / lot sizes and contract size from the venue instead of assuming BTC ones', async () => {
    const { connector } = make()
    await connector.start()
    const eth = connector.getInstrument('deribit:ETH_USDC-PERPETUAL')!
    expect(eth).toMatchObject({
      base: 'ETH', quote: 'USDC', settle: 'USDC', contractSize: '0.01', venueSizeUnit: 'base',
      price: { tick: '0.05', maxDecimals: 2 }, size: { step: '0.01', decimals: 2, min: '0.01' },
    })
  })

  it('falls back to protocol-permitted defaults when tick / lot / contract size are missing', async () => {
    const fake = new FakeDeribit()
    fake.instruments = {
      USDC: [
        instrumentEntry({
          instrument_name: 'BTC_USDC-PERPETUAL', tick_size: 0, lot_size: null, min_trade_amount: undefined, contract_size: null,
          quote_currency: 'USDC', settlement_currency: 'USDC', instrument_type: 'linear',
        }),
      ],
    }
    const connector = new DeribitDataConnector({ baseUrl: 'http://deribit.example.test', fetchImpl: fake.fetch, clock: () => FX_NOW })
    await connector.start()
    const inst = connector.getInstrument('deribit:BTC_USDC-PERPETUAL')!
    expect(inst.price).toEqual({ sigFigs: 5, maxDecimals: 8 })
    expect(inst.size).toEqual({ step: '1', decimals: 0, min: '1' })
    expect(inst.contractSize).toBe('1')
    expect(inst.venueSizeUnit).toBe('base')
  })
})
