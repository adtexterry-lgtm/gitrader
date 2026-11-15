// SPDX-License-Identifier: CPAL-1.0
import type { AccountSnapshot } from '../connector'
import type { StartupSnapshot } from '@gitrader/protocol/connector'
import type { Decimal } from '../proto'

/**
 * 交易侧（风控、接管、对账、工作台汇总）看到的观察账户：永远是空账户，没有持仓、没有挂单。
 * 这样接管全撤 / 全平遇到观察账户是"无事可做"而不是报错；真实的持仓只经 WatchReader 给只读查询用。
 */
export function emptyWatchSnapshot(accountId: string, ts: number): AccountSnapshot {
  return { accountId, ts, equity: '0' as Decimal, available: '0' as Decimal, positions: [], openOrders: [], asOf: ts }
}

/** 启动对账 / 观察快照用的空视图：新鲜、完整、没有任何东西（观察账户在交易侧本来就一无所有）。 */
export function emptyWatchStartup(accountId: string, ts: number, fillsSince: number): StartupSnapshot {
  const margin = { accountId, model: 'standard', valuationCcy: 'USDC', equity: '0', initialMargin: '0', maintenanceMargin: '0', available: '0', marginRatio: '0', leverage: 0, ts } as unknown as StartupSnapshot['account']['margin']
  return { account: { accountModel: 'standard', balances: [], margin, positions: [], ts, asOf: ts, confirmedAt: ts, stale: false }, openOrders: [], fills: [], fillsSince, truncated: false }
}
