// SPDX-License-Identifier: Apache-2.0
// 内核 WS 客户端：契约 §4.2 的订阅 / 查询 / 命令，走 JSON-RPC 2.0（与 GEP 同形，见 §2.1）。会话鉴权由壳注入（getToken）。
//
// TODO(protocol): 契约只定义了桥方法，没有定义壳 ↔ 内核的 WS 线格式。本文件的线格式是本包约定，等 B / E 的 api/ 落地后对齐：
//   连接  ws://127.0.0.1:<port>/ui
//   首帧  → {"method":"auth","params":{"token","client":{"name","instanceId"}}}      ← {"result":{"ok":true,"user":"usr_…"}}
//   订阅  → {"method":"subscribe","params":{"topic","filter?","maxHz?","fromSeq?"}}   ← {"result":{"subscriptionId"}}
//         → {"method":"unsubscribe","params":{"subscriptionId"}}
//   事件  ← {"method":"event","params":{"subscriptionId","topic","events":[{"seq?","ts?","data"}]}}（单条可直接带 data）
//   查询  → {"method":"query","params":{"method","params"}}                          ← {"result":…}
//   命令  → {"method":"command","params":{"action","params","origin":{"tool","via":"ui"},"attestation?"}}
//   错误  ← {"error":{"code","message","data":Problem}}；需要在场证明时 data.name = "ATTESTATION_REQUIRED"

export type ClientStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed'

export interface EventEnvelope {
  topic: string
  seq?: number
  ts?: number
  data: unknown
}

/** 在场证明（契约 §5.1 `attestation.method`）。M1 只有 PIN；通行密钥 M1.1。 */
export interface Attestation {
  method: 'pin' | 'passkey' | 'wallet'
  /** PIN 明文只在本机回环发给内核校验，不落盘、不进日志。 */
  pin?: string
  [k: string]: unknown
}

export interface AttestRequest {
  action: string
  params: unknown
  reason?: string
  /** 重试时才有（setAttestor(fn, { retry: true })）：上一次证明被拒的内核原文（AUTH_FAILED 的 message，不改写）。 */
  error?: string
  /** 重试时：内核给的锁定剩余毫秒（PIN 错太多次）；没锁定则没有。 */
  retryAfterMs?: number
  /** 重试时：包括这一次在内还能提交几次（总共 ATTEST_MAX_TRIES 次）。 */
  remaining?: number
}
/**
 * attestor 的第二参数：谁在要证明。tool = 命令的 origin.tool；块桥发的命令是 `block:<blockId>:<action>`，blockId 由宿主按清单填（插件改不了）。
 * title = 调用方给的「动作 + 对象」（command 的 opts.title，可缺；插件发起时壳要另标来源，不能只信 title）。
 */
export interface AttestContext { tool: string; blockId?: string; title?: string }
/** 旧签名 `(req) => …` 照样可用（第二参数可忽略）；第二参数在类型上可选（SDK 照常总是传），拿到一个 Attestor 只传 req 调用也能编译。 */
export type Attestor = (req: AttestRequest, ctx?: AttestContext) => Promise<Attestation | null>
/** 一条命令的进出（onCommand / onSettled 的参数）：params 是调用方传进 command 的同一个对象（未改写），tool = origin.tool。 */
export interface CommandInfo { action: string; params: unknown; tool: string }
/** 开了重试时一次命令最多调 attestor 的次数（含第一次）。 */
export const ATTEST_MAX_TRIES = 5
export const AUTH_FAILED = 'AUTH_FAILED'
const blockIdOf = (tool: string, action: string): string | undefined =>
  (tool.startsWith('block:') && tool.endsWith(':' + action) ? tool.slice(6, tool.length - action.length - 1) || undefined : undefined)

export class KernelError extends Error {
  /** 本地交互取消；未处理的 1010 绝不等同取消。 */
  cancelled = false
  readonly code: number
  /** 契约 §2.8 Problem 名（如 `RULE_DENIED`、`AUTH_FAILED`），没有则 undefined。 */
  readonly problemName: string | undefined
  /** 内核给的 Problem 原样保留（不改写上游文案）。 */
  readonly problem: unknown
  constructor(code: number, message: string, problem?: unknown) {
    super(message)
    this.name = 'KernelError'
    this.code = code
    this.problem = problem
    const n = (problem as { name?: unknown } | undefined)?.name
    this.problemName = typeof n === 'string' ? n : undefined
  }
}

