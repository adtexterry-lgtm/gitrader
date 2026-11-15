// SPDX-License-Identifier: CPAL-1.0
// 行情读取：quote 只读缓存、bookTicker 写入、盘口深度解析、premiumIndex 的资金费率与标记价。
import { describe, expect, it } from 'vitest'
import { BinanceDataConnector } from '../src/connector'
import { FakeBinance, FX_NOW } from './helpers/fake-binance'

function make() {
  const fake = new FakeBinance()
  const t = { now: FX_NOW }
  const connector = new BinanceDataConnector({ baseUrl: 'https://fapi.example.test', fetchImpl: fake.fetch, clock: () => t.now })
  return { fake, t, connector }
}

describe('quote', () => {
  it('quote() is undefined until refreshQuote() has run, then serves the cached bid/ask', async () => {
    const { fake, connector } = make()
    expect(connector.quote('binance:BTCUSDT')).toBeUndefined()

    const quote = await connector.refreshQuote('binance:BTCUSDT')
    expect(quote).toEqual({
      instrumentId: 'binance:BTCUSDT', ts: FX_NOW, bid: 100.1, ask: 100.2, stale: false, ageMs: 0,
    })
    expect(fake.callsTo('/fapi/v1/ticker/bookTicker')).toHaveLength(1)
    expect(fake.callsTo('/fapi/v1/ticker/bookTicker')[0]!.params.get('symbol')).toBe('BTCUSDT')
    expect(connector.quote('binance:BTCUSDT')).toEqual(quote)
  })

  it('marks a cached quote stale once it ages past staleMs, without refetching', async () => {
    const { fake, t, connector } = make()
    await connector.refreshQuote('binance:BTCUSDT')
    t.now += 11_000
    const stale = connector.quote('binance:BTCUSDT')!
    expect(stale).toMatchObject({ stale: true, ageMs: 11_000, bid: 100.1, ask: 100.2 })
    expect(fake.callsTo('/fapi/v1/ticker/bookTicker')).toHaveLength(1)
  })

  it('returns undefined when the venue sends no usable bid/ask', async () => {
    const { fake, connector } = make()
    fake.bookTicker = { symbol: 'BTCUSDT', bidPrice: '0', askPrice: '', time: FX_NOW }
    await expect(connector.refreshQuote('binance:BTCUSDT')).resolves.toBeUndefined()
    expect(connector.quote('binance:BTCUSDT')).toBeUndefined()
  })

  it('refuses instrument ids that belong to another venue', async () => {
    const { fake, connector } = make()
    await expect(connector.refreshQuote('hyperliquid:BTC')).rejects.toMatchObject({ problem: { name: 'INVALID_PARAMS' } })
    expect(fake.calls).toHaveLength(0)
  })
})

describe('book', () => {
  it('parses depth into descending bids and ascending asks, truncated to the requested depth', async () => {
    const { fake, connector } = make()
    const book = await connector.book('binance:BTCUSDT', 2)

    expect(book.instrumentId).toBe('binance:BTCUSDT')
    expect(book.ts).toBe(FX_NOW)
    expect(book.bids).toEqual([{ price: 100, size: 1.5 }, { price: 99.9, size: 2.5 }])
    expect(book.asks).toEqual([{ price: 100.1, size: 1.5 }, { price: 100.2, size: 0.5 }])
    expect(fake.callsTo('/fapi/v1/depth')[0]!.params.get('limit')).toBe('5') // 官方只允许 5/10/20/50/100/500/1000
  })

  it('defaults to the 20-level bucket', async () => {
    const { fake, connector } = make()
    await connector.book('binance:BTCUSDT')
    expect(fake.callsTo('/fapi/v1/depth')[0]!.params.get('limit')).toBe('20')
  })
})

describe('context', () => {
  it('carries mark price, index price, funding rate and the 8h funding interval', async () => {
    const { fake, connector } = make()
    const context = await connector.context('binance:BTCUSDT')

    expect(context).toMatchObject({
      instrumentId: 'binance:BTCUSDT', ts: FX_NOW, markPrice: 100.05, oraclePrice: 100, fundingRate: 0.0001, fundingIntervalMs: 28_800_000,
    })
    expect(fake.callsTo('/fapi/v1/premiumIndex')[0]!.params.get('symbol')).toBe('BTCUSDT')
  })
})
