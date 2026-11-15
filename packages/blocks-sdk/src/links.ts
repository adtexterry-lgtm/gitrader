// SPDX-License-Identifier: Apache-2.0
// 契约 §4.3 联动组：同一通道（A / B / …）内，symbol / account / timeRange / strategy / experiment 同步。
import type { LinkGroup } from './manifest'

export type LinkValues = Partial<Record<LinkGroup, unknown>>
export type LinkListener = (value: unknown, source?: string) => void

const same = (a: unknown, b: unknown): boolean => a === b || (typeof a === 'object' && typeof b === 'object' && a !== null && b !== null && JSON.stringify(a) === JSON.stringify(b))

export class LinkHub {
  private channels = new Map<string, LinkValues>()
  private listeners = new Map<string, Set<LinkListener>>()
  private anyListeners = new Set<(channel: string, group: LinkGroup, value: unknown, source?: string) => void>()

  constructor(initial: Record<string, LinkValues> = {}) {
    for (const [ch, v] of Object.entries(initial)) this.channels.set(ch, { ...v })
  }

  get(channel: string, group: LinkGroup): unknown {
    return this.channels.get(channel)?.[group]
  }

  all(channel: string): LinkValues {
    return { ...(this.channels.get(channel) ?? {}) }
  }

  /** 设值并通知同通道同组的订阅者。值没变返回 false（不重复通知）。 */
  set(channel: string, group: LinkGroup, value: unknown, source?: string): boolean {
    const cur = this.channels.get(channel) ?? {}
    if (same(cur[group], value)) return false
    this.channels.set(channel, { ...cur, [group]: value })
    this.emit(channel, group, value, source)
    return true
  }

  subscribe(channel: string, group: LinkGroup, fn: LinkListener): () => void {
    const key = `${channel}\u0000${group}`
    let set = this.listeners.get(key)
    if (!set) this.listeners.set(key, (set = new Set()))
    set.add(fn)
    return () => { set!.delete(fn) }
  }

  /** 监听任意联动变化（壳用它把通道值写回工作区）。 */
  onAny(fn: (channel: string, group: LinkGroup, value: unknown, source?: string) => void): () => void {
    this.anyListeners.add(fn)
    return () => { this.anyListeners.delete(fn) }
  }

  /** 导出为工作区 `channels` 字段。 */
  snapshot(): Record<string, LinkValues> {
    const out: Record<string, LinkValues> = {}
    for (const [ch, v] of this.channels) out[ch] = { ...v }
    return out
  }

  /** 整体替换（加载工作区时）。对有差异的组逐个通知。 */
  load(channels: Record<string, LinkValues>, source = 'load'): void {
    const next = new Map<string, LinkValues>()
    for (const [ch, v] of Object.entries(channels)) next.set(ch, { ...v })
    const touched: Array<[string, LinkGroup, unknown]> = []
    const names = new Set([...this.channels.keys(), ...next.keys()])
    for (const ch of names) {
      const a = this.channels.get(ch) ?? {}
      const b = next.get(ch) ?? {}
      for (const g of new Set([...Object.keys(a), ...Object.keys(b)]) as Set<LinkGroup>) if (!same(a[g], b[g])) touched.push([ch, g, b[g]])
    }
    this.channels = next
    for (const [ch, g, v] of touched) this.emit(ch, g, v, source)
  }

  private emit(channel: string, group: LinkGroup, value: unknown, source?: string): void {
    for (const fn of this.listeners.get(`${channel}\u0000${group}`) ?? []) {
      try { fn(value, source) } catch { /* 一个订阅者出错不拖垮其他 */ }
    }
    for (const fn of this.anyListeners) {
      try { fn(channel, group, value, source) } catch { /* 同上 */ }
    }
  }
}
