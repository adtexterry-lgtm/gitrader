// SPDX-License-Identifier: CPAL-1.0
// 速率与错误：每次请求前 acquire(weight)、成功后 reportOk；429 → Retry-After + 预算退避；
// 401 / 403 → VENUE_AUTH（不重试，403 多是免费计划查 SIP）；404 → INVALID_PARAMS；其余 / 网络异常 → VENUE_UNAVAILABLE。
import { describe, expect, it } from 'vitest'
import { AlpacaDataConnector } from '../src/connector'
import { ProblemError } from '../src/parse'
import { DATA_HOST, FX_NOW, FakeAlpaca, TRADING_HOST, json } from './helpers/fake-alpaca'

const BARS_PATH = '/v2/stocks/AAPL/bars'

function make(o: Record<string, unknown> = {}): { fake: FakeAlpaca; connector: AlpacaDataConnector } {
  const fake = new FakeAlpaca()
  const connector = new AlpacaDataConnector({
    tradingBaseUrl: `http://${TRADING_HOST}`,
    dataBaseUrl: `http://${DATA_HOST}`,
    fetchImpl: fake.fetch,
    clock: () => FX_NOW,
    env: {},
    ...o,
  })
  return { fake, connector }
}

const failureOf = async (run: () => Promise<unknown>): Promise<ProblemError> => {
  try {
    await run()
  } catch (e) {
    expect(e).toBeInstanceOf(ProblemError)
    return e as ProblemError
  }
  throw new Error('expected a ProblemError')
}

describe('rate budget', () => {
  it('acquires one unit before every HTTP call and reports success afterwards', async () => {
    const fake = new FakeAlpaca()
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
      usage: () => ({ used, target: 200, limit: 200, ratio: used / 200, windowMs: 60_000, backoffUntil: 0 }),
    }
    const connector = new AlpacaDataConnector({
      tradingBaseUrl: `http://${TRADING_HOST}`,
      dataBaseUrl: `http://${DATA_HOST}`,
      fetchImpl: async (input, init) => {
        events.push('fetch')
        return fake.fetch(input, init)
      },
      budget,
      clock: () => FX_NOW,
      env: {},
    })

    await connector.start()
    await connector.candles('alpaca:AAPL', '1m', { n: 5 })
    await connector.refreshQuote('alpaca:AAPL')

    // start() 三次（日历 / 标的 / 时钟）+ K 线一次 + 快照一次
    expect(taken).toEqual([1, 1, 1, 1, 1])
    expect(events).toEqual([
      'acquire:1', 'fetch', 'ok',
      'acquire:1', 'fetch', 'ok',
      'acquire:1', 'fetch', 'ok',
      'acquire:1', 'fetch', 'ok',
      'acquire:1', 'fetch', 'ok',
    ])
    expect(oks).toBe(5)
    expect(connector.status().rateBudget).toEqual({ used: 5, limit: 200, windowMs: 60_000 })
  })

  it('defaults to an unlimited budget when none is injected', async () => {
    const { connector } = make()
    await connector.start()
    expect(connector.status().rateBudget).toEqual({ used: 0, limit: 200, windowMs: 60_000 })
  })
})

