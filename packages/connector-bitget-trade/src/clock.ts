// SPDX-License-Identifier: CPAL-1.0
// 场所时钟：Bitget 签名把 ACCESS-TIMESTAMP 放进预签串（QD bitget.py:198-201），时钟偏差直接变成签名被拒
// （QD 错误分类里 clock_skew 是一等类，见 venue-errors.ts 的 CLOCK_TOKENS）。
//   · 时间戳只从注入的时钟取，不直接 Date.now()（测试可推进时间）；
//   · 用服务端时间重校偏移；偏差 > 10 s 时按频段告警（不含任何密钥）；
//   · 时间戳是毫秒整数字符串（Bitget 要求）。
import type { Ms } from '@gitrader/protocol'

export const CLOCK_SKEW_WARN_MS = 10_000

export class VenueClock {
  private offsetMs = 0
  private lastSyncAt: Ms | null = null

  constructor(private readonly clock: () => number = () => Date.now()) {}

  /** 校准后的毫秒时间（本地时钟 + 偏移）。 */
  now(): Ms {
    return Math.round(this.clock() + this.offsetMs)
  }

  /** ACCESS-TIMESTAMP：毫秒整数字符串。 */
  timestamp(): string {
    return String(this.now())
  }

  /** 当前偏移（诊断用）。 */
  get offset(): number {
    return this.offsetMs
  }

  /** 上次校准时刻（0 / null = 还没校准）。 */
  get syncedAt(): Ms | null {
    return this.lastSyncAt
  }

  /** 用场所时间重校：offset = serverTime - 本地时间。非有限 / 非正数忽略。 */
  resync(serverTimeMs: number): void {
    if (!Number.isFinite(serverTimeMs) || serverTimeMs <= 0) return
    this.offsetMs = Math.round(serverTimeMs - this.clock())
    this.lastSyncAt = this.clock()
  }

  /** 偏差是否超过告警阈值。 */
  skewed(): boolean {
    return Math.abs(this.offsetMs) > CLOCK_SKEW_WARN_MS
  }
}
