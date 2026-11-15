// SPDX-License-Identifier: CPAL-1.0
// 会话与事件流（契约 §2.2 续传、§2.5 事件流）。
// 一个会话 = 一条全局单调递增的 seq（跨流）+ 一个保留窗 + 订阅集合。连接断开后会话继续存活（保留窗内），
// 宿主用 gep.hello({resume:{sessionId,lastSeq}}) 重连即可补发 seq > lastSeq 的事件。
//
// 损失等级（GEP_STREAMS）：
//   lossless    永不丢弃；缓冲溢出（硬上限）时发 gep.overflow，宿主随后必须调 engine.snapshot。
//   conflatable 未确认 > 5,000 条时，同一键的事件只保留最新一条并带 `conflated: <被合并掉的条数>`，
//               每键至多每秒放行一条（宿主恢复确认后立即补发最新状态）。
//   lossy       (log) 未确认 > 5,000 条时丢弃，计数挂在下一条放行的事件的 `conflated` 上。
import { GEP_LIMITS, GEP_STREAMS, type AccountId, type Causation, type GepEvent, type GepStream, type InstrumentId, type Origin } from '../proto'
import { newId } from '../util/hash'

export interface EventDraft {
  stream: GepStream
  /** 类型名第一段必须等于 stream。 */
  type: string
  ts?: number
  accountId?: AccountId
  instrumentId?: InstrumentId
  data: Record<string, unknown>
  origin?: Origin
  causation?: Causation
  /** 可合并流的合并键（缺省：type + accountId + instrumentId）。 */
  key?: string
}

export interface Subscription { id: string; streams: Set<GepStream>; accountIds?: Set<string> }

interface Entry { ev: GepEvent; at: number; delivered: boolean }

const LOSS = new Map<string, 'lossless' | 'conflatable' | 'lossy'>(GEP_STREAMS.map((s) => [s.stream, s.loss]))

export interface SessionOptions {
  /** 保留窗的最小事件数 / 最小时长。 */
  retentionMinEvents?: number
  retentionMinMs?: number
  /** 缓冲硬上限（超过即丢最老的并发 gep.overflow）。 */
  hardCapEvents?: number
  /** 未确认超过此数开始合并可合并流。 */
  backpressureUnacked?: number
  /** 合并流放行节奏（毫秒）。 */
  conflateReleaseMs?: number
  /** 每次 events.push 最多带多少条。 */
  batchSize?: number
  now?: () => number
}

export type Sender = (method: 'events.push' | 'gep.overflow', params: unknown) => void

export class Session {
  readonly id: string
  readonly createdAt: number
  seq = 0
  /** 宿主已确认到的 seq。 */
  acked = 0
  /** 当前连接上已推送到的 seq。 */
  sent = 0
  readonly subs = new Map<string, Subscription>()
  /** 连接断开的时刻（null = 在线）。 */
  detachedAt: number | null = null
  droppedLossless = 0
  private buf: Entry[] = []
  private head = 0
  /** 已推送、未确认、且计入背压的条数。 */
  private inflight = 0
  private slots = new Map<string, { draft: GepEvent; merged: number; lastRelease: number }>()
  private sender: Sender | null = null
  private flushTimer: NodeJS.Timeout | null = null
  private releaseTimer: NodeJS.Timeout | null = null
  private readonly o: Required<SessionOptions>

  constructor(opts: SessionOptions = {}) {
    this.o = {
      retentionMinEvents: opts.retentionMinEvents ?? GEP_LIMITS.retentionMinEvents,
      retentionMinMs: opts.retentionMinMs ?? GEP_LIMITS.retentionMinMs,
      hardCapEvents: opts.hardCapEvents ?? 200_000,
      backpressureUnacked: opts.backpressureUnacked ?? GEP_LIMITS.backpressureUnackedEvents,
      conflateReleaseMs: opts.conflateReleaseMs ?? 1000,
      batchSize: opts.batchSize ?? 500,
      now: opts.now ?? Date.now,
    }
    this.id = newId('ses', this.o.now())
    this.createdAt = this.o.now()
  }

  // ---- 连接绑定 ----------------------------------------------------------------

  attach(sender: Sender): void {
    this.sender = sender
    this.detachedAt = null
  }

