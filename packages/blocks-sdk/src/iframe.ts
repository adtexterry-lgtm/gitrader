// SPDX-License-Identifier: Apache-2.0
// 块桥的 postMessage / MessageChannel 实现：第三方 iframe 块（sandbox="allow-scripts"，不给 allow-same-origin）与弹出窗用它连到宿主桥。
// 与宿主桥语义一致；宿主侧（serveBridge）才做权限校验，远程桥只是线缆。
import type { EventEnvelope } from './client'
import { KernelError } from './client'
import { BridgeError, type BlockBridge, type BridgeHello, type SubscribeOptions, type Unsubscribe } from './bridge'
import type { LinkGroup } from './manifest'

export interface PortLike {
  postMessage(msg: unknown): void
  onmessage: ((ev: { data: unknown }) => void) | null
  start?(): void
  close?(): void
}

interface Err { kind: 'bridge' | 'kernel' | 'other'; code: string | number; message: string; problem?: unknown }
const serializeError = (e: unknown): Err => {
  if (e instanceof BridgeError) return { kind: 'bridge', code: e.code, message: e.message }
  if (e instanceof KernelError) return { kind: 'kernel', code: e.code, message: e.message, problem: e.problem }
  return { kind: 'other', code: 'ERROR', message: String((e as Error)?.message ?? e) }
}
const reviveError = (e: Err): Error => {
  if (e.kind === 'bridge') return new BridgeError(e.code as BridgeError['code'], e.message)
  if (e.kind === 'kernel') return new KernelError(Number(e.code), e.message, e.problem)
  return new Error(e.message)
}

type Req =
  | { gr: 1; t: 'req'; id: number; op: 'hello' }
  | { gr: 1; t: 'req'; id: number; op: 'subscribe'; sid: number; topic: string; opts?: SubscribeOptions }
  | { gr: 1; t: 'req'; id: number; op: 'unsubscribe'; sid: number }
  | { gr: 1; t: 'req'; id: number; op: 'query'; method: string; params?: unknown }
  | { gr: 1; t: 'req'; id: number; op: 'command'; action: string; params?: unknown }
  | { gr: 1; t: 'req'; id: number; op: 'link.set'; group: LinkGroup; value: unknown }
  | { gr: 1; t: 'req'; id: number; op: 'link.watch'; groups: LinkGroup[] }

/** 宿主侧：在 port 上服务一个桥。返回销毁函数（取消全部订阅）。 */
export function serveBridge(port: PortLike, bridge: BlockBridge): () => void {
  const subs = new Map<number, Unsubscribe>()
  const linkOffs: Unsubscribe[] = []
  const outbox = new Map<number, EventEnvelope[]>()
  let flushing = false
  const flush = () => {
    flushing = false
    for (const [sid, events] of outbox) { port.postMessage({ gr: 1, t: 'event', sid, events }) }
    outbox.clear()
  }
  const reply = (id: number, ok: boolean, payload: unknown) => port.postMessage(ok ? { gr: 1, t: 'res', id, ok, result: payload } : { gr: 1, t: 'res', id, ok, error: serializeError(payload) })
  port.onmessage = (ev) => {
    const m = ev.data as Req
    if (!m || m.gr !== 1 || m.t !== 'req') return
    try {
      switch (m.op) {
        case 'hello': void bridge.hello().then((r) => reply(m.id, true, r), (e) => reply(m.id, false, e)); break
        case 'subscribe': {
          const off = bridge.subscribe(m.topic, (e) => {
            const q = outbox.get(m.sid)
            if (q) q.push(e); else outbox.set(m.sid, [e])
            if (!flushing) { flushing = true; queueMicrotask(flush) }
          }, m.opts)
          subs.set(m.sid, off)
          reply(m.id, true, null)
          break
        }
        case 'unsubscribe': subs.get(m.sid)?.(); subs.delete(m.sid); reply(m.id, true, null); break
        case 'query': void bridge.query(m.method, m.params).then((r) => reply(m.id, true, r ?? null), (e) => reply(m.id, false, e)); break
        case 'command': void bridge.command(m.action, m.params).then((r) => reply(m.id, true, r ?? null), (e) => reply(m.id, false, e)); break
        case 'link.set': bridge.link.set(m.group, m.value); reply(m.id, true, null); break
        case 'link.watch':
          for (const g of m.groups) linkOffs.push(bridge.link.subscribe(g, (value) => port.postMessage({ gr: 1, t: 'link', group: g, value })))
          reply(m.id, true, null)
          break
      }
    } catch (e) { reply((m as { id: number }).id, false, e) }
  }
  port.start?.()
  return () => { for (const off of subs.values()) off(); subs.clear(); for (const off of linkOffs) off(); linkOffs.length = 0; port.onmessage = null }
}

