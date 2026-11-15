// SPDX-License-Identifier: CPAL-1.0
// 密钥与错误信封：key 只走 `Authorization: apikey <key>` 请求头（不进 URL）；缺失即拒绝；
// 官方 {code,message,status:"error"} 信封（HTTP 200 也可能带）按码表映射；错误文本里的密钥被脱敏。
import { describe, expect, it } from 'vitest'
import { TwelveDataDataConnector } from '../src/connector'
import { ProblemError } from '../src/parse'
import { FakeTwelveData, FX_NOW, TEST_KEY, errorJson, json } from './helpers/fake-twelvedata'

const BASE = 'https://twelvedata.example.test'

function make(o: Record<string, unknown> = {}) {
  const fake = new FakeTwelveData()
  const connector = new TwelveDataDataConnector({
    baseUrl: BASE, fetchImpl: fake.fetch, clock: () => FX_NOW, env: { TWELVEDATA_API_KEY: TEST_KEY }, ...o,
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
  it('reads the key from TWELVEDATA_API_KEY and sends it in the Authorization header', async () => {
    const { fake, connector } = make()
    await connector.start()
    const call = fake.callsTo('/stocks')[0]!
    expect(call.headers.authorization).toBe(`apikey ${TEST_KEY}`)
    // 密钥不进 URL（官方也支持 apikey 查询参数，本包刻意不用）
    expect(call.url).not.toContain(TEST_KEY)
    expect(call.params.get('apikey')).toBeNull()
  })

  it('an explicit apiKey wins over the environment variable', async () => {
    const { fake, connector } = make({ apiKey: 'option-key' })
    await connector.start()
    expect(fake.callsTo('/stocks')[0]!.headers.authorization).toBe('apikey option-key')
  })

  it('refuses to construct without a key and names the variable, never a key value', () => {
    let caught: unknown
    try {
      new TwelveDataDataConnector({ baseUrl: BASE, fetchImpl: new FakeTwelveData().fetch, env: {} })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(ProblemError)
    const problem = (caught as ProblemError).problem
    expect(problem).toMatchObject({ name: 'INVALID_PARAMS', retryable: false })
    expect(problem.message).toContain('TWELVEDATA_API_KEY')
  })

  it('treats a blank environment value as missing', () => {
    expect(() => new TwelveDataDataConnector({ baseUrl: BASE, fetchImpl: new FakeTwelveData().fetch, env: { TWELVEDATA_API_KEY: ' ' } }))
      .toThrow(ProblemError)
  })
})

describe('error envelope', () => {
  it('maps an HTTP 401 envelope to VENUE_AUTH without retrying', async () => {
    const fake = new FakeTwelveData()
    fake.override.set('/stocks', () => errorJson(401, 'Invalid API key', 401))
    const connector = new TwelveDataDataConnector({
      baseUrl: BASE, fetchImpl: fake.fetch, clock: () => FX_NOW, env: { TWELVEDATA_API_KEY: TEST_KEY },
    })
    const problem = await failureOf(() => connector.start())
    expect(problem.problem).toMatchObject({ name: 'VENUE_AUTH', retryable: false, venue: { id: 'twelvedata', code: 401 } })
  })

  it('maps a 403 envelope delivered with HTTP 200 to VENUE_AUTH (official allows status:"error" on 200)', async () => {
    const { fake, connector } = make()
    fake.override.set('/market_state', () => errorJson(403, 'This endpoint is not available in your plan'))
    const problem = await failureOf(() => connector.marketState())
    expect(problem.problem).toMatchObject({ name: 'VENUE_AUTH', retryable: false, venue: { code: 403 } })
  })

  it('maps a 400 envelope to INVALID_PARAMS and keeps the vendor message', async () => {
    const { fake, connector } = make()
    fake.override.set('/quote', () => errorJson(400, 'Invalid symbol parameter'))
    const problem = await failureOf(() => connector.refreshQuote('twelvedata:NOPE'))
    expect(problem.problem).toMatchObject({ name: 'INVALID_PARAMS', retryable: false })
    expect(JSON.stringify(problem.problem)).toContain('Invalid symbol parameter')
  })

  it('redacts the api key if the upstream echoes it back', async () => {
    const { fake, connector } = make()
    fake.override.set('/quote', () => json({ code: 500, message: `boom ${TEST_KEY}`, status: 'error' }, 500))
    const problem = await failureOf(() => connector.refreshQuote('twelvedata:AAPL'))
    const text = JSON.stringify(problem.problem)
    expect(text).not.toContain(TEST_KEY)
    expect(text).toContain('<redacted>')
  })
})
