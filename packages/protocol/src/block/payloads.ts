// SPDX-License-Identifier: Apache-2.0
// 块 / 壳通过桥订阅与查询的主题载荷（契约 §4.2 只列了主题名，这里把块需要的两个定稿）。v0.1.6。
import type { Decimal, Ms } from '../model/decimal'
import type { AccountId } from '../model/ids'
import type { TradingState } from '../model/risk'

/** 可量化的限额项（RiskLimits / MandateLimits 里有"已用 / 上限"概念的那些）。 */
export const RISK_USAGE_KEYS = [
  'maxLeverage', 'maxOrderNotional', 'maxPositionNotionalRatio', 'maxTotalNotionalRatio', 'maxOpenPositions', 'maxDailyLossRatio',
  'maxDailyNotional', 'maxDailyLoss', 'maxOrdersPerMinute', 'maxDailyOrders', 'maxCancelsPerMinute',
] as const
export type RiskUsageKey = (typeof RISK_USAGE_KEYS)[number]

/** 一项限额的占用。used / limit 都是十进制字符串；ratio = used / limit（分数，limit 为 0 时省略）。 */
export interface RiskUsageItem {
  /** 限额名（RiskLimits / MandateLimits 的字段名；也允许 x- 前缀的扩展）。 */
  key: RiskUsageKey | `x-${string}`
  used: Decimal
  limit: Decimal
  /** 单位：USDC、x（杠杆倍数）、count、ratio …… */
  unit: string
  ratio?: Decimal
  /** 这项限额来自哪个作用域（account / mandate / org …），多个作用域取最严的那个。 */
  scope?: string
  /** 窗口：按日 / 按分钟 / 瞬时。 */
  window?: 'day' | 'minute' | 'now'
}

/**
 * `risk.state` 查询 / 主题的快照。内核可以多给字段（policy、presets …）；块只依赖这里列的。
 * v0.1.6 新增 `usage`：每项限额的已用 / 上限，风险状态块据此画占用条。
 */
export interface RiskStateSnapshot {
  tradingState: TradingState
  reasons?: unknown[]
  policyVersion?: number
  denyLlmLiveEntries?: boolean
  usage?: RiskUsageItem[]
  ts?: Ms
}

/**
 * `account.summary` 查询 / 主题的载荷。v0.1.6 新增 `dayStartEquity`：当日基线权益（`dailyResetAt` 时点的权益），
 * 块用它算当日盈亏（equity - dayStartEquity）。
 */
export interface AccountSummary {
  accountId: AccountId
  ts: Ms
  equity: Decimal
  available: Decimal
  positions?: number
  openOrders?: number
  /** 当日基线权益。缺省 = 内核尚未建立基线。 */
  dayStartEquity?: Decimal
}
