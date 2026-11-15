// SPDX-License-Identifier: CPAL-1.0
// 密钥与错误码：key 只走 X-Finnhub-Token 请求头（不进 URL）；缺失即拒绝；
// 401 / 403 → VENUE_AUTH、404 → INVALID_PARAMS、429 / 其余 → VENUE_UNAVAILABLE；错误文本里的密钥被脱敏。
import { describe, expect, it } from 'vitest'
import { FinnhubDataConnector } from '../src/connector'
import { ProblemError } from '../src/parse'
import { FakeFinnhub, FX_NOW, TEST_KEY, json } from './helpers/fake-finnhub'

const BASE = 'https://finnhub.example.test/v1'

function make(o: Record<string, unknown> = {}) {
  const fake = new FakeFinnhub()
  const connector = new FinnhubDataConnector({
    baseUrl: BASE, fetchImpl: fake.fetch, clock: () => FX_NOW, env: { FINNHUB_API_KEY: TEST_KEY }, ...o,
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

describe('api key', () => {
  it('reads the key from the FINNHUB_API_KEY environment variable and sends it as a header', async () => {
    const { fake, connector } = make()
    await connector.start()
    const call = fake.callsTo('/stock/symbol')[0]!
    expect(call.headers['x-finnhub-token']).toBe(TEST_KEY)
    // 密钥不进 URL（官方也允许 token 查询参数，本包刻意不用）
    expect(call.url).not.toContain(TEST_KEY)
    expect(call.params.get('token')).toBeNull()
  })

  it('an explicit apiKey wins over the environment variable', async () => {
    const { fake, connector } = make({ apiKey: 'option-key' })
    await connector.start()
    expect(fake.callsTo('/stock/symbol')[0]!.headers['x-finnhub-token']).toBe('option-key')
  })

  it('refuses to construct without a key and names the variable, never a key value', () => {
    let caught: unknown
    try {
      new FinnhubDataConnector({ baseUrl: BASE, fetchImpl: new FakeFinnhub().fetch, env: {} })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(ProblemError)
    const problem = (caught as ProblemError).problem
    expect(problem).toMatchObject({ name: 'INVALID_PARAMS', retryable: false })
    expect(problem.message).toContain('FINNHUB_API_KEY')
  })

  it('treats a blank environment value as missing', () => {
    expect(() => new FinnhubDataConnector({ baseUrl: BASE, fetchImpl: new FakeFinnhub().fetch, env: { FINNHUB_API_KEY: '   ' } }))
      .toThrow(ProblemError)
  })
})

describe('error mapping', () => {
  it('maps 401 to VENUE_AUTH without retrying', async () => {
    const fake = new FakeFinnhub()
    fake.override.set('/stock/symbol', () => json({ error: 'Invalid API key.' }, 401))
    const connector = new FinnhubDataConnector({
      baseUrl: BASE, fetchImpl: fake.fetch, clock: () => FX_NOW, env: { FINNHUB_API_KEY: TEST_KEY },
    })
    const problem = await failureOf(() => connector.start())
    expect(problem.problem).toMatchObject({ name: 'VENUE_AUTH', retryable: false, venue: { id: 'finnhub', code: 401 } })
  })

  it('maps 403 (endpoint outside the plan) to VENUE_AUTH and says so', async () => {
    const { fake, connector } = make()
    fake.override.set('/stock/bidask', () => json({ error: 'You do not have access to this resource.' }, 403))
    const problem = await failureOf(() => connector.book('finnhub:AAPL'))
    expect(problem.problem.name).toBe('VENUE_AUTH')
    expect(problem.problem.message).toContain('plan coverage')
  })

  it('maps 403 on the premium /stock/candle endpoint to VENUE_AUTH without retrying', async () => {
    const { fake, connector } = make()
    fake.override.set('/stock/candle', () => json({ error: 'You do not have access to this resource.' }, 403))
    const problem = await failureOf(() => connector.candles('finnhub:AAPL', '1d', { n: 10 }))
    expect(problem.problem.name).toBe('VENUE_AUTH')
    expect(problem.problem.retryable).not.toBe(true)
    expect(fake.callsTo('/stock/candle')).toHaveLength(1)
  })

  it('maps 404 to INVALID_PARAMS', async () => {
    const { fake, connector } = make()
    fake.override.set('/quote', () => json({ error: 'not found' }, 404))
    const problem = await failureOf(() => connector.refreshQuote('finnhub:NOPE'))
    expect(problem.problem).toMatchObject({ name: 'INVALID_PARAMS', retryable: false })
  })

  it('redacts the api key if the upstream echoes it back in an error body', async () => {
    const { fake, connector } = make()
    fake.override.set('/quote', () => json({ error: `bad key ${TEST_KEY}` }, 500))
    const problem = await failureOf(() => connector.refreshQuote('finnhub:AAPL'))
    const text = JSON.stringify(problem.problem)
    expect(text).not.toContain(TEST_KEY)
    expect(text).toContain('<redacted>')
  })
})
