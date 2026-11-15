// SPDX-License-Identifier: CPAL-1.0
// 只读：交易 / 账户 11 方法一律抛 CAPABILITY_UNSUPPORTED，且一个 HTTP 请求都不发。
import { describe, expect, it } from 'vitest'
import { DydxDataConnector } from '../src/connector'
import { ProblemError } from '../src/parse'
import { FakeDydx, FX_NOW } from './helpers/fake-dydx'

const BASE = 'http://dydx.example.test'

const TRADE_CALLS: Array<[string, unknown[]]> = [
  ['submit', [{}, [{ instrumentId: 'dydx:BTC-USD' }]]],
  ['cancel', [{}, [{ instrumentId: 'dydx:BTC-USD' }]]],
  ['cancelAll', [{}, 'dydx:BTC-USD']],
  ['amend', [{}, { instrumentId: 'dydx:BTC-USD' }]],
  ['setLeverage', [{}, 'dydx:BTC-USD', 5, 'cross']],
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
  it('every trading and account method throws CAPABILITY_UNSUPPORTED with the venue message', () => {
    const fake = new FakeDydx()
    const connector = new DydxDataConnector({ baseUrl: BASE, fetchImpl: fake.fetch, clock: () => FX_NOW })
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
        message: 'dydx data connector is read-only',
      })
    }
    // 全部拒绝路径都不该联网
    expect(fake.calls).toHaveLength(0)
  })

  it('market reads still work after the refusals, and refusals never touch HTTP', async () => {
    const fake = new FakeDydx()
    const connector = new DydxDataConnector({ baseUrl: BASE, fetchImpl: fake.fetch, clock: () => FX_NOW })
    await connector.start()
    expect(fake.callsTo('/v4/perpetualMarkets')).toHaveLength(1)

    const loose = connector as unknown as Record<string, (...args: unknown[]) => unknown>
    for (const [name, args] of [...TRADE_CALLS, ...ACCOUNT_CALLS]) {
      expect(() => loose[name]!(...args), name).toThrow(ProblemError)
    }
    expect(fake.calls).toHaveLength(1)
    expect(connector.listInstruments().map((i) => i.instrumentId)).toContain('dydx:BTC-USD')
  })

  it('refuses to serve a closed connector instead of silently polling', async () => {
    const fake = new FakeDydx()
    const connector = new DydxDataConnector({ baseUrl: BASE, fetchImpl: fake.fetch, clock: () => FX_NOW })
    await connector.close()
    await expect(connector.start()).rejects.toMatchObject({ problem: { name: 'CAPABILITY_UNSUPPORTED' } })
    expect(() => connector.subscribe({ channel: 'quote', instrumentId: 'dydx:BTC-USD' }, () => {})).toThrow(
      /dydx data connector is closed/,
    )
    expect(fake.calls).toHaveLength(0)
  })
})
