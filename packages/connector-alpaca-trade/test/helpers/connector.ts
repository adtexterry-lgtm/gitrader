// SPDX-License-Identifier: CPAL-1.0
// 测试脚手架：把连接器接到假服务器（可推进的固定时钟、不退避的预算），并提供账户引用与常用构造器。
import type { AccountId } from '@gitrader/protocol'
import type { AccountRef, TradeContext } from '@gitrader/protocol/connector'
import { createAlpacaBudget } from '../../src/budget'
import type { AlpacaBudget } from '../../src/budget'
import { AlpacaTradeConnector } from '../../src/connector'
import type { AlpacaTradeConnectorOptions } from '../../src/connector'
import type { AlpacaAccounts } from '../../src/account'
import type { AlpacaTrading } from '../../src/trading'
import { API_KEY, API_SECRET, BASE_URL, DATA_URL, NOW } from './fake-alpaca'
import type { FakeAlpaca } from './fake-alpaca'

export const ACCOUNT_ID = 'acct_alpaca_test' as AccountId
export const ADDRESS = '0x0000000000000000000000000000000000000001' as const

export const accountRef: AccountRef = { accountId: ACCOUNT_ID, address: ADDRESS }

/** 固定时钟 + 模拟窗口推进的预算：测试只看行为，不等真实时间（超配额时把预算时钟向前拨）。 */
export function fixedBudget(over: { limit?: number } = {}): AlpacaBudget {
  let now = NOW
  return createAlpacaBudget({
    clock: () => now,
    sleep: async (ms: number) => { now += ms },
    ...(over.limit !== undefined ? { limit: over.limit } : {}),
  })
}

export interface TestConnector {
  connector: AlpacaTradeConnector
  accounts: AlpacaAccounts
  trading: AlpacaTrading
  budget: AlpacaBudget
  /** 推进可注入的时钟（时段 / 报价年龄测试）。 */
  setNow: (ms: number) => void
  now: () => number
}

export function makeConnector(fake: FakeAlpaca, over: Partial<AlpacaTradeConnectorOptions> = {}): TestConnector {
  const budget = over.budget ?? fixedBudget()
  let now = NOW
  const clock = (): number => now
  const connector = new AlpacaTradeConnector({
    mode: 'paper',
    baseUrl: BASE_URL,
    dataBaseUrl: DATA_URL,
    apiKey: API_KEY,
    apiSecret: API_SECRET,
    fetchImpl: fake.fetch,
    clock,
    budget,
    ...over,
  })
  return {
    connector,
    accounts: connector.accounts,
    trading: connector.trading,
    budget,
    setNow: (ms: number) => { now = ms },
    now: () => now,
  }
}

/** 一个最小的 TradeContext（Alpaca 用 API key，不需要签名器）。 */
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

/** 取 OrderAck 的 problem（submit / amend 的拒单不是抛错，而是回执里的 problem）。 */
export function ackProblem(ack: { problem?: { code: number; name: string; message: string } } | undefined): { code: number; name: string; message: string } {
  if (ack?.problem === undefined) throw new Error('expected the ack to carry a problem')
  return ack.problem
}
