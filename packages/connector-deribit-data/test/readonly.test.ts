// SPDX-License-Identifier: CPAL-1.0
// 只读：交易 / 账户方法一律抛 CAPABILITY_UNSUPPORTED，且一个 HTTP 请求都不发。
import { describe, expect, it } from 'vitest'
import { DeribitDataConnector } from '../src/connector'
import { ProblemError } from '../src/parse'
import { FakeDeribit, FX_NOW } from './helpers/fake-deribit'

const TRADE_CALLS: Array<[string, unknown[]]> = [
  ['submit', [{}, [{ instrumentId: 'deribit:BTC-PERPETUAL' }]]],
  ['cancel', [{}, [{ instrumentId: 'deribit:BTC-PERPETUAL' }]]],
  ['cancelAll', [{}, 'deribit:BTC-PERPETUAL']],
  ['amend', [{}, { instrumentId: 'deribit:BTC-PERPETUAL' }]],
  ['setLeverage', [{}, 'deribit:BTC-PERPETUAL', 5, 'cross']],
  ['scheduleCancel', [{}, null]],
]

const ACCOUNT_CALLS: Array<[string, unknown[]]> = [
  ['accountState', [{}]],
  ['openOrders', [{}]],
  ['fills', [{}, FX_NOW]],
  ['orderStatus', [{}, {}]],
  ['startupSnapshot', [{}, FX_NOW]],
]

describe('read-only surface', () => {
  it('every trading and account method throws CAPABILITY_UNSUPPORTED', () => {
    const fake = new FakeDeribit()
    const connector = new DeribitDataConnector({ fetchImpl: fake.fetch, clock: () => FX_NOW })
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
      expect(problem, name).toMatchObject({
        name: 'CAPABILITY_UNSUPPORTED', code: 5002, category: 'PROTOCOL', retryable: false,
        message: 'deribit data connector is read-only',
      })
    }
    // 全部拒绝路径都不该联网
    expect(fake.calls).toHaveLength(0)
  })

  it('market reads still work after the refusals, and refusals never touch HTTP', async () => {
    const fake = new FakeDeribit()
    const connector = new DeribitDataConnector({ fetchImpl: fake.fetch, clock: () => FX_NOW })
    await connector.start()
    expect(fake.callsTo('/api/v2/public/get_instruments')).toHaveLength(3)

    const loose = connector as unknown as Record<string, (...args: unknown[]) => unknown>
    for (const [name, args] of [...TRADE_CALLS, ...ACCOUNT_CALLS]) {
      expect(() => loose[name]!(...args)).toThrow(ProblemError)
    }
    expect(fake.calls).toHaveLength(3)
    expect(connector.listInstruments().map((i) => i.instrumentId)).toContain('deribit:BTC_USDC-PERPETUAL')
  })
})
