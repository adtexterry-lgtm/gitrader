// SPDX-License-Identifier: CPAL-1.0
import type { NotifyChannel, NotifyConfig, NoticeLevel } from '../config'
import type { EventBus, KernelEvent, Unsubscribe } from '../events'
import { notificationMetrics } from '../metrics'
import { NOTIFICATION_CALL } from '../plugins'
import type { PluginHost } from '../plugins'
import { makeProblem } from '../proto'
import { KernelError } from '../util/errors'
import { createHash } from 'node:crypto'
import { NoticeOutbox, outboxId } from './outbox'
import { NOTICE_TOPICS, noticeForEvent, isNoticeEvent } from './templates'
import type { Notice } from './templates'

type SendResult = { ok: true; ref?: string } | { ok: false; reason: string; retryable: boolean }
export type ChannelResult = SendResult & { channelId: string; detail?: string }
/** One notice bound to one channel. Routing, dedupe and rate limits are already decided when a Delivery exists. */
interface Delivery { notice: Notice; channelId: string; done?: (result: { results: ChannelResult[] }) => void; durable?: boolean; /** Set when re-sent after a restart: the validity window runs from the first queueing. */ queuedAt?: number }
interface ChannelQueue { jobs: Delivery[]; busy: boolean }
interface Budget { count: number; merged: number; level: NoticeLevel; expires: number; timer: ReturnType<typeof setTimeout> }
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const stateIdentity = (data: Record<string, unknown>): string => {
  const scope = record(data.scope)
  return JSON.stringify([scope.type, scope.id, data.from, data.to])
}
const rank: Record<NoticeLevel, number> = { info: 0, warn: 1, critical: 2 }
const matches = (pattern: string, topic: string): boolean => pattern === '*' || pattern === topic || (pattern.endsWith('.*') && topic.startsWith(pattern.slice(0, -1)))
const failure = (channelId: string, reason: string): ChannelResult => ({ channelId, ok: false, reason, retryable: false })

/** Per-channel queue bound (it was 1000 for the single shared queue). */
const QUEUE_LIMIT = 1000
/**
 * R2-REL-03: one notice makes at most 3 HTTP attempts on one channel across the whole chain.
 * The channel plugin owns the HTTP retries (growing backoff, one notice key on every attempt) and reports `exhausted: true` when it
 * used them up. The kernel only calls again (once, after at least 200 ms) for failures the plugin did not already retry: it never
 * stacks a second retry layer on top, and never re-calls after a timeout (the first call may still be running inside the plugin).
 */
const KERNEL_RETRY_MIN_MS = 200
/** How long a restarted outlet waits for the channel plugins to be loaded before giving up on re-sending. */
const RESUME_WAIT_MS = 60_000
const RESUME_POLL_MS = 250

/**
 * Event subscribers only route (synchronously) and enqueue. Every channel has its own queue and consumer, so a hung channel never
 * delays another channel; critical notices go in front of the info / warn notices already queued on the same channel.
 */
export class NotifyOutlet {
  readonly metrics
  private queues = new Map<string, ChannelQueue>()
  private closed = false
  private sequence = 0
  private unsubscribe: Unsubscribe[]
  private seen = new Map<string, number>()
  private budgets = new Map<string, Budget>()
  private takeovers = new Map<string, { id: string; expires: number }>()
  private stateChange?: { seq: number; identity: string; takeoverId: string }
  private readonly outbox?: NoticeOutbox
  private resumeTimer?: ReturnType<typeof setInterval>
  constructor(private readonly o: { events: EventBus; plugins: PluginHost; config: () => NotifyConfig | undefined; now: () => number; log: (message: string) => void; /** Unacknowledged warn / critical notices survive a crash in this file (inside GITRADER_HOME). */ outboxFile?: string }) {
    this.metrics = notificationMetrics(o.events)
    if (o.outboxFile) this.outbox = new NoticeOutbox(o.outboxFile, o.log)
    this.unsubscribe = NOTICE_TOPICS.map(topic => o.events.subscribe(topic, event => {
      if (isNoticeEvent(event) && this.channels().length) this.route(event)
    }))
    this.resume()
  }
  private channels(): NotifyChannel[] { return this.o.config()?.channels ?? [] }

