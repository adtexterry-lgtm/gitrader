// SPDX-License-Identifier: CPAL-1.0
// 只读：11 个交易 / 账户方法一律抛 CAPABILITY_UNSUPPORTED，且一个 HTTP 请求都不发。
import { describe, expect, it } from 'vitest'
import { FinnhubDataConnector } from '../src/connector'
import { ProblemError } from '../src/parse'
import { FakeFinnhub, FX_NOW } from './helpers/fake-finnhub'

const TRADE_CALLS: Array<[string, unknown[]]> = [
  ['submit', [{}, [{ instrumentId: 'finnhub:AAPL' }]]],
  ['cancel', [{}, [{ instrumentId: 'finnhub:AAPL' }]]],
  ['cancelAll', [{}, 'finnhub:AAPL']],
  ['amend', [{}, { instrumentId: 'finnhub:AAPL' }]],
  ['setLeverage', [{}, 'finnhub:AAPL', 5, 'cross']],
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
  const fake = new FakeFinnhub()
  const connector = new FinnhubDataConnector({
    baseUrl: 'https://finnhub.example.test/v1', fetchImpl: fake.fetch, clock: () => FX_NOW,
    env: { FINNHUB_API_KEY: 'test-finnhub-key' },
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
        message: 'finnhub data connector is read-only',
      })
    }
    expect(fake.calls).toHaveLength(0)
  })

  it('market reads still work after the refusals, and refusals never touch HTTP', async () => {
    const { fake, connector } = make()
    await connector.start()
    expect(fake.callsTo('/stock/symbol')).toHaveLength(1)

    const loose = connector as unknown as Record<string, (...args: unknown[]) => unknown>
    for (const [name, args] of [...TRADE_CALLS, ...ACCOUNT_CALLS]) {
      expect(() => loose[name]!(...args)).toThrow(ProblemError)
    }
    expect(fake.calls).toHaveLength(1)
    expect(connector.listInstruments().map((i) => i.instrumentId)).toContain('finnhub:AAPL')
  })
})
