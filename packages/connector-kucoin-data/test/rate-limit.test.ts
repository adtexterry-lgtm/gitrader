// SPDX-License-Identifier: CPAL-1.0
// 速率：每次请求前 acquire(weight)、成功后 reportOk；429 → Retry-After 退避；
// 信封 code !== '200000' → VENUE_UNAVAILABLE（retryable，带场所 code / msg）。
import { describe, expect, it } from 'vitest'
import { KucoinDataConnector } from '../src/connector'
import { FakeKucoin, FX_NOW, MARK_TS, candleRows, errorEnvelope } from './helpers/fake-kucoin'

describe('rate budget', () => {
  it('acquires the request weight before each HTTP call and reports success afterwards', async () => {
    const fake = new FakeKucoin()
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
      usage: () => ({ used, target: 30, limit: 30, ratio: used / 30, windowMs: 3_000, backoffUntil: 0 }),
    }
    const connector = new KucoinDataConnector({
      baseUrl: 'http://kucoin.example.test',
      fetchImpl: async (input, init) => {
        events.push('fetch')
        return fake.fetch(input, init)
      },
      budget,
      clock: () => FX_NOW,
    })
    fake.kline = () => candleRows(MARK_TS, 2)

    await connector.start()
    await connector.candles('kucoin:XBTUSDTM', '1m', { n: 2 })
    await connector.book('kucoin:XBTUSDTM', 20)
    await connector.context('kucoin:XBTUSDTM')
    await connector.refreshQuote('kucoin:XBTUSDTM')

    // contracts 1、kline 1、depth 1、mark-price 1、funding-rate 1、ticker 1
    expect(taken).toEqual([1, 1, 1, 1, 1, 1])
    expect(events).toEqual([
      'acquire:1', 'fetch', 'ok',
      'acquire:1', 'fetch', 'ok',
      'acquire:1', 'fetch', 'ok',
      'acquire:1', 'fetch', 'ok',
      'acquire:1', 'fetch', 'ok',
      'acquire:1', 'fetch', 'ok',
    ])
    expect(oks).toBe(6)
    expect(connector.status().rateBudget).toEqual({ used: 6, limit: 30, windowMs: 3_000 })
  })

  it('defaults to an unlimited budget when none is injected', async () => {
    const fake = new FakeKucoin()
    const connector = new KucoinDataConnector({ fetchImpl: fake.fetch, clock: () => FX_NOW })
    await connector.start()
    expect(connector.status().rateBudget).toEqual({ used: 0, limit: 30, windowMs: 3_000 })
  })
})

describe('HTTP failures', () => {
  it('429 becomes VENUE_UNAVAILABLE with retryAfterMs and penalizes the budget', async () => {
    const fake = new FakeKucoin()
    const penalties: Array<number | undefined> = []
    let oks = 0
    const budget = {
      async acquire() {},
      charge() {},
      reportOk() { oks += 1 },
      penalize(retryAfterMs?: number) { penalties.push(retryAfterMs) },
      usage: () => ({ used: 0, target: 30, limit: 30, ratio: 0, windowMs: 3_000, backoffUntil: 0 }),
    }
    fake.override.set('/api/v1/ticker', () => new Response('too many requests', { status: 429, headers: { 'retry-after': '3' } }))
    const connector = new KucoinDataConnector({ fetchImpl: fake.fetch, budget, clock: () => FX_NOW })

    await expect(connector.refreshQuote('kucoin:XBTUSDTM')).rejects.toMatchObject({
      problem: {
        name: 'VENUE_UNAVAILABLE', code: 3003, category: 'VENUE', retryable: true, retryAfterMs: 3_000,
        venue: { id: 'kucoin', code: 429, message: 'too many requests' },
      },
    })
    expect(penalties).toEqual([3_000])
    expect(oks).toBe(0)
    expect(connector.quote('kucoin:XBTUSDTM')).toBeUndefined()
  })

  it('a business code other than 200000 becomes a retryable VENUE_UNAVAILABLE carrying code and msg', async () => {
    const fake = new FakeKucoin()
    let oks = 0
    const budget = {
      async acquire() {},
      charge() {},
      reportOk() { oks += 1 },
      penalize() {},
      usage: () => ({ used: 0, target: 30, limit: 30, ratio: 0, windowMs: 3_000, backoffUntil: 0 }),
    }
    fake.override.set('/api/v1/ticker', () => errorEnvelope('200003', 'Invalid symbol.'))
    const connector = new KucoinDataConnector({ fetchImpl: fake.fetch, budget, clock: () => FX_NOW })

    await expect(connector.refreshQuote('kucoin:NOPEUSDTM')).rejects.toMatchObject({
      problem: {
        name: 'VENUE_UNAVAILABLE', retryable: true,
        venue: { id: 'kucoin', code: '200003', message: 'Invalid symbol.' },
      },
    })
    expect(oks).toBe(0)
  })

  it('rejects 500 without Retry-After and still serves a later success envelope', async () => {
    const fake = new FakeKucoin()
    fake.override.set('/api/v1/kline/query', () => new Response('boom', { status: 500 }))
    const connector = new KucoinDataConnector({ fetchImpl: fake.fetch, clock: () => FX_NOW })

    await expect(connector.candles('kucoin:XBTUSDTM', '1m', { n: 1 })).rejects.toMatchObject({
      problem: { name: 'VENUE_UNAVAILABLE', retryable: true, venue: { code: 500, message: 'boom' } },
    })
    const error = await connector.candles('kucoin:XBTUSDTM', '1m', { n: 1 }).catch((e: unknown) => e)
    expect((error as { problem?: { retryAfterMs?: number } }).problem?.retryAfterMs).toBeUndefined()

    fake.override.delete('/api/v1/kline/query')
    fake.kline = () => []
    await expect(connector.candles('kucoin:XBTUSDTM', '1m', { n: 1 })).resolves.toEqual([])
  })
})
