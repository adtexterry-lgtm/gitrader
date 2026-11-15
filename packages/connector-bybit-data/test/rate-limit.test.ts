// SPDX-License-Identifier: CPAL-1.0
// 速率：每次请求前 acquire(weight)（一请求一次、顺序在前），成功后 reportOk；429 → Retry-After 退避；
// 信封 retCode !== 0 → VENUE_UNAVAILABLE（retryable，消息带 retMsg）。
import { describe, expect, it } from 'vitest'
import { BybitDataConnector } from '../src/connector'
import { FakeBybit, FX_NOW } from './helpers/fake-bybit'

describe('rate budget', () => {
  it('acquires the request weight before each HTTP call and reports success afterwards', async () => {
    const fake = new FakeBybit()
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
      usage: () => ({ used, target: 120, limit: 120, ratio: used / 120, windowMs: 5000, backoffUntil: 0 }),
    }
    const connector = new BybitDataConnector({
      baseUrl: 'http://bybit.example.test',
      fetchImpl: async (input, init) => {
        events.push('fetch')
        return fake.fetch(input, init)
      },
      budget,
      clock: () => FX_NOW,
    })

    await connector.start()
    await connector.candles('bybit:BTCUSDT', '1m', { n: 300 })
    await connector.book('bybit:BTCUSDT', 20)
    await connector.context('bybit:BTCUSDT')
    await connector.refreshQuote('bybit:BTCUSDT')

    // instruments 1、kline 1、orderbook 1、tickers(context) 1、tickers(quote) 1
    expect(taken).toEqual([1, 1, 1, 1, 1])
    expect(events).toEqual([
      'acquire:1', 'fetch', 'ok',
      'acquire:1', 'fetch', 'ok',
      'acquire:1', 'fetch', 'ok',
      'acquire:1', 'fetch', 'ok',
      'acquire:1', 'fetch', 'ok',
    ])
    expect(oks).toBe(5)
    expect(connector.status().rateBudget).toEqual({ used: 5, limit: 120, windowMs: 5000 })
  })

  it('defaults to an unlimited budget when none is injected', async () => {
    const fake = new FakeBybit()
    const connector = new BybitDataConnector({ fetchImpl: fake.fetch, clock: () => FX_NOW })
    await connector.start()
    expect(connector.status().rateBudget).toEqual({ used: 0, limit: 120, windowMs: 5000 })
  })
})

describe('HTTP failures', () => {
  it('429 becomes VENUE_UNAVAILABLE with retryAfterMs and penalizes the budget', async () => {
    const fake = new FakeBybit()
    const penalties: Array<number | undefined> = []
    let oks = 0
    const budget = {
      async acquire() {},
      charge() {},
      reportOk() { oks += 1 },
      penalize(retryAfterMs?: number) { penalties.push(retryAfterMs) },
      usage: () => ({ used: 0, target: 120, limit: 120, ratio: 0, windowMs: 5000, backoffUntil: 0 }),
    }
    fake.override.set('/v5/market/tickers', () => new Response('too many requests', { status: 429, headers: { 'retry-after': '3' } }))
    const connector = new BybitDataConnector({ fetchImpl: fake.fetch, budget, clock: () => FX_NOW })

    await expect(connector.refreshQuote('bybit:BTCUSDT')).rejects.toMatchObject({
      problem: {
        name: 'VENUE_UNAVAILABLE', code: 3003, category: 'VENUE', retryable: true, retryAfterMs: 3000,
        venue: { code: 429, message: 'too many requests' },
      },
    })
    expect(penalties).toEqual([3000])
    expect(oks).toBe(0)
    expect(connector.quote('bybit:BTCUSDT')).toBeUndefined()
  })

  it('a retCode other than 0 becomes a retryable VENUE_UNAVAILABLE carrying retMsg', async () => {
    const fake = new FakeBybit()
    let oks = 0
    const budget = {
      async acquire() {},
      charge() {},
      reportOk() { oks += 1 },
      penalize() {},
      usage: () => ({ used: 0, target: 120, limit: 120, ratio: 0, windowMs: 5000, backoffUntil: 0 }),
    }
    fake.override.set('/v5/market/tickers', () =>
      new Response(JSON.stringify({ retCode: 10001, retMsg: 'params error: Symbol Is Invalid', result: {}, time: FX_NOW }), {
        status: 200, headers: { 'content-type': 'application/json' },
      }))
    const connector = new BybitDataConnector({ fetchImpl: fake.fetch, budget, clock: () => FX_NOW })

    await expect(connector.refreshQuote('bybit:NOPEUSDT')).rejects.toMatchObject({
      problem: {
        name: 'VENUE_UNAVAILABLE', retryable: true,
        venue: { id: 'bybit', code: '10001', message: 'params error: Symbol Is Invalid' },
      },
    })
    expect(oks).toBe(0)
  })

  it('rejects 500 without Retry-After and keeps reading after recovery', async () => {
    const fake = new FakeBybit()
    fake.override.set('/v5/market/kline', () => new Response('boom', { status: 500 }))
    const connector = new BybitDataConnector({ fetchImpl: fake.fetch, clock: () => FX_NOW })

    const error = await connector.candles('bybit:BTCUSDT', '1m', { n: 1 }).catch((e: unknown) => e)
    expect((error as { problem?: { name?: string; retryable?: boolean; retryAfterMs?: number; venue?: { code?: number; message?: string } } }).problem)
      .toMatchObject({ name: 'VENUE_UNAVAILABLE', retryable: true, venue: { code: 500, message: 'boom' } })
    expect((error as { problem?: { retryAfterMs?: number } }).problem?.retryAfterMs).toBeUndefined()

    fake.override.delete('/v5/market/kline')
    await expect(connector.candles('bybit:BTCUSDT', '1m', { n: 1 })).resolves.toHaveLength(1)
  })
})
