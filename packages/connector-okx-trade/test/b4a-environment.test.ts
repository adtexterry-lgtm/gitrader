// SPDX-License-Identifier: CPAL-1.0
import { describe, expect, it } from 'vitest'
import { makeProblem } from '@gitrader/protocol'
import { ProblemError } from '../src/errors'
import { OkxTradeConnector, defaultBudget } from '../src/connector'
import { OkxHttp } from '../src/rest'
import { API_KEY, API_SECRET, BASE_URL, FakeOkxTrade, NOW, PASSPHRASE } from './helpers/fake-okx-trade'

function options(environment?: unknown) {
  return {
    ...(environment !== undefined ? { environment } : {}),
    apiKey: API_KEY,
    apiSecret: API_SECRET,
    passphrase: PASSPHRASE,
    baseUrl: BASE_URL,
    fetchImpl: new FakeOkxTrade().fetch,
    clock: () => NOW,
  }
}

function expectInvalid(action: () => unknown): void {
  let caught: unknown
  try {
    action()
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(ProblemError)
  expect((caught as ProblemError).problem).toEqual(makeProblem('INVALID_PARAMS', 'environment must be mainnet or testnet'))
}

describe('B4a OKX environment validation', () => {
  it('rejects every explicit value outside mainnet and testnet through HTTP and connector constructors', () => {
    for (const environment of ['demo', 'constructor', '__proto__', null, 1]) {
      expectInvalid(() => new OkxHttp(options(environment) as never))
      expectInvalid(() => new OkxTradeConnector({
        ...options(environment),
        budget: defaultBudget(() => NOW),
        onWarn: () => {},
      } as never))
    }
  })

  it('defaults only undefined to mainnet and accepts both declared environments with baseUrl override', () => {
    const defaultHttp = new OkxHttp(options() as never)
    expect(defaultHttp.environment).toBe('mainnet')
    for (const environment of ['mainnet', 'testnet'] as const) {
      const http = new OkxHttp(options(environment) as never)
      expect(http.environment).toBe(environment)
      expect(http.baseUrl).toBe(BASE_URL)
      const connector = new OkxTradeConnector({
        ...options(environment),
        budget: defaultBudget(() => NOW),
        onWarn: () => {},
      } as never)
      expect(connector.environment).toBe(environment)
      expect(connector.http.environment).toBe(environment)
      expect(connector.http.baseUrl).toBe(BASE_URL)
    }
  })
})
