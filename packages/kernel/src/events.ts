// SPDX-License-Identifier: CPAL-1.0
// 内核事件总线（契约 §4.2 事件主题）。同步派发，订阅者异常不影响发布者。
export const EVENT_TOPICS = [
  'market.quote', 'market.book', 'market.trades', 'market.candles',
  'account.summary', 'account.positions', 'account.orders', 'account.fills',
  'proposal.created', 'proposal.decided', 'proposal.executed', 'proposal.expired', 'proposal.withdrawn', 'proposal.failed',
  'risk.state', 'risk.denials', 'ledger.entry', 'engine.health', 'strategy.status', 'workspace.changed',
  'takeover.alert', 'mandate.changed', 'venue.status', 'plugin.state',
  'reconciliation.updated', 'reconciliation.notice',
] as const

export interface KernelEvent { topic: string; ts: number; seq: number; data: unknown }
export type Unsubscribe = () => void

/** 订阅模式：精确主题、`proposal.*` 前缀、或 `*` 全部。 */
const matches = (pattern: string, topic: string): boolean =>
  pattern === '*' || pattern === topic || (pattern.endsWith('.*') && topic.startsWith(pattern.slice(0, -1)))

export class EventBus {
  private subs = new Map<number, { pattern: string; fn: (e: KernelEvent) => void }>()
  private nextId = 1
  private seq = 0
  constructor(private now: () => number = Date.now, private onError: (e: unknown) => void = () => {}) {}

  subscribe(pattern: string, fn: (e: KernelEvent) => void): Unsubscribe {
    const id = this.nextId++
    this.subs.set(id, { pattern, fn })
    return () => { this.subs.delete(id) }
  }

  publish(topic: string, data: unknown): KernelEvent {
    const e: KernelEvent = { topic, ts: this.now(), seq: ++this.seq, data }
    for (const s of [...this.subs.values()]) {
      if (!matches(s.pattern, topic)) continue
      try { s.fn(e) } catch (err) { this.onError(err) }
    }
    return e
  }
  get subscriberCount(): number { return this.subs.size }
}
