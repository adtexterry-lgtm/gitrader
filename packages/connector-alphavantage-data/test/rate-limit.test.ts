// SPDX-License-Identifier: CPAL-1.0
// 限流与错误：Alpha Vantage 用 HTTP 200 传失败体（Information / Note / Error Message），
// 优先级与映射（限流 → VENUE_UNAVAILABLE + retryAfterMs；参数错 → INVALID_PARAMS）、
// HTTP 429 的 Retry-After、401 → VENUE_AUTH、预算记账、以及密钥不出现在错误信息里。
import { describe, expect, it } from 'vitest'
import { AlphaVantageDataConnector } from '../src/connector'
import { ProblemError } from '../src/parse'
import { API_KEY, FX_NOW, FakeAlphaVantage, HOST } from './helpers/fake-alphavantage'

const ID = 'alphavantage:AAPL'

interface Recorder {
  acquire: Array<number>
  oks: number
  penalties: Array<number | undefined>
}

function makeBudget(): { budget: Record<string, unknown>; recorder: Recorder } {
  const recorder: Recorder = { acquire: [], oks: 0, penalties: [] }
  const budget = {
    acquire: async (weight: number) => { recorder.acquire.push(weight) },
    reportOk: () => { recorder.oks += 1 },
    penalize: (ms?: number) => { recorder.penalties.push(ms) },
    usage: () => ({ used: recorder.acquire.length, target: 25, limit: 25, ratio: 0, windowMs: 86_400_000, backoffUntil: 0 }),
  }
  return { budget, recorder }
}

async function failureOf(fn: () => Promise<unknown>): Promise<ProblemError> {
  try {
    await fn()
  } catch (e) {
    expect(e).toBeInstanceOf(ProblemError)
    return e as ProblemError
  }
  throw new Error('expected the call to reject')
}

