// SPDX-License-Identifier: CPAL-1.0
// 行情读取：quote 只读缓存、ticker 写入（时间取最近成交）、盘口结构解析与深度上限、现货 context 以最新成交价代标记价。
import { describe, expect, it } from 'vitest'
import { CoinbaseDataConnector } from '../src/connector'
import { FakeCoinbase, FX_BOOK_TIME, FX_NOW, FX_TRADE_TIME } from './helpers/fake-coinbase'

const TICKER_PATH = '/api/v3/brokerage/market/products/BTC-USD/ticker'
const BOOK_PATH = '/api/v3/brokerage/market/product_book'
const TRADE_TS = Date.parse(FX_TRADE_TIME.replace(/(\.\d{3})\d+/, '$1'))
const BOOK_TS = Date.parse(FX_BOOK_TIME.replace(/(\.\d{3})\d+/, '$1'))

function make() {
  const fake = new FakeCoinbase()
  const t = { now: FX_NOW }
  const connector = new CoinbaseDataConnector({
    baseUrl: 'http://coinbase.example.test', fetchImpl: fake.fetch, clock: () => t.now,
  })
  return { fake, t, connector }
}

describe('quote', () => {
  it('quote() is undefined until refreshQuote() has run, then serves cached bid/ask/last', async () => {
    const { fake, connector } = make()
    expect(connector.quote('coinbase:BTC-USD')).toBeUndefined()

    const quote = await connector.refreshQuote('coinbase:BTC-USD')
    expect(quote).toEqual({
      instrumentId: 'coinbase:BTC-USD', ts: TRADE_TS, bid: 82363.57, ask: 82363.58, last: 82363.33,
      stale: false, ageMs: FX_NOW - TRADE_TS,
    })
    const calls = fake.callsTo(TICKER_PATH)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.params.get('limit')).toBe('1')
    expect(connector.quote('coinbase:BTC-USD')).toEqual(quote)
  })

  it('marks a cached quote stale once it ages past staleMs, without refetching', async () => {
    const { fake, t, connector } = make()
    await connector.refreshQuote('coinbase:BTC-USD')
    t.now += 11_000
    const stale = connector.quote('coinbase:BTC-USD')!
    expect(stale).toMatchObject({ stale: true, ageMs: FX_NOW - TRADE_TS + 11_000, bid: 82363.57, ask: 82363.58 })
    expect(fake.callsTo(TICKER_PATH)).toHaveLength(1)
  })

  it('returns undefined when the venue sends no usable bid/ask', async () => {
    const { fake, connector } = make()
    fake.ticker = { best_bid: '', best_ask: '0', trades: [] }
    await expect(connector.refreshQuote('coinbase:BTC-USD')).resolves.toBeUndefined()
    expect(connector.quote('coinbase:BTC-USD')).toBeUndefined()
  })

  it('falls back to the clock when the ticker carries no trade timestamp', async () => {
    const { fake, connector } = make()
    fake.ticker = { best_bid: '100.1', best_ask: '100.2', trades: [] }
    const quote = await connector.refreshQuote('coinbase:BTC-USD')
    expect(quote).toMatchObject({ ts: FX_NOW, bid: 100.1, ask: 100.2, stale: false, ageMs: 0 })
    expect(quote?.last).toBeUndefined()
  })

  it('refuses instrument ids that belong to another venue', async () => {
    const { fake, connector } = make()
    await expect(connector.refreshQuote('okx:BTC-USDT')).rejects.toMatchObject({ problem: { name: 'INVALID_PARAMS' } })
    expect(fake.calls).toHaveLength(0)
  })
})

describe('book', () => {
  it('parses pricebook bids descending / asks ascending, truncated to the requested depth', async () => {
    const { fake, connector } = make()
    const book = await connector.book('coinbase:BTC-USD', 2)

    expect(book.instrumentId).toBe('coinbase:BTC-USD')
    expect(book.ts).toBe(BOOK_TS)
    expect(book.bids).toEqual([{ price: 82367.97, size: 0.01273918 }, { price: 82366.32, size: 0.02428176 }])
    expect(book.asks).toEqual([{ price: 82367.98, size: 0.0045385 }, { price: 82368.6, size: 0.04 }])

    const call = fake.callsTo(BOOK_PATH)[0]!
    expect(call.params.get('product_id')).toBe('BTC-USD')
    expect(call.params.get('limit')).toBe('2')
  })

  it('defaults to 20 levels and clamps the requested depth to the 250 upper bound', async () => {
    const { fake, connector } = make()
    await connector.book('coinbase:BTC-USD')
    await connector.book('coinbase:BTC-USD', 5000)
    const limits = fake.callsTo(BOOK_PATH).map((c) => c.params.get('limit'))
    expect(limits).toEqual(['20', '250'])
  })

  it('ignores malformed levels and falls back to the clock when pricebook.time is missing', async () => {
    const { fake, connector } = make()
    fake.book = { pricebook: { bids: [{ price: '0', size: '1' }, { price: '99.5', size: '' }], asks: [{ price: '100.5', size: '2' }] } }
    const book = await connector.book('coinbase:BTC-USD', 5)
    expect(book.bids).toEqual([])
    expect(book.asks).toEqual([{ price: 100.5, size: 2 }])
    expect(book.ts).toBe(FX_NOW)
  })
})

describe('context', () => {
  it('refreshes once and marks the latest trade price', async () => {
    const { fake, connector } = make()
    const context = await connector.context('coinbase:BTC-USD')

    expect(context).toEqual({
      instrumentId: 'coinbase:BTC-USD', ts: FX_NOW, markPrice: 82363.33, midPrice: (82363.57 + 82363.58) / 2,
    })
    expect(context.fundingRate).toBeUndefined()
    expect(context.fundingIntervalMs).toBeUndefined()
    expect(fake.callsTo(TICKER_PATH)).toHaveLength(1)
  })

  it('marks the cached latest trade price and adds a local midPrice without refetching', async () => {
    const { fake, connector } = make()
    await connector.refreshQuote('coinbase:BTC-USD')
    const context = await connector.context('coinbase:BTC-USD')
    expect(context.markPrice).toBe(82363.33)
    expect(context.midPrice).toBe((82363.57 + 82363.58) / 2)
    expect(fake.calls).toHaveLength(1)
  })

  it('throws a retryable VENUE_UNAVAILABLE when no usable quote is available', async () => {
    const { fake, connector } = make()
    fake.ticker = { best_bid: '', best_ask: '0', trades: [] }
    await expect(connector.context('coinbase:BTC-USD')).rejects.toMatchObject({
      problem: { name: 'VENUE_UNAVAILABLE', retryable: true },
    })
    expect(fake.callsTo(TICKER_PATH)).toHaveLength(1)
  })

  it('rejects foreign instrument ids', async () => {
    const { connector } = make()
    await expect(connector.context('binance:BTCUSDT')).rejects.toMatchObject({ problem: { name: 'INVALID_PARAMS' } })
  })
})