/** 连接丢失 / 超时：命令的结果未知，调用方不得盲目重发。 */
export const CODE_CONNECTION_LOST = -32001
export const CODE_TIMEOUT = -32002
export const CODE_CLOSED = -32003
export const ATTESTATION_REQUIRED = 'ATTESTATION_REQUIRED'

/** 长命令：内核里是串行多步（撤单、平仓、复查、重试），15 s 不够——接管、平仓、全撤、恢复交易给 60 s（修复轮 4 · C9）。 */
export const isLongCommand = (action: unknown): boolean => typeof action === 'string' && /^(takeover\.|position\.close$|order\.cancel_all$|trading_state\.resume$)/.test(action)

interface WebSocketLike {
  readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  onopen: ((ev: unknown) => void) | null
  onclose: ((ev: unknown) => void) | null
  onerror: ((ev: unknown) => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
}
type WebSocketCtorLike = new (url: string) => WebSocketLike

export interface KernelClientOptions {
  url: string
  getToken: () => string | Promise<string>
  WebSocketCtor?: WebSocketCtorLike
  clientName?: string
  instanceId?: string
  requestTimeoutMs?: number
  /** 长命令（isLongCommand）的超时，缺省 60000。 */
  longRequestTimeoutMs?: number
  reconnect?: { minMs?: number; maxMs?: number } | false
}

interface Sub {
  topic: string
  filter?: unknown
  maxHz?: number
  handler: (e: EventEnvelope) => void
  serverId?: string
  lastSeq?: number
  pendingUnsub?: boolean
  sending?: boolean
}

interface Pending { resolve: (v: unknown) => void; reject: (e: unknown) => void; timer: ReturnType<typeof setTimeout>; method: string }

const OPEN = 1

export class KernelClient {
  private ws: WebSocketLike | null = null
  private nextId = 1
  private pending = new Map<number, Pending>()
  private subs = new Set<Sub>()
  private byServerId = new Map<string, Sub>()
  private statusListeners = new Set<(s: ClientStatus) => void>()
  private _status: ClientStatus = 'idle'
  private attestor: Attestor | null = null
  private attestRetry = false
  private commandListeners = new Set<(c: CommandInfo) => void>()
  private settledListeners = new Set<(c: CommandInfo & { ok: boolean }) => void>()
  private closedByUser = false
  private attempt = 0
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private opening: Promise<void> | null = null
  /** 登录后内核回报的用户 id。 */
  user: string | null = null
  /** 最近一次致命错误（鉴权失败等）。 */
  lastError: KernelError | null = null

  constructor(private readonly opts: KernelClientOptions) {}

  get status(): ClientStatus { return this._status }

  onStatus(fn: (s: ClientStatus) => void): () => void {
    this.statusListeners.add(fn)
    return () => { this.statusListeners.delete(fn) }
  }

  /**
   * 注入在场证明的来源（壳的 PIN 弹层）。opts.retry = true：带证明重发后内核回 AUTH_FAILED（PIN 错 / 锁定）时，
   * 再调 attestor（req 带 error / retryAfterMs / remaining），直到成功、用户取消或累计 ATTEST_MAX_TRIES 次。不开 = 旧行为（只问一次）。
   */
  private attestKeepLocked = false
  setAttestor(fn: Attestor | null, opts: { retry?: boolean; keepLocked?: boolean } = {}): void { this.attestor = fn; this.attestRetry = opts.retry === true; this.attestKeepLocked = opts.keepLocked === true }

  /** 观察命令发出（宿主用，例如壳跟踪「接管在跑」）：每次 command()（含块桥发的）调一次 fn，返回取消函数。不登记 = 旧行为。 */
  onCommand(fn: (c: CommandInfo) => void): () => void {
    this.commandListeners.add(fn)
    return () => { this.commandListeners.delete(fn) }
  }

