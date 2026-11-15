// SPDX-License-Identifier: Apache-2.0
// 块开发用的独立预览 harness：夹具喂数据，块不连内核也能渲染（契约 §4.1 `fixtures`）。
// 夹具桥实现 BlockBridge：订阅按夹具里的时间轴回放，查询读夹具里的静态结果，命令只记录。
import type { EventEnvelope } from './client'
import type { BlockBridge, BridgeHello, SubscribeOptions } from './bridge'
import { LinkHub } from './links'
import { topicMatches, type BlockManifest, type LinkGroup } from './manifest'

/** TODO(protocol): 夹具文件形状是本包约定。 */
export interface BlockFixtures {
  /** t = 相对回放起点的毫秒；topic 同 inputs.events。 */
  events: Array<{ t: number; topic: string; data: unknown }>
  queries?: Record<string, unknown>
  links?: Partial<Record<LinkGroup, unknown>>
  /** 回放结束后是否循环（默认 false）。 */
  loop?: boolean
}

export interface FixtureBridge extends BlockBridge {
  /** 命令调用记录（预览页用来显示块发出了什么）。 */
  readonly commandLog: Array<{ action: string; params: unknown }>
  /** 重新开始回放。 */
  restart(): void
}

interface Playing { topic: string; handler: (e: EventEnvelope) => void; timers: Array<ReturnType<typeof setTimeout>> }

export function createFixtureBridge(manifest: BlockManifest, fixtures: BlockFixtures, opts: { instanceId?: string; hub?: LinkHub; channel?: string } = {}): FixtureBridge {
  const instanceId = opts.instanceId ?? `bi_${manifest.id.split('.').pop()}_preview`
  const channel = opts.channel ?? 'A'
  const hub = opts.hub ?? new LinkHub({ [channel]: { ...(fixtures.links ?? {}) } })
  const subs = new Set<Playing>()
  const commandLog: Array<{ action: string; params: unknown }> = []

  const play = (s: Playing) => {
    for (const t of s.timers) clearTimeout(t)
    s.timers.length = 0
    const evs = fixtures.events.filter((e) => topicMatches(s.topic, e.topic) || topicMatches(e.topic, s.topic))
    let seq = 0
    const end = evs.reduce((m, e) => Math.max(m, e.t), 0)
    for (const e of evs) {
      s.timers.push(setTimeout(() => s.handler({ topic: e.topic, seq: ++seq, ts: Date.now(), data: e.data }), Math.max(0, e.t)))
    }
    if (fixtures.loop && evs.length) s.timers.push(setTimeout(() => play(s), end + 1000))
  }

  return {
    blockId: manifest.id,
    instanceId,
    commandLog,
    async hello(): Promise<BridgeHello> {
      const links: Partial<Record<LinkGroup, unknown>> = {}
      for (const l of manifest.linkGroups ?? []) links[l.group] = hub.get(channel, l.group)
      return { blockId: manifest.id, version: manifest.version, instanceId, permissions: manifest.permissions, links, theme: 'dark', locale: 'zh-CN' }
    },
    subscribe(topic: string, handler: (e: EventEnvelope) => void, _opts?: SubscribeOptions) {
      if (topic.startsWith('link.')) return hub.subscribe(channel, topic.slice(5) as LinkGroup, (v) => handler({ topic, ts: Date.now(), data: v }))
      const s: Playing = { topic, handler, timers: [] }
      subs.add(s)
      play(s)
      return () => { for (const t of s.timers) clearTimeout(t); subs.delete(s) }
    },
    async query<T>(method: string): Promise<T> {
      if (!fixtures.queries || !(method in fixtures.queries)) throw new Error(`夹具没有查询 ${method}`)
      return fixtures.queries[method] as T
    },
    async command<T>(action: string, params?: unknown): Promise<T> {
      commandLog.push({ action, params })
      return undefined as T
    },
    link: {
      get: (g) => hub.get(channel, g),
      set: (g, v) => { hub.set(channel, g, v, instanceId) },
      subscribe: (g, fn) => hub.subscribe(channel, g, (v) => fn(v)),
    },
    restart() { for (const s of subs) play(s) },
  }
}
