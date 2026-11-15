// SPDX-License-Identifier: CPAL-1.0
// 速率与错误：每次请求前 acquire、成功后 reportOk；429（含 HTTP 200 的信封）→ 退避 + retryAfterMs；
// 5xx / 网络异常 / 坏 JSON → VENUE_UNAVAILABLE（可重试）。
import { describe, expect, it } from 'vitest'
import { TwelveDataDataConnector } from '../src/connector'
import { ProblemError } from '../src/parse'
import { FakeTwelveData, FX_NOW, TEST_KEY, errorJson, json } from './helpers/fake-twelvedata'

const BASE = 'https://twelvedata.example.test'

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
  const fake = new FakeTwelveData()
  const connector = new TwelveDataDataConnector({
    baseUrl: BASE, fetchImpl: fake.fetch, clock: () => FX_NOW, env: { TWELVEDATA_API_KEY: TEST_KEY }, ...o,
  })
  return { fake, connector }
}

describe('rate budget', () => {
  it('acquires one credit before every HTTP call and reports success afterwards', async () => {
    const fake = new FakeTwelveData()
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
      usage: () => ({ used: taken.length, target: 8, limit: 8, ratio: 0, windowMs: 60_000, backoffUntil: 0 }),
    }
    const connector = new TwelveDataDataConnector({
      baseUrl: BASE,
      fetchImpl: async (input, init) => {
        events.push('fetch')
        return fake.fetch(input, init)
      },
      budget,
      clock: () => FX_NOW,
      env: { TWELVEDATA_API_KEY: TEST_KEY },
    })

    await connector.start()
    await connector.candles('twelvedata:AAPL', '1m', { n: 5 })
    await connector.refreshQuote('twelvedata:AAPL')

    expect(taken).toEqual([1, 1, 1])
    expect(events).toEqual(['acquire:1', 'fetch', 'ok', 'acquire:1', 'fetch', 'ok', 'acquire:1', 'fetch', 'ok'])
    expect(oks).toBe(3)
    expect(connector.status().rateBudget).toEqual({ used: 3, limit: 8, windowMs: 60_000 })
  })

  it('maps an HTTP 429 with Retry-After to a retryable VENUE_UNAVAILABLE and backs the budget off', async () => {
    const fake = new FakeTwelveData()
    const penalties: number[] = []
    const budget = {
      acquire: async () => {},
      charge: () => {},
      reportOk: () => {},
      penalize: (ms?: number) => { penalties.push(ms ?? -1) },
      usage: () => ({ used: 0, target: 8, limit: 8, ratio: 0, windowMs: 60_000, backoffUntil: 0 }),
    }
    fake.override.set('/stocks', () => new Response(JSON.stringify({ code: 429, message: 'API limit reached', status: 'error' }), {
      status: 429,
      headers: { 'content-type': 'application/json', 'retry-after': '15' },
    }))
    const connector = new TwelveDataDataConnector({
      baseUrl: BASE, fetchImpl: fake.fetch, budget, clock: () => FX_NOW, env: { TWELVEDATA_API_KEY: TEST_KEY },
    })

    const problem = await failureOf(() => connector.start())
    expect(problem.problem).toMatchObject({ name: 'VENUE_UNAVAILABLE', retryable: true, retryAfterMs: 15_000 })
    expect(penalties).toEqual([15_000])
  })

  it('honours a 429 delivered as an HTTP 200 error envelope and falls back to 60 s without Retry-After', async () => {
    const fake = new FakeTwelveData()
    const penalties: number[] = []
    const budget = {
      acquire: async () => {},
      charge: () => {},
      reportOk: () => {},
      penalize: (ms?: number) => { penalties.push(ms ?? -1) },
      usage: () => ({ used: 0, target: 8, limit: 8, ratio: 0, windowMs: 60_000, backoffUntil: 0 }),
    }
    fake.override.set('/stocks', () => errorJson(429, 'You have run out of API credits for the current minute'))
    const connector = new TwelveDataDataConnector({
      baseUrl: BASE, fetchImpl: fake.fetch, budget, clock: () => FX_NOW, env: { TWELVEDATA_API_KEY: TEST_KEY },
    })

    const problem = await failureOf(() => connector.start())
    expect(problem.problem).toMatchObject({ name: 'VENUE_UNAVAILABLE', retryable: true, retryAfterMs: 60_000 })
    expect(penalties).toEqual([60_000])
  })

  it('maps 500 to a retryable VENUE_UNAVAILABLE and keeps the vendor message', async () => {
    const { fake, connector } = make()
    fake.override.set('/stocks', () => json({ code: 500, message: 'internal problem', status: 'error' }, 500))
    const problem = await failureOf(() => connector.start())
    expect(problem.problem).toMatchObject({ name: 'VENUE_UNAVAILABLE', retryable: true, venue: { code: 500 } })
    expect(JSON.stringify(problem.problem)).toContain('internal problem')
  })

  it('maps a transport failure to VENUE_UNAVAILABLE', async () => {
    const connector = new TwelveDataDataConnector({
      baseUrl: BASE,
      fetchImpl: async () => { throw new Error('socket hang up') },
      clock: () => FX_NOW,
      env: { TWELVEDATA_API_KEY: TEST_KEY },
    })
    const problem = await failureOf(() => connector.start())
    expect(problem.problem).toMatchObject({ name: 'VENUE_UNAVAILABLE', retryable: true, venue: { id: 'twelvedata', message: 'socket hang up' } })
  })

  it('maps an unparsable body to VENUE_UNAVAILABLE', async () => {
    const { fake, connector } = make()
    fake.override.set('/stocks', () => new Response('<html>oops</html>', { status: 200, headers: { 'content-type': 'text/html' } }))
    const problem = await failureOf(() => connector.start())
    expect(problem.problem.message).toContain('invalid JSON')
  })
})