  /**
   * 观察命令落定（宿主用，例如 PIN 弹层等「带证明重发」落定才关）：每次 command() 结束调一次 fn——成功、失败、在场证明被取消都算，
   * 带证明的重发与开了 retry 的重试算同一条命令（只调一次）。ok = 有没有抛错（结果读法照旧由调用方定，G3）。返回取消函数。不登记 = 旧行为。
   */
  onSettled(fn: (c: CommandInfo & { ok: boolean }) => void): () => void {
    this.settledListeners.add(fn)
    return () => { this.settledListeners.delete(fn) }
  }

  private setStatus(s: ClientStatus): void {
    if (this._status === s) return
    this._status = s
    for (const fn of this.statusListeners) { try { fn(s) } catch { /* 监听者出错不影响连接 */ } }
  }

  /** 建立连接并鉴权。重复调用复用同一次连接。 */
  connect(): Promise<void> {
    if (this._status === 'open') return Promise.resolve()
    if (this.opening) return this.opening
    this.closedByUser = false
    this.opening = this.open().finally(() => { this.opening = null })
    return this.opening
  }

  private open(): Promise<void> {
    this.setStatus(this.attempt === 0 ? 'connecting' : 'reconnecting')
    const Ctor = this.opts.WebSocketCtor ?? ((globalThis as { WebSocket?: unknown }).WebSocket as WebSocketCtorLike | undefined)
    if (!Ctor) return Promise.reject(new KernelError(CODE_CLOSED, '当前环境没有 WebSocket'))
    return new Promise<void>((resolve, reject) => {
      let settled = false
      const ws = new Ctor(this.opts.url)
      this.ws = ws
      ws.onopen = () => {
        void (async () => {
          try {
            const token = await this.opts.getToken()
            const res = (await this.rpc('auth', { token, client: { name: this.opts.clientName ?? 'workbench', instanceId: this.opts.instanceId } }, ws)) as { user?: string } | undefined
            this.user = res?.user ?? null
            this.attempt = 0
            this.lastError = null
            this.setStatus('open')
            await this.resubscribeAll()
            settled = true
            resolve()
          } catch (e) {
            const err = e instanceof KernelError ? e : new KernelError(CODE_CONNECTION_LOST, String((e as Error)?.message ?? e))
            this.lastError = err
            const fatal = err.problemName === 'AUTH_FAILED'
            if (fatal) { this.closedByUser = true; this.setStatus('closed') }
            try { ws.close() } catch { /* 已关闭 */ }
            if (!settled) { settled = true; reject(err) }
          }
        })()
      }
      ws.onmessage = (ev) => this.onMessage(ev.data)
      ws.onerror = () => { /* 细节在 onclose 处理 */ }
      ws.onclose = () => {
        if (this.ws === ws) this.ws = null
        this.failPending(new KernelError(CODE_CONNECTION_LOST, '与内核的连接断开；进行中的命令结果未知，请先核对状态再重试'))
        for (const s of this.subs) delete s.serverId
        this.byServerId.clear()
        if (!settled) { settled = true; reject(this.lastError ?? new KernelError(CODE_CONNECTION_LOST, '无法连接内核')) }
        if (this.closedByUser) { this.setStatus('closed'); return }
        this.scheduleReconnect()
      }
    })
  }