  detach(): void {
    this.sender = null
    this.detachedAt = this.o.now()
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null }
    if (this.releaseTimer) { clearTimeout(this.releaseTimer); this.releaseTimer = null }
  }

  dispose(): void { this.detach(); this.buf = []; this.head = 0; this.slots.clear() }

  get online(): boolean { return this.sender !== null }

  // ---- 订阅 --------------------------------------------------------------------

  subscribe(streams: GepStream[], accountIds?: string[], fromSeq?: number): { subscriptionId: string; fromSeq: number } {
    const sub: Subscription = { id: newId('sub'), streams: new Set(streams), ...(accountIds && accountIds.length ? { accountIds: new Set(accountIds) } : {}) }
    this.subs.set(sub.id, sub)
    const next = this.seq + 1
    const from = fromSeq !== undefined && fromSeq >= 1 && fromSeq <= next ? Math.max(fromSeq, this.firstSeq()) : next
    if (from < next) {
      for (let i = this.indexAfter(from - 1); i < this.buf.length; i++) {
        const e = this.buf[i]!
        if (e.delivered && e.ev.seq > this.acked && this.inflight > 0) this.inflight -= 1
        e.delivered = false
      }
      this.sent = Math.min(this.sent, from - 1)
    }
    this.scheduleFlush()
    return { subscriptionId: sub.id, fromSeq: from }
  }

  unsubscribe(id: string): boolean { return this.subs.delete(id) }

  private matches(ev: GepEvent): boolean {
    for (const s of this.subs.values()) {
      if (!s.streams.has(ev.stream)) continue
      if (s.accountIds && ev.accountId && !s.accountIds.has(ev.accountId)) continue
      return true
    }
    return false
  }

  // ---- 发出事件 ----------------------------------------------------------------

  /** 追加一条事件（分配 seq / eventId）并安排推送。返回已追加的事件（被合并 / 丢弃时返回 null）。 */
  emit(d: EventDraft): GepEvent | null {
    const now = this.o.now()
    const loss = LOSS.get(d.stream) ?? 'lossless'
    const draft: GepEvent = {
      seq: 0, eventId: newId('evt', now), stream: d.stream, type: d.type, ts: d.ts ?? now,
      ...(d.accountId ? { accountId: d.accountId } : {}), ...(d.instrumentId ? { instrumentId: d.instrumentId } : {}),
      data: d.data, ...(d.origin ? { origin: d.origin } : {}), ...(d.causation ? { causation: d.causation } : {}),
    }
    if (loss !== 'lossless' && this.inflight > this.o.backpressureUnacked && this.matches(draft)) {
      if (loss === 'lossy') {
        const slot = this.slots.get('log:drop') ?? { draft, merged: 0, lastRelease: 0 }
        slot.merged += 1
        this.slots.set('log:drop', slot)
        this.armRelease()
        return null
      }
      const key = `${d.stream}|${d.type}|${d.accountId ?? ''}|${d.instrumentId ?? ''}|${d.key ?? ''}`
      const prev = this.slots.get(key)
      this.slots.set(key, { draft, merged: prev ? prev.merged + 1 : 0, lastRelease: prev?.lastRelease ?? 0 })
      this.armRelease()
      return null
    }
    return this.append(draft, now)
  }

  private append(ev: GepEvent, now: number, merged = 0): GepEvent {
    ev.seq = ++this.seq
    if (merged > 0) ev.conflated = merged
    this.buf.push({ ev, at: now, delivered: false })
    this.trim(now)
    this.scheduleFlush()
    return ev
  }

  private armRelease(): void {
    if (this.releaseTimer || !this.sender) return
    this.releaseTimer = setTimeout(() => { this.releaseTimer = null; this.release() }, this.o.conflateReleaseMs)
    this.releaseTimer.unref?.()
  }

  /** 放行被暂存的可合并事件（每键至多每秒一条；确认恢复后全部放行）。 */
  private release(): void {
    const now = this.o.now()
    const calm = this.inflight <= this.o.backpressureUnacked
    for (const [key, slot] of this.slots) {
      if (!calm && now - slot.lastRelease < this.o.conflateReleaseMs) continue
      this.slots.delete(key)
      const ev = slot.draft
      const out: GepEvent = key === 'log:drop' ? { ...ev, conflated: slot.merged } : ev
      this.append(out, now, key === 'log:drop' ? 0 : slot.merged)
    }
    if (this.slots.size > 0) this.armRelease()
  }

  // ---- 推送与确认 --------------------------------------------------------------

  private scheduleFlush(): void {
    if (this.flushTimer || !this.sender) return
    this.flushTimer = setTimeout(() => { this.flushTimer = null; this.flush() }, 2)
    this.flushTimer.unref?.()
  }

  flush(): void {
    const send = this.sender
    if (!send) return
    for (;;) {
      const batch: GepEvent[] = []
      let i = this.indexAfter(this.sent)
      for (; i < this.buf.length && batch.length < this.o.batchSize; i++) {
        const e = this.buf[i]!
        if (this.matches(e.ev)) { batch.push(e.ev); e.delivered = true; this.inflight += 1 }
        this.sent = e.ev.seq
      }
      if (batch.length === 0) break
      send('events.push', { sessionId: this.id, events: batch })
      if (batch.length < this.o.batchSize) break
    }
    if (this.slots.size > 0) this.armRelease()
  }

  /** 第一条 seq > x 的下标（二分；buf 按 seq 升序）。 */
  private indexAfter(x: number): number {
    let lo = this.head
    let hi = this.buf.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (this.buf[mid]!.ev.seq <= x) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  /** 宿主确认（events.ack 通知）。 */
  ack(upToSeq: number): void {
    if (!(upToSeq > this.acked)) return
    const up = Math.min(upToSeq, this.sent)
    for (let i = this.indexAfter(this.acked); i < this.buf.length; i++) {
      const e = this.buf[i]!
      if (e.ev.seq > up) break
      if (e.delivered && this.inflight > 0) this.inflight -= 1
    }
    this.acked = Math.max(this.acked, up)
    this.trim(this.o.now())
    if (this.slots.size > 0 && this.inflight <= this.o.backpressureUnacked) this.release()
  }

    get unacked(): number { return this.inflight }
  get bufferedEvents(): number { return this.buf.length - this.head }

  // ---- 保留窗与续传 ------------------------------------------------------------

  firstSeq(): number { return this.head < this.buf.length ? this.buf[this.head]!.ev.seq : this.seq + 1 }

  private trim(now: number): void {
    const { retentionMinEvents, retentionMinMs, hardCapEvents } = this.o
    // 正常保留窗：最老的事件已超出「最近 minEvents 条」且已超过 minMs；并且已确认（或本来就没人要确认）
    while (this.head < this.buf.length) {
      const e = this.buf[this.head]!
      const size = this.buf.length - this.head
      const beyondWindow = size > retentionMinEvents && now - e.at >= retentionMinMs
      const settled = e.ev.seq <= this.acked || !e.delivered
      if (beyondWindow && settled) this.head += 1
      else break
    }
    // 硬上限：无损流也只能丢，但必须告知宿主
    while (this.buf.length - this.head > hardCapEvents) {
      const e = this.buf[this.head]!
      if (e.ev.seq > this.acked && (LOSS.get(e.ev.stream) ?? 'lossless') === 'lossless' && (e.delivered || this.matches(e.ev))) {
        this.droppedLossless += 1
        if (e.delivered && this.inflight > 0) this.inflight -= 1
        this.sender?.('gep.overflow', { stream: e.ev.stream, dropped: 1, ts: now })
      }
      this.head += 1
    }
    if (this.head > 50_000 && this.head > this.buf.length / 2) { this.buf = this.buf.slice(this.head); this.head = 0 }
  }

  /** 是否还能补发 seq > lastSeq 的全部事件。 */
  canResumeFrom(lastSeq: number): 'ok' | 'gap' | 'future' {
    if (lastSeq > this.seq) return 'future'
    if (lastSeq === this.seq) return 'ok'
    return lastSeq + 1 >= this.firstSeq() ? 'ok' : 'gap'
  }

  /** 续传：把「已推送」游标拨回 lastSeq，后续 flush 会补发。 */
  rewindTo(lastSeq: number): void {
    this.acked = lastSeq
    this.sent = lastSeq
    this.inflight = 0
    for (let i = this.indexAfter(lastSeq); i < this.buf.length; i++) this.buf[i]!.delivered = false
    this.scheduleFlush()
  }

  /** 保留窗内 seq > fromSeqExclusive 的事件（测试 / 诊断用）。 */
  tail(fromSeqExclusive: number): GepEvent[] {
    const out: GepEvent[] = []
    for (let i = this.indexAfter(fromSeqExclusive); i < this.buf.length; i++) out.push(this.buf[i]!.ev)
    return out
  }
}
