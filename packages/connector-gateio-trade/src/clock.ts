// SPDX-License-Identifier: CPAL-1.0
// 场所时钟：Gate.io apiv4 的 `Timestamp` 头是 **Unix 秒**，且直接进签名串
// （QD backend_api_python/app/services/live_trading/gate.py:81-83），偏差过大时场所回 401 INVALID_SIGNATURE。
//   · 时间戳只从注入的时钟取，不直接 Date.now()（测试可推进时间）；
//   · 用服务端时间重校偏移；偏差 > 10 s 时按频段告警（不含任何密钥）；
//   · 时间戳是秒整数字符串（Gate.io 要求；毫秒会被当成未来时间拒掉）。
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

  /** `Timestamp` 头：秒整数字符串（QD gate.py:107 `str(int(time.time()))`）。 */
  timestamp(): string {
    return String(Math.floor(this.now() / 1000))
  }

  /** 当前偏移（诊断用）。 */
  get offset(): number {
    return this.offsetMs
  }

  /** 上次校准时刻（null = 还没校准）。 */
  get syncedAt(): Ms | null {
    return this.lastSyncAt
  }

  /** 用场所时间重校：offset = serverTime − 本地时间。非有限 / 非正数忽略。 */
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
