// SPDX-License-Identifier: CPAL-1.0
// describe() 能力声明 + 合约目录：只读、只 perp、orderTypes 全 none、tick / 币数量 / quanto_multiplier 映射。
import { describe, expect, it } from 'vitest'
import { ORDER_TYPES, validateVenueCapabilities } from '@gitrader/protocol'
import { GateioDataConnector } from '../src/connector'
import { FakeGateio, FX_NOW, REAL_CONTRACTS } from './helpers/fake-gateio'

function make() {
  const fake = new FakeGateio()
  const connector = new GateioDataConnector({ baseUrl: 'http://gateio.example.test', fetchImpl: fake.fetch, clock: () => FX_NOW })
  return { fake, connector }
}

describe('describe()', () => {
  it('passes the protocol schema and declares a read-only perp data source', () => {
    const { connector } = make()
    const caps = connector.describe()

    const validated = validateVenueCapabilities(caps)
    expect(validated.ok, JSON.stringify(validated)).toBe(true)

    expect(caps.venue).toBe('gateio')
    expect(caps.environments).toEqual(['mainnet'])
    expect(caps.instrumentKinds).toEqual(['perp'])
    for (const type of ORDER_TYPES) expect(caps.orderTypes[type]).toBe('none')
    expect(caps.tif).toEqual([])
    expect(caps.triggerPriceTypes).toEqual([])
    expect(caps.rateLimits).toEqual([{ scope: 'ip', model: 'count', limit: 200, windowMs: 10_000 }])
    expect(caps.history).toEqual({ maxCandles: 2000, pageLimit: 2000 })
    expect(caps['x-data-only']).toBe(true)
  })

  it('the connector reports the venue and mainnet environment', () => {
    const { connector } = make()
    expect(connector.venue).toBe('gateio')
    expect(connector.environment).toBe('mainnet')
    expect(connector.status()).toMatchObject({ venue: 'gateio', environment: 'mainnet', source: 'rest', wsState: 'disconnected' })
  })
})

describe('instrument catalogue', () => {
  it('start() pulls the contract list once and maps name to gateio:<name>', async () => {
    const { fake, connector } = make()
    expect(connector.listInstruments()).toEqual([])
    expect(connector.getInstrument('gateio:BTC_USDT')).toBeUndefined()

    await connector.start()
    await connector.start()
    const calls = fake.callsTo('/api/v4/futures/usdt/contracts')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.params.toString()).toBe('')

    // in_delisting === true 的条目整体丢弃
    expect(connector.listInstruments().map((i) => i.instrumentId)).toEqual([
      'gateio:BTC_USDT', 'gateio:DOGE_USDT', 'gateio:ETH_USDT',
    ])
    expect(connector.getInstrument('gateio:OLD_USDT')).toBeUndefined()
    expect(connector.getInstrument('gateio:ETH_USDT')?.base).toBe('ETH')
  })

  it('keeps the native symbol verbatim and maps tick / 币数量步长 / quanto_multiplier', async () => {
    const { connector } = make()
    await connector.start()
    const btc = connector.getInstrument('gateio:BTC_USDT')!

    expect(btc).toMatchObject({
      instrumentId: 'gateio:BTC_USDT', venue: 'gateio', symbol: 'BTC_USDT', displaySymbol: 'BTC-PERP', kind: 'perp',
      base: 'BTC', quote: 'USDT', settle: 'USDT', settlement: 'linear', contractSize: '0.0001',
      venueSizeUnit: 'base', assetClass: 'crypto', status: 'trading',
      price: { tick: '0.1', maxDecimals: 1 }, size: { step: '0.0001', decimals: 4, min: '0.0001' },
      fundingIntervalMs: 28_800_000, maxLeverage: 200,
      orderTypes: [], tif: [], triggerPriceTypes: [],
    })
    // quanto_multiplier 是「每张多少个币」：DOGE 一张 10 个，ETH 一张 0.01 个；步长 / 最小量同口径折成币
    expect(connector.getInstrument('gateio:DOGE_USDT')?.contractSize).toBe('10')
    expect(connector.getInstrument('gateio:DOGE_USDT')?.size).toEqual({ step: '10', decimals: 0, min: '10' })
    expect(connector.getInstrument('gateio:ETH_USDT')?.contractSize).toBe('0.01')
    expect(connector.getInstrument('gateio:ETH_USDT')?.size).toEqual({ step: '0.01', decimals: 2, min: '0.01' })
  })

  it('falls back to protocol-permitted defaults when tick / order_size_min are missing or zero', async () => {
    const fake = new FakeGateio()
    fake.contracts = [{ ...REAL_CONTRACTS[0]!, name: 'NODATA_USDT', order_price_round: '0', order_size_min: 0, quanto_multiplier: undefined }]
    const connector = new GateioDataConnector({ baseUrl: 'http://gateio.example.test', fetchImpl: fake.fetch, clock: () => FX_NOW })
    await connector.start()
    const inst = connector.getInstrument('gateio:NODATA_USDT')!

    expect(inst.price).toEqual({ sigFigs: 5, maxDecimals: 8 })
    expect(inst.size).toEqual({ step: '1', decimals: 0, min: '1' })
    expect(inst.contractSize).toBe('1')
    expect(inst.minNotional).toBeUndefined()
  })
})
