// SPDX-License-Identifier: CPAL-1.0
// Bybit v5 签名请求的时间源：`timestamp` + `recvWindow`（毫秒，缺省 5000，官方允许 1000–5000 的推荐值）。
//   · timestamp = 本机时钟 + 与场所的偏移；偏移由 GET /v5/market/time 或 retCode 10002 后的重校得出
//     （照 QD live_trading/bybit.py:193-206 的 sync_server_time_offset）；
//   · 时间戳必须严格递增：同一毫秒内连发两个签名请求时后一个 +1 ms，避免上游判重；
//   · 时钟由构造参数注入（测试里不需要假定时器）。
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

  /** 用场所时间重校偏移（场所时钟 − 本机时钟）。 */
  resync(serverTimeMs: number): void {
    if (!Number.isFinite(serverTimeMs) || serverTimeMs <= 0) return
    this.offsetMs = Math.round(serverTimeMs - this.clock())
  }
}

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/live_trading/bybit.py:166-191; adapted.
/**
 * GET /v5/market/time 的 result → 毫秒。优先 timeNano（纳秒 ÷ 1e6），其次 timeSecond，最后信封 time。
 * 三个字段都没有时返回 undefined（调用方只 warn，不抛）。
 */
export function serverTimeMsOf(raw: unknown): number | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const envelope = raw as { result?: { timeNano?: string; timeSecond?: string }; time?: number | string }
  const nano = envelope.result?.timeNano
  if (typeof nano === 'string' && nano.trim() !== '') {
    const n = Number(nano)
    if (Number.isFinite(n) && n > 0) return Math.floor(n / 1_000_000)
  }
  const sec = envelope.result?.timeSecond
  if (typeof sec === 'string' && sec.trim() !== '') {
    const s = Number(sec)
    if (Number.isFinite(s) && s > 0) return Math.round(s * 1000)
  }
  const t = Number(envelope.time)
  return Number.isFinite(t) && t > 0 ? Math.round(t) : undefined
}
