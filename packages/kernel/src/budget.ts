// SPDX-License-Identifier: CPAL-1.0
// 速率预算对象（实现 protocol 的 connector.RateBudget）：同一台机器上某场所的所有连接共用一个（HL：按 IP 的 REST 聚合权重 1200 / 分钟）。
// 内核创建后注入连接器（HyperliquidConnector({ budget })）；连接器 acquire / charge，内核读 usage() 做风控与"权重占用 ≤60%"的公布。
import type { connector } from '@gitrader/protocol'
import type { Clock } from './util/clock'

export interface BudgetOptions { limit: number; windowMs: number; targetRatio?: number; clock: Clock }

export class KernelRateBudget implements connector.RateBudget {
  private events: { ts: number; w: number }[] = []
  private backoffUntil = 0
  private failures = 0
  readonly limit: number
  readonly windowMs: number
  readonly targetRatio: number

  constructor(private o: BudgetOptions) {
    this.limit = o.limit
    this.windowMs = o.windowMs
    this.targetRatio = o.targetRatio ?? 0.6
  }

  private prune(): void {
    const cut = this.o.clock.now() - this.windowMs
    let i = 0
    while (i < this.events.length && (this.events[i] as { ts: number }).ts <= cut) i++
    if (i) this.events.splice(0, i)
  }
  used(): number { this.prune(); return this.events.reduce((s, e) => s + e.w, 0) }
  remaining(): number { return Math.max(0, this.limit - this.used()) }
  ratio(): number { return this.used() / this.limit }

  async acquire(weight: number, opts: { priority?: 'high' | 'low'; signal?: AbortSignal } = {}): Promise<void> {
    const cap = (opts.priority === 'low' ? this.targetRatio * 0.8 : this.targetRatio) * this.limit
    for (;;) {
      if (opts.signal?.aborted) throw new Error('aborted')
      const now = this.o.clock.now()
      if (now >= this.backoffUntil && (this.used() + weight <= cap || this.used() === 0)) { this.events.push({ ts: now, w: weight }); return }
      const first = this.events[0]?.ts ?? now
      const wait = Math.max(25, Math.min(1000, Math.max(this.backoffUntil - now, first + this.windowMs - now)))
      await new Promise<void>((r) => setTimeout(r, wait).unref?.())
    }
  }
  /** 事后补记权重（也供内核记录自己发起的请求）。 */
  charge(weight: number): void { this.events.push({ ts: this.o.clock.now(), w: weight }); this.prune() }
  penalize(retryAfterMs = 10_000): void {
    this.failures++
    this.backoffUntil = this.o.clock.now() + Math.min(retryAfterMs * 2 ** (this.failures - 1), 120_000)
  }
  reportOk(): void { this.failures = 0 }
  usage(): connector.BudgetUsage {
    const used = this.used()
    return { used, target: this.limit * this.targetRatio, limit: this.limit, ratio: used / this.limit, windowMs: this.windowMs, backoffUntil: this.backoffUntil }
  }
}