  private scheduleReconnect(): void {
    const r = this.opts.reconnect
    if (r === false) { this.setStatus('closed'); return }
    this.setStatus('reconnecting')
    const min = r?.minMs ?? 250
    const max = r?.maxMs ?? 5000
    const delay = Math.min(max, min * 2 ** this.attempt)
    this.attempt += 1
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      if (this.closedByUser) return
      this.open().catch(() => { /* onclose 已安排下一次 */ })
    }, delay)
  }

  close(): void {
    this.closedByUser = true
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null }
    const ws = this.ws
    this.ws = null
    this.failPending(new KernelError(CODE_CLOSED, '连接已关闭'))
    try { ws?.close() } catch { /* 已关闭 */ }
    this.setStatus('closed')
  }

  private failPending(err: KernelError): void {
    for (const [id, p] of this.pending) { clearTimeout(p.timer); p.reject(err); this.pending.delete(id) }
  }

  private rpc(method: string, params: unknown, via?: WebSocketLike): Promise<unknown> {
    const ws = via ?? this.ws
    if (!ws || ws.readyState !== OPEN) return Promise.reject(new KernelError(CODE_CONNECTION_LOST, '内核未连接'))
    const id = this.nextId++
    const long = method === 'command' && isLongCommand((params as { action?: unknown } | null | undefined)?.action)
    const timeoutMs = long ? this.opts.longRequestTimeoutMs ?? 60000 : this.opts.requestTimeoutMs ?? 15000
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new KernelError(CODE_TIMEOUT, `${method} 超时（${timeoutMs} ms）；结果未知，请先核对状态再重试`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer, method })
      try { ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params })) } catch (e) {
        clearTimeout(timer); this.pending.delete(id)
        reject(new KernelError(CODE_CONNECTION_LOST, String((e as Error)?.message ?? e)))
      }
    })
  }

  private onMessage(raw: unknown): void {
    let msg: { id?: number; method?: string; params?: unknown; result?: unknown; error?: { code?: number; message?: string; data?: unknown } }
    try { msg = JSON.parse(typeof raw === 'string' ? raw : String(raw)) } catch { return }
    const batch = Array.isArray(msg) ? (msg as typeof msg[]) : [msg]
    for (const m of batch) this.dispatch(m)
  }

  private dispatch(m: { id?: number; method?: string; params?: unknown; result?: unknown; error?: { code?: number; message?: string; data?: unknown } }): void {
    if (m.id !== undefined && (m.result !== undefined || m.error !== undefined)) {
      const p = this.pending.get(m.id)
      if (!p) return
      this.pending.delete(m.id)
      clearTimeout(p.timer)
      if (m.error) p.reject(new KernelError(m.error.code ?? -32603, m.error.message ?? '内核错误', m.error.data))
      else p.resolve(m.result)
      return
    }
    if (m.method === 'event' && m.params) this.onEvent(m.params as { subscriptionId?: string; topic?: string; events?: Array<{ seq?: number; ts?: number; data: unknown }>; seq?: number; ts?: number; data?: unknown })
  }

  private onEvent(p: { subscriptionId?: string; topic?: string; events?: Array<{ seq?: number; ts?: number; data: unknown }>; seq?: number; ts?: number; data?: unknown }): void {
    const sub = p.subscriptionId ? this.byServerId.get(p.subscriptionId) : undefined
    if (!sub) return
    const events = p.events ?? [{ seq: p.seq, ts: p.ts, data: p.data }]
    for (const e of events) {
      if (typeof e.seq === 'number') sub.lastSeq = e.seq
      try { sub.handler({ topic: p.topic ?? sub.topic, seq: e.seq, ts: e.ts, data: e.data }) } catch { /* 块里的错误不影响其他订阅 */ }
    }
  }

  // ---- 订阅 / 查询 / 命令 ----------------------------------------------------------

  subscribe(topic: string, handler: (e: EventEnvelope) => void, opts: { filter?: unknown; maxHz?: number } = {}): () => void {
    const sub: Sub = { topic, handler, filter: opts.filter, maxHz: opts.maxHz }
    this.subs.add(sub)
    if (this._status === 'open') void this.sendSubscribe(sub).catch(() => { /* 重连时会重订 */ })
    return () => {
      this.subs.delete(sub)
      if (sub.serverId) {
        this.byServerId.delete(sub.serverId)
        if (this._status === 'open') void this.rpc('unsubscribe', { subscriptionId: sub.serverId }).catch(() => { /* 连接已断则无需取消 */ })
      } else sub.pendingUnsub = true
    }
  }

  private async sendSubscribe(sub: Sub): Promise<void> {
    if (sub.serverId || sub.sending) return
    sub.sending = true
    try { await this.doSubscribe(sub) } finally { sub.sending = false }
  }

  private async doSubscribe(sub: Sub): Promise<void> {
    const params: Record<string, unknown> = { topic: sub.topic }
    if (sub.filter !== undefined) params.filter = sub.filter
    if (sub.maxHz !== undefined) params.maxHz = sub.maxHz
    if (sub.lastSeq !== undefined) params.fromSeq = sub.lastSeq + 1
    const res = (await this.rpc('subscribe', params)) as { subscriptionId: string }
    if (!this.subs.has(sub) || sub.pendingUnsub) { void this.rpc('unsubscribe', { subscriptionId: res.subscriptionId }).catch(() => {}); return }
    sub.serverId = res.subscriptionId
    this.byServerId.set(res.subscriptionId, sub)
  }

  private async resubscribeAll(): Promise<void> {
    await Promise.all([...this.subs].map((s) => this.sendSubscribe(s).catch(() => { /* 单个订阅失败不拖垮连接 */ })))
  }

  query<T = unknown>(method: string, params?: unknown): Promise<T> {
    return this.rpc('query', { method, params: params ?? {} }) as Promise<T>
  }

  /**
   * 发命令。内核回 ATTESTATION_REQUIRED 时调注入的 attestor（壳的 PIN 弹层）拿在场证明后重发一次；
   * 用户取消则抛 KernelError(ATTESTATION_REQUIRED)。其他错误原样抛出，不改写文案。
   * 开了重试（setAttestor 的 opts.retry）时，证明被拒（AUTH_FAILED）会带原文再问，见 setAttestor；中途取消同样抛 ATTESTATION_REQUIRED。
   * opts.title：给 PIN 弹层的「动作 + 对象」（只是提示，原样交给 attestor 的第二参数）。
   * 登记了 onCommand / onSettled 的观察者在发出前 / 落定后各收到一次（观察者出错不影响命令）。
   */
  async command<T = unknown>(action: string, params?: unknown, opts: { tool?: string; attestation?: Attestation; title?: string } = {}): Promise<T> {
    const info: CommandInfo = { action, params, tool: opts.tool ?? `ui:${action}` }
    for (const fn of this.commandListeners) { try { fn(info) } catch { /* 观察者出错不影响命令 */ } }
    let ok = false
    try {
      const r = await this.exec<T>(action, params, opts)
      ok = true
      return r
    } finally {
      const s = { ...info, ok }
      for (const fn of this.settledListeners) { try { fn(s) } catch { /* 同上 */ } }
    }
  }

  private async exec<T>(action: string, params: unknown, opts: { tool?: string; attestation?: Attestation; title?: string }): Promise<T> {
    const tool = opts.tool ?? `ui:${action}`
    const send = (attestation?: Attestation) => this.rpc('command', {
      action, params: params ?? {}, origin: { tool, via: 'ui' }, ...(attestation ? { attestation } : {}),
    }) as Promise<T>
    try {
      return await send(opts.attestation)
    } catch (e) {
      const attestor = this.attestor
      if (!(e instanceof KernelError && e.problemName === ATTESTATION_REQUIRED && attestor && !opts.attestation)) throw e
      const retry = this.attestRetry
      const blockId = blockIdOf(tool, action)
      const ctx: AttestContext = { tool, ...(blockId ? { blockId } : {}), ...(opts.title ? { title: opts.title } : {}) }
      let req: AttestRequest = { action, params, reason: e.message }
      for (let n = 1; ; n += 1) {
        const att = await attestor(req, ctx)
        if (!att) { e.cancelled = true; throw e }
        try {
          return await send(att)
        } catch (e2) {
          if (!retry || !(e2 instanceof KernelError && e2.problemName === AUTH_FAILED)) throw e2
          const wait = (e2.problem as { retryAfterMs?: unknown } | undefined)?.retryAfterMs
          if (n >= ATTEST_MAX_TRIES) {
            if (!this.attestKeepLocked || typeof wait !== 'number' || wait <= 0) throw e2
            n = 0 // 壳保留锁定倒计时；下一次重发仍须人输入 PIN。
          }
          req = { action, params, reason: e.message, error: e2.message, remaining: ATTEST_MAX_TRIES - n, ...(typeof wait === 'number' ? { retryAfterMs: wait } : {}) }
        }
      }
    }
  }
}
