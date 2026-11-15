// SPDX-License-Identifier: CPAL-1.0
// 场所时钟：所有时间判断只从注入的时钟取，测试可以推进时间。
//   · Alpaca 的请求头**不含时间戳**（鉴权是密钥对，不是 HMAC），所以这里不需要签名时间同步；
//   · 但交易时段、报价年龄、成交回补窗口都要「现在」，因此统一走 VenueClock；
//   · 用上游 `GET /v2/clock` 的 timestamp 重校偏移（官方 Trading API v2；QD 未用该端点，见 README 端点表）。
import type { Ms } from '@gitrader/protocol'

/** 时钟偏移告警阈值：超过就告警（不含任何密钥）。 */
export const CLOCK_SKEW_WARN_MS = 10_000

export class VenueClock {
  private offsetMs = 0
  private lastSyncAt: Ms | null = null

  constructor(private readonly clock: () => number = () => Date.now()) {}

  /** 校准后的毫秒时间。 */
  now(): Ms {
    return Math.round(this.clock() + this.offsetMs)
  }

  /** 未校准的本地时间（诊断用）。 */
  local(): Ms {
    return Math.round(this.clock())
  }

  get offset(): number {
    return this.offsetMs
  }

  get syncedAt(): Ms | null {
    return this.lastSyncAt
  }

  /** 用场所时间重校：offset = serverTime - 本地时间。非有限 / 非正数忽略。 */
  resync(serverTimeMs: number): void {
    if (!Number.isFinite(serverTimeMs) || serverTimeMs <= 0) return
    this.offsetMs = Math.round(serverTimeMs - this.clock())
    this.lastSyncAt = this.clock()
  }

  skewed(): boolean {
    return Math.abs(this.offsetMs) > CLOCK_SKEW_WARN_MS
  }
}
