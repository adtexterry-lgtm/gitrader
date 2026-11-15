// SPDX-License-Identifier: CPAL-1.0
// 标的清单：/stock/symbol 一次拉取并缓存、Instrument 字段映射、坏行跳过、exchange 参数透传。
import { describe, expect, it } from 'vitest'
import { FinnhubDataConnector } from '../src/connector'
import { FakeFinnhub, FX_NOW, TEST_KEY, symbolRow } from './helpers/fake-finnhub'

function make(o: Record<string, unknown> = {}) {
  const fake = new FakeFinnhub()
  const connector = new FinnhubDataConnector({
    baseUrl: 'https://finnhub.example.test/v1', fetchImpl: fake.fetch, clock: () => FX_NOW, env: { FINNHUB_API_KEY: TEST_KEY }, ...o,
  })
  return { fake, connector }
}

describe('instrument catalogue', () => {
  it('start() pulls /stock/symbol once and maps the native symbol to finnhub:<symbol>', async () => {
    const { fake, connector } = make()
    expect(connector.listInstruments()).toEqual([])

    await connector.start()
    await connector.start()
    expect(fake.callsTo('/stock/symbol')).toHaveLength(1)

    expect(connector.listInstruments().map((i) => i.instrumentId)).toEqual(['finnhub:AAPL', 'finnhub:MSFT'])
    expect(connector.getInstrument('finnhub:MSFT')?.symbol).toBe('MSFT')
    expect(connector.getInstrument('finnhub:NOPE')).toBeUndefined()
  })

  it('maps an equity row onto the protocol Instrument shape', async () => {
    const { connector } = make()
    await connector.start()
    const aapl = connector.getInstrument('finnhub:AAPL')!
    expect(aapl).toMatchObject({
      instrumentId: 'finnhub:AAPL', venue: 'finnhub', symbol: 'AAPL', displaySymbol: 'AAPL', kind: 'spot',
      base: 'AAPL', quote: 'USD', settle: 'USD', settlement: 'linear', contractSize: '1', venueSizeUnit: 'base',
      assetClass: 'stocks', marketGroup: null, status: 'trading',
      price: { maxDecimals: 4 }, size: { step: '1', decimals: 0, min: '1' },
      underlying: { description: 'APPLE INC', synthetic: false },
      orderTypes: [], tif: [], triggerPriceTypes: [], updatedAt: FX_NOW,
    })
    // Finnhub 不提供交易日历：sessions 是美股常规时段（纽约时区），日期级例外走 marketHolidays()
    expect(aapl.sessions).toEqual({
      tz: 'America/New_York',
      windows: [{ days: [1, 2, 3, 4, 5], from: '09:30', to: '16:00', quality: 'regular' }],
    })
  })

  it('keeps the venue-native display symbol and currency, and skips rows without a symbol', async () => {
    const fake = new FakeFinnhub()
    fake.symbols = [
      symbolRow({ symbol: 'BRK.B', displaySymbol: 'BRK.B', description: 'BERKSHIRE HATHAWAY INC-CL B' }),
      symbolRow({ symbol: 'SHOP', currency: 'CAD', displaySymbol: 'SHOP', description: 'SHOPIFY INC' }),
      symbolRow({ symbol: '' }),
      { description: 'no symbol field at all' },
      null,
      'not-an-object',
    ]
    const connector = new FinnhubDataConnector({
      baseUrl: 'https://finnhub.example.test/v1', fetchImpl: fake.fetch, clock: () => FX_NOW, env: { FINNHUB_API_KEY: TEST_KEY },
    })
    await connector.start()

    const ids = connector.listInstruments().map((i) => i.instrumentId)
    expect(ids).toEqual(['finnhub:BRK.B', 'finnhub:SHOP']) // 原生大小写与点号原样保留
    expect(connector.getInstrument('finnhub:SHOP')?.quote).toBe('CAD')
  })

  it('sends the configured exchange (default US) and can be re-pointed', async () => {
    const { fake, connector } = make()
    await connector.start()
    expect(fake.callsTo('/stock/symbol')[0]!.params.get('exchange')).toBe('US')

    const lse = make({ exchange: 'london' })
    await lse.connector.start()
    expect(lse.fake.callsTo('/stock/symbol')[0]!.params.get('exchange')).toBe('LONDON')
  })

  it('rejects a payload that is not an array instead of silently returning an empty catalogue', async () => {
    const fake = new FakeFinnhub()
    fake.symbols = { error: 'unexpected' }
    const connector = new FinnhubDataConnector({
      baseUrl: 'https://finnhub.example.test/v1', fetchImpl: fake.fetch, clock: () => FX_NOW, env: { FINNHUB_API_KEY: TEST_KEY },
    })
    await expect(connector.start()).rejects.toMatchObject({ problem: { name: 'VENUE_UNAVAILABLE', retryable: true } })
  })
})