/** 块侧：把 port 包成 BlockBridge。blockId / instanceId 由握手方给出。 */
export function createRemoteBridge(port: PortLike, ids: { blockId: string; instanceId: string }): BlockBridge {
  let nextId = 1
  let nextSid = 1
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>()
  const handlers = new Map<number, (e: EventEnvelope) => void>()
  const linkCache: Partial<Record<LinkGroup, unknown>> = {}
  const linkFns = new Map<LinkGroup, Set<(v: unknown) => void>>()
  let helloP: Promise<BridgeHello> | null = null

  port.onmessage = (ev) => {
    const m = ev.data as { gr?: number; t?: string; id?: number; ok?: boolean; result?: unknown; error?: Err; sid?: number; events?: EventEnvelope[]; group?: LinkGroup; value?: unknown }
    if (!m || m.gr !== 1) return
    if (m.t === 'res' && m.id !== undefined) {
      const p = pending.get(m.id)
      if (!p) return
      pending.delete(m.id)
      if (m.ok) p.resolve(m.result); else p.reject(reviveError(m.error as Err))
    } else if (m.t === 'event' && m.sid !== undefined) {
      const h = handlers.get(m.sid)
      if (h) for (const e of m.events ?? []) { try { h(e) } catch { /* 块里的错误不影响桥 */ } }
    } else if (m.t === 'link' && m.group) {
      linkCache[m.group] = m.value
      for (const fn of linkFns.get(m.group) ?? []) { try { fn(m.value) } catch { /* 同上 */ } }
    }
  }
  port.start?.()

  const call = <T>(body: Record<string, unknown>): Promise<T> => new Promise<T>((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
    port.postMessage({ gr: 1, t: 'req', id, ...body })
  })

  return {
    blockId: ids.blockId,
    instanceId: ids.instanceId,
    hello() {
      helloP ??= call<BridgeHello>({ op: 'hello' }).then(async (h) => {
        Object.assign(linkCache, h.links)
        const groups = Object.keys(h.links) as LinkGroup[]
        if (groups.length) await call({ op: 'link.watch', groups })
        return h
      })
      return helloP
    },
    subscribe(topic, handler, opts) {
      const sid = nextSid++
      handlers.set(sid, handler)
      // 订阅被宿主拒绝时，错误无处可抛（subscribe 是同步接口）：在下一个微任务里让订阅失效并打印。
      void call({ op: 'subscribe', sid, topic, opts }).catch((e) => { handlers.delete(sid); console.error('[gitrader] 订阅被拒：', (e as Error).message) })
      return () => { handlers.delete(sid); void call({ op: 'unsubscribe', sid }).catch(() => {}) }
    },
    query: <T>(method: string, params?: unknown) => call<T>({ op: 'query', method, params }),
    command: <T>(action: string, params?: unknown) => call<T>({ op: 'command', action, params }),
    link: {
      get: (g) => linkCache[g],
      set(g, value) { linkCache[g] = value; void call({ op: 'link.set', group: g, value }).catch((e) => console.error('[gitrader] 联动被拒：', (e as Error).message)) },
      subscribe(g, fn) {
        let set = linkFns.get(g)
        if (!set) linkFns.set(g, (set = new Set()))
        set.add(fn)
        return () => { set!.delete(fn) }
      },
    },
  }
}

