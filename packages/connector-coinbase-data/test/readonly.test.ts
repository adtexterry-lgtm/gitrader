// SPDX-License-Identifier: CPAL-1.0
// 只读：交易 / 账户 11 方法一律抛 CAPABILITY_UNSUPPORTED，且一个 HTTP 请求都不发。
import { describe, expect, it } from 'vitest'
import { CoinbaseDataConnector } from '../src/connector'
import { ProblemError } from '../src/parse'
import { FakeCoinbase, FX_NOW } from './helpers/fake-coinbase'

const ID = 'coinbase:BTC-USD'

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

function make() {
  const fake = new FakeCoinbase()
  const connector = new CoinbaseDataConnector({ fetchImpl: fake.fetch, clock: () => FX_NOW })
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
      const problem = (caught as ProblemError).problem
      expect(problem, name).toMatchObject({
        name: 'CAPABILITY_UNSUPPORTED', code: 5002, category: 'PROTOCOL', retryable: false,
        message: 'coinbase data connector is read-only',
      })
    }
    // 全部拒绝路径都不该联网
    expect(fake.calls).toHaveLength(0)
  })

  it('market reads still work after the refusals, and refusals never touch HTTP', async () => {
    const { fake, connector } = make()
    await connector.start()
    expect(fake.callsTo('/api/v3/brokerage/market/products')).toHaveLength(1)

    const loose = connector as unknown as Record<string, (...args: unknown[]) => unknown>
    for (const [name, args] of [...TRADE_CALLS, ...ACCOUNT_CALLS]) {
      expect(() => loose[name]!(...args)).toThrow(ProblemError)
    }
    expect(fake.calls).toHaveLength(1)
    expect(connector.listInstruments().map((i) => i.instrumentId)).toContain(ID)
  })

  it('declares no tradable surface in the instrument catalogue either', async () => {
    const { connector } = make()
    await connector.start()
    const instrument = connector.getInstrument(ID)!
    expect(instrument.orderTypes).toEqual([])
    expect(instrument.tif).toEqual([])
    expect(instrument.triggerPriceTypes).toEqual([])
  })
})
