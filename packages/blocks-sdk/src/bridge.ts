// SPDX-License-Identifier: Apache-2.0
// 契约 §4.2 块桥：块只经桥收发事件与命令，不直连内核、不持有凭据。
// 同一套桥接口有三种实现：宿主桥（createHostBridge，直接用内核客户端，一方 inline 块用）、
// 远程桥（iframe.ts 的 createRemoteBridge，第三方 iframe 块与弹出窗用 postMessage 连到宿主桥）、夹具桥（harness.ts，离线预览）。
import type { EventEnvelope, KernelClient } from './client'
import { KernelError } from './client'
import type { LinkHub } from './links'
import {
  FIRST_PARTY_ONLY_ACTIONS, NO_ACTIVATION_ACTIONS, actionMatches, actionPermission, topicMatches, topicPermission,
  type BlockManifest, type BlockPermission, type LinkGroup,
} from './manifest'

export type Unsubscribe = () => void

export interface BridgeHello {
  blockId: string
  version: string
  instanceId: string
  permissions: BlockPermission[]
  /** 本块所在通道里各联动组的当前值。 */
  links: Partial<Record<LinkGroup, unknown>>
  theme: string
  locale: string
}

export interface SubscribeOptions { filter?: unknown; maxHz?: number }

/** 块拿到的桥。所有方法对三种实现语义一致。 */
export interface BlockBridge {
  readonly blockId: string
  readonly instanceId: string
  hello(): Promise<BridgeHello>
  subscribe(topic: string, handler: (e: EventEnvelope) => void, opts?: SubscribeOptions): Unsubscribe
  query<T = unknown>(method: string, params?: unknown): Promise<T>
  /** 有副作用的命令必须来自人的点击（瞬时用户激活）。 */
  command<T = unknown>(action: string, params?: unknown): Promise<T>
  link: {
    get(group: LinkGroup): unknown
    set(group: LinkGroup, value: unknown): void
    subscribe(group: LinkGroup, fn: (value: unknown) => void): Unsubscribe
  }
}

/** 桥拒绝（权限 / 未声明 / 非人点击）。code 供块区分，message 是给开发者看的。 */
export class BridgeError extends Error {
  constructor(readonly code: 'TOPIC_NOT_DECLARED' | 'PERMISSION_DENIED' | 'QUERY_NOT_ALLOWED' | 'ACTION_NOT_DECLARED' | 'FIRST_PARTY_ONLY' | 'USER_ACTIVATION_REQUIRED' | 'LINK_NOT_ALLOWED', message: string) {
    super(message)
    this.name = 'BridgeError'
  }
}

export interface HostBridgeOptions {
  manifest: BlockManifest
  instanceId: string
  kernel: KernelClient
  hub: LinkHub
  /** 本块所在联动通道；缺省 `A`。 */
  channel?: string
  /** 一方签名块（inline 且随内核发布）：可带 proposal.approve / reject。 */
  trusted?: boolean
  /** 用户授予的权限；缺省 = 清单声明的全部。 */
  grants?: BlockPermission[]
  theme?: () => string
  locale?: () => string
  /** 事件按帧批量投递；缺省 requestAnimationFrame，无 rAF 时 16 ms 定时器。测试可注入同步调度。 */
  schedule?: (fn: () => void) => void
  /** 是否有瞬时用户激活；缺省读 navigator.userActivation.isActive，读不到则放行（测试 / 非浏览器）。 */
  isUserActive?: () => boolean
}

const defaultSchedule = (fn: () => void): void => {
  const raf = (globalThis as { requestAnimationFrame?: (cb: () => void) => number }).requestAnimationFrame
  if (typeof raf === 'function') raf(fn)
  else setTimeout(fn, 16)
}

const defaultIsUserActive = (): boolean => {
  const ua = (globalThis as { navigator?: { userActivation?: { isActive?: boolean } } }).navigator?.userActivation
  return ua && typeof ua.isActive === 'boolean' ? ua.isActive : true
}

