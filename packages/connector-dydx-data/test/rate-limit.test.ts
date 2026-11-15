// SPDX-License-Identifier: CPAL-1.0
// 速率：每次请求前 acquire(1)（Indexer 按次数计费、一请求一次、顺序在前），成功后 reportOk；
// 429 → Retry-After 退避；非 2xx 或 2xx 带 errors → VENUE_UNAVAILABLE（retryable）。
import { describe, expect, it } from 'vitest'
import { DydxDataConnector } from '../src/connector'
import { FakeDydx, FX_NOW } from './helpers/fake-dydx'

const BASE = 'http://dydx.example.test'

describe('rate budget', () => {
  it('acquires one unit before each HTTP call and reports success afterwards', async () => {
    const fake = new FakeDydx()
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
      usage: () => ({ used, target: 100, limit: 100, ratio: used / 100, windowMs: 10_000, backoffUntil: 0 }),
    }
    const connector = new DydxDataConnector({
      baseUrl: BASE,
      fetchImpl: async (input, init) => {
        events.push('fetch')
        return fake.fetch(input, init)
      },
      budget,
      clock: () => FX_NOW,
    })
    fake.candles = { candles: [] }

    await connector.start()
    await connector.candles('dydx:BTC-USD', '1m', { n: 300 })
    await connector.book('dydx:BTC-USD', 20)
    await connector.context('dydx:BTC-USD')
    await connector.refreshQuote('dydx:BTC-USD')

    // markets 1、candles 1、orderbook 1、context 0（读缓存）、quote = orderbook + trades 各 1
    expect(taken).toEqual([1, 1, 1, 1, 1])
    expect(events).toEqual([
      'acquire:1', 'fetch', 'ok',
      'acquire:1', 'fetch', 'ok',
      'acquire:1', 'fetch', 'ok',
      'acquire:1', 'fetch', 'ok',
      'acquire:1', 'fetch', 'ok',
    ])
    expect(oks).toBe(5)
    expect(connector.status().rateBudget).toEqual({ used: 5, limit: 100, windowMs: 10_000 })
  })

  it('defaults to an unlimited budget when none is injected', async () => {
    const fake = new FakeDydx()
    const connector = new DydxDataConnector({ baseUrl: BASE, fetchImpl: fake.fetch, clock: () => FX_NOW })
    await connector.start()
    expect(connector.status().rateBudget).toEqual({ used: 0, limit: 100, windowMs: 10_000 })
  })
})

describe('HTTP failures', () => {
  it('429 becomes VENUE_UNAVAILABLE with retryAfterMs and penalizes the budget', async () => {
    const fake = new FakeDydx()
    const penalties: Array<number | undefined> = []
    let oks = 0
    const budget = {
      async acquire() {},
      charge() {},
      reportOk() { oks += 1 },
      penalize(retryAfterMs?: number) { penalties.push(retryAfterMs) },
      usage: () => ({ used: 0, target: 100, limit: 100, ratio: 0, windowMs: 10_000, backoffUntil: 0 }),
    }
    fake.override.set('orderbook', () => new Response('too many requests', { status: 429, headers: { 'retry-after': '3' } }))
    const connector = new DydxDataConnector({ baseUrl: BASE, fetchImpl: fake.fetch, budget, clock: () => FX_NOW })

    await expect(connector.refreshQuote('dydx:BTC-USD')).rejects.toMatchObject({
      problem: {
        name: 'VENUE_UNAVAILABLE', code: 3003, category: 'VENUE', retryable: true, retryAfterMs: 3000,
        venue: { code: 429, message: 'too many requests' },
      },
    })
    expect(penalties).toEqual([3000])
    expect(oks).toBe(0)
    expect(connector.quote('dydx:BTC-USD')).toBeUndefined()
  })

  it('surfaces the Indexer `errors[0].msg` on a non-2xx response', async () => {
    const fake = new FakeDydx()
    fake.override.set('orderbook', () => new Response(
      JSON.stringify({ errors: [{ msg: 'NOPE-USD not found in markets of type PERPETUAL' }] }),
      { status: 404, headers: { 'content-type': 'application/json' } },
    ))
    const connector = new DydxDataConnector({ baseUrl: BASE, fetchImpl: fake.fetch, clock: () => FX_NOW })

    await expect(connector.book('dydx:NOPE-USD')).rejects.toMatchObject({
      problem: {
        name: 'VENUE_UNAVAILABLE', retryable: true,
        venue: { id: 'dydx', code: 404, message: 'NOPE-USD not found in markets of type PERPETUAL' },
      },
    })
  })

  it('treats an `errors` body served with HTTP 200 as a venue error', async () => {
    const fake = new FakeDydx()
    fake.override.set('candles', () => new Response(
      JSON.stringify({ errors: [{ msg: 'resolution must be a valid Candle Resolution' }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ))
    const connector = new DydxDataConnector({ baseUrl: BASE, fetchImpl: fake.fetch, clock: () => FX_NOW })

    await expect(connector.candles('dydx:BTC-USD', '1m', { n: 1 })).rejects.toMatchObject({
      problem: { name: 'VENUE_UNAVAILABLE', retryable: true, venue: { message: 'resolution must be a valid Candle Resolution' } },
    })
  })

  it('rejects 500 without Retry-After and keeps retryAfterMs unset', async () => {
    const fake = new FakeDydx()
    fake.override.set('markets', () => new Response('boom', { status: 500 }))
    const connector = new DydxDataConnector({ baseUrl: BASE, fetchImpl: fake.fetch, clock: () => FX_NOW })

    const error = await connector.start().catch((e: unknown) => e)
    expect((error as { problem?: { name?: string; retryable?: boolean; retryAfterMs?: number } }).problem).toMatchObject({
      name: 'VENUE_UNAVAILABLE', retryable: true,
    })
    expect((error as { problem?: { retryAfterMs?: number } }).problem?.retryAfterMs).toBeUndefined()

    fake.override.delete('markets')
    await expect(connector.start()).resolves.toBeUndefined()
    expect(connector.listInstruments().length).toBeGreaterThan(0)
  })

  it('reports invalid JSON as VENUE_UNAVAILABLE instead of leaking a parse error', async () => {
    const fake = new FakeDydx()
    fake.override.set('markets', () => new Response('<html>gateway</html>', { status: 200, headers: { 'content-type': 'text/html' } }))
    const connector = new DydxDataConnector({ baseUrl: BASE, fetchImpl: fake.fetch, clock: () => FX_NOW })
    await expect(connector.start()).rejects.toMatchObject({
      problem: { name: 'VENUE_UNAVAILABLE', venue: { message: 'invalid json' } },
    })
  })
})
