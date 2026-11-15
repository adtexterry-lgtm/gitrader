// SPDX-License-Identifier: CPAL-1.0
// 环境与密钥：paper / live 由配置显式声明、基址随之决定；密钥前缀 PK = 模拟、AK = 实盘，前缀与声明不符 → 构造时拒绝。
// 密钥只从构造参数 / 环境变量进，私有字段保存，不打印、不落盘、不进错误信息。
import { inspect } from 'node:util'
import { describe, expect, it } from 'vitest'
import { AlpacaDataConnector } from '../src/connector'
import { ProblemError, TRADING_LIVE_HOST, TRADING_PAPER_HOST } from '../src/parse'
import { DATA_HOST, FX_NOW, FakeAlpaca, TRADING_HOST } from './helpers/fake-alpaca'

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

const problemOf = (fn: () => unknown): ProblemError => {
  try {
    fn()
  } catch (e) {
    expect(e).toBeInstanceOf(ProblemError)
    return e as ProblemError
  }
  throw new Error('expected a ProblemError')
}

const problemOfAsync = async (fn: () => Promise<unknown>): Promise<ProblemError> => {
  try {
    await fn()
  } catch (e) {
    expect(e).toBeInstanceOf(ProblemError)
    return e as ProblemError
  }
  throw new Error('expected a ProblemError')
}

describe('environment / credential rules', () => {
  it('accepts PK keys for a declared paper environment and sends them as Alpaca auth headers', async () => {
    const { fake, connector } = make({ environment: 'paper', keyId: 'PKFAKEKEY', secretKey: 'fakesecret' })
    expect(connector.alpacaEnvironment).toBe('paper')
    await connector.start()
    await connector.candles('alpaca:AAPL', '1m', { n: 1 })

    for (const call of fake.calls) {
      expect(call.headers['apca-api-key-id']).toBe('PKFAKEKEY')
      expect(call.headers['apca-api-secret-key']).toBe('fakesecret')
    }
  })

  it('accepts AK keys for a declared live environment', async () => {
    const { connector } = make({ environment: 'live', keyId: 'AKFAKEKEY', secretKey: 'fakesecret' })
    expect(connector.alpacaEnvironment).toBe('live')
    expect(connector.describe()['x-environment']).toBe('live')
  })

  it('rejects a paper key when the environment is live (and never echoes the key)', () => {
    const problem = problemOf(() => make({ environment: 'live', keyId: 'PKFAKEKEY', secretKey: 'fakesecret' }))
    expect(problem.problem.name).toBe('INVALID_PARAMS')
    expect(problem.message).toMatch(/key prefix says paper but environment is live/)
    expect(problem.message).not.toContain('PKFAKEKEY')
    expect(problem.message).not.toContain('fakesecret')
  })

  it('rejects a live key when the environment is paper', () => {
    const problem = problemOf(() => make({ environment: 'paper', keyId: 'AKFAKEKEY', secretKey: 'fakesecret' }))
    expect(problem.message).toMatch(/key prefix says live but environment is paper/)
  })

  it('rejects an unrecognised key prefix and a half-configured credential pair', () => {
    expect(problemOf(() => make({ keyId: 'ZZ123', secretKey: 's' })).message)
      .toMatch(/neither PK \(paper\) nor AK \(live\)/)
    expect(problemOf(() => make({ keyId: 'PKONLY' })).message).toMatch(/both keyId and secretKey/)
    expect(problemOf(() => make({ secretKey: 'only-secret' })).message).toMatch(/both keyId and secretKey/)
  })

  it('reads credentials from the injected environment instead of the real process env', async () => {
    const { fake, connector } = make({
      environment: 'paper',
      env: { ALPACA_API_KEY_ID: 'PKFROMENV', ALPACA_API_SECRET_KEY: 'secret-from-env' },
    })
    await connector.market.refreshMarketClock()
    expect(fake.calls[0]!.headers['apca-api-key-id']).toBe('PKFROMENV')
  })

  it('works without credentials (no auth headers) so public / anonymous use is explicit', async () => {
    const { fake, connector } = make()
    await connector.start()
    expect(fake.calls.every((c) => c.headers['apca-api-key-id'] === undefined)).toBe(true)
    expect(connector.market.http.authenticated).toBe(false)
  })

  it('refuses to point a paper declaration at the live trading host (paper / live must not be mixed)', () => {
    expect(problemOf(() => make({ environment: 'paper', tradingBaseUrl: `https://${TRADING_LIVE_HOST}` })).message)
      .toMatch(/paper \/ live must not be mixed/)
    expect(problemOf(() => make({ environment: 'live', tradingBaseUrl: `https://${TRADING_PAPER_HOST}` })).message)
      .toMatch(/paper \/ live must not be mixed/)
  })

  it('defaults the trading host from the declared environment when no override is given', () => {
    const paper = new AlpacaDataConnector({ fetchImpl: new FakeAlpaca().fetch, clock: () => FX_NOW })
    expect(paper.market.http.tradingBaseUrl).toBe(`https://${TRADING_PAPER_HOST}`)
    const live = new AlpacaDataConnector({ environment: 'live', keyId: 'AKFAKE', secretKey: 's', fetchImpl: new FakeAlpaca().fetch })
    expect(live.market.http.tradingBaseUrl).toBe(`https://${TRADING_LIVE_HOST}`)
    // 数据主机 paper / live 共用（源只由 feed 决定）
    expect(live.market.http.dataBaseUrl).toBe('https://data.alpaca.markets')
  })

  it('exposes no key material through util.inspect, even with hidden fields shown', () => {
    const keyId = 'PKFAKEINSPECTKEY'
    const secretKey = 'fake-inspect-secret-value'
    const { connector } = make({ environment: 'paper', keyId, secretKey })
    const dumped = inspect(connector, { depth: 8, showHidden: true })
    expect(dumped).not.toContain(keyId)
    expect(dumped).not.toContain(secretKey)
  })

  it('keeps secrets out of error text when the venue echoes them back in a 401 body', async () => {
    const keyId = 'PKFAKE401KEY'
    const secretKey = 'fake-401-secret-value'
    const { fake, connector } = make({ environment: 'paper', keyId, secretKey })
    fake.override.set(`${TRADING_HOST}/v2/clock`, () => new Response(
      JSON.stringify({ code: 40110000, message: `access denied: key_id=${keyId} secret=${secretKey}` }),
      { status: 401, headers: { 'content-type': 'application/json' } },
    ))

    const err = await problemOfAsync(() => connector.refreshMarketClock())
    expect(err.problem.name).toBe('VENUE_AUTH')
    for (const text of [String(err), err.problem.message, err.problem.venue?.message ?? '']) {
      expect(text).not.toContain(secretKey)
      expect(text).not.toContain(keyId)
    }
  })
})