  private queueOf(channelId: string): ChannelQueue {
    let queue = this.queues.get(channelId)
    if (!queue) { queue = { jobs: [], busy: false }; this.queues.set(channelId, queue) }
    return queue
  }
  private enqueue(delivery: Delivery): void {
    if (this.closed) { this.cancel(delivery, 'stopped'); return }
    const queue = this.queueOf(delivery.channelId)
    const level = rank[delivery.notice.level]
    if (queue.jobs.length >= QUEUE_LIMIT) {
      // Bound reached: drop the oldest notice of the lowest level (the newcomer itself if it is the least important).
      const lowest = Math.min(...queue.jobs.map(job => rank[job.notice.level]))
      if (level < lowest) { this.cancel(delivery, 'queue_overflow'); this.metrics.dropped++; return }
      this.cancel(queue.jobs.splice(queue.jobs.findIndex(job => rank[job.notice.level] === lowest), 1)[0]!, 'queue_overflow')
      this.metrics.dropped++
    }
    if (delivery.notice.level === 'critical') {
      // In front of everything that is not critical (FIFO among criticals); the notice already in flight is not interrupted.
      const at = queue.jobs.findIndex(job => job.notice.level !== 'critical')
      if (at < 0) queue.jobs.push(delivery)
      else queue.jobs.splice(at, 0, delivery)
    } else queue.jobs.push(delivery)
    if (delivery.durable && this.outbox) this.outbox.add({ id: outboxId(delivery.channelId, delivery.notice.key), channelId: delivery.channelId, notice: delivery.notice, queuedAt: delivery.queuedAt ?? Math.trunc(this.o.now()) })
    if (!queue.busy) {
      queue.busy = true
      queueMicrotask(() => { void this.drain(queue) })
    }
  }
  private cancel(delivery: Delivery, reason: string): void {
    delivery.done?.({ results: [failure(delivery.channelId, reason)] })
  }
  private async drain(queue: ChannelQueue): Promise<void> {
    try {
      while (!this.closed && queue.jobs.length) {
        const delivery = queue.jobs.shift()!
        try { await this.deliver(delivery) }
        catch {
          this.cancel(delivery, 'internal_error')
          this.metrics.dropped++
          this.o.log('notification processing failed: internal_error')
        }
      }
    } finally { queue.busy = false }
  }
  private async deliver(delivery: Delivery): Promise<void> {
    const channel = this.channels().find(candidate => candidate.id === delivery.channelId)
    const result = channel ? await this.send(channel, delivery.notice, delivery.done !== undefined) : failure(delivery.channelId, 'unknown_channel')
    if (delivery.durable && this.outbox) {
      // Keep the record while the failure may be transient (re-sent once after a restart, within its validity); drop it once delivered or hopeless.
      const transient = !result.ok && (result.retryable || ['timeout', 'unavailable', 'internal_error', 'stopped'].includes(result.reason))
      if (!transient) this.outbox.remove(outboxId(delivery.channelId, delivery.notice.key))
    }
    delivery.done?.({ results: [result] })
  }

