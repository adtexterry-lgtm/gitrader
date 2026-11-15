// SPDX-License-Identifier: CPAL-1.0
// 速率：每次请求前 acquire(weight)（一请求一次、顺序在前），成功后 reportOk；
// 429 → Retry-After 退避；Gate.io 的 `{ label }` 错误体 → VENUE_UNAVAILABLE（retryable，消息带 label）。
import { describe, expect, it } from 'vitest'
import { GateioDataConnector } from '../src/connector'
import { FakeGateio, FX_NOW, candleRows } from './helpers/fake-gateio'

const TICKERS = '/api/v4/futures/usdt/tickers'
const CANDLES = '/api/v4/futures/usdt/candlesticks'

describe('rate budget', () => {
  it('acquires the request weight before each HTTP call and reports success afterwards', async () => {
    const fake = new FakeGateio()
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
      usage: () => ({ used, target: 200, limit: 200, ratio: used / 200, windowMs: 10_000, backoffUntil: 0 }),
    }
    const connector = new GateioDataConnector({
      baseUrl: 'http://gateio.example.test',
      fetchImpl: async (input, init) => {
        events.push('fetch')
        return fake.fetch(input, init)
      },
      budget,
      clock: () => FX_NOW,
    })
    fake.candleRows = candleRows(FX_NOW, 3)

    await connector.start()
    await connector.candles('gateio:BTC_USDT', '1m', { n: 3 })
    await connector.book('gateio:BTC_USDT', 20)
    await connector.context('gateio:BTC_USDT')
    await connector.refreshQuote('gateio:BTC_USDT')

    // Gate.io 公共端点按「次」计，每次权重 1：contracts / candlesticks / order_book / tickers(context) / tickers(quote)
    expect(taken).toEqual([1, 1, 1, 1, 1])
    expect(events).toEqual([
      'acquire:1', 'fetch', 'ok',
      'acquire:1', 'fetch', 'ok',
      'acquire:1', 'fetch', 'ok',
      'acquire:1', 'fetch', 'ok',
      'acquire:1', 'fetch', 'ok',
    ])
    expect(oks).toBe(5)
    expect(connector.status().rateBudget).toEqual({ used: 5, limit: 200, windowMs: 10_000 })
  })

  it('defaults to an unlimited budget when none is injected', async () => {
    const fake = new FakeGateio()
    const connector = new GateioDataConnector({ baseUrl: 'http://gateio.example.test', fetchImpl: fake.fetch, clock: () => FX_NOW })
    await connector.start()
    expect(connector.status().rateBudget).toEqual({ used: 0, limit: 200, windowMs: 10_000 })
  })
})

describe('HTTP failures', () => {
  it('429 becomes VENUE_UNAVAILABLE with retryAfterMs and penalizes the budget', async () => {
    const fake = new FakeGateio()
    const penalties: Array<number | undefined> = []
    let oks = 0
    const budget = {
      async acquire() {},
      charge() {},
      reportOk() { oks += 1 },
      penalize(retryAfterMs?: number) { penalties.push(retryAfterMs) },
      usage: () => ({ used: 0, target: 200, limit: 200, ratio: 0, windowMs: 10_000, backoffUntil: 0 }),
    }
    fake.override.set(TICKERS, () => new Response('too many requests', { status: 429, headers: { 'retry-after': '3' } }))
    const connector = new GateioDataConnector({ baseUrl: 'http://gateio.example.test', fetchImpl: fake.fetch, budget, clock: () => FX_NOW })

    await expect(connector.refreshQuote('gateio:BTC_USDT')).rejects.toMatchObject({
      problem: {
        name: 'VENUE_UNAVAILABLE', code: 3003, category: 'VENUE', retryable: true, retryAfterMs: 3000,
        venue: { id: 'gateio', code: 429, message: 'too many requests' },
      },
    })
    expect(penalties).toEqual([3000])
    expect(oks).toBe(0)
    expect(connector.quote('gateio:BTC_USDT')).toBeUndefined()
  })

  it('a non-2xx `{ label }` body becomes a retryable VENUE_UNAVAILABLE carrying the label', async () => {
    const fake = new FakeGateio()
    let oks = 0
    const budget = {
      async acquire() {},
      charge() {},
      reportOk() { oks += 1 },
      penalize() {},
      usage: () => ({ used: 0, target: 200, limit: 200, ratio: 0, windowMs: 10_000, backoffUntil: 0 }),
    }
    fake.override.set(TICKERS, () =>
      new Response(JSON.stringify({ label: 'CONTRACT_NOT_FOUND' }), {
        status: 400, headers: { 'content-type': 'application/json' },
      }))
    const connector = new GateioDataConnector({ baseUrl: 'http://gateio.example.test', fetchImpl: fake.fetch, budget, clock: () => FX_NOW })

    await expect(connector.refreshQuote('gateio:NOPE_USDT')).rejects.toMatchObject({
      problem: {
        name: 'VENUE_UNAVAILABLE', retryable: true,
        venue: { id: 'gateio', code: 'CONTRACT_NOT_FOUND', message: 'CONTRACT_NOT_FOUND' },
      },
    })
    expect(oks).toBe(0)
  })

  it('carries the label and message of a real 400 INVALID_PARAM_VALUE body', async () => {
    const fake = new FakeGateio()
    fake.override.set(CANDLES, () =>
      new Response(
        JSON.stringify({
          label: 'INVALID_PARAM_VALUE',
          message: 'Invalid request parameter `limit` value: 2, `limit` and `from` and `to` cannot be present at the same time',
        }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      ))
    const connector = new GateioDataConnector({ baseUrl: 'http://gateio.example.test', fetchImpl: fake.fetch, clock: () => FX_NOW })

    const error = await connector.candles('gateio:BTC_USDT', '1m', { n: 2 }).catch((e: unknown) => e)
    expect((error as { problem?: unknown }).problem).toMatchObject({
      name: 'VENUE_UNAVAILABLE',
      venue: { id: 'gateio', code: 'INVALID_PARAM_VALUE', message: expect.stringContaining('cannot be present at the same time') },
    })
  })

  it('rejects 500 without Retry-After and recovers once the endpoint does', async () => {
    const fake = new FakeGateio()
    fake.override.set(CANDLES, () => new Response('boom', { status: 500 }))
    const connector = new GateioDataConnector({ baseUrl: 'http://gateio.example.test', fetchImpl: fake.fetch, clock: () => FX_NOW })

    await expect(connector.candles('gateio:BTC_USDT', '1m', { n: 1 })).rejects.toMatchObject({
      problem: { name: 'VENUE_UNAVAILABLE', retryable: true, venue: { code: 500, message: 'boom' } },
    })
    const error = await connector.candles('gateio:BTC_USDT', '1m', { n: 1 }).catch((e: unknown) => e)
    expect((error as { problem?: { retryAfterMs?: number } }).problem?.retryAfterMs).toBeUndefined()

    fake.override.delete(CANDLES)
    fake.candleRows = []
    await expect(connector.candles('gateio:BTC_USDT', '1m', { n: 1 })).resolves.toEqual([])
  })
})
