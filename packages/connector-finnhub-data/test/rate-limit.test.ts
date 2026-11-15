// SPDX-License-Identifier: CPAL-1.0
// 速率与错误：每次请求前 acquire、成功后 reportOk；429 → Retry-After + 预算退避；
// 500 / 网络异常 / 坏 JSON → VENUE_UNAVAILABLE（可重试）。
import { describe, expect, it } from 'vitest'
import { FinnhubDataConnector } from '../src/connector'
import { ProblemError } from '../src/parse'
import { FakeFinnhub, FX_NOW, TEST_KEY, json } from './helpers/fake-finnhub'

const BASE = 'https://finnhub.example.test/v1'

const failureOf = async (run: () => Promise<unknown>): Promise<ProblemError> => {
  try {
    await run()
  } catch (e) {
    expect(e).toBeInstanceOf(ProblemError)
    return e as ProblemError
  }
  throw new Error('expected a ProblemError')
}

function make(o: Record<string, unknown> = {}) {
  const fake = new FakeFinnhub()
  const connector = new FinnhubDataConnector({
    baseUrl: BASE, fetchImpl: fake.fetch, clock: () => FX_NOW, env: { FINNHUB_API_KEY: TEST_KEY }, ...o,
  })
  return { fake, connector }
}

describe('rate budget', () => {
  it('acquires one unit before every HTTP call and reports success afterwards', async () => {
    const fake = new FakeFinnhub()
    const events: string[] = []
    const taken: number[] = []
    let oks = 0
    const budget = {
      async acquire(weight: number) {
        taken.push(weight)
        events.push(`acquire:${weight}`)
      },
      charge() {},
      reportOk() {
        oks += 1
        events.push('ok')
      },
      penalize() {},
      usage: () => ({ used: taken.length, target: 60, limit: 60, ratio: 0, windowMs: 60_000, backoffUntil: 0 }),
    }
    const connector = new FinnhubDataConnector({
      baseUrl: BASE,
      fetchImpl: async (input, init) => {
        events.push('fetch')
        return fake.fetch(input, init)
      },
      budget,
      clock: () => FX_NOW,
      env: { FINNHUB_API_KEY: TEST_KEY },
    })

    await connector.start()
    await connector.candles('finnhub:AAPL', '1m', { n: 5 })
    await connector.refreshQuote('finnhub:AAPL')

    expect(taken).toEqual([1, 1, 1])
    expect(events).toEqual(['acquire:1', 'fetch', 'ok', 'acquire:1', 'fetch', 'ok', 'acquire:1', 'fetch', 'ok'])
    expect(oks).toBe(3)
    expect(connector.status().rateBudget).toEqual({ used: 3, limit: 60, windowMs: 60_000 })
  })

  it('maps 429 to a retryable VENUE_UNAVAILABLE with retryAfterMs and backs the budget off', async () => {
    const fake = new FakeFinnhub()
    const penalties: number[] = []
    const budget = {
      acquire: async () => {},
      charge: () => {},
      reportOk: () => {},
      penalize: (ms?: number) => { penalties.push(ms ?? -1) },
      usage: () => ({ used: 0, target: 60, limit: 60, ratio: 0, windowMs: 60_000, backoffUntil: 0 }),
    }
    fake.override.set('/stock/symbol', () => new Response('{\n "error": "API limit reached. Please try again later."\n}', {
      status: 429,
      headers: { 'content-type': 'application/json', 'retry-after': '30' },
    }))
    const connector = new FinnhubDataConnector({
      baseUrl: BASE, fetchImpl: fake.fetch, budget, clock: () => FX_NOW, env: { FINNHUB_API_KEY: TEST_KEY },
    })

    const problem = await failureOf(() => connector.start())
    expect(problem.problem).toMatchObject({ name: 'VENUE_UNAVAILABLE', retryable: true, retryAfterMs: 30_000 })
    expect(penalties).toEqual([30_000])
  })

  it('falls back to a 60 s retry window when 429 carries no Retry-After', async () => {
    const { fake, connector } = make()
    fake.override.set('/stock/symbol', () => new Response('', { status: 429 }))
    const problem = await failureOf(() => connector.start())
    expect(problem.problem).toMatchObject({ name: 'VENUE_UNAVAILABLE', retryable: true, retryAfterMs: 60_000 })
  })

  it('maps 500 to a retryable VENUE_UNAVAILABLE and keeps the upstream body', async () => {
    const { fake, connector } = make()
    fake.override.set('/stock/symbol', () => json({ error: 'internal' }, 500))
    const problem = await failureOf(() => connector.start())
    expect(problem.problem).toMatchObject({ name: 'VENUE_UNAVAILABLE', retryable: true, venue: { code: 500 } })
  })

  it('maps a transport failure to VENUE_UNAVAILABLE', async () => {
    const connector = new FinnhubDataConnector({
      baseUrl: BASE,
      fetchImpl: async () => { throw new Error('socket hang up') },
      clock: () => FX_NOW,
      env: { FINNHUB_API_KEY: TEST_KEY },
    })
    const problem = await failureOf(() => connector.start())
    expect(problem.problem).toMatchObject({ name: 'VENUE_UNAVAILABLE', retryable: true, venue: { id: 'finnhub', message: 'socket hang up' } })
    expect(problem.problem.message).toContain('request failed')
  })

  it('maps an unparsable body to VENUE_UNAVAILABLE', async () => {
    const { fake, connector } = make()
    fake.override.set('/stock/symbol', () => new Response('<html>oops</html>', {
      status: 200, headers: { 'content-type': 'text/html' },
    }))
    const problem = await failureOf(() => connector.start())
    expect(problem.problem.message).toContain('invalid JSON')
  })
})
