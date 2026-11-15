// SPDX-License-Identifier: Apache-2.0
// 套件扮演宿主的一次会话：JSON-RPC 客户端 + host.* 服务端，记录引擎发来的一切。
import {
  GEP_SUPPORTED_VERSIONS, isRpcNotification, isRpcRequest, isRpcResponse, type GepEvent, type JsonRpcId, type Problem,
} from '../src'
import { HostSim } from './host-sim'
import type { Transport } from './transport'

export type Outcome = { ok: true; result: any } | { ok: false; error: { code: number; message: string; data?: Problem } }

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export interface NotificationRecord { method: string; params: any; at: number }

export class GepSession {
  readonly events: GepEvent[] = []
  readonly notifications: NotificationRecord[] = []
  /** 收到的每一条原始文本（成帧、BOM、泄漏检查用）。 */
  readonly raw: string[] = []
  closed = false
  closedAt = 0
  sessionId = ''
  autoAck = true
  /** 引擎发来的、没被识别的请求（方法不存在）。 */
  private nextId = 1
  private pending = new Map<JsonRpcId, (o: Outcome) => void>()
  private waiters: (() => void)[] = []
  private hb: ReturnType<typeof setInterval> | undefined
  private hostSeq = 0
  private hostEventSeq = 0

  constructor(readonly transport: Transport, readonly host: HostSim) {
    transport.onMessage((text) => this.onText(text))
    transport.onClose(() => { this.closed = true; this.closedAt = Date.now(); this.stopHeartbeats(); this.wake(); for (const [, cb] of this.pending) cb({ ok: false, error: { code: -1, message: 'transport closed' } }); this.pending.clear() })
  }

  private wake(): void { const w = this.waiters; this.waiters = []; for (const f of w) f() }

  private onText(text: string): void {
    this.raw.push(text)
    let msg: unknown
    try { msg = JSON.parse(text) } catch { return }
    const items = Array.isArray(msg) ? msg : [msg]
    for (const m of items) this.onMessage(m)
    this.wake()
  }

