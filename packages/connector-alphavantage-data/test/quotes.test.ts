// SPDX-License-Identifier: CPAL-1.0
// 报价：GLOBAL_QUOTE 解析（字段编号照官方文档）、quote 只读缓存、bid/ask = 最新价（免费档无盘口）、
// book() 明确拒绝而不是造档位、context 的昨收、陈旧标记。
import { describe, expect, it } from 'vitest'
import { AlphaVantageDataConnector } from '../src/connector'
import { API_KEY, FX_NOW, FakeAlphaVantage, HOST, respond } from './helpers/fake-alphavantage'

const ID = 'alphavantage:AAPL'

function make(o: Record<string, unknown> = {}): { fake: FakeAlphaVantage; connector: AlphaVantageDataConnector } {
  const fake = new FakeAlphaVantage()
  const connector = new AlphaVantageDataConnector({
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

  it('parses the documented Global Quote fields into a stamped quote', async () => {
    const { fake, connector } = make()
    const quote = await connector.refreshQuote(ID)

    expect(fake.callsOf('GLOBAL_QUOTE')[0]!.params.get('symbol')).toBe('AAPL')
    expect(quote).toEqual({
      instrumentId: ID, ts: FX_NOW, bid: 202.52, ask: 202.52, last: 202.52, stale: false, ageMs: 0,
    })
    expect(connector.quoteDetail(ID)).toEqual({
      symbol: 'AAPL', price: 202.52, open: 201, high: 203, low: 200.5, volume: 5_000_000, prevClose: 201.05,
      tradingDay: '2026-10-20',
    })
  })

  it('marks the cached quote stale once the clock moves past the threshold', async () => {
    let now = FX_NOW
    const { connector } = make({ clock: () => now })
    await connector.refreshQuote(ID)
    now = FX_NOW + 10_001
    expect(connector.quote(ID)).toMatchObject({ stale: true, ageMs: 10_001 })
  })

  it('clears the cache when the symbol comes back as an empty Global Quote', async () => {
    const { fake, connector } = make()
    await connector.refreshQuote(ID)
    fake.override.set('GLOBAL_QUOTE', () => respond({ 'Global Quote': {} }))
    expect(await connector.refreshQuote(ID)).toBeUndefined()
    expect(connector.quote(ID)).toBeUndefined()
  })

  it('refuses to fabricate an order book (free tier publishes no bid/ask)', async () => {
    const { fake, connector } = make()
    await expect(connector.book(ID, 5)).rejects.toThrow(/free tier publishes no bid\/ask/)
    expect(fake.calls).toHaveLength(0)
  })

  it('builds context from the last price plus the previous close, with no funding fields', async () => {
    const { connector } = make()
    const context = await connector.context(ID)
    expect(context).toEqual({
      instrumentId: ID, ts: FX_NOW, markPrice: 202.52, midPrice: 202.52, prevDayPrice: 201.05,
    })
    expect(context.fundingRate).toBeUndefined()
  })

  it('reports a failed context when the symbol has no usable price', async () => {
    const { fake, connector } = make()
    fake.override.set('GLOBAL_QUOTE', () => respond({ 'Global Quote': {} }))
    await expect(connector.context(ID)).rejects.toThrow(/has no price for context/)
  })
})
