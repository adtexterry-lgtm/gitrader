// SPDX-License-Identifier: CPAL-1.0
// describe() 能力声明 + 合约目录：只读、只收 PF_ 永续且 tradeable、tickSize / contractValueTradePrecision 映射，数量折成标的币。
import { describe, expect, it } from 'vitest'
import { ORDER_TYPES, validateVenueCapabilities } from '@gitrader/protocol'
import { KrakenDataConnector } from '../src/connector'
import { FakeKraken, FX_NOW, perpEntry } from './helpers/fake-kraken'

function make() {
  const fake = new FakeKraken()
  const connector = new KrakenDataConnector({ fetchImpl: fake.fetch, clock: () => FX_NOW })
  return { fake, connector }
}

describe('describe()', () => {
  it('passes the protocol schema and declares a read-only perp data source', () => {
    const { connector } = make()
    const caps = connector.describe()

    const validated = validateVenueCapabilities(caps)
    expect(validated.ok, JSON.stringify(validated)).toBe(true)

    expect(caps.venue).toBe('kraken')
    expect(caps.environments).toEqual(['mainnet'])
    expect(caps.instrumentKinds).toEqual(['perp'])
    for (const type of ORDER_TYPES) expect(caps.orderTypes[type]).toBe('none')
    expect(caps.tif).toEqual([])
    expect(caps.triggerPriceTypes).toEqual([])
    // 公共端点约 500 次 / 10 s，按次计
    expect(caps.rateLimits).toEqual([{ scope: 'ip', model: 'count', limit: 500, windowMs: 10_000 }])
    expect(caps.history).toEqual({ maxCandles: 5000, pageLimit: 5000 })
    expect(caps['x-data-only']).toBe(true)
  })

  it('the connector reports the venue and mainnet environment', () => {
    const { connector } = make()
    expect(connector.venue).toBe('kraken')
    expect(connector.environment).toBe('mainnet')
    expect(connector.status()).toMatchObject({ venue: 'kraken', environment: 'mainnet', source: 'rest', wsState: 'disconnected' })
  })
})

describe('instrument catalogue', () => {
  it('start() pulls the catalogue once and keeps only PF_ symbols with tradeable === true', async () => {
    const { fake, connector } = make()
    expect(connector.listInstruments()).toEqual([])
    expect(connector.getInstrument('kraken:PF_XBTUSD')).toBeUndefined()

    await connector.start()
    await connector.start()
    expect(fake.callsTo('/derivatives/api/v3/instruments')).toHaveLength(1)

    // FF_ 季度合约、PI_ 反向季度、tradeable=false 的 PF_ 都不收录；停牌合约保留为 halted
    expect(connector.listInstruments().map((i) => i.instrumentId)).toEqual([
      'kraken:PF_ETHUSD', 'kraken:PF_SOLUSD', 'kraken:PF_SUSP', 'kraken:PF_XBTUSD',
    ])
    expect(connector.getInstrument('kraken:PF_ETHUSD')?.base).toBe('ETH')
    expect(connector.getInstrument('kraken:PF_SUSP')?.status).toBe('halted')
  })

  it('maps tickSize / contractValueTradePrecision / contractSize into protocol fields', async () => {
    const { connector } = make()
    await connector.start()
    const btc = connector.getInstrument('kraken:PF_XBTUSD')!

    expect(btc).toMatchObject({
      venue: 'kraken', symbol: 'PF_XBTUSD', displaySymbol: 'BTC-USD-PERP', kind: 'perp', base: 'BTC', quote: 'USD',
      settle: 'BTC', settlement: 'inverse', contractSize: '1', venueSizeUnit: 'base', assetClass: 'crypto',
      status: 'trading', price: { tick: '1', maxDecimals: 0 }, size: { step: '0.0001', decimals: 4, min: '0.0001' },
      fundingIntervalMs: 3_600_000, orderTypes: [], tif: [], triggerPriceTypes: [],
    })
    expect(connector.getInstrument('kraken:PF_ETHUSD')?.price).toEqual({ tick: '0.1', maxDecimals: 1 })
    expect(connector.getInstrument('kraken:PF_ETHUSD')?.size).toEqual({ step: '0.001', decimals: 3, min: '0.001' })
    // 上游不给最小名义额
    expect(btc.minNotional).toBeUndefined()
  })

  it('falls back to protocol-permitted defaults when tick / precision / contract size are missing or unusable', async () => {
    const fake = new FakeKraken()
    fake.instruments = [
      perpEntry({
        symbol: 'PF_NODATA', tickSize: 0, contractValueTradePrecision: undefined, contractSize: undefined,
        base: 'NODATA', quote: 'USD', pair: 'NODATA:USD',
      }),
      // 真网存在负精度标的（-3 表示步长 1000 张）
      perpEntry({ symbol: 'PF_COARSE', contractValueTradePrecision: -3, base: 'COARSE', pair: 'COARSE:USD' }),
    ]
    const connector = new KrakenDataConnector({ fetchImpl: fake.fetch, clock: () => FX_NOW })
    await connector.start()
    const inst = connector.getInstrument('kraken:PF_NODATA')!

    expect(inst.price).toEqual({ sigFigs: 5, maxDecimals: 8 })
    expect(inst.size).toEqual({ step: '1', decimals: 0, min: '1' })
    expect(inst.contractSize).toBe('1')
    expect(connector.getInstrument('kraken:PF_COARSE')?.size).toEqual({ step: '1000', decimals: 0, min: '1000' })
  })

  it('multiplies contract-denominated size rules by contractSize and declares base units', async () => {
    const fake = new FakeKraken()
    fake.instruments = [
      perpEntry({
        symbol: 'PF_MULTI', contractSize: 10, contractValueTradePrecision: 2,
        base: 'MULTI', quote: 'USD', pair: 'MULTI:USD',
      }),
    ]
    const connector = new KrakenDataConnector({ fetchImpl: fake.fetch, clock: () => FX_NOW })
    await connector.start()
    const inst = connector.getInstrument('kraken:PF_MULTI')!

    expect(inst.contractSize).toBe('10')
    expect(inst.venueSizeUnit).toBe('base')
    // 张数步长 0.01 × 每张 10 个标的币 = 0.1 个标的币
    expect(inst.size).toEqual({ step: '0.1', decimals: 1, min: '0.1' })
  })
})
