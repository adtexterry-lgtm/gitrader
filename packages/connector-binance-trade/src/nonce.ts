// SPDX-License-Identifier: CPAL-1.0
// Binance 签名请求的时间戳源：`timestamp` + `recvWindow`（不是 nonce 链）。
//   · timestamp = 本机时钟 + 与场所的偏移（偏移由 /fapi/v1/time 或 -1021 后的重校得出）；
//   · recvWindow 缺省 5000 ms（官方允许 1–60000，默认 5000）；
//   · 时钟由构造参数注入（测试里不需要假定时器）。
// 时间戳必须严格递增：同一毫秒内连发两个签名请求时后一个 +1 ms，避免上游判重 / 早于上次时间戳。
export class TimestampSource {
  private last = 0
  private offsetMs = 0
  constructor(
    private readonly clock: () => number = () => Date.now(),
    readonly recvWindowMs: number = 5_000,
  ) {
    if (!Number.isInteger(recvWindowMs) || recvWindowMs < 1 || recvWindowMs > 60_000) {
      throw new RangeError('recvWindowMs must be an integer from 1 to 60000')
    }
  }

  /** 本机时钟 + 场所偏移（尚未向上取整到「比上次大」）。 */
  now(): number {
    return this.clock() + this.offsetMs
  }

  /** 下一个可用时间戳：≥ now()，且严格大于上一次发出的时间戳。 */
  next(): number {
    const candidate = this.now()
    const out = candidate > this.last ? candidate : this.last + 1
    this.last = out
    return out
  }

  get offset(): number {
    return this.offsetMs
  }

  /** 用场所 serverTime 重校偏移（本机时钟 − 场所时钟）。 */
  resync(serverTimeMs: number): void {
    if (!Number.isFinite(serverTimeMs) || serverTimeMs <= 0) return
    this.offsetMs = Math.round(serverTimeMs - this.clock())
  }
}
