// SPDX-License-Identifier: CPAL-1.0
// 限流与错误：预算记账（5 次/分钟口径）、403 无权限 → VENUE_AUTH、404 → INVALID_PARAMS、
// 429 带 Retry-After、200 但 body 是 {"status":"ERROR"}、密钥不出现在错误信息里、坏 JSON。
import { describe, expect, it } from 'vitest'
import { PolygonDataConnector } from '../src/connector'
import { ProblemError } from '../src/parse'
import { API_KEY, FX_NOW, FakePolygon, HOST, json } from './helpers/fake-polygon'

const ID = 'polygon:AAPL'

interface Recorder {
  acquire: number[]
  oks: number
  penalties: Array<number | undefined>
}

function makeBudget(): { budget: Record<string, unknown>; recorder: Recorder } {
  const recorder: Recorder = { acquire: [], oks: 0, penalties: [] }
  const budget = {
    acquire: async (weight: number) => { recorder.acquire.push(weight) },
    reportOk: () => { recorder.oks += 1 },
    penalize: (ms?: number) => { recorder.penalties.push(ms) },
    usage: () => ({ used: recorder.acquire.length, target: 5, limit: 5, ratio: 0, windowMs: 60_000, backoffUntil: 0 }),
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

function make(o: Record<string, unknown> = {}): { fake: FakePolygon; connector: PolygonDataConnector; recorder: Recorder } {
  const { budget, recorder } = makeBudget()
  const fake = new FakePolygon()
  const connector = new PolygonDataConnector({
    apiKey: API_KEY, baseUrl: `http://${HOST}`, fetchImpl: fake.fetch, clock: () => FX_NOW, budget, ...o,
  })
  return { fake, connector, recorder }
}

describe('rate limits and errors', () => {
  it('charges the injected budget once per request and reports success', async () => {
    const { connector, recorder } = make()
    await connector.candles(ID, '1d')
    await connector.refreshQuote(ID)
    expect(recorder.acquire).toEqual([1, 1])
    expect(recorder.oks).toBe(2)
    expect(connector.status().rateBudget).toEqual({ used: 2, limit: 5, windowMs: 60_000 })
  })

  it('sends the key as a Bearer header and never in the URL', async () => {
    const { fake, connector } = make()
    await connector.refreshQuote(ID)
    const call = fake.calls[0]!
    expect(call.headers.authorization).toBe(`Bearer ${API_KEY}`)
    expect(call.url).not.toContain(API_KEY)
    expect(call.params.get('apiKey')).toBeNull()
  })

  it('maps HTTP 403 to VENUE_AUTH without retrying (free plan has no entitlement)', async () => {
    const { fake, connector } = make()
    fake.override.set('/v2/aggs', () => new Response('{"status":"NOT_AUTHORIZED"}', { status: 403 }))
    const error = await failureOf(() => connector.candles(ID, '1m'))
    expect(error.problem).toMatchObject({ name: 'VENUE_AUTH', retryable: false, venue: { code: 403 } })
  })

  it('maps a 200 response carrying {"status":"NOT_AUTHORIZED"} to VENUE_AUTH without retrying', async () => {
    const { fake, connector } = make()
    fake.override.set('/v2/aggs', () => json({ status: 'NOT_AUTHORIZED', error: 'not entitled' }))
    const error = await failureOf(() => connector.candles(ID, '1m'))
    expect(error.problem).toMatchObject({ name: 'VENUE_AUTH', retryable: false, venue: { code: 'NOT_AUTHORIZED' } })
    expect(fake.callsTo('/v2/aggs')).toHaveLength(1)
  })

  it('maps HTTP 404 to INVALID_PARAMS (unknown ticker)', async () => {
    const { fake, connector } = make()
    fake.override.set('/v2/snapshot', () => new Response('not found', { status: 404 }))
    const error = await failureOf(() => connector.refreshQuote(ID))
    expect(error.problem).toMatchObject({ name: 'INVALID_PARAMS', retryable: false })
  })

  it('honours Retry-After on HTTP 429 and penalises the budget', async () => {
    const { fake, connector, recorder } = make()
    fake.override.set('/v2/snapshot', () => new Response('slow down', { status: 429, headers: { 'retry-after': '12' } }))
    const error = await failureOf(() => connector.refreshQuote(ID))
    expect(error.problem).toMatchObject({ name: 'VENUE_UNAVAILABLE', retryable: true, retryAfterMs: 12_000 })
    expect(recorder.penalties).toEqual([12_000])
  })

  it('treats a 200 response carrying {"status":"ERROR"} as a retryable venue error', async () => {
    const { fake, connector } = make()
    fake.override.set('/v3/reference/tickers', () => json({ status: 'ERROR', error: 'Unknown API Key', request_id: 'r' }))
    const error = await failureOf(() => connector.start())
    expect(error.problem.name).toBe('VENUE_UNAVAILABLE')
    expect(error.problem.retryable).toBe(true)
    expect(error.problem.venue?.message).toBe('Unknown API Key')
  })

  it('never echoes the API key in an error message, even when the upstream does', async () => {
    const { fake, connector } = make()
    fake.override.set('/v2/snapshot', () => new Response(`bad key ${API_KEY}`, { status: 500 }))
    const error = await failureOf(() => connector.refreshQuote(ID))
    expect(error.problem.message).not.toContain(API_KEY)
    expect(error.problem.venue?.message).not.toContain(API_KEY)
    expect(error.problem.venue?.message).toContain('<redacted>')
  })

  it('maps an unparseable body to a retryable venue error', async () => {
    const { fake, connector } = make()
    fake.override.set('/v2/snapshot', () => new Response('<html>oops</html>', { status: 200 }))
    const error = await failureOf(() => connector.refreshQuote(ID))
    expect(error.problem).toMatchObject({ name: 'VENUE_UNAVAILABLE', retryable: true })
  })

  it('propagates a network failure as a retryable venue error', async () => {
    const connector = new PolygonDataConnector({
      apiKey: API_KEY,
      baseUrl: `http://${HOST}`,
      fetchImpl: async () => { throw new Error('connect ECONNREFUSED') },
      clock: () => FX_NOW,
    })
    const error = await failureOf(() => connector.refreshQuote(ID))
    expect(error.problem).toMatchObject({ name: 'VENUE_UNAVAILABLE', retryable: true })
    expect(error.problem.venue?.message).toContain('ECONNREFUSED')
  })
})
