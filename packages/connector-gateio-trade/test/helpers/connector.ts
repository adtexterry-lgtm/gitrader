// SPDX-License-Identifier: CPAL-1.0
// 测试脚手架：把连接器接到假服务器（固定时钟、不退避的预算），并提供账户引用与常用构造器。
import type { AccountId } from '@gitrader/protocol'
import type { AccountRef, TradeContext } from '@gitrader/protocol/connector'
import { createWeightBudget } from '../../src/budget'
import type { GateBudget } from '../../src/budget'
import { GateioTradeConnector } from '../../src/connector'
import type { GateioTradeConnectorOptions } from '../../src/connector'
import type { GateAccounts } from '../../src/account'
import type { GateTrading } from '../../src/trading'
import { API_KEY, API_SECRET, BASE_URL, NOW } from './fake-gate'
import type { FakeGate } from './fake-gate'

export const ACCOUNT_ID = 'acct_gateio_test' as AccountId
export const ADDRESS = '0x0000000000000000000000000000000000000001' as const
export const INSTRUMENT = 'gateio:BTC_USDT'
export const ETH_INSTRUMENT = 'gateio:ETH_USDT'

export const accountRef: AccountRef = { accountId: ACCOUNT_ID, address: ADDRESS }

/** 固定时钟 + 永不等候的预算：测试只看行为，不等真实时间。 */
export function fixedBudget(over: { limit?: number; orderLimit?: number } = {}): GateBudget {
  return createWeightBudget({
    clock: () => NOW,
    sleep: async () => {},
    ...(over.limit !== undefined ? { limit: over.limit } : {}),
    ...(over.orderLimit !== undefined ? { orderLimit: over.orderLimit } : {}),
  })
}

export interface TestConnector {
  connector: GateioTradeConnector
  accounts: GateAccounts
  trading: GateTrading
  budget: GateBudget
}

export function makeConnector(fake: FakeGate, over: Partial<GateioTradeConnectorOptions> = {}): TestConnector {
  const budget = over.budget ?? fixedBudget()
  const connector = new GateioTradeConnector({
    environment: 'mainnet',
    baseUrl: BASE_URL,
    apiKey: API_KEY,
    apiSecret: API_SECRET,
    fetchImpl: fake.fetch,
    clock: () => NOW,
    budget,
    ...over,
  })
  return { connector, accounts: connector.accounts, trading: connector.trading, budget }
}

/** 一个最小的 TradeContext（没有签名器：Gate 用 API key，不需要它）。 */
export function tradeContext(over: Partial<TradeContext> = {}): TradeContext {
  return { account: accountRef, signer: { kind: 'none' } as unknown as TradeContext['signer'], ...over }
}

/** 干净的错误断言：拿到 ProblemError 里的 Problem。 */
export async function problemOf(fn: () => Promise<unknown>): Promise<{ code: number; name: string; message: string; retryable: boolean; venue?: { code?: string | number; message: string } }> {
  try {
    await fn()
  } catch (e) {
    const problem = (e as { problem?: { code: number; name: string; message: string; retryable: boolean } }).problem
    if (problem) return problem
    throw e
  }
  throw new Error('expected the call to throw')
}