  private onMessage(m: unknown): void {
    if (isRpcResponse(m)) {
      const cb = this.pending.get(m.id as JsonRpcId)
      if (cb) {
        this.pending.delete(m.id as JsonRpcId)
        cb('error' in m ? { ok: false, error: m.error } : { ok: true, result: m.result })
      }
    } else if (isRpcRequest(m)) {
      const out = this.host.handle(m.method, m.params)
      if ('result' in out) this.transport.send(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: out.result }))
      else this.transport.send(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: out.error.code, message: out.error.message, data: out.error } }))
    } else if (isRpcNotification(m)) {
      this.notifications.push({ method: m.method, params: m.params, at: Date.now() })
      if (m.method === 'events.push') {
        const evs = ((m.params as { events?: GepEvent[] } | undefined)?.events ?? []) as GepEvent[]
        this.events.push(...evs)
        if (this.autoAck && evs.length > 0) this.notify('host.events.ack', { upToSeq: Math.max(...evs.map((e) => e.seq)) })
      }
    }
  }

  /** 发请求并等响应；超时返回 { ok:false, code:-2 }。 */
  request(method: string, params?: unknown, timeoutMs = 10_000): Promise<Outcome> {
    const id = this.nextId++
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.pending.delete(id); resolve({ ok: false, error: { code: -2, message: `timeout waiting for ${method}` } }) }, timeoutMs)
      this.pending.set(id, (o) => { clearTimeout(timer); resolve(o) })
      this.transport.send(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }))
    })
  }

  /** 同一帧发一批请求（JSON 数组）；每个请求按 id 收响应。 */
  requestBatch(items: { method: string; params?: unknown }[], timeoutMs = 10_000): Promise<Outcome[]> {
    const reqs = items.map((it) => ({ jsonrpc: '2.0', id: this.nextId++, method: it.method, ...(it.params === undefined ? {} : { params: it.params }) }))
    const waits = reqs.map((r) => new Promise<Outcome>((resolve) => {
      const timer = setTimeout(() => { this.pending.delete(r.id); resolve({ ok: false, error: { code: -2, message: `timeout waiting for ${r.method}` } }) }, timeoutMs)
      this.pending.set(r.id, (o) => { clearTimeout(timer); resolve(o) })
    }))
    this.transport.send(JSON.stringify(reqs))
    return Promise.all(waits)
  }

  /** 发请求，出错则抛。 */
  async call<T = any>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    const o = await this.request(method, params, timeoutMs)
    if (!o.ok) throw new Error(`${method} failed: ${o.error.code} ${o.error.message}`)
    return o.result as T
  }

  /** 发请求，返回 error（成功则抛）。 */
  async expectError(method: string, params?: unknown, timeoutMs?: number): Promise<{ code: number; message: string; data?: Problem }> {
    const o = await this.request(method, params, timeoutMs)
    if (o.ok) throw new Error(`${method} unexpectedly succeeded`)
    return o.error
  }

  notify(method: string, params?: unknown): void {
    this.transport.send(JSON.stringify({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) }))
  }

  sendRaw(text: string): void { this.transport.send(text) }

  async hello(opts: { token: string; versions?: readonly string[]; resume?: { sessionId: string; lastSeq: number } }): Promise<Outcome> {
    const o = await this.request('gep.hello', {
      protocol: 'gep', versions: opts.versions ?? GEP_SUPPORTED_VERSIONS, host: { name: 'gep-conformance-host', version: '0.1.2' }, auth: { token: opts.token },
      ...(opts.resume ? { resume: opts.resume } : {}),
    })
    if (o.ok) this.sessionId = (o.result as { sessionId: string }).sessionId
    return o
  }

  startHeartbeats(intervalMs = 1000): void {
    this.stopHeartbeats()
    const beat = () => this.notify('gep.heartbeat', { ts: Date.now(), seq: ++this.hostSeq })
    beat()
    this.hb = setInterval(beat, intervalMs)
    this.hb.unref?.()
  }
  stopHeartbeats(): void { if (this.hb) clearInterval(this.hb); this.hb = undefined }

  /** 宿主 → 引擎的事件（行情等）。seq 在会话内单调递增；同一个 eventId 重发用于去重测试。 */
  pushHostEvents(events: { stream: GepEvent['stream']; type: string; data: Record<string, unknown>; eventId?: string; instrumentId?: string }[]): string[] {
    const ids: string[] = []
    const out = events.map((e) => {
      this.hostEventSeq += 1
      const eventId = e.eventId ?? `evt_h${this.sessionId.slice(-4)}${String(this.hostEventSeq).padStart(8, '0')}`
      ids.push(eventId)
      return { seq: this.hostEventSeq, eventId, stream: e.stream, type: e.type, ts: Date.now(), ...(e.instrumentId ? { instrumentId: e.instrumentId } : {}), data: e.data }
    })
    this.notify('events.push', { sessionId: this.sessionId, events: out })
    return ids
  }

  /** 等条件成立（每次消息到达或超时后重检）。 */
  async waitFor(pred: () => boolean, timeoutMs: number, pollMs = 25): Promise<boolean> {
    const end = Date.now() + timeoutMs
    while (Date.now() < end) {
      if (pred()) return true
      await new Promise<void>((r) => { this.waiters.push(r); setTimeout(r, pollMs) })
    }
    return pred()
  }

  /** 等传输关闭，返回是否在期限内关闭。 */
  waitClosed(timeoutMs: number): Promise<boolean> { return this.waitFor(() => this.closed, timeoutMs) }

  close(): void { this.stopHeartbeats(); this.transport.close() }

  /** 引擎最近一次发来的指定通知。 */
  notificationsOf(method: string): NotificationRecord[] { return this.notifications.filter((n) => n.method === method) }
}

