// SPDX-License-Identifier: CPAL-1.0
// R2-REL-03：通知落盘队列。已经路由到某个通道、还没确认送达的 warn / critical 通知记在 GITRADER_HOME 里的一个小日志文件
// （一行一条操作：add / del），内核崩溃重启后在有效期内对没送达的通道各补发一次（同一个去重键）。
// 只存已脱敏的通知正文；不写账本、不碰钥匙。只追加，硬杀时最多丢最后一行半截的记录。
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { writeFileAtomic } from '../util/fsperm'
import type { Notice } from './templates'

/** 落盘通知的有效期：超过就不再补发（过期的告警比没有更糟）。 */
export const OUTBOX_TTL_MS = 10 * 60_000
const OUTBOX_MAX_ENTRIES = 500
/** 日志里的操作行数超过这个值、且远多于存活记录时压实一次（重写成只剩存活记录）。 */
const COMPACT_OPS = 2000

export interface OutboxEntry { id: string; channelId: string; notice: Notice; queuedAt: number }

/** 同一通道上同一条通知只有一条记录。 */
export const outboxId = (channelId: string, noticeKey: string): string => JSON.stringify([channelId, noticeKey])

export class NoticeOutbox {
  private entries = new Map<string, OutboxEntry>()
  private ops = 0
  constructor(private readonly file: string, private readonly log: (message: string) => void) { this.load() }

  private load(): void {
    if (!existsSync(this.file)) return
    try {
      for (const line of readFileSync(this.file, 'utf8').split('\n')) {
        if (!line) continue
        this.ops++
        try {
          const op = JSON.parse(line) as { op?: string; entry?: OutboxEntry; id?: string }
          if (op.op === 'add' && op.entry && typeof op.entry.id === 'string' && typeof op.entry.channelId === 'string' && typeof op.entry.queuedAt === 'number' && op.entry.notice && typeof op.entry.notice.key === 'string') this.entries.set(op.entry.id, op.entry)
          else if (op.op === 'del' && typeof op.id === 'string') this.entries.delete(op.id)
        } catch { /* 硬杀留下的半截行：丢掉 */ }
      }
    } catch { this.log('notification outbox is unreadable and was ignored (notices queued before the restart are lost)') }
    if (this.ops > this.entries.size) this.compact()
  }

  /** 还在有效期内的记录（按入队先后）；过期的顺手清掉。 */
  pending(now: number): OutboxEntry[] {
    for (const e of [...this.entries.values()]) if (now - e.queuedAt >= OUTBOX_TTL_MS) this.remove(e.id)
    return [...this.entries.values()].sort((a, b) => a.queuedAt - b.queuedAt)
  }

  add(entry: OutboxEntry): void {
    this.entries.set(entry.id, entry)
    this.append({ op: 'add', entry })
    while (this.entries.size > OUTBOX_MAX_ENTRIES) this.remove(this.entries.keys().next().value as string)
  }

  remove(id: string): void {
    if (this.entries.delete(id)) this.append({ op: 'del', id })
  }

  private append(op: Record<string, unknown>): void {
    try {
      appendFileSync(this.file, `${JSON.stringify(op)}\n`, 'utf8')
      if (++this.ops > COMPACT_OPS && this.ops > this.entries.size * 4) this.compact()
    } catch (error) { this.log(`notification outbox write failed: ${error instanceof Error ? error.message : String(error)}`) }
  }

  /** 重写成只剩存活记录的日志（原子替换）。 */
  private compact(): void {
    try {
      writeFileAtomic(this.file, [...this.entries.values()].map(entry => `${JSON.stringify({ op: 'add', entry })}\n`).join(''))
      this.ops = this.entries.size
    } catch (error) { this.log(`notification outbox compaction failed: ${error instanceof Error ? error.message : String(error)}`) }
  }
}
