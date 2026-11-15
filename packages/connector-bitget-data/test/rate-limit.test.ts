// SPDX-License-Identifier: CPAL-1.0
// 速率：每次请求前 acquire(1)（按次计，一请求一次、顺序在前），成功后 reportOk；
// 429 → Retry-After 退避；信封 code !== "00000" → VENUE_UNAVAILABLE（retryable，带 msg）。
import { describe, expect, it } from 'vitest'
import { BitgetDataConnector } from '../src/connector'
import { FakeBitget, FX_NOW, errorEnvelope } from './helpers/fake-bitget'

function recordingBudget() {
  const acquired: number[] = []
  const penalties: Array<number | undefined> = []
  let used = 0
  let oks = 0
  const budget = {
    async acquire(weight: number) {
      acquired.push(weight)
      used += weight
    },
    charge() {},
    reportOk() { oks += 1 },
    penalize(retryAfterMs?: number) { penalties.push(retryAfterMs) },
    usage: () => ({ used, target: 20, limit: 20, ratio: used / 20, windowMs: 1000, backoffUntil: 0 }),
  }
  return { budget, acquired, penalties, oksNow: () => oks }
}

describe('rate budget', () => {
  it('acquires one count before each HTTP call and reports success afterwards', async () => {
    const fake = new FakeBitget()
    const events: string[] = []
    const acquired: number[] = []
    let used = 0
    const budget = {
      async acquire(weight: number) {
        acquired.push(weight)
        used += weight
        events.push(`acquire:${weight}`)
      },
      charge() {},
      reportOk() { events.push('ok') },
      penalize() {},
      usage: () => ({ used, target: 20, limit: 20, ratio: used / 20, windowMs: 1000, backoffUntil: 0 }),
    }
    const connector = new BitgetDataConnector({
      baseUrl: 'http://bitget.example.test',
      fetchImpl: async (input, init) => {
        events.push('fetch')
        return fake.fetch(input, init)
      },
      budget,
      clock: () => FX_NOW,
    })

    await connector.start()
    await connector.candles('bitget:BTCUSDT', '1m', { n: 5 })
    await connector.book('bitget:BTCUSDT', 20)
    await connector.context('bitget:BTCUSDT')
    await connector.refreshQuote('bitget:BTCUSDT')

    // contracts 1、candles 1、merge-depth 1、ticker + current-fund-rate 1+1、ticker 1
    expect(acquired).toEqual([1, 1, 1, 1, 1, 1])
    expect(events).toEqual([
      'acquire:1', 'fetch', 'ok',
      'acquire:1', 'fetch', 'ok',
      'acquire:1', 'fetch', 'ok',
      'acquire:1', 'fetch', 'ok',
      'acquire:1', 'fetch', 'ok',
      'acquire:1', 'fetch', 'ok',
    ])
    expect(connector.status().rateBudget).toEqual({ used: 6, limit: 20, windowMs: 1000 })
  })

  it('defaults to an unlimited budget when none is injected', async () => {
    const fake = new FakeBitget()
    const connector = new BitgetDataConnector({ fetchImpl: fake.fetch, clock: () => FX_NOW })
    await connector.start()
    expect(connector.status().rateBudget).toEqual({ used: 0, limit: 20, windowMs: 1000 })
  })
})

describe('HTTP failures', () => {
  it('429 becomes VENUE_UNAVAILABLE with retryAfterMs and penalizes the budget', async () => {
    const fake = new FakeBitget()
    const { budget, penalties, oksNow } = recordingBudget()
    fake.override.set('/api/v2/mix/market/ticker', () => new Response('too many requests', { status: 429, headers: { 'retry-after': '3' } }))
    const connector = new BitgetDataConnector({ fetchImpl: fake.fetch, budget, clock: () => FX_NOW })

    await expect(connector.refreshQuote('bitget:BTCUSDT')).rejects.toMatchObject({
      problem: {
        name: 'VENUE_UNAVAILABLE', code: 3003, category: 'VENUE', retryable: true, retryAfterMs: 3000,
        venue: { code: 429, message: 'too many requests' },
      },
    })
    expect(penalties).toEqual([3000])
    expect(oksNow()).toBe(0)
    expect(connector.quote('bitget:BTCUSDT')).toBeUndefined()
  })

  it('a business code other than "00000" becomes a retryable VENUE_UNAVAILABLE carrying msg', async () => {
    const fake = new FakeBitget()
    const { budget, penalties, oksNow } = recordingBudget()
    fake.override.set('/api/v2/mix/market/ticker', () => errorEnvelope('40034', 'Parameter NOPEZZZ does not exist'))
    const connector = new BitgetDataConnector({ fetchImpl: fake.fetch, budget, clock: () => FX_NOW })

    await expect(connector.refreshQuote('bitget:NOPEZZZ')).rejects.toMatchObject({
      problem: {
        name: 'VENUE_UNAVAILABLE', retryable: true,
        venue: { id: 'bitget', code: '40034', message: 'Parameter NOPEZZZ does not exist' },
      },
    })
    expect(penalties).toEqual([])
    expect(oksNow()).toBe(0)
  })

  it('500 becomes a retryable VENUE_UNAVAILABLE without Retry-After', async () => {
    const fake = new FakeBitget()
    fake.override.set('/api/v2/mix/market/candles', () => new Response('boom', { status: 500 }))
    const connector = new BitgetDataConnector({ fetchImpl: fake.fetch, clock: () => FX_NOW })

    const error = await connector.candles('bitget:BTCUSDT', '1m', { n: 1 }).catch((e: unknown) => e)
    expect(error).toMatchObject({ problem: { name: 'VENUE_UNAVAILABLE', retryable: true, venue: { code: 500, message: 'boom' } } })
    expect((error as { problem?: { retryAfterMs?: number } }).problem?.retryAfterMs).toBeUndefined()
  })
})