describe('rate limits and errors', () => {
  it('charges the injected budget once per request and reports success', async () => {
    const { budget, recorder } = makeBudget()
    const fake = new FakeAlphaVantage()
    const connector = new AlphaVantageDataConnector({
      apiKey: API_KEY, baseUrl: `http://${HOST}`, fetchImpl: fake.fetch, clock: () => FX_NOW, budget,
    })
    await connector.candles(ID, '1d')
    await connector.refreshQuote(ID)
    expect(recorder.acquire).toEqual([1, 1])
    expect(recorder.oks).toBe(2)
    expect(connector.status().rateBudget).toEqual({ used: 2, limit: 25, windowMs: 86_400_000 })
  })

  it('maps an Information body (free-tier cap) to a retryable venue error with a retry hint', async () => {
    const { budget, recorder } = makeBudget()
    const fake = new FakeAlphaVantage()
    fake.override.set('TIME_SERIES_DAILY', () => new Response(
      JSON.stringify({ Information: 'Thank you for using Alpha Vantage! Our standard API call frequency is limited.' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ))
    const connector = new AlphaVantageDataConnector({
      apiKey: API_KEY, baseUrl: `http://${HOST}`, fetchImpl: fake.fetch, clock: () => FX_NOW, budget,
    })
    const error = await failureOf(() => connector.candles(ID, '1d'))
    expect(error.problem.name).toBe('VENUE_UNAVAILABLE')
    expect(error.problem.retryable).toBe(true)
    expect(error.problem.retryAfterMs).toBe(60_000)
    expect(error.problem.venue?.message).toContain('standard API call frequency')
    expect(recorder.penalties).toEqual([60_000])
  })

  it('maps a Note body that mentions premium to VENUE_AUTH without a retry or a budget penalty', async () => {
    const { budget, recorder } = makeBudget()
    const fake = new FakeAlphaVantage()
    fake.override.set('TIME_SERIES_INTRADAY', () => new Response(
      JSON.stringify({ Note: 'This endpoint is available on premium plans only.' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ))
    const connector = new AlphaVantageDataConnector({
      apiKey: API_KEY, baseUrl: `http://${HOST}`, fetchImpl: fake.fetch, clock: () => FX_NOW, budget,
    })
    const error = await failureOf(() => connector.candles(ID, '5m'))
    expect(error.problem.name).toBe('VENUE_AUTH')
    expect(error.problem.retryable).toBe(false)
    expect(error.problem.venue?.message).toContain('premium plans')
    expect(recorder.penalties).toEqual([])
    expect(recorder.oks).toBe(0)
  })

  it('maps an Information body that mentions premium to VENUE_AUTH as well (case-insensitive)', async () => {
    const { budget, recorder } = makeBudget()
    const fake = new FakeAlphaVantage()
    fake.override.set('TIME_SERIES_DAILY', () => new Response(
      JSON.stringify({ Information: 'The outputsize=full parameter is a PREMIUM feature.' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ))
    const connector = new AlphaVantageDataConnector({
      apiKey: API_KEY, baseUrl: `http://${HOST}`, fetchImpl: fake.fetch, clock: () => FX_NOW, budget,
    })
    const error = await failureOf(() => connector.candles(ID, '1d', { n: 200 }))
    expect(error.problem.name).toBe('VENUE_AUTH')
    expect(error.problem.retryable).toBe(false)
    expect(error.problem.venue?.message).toContain('PREMIUM feature')
    expect(recorder.penalties).toEqual([])
    expect(recorder.oks).toBe(0)
  })

  it('maps an Error Message body to INVALID_PARAMS (not retryable)', async () => {
    const fake = new FakeAlphaVantage()
    fake.override.set('GLOBAL_QUOTE', () => new Response(
      JSON.stringify({ 'Error Message': 'Invalid API call. Please retry or visit the documentation.' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ))
    const connector = new AlphaVantageDataConnector({
      apiKey: API_KEY, baseUrl: `http://${HOST}`, fetchImpl: fake.fetch, clock: () => FX_NOW,
    })
    const error = await failureOf(() => connector.refreshQuote(ID))
    expect(error.problem.name).toBe('INVALID_PARAMS')
    expect(error.problem.retryable).toBe(false)
  })

  it('honours Retry-After on HTTP 429 and penalises the budget', async () => {
    const { budget, recorder } = makeBudget()
    const fake = new FakeAlphaVantage()
    fake.override.set('GLOBAL_QUOTE', () => new Response('slow down', { status: 429, headers: { 'retry-after': '30' } }))
    const connector = new AlphaVantageDataConnector({
      apiKey: API_KEY, baseUrl: `http://${HOST}`, fetchImpl: fake.fetch, clock: () => FX_NOW, budget,
    })
    const error = await failureOf(() => connector.refreshQuote(ID))
    expect(error.problem).toMatchObject({ name: 'VENUE_UNAVAILABLE', retryable: true, retryAfterMs: 30_000 })
    expect(recorder.penalties).toEqual([30_000])
  })

  it('maps HTTP 401 to VENUE_AUTH without retrying', async () => {
    const fake = new FakeAlphaVantage()
    fake.override.set('GLOBAL_QUOTE', () => new Response('unauthorized', { status: 401 }))
    const connector = new AlphaVantageDataConnector({
      apiKey: API_KEY, baseUrl: `http://${HOST}`, fetchImpl: fake.fetch, clock: () => FX_NOW,
    })
    const error = await failureOf(() => connector.refreshQuote(ID))
    expect(error.problem).toMatchObject({ name: 'VENUE_AUTH', retryable: false, venue: { code: 401 } })
  })

  it('never echoes the API key in an error message, even when the upstream does', async () => {
    const fake = new FakeAlphaVantage()
    fake.override.set('GLOBAL_QUOTE', () => new Response(`bad key ${API_KEY}`, { status: 500 }))
    const connector = new AlphaVantageDataConnector({
      apiKey: API_KEY, baseUrl: `http://${HOST}`, fetchImpl: fake.fetch, clock: () => FX_NOW,
    })
    const error = await failureOf(() => connector.refreshQuote(ID))
    expect(error.problem.message).not.toContain(API_KEY)
    expect(error.problem.venue?.message).not.toContain(API_KEY)
    expect(error.problem.venue?.message).toContain('<redacted>')
  })

  it('maps a truncated / non-JSON body on a JSON endpoint to a retryable venue error', async () => {
    const fake = new FakeAlphaVantage()
    fake.override.set('TIME_SERIES_DAILY', () => new Response('<html>oops</html>', { status: 200 }))
    const connector = new AlphaVantageDataConnector({
      apiKey: API_KEY, baseUrl: `http://${HOST}`, fetchImpl: fake.fetch, clock: () => FX_NOW,
    })
    const error = await failureOf(() => connector.candles(ID, '1d'))
    expect(error.problem).toMatchObject({ name: 'VENUE_UNAVAILABLE', retryable: true })
  })
})