/** 宿主桥：校验清单（订阅 / 查询 / 命令 / 权限 / 联动）后再转给内核客户端。 */
export function createHostBridge(o: HostBridgeOptions): BlockBridge {
  const m = o.manifest
  const channel = o.channel ?? 'A'
  const grants = new Set<BlockPermission>(o.grants ?? m.permissions)
  const schedule = o.schedule ?? defaultSchedule
  const active = o.isUserActive ?? defaultIsUserActive
  const linkMode = (g: LinkGroup) => m.linkGroups?.find((l) => l.group === g)?.mode

  const needPerm = (p: BlockPermission | null, what: string) => {
    if (p && !(m.permissions.includes(p) && grants.has(p))) throw new BridgeError('PERMISSION_DENIED', `${what} 需要权限 ${p}`)
  }

  const subscribeKernel = (topic: string, handler: (e: EventEnvelope) => void, opts: SubscribeOptions = {}): Unsubscribe => {
    // link.<group>：由联动中枢本地投递，不经内核。
    if (topic.startsWith('link.')) {
      const g = topic.slice(5) as LinkGroup
      if (!linkMode(g)) throw new BridgeError('LINK_NOT_ALLOWED', `未声明联动组 ${g}`)
      return o.hub.subscribe(channel, g, (value) => handler({ topic, ts: Date.now(), data: value }))
    }
    const decl = m.inputs?.events?.find((e) => topicMatches(e.topic, topic) || topicMatches(topic, e.topic))
    if (!decl) throw new BridgeError('TOPIC_NOT_DECLARED', `清单 inputs.events 没有声明 ${topic}`)
    needPerm(topicPermission(topic), `订阅 ${topic}`)
    const maxHz = opts.maxHz !== undefined && decl.maxHz !== undefined ? Math.min(opts.maxHz, decl.maxHz) : (opts.maxHz ?? decl.maxHz)
    const filter = opts.filter ?? decl.filter
    // 按帧批量投递：同一帧内到达的事件合并成一次回调序列
    let queue: EventEnvelope[] = []
    let scheduled = false
    let dead = false
    const flush = () => {
      scheduled = false
      const batch = queue
      queue = []
      if (dead) return
      for (const ev of batch) { try { handler(ev) } catch { /* 块里的错误不影响桥 */ } }
    }
    const off = o.kernel.subscribe(topic, (ev) => {
      queue.push(ev)
      if (!scheduled) { scheduled = true; schedule(flush) }
    }, { filter, maxHz })
    return () => { dead = true; off() }
  }

  return {
    blockId: m.id,
    instanceId: o.instanceId,
    async hello() {
      const links: Partial<Record<LinkGroup, unknown>> = {}
      for (const l of m.linkGroups ?? []) links[l.group] = o.hub.get(channel, l.group)
      return { blockId: m.id, version: m.version, instanceId: o.instanceId, permissions: m.permissions.filter((p) => grants.has(p)), links, theme: o.theme?.() ?? 'dark', locale: o.locale?.() ?? 'zh-CN' }
    },
    subscribe: subscribeKernel,
    query<T>(method: string, params?: unknown) {
      if (!(m.inputs?.queries ?? []).includes(method)) return Promise.reject(new BridgeError('QUERY_NOT_ALLOWED', `清单 inputs.queries 没有声明 ${method}`))
      try { needPerm(topicPermission(method), `查询 ${method}`) } catch (e) { return Promise.reject(e) }
      return o.kernel.query<T>(method, params)
    },
    command<T>(action: string, params?: unknown) {
      try {
        if (!(m.actions ?? []).some((a) => actionMatches(a, action))) throw new BridgeError('ACTION_NOT_DECLARED', `清单 actions 没有声明 ${action}`)
        if (FIRST_PARTY_ONLY_ACTIONS.includes(action) && !(o.trusted && m.isolation === 'inline')) throw new BridgeError('FIRST_PARTY_ONLY', `${action} 只允许一方签名块`)
        needPerm(actionPermission(action), `命令 ${action}`)
        if (action === 'link.set') {
          const p = (params ?? {}) as { group?: LinkGroup; value?: unknown }
          if (!p.group || linkMode(p.group) !== 'readwrite') throw new BridgeError('LINK_NOT_ALLOWED', `未声明可写联动组 ${String(p.group)}`)
          o.hub.set(channel, p.group, p.value, o.instanceId)
          return Promise.resolve(undefined as T)
        }
        if (!NO_ACTIVATION_ACTIONS.includes(action) && !action.startsWith('workspace.') && !active()) throw new BridgeError('USER_ACTIVATION_REQUIRED', `${action} 有副作用，必须来自人的点击`)
      } catch (e) { return Promise.reject(e) }
      return o.kernel.command<T>(action, params, { tool: `block:${m.id}:${action}` })
    },
    link: {
      get(group) { return linkMode(group) ? o.hub.get(channel, group) : undefined },
      set(group, value) {
        if (linkMode(group) !== 'readwrite') throw new BridgeError('LINK_NOT_ALLOWED', `未声明可写联动组 ${group}`)
        o.hub.set(channel, group, value, o.instanceId)
      },
      subscribe(group, fn) {
        if (!linkMode(group)) throw new BridgeError('LINK_NOT_ALLOWED', `未声明联动组 ${group}`)
        return o.hub.subscribe(channel, group, (v) => fn(v))
      },
    },
  }
}

export { KernelError }
