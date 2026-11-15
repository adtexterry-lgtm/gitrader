// SPDX-License-Identifier: CPAL-1.0
import { createHash } from 'node:crypto'
import { findPromiseLanguage } from '../proto'
import type { KernelEvent } from '../events'
import type { NoticeLevel } from '../config'

export interface Notice { key: string; level: NoticeLevel; title: string; lines: string[]; ts: number; topic: string }
export const NOTICE_TOPICS = ['risk.denials', 'risk.state', 'takeover.alert', 'engine.health', 'plugin.state', 'mandate.changed', 'proposal.decided', 'proposal.executed', 'proposal.failed', 'ledger.entry', 'reconciliation.notice'] as const
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const fields = new Set(['id', 'accountId', 'instrumentId', 'orderId', 'proposalId', 'precheckId', 'mandateId', 'takeoverId', 'experimentId', 'pluginId', 'engineId', 'ruleId', 'rule', 'code', 'type', 'state', 'status', 'gep', 'phase', 'from', 'to', 'level', 'actual', 'observed', 'value', 'limit', 'threshold', 'quantity', 'price', 'notional', 'remaining', 'version', 'until', 'sent', 'failed'])
const factToken = /^[A-Za-z0-9_.:/-]{1,64}$/
const groups = new Set(['scope', 'hit', 'ruleHits', 'protector', 'precheck', 'intent', 'decision', 'execution', 'error', 'problem'])

export function isNoticeEvent(event: KernelEvent): boolean {
  if (event.topic !== 'ledger.entry') return (NOTICE_TOPICS as readonly string[]).includes(event.topic)
  const type = record(event.data).type
  return typeof type === 'string' && (['protector.triggered', 'trading_state.changed', 'experiment.stage_changed', 'risk.denied'].includes(type) || type.startsWith('takeover.'))
}

function facts(value: unknown, prefix = '', depth = 0): string[] {
  if (depth > 5) return []
  if (Array.isArray(value)) return value.flatMap((item, i) => facts(item, `${prefix}[${i}]`, depth + 1))
  return Object.entries(record(value)).sort(([a], [b]) => a.localeCompare(b)).flatMap(([key, item]) => {
    const path = prefix ? `${prefix}.${key}` : key
    if (fields.has(key) && (typeof item === 'string' || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item)))) {
      return [`${path}: ${typeof item === 'string' && !factToken.test(item) ? '[text omitted]' : String(item)}`]
    }
    return groups.has(key) ? facts(item, path, depth + 1) : []
  })
}

function defaultLevel(topic: string, data: Record<string, unknown>): NoticeLevel {
  if (topic.startsWith('takeover.') || topic === 'protector.triggered') return 'critical'
  if (topic === 'engine.health' && [data.state, data.status, data.gep].some(value => value === 'down' || value === 'failed')) return 'critical'
  if ((topic === 'risk.state' || topic === 'trading_state.changed') && (data.to === 'HALTED' || data.to === 'REDUCING')) return 'critical'
  if (['risk.denials', 'risk.denied', 'proposal.failed'].includes(topic)) return 'warn'
  if (topic === 'plugin.state' && data.state === 'failed') return 'warn'
  if (topic === 'mandate.changed' && ['downgraded', 'revoked', 'expired'].includes(String(data.status))) return 'warn'
  return 'info'
}

/** Templates include only identified facts; credentials and arbitrary payloads are never serialized. */
export function noticeForEvent(event: KernelEvent, redacted: () => void = () => {}): Notice | undefined {
  if (!(NOTICE_TOPICS as readonly string[]).includes(event.topic)) return undefined
  const envelope = record(event.data)
  if (event.topic === 'reconciliation.notice') {
    const bounded = (value: unknown, limit: number): string => typeof value === 'string' ? value.slice(0, limit) : ''
    const noticeId = bounded(envelope.noticeId, 80)
    const alias = bounded(envelope.accountAlias, 64)
    const code = bounded(envelope.code, 64)
    const summary = bounded(envelope.summary, 180)
    const why = bounded(envelope.why, 300)
    const clean = (line: string): string => {
      if (findPromiseLanguage(line) === null) return line
      redacted()
      return '[redacted wording]'
    }
    const level: NoticeLevel = envelope.severity === 'blocker' ? 'critical' : envelope.severity === 'warn' ? 'warn' : 'info'
    const lines = [`account: ${alias}`, `code: ${code}`, `summary: ${summary}`, `why: ${why}`].map(clean)
    return { key: noticeId || createHash('sha256').update(JSON.stringify([event.topic, lines])).digest('hex'), level, title: 'reconciliation.notice', lines, ts: Math.trunc(event.ts), topic: event.topic }
  }
  let topic = event.topic
  let data = envelope
  if (topic === 'ledger.entry') {
    topic = String(envelope.type ?? '')
    if (!['protector.triggered', 'trading_state.changed', 'experiment.stage_changed', 'risk.denied'].includes(topic) && !topic.startsWith('takeover.')) return undefined
    data = { ...record(envelope.subject), ...record(envelope.payload), precheck: envelope.precheck, ruleHits: envelope.ruleHits }
  }
  const ts = typeof envelope.ts === 'number' && Number.isSafeInteger(envelope.ts) ? envelope.ts : Math.trunc(event.ts)
  const lines = facts(data)
  const takeover = typeof data.takeoverId === 'string' && factToken.test(data.takeoverId)
    && (topic.startsWith('takeover.') || topic === 'risk.state' || topic === 'trading_state.changed')
  // GQ-51：一次拒单同时有账本条目（risk.denied）和总线事件（risk.denials），按 账户 + 订单（无订单则预检）归一成同一个 key，出口去重只放一条。
  const denialRef = typeof data.accountId === 'string' ? (typeof data.orderId === 'string' ? data.orderId : typeof data.precheckId === 'string' ? data.precheckId : undefined) : undefined
  const denial = (topic === 'risk.denials' || topic === 'risk.denied') && denialRef !== undefined
  const identity = denial ? ['risk.denied', data.accountId, denialRef] : takeover ? ['takeover', data.takeoverId, topic === 'takeover.failed' || topic === 'takeover.alert' ? 'failed' : 'update'] : [topic, lines]
  const key = createHash('sha256').update(JSON.stringify(identity)).digest('hex')
  const clean = (line: string): string => {
    if (findPromiseLanguage(line) === null) return line
    redacted()
    return '[redacted wording]'
  }
  return { key, level: defaultLevel(topic, data), title: clean(topic), lines: [`ts: ${ts}`, ...lines].map(clean), ts, topic }
}
