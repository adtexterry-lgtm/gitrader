// SPDX-License-Identifier: CPAL-1.0
// 报价 / 盘口 / context / 市场状态：/quote 的 close 口径、bid = ask = last 的约定、
// 没有盘口端点时的老实拒绝、/market_state 的解析。
import { describe, expect, it } from 'vitest'
import { TwelveDataDataConnector } from '../src/connector'
import { FakeTwelveData, FX_NOW } from './helpers/fake-twelvedata'

function make(o: Record<string, unknown> = {}) {
  const fake = new FakeTwelveData()
  const connector = new TwelveDataDataConnector({
    baseUrl: 'https://twelvedata.example.test', fetchImpl: fake.fetch, clock: () => FX_NOW,
    env: { TWELVEDATA_API_KEY: 'test-twelvedata-key' }, ...o,
  })
  return { fake, connector }
}

describe('quotes', () => {
  it('quote() is cache-only before the first refresh', () => {
    const { fake, connector } = make()
    expect(connector.quote('twelvedata:AAPL')).toBeUndefined()
    expect(fake.calls).toHaveLength(0)
  })

  it('refreshQuote() reads /quote and keeps the documented last-price basis (bid = ask = last)', async () => {
    const { fake, connector } = make()
    const quote = await connector.refreshQuote('twelvedata:AAPL')
    expect(quote).toMatchObject({
      instrumentId: 'twelvedata:AAPL', ts: FX_NOW, bid: 188.5, ask: 188.5, last: 188.5, stale: false, ageMs: 0,
    })
    expect(fake.callsTo('/quote')[0]!.params.get('symbol')).toBe('AAPL')
  })

  it('flags a cached quote as stale once the injected clock passes the threshold', async () => {
    let now = FX_NOW
    const { connector } = make({ clock: () => now })
    await connector.refreshQuote('twelvedata:AAPL')
    now += 30_000
    const quote = connector.quote('twelvedata:AAPL')!
    expect(quote).toMatchObject({ stale: true, ageMs: 30_000 })
  })

  it('drops the cached quote when the vendor reports no close price', async () => {
    const { fake, connector } = make()
    await connector.refreshQuote('twelvedata:AAPL')
    fake.quote = { symbol: 'AAPL', close: '0', previous_close: '187.00', timestamp: FX_NOW / 1000 }
    await expect(connector.refreshQuote('twelvedata:AAPL')).resolves.toBeUndefined()
    expect(connector.quote('twelvedata:AAPL')).toBeUndefined()
  })
})

describe('order book', () => {
  it('book() refuses with CAPABILITY_UNSUPPORTED and never calls HTTP', async () => {
    const { fake, connector } = make()
    await expect(connector.book('twelvedata:AAPL')).rejects.toMatchObject({
      problem: { name: 'CAPABILITY_UNSUPPORTED', retryable: false, message: 'twelvedata data connector has no order book (REST quotes carry no bid/ask)' },
    })
    expect(fake.calls).toHaveLength(0)
  })
})

describe('context', () => {
  it('uses the last close as mark price and the previous close as prevDayPrice', async () => {
    const { connector } = make()
    const context = await connector.context('twelvedata:AAPL')
    expect(context).toMatchObject({ instrumentId: 'twelvedata:AAPL', markPrice: 188.5, prevDayPrice: 187 })
    expect(context.midPrice).toBeUndefined()
  })
})

describe('market state', () => {
  it('parses /market_state into the authoritative open/closed state with countdowns', async () => {
    const { fake, connector } = make()
    const state = await connector.marketState()
    expect(state).toEqual({
      exchange: 'NASDAQ',
      isOpen: true,
      timeToOpen: '00:00:00',
      timeToClose: '04:36:15',
      timeAfterOpen: '01:23:45',
    })
    expect(fake.callsTo('/market_state')[0]!.params.get('exchange')).toBe('NASDAQ')
  })

  it('treats a non-boolean is_market_open as closed rather than guessing', async () => {
    const { fake, connector } = make()
    fake.marketState = [{ name: 'NASDAQ', code: 'NASDAQ', is_market_open: 'yes' }]
    const state = await connector.marketState()
    expect(state.isOpen).toBe(false)
    expect(state.timeToClose).toBeNull()
  })

  it('matches the requested exchange inside the top-level array and reports its own open state', async () => {
    const { fake, connector } = make({ exchange: 'NYSE' })
    const state = await connector.marketState()
    expect(state.exchange).toBe('NYSE')
    expect(state.isOpen).toBe(false)
    expect(fake.callsTo('/market_state')[0]!.params.get('exchange')).toBe('NYSE')
  })

  it('rejects a non-array payload with a retryable VENUE_UNAVAILABLE', async () => {
    const { fake, connector } = make()
    fake.marketState = { name: 'NASDAQ', code: 'NASDAQ', is_market_open: true }
    await expect(connector.marketState()).rejects.toMatchObject({
      problem: { name: 'VENUE_UNAVAILABLE', retryable: true },
    })
  })

  it('rejects with INVALID_PARAMS when the array has no entry for the exchange', async () => {
    const { fake, connector } = make()
    fake.marketState = [{ name: 'NYSE', code: 'NYSE', is_market_open: false }]
    await expect(connector.marketState()).rejects.toMatchObject({
      problem: { name: 'INVALID_PARAMS', retryable: false, message: expect.stringContaining('NASDAQ') },
    })
  })
})
