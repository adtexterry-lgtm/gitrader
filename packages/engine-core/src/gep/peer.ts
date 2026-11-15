// SPDX-License-Identifier: CPAL-1.0
// JSON-RPC 2.0 对等端：同一条连接上，引擎既是服务端（宿主调用 engine.* …）也是客户端（引擎调用 host.*）。
// 契约 §2.1：UTF-8、单帧一个对象或批量数组、WS 单帧 ≤ 4 MiB / stdio 单行 ≤ 1 MiB；错误把 Problem 放在 error.data（§2.8）。
import { makeProblem, type JsonRpcId, type Problem, type ProblemName } from '../proto'

/** 业务代码抛这个，peer 会把它变成带 Problem 的 JSON-RPC 错误响应。 */
export class RpcError extends Error {
  constructor(readonly problem: Problem) {
    super(problem.message)
    this.name = 'RpcError'
  }
}
export const rpcErr = (name: ProblemName, message: string, extra: Partial<Problem> = {}): RpcError => new RpcError(makeProblem(name, message, extra))

export interface PeerOptions {
  /** 把一个已序列化的帧发出去（一行 / 一条 WS 文本消息）。 */
  send(text: string): void
  /** 单帧字节上限（WS 4 MiB、stdio 1 MiB）。 */
  maxFrameBytes: number
  /** 处理一个请求；抛 RpcError 即返回对应错误，抛别的异常一律 -32603（不泄露内部细节）。 */
  handle(method: string, params: unknown, id: JsonRpcId): Promise<unknown> | unknown
  /** 收到通知（无 id）。 */
  onNotify(method: string, params: unknown): void
  /** 内部错误的脱敏日志出口。 */
  onInternalError?(method: string, err: unknown): void
  /** 默认的出站调用超时。 */
  callTimeoutMs?: number
}

interface Pending { resolve(v: unknown): void; reject(e: unknown): void; timer: NodeJS.Timeout; method: string }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

function errorFrame(id: JsonRpcId | null, problem: Problem): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code: problem.code, message: problem.message, data: problem } }
}

/**
 * 一帧 batch 的最大成员数。响应体积随成员数线性放大（实测 20 000 成员 → 请求 100 KB / 响应 3.92 MB，
 * 39.2×），而 `maxFrameBytes` 只管入站，所以出站侧必须有成员上限：超出整帧 INVALID_REQUEST（审计 L4-03）。
 * 与 Python 引擎的 `MAX_BATCH_MEMBERS` 同值。
 */
export const MAX_BATCH_MEMBERS = 100

export class RpcPeer {
  private nextId = 1
  private readonly pending = new Map<JsonRpcId, Pending>()
  private closed = false

  constructor(private readonly o: PeerOptions) {}

  get isClosed(): boolean { return this.closed }

  /** 出站请求（引擎 → 宿主，方法名带 host. 前缀）。 */
  call<T = unknown>(method: string, params: unknown, timeoutMs = this.o.callTimeoutMs ?? 10_000): Promise<T> {
    if (this.closed) return Promise.reject(rpcErr('VENUE_UNAVAILABLE', 'connection closed', { retryable: true }))
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(rpcErr('INTERNAL', `call ${method} timed out after ${timeoutMs} ms`, { retryable: true }))
      }, timeoutMs)
      timer.unref?.()
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer, method })
      this.write({ jsonrpc: '2.0', id, method, params })
    })
  }

  /** 出站通知（无 id）。 */
  notify(method: string, params?: unknown): void {
    if (this.closed) return
    this.write({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) })
  }

  private write(frame: unknown): void {
    try { this.o.send(JSON.stringify(frame)) } catch { /* 连接已断，等 close() 清理 */ }
  }

  /** 连接断开：未完成的出站调用全部失败。 */
  close(): void {
    if (this.closed) return
    this.closed = true
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(rpcErr('VENUE_UNAVAILABLE', `connection closed during ${p.method}`, { retryable: true }))
      this.pending.delete(id)
    }
  }

  /** 收到一帧（一个对象或一个批量数组）。 */
  async receive(text: string): Promise<void> {
    if (this.closed) return
    if (Buffer.byteLength(text, 'utf8') > this.o.maxFrameBytes) {
      this.write(errorFrame(null, makeProblem('PAYLOAD_TOO_LARGE', `frame exceeds ${this.o.maxFrameBytes} bytes`)))
      return
    }
    let msg: unknown
    try { msg = JSON.parse(text) } catch {
      this.write(errorFrame(null, makeProblem('PARSE_ERROR', 'parse error')))
      return
    }
    if (Array.isArray(msg)) {
      if (msg.length === 0) { this.write(errorFrame(null, makeProblem('INVALID_REQUEST', 'empty batch'))); return }
      if (msg.length > MAX_BATCH_MEMBERS) {
        this.write(errorFrame(null, makeProblem('INVALID_REQUEST', `batch has ${msg.length} members; the limit is ${MAX_BATCH_MEMBERS}`)))
        return
      }
      const out = (await Promise.all(msg.map((m) => this.dispatch(m)))).filter((r): r is Record<string, unknown> => r !== null)
      if (out.length > 0) { try { this.o.send(JSON.stringify(out)) } catch { /* ignore */ } }
      return
    }
    const r = await this.dispatch(msg)
    if (r !== null) this.write(r)
  }

  /** 处理单个消息，返回要发回的响应帧（通知 / 响应返回 null）。 */
  private async dispatch(m: unknown): Promise<Record<string, unknown> | null> {
    if (!isObj(m) || m.jsonrpc !== '2.0') return errorFrame(isObj(m) && (typeof m.id === 'number' || typeof m.id === 'string') ? m.id : null, makeProblem('INVALID_REQUEST', 'invalid request'))
    // 响应：对应我们发出的调用
    if (typeof m.method !== 'string') {
      if ('id' in m && ('result' in m || 'error' in m)) { this.settle(m); return null }
      return errorFrame(typeof m.id === 'number' || typeof m.id === 'string' ? m.id : null, makeProblem('INVALID_REQUEST', 'invalid request'))
    }
    if (!('id' in m)) {
      try { this.o.onNotify(m.method, m.params) } catch (e) { this.o.onInternalError?.(m.method, e) }
      return null
    }
    const id = m.id
    if (typeof id !== 'number' && typeof id !== 'string') return errorFrame(null, makeProblem('INVALID_REQUEST', 'id must be a number or a string'))
    try {
      const result = await this.o.handle(m.method, m.params, id)
      return { jsonrpc: '2.0', id, result: result === undefined ? null : result }
    } catch (e) {
      if (e instanceof RpcError) return errorFrame(id, e.problem)
      this.o.onInternalError?.(m.method, e)
      return errorFrame(id, makeProblem('INTERNAL_ERROR', 'internal error'))
    }
  }

  private settle(m: Record<string, unknown>): void {
    const id = m.id as JsonRpcId
    const p = this.pending.get(id)
    if (!p) return
    this.pending.delete(id)
    clearTimeout(p.timer)
    if ('error' in m && isObj(m.error)) {
      const err = m.error
      const data = isObj(err.data) && typeof err.data.code === 'number' ? (err.data as unknown as Problem) : null
      p.reject(new RpcError(data ?? makeProblem('INTERNAL', typeof err.message === 'string' ? err.message : 'remote error', { code: typeof err.code === 'number' ? err.code : 4001 })))
    } else p.resolve(m.result)
  }
}
