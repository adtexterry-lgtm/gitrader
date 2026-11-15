// SPDX-License-Identifier: CPAL-1.0
// HTX 签名请求的时间源。
// 官方《签名认证》：`Timestamp` 是 UTC ISO8601 文本，**秒级、不带毫秒**（例 2017-05-18T06:20:56），
// 与服务器时间偏差过大会被拒（错误文案含 timestamp / 时间戳）。因此：
//   · 格式固定 `YYYY-MM-DDTHH:MM:SS`（UTC），不写毫秒、不写时区后缀；
//   · 时间戳直接用当前秒（同一秒内的多个请求时间戳相同）：官方只要求与场所时间偏差在窗口内，
//     不做本包自创的“严格递增”；
//   · 偏移由场所时间重校：linear-swap-api v1 的**每个响应**都带 `ts`（毫秒），拿它校准
//     （公开接口 GET /linear-swap-api/v1/swap_contract_info 也带 ts，不需要签名就能校准）。
export class HtxClock {
  private offsetMs = 0

  constructor(private readonly clock: () => number = () => Date.now()) {}

  /** 本机时钟 + 场所偏移（毫秒）。 */
  now(): number {
    return this.clock() + this.offsetMs
  }

  /** 下一次签名用的 Timestamp 文本（UTC，秒级 = 当前秒）。 */
  nextTimestamp(): string {
    return formatHtxTimestamp(this.now())
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

/** 毫秒 → HTX 的 Timestamp 文本（UTC，秒级，例 2017-05-18T06:20:56）。 */
export function formatHtxTimestamp(ms: number): string {
  const iso = new Date(Math.floor(ms / 1000) * 1000).toISOString()
  return iso.slice(0, 19)
}

/** 从 v1 信封的 `ts`（毫秒）取场所时间；拿不到返回 undefined（调用方只 warn，不抛）。 */
export function serverTimeMsOf(raw: unknown): number | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const ts = Number((raw as { ts?: unknown }).ts)
  return Number.isFinite(ts) && ts > 0 ? Math.round(ts) : undefined
}
