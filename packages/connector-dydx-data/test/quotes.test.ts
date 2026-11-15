// SPDX-License-Identifier: CPAL-1.0
// 行情读取：quote 只读缓存（盘口最优档 + 最近成交）、盘口深度与截断、标记价 / 资金费率 / 持仓上下文。
import { describe, expect, it } from 'vitest'
import { DydxDataConnector } from '../src/connector'
import { FakeDydx, FX_NOW } from './helpers/fake-dydx'

const BASE = 'http://dydx.example.test'

function make() {
  const fake = new FakeDydx()
  const t = { now: FX_NOW }
  const connector = new DydxDataConnector({ baseUrl: BASE, fetchImpl: fake.fetch, clock: () => t.now })
  return { fake, t, connector }
}

describe('quote', () => {
  it('quote() is undefined until refreshQuote() runs, then serves best bid/ask from the book plus the last trade', async () => {
    const { fake, connector } = make()
    expect(connector.quote('dydx:BTC-USD')).toBeUndefined()

    const quote = await connector.refreshQuote('dydx:BTC-USD')
    expect(quote).toEqual({
      instrumentId: 'dydx:BTC-USD', ts: FX_NOW, bid: 82379, ask: 82400, last: 82350, stale: false, ageMs: 0,
    })
    const books = fake.callsOfKind('orderbook')
    const trades = fake.callsOfKind('trades')
    expect(books).toHaveLength(1)
    expect(books[0]!.path).toBe('/v4/orderbooks/perpetualMarket/BTC-USD')
    expect(trades).toHaveLength(1)
    expect(trades[0]!.path).toBe('/v4/trades/perpetualMarket/BTC-USD')
    expect(trades[0]!.params.get('limit')).toBe('1')
    expect(connector.quote('dydx:BTC-USD')).toEqual(quote)
  })

  it('marks a cached quote stale once it ages past staleMs, without refetching', async () => {
    const { fake, t, connector } = make()
    await connector.refreshQuote('dydx:BTC-USD')
    t.now += 11_000
    expect(connector.quote('dydx:BTC-USD')).toMatchObject({ stale: true, ageMs: 11_000, bid: 82379, ask: 82400 })
    expect(fake.callsOfKind('orderbook')).toHaveLength(1)
  })

  it('returns undefined when the book has no usable side, without asking for trades', async () => {
    const { fake, connector } = make()
    fake.orderbook = { bids: [{ price: '0', size: '1' }], asks: [] }
    await expect(connector.refreshQuote('dydx:BTC-USD')).resolves.toBeUndefined()
    expect(connector.quote('dydx:BTC-USD')).toBeUndefined()
    expect(fake.callsOfKind('trades')).toHaveLength(0)
  })

  it('keeps the quote and drops `last` when the trades endpoint is unavailable', async () => {
    const { fake, connector } = make()
    fake.override.set('trades', () => new Response('boom', { status: 500 }))
    const quote = await connector.refreshQuote('dydx:BTC-USD')
    expect(quote).toMatchObject({ bid: 82379, ask: 82400 })
    expect(quote !== undefined && 'last' in quote).toBe(false)
    // 盘口这次成功照常算数
    expect(fake.callsOfKind('orderbook')).toHaveLength(1)
  })

  it('refuses instrument ids that belong to another venue', async () => {
    const { fake, connector } = make()
    await expect(connector.refreshQuote('binance:BTCUSDT')).rejects.toMatchObject({ problem: { name: 'INVALID_PARAMS' } })
    await expect(connector.book('okx:BTC-USDT-SWAP')).rejects.toMatchObject({ problem: { name: 'INVALID_PARAMS' } })
    expect(fake.calls).toHaveLength(0)
  })
})

describe('book', () => {
  it('parses bids descending / asks ascending and truncates to the requested depth', async () => {
    const { fake, connector } = make()
    const book = await connector.book('dydx:BTC-USD', 2)

    expect(book.instrumentId).toBe('dydx:BTC-USD')
    expect(book.ts).toBe(FX_NOW)
    expect(book.bids).toEqual([{ price: 82379, size: 0.0606 }, { price: 82372, size: 0.183 }])
    expect(book.asks).toEqual([{ price: 82400, size: 0.0606 }, { price: 82419, size: 0.1213 }])
    expect(fake.callsOfKind('orderbook')[0]!.params.toString()).toBe('')
  })

  it('defaults to 20 levels and clamps the requested depth to the 500 upper bound', async () => {
    const { fake, connector } = make()
    const deep = await connector.book('dydx:BTC-USD', 5000)
    expect(deep.bids).toHaveLength(3)
    expect(deep.asks).toHaveLength(3)
    await connector.book('dydx:BTC-USD')
    expect(fake.callsOfKind('orderbook')).toHaveLength(2)
  })

  it('sorts a venue payload that arrives out of order', async () => {
    const { fake, connector } = make()
    fake.orderbook = {
      bids: [{ price: '100', size: '1' }, { price: '101', size: '2' }, { price: '99', size: '3' }],
      asks: [{ price: '103', size: '1' }, { price: '102', size: '2' }],
    }
    const book = await connector.book('dydx:BTC-USD', 5)
    expect(book.bids.map((b) => b.price)).toEqual([101, 100, 99])
    expect(book.asks.map((a) => a.price)).toEqual([102, 103])
  })
})

describe('context', () => {
  it('serves mark price / funding rate / open interest from the cached perpetualMarkets payload', async () => {
    const { fake, connector } = make()
    await connector.start()
    const context = await connector.context('dydx:BTC-USD')

    expect(context.instrumentId).toBe('dydx:BTC-USD')
    expect(context.ts).toBe(FX_NOW)
    expect(context.markPrice).toBe(82385.52)
    expect(context.oraclePrice).toBe(82385.52)
    expect(context.fundingRate).toBeCloseTo(0.00000027678571428571, 15)
    expect(context.fundingIntervalMs).toBe(3_600_000)
    expect(context.openInterest).toBe(204.5404)
    // context 不额外发请求
    expect(fake.calls).toHaveLength(1)
  })

  it('pulls the market list once when context() is called before start()', async () => {
    const { fake, connector } = make()
    const context = await connector.context('dydx:ETH-USD')
    expect(context.markPrice).toBe(2429.98)
    expect(context.fundingRate).toBeCloseTo(-0.00000163362068965517, 15)
    expect(fake.callsTo('/v4/perpetualMarkets')).toHaveLength(1)
  })

  it('leaves protocol defaults when the market carries no usable numbers', async () => {
    const fake = new FakeDydx()
    fake.markets = { markets: { 'BLANK-USD': { ticker: 'BLANK-USD', status: 'ACTIVE' } } }
    const connector = new DydxDataConnector({ baseUrl: BASE, fetchImpl: fake.fetch, clock: () => FX_NOW })
    const context = await connector.context('dydx:BLANK-USD')
    expect(context.markPrice).toBe(0)
    expect(context.fundingRate).toBeUndefined()
    expect(context.openInterest).toBeUndefined()
    expect(context.fundingIntervalMs).toBe(3_600_000)
  })
})