describe('HTTP failures', () => {
  it('maps 429 to VENUE_UNAVAILABLE with retryAfterMs and penalises the shared budget', async () => {
    const fake = new FakeAlpaca()
    const penalties: Array<number | undefined> = []
    const budget = {
      async acquire() {},
      charge() {},
      reportOk() {},
      penalize(retryAfterMs?: number) { penalties.push(retryAfterMs) },
      usage: () => ({ used: 0, target: 200, limit: 200, ratio: 0, windowMs: 60_000, backoffUntil: 0 }),
    }
    fake.override.set(`${DATA_HOST}${BARS_PATH}`, () => new Response('slow down', { status: 429, headers: { 'retry-after': '3' } }))
    const connector = new AlpacaDataConnector({
      tradingBaseUrl: `http://${TRADING_HOST}`, dataBaseUrl: `http://${DATA_HOST}`,
      fetchImpl: fake.fetch, budget, clock: () => FX_NOW, env: {},
    })

    const problem = await failureOf(() => connector.candles('alpaca:AAPL', '1m', { n: 5 }))
    expect(problem.problem).toMatchObject({ name: 'VENUE_UNAVAILABLE', retryable: true, retryAfterMs: 3000 })
    expect(penalties).toEqual([3000])
  })

  it('maps 401 to VENUE_AUTH (not retryable) and keeps the key out of the message', async () => {
    const fake = new FakeAlpaca()
    fake.override.set(`${TRADING_HOST}/v2/clock`, () => new Response('{"message":"unauthorized"}', { status: 401 }))
    const { connector } = make({ keyId: 'PKFAKEKEY', secretKey: 'fakesecret', fetchImpl: fake.fetch })

    const problem = await failureOf(() => connector.market.refreshMarketClock())
    expect(problem.problem).toMatchObject({ name: 'VENUE_AUTH', retryable: false, venue: { code: 401 } })
    expect(problem.message).not.toContain('PKFAKEKEY')
    expect(problem.message).not.toContain('fakesecret')
  })

  it('maps 403 on the data host to VENUE_AUTH with a subscription hint (SIP without a plan)', async () => {
    const fake = new FakeAlpaca()
    fake.override.set(`${DATA_HOST}${BARS_PATH}`, () => new Response('{"message":"subscription does not permit querying recent SIP data"}', { status: 403 }))
    const { connector } = make({ feed: 'sip', environment: 'live', keyId: 'AKFAKE', secretKey: 's', fetchImpl: fake.fetch })

    const problem = await failureOf(() => connector.candles('alpaca:AAPL', '1m', { n: 5 }))
    expect(problem.problem.name).toBe('VENUE_AUTH')
    expect(problem.problem.retryable).toBe(false)
    expect(problem.message).toMatch(/check credentials and data subscription/)
  })

  it('maps 404 (unknown symbol) to INVALID_PARAMS without retrying', async () => {
    const fake = new FakeAlpaca()
    fake.override.set(`${DATA_HOST}${BARS_PATH}`, () => new Response('{"message":"invalid symbol"}', { status: 404 }))
    const { connector } = make({ fetchImpl: fake.fetch })
    const problem = await failureOf(() => connector.candles('alpaca:AAPL', '1m', { n: 5 }))
    expect(problem.problem).toMatchObject({ name: 'INVALID_PARAMS', retryable: false })
  })

  it('turns a transport failure into a retryable VENUE_UNAVAILABLE', async () => {
    const connector = new AlpacaDataConnector({
      tradingBaseUrl: `http://${TRADING_HOST}`, dataBaseUrl: `http://${DATA_HOST}`,
      fetchImpl: async () => { throw new Error('socket hang up') },
      clock: () => FX_NOW, env: {},
    })
    const problem = await failureOf(() => connector.start())
    expect(problem.problem).toMatchObject({ name: 'VENUE_UNAVAILABLE', retryable: true })
    expect(problem.message).toMatch(/request failed/)
  })

  it('treats an invalid JSON payload as VENUE_UNAVAILABLE', async () => {
    const fake = new FakeAlpaca()
    fake.override.set(`${TRADING_HOST}/v2/assets`, () => new Response('<html>oops</html>', { status: 200 }))
    const { connector } = make({ fetchImpl: fake.fetch })
    await expect(connector.start()).rejects.toThrow(/invalid JSON/)
  })

  it('keeps working normally through an explicit 200 JSON response', async () => {
    const fake = new FakeAlpaca()
    fake.override.set(`${TRADING_HOST}/v2/clock`, () => json({ timestamp: '2026-10-21T14:00:00Z', is_open: false, next_open: '2026-10-22T13:30:00Z', next_close: '2026-10-22T20:00:00Z' }))
    const { connector } = make({ fetchImpl: fake.fetch })
    expect((await connector.refreshMarketClock()).isOpen).toBe(false)
  })
})
