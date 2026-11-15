// SPDX-License-Identifier: CPAL-1.0
// 速率：每次请求前 acquire(weight)（一请求一次、顺序在前），成功后 reportOk；429 → Retry-After 退避；
// 非 2xx / 200 带 error / 网络异常 → VENUE_UNAVAILABLE（retryable）。
import { describe, expect, it } from 'vitest'
import { CoinbaseDataConnector } from '../src/connector'
import { FakeCoinbase, FX_NOW, json } from './helpers/fake-coinbase'

const TICKER_PATH = '/api/v3/brokerage/market/products/BTC-USD/ticker'
const CANDLES_PATH = '/api/v3/brokerage/market/products/BTC-USD/candles'

describe('rate budget', () => {
  it('acquires the request weight before each HTTP call and reports success afterwards', async () => {
    const fake = new FakeCoinbase()
    const events: string[] = []
    const taken: number[] = []
    let used = 0
    let oks = 0
    const budget = {
      async acquire(weight: number) {
        taken.push(weight)
        used += weight
        events.push(`acquire:${weight}`)
      },
      charge() {},
      reportOk() {
        oks += 1
        events.push('ok')
      },
      penalize() {},
      usage: () => ({ used, target: 10, limit: 10, ratio: used / 10, windowMs: 1000, backoffUntil: 0 }),
    }
    const connector = new CoinbaseDataConnector({
      baseUrl: 'http://coinbase.example.test',
      fetchImpl: async (input, init) => {
        events.push('fetch')
        return fake.fetch(input, init)
      },
      budget,
      clock: () => FX_NOW,
    })

    await connector.start()
    await connector.candles('coinbase:BTC-USD', '1m', { n: 300 })
    await connector.book('coinbase:BTC-USD', 20)
    await connector.refreshQuote('coinbase:BTC-USD')

    expect(taken).toEqual([1, 1, 1, 1])
    expect(events).toEqual([
      'acquire:1', 'fetch', 'ok',
      'acquire:1', 'fetch', 'ok',
      'acquire:1', 'fetch', 'ok',
      'acquire:1', 'fetch', 'ok',
    ])
    expect(oks).toBe(4)
    expect(connector.status().rateBudget).toEqual({ used: 4, limit: 10, windowMs: 1000 })
  })

  it('defaults to an unlimited budget when none is injected', async () => {
    const fake = new FakeCoinbase()
    const connector = new CoinbaseDataConnector({ fetchImpl: fake.fetch, clock: () => FX_NOW })
    await connector.start()
    expect(connector.status().rateBudget).toEqual({ used: 0, limit: 10, windowMs: 1000 })
  })
})

describe('HTTP failures', () => {
  it('429 becomes VENUE_UNAVAILABLE with retryAfterMs and penalizes the budget', async () => {
    const fake = new FakeCoinbase()
    const penalties: Array<number | undefined> = []
    let oks = 0
    const budget = {
      async acquire() {},
      charge() {},
      reportOk() { oks += 1 },
      penalize(retryAfterMs?: number) { penalties.push(retryAfterMs) },
      usage: () => ({ used: 0, target: 10, limit: 10, ratio: 0, windowMs: 1000, backoffUntil: 0 }),
    }
    fake.override.set(TICKER_PATH, () => new Response('too many requests', { status: 429, headers: { 'retry-after': '3' } }))
    const connector = new CoinbaseDataConnector({ fetchImpl: fake.fetch, budget, clock: () => FX_NOW })

    await expect(connector.refreshQuote('coinbase:BTC-USD')).rejects.toMatchObject({
      problem: {
        name: 'VENUE_UNAVAILABLE', code: 3003, category: 'VENUE', retryable: true, retryAfterMs: 3000,
        venue: { code: 429, message: 'too many requests' },
      },
    })
    expect(penalties).toEqual([3000])
    expect(oks).toBe(0)
    expect(connector.quote('coinbase:BTC-USD')).toBeUndefined()
  })

  it('a 200 carrying { error } becomes a retryable VENUE_UNAVAILABLE', async () => {
    const fake = new FakeCoinbase()
    let oks = 0
    const budget = {
      async acquire() {},
      charge() {},
      reportOk() { oks += 1 },
      penalize() {},
      usage: () => ({ used: 0, target: 10, limit: 10, ratio: 0, windowMs: 1000, backoffUntil: 0 }),
    }
    fake.override.set('/api/v3/brokerage/market/products/NOPE-USD/ticker', () => json({ error: 'NotFound', message: 'no such product' }))
    const connector = new CoinbaseDataConnector({ fetchImpl: fake.fetch, budget, clock: () => FX_NOW })

    await expect(connector.refreshQuote('coinbase:NOPE-USD')).rejects.toMatchObject({
      problem: {
        name: 'VENUE_UNAVAILABLE', retryable: true,
        venue: { id: 'coinbase', message: 'NotFound: no such product' },
      },
    })
    expect(oks).toBe(0)
  })

  it('500 becomes VENUE_UNAVAILABLE without retryAfterMs; a later good response recovers', async () => {
    const fake = new FakeCoinbase()
    fake.override.set(CANDLES_PATH, () => new Response('boom', { status: 500 }))
    const connector = new CoinbaseDataConnector({ fetchImpl: fake.fetch, clock: () => FX_NOW })

    await expect(connector.candles('coinbase:BTC-USD', '1m', { n: 1 })).rejects.toMatchObject({
      problem: { name: 'VENUE_UNAVAILABLE', retryable: true, venue: { code: 500, message: 'boom' } },
    })
    const error = await connector.candles('coinbase:BTC-USD', '1m', { n: 1 }).catch((e: unknown) => e)
    expect((error as { problem?: { retryAfterMs?: number } }).problem?.retryAfterMs).toBeUndefined()

    fake.override.delete(CANDLES_PATH)
    await expect(connector.candles('coinbase:BTC-USD', '1m', { n: 1 })).resolves.toHaveLength(1)
  })

  it('network failures and invalid JSON become VENUE_UNAVAILABLE carrying the venue message', async () => {
    const connector = new CoinbaseDataConnector({
      fetchImpl: async () => { throw new Error('socket hang up') },
      clock: () => FX_NOW,
    })
    await expect(connector.start()).rejects.toMatchObject({
      problem: { name: 'VENUE_UNAVAILABLE', retryable: true, venue: { id: 'coinbase', message: 'socket hang up' } },
    })

    const badJson = new CoinbaseDataConnector({
      fetchImpl: async () => new Response('not json', { status: 200, headers: { 'content-type': 'application/json' } }),
      clock: () => FX_NOW,
    })
    await expect(badJson.start()).rejects.toMatchObject({
      problem: { name: 'VENUE_UNAVAILABLE', retryable: true, venue: { message: 'invalid json' } },
    })
  })
})
