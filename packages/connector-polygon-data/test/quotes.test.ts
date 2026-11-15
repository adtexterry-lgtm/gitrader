// SPDX-License-Identifier: CPAL-1.0
// 报价 / 盘口 / context：快照的纳秒时间戳折毫秒（手算期望值）、NBBO 一档盘口、昨收与当日成交额、
// 没有 bid/ask 时不造报价、quote 只读缓存与陈旧标记。
import { describe, expect, it } from 'vitest'
import { PolygonDataConnector } from '../src/connector'
import { API_KEY, FX_NOW, FakePolygon, HOST, SNAPSHOT } from './helpers/fake-polygon'

const ID = 'polygon:AAPL'

function make(o: Record<string, unknown> = {}): { fake: FakePolygon; connector: PolygonDataConnector } {
  const fake = new FakePolygon()
  const connector = new PolygonDataConnector({
    apiKey: API_KEY,
    baseUrl: `http://${HOST}`,
    fetchImpl: fake.fetch,
    clock: () => FX_NOW,
    ...o,
  })
  return { fake, connector }
}

describe('quotes', () => {
  it('returns undefined before any refresh and never touches the network', () => {
    const { fake, connector } = make()
    expect(connector.quote(ID)).toBeUndefined()
    expect(connector.quoteDetail(ID)).toBeUndefined()
    expect(fake.calls).toHaveLength(0)
  })

  it('maps the snapshot NBBO into a stamped quote with the nanosecond timestamp folded to ms', async () => {
    const { fake, connector } = make()
    const quote = await connector.refreshQuote(ID)

    expect(fake.callsTo('/v2/snapshot/locale/us/markets/stocks/tickers/AAPL')).toHaveLength(1)
    // lastQuote.t = 2026-10-21T13:59:58Z（纳秒 ÷ 1e6）；ageMs 按本地拉取时刻（注入的 clock）算，刚拉完为 0
    expect(quote).toEqual({
      instrumentId: ID, ts: Date.parse('2026-10-21T13:59:58Z'), bid: 202.5, ask: 202.55, last: 202.52,
      stale: false, ageMs: 0,
    })
    expect(connector.quoteDetail(ID)).toEqual({
      ts: Date.parse('2026-10-21T13:59:58Z'), bid: 202.5, ask: 202.55, bidSize: 2, askSize: 3, last: 202.52,
      prevClose: 201.05, dayVolume: 5_000_000, dayVwap: 201.8,
    })
  })

  it('marks the cached quote stale once the clock moves past the threshold', async () => {
    let now = FX_NOW
    const { connector } = make({ clock: () => now })
    await connector.refreshQuote(ID)
    now = FX_NOW + 10_001
    expect(connector.quote(ID)).toMatchObject({ stale: true, ageMs: 10_001 })
  })

  it('returns undefined and clears the cache when the snapshot has no usable bid/ask', async () => {
    const { fake, connector } = make()
    await connector.refreshQuote(ID)
    fake.snapshot = { status: 'OK', ticker: { ticker: 'AAPL', updated: 1792468800000000000, lastTrade: { p: 202.52 } } }
    expect(await connector.refreshQuote(ID)).toBeUndefined()
    expect(connector.quote(ID)).toBeUndefined()
  })

  it('serves a single real NBBO level as the book instead of inventing depth', async () => {
    const { connector } = make()
    const book = await connector.book(ID, 10)
    expect(book).toEqual({
      instrumentId: ID,
      ts: Date.parse('2026-10-21T13:59:58Z'),
      bids: [{ price: 202.5, size: 2 }],
      asks: [{ price: 202.55, size: 3 }],
    })
  })

  it('leaves a side empty when the snapshot carries no size for it', async () => {
    const { fake, connector } = make()
    fake.snapshot = {
      status: 'OK',
      ticker: {
        ticker: 'AAPL',
        updated: Date.parse('2026-10-21T13:59:59Z') * 1e6,
        lastQuote: { p: 202.5, P: 202.55, t: Date.parse('2026-10-21T13:59:58Z') * 1e6 },
      },
    }
    const book = await connector.book(ID)
    expect(book.bids).toEqual([])
    expect(book.asks).toEqual([])
    expect(book.bids.length + book.asks.length).toBe(0)
  })

  it('builds context from the last trade, the previous close and the day notional', async () => {
    const { connector } = make()
    const context = await connector.context(ID)
    expect(context).toEqual({
      instrumentId: ID,
      ts: FX_NOW,
      markPrice: 202.52,
      midPrice: 202.525,
      prevDayPrice: 201.05,
      dayNotionalVolume: 5_000_000 * 201.8,
    })
    expect(context.fundingRate).toBeUndefined()
    expect(context.openInterest).toBeUndefined()
  })

  it('falls back to the mid price for markPrice when there is no last trade', async () => {
    const { fake, connector } = make()
    fake.snapshot = {
      ...(SNAPSHOT as Record<string, unknown>),
      ticker: {
        ticker: 'AAPL',
        updated: Date.parse('2026-10-21T13:59:59Z') * 1e6,
        lastQuote: { p: 202.5, P: 202.55, s: 2, S: 3, t: Date.parse('2026-10-21T13:59:58Z') * 1e6 },
      },
    }
    const context = await connector.context(ID)
    expect(context.markPrice).toBe(202.525)
    expect(context.prevDayPrice).toBeUndefined()
  })

  it('reports a failed context when the snapshot has no quote at all', async () => {
    const { fake, connector } = make()
    fake.snapshot = { status: 'OK', ticker: { ticker: 'AAPL', updated: 0 } }
    await expect(connector.context(ID)).rejects.toThrow(/has no quote for context/)
  })
})