  /** State publishers lack takeoverId: correlate ledger origin + scope, then its adjacent bus event. */
  private correlateTakeover(event: KernelEvent): KernelEvent {
    const data = record(event.data)
    const previous = this.stateChange
    this.stateChange = undefined
    if (event.topic === 'risk.state' && previous?.seq === event.seq - 1 && previous.identity === stateIdentity(data)) {
      return { ...event, data: { ...data, takeoverId: previous.takeoverId } }
    }
    if (event.topic !== 'ledger.entry') return event
    const payload = record(data.payload)
    const scope = record(payload.scope)
    const origin = record(data.origin)
    if (![origin.actor, origin.requestId, scope.type, scope.id].every(value => typeof value === 'string' && value.length > 0)) return event
    const key = JSON.stringify([origin.actor, origin.requestId, scope.type, scope.id])
    const now = this.o.now()
    for (const [key, takeover] of this.takeovers) if (takeover.expires <= now) this.takeovers.delete(key)
    const takeoverId = record(data.subject).takeoverId
    if (data.type === 'takeover.requested' && typeof takeoverId === 'string') {
      const entry = { id: takeoverId, expires: now + Math.max(300_000, (this.o.config()?.rateLimit?.dedupeWindowSec ?? 300) * 1000) }
      this.takeovers.set(key, entry)
      // fix-r2 D4：受限钥匙的接管把状态收紧在它的授权书作用域上（与请求作用域不同），两个作用域都要能关联到这次接管
      const stateScope = record(payload.stateScope)
      if (typeof stateScope.type === 'string' && typeof stateScope.id === 'string') this.takeovers.set(JSON.stringify([origin.actor, origin.requestId, stateScope.type, stateScope.id]), entry)
    }
    const takeover = this.takeovers.get(key)
    if (data.type === 'trading_state.changed' && takeover) {
      this.stateChange = { seq: event.seq, identity: stateIdentity(payload), takeoverId: takeover.id }
      return { ...event, data: { ...data, payload: { ...payload, takeoverId: takeover.id } } }
    }
    if ((data.type === 'takeover.completed' || data.type === 'takeover.failed') && takeover?.id === takeoverId) this.takeovers.delete(key)
    return event
  }
  /** Synchronous in event order (takeover correlation depends on it): event -> notice -> one Delivery per admitted channel. */
  private route(event: KernelEvent): void {
    try {
      const original = noticeForEvent(this.correlateTakeover(event), () => { this.metrics.redacted++ })
      if (!original) return
      const config = this.o.config()
      const rule = config?.rules?.find(rule => matches(rule.match, original.topic))
      const notice = rule ? { ...original, level: original.topic === 'takeover.failed' || original.topic === 'takeover.alert' ? 'critical' as const : rule.level } : original
      for (const channel of this.channels()) {
        if (rule && !rule.channels.includes(channel.id)) continue
        if (rank[notice.level] < rank[channel.minLevel]) continue
        if (this.closed) return
        if (!this.admit(channel, notice, config)) continue
        this.enqueue({ notice, channelId: channel.id, durable: rank[notice.level] >= rank.warn })
      }
    } catch {
      this.metrics.dropped++
      this.o.log('notification processing failed: internal_error')
    }
  }
  private admit(channel: NotifyChannel, notice: Notice, config: NotifyConfig | undefined): boolean {
    const now = this.o.now()
    for (const [key, expires] of this.seen) if (expires <= now) this.seen.delete(key)
    const key = JSON.stringify([channel.id, notice.key])
    if (this.seen.has(key)) { this.metrics.deduplicated++; return false }
    const windowMs = (config?.rateLimit?.dedupeWindowSec ?? 300) * 1000
    if (windowMs > 0) this.seen.set(key, now + windowMs)
    let budget = this.budgets.get(channel.id)
    if (budget && now >= budget.expires) { this.flush(channel.id, budget); budget = undefined }
    if (!budget) {
      const next: Budget = { count: 0, merged: 0, level: notice.level, expires: now + 60_000, timer: setTimeout(() => this.flush(channel.id, next), 60_000) }
      next.timer.unref?.()
      this.budgets.set(channel.id, next)
      budget = next
    }
    if (budget.count >= (config?.rateLimit?.perChannelPerMinute ?? 20)) {
      budget.merged++
      if (rank[notice.level] > rank[budget.level]) budget.level = notice.level
      this.metrics.merged++
      return false
    }
    budget.count++
    return true
  }
  private flush(channelId: string, budget: Budget): void {
    if (this.budgets.get(channelId) !== budget) return
    clearTimeout(budget.timer)
    this.budgets.delete(channelId)
    if (this.closed || !budget.merged) return
    this.enqueue({ channelId, notice: {
      key: `summary:${channelId}:${budget.expires}`, level: budget.level, topic: 'notify.summary',
      title: `${budget.merged} 条通知被合并`, lines: [`count: ${budget.merged}`, `windowEnd: ${budget.expires}`], ts: Math.trunc(this.o.now()),
    } })
  }
  private pause(ms: number): Promise<void> {
    return new Promise(resolve => { const timer = setTimeout(resolve, ms); timer.unref?.() })
  }
  private async send(channel: NotifyChannel, notice: Notice, diagnostic = false): Promise<ChannelResult> {
    let result: ChannelResult = failure(channel.id, 'internal_error')
    let category = 'internal_error'
    let missingHandle: string | undefined
    // GQ-52：同一条通知在同一通道的每次调用（含内核重试、重启后补发）用同一个幂等键，放在 params.idempotencyKey（B0 入参形状不变）；通道插件转成 Idempotency-Key 头，端点据此去重。
    const idempotencyKey = createHash('sha256').update(JSON.stringify([channel.id, notice.key])).digest('hex')
    for (let attempt = 0; attempt < 2; attempt++) {
      if (this.closed) return failure(channel.id, 'stopped')
      missingHandle = undefined
      let exhausted = false
      try {
        const value = await this.o.plugins.callTool(channel.plugin, 'notify_send', { notice, params: { ...channel.params, idempotencyKey } }, NOTIFICATION_CALL) as (Partial<SendResult> & { exhausted?: unknown }) | null
        if (value?.ok === true && (value.ref === undefined || typeof value.ref === 'string')) {
          this.metrics.recordSent(channel.id, notice.level)
          return { channelId: channel.id, ok: true, ...(value.ref === undefined ? {} : { ref: value.ref }) }
        }
        if (value?.ok === false && typeof value.reason === 'string' && typeof value.retryable === 'boolean') {
          category = 'channel_rejected'
          exhausted = value.exhausted === true
          result = { channelId: channel.id, ok: false, reason: value.reason, retryable: value.retryable }
        } else { category = 'invalid_result'; result = failure(channel.id, category) }
      } catch (error) {
        const name = error instanceof KernelError ? error.problem.name : ''
        category = name === 'BUSY' ? 'timeout' : name === 'PLUGIN_RESULT_INVALID' ? 'invalid_result'
          : name === 'SECRET_FIELD_REJECTED' ? 'secret_rejected' : name === 'VENUE_UNAVAILABLE' ? 'unavailable'
            : name === 'MANDATE_LIMIT' ? 'not_enabled' : name === 'PLUGIN_TOOL_UNKNOWN' ? 'unknown_tool'
              : name === 'INVALID_PARAMS' ? 'invalid_params' : 'internal_error'
        const detail = error instanceof KernelError ? error.problem.message : undefined
        if (name === 'INVALID_PARAMS' && detail && /^missing secret handle: [A-Za-z_][A-Za-z0-9_]*$/.test(detail)) missingHandle = detail
        result = { channelId: channel.id, ok: false, reason: category, retryable: category === 'timeout' || category === 'unavailable',
          ...(diagnostic && detail !== undefined ? { detail } : {}) }
      }
      if (this.closed) return failure(channel.id, 'stopped')
      if (result.ok || !result.retryable || exhausted || category === 'timeout' || attempt === 1) break
      this.metrics.retried++
      await this.pause(KERNEL_RETRY_MIN_MS + Math.random() * 100)
    }
    this.metrics.recordFailed(channel.id, category)
    this.o.log(`notification failed: channel=${channel.id} reason=${category}${missingHandle ? ` detail=${missingHandle}` : ''}`)
    return result
  }

