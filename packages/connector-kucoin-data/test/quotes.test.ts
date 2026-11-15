// SPDX-License-Identifier: CPAL-1.0
// 行情读取：quote 只读缓存（纳秒时间戳归一到毫秒）、ticker 写入、盘口 depth20/depth100 与「张 → 币」折算、
// 标记价 + 资金费率上下文。
import { describe, expect, it } from 'vitest'
import { KucoinDataConnector } from '../src/connector'
import { FakeKucoin, FX_NOW, MARK_TS } from './helpers/fake-kucoin'

function make() {
  const fake = new FakeKucoin()
  const t = { now: FX_NOW }
  const connector = new KucoinDataConnector({ baseUrl: 'http://kucoin.example.test', fetchImpl: fake.fetch, clock: () => t.now })
  return { fake, t, connector }
}

describe('quote', () => {
  it('quote() is undefined until refreshQuote() has run, then serves the cached bid/ask/last', async () => {
    const { fake, connector } = make()
    expect(connector.quote('kucoin:XBTUSDTM')).toBeUndefined()

    const quote = await connector.refreshQuote('kucoin:XBTUSDTM')
    expect(quote).toEqual({
      instrumentId: 'kucoin:XBTUSDTM', ts: FX_NOW, bid: 82_407.2, ask: 82_407.3, last: 82_401.6, stale: false, ageMs: 0,
    })
    const calls = fake.callsTo('/api/v1/ticker')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.params.get('symbol')).toBe('XBTUSDTM')
    // 缓存命中不再发请求
    expect(connector.quote('kucoin:XBTUSDTM')).toEqual(quote)
    expect(fake.callsTo('/api/v1/ticker')).toHaveLength(1)
  })

  it('marks a cached quote stale once it ages past staleMs, without refetching', async () => {
    const { fake, t, connector } = make()
    await connector.refreshQuote('kucoin:XBTUSDTM')
    t.now += 11_000
    expect(connector.quote('kucoin:XBTUSDTM')).toMatchObject({ stale: true, ageMs: 11_000, bid: 82_407.2, ask: 82_407.3 })
    expect(fake.callsTo('/api/v1/ticker')).toHaveLength(1)
  })

  it('returns undefined when the venue sends no usable bid/ask', async () => {
    const { fake, connector } = make()
    fake.ticker = { symbol: 'XBTUSDTM', price: '82401.6', bestBidPrice: null, bestAskPrice: '0', ts: 1_792_510_096_738_000_000 }
    await expect(connector.refreshQuote('kucoin:XBTUSDTM')).resolves.toBeUndefined()
    expect(connector.quote('kucoin:XBTUSDTM')).toBeUndefined()
  })

  it('refuses instrument ids that belong to another venue', async () => {
    const { fake, connector } = make()
    await expect(connector.refreshQuote('binance:BTCUSDT')).rejects.toMatchObject({ problem: { name: 'INVALID_PARAMS' } })
    expect(fake.calls).toHaveLength(0)
  })
})

describe('book', () => {
  it('parses depth20 bids descending / asks ascending and converts contracts to base units via multiplier', async () => {
    const { fake, connector } = make()
    await connector.start()
    const book = await connector.book('kucoin:XBTUSDTM', 3)

    expect(book.instrumentId).toBe('kucoin:XBTUSDTM')
    // 上游 ts 是纳秒，这里归一到毫秒
    expect(book.ts).toBe(1_792_510_112_015)
    expect(book.bids).toEqual([
      { price: 82_407.2, size: 0.9 }, { price: 82_405.7, size: 0.056 }, { price: 82_405.6, size: 0.059 },
    ])
    expect(book.asks).toEqual([
      { price: 82_407.3, size: 0.046 }, { price: 82_410.7, size: 0.002 }, { price: 82_410.8, size: 0.002 },
    ])
    const calls = fake.callsTo('/api/v1/level2/depth20')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.params.get('symbol')).toBe('XBTUSDTM')
  })

  it('truncates to the requested depth, defaults to 20, and switches to depth100 above 20 levels', async () => {
    const { fake, connector } = make()
    await connector.start()
    const shallow = await connector.book('kucoin:XBTUSDTM', 2)
    expect(shallow.bids).toHaveLength(2)
    expect(shallow.asks).toHaveLength(2)
    expect(fake.callsTo('/api/v1/level2/depth20')).toHaveLength(1)

    await connector.book('kucoin:XBTUSDTM')
    expect(fake.callsTo('/api/v1/level2/depth20')).toHaveLength(2)

    const deep = await connector.book('kucoin:XBTUSDTM', 50)
    expect(fake.callsTo('/api/v1/level2/depth100')).toHaveLength(1)
    expect(deep.bids).toHaveLength(50)
    expect(deep.asks).toHaveLength(50)

    // 超过 100 档按 100 截断（depth100 端点上限）
    const capped = await connector.book('kucoin:XBTUSDTM', 5_000)
    expect(capped.bids).toHaveLength(100)
    expect(fake.callsTo('/api/v1/level2/depth100')).toHaveLength(2)
  })

  it('keeps raw contract sizes when the catalogue was never loaded (multiplier unknown → 1)', async () => {
    const { connector } = make()
    const book = await connector.book('kucoin:XBTUSDTM', 1)
    expect(book.bids[0]).toEqual({ price: 82_407.2, size: 900 })
  })
})

describe('context', () => {
  it('merges mark price (with index price) and the funding rate, keeping the venue funding interval', async () => {
    const { fake, connector } = make()
    const context = await connector.context('kucoin:XBTUSDTM')

    expect(context).toEqual({
      instrumentId: 'kucoin:XBTUSDTM', ts: MARK_TS, markPrice: 82_415.75, oraclePrice: 82_457.21,
      fundingRate: 0.000061, fundingIntervalMs: 28_800_000,
    })
    expect(fake.callsTo('/api/v1/mark-price/XBTUSDTM/current')).toHaveLength(1)
    expect(fake.callsTo('/api/v1/funding-rate/XBTUSDTM/current')).toHaveLength(1)
  })

  it('falls back to the 8h default and omits fundingRate when the venue payload is unusable', async () => {
    const { fake, connector } = make()
    fake.fundingRate = { symbol: '.XBTUSDTMFPI8H', granularity: '', timePoint: '', value: '' }
    const context = await connector.context('kucoin:XBTUSDTM')

    expect(context.fundingRate).toBeUndefined()
    expect(context.fundingIntervalMs).toBe(28_800_000)
    expect(context.markPrice).toBe(82_415.75)
  })
})
