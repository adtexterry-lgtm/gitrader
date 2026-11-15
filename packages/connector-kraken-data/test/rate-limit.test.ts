// SPDX-License-Identifier: CPAL-1.0
// 速率：每次请求前 acquire(weight)（按次计 1，顺序在前），成功后 reportOk；429 → Retry-After 退避；
// 200 但信封 result === 'error' → VENUE_UNAVAILABLE（retryable）。
import { describe, expect, it } from 'vitest'
import { KrakenDataConnector } from '../src/connector'
import { FakeKraken, FX_NOW } from './helpers/fake-kraken'

describe('rate budget', () => {
  it('acquires the request weight before each HTTP call and reports success afterwards', async () => {
    const fake = new FakeKraken()
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
      usage: () => ({ used, target: 500, limit: 500, ratio: used / 500, windowMs: 10_000, backoffUntil: 0 }),
    }
    const connector = new KrakenDataConnector({
      baseUrl: 'http://kraken.example.test',
      fetchImpl: async (input, init) => {
        events.push('fetch')
        return fake.fetch(input, init)
      },
      budget,
      clock: () => FX_NOW,
    })
    fake.chart = []

    await connector.start()
    await connector.candles('kraken:PF_XBTUSD', '1h', { n: 300 })
    await connector.book('kraken:PF_XBTUSD', 20)
    await connector.context('kraken:PF_XBTUSD')
    await connector.refreshQuote('kraken:PF_XBTUSD')

    // Kraken 公共端点按次计：instruments 1、charts 1、orderbook 1、tickers 1、tickers 1
    expect(taken).toEqual([1, 1, 1, 1, 1])
    expect(events).toEqual([
      'acquire:1', 'fetch', 'ok',
      'acquire:1', 'fetch', 'ok',
      'acquire:1', 'fetch', 'ok',
      'acquire:1', 'fetch', 'ok',
      'acquire:1', 'fetch', 'ok',
    ])
    expect(oks).toBe(5)
    expect(connector.status().rateBudget).toEqual({ used: 5, limit: 500, windowMs: 10_000 })
  })

  it('defaults to an unlimited budget when none is injected', async () => {
    const fake = new FakeKraken()
    const connector = new KrakenDataConnector({ fetchImpl: fake.fetch, clock: () => FX_NOW })
    await connector.start()
    expect(connector.status().rateBudget).toEqual({ used: 0, limit: 500, windowMs: 10_000 })
  })
})

describe('HTTP failures', () => {
  it('429 becomes VENUE_UNAVAILABLE with retryAfterMs and penalizes the budget', async () => {
    const fake = new FakeKraken()
    const penalties: Array<number | undefined> = []
    let oks = 0
    const budget = {
      async acquire() {},
      charge() {},
      reportOk() { oks += 1 },
      penalize(retryAfterMs?: number) { penalties.push(retryAfterMs) },
      usage: () => ({ used: 0, target: 500, limit: 500, ratio: 0, windowMs: 10_000, backoffUntil: 0 }),
    }
    fake.override.set('/derivatives/api/v3/tickers', () => new Response('too many requests', { status: 429, headers: { 'retry-after': '3' } }))
    const connector = new KrakenDataConnector({ fetchImpl: fake.fetch, budget, clock: () => FX_NOW })

    await expect(connector.refreshQuote('kraken:PF_XBTUSD')).rejects.toMatchObject({
      problem: {
        name: 'VENUE_UNAVAILABLE', category: 'VENUE', retryable: true, retryAfterMs: 3000,
        venue: { code: 429, message: 'too many requests' },
      },
    })
    expect(penalties).toEqual([3000])
    expect(oks).toBe(0)
    expect(connector.quote('kraken:PF_XBTUSD')).toBeUndefined()
  })

  it('a 200 response carrying result === "error" becomes a retryable VENUE_UNAVAILABLE with the venue reason', async () => {
    const fake = new FakeKraken()
    let oks = 0
    const budget = {
      async acquire() {},
      charge() {},
      reportOk() { oks += 1 },
      penalize() {},
      usage: () => ({ used: 0, target: 500, limit: 500, ratio: 0, windowMs: 10_000, backoffUntil: 0 }),
    }
    fake.override.set('/derivatives/api/v3/orderbook', () =>
      new Response(JSON.stringify({ result: 'error', error: 'invalidArgument: symbol', serverTime: '2026-10-20T15:28:23.656Z' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      }))
    const connector = new KrakenDataConnector({ fetchImpl: fake.fetch, budget, clock: () => FX_NOW })

    await expect(connector.book('kraken:PF_NOPE')).rejects.toMatchObject({
      problem: {
        name: 'VENUE_UNAVAILABLE', retryable: true,
        venue: { id: 'kraken', code: 'invalidArgument: symbol', message: 'invalidArgument: symbol' },
      },
    })
    expect(oks).toBe(0)
  })

  it('a plain-text 400 without Retry-After still maps to VENUE_UNAVAILABLE, and success resumes afterwards', async () => {
    const fake = new FakeKraken()
    const path = '/api/charts/v1/trade/PF_XBTUSD/1m'
    fake.override.set(path, () => new Response('Invalid resolution', { status: 400 }))
    const connector = new KrakenDataConnector({ fetchImpl: fake.fetch, clock: () => FX_NOW })

    await expect(connector.candles('kraken:PF_XBTUSD', '1m', { n: 1 })).rejects.toMatchObject({
      problem: { name: 'VENUE_UNAVAILABLE', retryable: true, venue: { code: 400, message: 'Invalid resolution' } },
    })
    const error = await connector.candles('kraken:PF_XBTUSD', '1m', { n: 1 }).catch((e: unknown) => e)
    expect((error as { problem?: { retryAfterMs?: number } }).problem?.retryAfterMs).toBeUndefined()

    fake.override.delete(path)
    fake.chart = []
    await expect(connector.candles('kraken:PF_XBTUSD', '1m', { n: 1 })).resolves.toEqual([])
  })
})
