// SPDX-License-Identifier: CPAL-1.0
// 测试脚手架：把连接器接到假服务器（固定时钟、不退避的预算），并提供账户引用与常用构造器。
import type { AccountId } from '@gitrader/protocol'
import type { AccountRef, TradeContext } from '@gitrader/protocol/connector'
import { createCountBudget } from '../../src/budget'
import type { BitgetBudget } from '../../src/budget'
import { BitgetTradeConnector } from '../../src/connector'
import type { BitgetTradeConnectorOptions } from '../../src/connector'
import type { BitgetAccounts } from '../../src/account'
import type { BitgetTrading } from '../../src/trading'
import { API_KEY, API_SECRET, BASE_URL, NOW, PASSPHRASE } from './fake-bitget'
import type { FakeBitget } from './fake-bitget'

export const ACCOUNT_ID = 'acct_bitget_test' as AccountId
export const ADDRESS = '0x0000000000000000000000000000000000000001' as const

export const accountRef: AccountRef = { accountId: ACCOUNT_ID, address: ADDRESS }

/** 固定时钟 + 模拟窗口推进的预算：测试只看行为，不等真实时间（超配额时把预算时钟向前拨）。 */
export function fixedBudget(over: { limit?: number; orderLimit?: number } = {}): BitgetBudget {
  let now = NOW
  return createCountBudget({
    clock: () => now,
    sleep: async (ms: number) => { now += ms },
    ...(over.limit !== undefined ? { limit: over.limit } : {}),
    ...(over.orderLimit !== undefined ? { orderLimit: over.orderLimit } : {}),
  })
}

export interface TestConnector {
  connector: BitgetTradeConnector
  accounts: BitgetAccounts
  trading: BitgetTrading
  budget: BitgetBudget
}

export function makeConnector(fake: FakeBitget, over: Partial<BitgetTradeConnectorOptions> = {}): TestConnector {
  const budget = over.budget ?? fixedBudget()
  const connector = new BitgetTradeConnector({
    environment: 'mainnet',
    baseUrl: BASE_URL,
    apiKey: API_KEY,
    apiSecret: API_SECRET,
    passphrase: PASSPHRASE,
    fetchImpl: fake.fetch,
    clock: () => NOW,
    budget,
    ...over,
  })
  return { connector, accounts: connector.accounts as BitgetAccounts, trading: connector.trading as BitgetTrading, budget }
}

/** 一个最小的 TradeContext（没有签名器：Bitget 用 API key，不需要它）。 */
export function tradeContext(over: Partial<TradeContext> = {}): TradeContext {
  return { account: accountRef, signer: { kind: 'none' } as unknown as TradeContext['signer'], ...over }
}

/** 干净的错误断言：拿到 ProblemError 里的 Problem。 */
export async function problemOf(fn: () => Promise<unknown>): Promise<{ code: number; name: string; message: string; retryable: boolean }> {
  try {
    await fn()
  } catch (e) {
    const problem = (e as { problem?: { code: number; name: string; message: string; retryable: boolean } }).problem
    if (problem) return problem
    throw e
  }
  throw new Error('expected the call to throw')
}