// ---- 窗口握手 ---------------------------------------------------------------------

interface WindowLike {
  postMessage(msg: unknown, targetOrigin: string, transfer?: unknown[]): void
}
interface MessageEventLike { data: unknown; source: unknown; origin: string; ports: readonly PortLike[] }

/**
 * 宿主侧握手：等 `win`（iframe 的 contentWindow，或弹出窗）发来 {gr:'ready'}，回一个 MessagePort 并在其上服务 bridge。
 * 只认来自 `win` 本身的消息；弹出窗（同源）再加 expectOrigin 校验。可重复握手（块重载）。返回销毁函数。
 */
export function attachWindowBridge(win: WindowLike, bridge: BlockBridge, opts: { expectOrigin?: string } = {}): () => void {
  let dispose: (() => void) | null = null
  const onMsg = (e: Event) => {
    const ev = e as unknown as MessageEventLike
    const d = ev.data as { gr?: string } | null
    if (ev.source !== win || !d || d.gr !== 'ready') return
    if (opts.expectOrigin && ev.origin !== opts.expectOrigin) return
    dispose?.()
    const ch = new MessageChannel()
    dispose = serveBridge(ch.port1 as unknown as PortLike, bridge)
    // sandbox 无 allow-same-origin 的 iframe 源是 opaque，只能用 '*'；安全性靠 source 校验 + 桥自身的清单校验。
    win.postMessage({ gr: 'port' }, opts.expectOrigin ?? '*', [ch.port2])
  }
  const w = globalThis as unknown as { addEventListener(t: string, f: (e: Event) => void): void; removeEventListener(t: string, f: (e: Event) => void): void }
  w.addEventListener('message', onMsg)
  return () => { w.removeEventListener('message', onMsg); dispose?.() }
}

/**
 * 块侧握手（iframe 块 / 弹出窗页面入口调用）：向宿主发 ready，收到 port 后返回远程桥。
 * target 缺省 window.parent（iframe）；弹出窗传 window.opener 与 targetOrigin。blockId / instanceId 缺省读 window.__GITRADER_BLOCK__。
 */
export function connectHostBridge(opts: { blockId?: string; instanceId?: string; target?: WindowLike; targetOrigin?: string; timeoutMs?: number } = {}): Promise<BlockBridge> {
  const g = globalThis as unknown as { __GITRADER_BLOCK__?: { blockId: string; instanceId: string }; parent?: WindowLike; addEventListener(t: string, f: (e: Event) => void): void; removeEventListener(t: string, f: (e: Event) => void): void }
  const target = opts.target ?? g.parent
  const blockId = opts.blockId ?? g.__GITRADER_BLOCK__?.blockId
  const instanceId = opts.instanceId ?? g.__GITRADER_BLOCK__?.instanceId
  if (!blockId || !instanceId) return Promise.reject(new Error('缺少 blockId / instanceId（宿主会在 window.__GITRADER_BLOCK__ 里给出）'))
  if (!target) return Promise.reject(new Error('没有可握手的宿主窗口'))
  return new Promise<BlockBridge>((resolve, reject) => {
    const timer = setTimeout(() => { g.removeEventListener('message', onMsg); reject(new Error('宿主没有响应块桥握手')) }, opts.timeoutMs ?? 8000)
    const onMsg = (e: Event) => {
      const ev = e as unknown as MessageEventLike
      const d = ev.data as { gr?: string } | null
      if (ev.source !== target || !d || d.gr !== 'port' || !ev.ports[0]) return
      clearTimeout(timer)
      g.removeEventListener('message', onMsg)
      resolve(createRemoteBridge(ev.ports[0], { blockId, instanceId }))
    }
    g.addEventListener('message', onMsg)
    target.postMessage({ gr: 'ready' }, opts.targetOrigin ?? '*')
  })
}