  /**
   * After a restart: re-send, once per channel, the warn / critical notices that were never acknowledged (same notice key, so the
   * receiver can deduplicate) while they are still valid. Waits until the channel plugin is known to the plugin host.
   */
  private resume(): void {
    if (!this.outbox) return
    const waiting = this.outbox.pending(this.o.now()).filter(entry => {
      if (this.channels().some(channel => channel.id === entry.channelId)) return true
      this.outbox!.remove(entry.id)
      return false
    })
    if (!waiting.length) return
    this.o.log(`notification outbox: ${waiting.length} notice(s) not acknowledged before the restart will be re-sent once`)
    const startedAt = Date.now()
    const tick = (): void => {
      for (const entry of [...waiting]) {
        const channel = this.channels().find(candidate => candidate.id === entry.channelId)
        if (!channel) { waiting.splice(waiting.indexOf(entry), 1); this.outbox!.remove(entry.id); continue }
        if (!this.o.plugins.get(channel.plugin)) continue
        waiting.splice(waiting.indexOf(entry), 1)
        this.enqueue({ notice: entry.notice, channelId: entry.channelId, durable: true, queuedAt: entry.queuedAt })
      }
      if (!waiting.length || this.closed || Date.now() - startedAt > RESUME_WAIT_MS) { clearInterval(this.resumeTimer); this.resumeTimer = undefined }
    }
    this.resumeTimer = setInterval(tick, RESUME_POLL_MS)
    this.resumeTimer.unref?.()
    tick()
  }

  /** Human diagnostic: fixed info content, targeted channel; bypasses routing, dedupe and rate limits. */
  test(channelId: string): Promise<{ results: ChannelResult[] }> {
    if (!this.channels().some(channel => channel.id === channelId)) throw new KernelError(makeProblem('INVALID_PARAMS', 'unknown channel'))
    return new Promise(resolve => this.enqueue({ channelId, done: resolve, notice: {
      key: `test:${++this.sequence}:${this.o.now()}`, level: 'info', title: '通知通道测试', lines: [`channelId: ${channelId}`], ts: Math.trunc(this.o.now()), topic: 'notify.test',
    } }))
  }
  stop(): void {
    this.closed = true
    clearInterval(this.resumeTimer)
    this.resumeTimer = undefined
    for (const unsubscribe of this.unsubscribe) unsubscribe()
    this.unsubscribe = []
    for (const budget of this.budgets.values()) clearTimeout(budget.timer)
    this.budgets.clear()
    this.seen.clear()
    this.takeovers.clear()
    this.stateChange = undefined
    // Queued durable notices stay in the outbox on purpose: the next start re-sends them.
    for (const queue of this.queues.values()) {
      for (const delivery of queue.jobs) { this.cancel(delivery, 'stopped'); this.metrics.dropped++ }
      queue.jobs = []
    }
  }
}
