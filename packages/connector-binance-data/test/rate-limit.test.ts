// SPDX-License-Identifier: CPAL-1.0
// 速率：每次请求前先 take(weight)（一请求一次、顺序在前）；429 → VENUE_UNAVAILABLE 且带 Retry-After。
import { describe, expect, it } from 'vitest'
import { BinanceDataConnector } from '../src/connector'
import { FakeBinance, FX_NOW } from './helpers/fake-binance'

function recordingBudget() {
  const taken: number[] = []
  const penalties: Array<number | undefined> = []
  let used = 0
  const budget = {
    take(weight: number) {
      taken.push(weight)
      used += weight
    },
    charge() {},
    reportOk() {},
    penalize(retryAfterMs?: number) {
      penalties.push(retryAfterMs)
    },
    usage: () => ({ used, target: 2400, limit: 2400, ratio: used / 2400, windowMs: 60_000, backoffUntil: 0 }),
  }
  return { budget, taken, penalties }
}

describe('weight budget', () => {
  it('takes the request weight before each HTTP call, once per call', async () => {
    const fake = new FakeBinance()
    const events: string[] = []
    const taken: number[] = []
    let used = 0
    const budget = {
      take(weight: number) {
        taken.push(weight)
        used += weight
        events.push(`take:${weight}`)
      },
      charge() {},
      reportOk() {},
      penalize() {},
      usage: () => ({ used, target: 2400, limit: 2400, ratio: used / 2400, windowMs: 60_000, backoffUntil: 0 }),
    }
    const connector = new BinanceDataConnector({
      baseUrl: 'https://fapi.example.test',
      fetchImpl: async (input, init) => {
        events.push('fetch')
        return fake.fetch(input, init)
      },
      budget,
      clock: () => FX_NOW,
    })
    fake.klineRows = []

    await connector.start()
    await connector.candles('binance:BTCUSDT', '1m', { n: 300 })
    await connector.book('binance:BTCUSDT', 20)
    await connector.context('binance:BTCUSDT')
    await connector.refreshQuote('binance:BTCUSDT')

    // exchangeInfo 1、klines(300) 2、depth(20) 2、premiumIndex 1、bookTicker 2
    expect(taken).toEqual([1, 2, 2, 1, 2])
    expect(events).toEqual(['take:1', 'fetch', 'take:2', 'fetch', 'take:2', 'fetch', 'take:1', 'fetch', 'take:2', 'fetch'])
    expect(connector.status().rateBudget).toEqual({ used: 8, limit: 2400, windowMs: 60_000 })
  })

  it('defaults to an unlimited budget when none is injected', async () => {
    const fake = new FakeBinance()
    const connector = new BinanceDataConnector({ fetchImpl: fake.fetch, clock: () => FX_NOW })
    await connector.start()
    expect(connector.status().rateBudget).toEqual({ used: 0, limit: 2400, windowMs: 60_000 })
  })
})

describe('HTTP failures', () => {
  it('429 becomes VENUE_UNAVAILABLE with retryAfterMs and penalizes the budget', async () => {
    const fake = new FakeBinance()
    const { budget, penalties } = recordingBudget()
    fake.override.set('/fapi/v1/ticker/bookTicker', () => new Response('too many requests', { status: 429, headers: { 'retry-after': '3' } }))
    const connector = new BinanceDataConnector({ fetchImpl: fake.fetch, budget, clock: () => FX_NOW })

    await expect(connector.refreshQuote('binance:BTCUSDT')).rejects.toMatchObject({
      problem: {
        name: 'VENUE_UNAVAILABLE', code: 3003, category: 'VENUE', retryable: true, retryAfterMs: 3000,
        venue: { code: 429, message: 'too many requests' },
      },
    })
    expect(penalties).toEqual([3000])
    expect(connector.quote('binance:BTCUSDT')).toBeUndefined()
  })

  it('500 becomes a retryable VENUE_UNAVAILABLE without Retry-After', async () => {
    const fake = new FakeBinance()
    fake.override.set('/fapi/v1/klines', () => new Response('boom', { status: 500 }))
    const connector = new BinanceDataConnector({ fetchImpl: fake.fetch, clock: () => FX_NOW })

    await expect(connector.candles('binance:BTCUSDT', '1m', { n: 1 })).rejects.toMatchObject({
      problem: { name: 'VENUE_UNAVAILABLE', retryable: true, venue: { code: 500, message: 'boom' } },
    })
    const error = await connector.candles('binance:BTCUSDT', '1m', { n: 1 }).catch((e: unknown) => e)
    expect((error as { problem?: { retryAfterMs?: number } }).problem?.retryAfterMs).toBeUndefined()
  })
})
