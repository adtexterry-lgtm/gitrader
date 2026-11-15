// SPDX-License-Identifier: CPAL-1.0
// 行情读取：tickers 一次拿全部并缓存（quote 只读缓存）、盘口升序→降序、深度截断、标记价 + 资金费率上下文。
import { describe, expect, it } from 'vitest'
import { KrakenDataConnector } from '../src/connector'
import { FakeKraken, FX_NOW, perpEntry } from './helpers/fake-kraken'

function make() {
  const fake = new FakeKraken()
  const t = { now: FX_NOW }
  const connector = new KrakenDataConnector({ baseUrl: 'http://kraken.example.test', fetchImpl: fake.fetch, clock: () => t.now })
  return { fake, t, connector }
}

describe('quote', () => {
  it('quote() is undefined until refreshQuote() has run, then serves the cached bid/ask/last', async () => {
    const { fake, connector } = make()
    expect(connector.quote('kraken:PF_XBTUSD')).toBeUndefined()

    const quote = await connector.refreshQuote('kraken:PF_XBTUSD')
    expect(quote).toEqual({
      instrumentId: 'kraken:PF_XBTUSD', ts: FX_NOW, bid: 82347, ask: 82348, last: 82350, stale: false, ageMs: 0,
    })
    expect(fake.callsTo('/derivatives/api/v3/tickers')).toHaveLength(1)
    expect(connector.quote('kraken:PF_XBTUSD')).toEqual(quote)
  })

  it('one tickers response caches every symbol, so a second instrument needs no extra request', async () => {
    const { fake, connector } = make()
    await connector.refreshQuote('kraken:PF_XBTUSD')

    const eth = connector.quote('kraken:PF_ETHUSD')
    expect(eth).toMatchObject({ instrumentId: 'kraken:PF_ETHUSD', bid: 2800.1, ask: 2801.5, last: 2800.9 })
    expect(fake.callsTo('/derivatives/api/v3/tickers')).toHaveLength(1)
  })

  it('marks a cached quote stale once it ages past staleMs, without refetching', async () => {
    const { fake, t, connector } = make()
    await connector.refreshQuote('kraken:PF_XBTUSD')
    t.now += 11_000
    expect(connector.quote('kraken:PF_XBTUSD')).toMatchObject({ stale: true, ageMs: 11_000, bid: 82347, ask: 82348 })
    expect(fake.callsTo('/derivatives/api/v3/tickers')).toHaveLength(1)
  })

  it('drops the cached quote when the venue sends no usable bid/ask', async () => {
    const { fake, connector } = make()
    await connector.refreshQuote('kraken:PF_XBTUSD')
    expect(connector.quote('kraken:PF_XBTUSD')).toBeDefined()

    fake.tickers = [{ symbol: 'PF_XBTUSD', last: 82350, bid: 0, ask: '', lastTime: '2026-10-20T15:28:02.175Z' }]
    await expect(connector.refreshQuote('kraken:PF_XBTUSD')).resolves.toBeUndefined()
    expect(connector.quote('kraken:PF_XBTUSD')).toBeUndefined()
  })

  it('refuses instrument ids that belong to another venue', async () => {
    const { fake, connector } = make()
    await expect(connector.refreshQuote('binance:BTCUSDT')).rejects.toMatchObject({ problem: { name: 'INVALID_PARAMS' } })
    expect(fake.calls).toHaveLength(0)
  })
})

describe('book', () => {
  it('turns the venue ascending bids into descending levels and truncates to the requested depth', async () => {
    const { fake, connector } = make()
    const book = await connector.book('kraken:PF_XBTUSD', 3)

    expect(book.instrumentId).toBe('kraken:PF_XBTUSD')
    expect(book.ts).toBe(FX_NOW)
    expect(book.bids).toEqual([
      { price: 82347, size: 0.0001 }, { price: 82346, size: 0.0003 }, { price: 82344, size: 0.0001 },
    ])
    expect(book.asks).toEqual([
      { price: 82348, size: 0.2666 }, { price: 82349, size: 0.023 }, { price: 82350, size: 0.056 },
    ])
    const call = fake.callsTo('/derivatives/api/v3/orderbook')[0]!
    expect(call.params.get('symbol')).toBe('PF_XBTUSD')
    // 上游不带 depth 参数
    expect(call.params.get('depth')).toBeNull()
  })

  it('defaults to 20 levels and keeps the venue payload intact below that depth', async () => {
    const { fake, connector } = make()
    const book = await connector.book('kraken:PF_XBTUSD')
    expect(book.bids).toHaveLength(8)
    expect(book.bids[0]!.price).toBe(82347)
    expect(book.asks).toHaveLength(6)
    expect(fake.callsTo('/derivatives/api/v3/orderbook')).toHaveLength(1)
  })

  it('converts contract sizes in the book to base quantity using contractSize', async () => {
    const fake = new FakeKraken()
    fake.instruments = [perpEntry({ symbol: 'PF_XBTUSD', contractSize: 10, base: 'BTC', quote: 'USD', pair: 'BTC:USD' })]
    const connector = new KrakenDataConnector({ fetchImpl: fake.fetch, clock: () => FX_NOW })
    await connector.start()

    const book = await connector.book('kraken:PF_XBTUSD', 3)
    expect(book.bids).toEqual([
      { price: 82347, size: 0.001 }, { price: 82346, size: 0.003 }, { price: 82344, size: 0.001 },
    ])
    expect(book.asks).toEqual([
      { price: 82348, size: 2.666 }, { price: 82349, size: 0.23 }, { price: 82350, size: 0.56 },
    ])
  })
})

describe('context', () => {
  it('reads mark price, funding rate, index price and open interest from the single tickers response', async () => {
    const { fake, connector } = make()
    const context = await connector.context('kraken:PF_XBTUSD')

    expect(context).toMatchObject({
      instrumentId: 'kraken:PF_XBTUSD', ts: FX_NOW, markPrice: 82369.55914941261,
      // ticker 的 fundingRate 是绝对额（quote / 张），相对费率 = 0.9490556512570277 / 82369.55914941261
      fundingRate: 0.000011521922188942485,
      fundingIntervalMs: 3_600_000, oraclePrice: 82363.54, openInterest: 2318.1385, midPrice: 82347.5,
    })
    expect(fake.callsTo('/derivatives/api/v3/tickers')).toHaveLength(1)
  })

  it('leaves the funding fields at protocol defaults when the symbol is not in the response', async () => {
    const { connector } = make()
    const context = await connector.context('kraken:PF_SOLUSD')
    expect(context.markPrice).toBe(0)
    expect(context.fundingRate).toBeUndefined()
    expect(context.oraclePrice).toBeUndefined()
    expect(context.fundingIntervalMs).toBe(3_600_000)
  })
})
