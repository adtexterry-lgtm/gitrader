// SPDX-License-Identifier: CPAL-1.0
// 速率：每次请求前 acquire(1)（计数模型、顺序在前），成功后 reportOk；
// 429 → Retry-After 退避；JSON-RPC error 信封（HTTP 4xx 或 200）→ 带场所码的 VENUE_UNAVAILABLE。
import { describe, expect, it } from 'vitest'
import { DeribitDataConnector } from '../src/connector'
import { FakeDeribit, FX_NOW } from './helpers/fake-deribit'

const TICKER = '/api/v2/public/ticker'
const CHART = '/api/v2/public/get_tradingview_chart_data'

function recordingBudget() {
  const taken: number[] = []
  const events: string[] = []
  const penalties: Array<number | undefined> = []
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
    penalize(retryAfterMs?: number) {
      penalties.push(retryAfterMs)
    },
    usage: () => ({ used, target: 20, limit: 20, ratio: used / 20, windowMs: 1_000, backoffUntil: 0 }),
  }
  return { budget, taken, events, penalties, oks: () => oks, used: () => used }
}

describe('count budget', () => {
  it('acquires one unit before each HTTP call and reports success afterwards', async () => {
    const fake = new FakeDeribit()
    const rec = recordingBudget()
    const connector = new DeribitDataConnector({
      baseUrl: 'http://deribit.example.test',
      fetchImpl: async (input, init) => {
        rec.events.push('fetch')
        return fake.fetch(input, init)
      },
      budget: rec.budget,
      clock: () => FX_NOW,
    })
    fake.chart = { ticks: [], open: [], high: [], low: [], close: [], volume: [], status: 'no_data' }

    await connector.start()
    await connector.candles('deribit:BTC-PERPETUAL', '1m', { n: 300 })
    await connector.book('deribit:BTC-PERPETUAL', 20)
    await connector.context('deribit:BTC-PERPETUAL')
    await connector.refreshQuote('deribit:BTC-PERPETUAL')

    // 目录 BTC / ETH / USDC 各 1、K 线 1、盘口 1、context 1、ticker 1
    expect(rec.taken).toEqual([1, 1, 1, 1, 1, 1, 1])
    expect(rec.events).toEqual([
      'acquire:1', 'fetch', 'ok',
      'acquire:1', 'fetch', 'ok',
      'acquire:1', 'fetch', 'ok',
      'acquire:1', 'fetch', 'ok',
      'acquire:1', 'fetch', 'ok',
      'acquire:1', 'fetch', 'ok',
      'acquire:1', 'fetch', 'ok',
    ])
    expect(rec.oks()).toBe(7)
    expect(connector.status().rateBudget).toEqual({ used: 7, limit: 20, windowMs: 1_000 })
  })

  it('defaults to an unlimited budget when none is injected', async () => {
    const fake = new FakeDeribit()
    const connector = new DeribitDataConnector({ fetchImpl: fake.fetch, clock: () => FX_NOW })
    await connector.start()
    expect(connector.status().rateBudget).toEqual({ used: 0, limit: 20, windowMs: 1_000 })
  })
})

describe('HTTP and envelope failures', () => {
  it('429 becomes VENUE_UNAVAILABLE with retryAfterMs and penalizes the budget', async () => {
    const fake = new FakeDeribit()
    const rec = recordingBudget()
    fake.override.set(TICKER, () => new Response('too many requests', { status: 429, headers: { 'retry-after': '3' } }))
    const connector = new DeribitDataConnector({ baseUrl: 'http://deribit.example.test', fetchImpl: fake.fetch, budget: rec.budget, clock: () => FX_NOW })

    await expect(connector.refreshQuote('deribit:BTC-PERPETUAL')).rejects.toMatchObject({
      problem: {
        name: 'VENUE_UNAVAILABLE', code: 3003, category: 'VENUE', retryable: true, retryAfterMs: 3000,
        venue: { id: 'deribit', code: 429, message: 'too many requests' },
      },
    })
    expect(rec.penalties).toEqual([3000])
    expect(rec.oks()).toBe(0)
    expect(connector.quote('deribit:BTC-PERPETUAL')).toBeUndefined()
  })

  it('a JSON-RPC error envelope over HTTP 400 carries the venue code and message', async () => {
    const fake = new FakeDeribit()
    fake.override.set(TICKER, () =>
      new Response(
        JSON.stringify({ jsonrpc: '2.0', error: { code: -32602, data: { reason: 'wrong format', param: 'instrument_name' }, message: 'Invalid params' } }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      ))
    const connector = new DeribitDataConnector({ baseUrl: 'http://deribit.example.test', fetchImpl: fake.fetch, clock: () => FX_NOW })

    await expect(connector.refreshQuote('deribit:NOPE-NOT-REAL')).rejects.toMatchObject({
      problem: {
        name: 'VENUE_UNAVAILABLE', retryable: true,
        venue: { id: 'deribit', code: -32602, message: 'Invalid params' },
      },
    })
  })

  it('an error envelope inside a 200 response is still VENUE_UNAVAILABLE, and success still parses', async () => {
    const fake = new FakeDeribit()
    fake.override.set(CHART, () =>
      new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: 10028, message: 'too_many_requests' } }), {
        status: 200, headers: { 'content-type': 'application/json' },
      }))
    const connector = new DeribitDataConnector({ baseUrl: 'http://deribit.example.test', fetchImpl: fake.fetch, clock: () => FX_NOW })

    await expect(connector.candles('deribit:BTC-PERPETUAL', '1m', { n: 1 })).rejects.toMatchObject({
      problem: { name: 'VENUE_UNAVAILABLE', retryable: true, venue: { code: 10028, message: 'too_many_requests' } },
    })

    fake.override.delete(CHART)
    await expect(connector.candles('deribit:BTC-PERPETUAL', '1m', { n: 1 })).resolves.toHaveLength(1)
  })

  it('500 becomes a retryable VENUE_UNAVAILABLE without Retry-After', async () => {
    const fake = new FakeDeribit()
    fake.override.set(TICKER, () => new Response('boom', { status: 500 }))
    const connector = new DeribitDataConnector({ baseUrl: 'http://deribit.example.test', fetchImpl: fake.fetch, clock: () => FX_NOW })

    await expect(connector.context('deribit:BTC-PERPETUAL')).rejects.toMatchObject({
      problem: { name: 'VENUE_UNAVAILABLE', retryable: true, venue: { code: 500, message: 'boom' } },
    })
    const error = await connector.context('deribit:BTC-PERPETUAL').catch((e: unknown) => e)
    expect((error as { problem?: { retryAfterMs?: number } }).problem?.retryAfterMs).toBeUndefined()
  })
})
