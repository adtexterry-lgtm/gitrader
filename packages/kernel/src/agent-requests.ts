// SPDX-License-Identifier: CPAL-1.0
// 接入请求（人在浏览器输 PIN 批准）：只存内存，进程重启即失效——这是设计。
// 请求里只放 agentkey.create 的入参；令牌只在批准时生成并落盘，任何返回值都不带令牌。
import { randomBytes } from 'node:crypto'
import { makeProblem } from './proto'
import { KernelError } from './util/errors'

export type AgentRequestState = 'pending' | 'approved' | 'rejected' | 'expired'

export interface AgentRequestView {
  requestId: string
  state: AgentRequestState
  createdAt: number
  expiresAt: number
  /** 与 agentkey.create 的 input 同形。 */
  input: unknown
  keyId?: string
  tokenFilePath?: string
  note?: string
}

const bad = (m: string): KernelError => new KernelError(makeProblem('INVALID_PARAMS', m))

export class AgentRequests {
  private readonly now: () => number
  private readonly ttlMs: number
  private readonly max: number
  private readonly onChange?: () => void
  private readonly items = new Map<string, AgentRequestView>()

  constructor(o: { clock: { now(): number }; ttlMs?: number; max?: number; onChange?: () => void }) {
    this.now = () => o.clock.now()
    this.ttlMs = o.ttlMs ?? 600_000
    this.max = o.max ?? 3
    this.onChange = o.onChange
  }

  create(input: unknown): AgentRequestView {
    this.sweep()
    if (this.pending().length >= this.max) throw bad(`已有 ${this.max} 个待批准的接入请求；请先在工作台处理`)
    const now = this.now()
    const view: AgentRequestView = {
      requestId: `akr_${randomBytes(8).toString('hex')}`,
      state: 'pending',
      createdAt: now,
      expiresAt: now + this.ttlMs,
      input,
    }
    this.items.set(view.requestId, view)
    this.onChange?.()
    return { ...view }
  }

  /** 只列 pending（先清掉过期的）。 */
  list(): AgentRequestView[] {
    this.sweep()
    return this.pending().map((v) => ({ ...v }))
  }

  /** 过期的显示 expired；不存在返回 undefined。 */
  get(requestId: string): AgentRequestView | undefined {
    const v = this.items.get(requestId)
    if (!v) return undefined
    if (v.state === 'pending' && this.now() >= v.expiresAt) {
      const expired: AgentRequestView = { ...v, state: 'expired' }
      this.items.set(requestId, expired)
      this.onChange?.()
      return { ...expired }
    }
    return { ...v }
  }

  settle(requestId: string, r: { state: 'approved'; keyId: string; tokenFilePath: string } | { state: 'rejected'; note?: string }): AgentRequestView {
    const cur = this.get(requestId)
    if (!cur) throw bad(`没有这个接入请求（可能内核重启过）`)
    if (cur.state !== 'pending') throw bad(`接入请求不是待批准状态（当前 ${cur.state}）`)
    const next: AgentRequestView = r.state === 'approved'
      ? { ...cur, state: 'approved', keyId: r.keyId, tokenFilePath: r.tokenFilePath }
      : { ...cur, state: 'rejected', ...(r.note ? { note: r.note } : {}) }
    this.items.set(requestId, next)
    this.onChange?.()
    return { ...next }
  }

  private pending(): AgentRequestView[] {
    return [...this.items.values()].filter((v) => v.state === 'pending')
  }

  /** 过期清理：pending 且到点的标成 expired；有过变动就通知一次。 */
  private sweep(): void {
    const now = this.now()
    let changed = false
    for (const [id, v] of this.items) {
      if (v.state !== 'pending' || now < v.expiresAt) continue
      this.items.set(id, { ...v, state: 'expired' })
      changed = true
    }
    if (changed) this.onChange?.()
  }
}
