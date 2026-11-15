// SPDX-License-Identifier: CPAL-1.0
// 只读：11 个交易 / 账户方法一律抛 CAPABILITY_UNSUPPORTED，且一个 HTTP 请求都不发。
import { describe, expect, it } from 'vitest'
import { AlphaVantageDataConnector } from '../src/connector'
import { ProblemError } from '../src/parse'
import { API_KEY, FX_NOW, FakeAlphaVantage, HOST } from './helpers/fake-alphavantage'

const ID = 'alphavantage:AAPL'

const TRADE_CALLS: Array<[string, unknown[]]> = [
  ['submit', [{}, [{ instrumentId: ID }]]],
  ['cancel', [{}, [{ instrumentId: ID }]]],
  ['cancelAll', [{}, ID]],
  ['amend', [{}, { instrumentId: ID }]],
  ['setLeverage', [{}, ID, 5, 'cross']],
  ['scheduleCancel', [{}, null]],
]

const ACCOUNT_CALLS: Array<[string, unknown[]]> = [
  ['accountState', [{}]],
  ['openOrders', [{}]],
  ['fills', [{}, FX_NOW]],
  ['orderStatus', [{}, {}]],
  ['startupSnapshot', [{}, FX_NOW]],
]

function make(): { fake: FakeAlphaVantage; connector: AlphaVantageDataConnector } {
  const fake = new FakeAlphaVantage()
  const connector = new AlphaVantageDataConnector({
    apiKey: API_KEY, baseUrl: `http://${HOST}`, fetchImpl: fake.fetch, clock: () => FX_NOW,
  })
  return { fake, connector }
}

describe('read-only surface', () => {
  it('every trading and account method throws CAPABILITY_UNSUPPORTED with the read-only message', () => {
    const { fake, connector } = make()
    const loose = connector as unknown as Record<string, (...args: unknown[]) => unknown>

    for (const [name, args] of [...TRADE_CALLS, ...ACCOUNT_CALLS]) {
      expect(typeof loose[name], name).toBe('function')
      let caught: unknown
      try {
        loose[name]!(...args)
      } catch (e) {
        caught = e
      }
      expect(caught, name).toBeInstanceOf(ProblemError)
      const problem = (caught as ProblemError).problem
      expect(problem.name, name).toBe('CAPABILITY_UNSUPPORTED')
      expect(problem.message, name).toBe('alphavantage data connector is read-only')
      expect(problem.retryable, name).toBe(false)
    }
    expect(fake.calls).toHaveLength(0)
  })

  it('has no WebSocket surface: status() always reports the rest source', async () => {
    const { connector } = make()
    expect(connector.status().source).toBe('rest')
    expect(connector.status().wsState).toBe('disconnected')
    await connector.start()
    expect(connector.status().source).toBe('rest')
  })
})
