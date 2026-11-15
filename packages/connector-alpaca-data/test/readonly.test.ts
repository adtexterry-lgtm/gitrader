// SPDX-License-Identifier: CPAL-1.0
// 只读：11 个交易 / 账户方法一律抛 CAPABILITY_UNSUPPORTED，且一个 HTTP 请求都不发。
import { describe, expect, it } from 'vitest'
import { AlpacaDataConnector } from '../src/connector'
import { ProblemError } from '../src/parse'
import { DATA_HOST, FX_NOW, FakeAlpaca, TRADING_HOST } from './helpers/fake-alpaca'

const ID = 'alpaca:AAPL'

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

function make(o: Record<string, unknown> = {}): { fake: FakeAlpaca; connector: AlpacaDataConnector } {
  const fake = new FakeAlpaca()
  const connector = new AlpacaDataConnector({
    tradingBaseUrl: `http://${TRADING_HOST}`,
    dataBaseUrl: `http://${DATA_HOST}`,
    fetchImpl: fake.fetch,
    clock: () => FX_NOW,
    ...o,
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
      expect((caught as ProblemError).problem, name).toMatchObject({
        name: 'CAPABILITY_UNSUPPORTED', code: 5002, category: 'PROTOCOL', retryable: false,
        message: 'alpaca data connector is read-only',
      })
    }
    expect(fake.calls).toHaveLength(0)
  })

  it('keeps serving market reads after the refusals, and refusals never touch HTTP', async () => {
    const { fake, connector } = make()
    await connector.start()
    const before = fake.calls.length

    const loose = connector as unknown as Record<string, (...args: unknown[]) => unknown>
    for (const [name, args] of [...TRADE_CALLS, ...ACCOUNT_CALLS]) expect(() => loose[name]!(...args)).toThrow(ProblemError)

    expect(fake.calls).toHaveLength(before)
    expect(connector.listInstruments().map((i) => i.instrumentId)).toContain(ID)
    expect(await connector.candles(ID, '1m', { n: 5 })).toHaveLength(5)
  })

  it('declares no tradable surface on the instruments either', async () => {
    const { connector } = make()
    await connector.start()
    const instrument = connector.getInstrument(ID)!
    expect(instrument.orderTypes).toEqual([])
    expect(instrument.tif).toEqual([])
    expect(instrument.triggerPriceTypes).toEqual([])
    expect(instrument.maxLeverage).toBeUndefined()
    expect(instrument.marginModes).toBeUndefined()
  })

  it('exposes no signing / key material on the connector (nothing to serialise by accident)', () => {
    const { connector } = make({ keyId: 'PKFAKEKEY', secretKey: 'fakesecretvalue' })
    const json = JSON.stringify(connector)
    expect(json).not.toContain('PKFAKEKEY')
    expect(json).not.toContain('fakesecretvalue')
    expect(Object.keys(connector)).toEqual(expect.arrayContaining(['venue', 'environment', 'market', 'budget']))
  })
})
