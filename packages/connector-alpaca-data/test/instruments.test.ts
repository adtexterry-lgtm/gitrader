// SPDX-License-Identifier: CPAL-1.0
// 标的目录：/v2/assets → Instrument（美股形状照 protocol instrument.ts）、原生 symbol 保留、非美股剔除、
// 碎股 / 可借等协议没有的属性走 assetFlags()。
import { describe, expect, it } from 'vitest'
import { AlpacaDataConnector } from '../src/connector'
import { assetFlagsOf } from '../src/parse'
import { DATA_HOST, FX_NOW, FakeAlpaca, TRADING_HOST, assetEntry } from './helpers/fake-alpaca'

export function make(o: Record<string, unknown> = {}): { fake: FakeAlpaca; connector: AlpacaDataConnector } {
  const fake = new FakeAlpaca()
  const connector = new AlpacaDataConnector({
    tradingBaseUrl: `http://${TRADING_HOST}`,
    dataBaseUrl: `http://${DATA_HOST}`,
    fetchImpl: fake.fetch,
    clock: () => FX_NOW,
    ...o,
  })
  return { fake, connector }
}

describe('instrument catalogue', () => {
  it('start() pulls the calendar first, then us_equity assets, and caches them (one call each)', async () => {
    const { fake, connector } = make()
    expect(connector.listInstruments()).toEqual([])

    await connector.start()
    await connector.start()

    expect(fake.callsTo(TRADING_HOST, '/v2/calendar')).toHaveLength(1)
    const assets = fake.callsTo(TRADING_HOST, '/v2/assets')
    expect(assets).toHaveLength(1)
    expect(assets[0]!.params.get('status')).toBe('active')
    expect(assets[0]!.params.get('asset_class')).toBe('us_equity')
    expect(fake.callsTo(TRADING_HOST, '/v2/clock')).toHaveLength(1)
    // 日历必须先于标的：sessions 来自接口，不在代码里写死
    expect(fake.calls[0]!.path).toBe('/v2/calendar')
    expect(fake.calls[1]!.path).toBe('/v2/assets')
  })

  it('maps a US equity onto the protocol instrument shape (spot / stocks / USD / base)', async () => {
    const { connector } = make()
    await connector.start()
    const aapl = connector.getInstrument('alpaca:AAPL')!

    expect(aapl).toMatchObject({
      instrumentId: 'alpaca:AAPL', venue: 'alpaca', symbol: 'AAPL', displaySymbol: 'AAPL',
      kind: 'spot', base: 'AAPL', quote: 'USD', settle: 'USD', settlement: 'linear',
      contractSize: '1', venueSizeUnit: 'base', assetClass: 'stocks', status: 'trading',
      orderTypes: [], tif: [], triggerPriceTypes: [],
    })
    expect(aapl.underlying).toEqual({ description: 'Apple Inc. Common Stock', synthetic: false })
    // 美股没有资金费字段
    expect(aapl.fundingIntervalMs).toBeUndefined()
    // 协议没有分档 tick 字段：只给 maxDecimals，不写死 tick
    expect(aapl.price).toEqual({ maxDecimals: 4 })
    expect(aapl.size).toEqual({ step: '1', decimals: 0, min: '1' })
    expect(aapl.updatedAt).toBe(FX_NOW)
  })

  it('drops non-US-equity assets and delisted rows, keeps halted ones out of trading status', async () => {
    const { connector } = make()
    await connector.start()
    const ids = connector.listInstruments().map((i) => i.instrumentId)
    expect(ids).toEqual(['alpaca:AAPL', 'alpaca:BRK.B', 'alpaca:HALT', 'alpaca:MSFT'])
    // 下线标的仍在缓存里（能按 id 查到并看到状态），但默认不进 listInstruments
    expect(connector.getInstrument('alpaca:OLD')?.status).toBe('delisted')
    expect(connector.listInstruments({ includeDelisted: true }).map((i) => i.instrumentId)).toContain('alpaca:OLD')
    expect(connector.getInstrument('alpaca:HALT')?.status).toBe('halted')
    // 加密资产不在本包范围
    expect(connector.getInstrument('alpaca:BTC/USD')).toBeUndefined()
    expect(ids.some((id) => id.includes('BTC'))).toBe(false)
  })

  it('keeps the native symbol casing and dots (BRK.B is not BRK/B)', async () => {
    const { connector } = make()
    await connector.start()
    expect(connector.getInstrument('alpaca:BRK.B')?.symbol).toBe('BRK.B')
    expect(connector.getInstrument('alpaca:BRK.B')?.base).toBe('BRK.B')
  })

  it('exposes fractionable / shortable / borrow_status through assetFlags() (no protocol field)', async () => {
    const { connector } = make()
    await connector.start()
    expect(connector.assetFlags('alpaca:AAPL')).toEqual({
      symbol: 'AAPL', exchange: 'NASDAQ', tradable: true, marginable: true, shortable: true,
      borrowStatus: 'easy_to_borrow', easyToBorrow: true, fractionable: true,
      marginRequirementLong: 30, marginRequirementShort: 30, maintenanceMarginRequirement: null,
    })
    expect(connector.assetFlags('alpaca:MSFT')).toMatchObject({
      fractionable: false, shortable: false, borrowStatus: 'hard_to_borrow', easyToBorrow: false, tradable: true,
    })
    expect(connector.assetFlags('alpaca:NOPE')).toBeUndefined()
    expect(() => connector.assetFlags('nasdaq:AAPL')).toThrow(/not a alpaca instrument id/)
  })

  it('falls back to protocol-permitted defaults when optional asset fields are missing', async () => {
    const fake = new FakeAlpaca()
    fake.assets = [assetEntry({
      symbol: 'BARE', name: undefined, exchange: undefined, marginable: undefined, shortable: undefined,
      borrow_status: undefined, fractionable: undefined, margin_requirement_long: undefined, margin_requirement_short: undefined,
    })]
    const connector = new AlpacaDataConnector({
      tradingBaseUrl: `http://${TRADING_HOST}`, dataBaseUrl: `http://${DATA_HOST}`,
      fetchImpl: fake.fetch, clock: () => FX_NOW,
    })
    await connector.start()
    const bare = connector.getInstrument('alpaca:BARE')!
    expect(bare.underlying).toBeUndefined()
    expect(bare.price).toEqual({ maxDecimals: 4 })
    expect(connector.assetFlags('alpaca:BARE')).toEqual({
      symbol: 'BARE', exchange: null, tradable: true, marginable: false, shortable: false,
      borrowStatus: null, easyToBorrow: false, fractionable: false,
      marginRequirementLong: null, marginRequirementShort: null, maintenanceMarginRequirement: null,
    })
  })

  it('reads the pre-2026-09-22 legacy fields only as a fallback; borrow_status wins; unknown is never "easy"', () => {
    const legacy = assetFlagsOf({ symbol: 'OLD', easy_to_borrow: true, maintenance_margin_requirement: 25 })!
    expect(legacy).toMatchObject({ borrowStatus: 'easy_to_borrow', easyToBorrow: true, maintenanceMarginRequirement: 25, marginRequirementLong: null })
    expect(assetFlagsOf({ symbol: 'OLD', easy_to_borrow: false })).toMatchObject({ borrowStatus: 'hard_to_borrow', easyToBorrow: false })
    expect(assetFlagsOf({ symbol: 'MIX', borrow_status: 'hard_to_borrow', easy_to_borrow: true })).toMatchObject({ borrowStatus: 'hard_to_borrow', easyToBorrow: false })
    expect(assetFlagsOf({ symbol: 'NEW', borrow_status: 'some_new_value', easy_to_borrow: true })).toMatchObject({ borrowStatus: null, easyToBorrow: false })
    expect(assetFlagsOf({ symbol: 'NONE' })).toMatchObject({ borrowStatus: null, easyToBorrow: false })
  })

  it('refreshes the catalogue on demand without re-fetching sessions first', async () => {
    const { fake, connector } = make()
    await connector.start()
    fake.assets = [assetEntry({ id: 'y1', symbol: 'NVDA', name: 'NVIDIA Corporation Common Stock' })]
    await connector.market.refreshAssets()
    expect(fake.callsTo(TRADING_HOST, '/v2/assets')).toHaveLength(2)
    expect(connector.listInstruments().map((i) => i.symbol)).toEqual(['NVDA'])
  })
})
