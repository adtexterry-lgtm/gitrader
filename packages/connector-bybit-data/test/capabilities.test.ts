// SPDX-License-Identifier: CPAL-1.0
// describe() 能力声明 + 合约目录：只读、只线性永续、orderTypes 全 none、tickSize/qtyStep/minOrderQty/minNotional/fundingInterval 映射。
import { describe, expect, it } from 'vitest'
import { ORDER_TYPES, validateVenueCapabilities } from '@gitrader/protocol'
import { BybitDataConnector } from '../src/connector'
import { FakeBybit, FX_NOW, perpEntry } from './helpers/fake-bybit'

function make() {
  const fake = new FakeBybit()
  const connector = new BybitDataConnector({ fetchImpl: fake.fetch, clock: () => FX_NOW })
  return { fake, connector }
}

describe('describe()', () => {
  it('passes the protocol schema and declares a read-only perp data source', () => {
    const { connector } = make()
    const caps = connector.describe()

    const validated = validateVenueCapabilities(caps)
    expect(validated.ok, JSON.stringify(validated)).toBe(true)

    expect(caps.venue).toBe('bybit')
    expect(caps.environments).toEqual(['mainnet'])
    expect(caps.instrumentKinds).toEqual(['perp'])
    for (const type of ORDER_TYPES) expect(caps.orderTypes[type]).toBe('none')
    expect(caps.tif).toEqual([])
    expect(caps.triggerPriceTypes).toEqual([])
    expect(caps.rateLimits).toEqual([{ scope: 'ip', model: 'count', limit: 120, windowMs: 5000 }])
    expect(caps.history).toEqual({ maxCandles: 1000, pageLimit: 1000 })
    expect(caps['x-data-only']).toBe(true)
  })

  it('the connector reports the venue and mainnet environment', () => {
    const { connector } = make()
    expect(connector.venue).toBe('bybit')
    expect(connector.environment).toBe('mainnet')
    expect(connector.status()).toMatchObject({ venue: 'bybit', environment: 'mainnet', source: 'rest', wsState: 'disconnected' })
  })
})

describe('instrument catalogue', () => {
  it('start() pulls the linear catalogue once and maps symbol to bybit:<symbol>', async () => {
    const { fake, connector } = make()
    expect(connector.listInstruments()).toEqual([])
    expect(connector.getInstrument('bybit:BTCUSDT')).toBeUndefined()

    await connector.start()
    await connector.start()
    const calls = fake.callsTo('/v5/market/instruments-info')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.params.get('category')).toBe('linear')
    expect(calls[0]!.params.get('limit')).toBe('1000')
    expect(calls[0]!.params.get('cursor')).toBeNull()

    const ids = connector.listInstruments().map((i) => i.instrumentId)
    // 交割合约、反向永续、未上市条目都被剔除
    expect(ids).toEqual(['bybit:0GUSDT', 'bybit:BTCUSDT', 'bybit:ETHUSDT'])
    expect(connector.listInstruments({ includeDelisted: true }).map((i) => i.instrumentId)).toEqual(ids)
    expect(connector.getInstrument('bybit:ETHUSDT')?.base).toBe('ETH')
  })

  it('follows nextPageCursor until it is empty', async () => {
    const fake = new FakeBybit()
    fake.instrumentPages = [
      { list: [perpEntry()], nextPageCursor: 'page-2' },
      { list: [perpEntry({ symbol: 'ETHUSDT', baseCoin: 'ETH', quoteCoin: 'USDT' })], nextPageCursor: '' },
    ]
    const connector = new BybitDataConnector({ fetchImpl: fake.fetch, clock: () => FX_NOW })
    await connector.start()

    const calls = fake.callsTo('/v5/market/instruments-info')
    expect(calls).toHaveLength(2)
    expect(calls[1]!.params.get('cursor')).toBe('page-2')
    expect(connector.listInstruments().map((i) => i.instrumentId)).toEqual(['bybit:BTCUSDT', 'bybit:ETHUSDT'])
  })

  it('maps tickSize / qtyStep / minOrderQty / minNotionalValue onto protocol fields', async () => {
    const { connector } = make()
    await connector.start()
    const btc = connector.getInstrument('bybit:BTCUSDT')!
    expect(btc).toMatchObject({
      venue: 'bybit', symbol: 'BTCUSDT', displaySymbol: 'BTC-PERP', kind: 'perp', base: 'BTC', quote: 'USDT',
      settle: 'USDT', settlement: 'linear', contractSize: '1', venueSizeUnit: 'base', assetClass: 'crypto',
      status: 'trading', price: { tick: '0.1', maxDecimals: 1 }, size: { step: '0.001', decimals: 3, min: '0.001' },
      minNotional: '5', fundingIntervalMs: 28_800_000, orderTypes: [], tif: [], triggerPriceTypes: [],
    })
    // fundingInterval 以分钟给（0GUSDT 为 240 分钟 = 4 小时），必须按上游算而不是写死 8 小时
    expect(connector.getInstrument('bybit:0GUSDT')?.fundingIntervalMs).toBe(14_400_000)
    expect(connector.getInstrument('bybit:ETHUSDT')?.size).toEqual({ step: '0.01', decimals: 2, min: '0.01' })
  })

  it('falls back to protocol-permitted defaults when tick / step / min are missing or unusable', async () => {
    const fake = new FakeBybit()
    fake.instrumentPages = [
      {
        list: [perpEntry({ symbol: 'NODATAUSDT', baseCoin: 'NODATA', priceFilter: { tickSize: '0' }, lotSizeFilter: { qtyStep: '', minOrderQty: undefined } })],
        nextPageCursor: '',
      },
    ]
    const connector = new BybitDataConnector({ fetchImpl: fake.fetch, clock: () => FX_NOW })
    await connector.start()
    const inst = connector.getInstrument('bybit:NODATAUSDT')!
    expect(inst.price).toEqual({ sigFigs: 5, maxDecimals: 8 })
    expect(inst.size).toEqual({ step: '1', decimals: 0, min: '1' })
    expect(inst.minNotional).toBeUndefined()
    expect(inst.fundingIntervalMs).toBe(28_800_000)
  })

  it('keeps PendingOpen contracts as halted (not tradable yet) instead of dropping them; PreLaunch still skipped', async () => {
    const fake = new FakeBybit()
    fake.instrumentPages = [{
      list: [perpEntry(), perpEntry({ symbol: 'NEWUSDT', baseCoin: 'NEW', status: 'PendingOpen' }), perpEntry({ symbol: 'PREUSDT', baseCoin: 'PRE', status: 'PreLaunch' })],
      nextPageCursor: '',
    }]
    const connector = new BybitDataConnector({ fetchImpl: fake.fetch, clock: () => FX_NOW })
    await connector.start()
    expect(connector.getInstrument('bybit:NEWUSDT')?.status).toBe('halted')
    expect(connector.getInstrument('bybit:BTCUSDT')?.status).toBe('trading')
    expect(connector.getInstrument('bybit:PREUSDT')).toBeUndefined()
  })
})
