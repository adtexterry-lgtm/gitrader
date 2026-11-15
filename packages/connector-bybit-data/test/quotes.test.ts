// SPDX-License-Identifier: CPAL-1.0
// 行情读取：quote 只读缓存、tickers 写入、盘口 b/a 解析与 500 上限、标记价 + 资金费上下文（单次 tickers 请求）。
import { describe, expect, it } from 'vitest'
import { BybitDataConnector } from '../src/connector'
import { FakeBybit, FX_NOW } from './helpers/fake-bybit'

function make() {
  const fake = new FakeBybit()
  const t = { now: FX_NOW }
  const connector = new BybitDataConnector({ baseUrl: 'http://bybit.example.test', fetchImpl: fake.fetch, clock: () => t.now })
  return { fake, t, connector }
}

describe('quote', () => {
  it('quote() is undefined until refreshQuote() has run, then serves the cached bid/ask/last', async () => {
    const { fake, connector } = make()
    expect(connector.quote('bybit:BTCUSDT')).toBeUndefined()

    const quote = await connector.refreshQuote('bybit:BTCUSDT')
    expect(quote).toEqual({
      instrumentId: 'bybit:BTCUSDT', ts: FX_NOW, bid: 82428.5, ask: 82428.6, last: 82429.1, stale: false, ageMs: 0,
    })
    const calls = fake.callsTo('/v5/market/tickers')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.params.get('category')).toBe('linear')
    expect(calls[0]!.params.get('symbol')).toBe('BTCUSDT')
    expect(connector.quote('bybit:BTCUSDT')).toEqual(quote)
  })

  it('marks a cached quote stale once it ages past staleMs, without refetching', async () => {
    const { fake, t, connector } = make()
    await connector.refreshQuote('bybit:BTCUSDT')
    t.now += 11_000
    const stale = connector.quote('bybit:BTCUSDT')!
    expect(stale).toMatchObject({ stale: true, ageMs: 11_000, bid: 82428.5, ask: 82428.6 })
    expect(fake.callsTo('/v5/market/tickers')).toHaveLength(1)
  })

  it('returns undefined when the venue sends no usable bid/ask', async () => {
    const { fake, connector } = make()
    fake.tickers.BTCUSDT = { symbol: 'BTCUSDT', lastPrice: '82429.10', markPrice: '82440.94', bid1Price: '0', ask1Price: '' }
    await expect(connector.refreshQuote('bybit:BTCUSDT')).resolves.toBeUndefined()
    expect(connector.quote('bybit:BTCUSDT')).toBeUndefined()
    // 标记价不受影响
    await expect(connector.context('bybit:BTCUSDT')).resolves.toMatchObject({ markPrice: 82440.94 })
  })

  it('refuses instrument ids that belong to another venue', async () => {
    const { fake, connector } = make()
    await expect(connector.refreshQuote('binance:BTCUSDT')).rejects.toMatchObject({ problem: { name: 'INVALID_PARAMS' } })
    expect(fake.calls).toHaveLength(0)
  })
})

describe('book', () => {
  it('parses b/a into bids descending / asks ascending, truncated to the requested depth', async () => {
    const { fake, connector } = make()
    const book = await connector.book('bybit:BTCUSDT', 2)

    expect(book.instrumentId).toBe('bybit:BTCUSDT')
    expect(book.ts).toBe(1_792_510_147_359)
    expect(book.bids).toEqual([{ price: 82428.5, size: 3.688 }, { price: 82428.4, size: 0.001 }])
    expect(book.asks).toEqual([{ price: 82428.6, size: 4.978 }, { price: 82428.7, size: 0.002 }])
    const call = fake.callsTo('/v5/market/orderbook')[0]!
    expect(call.params.get('category')).toBe('linear')
    expect(call.params.get('symbol')).toBe('BTCUSDT')
    expect(call.params.get('limit')).toBe('2')
  })

  it('sorts unsorted levels and defaults to 20 / clamps to 500', async () => {
    const { fake, connector } = make()
    fake.books.BTCUSDT = {
      s: 'BTCUSDT',
      b: [['100.0', '1'], ['101.0', '2'], ['99.0', '3']],
      a: [['102.0', '1'], ['101.5', '2']],
      ts: FX_NOW,
    }
    const book = await connector.book('bybit:BTCUSDT')
    expect(book.bids.map((l) => l.price)).toEqual([101, 100, 99])
    expect(book.asks.map((l) => l.price)).toEqual([101.5, 102])

    await connector.book('bybit:BTCUSDT', 5000)
    expect(fake.callsTo('/v5/market/orderbook').map((c) => c.params.get('limit'))).toEqual(['20', '500'])
  })
})

describe('context', () => {
  it('reads mark price / funding rate / open interest from one tickers call', async () => {
    const { fake, connector } = make()
    await connector.start()
    const context = await connector.context('bybit:BTCUSDT')

    expect(context).toMatchObject({
      instrumentId: 'bybit:BTCUSDT', ts: FX_NOW, markPrice: 82440.94, fundingRate: 0.00004899,
      fundingIntervalMs: 28_800_000, openInterest: 58828.846,
    })
    const calls = fake.callsTo('/v5/market/tickers')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.params.get('symbol')).toBe('BTCUSDT')
  })

  it('uses the catalogue fundingInterval (minutes) instead of a hard-coded 8h', async () => {
    const fake = new FakeBybit()
    fake.instrumentPages = [
      {
        list: [{
          symbol: '0GUSDT', contractType: 'LinearPerpetual', status: 'Trading', baseCoin: '0G', quoteCoin: 'USDT',
          settleCoin: 'USDT', fundingInterval: 240, priceFilter: { tickSize: '0.0001' },
          lotSizeFilter: { qtyStep: '0.1', minOrderQty: '0.1', minNotionalValue: '5' },
        }],
        nextPageCursor: '',
      },
    ]
    fake.tickers['0GUSDT'] = { symbol: '0GUSDT', bid1Price: '0.4001', ask1Price: '0.4002', lastPrice: '0.4001', markPrice: '0.4002', fundingRate: '0.0001', openInterest: '1000' }
    const connector = new BybitDataConnector({ fetchImpl: fake.fetch, clock: () => FX_NOW })
    await connector.start()
    await expect(connector.context('bybit:0GUSDT')).resolves.toMatchObject({ fundingIntervalMs: 14_400_000 })
  })

  it('falls back to the 8h default for a symbol outside the catalogue', async () => {
    const { connector } = make()
    const context = await connector.context('bybit:BTCUSDT')
    expect(context.fundingIntervalMs).toBe(28_800_000)
    expect(context.openInterest).toBe(58828.846)
  })
})
