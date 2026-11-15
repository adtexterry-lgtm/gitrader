// SPDX-License-Identifier: CPAL-1.0
// 只读：11 个交易 / 账户方法一律抛 CAPABILITY_UNSUPPORTED，且一个 HTTP 请求都不发。
import { describe, expect, it } from 'vitest'
import { TwelveDataDataConnector } from '../src/connector'
import { ProblemError } from '../src/parse'
import { FakeTwelveData, FX_NOW } from './helpers/fake-twelvedata'

const TRADE_CALLS: Array<[string, unknown[]]> = [
  ['submit', [{}, [{ instrumentId: 'twelvedata:AAPL' }]]],
  ['cancel', [{}, [{ instrumentId: 'twelvedata:AAPL' }]]],
  ['cancelAll', [{}, 'twelvedata:AAPL']],
  ['amend', [{}, { instrumentId: 'twelvedata:AAPL' }]],
  ['setLeverage', [{}, 'twelvedata:AAPL', 5, 'cross']],
  ['scheduleCancel', [{}, null]],
]

const ACCOUNT_CALLS: Array<[string, unknown[]]> = [
  ['accountState', [{}]],
  ['openOrders', [{}]],
  ['fills', [{}, FX_NOW]],
  ['orderStatus', [{}, {}]],
  ['startupSnapshot', [{}, FX_NOW]],
]

function make() {
  const fake = new FakeTwelveData()
  const connector = new TwelveDataDataConnector({
    baseUrl: 'https://twelvedata.example.test', fetchImpl: fake.fetch, clock: () => FX_NOW,
    env: { TWELVEDATA_API_KEY: 'test-twelvedata-key' },
  })
  return { fake, connector }
}

describe('read-only surface', () => {
  it('every trading and account method throws CAPABILITY_UNSUPPORTED', () => {
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
      expect((caught as ProblemError).problem, name).toMatchObject({
        name: 'CAPABILITY_UNSUPPORTED', code: 5002, category: 'PROTOCOL', retryable: false,
        message: 'twelvedata data connector is read-only',
      })
    }
    expect(fake.calls).toHaveLength(0)
  })

  it('market reads still work after the refusals, and refusals never touch HTTP', async () => {
    const { fake, connector } = make()
    await connector.start()
    expect(fake.callsTo('/stocks')).toHaveLength(1)

    const loose = connector as unknown as Record<string, (...args: unknown[]) => unknown>
    for (const [name, args] of [...TRADE_CALLS, ...ACCOUNT_CALLS]) {
      expect(() => loose[name]!(...args)).toThrow(ProblemError)
    }
    expect(fake.calls).toHaveLength(1)
    expect(connector.listInstruments().map((i) => i.instrumentId)).toContain('twelvedata:AAPL')
  })
})
