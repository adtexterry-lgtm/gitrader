// SPDX-License-Identifier: CPAL-1.0
// 只读：交易 / 账户 11 方法一律抛 CAPABILITY_UNSUPPORTED，且一个 HTTP 请求都不发。
import { describe, expect, it } from 'vitest'
import { GateioDataConnector } from '../src/connector'
import { ProblemError } from '../src/parse'
import { FakeGateio, FX_NOW } from './helpers/fake-gateio'

const TRADE_CALLS: Array<[string, unknown[]]> = [
  ['submit', [{}, [{ instrumentId: 'gateio:BTC_USDT' }]]],
  ['cancel', [{}, [{ instrumentId: 'gateio:BTC_USDT' }]]],
  ['cancelAll', [{}, 'gateio:BTC_USDT']],
  ['amend', [{}, { instrumentId: 'gateio:BTC_USDT' }]],
  ['setLeverage', [{}, 'gateio:BTC_USDT', 5, 'cross']],
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
    const fake = new FakeGateio()
    const connector = new GateioDataConnector({ baseUrl: 'http://gateio.example.test', fetchImpl: fake.fetch, clock: () => FX_NOW })
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
        message: 'gateio data connector is read-only',
      })
    }
    // 全部拒绝路径都不该联网
    expect(fake.calls).toHaveLength(0)
  })

  it('market reads still work after the refusals, and refusals never touch HTTP', async () => {
    const fake = new FakeGateio()
    const connector = new GateioDataConnector({ baseUrl: 'http://gateio.example.test', fetchImpl: fake.fetch, clock: () => FX_NOW })
    await connector.start()
    expect(fake.callsTo('/api/v4/futures/usdt/contracts')).toHaveLength(1)

    const loose = connector as unknown as Record<string, (...args: unknown[]) => unknown>
    for (const [name, args] of [...TRADE_CALLS, ...ACCOUNT_CALLS]) {
      expect(() => loose[name]!(...args)).toThrow(ProblemError)
    }
    expect(fake.calls).toHaveLength(1)
    expect(connector.listInstruments().map((i) => i.instrumentId)).toContain('gateio:BTC_USDT')
  })
})
