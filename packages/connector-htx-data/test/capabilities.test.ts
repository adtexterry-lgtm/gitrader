// SPDX-License-Identifier: CPAL-1.0
// describe() 能力声明 + swap_contract_info 目录：只读、只 perp、orderTypes 全 none、面值与 tick 映射、状态表。
import { describe, expect, it } from 'vitest'
import { ORDER_TYPES, validateVenueCapabilities } from '@gitrader/protocol'
import type { InstrumentStatus } from '@gitrader/protocol'
import { HtxDataConnector } from '../src/connector'
import { parseInstrument } from '../src/parse'
import { FakeHtx, FX_NOW, contractEntry } from './helpers/fake-htx'

function make() {
  const fake = new FakeHtx()
  const connector = new HtxDataConnector({ fetchImpl: fake.fetch, clock: () => FX_NOW })
  return { fake, connector }
}

describe('describe()', () => {
  it('passes the protocol schema and declares a read-only perp data source', () => {
    const { connector } = make()
    const caps = connector.describe()

    const validated = validateVenueCapabilities(caps)
    expect(validated.ok, JSON.stringify(validated)).toBe(true)

    expect(caps.venue).toBe('htx')
    expect(caps.environments).toEqual(['mainnet'])
    expect(caps.instrumentKinds).toEqual(['perp'])
    for (const type of ORDER_TYPES) expect(caps.orderTypes[type]).toBe('none')
    expect(caps.tif).toEqual([])
    expect(caps.triggerPriceTypes).toEqual([])
    expect(caps.rateLimits).toEqual([{ scope: 'ip', model: 'count', limit: 800, windowMs: 1000 }])
    expect(caps.history).toEqual({ maxCandles: 2000, pageLimit: 2000 })
    expect(caps['x-data-only']).toBe(true)
  })

  it('the connector reports the venue and mainnet environment', () => {
    const { connector } = make()
    expect(connector.venue).toBe('htx')
    expect(connector.environment).toBe('mainnet')
    expect(connector.status()).toMatchObject({ venue: 'htx', environment: 'mainnet', source: 'rest', wsState: 'disconnected' })
  })
})

describe('swap_contract_info catalogue', () => {
  it('start() pulls the contract list once and maps contract_code to htx:<contract_code>', async () => {
    const { fake, connector } = make()
    expect(connector.listInstruments()).toEqual([])
    expect(connector.getInstrument('htx:BTC-USDT')).toBeUndefined()

    await connector.start()
    await connector.start()
    expect(fake.callsTo('/linear-swap-api/v1/swap_contract_info')).toHaveLength(1)

    const ids = connector.listInstruments().map((i) => i.instrumentId)
    expect(ids).toEqual(['htx:BTC-USDC', 'htx:BTC-USDT', 'htx:ETH-USDT', 'htx:HALT-USDT', 'htx:NEW-USDT'])
    // 期货条目（business_type=futures）不进来；Delisting(0) 默认不展示
    expect(ids).not.toContain('htx:BTC-USDT-CQ')
    expect(ids).not.toContain('htx:OLD-USDT')
    expect(connector.listInstruments({ includeDelisted: true }).map((i) => i.instrumentId)).toContain('htx:OLD-USDT')
    expect(connector.getInstrument('htx:ETH-USDT')?.base).toBe('ETH')
    expect(connector.getInstrument('htx:NOPE-USDT')).toBeUndefined()
  })

  it('asks for swap contracts explicitly (business_type=swap, contract_type=swap)', async () => {
    const { fake, connector } = make()
    await connector.start()
    const call = fake.callsTo('/linear-swap-api/v1/swap_contract_info')[0]!
    expect(call.params.get('business_type')).toBe('swap')
    expect(call.params.get('contract_type')).toBe('swap')
    expect(call.params.get('contract_code')).toBeNull()
  })

  it('maps tick, contract size and status into protocol fields', async () => {
    const { connector } = make()
    await connector.start()
    const btc = connector.getInstrument('htx:BTC-USDT')!
    expect(btc).toMatchObject({
      venue: 'htx', symbol: 'BTC-USDT', displaySymbol: 'BTC-PERP', kind: 'perp', base: 'BTC', quote: 'USDT', settle: 'USDT',
      settlement: 'linear', contractSize: '0.001', venueSizeUnit: 'base', assetClass: 'crypto', status: 'trading',
      price: { tick: '0.1', maxDecimals: 1 }, size: { step: '0.001', decimals: 3, min: '0.001' },
      fundingIntervalMs: 28_800_000, orderTypes: [], tif: [], triggerPriceTypes: [],
    })
  })

  it('maps every documented contract_status value to a protocol status', () => {
    const cases: Array<[number, InstrumentStatus]> = [
      [1, 'trading'],
      [2, 'halted'],
      [3, 'halted'],
      [4, 'halted'],
      [0, 'delisted'],
      [5, 'delisted'],
      [6, 'delisted'],
      [7, 'delisted'],
      [8, 'delisted'],
      [99, 'halted'],
    ]
    for (const [code, status] of cases) {
      const instrument = parseInstrument(contractEntry({ contract_status: code }), FX_NOW)
      expect(instrument?.status, `contract_status ${code}`).toBe(status)
    }
  })

  it('falls back to protocol-permitted defaults when contract_size / price_tick are missing or unusable', () => {
    const instrument = parseInstrument(contractEntry({ contract_size: '0', price_tick: undefined }), FX_NOW)!
    expect(instrument.contractSize).toBe('1')
    expect(instrument.size).toEqual({ step: '1', decimals: 0, min: '1' })
    expect(instrument.price).toEqual({ sigFigs: 5, maxDecimals: 8 })
  })

  it('drops futures, non-swap business types and non USDT/USDC pairs', () => {
    expect(parseInstrument(contractEntry({ business_type: 'futures' }), FX_NOW)).toBeUndefined()
    expect(parseInstrument(contractEntry({ contract_type: 'this_week' }), FX_NOW)).toBeUndefined()
    expect(parseInstrument(contractEntry({ pair: 'BTC-USD', contract_code: 'BTC-USD' }), FX_NOW)).toBeUndefined()
    expect(parseInstrument(contractEntry({ contract_code: '' }), FX_NOW)).toBeUndefined()
  })
})
