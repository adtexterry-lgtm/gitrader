// SPDX-License-Identifier: CPAL-1.0
// 内核指标：Prometheus 0.0.4 文本格式；事件总线逐主题计数；只读，不改任何内核状态。
import { EVENT_TOPICS } from './events'
import type { EventBus } from './events'

export interface MetricsSource { events: EventBus; status(): Record<string, unknown> }

/** 标签值转义：先反斜杠后双引号。 */
const escapeLabel = (v: string): string => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')

/** 字段缺失或不是有限数时按 0 处理。 */
const finiteNumber = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/** Notification counters are shared by the outlet and every HTTP metrics view of the same bus. */
export class NotificationMetrics {
  private sent = new Map<string, Map<string, number>>()
  private failed = new Map<string, Map<string, number>>()
  dropped = 0
  deduplicated = 0
  merged = 0
  redacted = 0
  retried = 0
  private increment(map: Map<string, Map<string, number>>, channel: string, label: string): void {
    let values = map.get(channel)
    if (!values) { values = new Map(); map.set(channel, values) }
    values.set(label, (values.get(label) ?? 0) + 1)
  }
  recordSent(channel: string, level: string): void { this.increment(this.sent, channel, level) }
  recordFailed(channel: string, reason: string): void { this.increment(this.failed, channel, reason) }
  render(): string[] {
    const lines: string[] = []
    for (const [name, label, values] of [
      ['notify_sent_total', 'level', this.sent],
      ['notify_failed_total', 'reason', this.failed],
    ] as const) {
      lines.push(`# TYPE ${name} counter`)
      for (const [channel, labels] of values) for (const [value, count] of labels) lines.push(`${name}{channel="${escapeLabel(channel)}",${label}="${escapeLabel(value)}"} ${count}`)
    }
    for (const [name, count] of [
      ['notify_dropped_total', this.dropped], ['notify_deduplicated_total', this.deduplicated],
      ['notify_merged_total', this.merged], ['notify_redacted_total', this.redacted], ['notify_retried_total', this.retried],
    ] as const) lines.push(`# TYPE ${name} counter`, `${name} ${count}`)
    return lines
  }
}
const notificationCounters = new WeakMap<EventBus, NotificationMetrics>()
export function notificationMetrics(events: EventBus): NotificationMetrics {
  let counters = notificationCounters.get(events)
  if (!counters) { counters = new NotificationMetrics(); notificationCounters.set(events, counters) }
  return counters
}

const opRateCounterMaps = new WeakMap<EventBus, Map<string, number>>()
/** Shared per-principal bucket of calls refused by the operation rate limit. */
export function opRateCounters(events: EventBus): Map<string, number> {
  let counters = opRateCounterMaps.get(events)
  if (!counters) { counters = new Map(); opRateCounterMaps.set(events, counters) }
  return counters
}

export class Metrics {
  readonly eventsTotal: Map<string, number>

  constructor(private readonly src: MetricsSource) {
    this.eventsTotal = new Map<string, number>()
    for (const topic of EVENT_TOPICS) this.eventsTotal.set(topic, 0)
    for (const topic of EVENT_TOPICS) {
      src.events.subscribe(topic, () => {
        this.eventsTotal.set(topic, (this.eventsTotal.get(topic) ?? 0) + 1)
      })
    }
  }

  render(): string {
    const status = this.src.status()
    const uptimeMs = finiteNumber(status.uptimeMs)
    const ledger = status.ledger as { count?: unknown } | null | undefined
    const ledgerCount = finiteNumber(ledger?.count)
    const tradingState = status.tradingState === undefined || status.tradingState === null ? 'unknown' : String(status.tradingState)
    const mem = process.memoryUsage()
    const lines = [
      '# HELP gitrader_up 1 while the kernel process is running',
      '# TYPE gitrader_up gauge',
      'gitrader_up 1',
      '# HELP gitrader_uptime_seconds Seconds since the kernel started',
      '# TYPE gitrader_uptime_seconds gauge',
      `gitrader_uptime_seconds ${(uptimeMs / 1000).toFixed(3)}`,
      '# HELP gitrader_process_rss_bytes Resident set size of the kernel process',
      '# TYPE gitrader_process_rss_bytes gauge',
      `gitrader_process_rss_bytes ${mem.rss}`,
      '# HELP gitrader_process_heap_used_bytes V8 heap used by the kernel process',
      '# TYPE gitrader_process_heap_used_bytes gauge',
      `gitrader_process_heap_used_bytes ${mem.heapUsed}`,
      '# HELP gitrader_ledger_entries Number of ledger entries',
      '# TYPE gitrader_ledger_entries gauge',
      `gitrader_ledger_entries ${ledgerCount}`,
      '# HELP gitrader_trading_state Effective trading state (1 for the current state)',
      '# TYPE gitrader_trading_state gauge',
      `gitrader_trading_state{state="${escapeLabel(tradingState)}"} 1`,
      '# HELP gitrader_events_total Kernel event bus events by topic',
      '# TYPE gitrader_events_total counter',
    ]
    for (const topic of EVENT_TOPICS) lines.push(`gitrader_events_total{topic="${escapeLabel(topic)}"} ${this.eventsTotal.get(topic) ?? 0}`)
    lines.push(...notificationMetrics(this.src.events).render())
    lines.push(
      '# HELP gitrader_op_rate_limited_total Calls refused by the operation rate limit, by principal',
      '# TYPE gitrader_op_rate_limited_total counter',
    )
    for (const [label, count] of opRateCounters(this.src.events)) lines.push(`gitrader_op_rate_limited_total{principal="${escapeLabel(label)}"} ${count}`)
    return lines.map((line) => `${line}\n`).join('')
  }
}
