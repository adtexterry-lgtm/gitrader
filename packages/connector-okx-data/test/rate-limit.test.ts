// SPDX-License-Identifier: CPAL-1.0
// 速率：每次请求前 acquire(weight)（一请求一次、顺序在前），成功后 reportOk；429 → Retry-After 退避；
// 信封 code !== "0" → VENUE_UNAVAILABLE（retryable）。
import { describe, expect, it } from 'vitest'
import { OkxDataConnector } from '../src/connector'
import { FakeOkx, FX_NOW } from './helpers/fake-okx'

describe('rate budget', () => {
  it('acquires the request weight before each HTTP call and reports success afterwards', async () => {
    const fake = new FakeOkx()
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
      usage: () => ({ used, target: 20, limit: 20, ratio: used / 20, windowMs: 2000, backoffUntil: 0 }),
    }
    const connector = new OkxDataConnector({
      baseUrl: 'http://okx.example.test',
      fetchImpl: async (input, init) => {
        events.push('fetch')
        return fake.fetch(input, init)
      },
      budget,
      clock: () => FX_NOW,
    })
    fake.candleRows = []

    await connector.start()
    await connector.candles('okx:BTC-USDT-SWAP', '1m', { n: 300 })
    await connector.book('okx:BTC-USDT-SWAP', 20)
    await connector.context('okx:BTC-USDT-SWAP')
    await connector.refreshQuote('okx:BTC-USDT-SWAP')

    // instruments 1、candles(300) 2、books(20) 1、mark-price 1、funding-rate 1、ticker 1
    expect(taken).toEqual([1, 2, 1, 1, 1, 1])
    expect(events).toEqual([
      'acquire:1', 'fetch', 'ok',
      'acquire:2', 'fetch', 'ok',
      'acquire:1', 'fetch', 'ok',
      'acquire:1', 'fetch', 'ok',
      'acquire:1', 'fetch', 'ok',
      'acquire:1', 'fetch', 'ok',
    ])
    expect(oks).toBe(6)
    expect(connector.status().rateBudget).toEqual({ used: 7, limit: 20, windowMs: 2000 })
  })

  it('defaults to an unlimited budget when none is injected', async () => {
    const fake = new FakeOkx()
    const connector = new OkxDataConnector({ fetchImpl: fake.fetch, clock: () => FX_NOW })
    await connector.start()
    expect(connector.status().rateBudget).toEqual({ used: 0, limit: 20, windowMs: 2000 })
  })
})

describe('HTTP failures', () => {
  it('429 becomes VENUE_UNAVAILABLE with retryAfterMs and penalizes the budget', async () => {
    const fake = new FakeOkx()
    const penalties: Array<number | undefined> = []
    let oks = 0
    const budget = {
      async acquire() {},
      charge() {},
      reportOk() { oks += 1 },
      penalize(retryAfterMs?: number) { penalties.push(retryAfterMs) },
      usage: () => ({ used: 0, target: 20, limit: 20, ratio: 0, windowMs: 2000, backoffUntil: 0 }),
    }
    fake.override.set('/api/v5/market/ticker', () => new Response('too many requests', { status: 429, headers: { 'retry-after': '3' } }))
    const connector = new OkxDataConnector({ fetchImpl: fake.fetch, budget, clock: () => FX_NOW })

    await expect(connector.refreshQuote('okx:BTC-USDT-SWAP')).rejects.toMatchObject({
      problem: {
        name: 'VENUE_UNAVAILABLE', code: 3003, category: 'VENUE', retryable: true, retryAfterMs: 3000,
        venue: { code: 429, message: 'too many requests' },
      },
    })
    expect(penalties).toEqual([3000])
    expect(oks).toBe(0)
    expect(connector.quote('okx:BTC-USDT-SWAP')).toBeUndefined()
  })

  it('an envelope code other than "0" becomes a retryable VENUE_UNAVAILABLE carrying the venue code', async () => {
    const fake = new FakeOkx()
    let oks = 0
    const budget = {
      async acquire() {},
      charge() {},
      reportOk() { oks += 1 },
      penalize() {},
      usage: () => ({ used: 0, target: 20, limit: 20, ratio: 0, windowMs: 2000, backoffUntil: 0 }),
    }
    fake.override.set('/api/v5/market/ticker', () =>
      new Response(JSON.stringify({ code: '51001', msg: 'Instrument ID does not exist', data: [] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      }))
    const connector = new OkxDataConnector({ fetchImpl: fake.fetch, budget, clock: () => FX_NOW })

    await expect(connector.refreshQuote('okx:NOPE-USDT-SWAP')).rejects.toMatchObject({
      problem: {
        name: 'VENUE_UNAVAILABLE', retryable: true,
        venue: { id: 'okx', code: '51001', message: 'Instrument ID does not exist' },
      },
    })
    expect(oks).toBe(0)
  })

  it('accepts an explicit success envelope and rejects 500 without Retry-After', async () => {
    const fake = new FakeOkx()
    fake.override.set('/api/v5/market/candles', () => new Response('boom', { status: 500 }))
    const connector = new OkxDataConnector({ fetchImpl: fake.fetch, clock: () => FX_NOW })

    await expect(connector.candles('okx:BTC-USDT-SWAP', '1m', { n: 1 })).rejects.toMatchObject({
      problem: { name: 'VENUE_UNAVAILABLE', retryable: true, venue: { code: 500, message: 'boom' } },
    })
    const error = await connector.candles('okx:BTC-USDT-SWAP', '1m', { n: 1 }).catch((e: unknown) => e)
    expect((error as { problem?: { retryAfterMs?: number } }).problem?.retryAfterMs).toBeUndefined()

    fake.override.delete('/api/v5/market/candles')
    fake.candleRows = []
    await expect(connector.candles('okx:BTC-USDT-SWAP', '1m', { n: 1 })).resolves.toEqual([])
  })
})
