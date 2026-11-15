// SPDX-License-Identifier: CPAL-1.0
// OKX 签名请求的时间戳源：`OK-ACCESS-TIMESTAMP` 必须是带毫秒的 RFC3339 UTC（例 2020-12-08T09:08:57.715Z）。
//   · 时间 = 本机时钟 + 与场所的偏移（偏移由 /api/v5/public/time 或 50112 之后的重校得出）；
//   · 时钟由构造参数注入（测试里不需要假定时器）；
//   · 时间戳必须严格递增：同一毫秒内连发两个签名请求时后一个 +1 ms，避免上游判重。
// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/live_trading/okx.py:269-274; adapted.

/** 毫秒时间 → OKX 口径的 RFC3339（UTC，毫秒三位，Z 结尾）。 */
export function isoOf(ms: number): string {
  const d = new Date(ms)
  const sec = d.toISOString().slice(0, 19)
  const frac = String(((ms % 1000) + 1000) % 1000).padStart(3, '0')
  return `${sec}.${frac}Z`
}

export class IsoTimestampSource {
  private last = 0
  private offsetMs = 0

  constructor(
    private readonly clock: () => number = () => Date.now(),
  ) {}

  /** 本机时钟 + 场所偏移（毫秒）。 */
  now(): number {
    return Math.round(this.clock() + this.offsetMs)
  }

  /** 下一个可用时间戳（毫秒）：≥ now()，且严格大于上一次发出的时间戳。 */
  nextMs(): number {
    const candidate = this.now()
    const out = candidate > this.last ? candidate : this.last + 1
    this.last = out
    return out
  }

  /** 下一个可用时间戳（OKX 口径的字符串）。 */
  next(): string {
    return isoOf(this.nextMs())
  }

  get offset(): number {
    return this.offsetMs
  }

  /** 用场所时间重校偏移（本机时钟 − 场所时钟）。 */
  resync(serverTimeMs: number): void {
    if (!Number.isFinite(serverTimeMs) || serverTimeMs <= 0) return
    this.offsetMs = Math.round(serverTimeMs - this.clock())
  }
}
