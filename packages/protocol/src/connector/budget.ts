// SPDX-License-Identifier: Apache-2.0
// 连接器接口 · 速率预算对象（HL：按 IP 的 REST 聚合权重 1200 / 分钟；契约 §1.5.1 rateLimits）。
// 预算对象由内核注入（同一台机器上所有连接共用一个）；实现不在本包。

export interface BudgetUsage {
  /** 窗口内已批准的权重。 */
  used: number
  /** 目标上限（limit × targetRatio）。 */
  target: number
  /** 场所硬上限（HL：1200）。 */
  limit: number
  /** used / limit：对外公布的「场所权重占用」。 */
  ratio: number
  windowMs: number
  /** 退避截止时刻（ms，0 = 无退避）。 */
  backoffUntil: number
}

export interface RateBudget {
  /** 等到预算够用再返回；预算由调用方在返回后立即视为已花掉。low 优先级只能用 target 的一部分，让位给交互请求。 */
  acquire(weight: number, opts?: { priority?: 'high' | 'low'; signal?: AbortSignal }): Promise<void>
  /** 事后补记权重（例如按返回条数追加的权重），不等待。 */
  charge(weight: number): void
  /** 收到 429：整体退避。 */
  penalize(retryAfterMs?: number): void
  /** 一次成功响应：清零连续退避计数。 */
  reportOk(): void
  usage(): BudgetUsage
}
