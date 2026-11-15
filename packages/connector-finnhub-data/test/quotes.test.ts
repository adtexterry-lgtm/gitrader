// SPDX-License-Identifier: CPAL-1.0
// 报价 / 盘口 / context / 市场状态：/quote 的 last 价口径、bid = ask = last 的约定、/stock/bidask 最优一档、
// /stock/market-status 与 /stock/market-holiday 的解析。
import { describe, expect, it } from 'vitest'
import { FinnhubDataConnector } from '../src/connector'
import { FakeFinnhub, FX_NOW } from './helpers/fake-finnhub'

function make(o: Record<string, unknown> = {}) {
  const fake = new FakeFinnhub()
  const connector = new FinnhubDataConnector({
    baseUrl: 'https://finnhub.example.test/v1', fetchImpl: fake.fetch, clock: () => FX_NOW,
    env: { FINNHUB_API_KEY: 'test-finnhub-key' }, ...o,
  })
  return { fake, connector }
}

describe('quotes', () => {
  it('quote() is cache-only before the first refresh', () => {
    const { fake, connector } = make()
    expect(connector.quote('finnhub:AAPL')).toBeUndefined()
    expect(fake.calls).toHaveLength(0)
  })

  it('refreshQuote() reads /quote and keeps the documented last-price basis (bid = ask = last)', async () => {
    const { fake, connector } = make()
    const quote = await connector.refreshQuote('finnhub:AAPL')

    expect(quote).toMatchObject({ instrumentId: 'finnhub:AAPL', ts: FX_NOW, bid: 100.5, ask: 100.5, last: 100.5, stale: false, ageMs: 0 })
    expect(fake.callsTo('/quote')[0]!.params.get('symbol')).toBe('AAPL')
    expect(connector.quote('finnhub:AAPL')).toEqual(quote)
  })

  it('flags a cached quote as stale once the injected clock passes the threshold', async () => {
    let now = FX_NOW
    const { connector } = make({ clock: () => now })
    await connector.refreshQuote('finnhub:AAPL')
    now += 30_000
    const quote = connector.quote('finnhub:AAPL')!
    expect(quote.stale).toBe(true)
    expect(quote.ageMs).toBe(30_000)
  })

  it('drops the cached quote when the upstream reports no trade (c = 0)', async () => {
    const { fake, connector } = make()
    await connector.refreshQuote('finnhub:AAPL')
    fake.quote = { c: 0, d: 0, dp: 0, h: 0, l: 0, o: 0, pc: 100, t: FX_NOW / 1000 }
    await expect(connector.refreshQuote('finnhub:AAPL')).resolves.toBeUndefined()
    expect(connector.quote('finnhub:AAPL')).toBeUndefined()
  })
})

describe('top of book', () => {
  it('book() maps /stock/bidask onto a single real level per side and ignores depth', async () => {
    const { fake, connector } = make()
    const book = await connector.book('finnhub:AAPL', 20)
    expect(book).toEqual({
      instrumentId: 'finnhub:AAPL',
      ts: FX_NOW,
      bids: [{ price: 100.1, size: 3 }],
      asks: [{ price: 100.2, size: 4 }],
    })
    expect(fake.callsTo('/stock/bidask')).toHaveLength(1)
  })

  it('book() fails with VENUE_UNAVAILABLE when the vendor returns no bid/ask', async () => {
    const { fake, connector } = make()
    fake.bidAsk = {}
    await expect(connector.book('finnhub:AAPL')).rejects.toMatchObject({
      problem: { name: 'VENUE_UNAVAILABLE', retryable: true },
    })
  })
})

describe('context', () => {
  it('uses the last trade as mark price and the previous close as prevDayPrice', async () => {
    const { connector } = make()
    const context = await connector.context('finnhub:AAPL')
    expect(context).toMatchObject({ instrumentId: 'finnhub:AAPL', markPrice: 100.5, prevDayPrice: 100 })
    expect(context.midPrice).toBeUndefined() // 没有真实买卖盘时不给中价
  })

  it('adds a mid price once a real bid/ask was cached', async () => {
    const { connector } = make()
    await connector.book('finnhub:AAPL')
    const context = await connector.context('finnhub:AAPL')
    expect(context.midPrice).toBeCloseTo(100.15, 10)
  })
})

describe('market status and holidays', () => {
  it('parses /stock/market-status into an authoritative open/closed state', async () => {
    const { fake, connector } = make()
    const state = await connector.marketStatus()
    expect(state).toEqual({
      exchange: 'US', isOpen: true, session: 'regular', ts: FX_NOW, holiday: null, timezone: 'America/New_York',
    })
    expect(fake.callsTo('/stock/market-status')[0]!.params.get('exchange')).toBe('US')
  })

  it('parses /stock/market-holiday rows (early close keeps its trading hour)', async () => {
    const { connector } = make()
    const rows = await connector.marketHolidays()
    expect(rows).toEqual([
      { date: '2026-11-27', event: 'Thanksgiving', tradingHour: '09:30-13:00' },
      { date: '2026-12-25', event: 'Christmas', tradingHour: null },
    ])
  })
})
