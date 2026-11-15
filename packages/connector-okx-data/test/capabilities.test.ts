// SPDX-License-Identifier: CPAL-1.0
// describe() 能力声明 + 合约目录：只读、只 SWAP、orderTypes 全 none、tickSz/lotSz/minSz/ctVal 映射（数量折成币）。
import { describe, expect, it } from 'vitest'
import { ORDER_TYPES, validateVenueCapabilities } from '@gitrader/protocol'
import { OkxDataConnector } from '../src/connector'
import { FakeOkx, FX_NOW, swapEntry } from './helpers/fake-okx'

function make() {
  const fake = new FakeOkx()
  const connector = new OkxDataConnector({ fetchImpl: fake.fetch, clock: () => FX_NOW })
  return { fake, connector }
}

describe('describe()', () => {
  it('passes the protocol schema and declares a read-only perp data source', () => {
    const { connector } = make()
    const caps = connector.describe()

    const validated = validateVenueCapabilities(caps)
    expect(validated.ok, JSON.stringify(validated)).toBe(true)

    expect(caps.venue).toBe('okx')
    expect(caps.environments).toEqual(['mainnet'])
    expect(caps.instrumentKinds).toEqual(['perp'])
    for (const type of ORDER_TYPES) expect(caps.orderTypes[type]).toBe('none')
    expect(caps.tif).toEqual([])
    expect(caps.triggerPriceTypes).toEqual([])
    expect(caps.rateLimits).toEqual([{ scope: 'ip', model: 'count', limit: 20, windowMs: 2000 }])
    expect(caps.history).toEqual({ maxCandles: 300, pageLimit: 100 })
    expect(caps['x-data-only']).toBe(true)
  })

  it('the connector reports the venue and mainnet environment', () => {
    const { connector } = make()
    expect(connector.venue).toBe('okx')
    expect(connector.environment).toBe('mainnet')
    expect(connector.status()).toMatchObject({ venue: 'okx', environment: 'mainnet', source: 'rest', wsState: 'disconnected' })
  })
})

describe('instrument catalogue', () => {
  it('start() pulls SWAP instruments once and maps instId to okx:<instId>', async () => {
    const { fake, connector } = make()
    expect(connector.listInstruments()).toEqual([])
    expect(connector.getInstrument('okx:BTC-USDT-SWAP')).toBeUndefined()

    await connector.start()
    await connector.start()
    const calls = fake.callsTo('/api/v5/public/instruments')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.params.get('instType')).toBe('SWAP')

    const ids = connector.listInstruments().map((i) => i.instrumentId)
    // 交割合约与币本位（BTC-USD-SWAP）被剔除，expired 条目按 delisted 过滤
    expect(ids).toEqual(['okx:BTC-USDT-SWAP', 'okx:ETH-USDT-SWAP'])
    expect(ids).not.toContain('okx:BTC-USD-SWAP')
    expect(connector.listInstruments({ includeDelisted: true }).map((i) => i.instrumentId)).toContain('okx:OLD-USDT-SWAP')
    expect(connector.getInstrument('okx:ETH-USDT-SWAP')?.base).toBe('ETH')
  })

  it('keeps only USDT/USDC-settled linear swaps and drops coin-margined (inverse) entries', async () => {
    const fake = new FakeOkx()
    fake.instruments = [
      swapEntry({ instId: 'BTC-USDT-SWAP' }),
      swapEntry({ instId: 'ETH-USDC-SWAP', instFamily: 'ETH-USDC', settleCcy: 'USDC', ctVal: '0.01', ctValCcy: 'ETH' }),
      // settleCcy = 标的币 → 币本位（inverse），不收
      swapEntry({ instId: 'BTC-USD-SWAP', instFamily: 'BTC-USD', settleCcy: 'BTC', ctVal: '100', ctValCcy: 'USD' }),
      swapEntry({ instId: 'ETH-USD-SWAP', instFamily: 'ETH-USD', settleCcy: 'ETH', ctVal: '10', ctValCcy: 'USD' }),
      // 其它结算币（USD）也不收：第一版只承诺 USDT / USDC 线性合约
      swapEntry({ instId: 'XRP-USD-SWAP', instFamily: 'XRP-USD', settleCcy: 'USD', ctVal: '100', ctValCcy: 'XRP' }),
    ]
    const connector = new OkxDataConnector({ fetchImpl: fake.fetch, clock: () => FX_NOW })
    await connector.start()

    const kept = connector.listInstruments({ includeDelisted: true })
    expect(kept.map((i) => i.symbol)).toEqual(['BTC-USDT-SWAP', 'ETH-USDC-SWAP'])
    for (const instrument of kept) {
      expect(instrument.settlement).toBe('linear')
      expect(['USDT', 'USDC']).toContain(instrument.settle)
      // 结算币 ≠ 标的币 = 线性；折币也只在 ctVal 上做，与结算币判断无关
      expect(instrument.settle).not.toBe(instrument.base)
    }
    expect(connector.getInstrument('okx:BTC-USD-SWAP')).toBeUndefined()
    expect(connector.getInstrument('okx:ETH-USD-SWAP')).toBeUndefined()
    expect(connector.getInstrument('okx:XRP-USD-SWAP')).toBeUndefined()
  })

  it('parses tickSz / lotSz / minSz / ctVal into protocol fields, folding 张 into base', async () => {
    const { connector } = make()
    await connector.start()
    const btc = connector.getInstrument('okx:BTC-USDT-SWAP')!
    // ctVal = 0.01：lotSz / minSz = 0.01 张 → size.step / size.min = 0.0001 BTC
    expect(btc).toMatchObject({
      venue: 'okx', symbol: 'BTC-USDT-SWAP', displaySymbol: 'BTC-PERP', kind: 'perp', base: 'BTC', quote: 'USDT',
      settle: 'USDT', settlement: 'linear', contractSize: '0.01', venueSizeUnit: 'base', assetClass: 'crypto',
      status: 'trading', price: { tick: '0.1', maxDecimals: 1 }, size: { step: '0.0001', decimals: 4, min: '0.0001' },
      fundingIntervalMs: 28_800_000, orderTypes: [], tif: [], triggerPriceTypes: [],
    })
    // 以标的币结算的币本位合约不收
    expect(connector.getInstrument('okx:BTC-USD-SWAP')).toBeUndefined()
    expect(connector.getInstrument('okx:OLD-USDT-SWAP')?.status).toBe('delisted')
  })

  it('falls back to protocol-permitted defaults when tick / lot / min are missing or unusable', async () => {
    const fake = new FakeOkx()
    fake.instruments = [swapEntry({ instId: 'NODATA-USDT-SWAP', tickSz: '0', lotSz: '', minSz: undefined })]
    const connector = new OkxDataConnector({ fetchImpl: fake.fetch, clock: () => FX_NOW })
    await connector.start()
    const inst = connector.getInstrument('okx:NODATA-USDT-SWAP')!
    expect(inst.price).toEqual({ sigFigs: 5, maxDecimals: 8 })
    // 缺 lotSz / minSz → 按 1 张算，再乘 ctVal（夹具 0.01）
    expect(inst.size).toEqual({ step: '0.01', decimals: 2, min: '0.01' })
    expect(inst.minNotional).toBeUndefined()
  })
})
