// SPDX-License-Identifier: CPAL-1.0
// 标的清单：/stocks 一次拉取并缓存、Instrument 字段映射（marketGroup 记交易所）、坏行跳过、exchange 参数。
import { describe, expect, it } from 'vitest'
import { TwelveDataDataConnector } from '../src/connector'
import { FakeTwelveData, FX_NOW, TEST_KEY, stockRow } from './helpers/fake-twelvedata'

function make(o: Record<string, unknown> = {}) {
  const fake = new FakeTwelveData()
  const connector = new TwelveDataDataConnector({
    baseUrl: 'https://twelvedata.example.test', fetchImpl: fake.fetch, clock: () => FX_NOW,
    env: { TWELVEDATA_API_KEY: TEST_KEY }, ...o,
  })
  return { fake, connector }
}

describe('instrument catalogue', () => {
  it('start() pulls /stocks once and maps the native symbol to twelvedata:<symbol>', async () => {
    const { fake, connector } = make()
    expect(connector.listInstruments()).toEqual([])

    await connector.start()
    await connector.start()
    expect(fake.callsTo('/stocks')).toHaveLength(1)

    expect(connector.listInstruments().map((i) => i.instrumentId)).toEqual(['twelvedata:AAPL', 'twelvedata:MSFT'])
    expect(connector.getInstrument('twelvedata:NOPE')).toBeUndefined()
  })

  it('maps an equity row onto the protocol Instrument shape', async () => {
    const { connector } = make()
    await connector.start()
    expect(connector.getInstrument('twelvedata:AAPL')).toMatchObject({
      instrumentId: 'twelvedata:AAPL', venue: 'twelvedata', symbol: 'AAPL', displaySymbol: 'AAPL', kind: 'spot',
      base: 'AAPL', quote: 'USD', settle: 'USD', settlement: 'linear', contractSize: '1', venueSizeUnit: 'base',
      assetClass: 'stocks', marketGroup: 'NASDAQ', status: 'trading',
      price: { maxDecimals: 4 }, size: { step: '1', decimals: 0, min: '1' },
      underlying: { description: 'Apple Inc.', synthetic: false },
      orderTypes: [], tif: [], triggerPriceTypes: [], updatedAt: FX_NOW,
      sessions: {
        tz: 'America/New_York',
        windows: [{ days: [1, 2, 3, 4, 5], from: '09:30', to: '16:00', quality: 'regular' }],
      },
    })
  })

  it('keeps non-US symbols and currencies as the vendor writes them, and skips rows without a symbol', async () => {
    const fake = new FakeTwelveData()
    fake.stocks = {
      status: 'ok',
      data: [
        stockRow({ symbol: '0700', name: 'Tencent Holdings Ltd', currency: 'HKD', exchange: 'HKEX', mic_code: 'XHKG' }),
        stockRow({ symbol: '', name: 'broken row' }),
        { name: 'no symbol field' },
        null,
      ],
    }
    const connector = new TwelveDataDataConnector({
      baseUrl: 'https://twelvedata.example.test', fetchImpl: fake.fetch, clock: () => FX_NOW, env: { TWELVEDATA_API_KEY: TEST_KEY },
    })
    await connector.start()
    const ids = connector.listInstruments().map((i) => i.instrumentId)
    expect(ids).toEqual(['twelvedata:0700'])
    expect(connector.getInstrument('twelvedata:0700')).toMatchObject({ quote: 'HKD', marketGroup: 'HKEX' })
  })

  it('sends the configured exchange (default NASDAQ) and upper-cases overrides', async () => {
    const { fake, connector } = make()
    await connector.start()
    expect(fake.callsTo('/stocks')[0]!.params.get('exchange')).toBe('NASDAQ')

    const lse = make({ exchange: 'lse' })
    await lse.connector.start()
    expect(lse.fake.callsTo('/stocks')[0]!.params.get('exchange')).toBe('LSE')
  })

  it('rejects a payload without a data array instead of silently returning an empty catalogue', async () => {
    const fake = new FakeTwelveData()
    fake.stocks = { status: 'ok' }
    const connector = new TwelveDataDataConnector({
      baseUrl: 'https://twelvedata.example.test', fetchImpl: fake.fetch, clock: () => FX_NOW, env: { TWELVEDATA_API_KEY: TEST_KEY },
    })
    await expect(connector.start()).rejects.toMatchObject({ problem: { name: 'VENUE_UNAVAILABLE', retryable: true } })
  })
})
