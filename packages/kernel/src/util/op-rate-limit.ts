// SPDX-License-Identifier: CPAL-1.0
import { makeProblem } from '../proto'
import { KernelError } from './errors'

export interface OpRateBucketOptions { capacity?: number; refillPerSecond?: number }
export interface OpRateLimiterOptions extends OpRateBucketOptions { readOnly?: OpRateBucketOptions; session?: OpRateBucketOptions }
export type OpRateClass = 'default' | 'readOnly'

interface Bucket { tokens: number; refilledAt: number; usedAt: number }

interface BucketConfig { capacity: number; refillPerSecond: number; idleMs: number; message: string }

const MAX_BUCKETS = 10_000

/** Operations that are never rate limited (they are the user-facing escape hatches). */
export const EXEMPT_OPERATIONS: ReadonlySet<string> = new Set([
  'kill', 'order.place', 'order.cancel', 'order.cancel_all', 'order.amend', 'position.close', 'proposal.approve',
])
/** Agent order actions that count as an exempt operation. */
export const EXEMPT_AGENT_ORDER_ACTIONS: ReadonlySet<string> = new Set(['place', 'cancel', 'cancel_all', 'close', 'amend'])

/** Classify an operation name (plus optional params) into its rate-limit class. */
export function classifyOperation(name: string, params?: unknown): 'exempt' | OpRateClass {
  if (EXEMPT_OPERATIONS.has(name)) return 'exempt'
  const action = params !== null && typeof params === 'object' && !Array.isArray(params) && Object.keys(params).length > 0
    ? String((params as Record<string, unknown>).action ?? '')
    : ''
  if (name === 'agent.order' && EXEMPT_AGENT_ORDER_ACTIONS.has(action)) return 'exempt'
  if (name.startsWith('market.') || name === 'agent.market' || name === 'order.preview' || (name === 'agent.order' && action === 'preview')) return 'readOnly'
  return 'default'
}

function bucketConfig(options: OpRateBucketOptions, capacity: number, refillPerSecond: number, readOnly: boolean, label: string): BucketConfig {
  const cap = options.capacity ?? capacity
  const rate = options.refillPerSecond ?? refillPerSecond
  if (!Number.isInteger(cap) || cap < 1 || cap > 10_000) {
    throw new TypeError(readOnly ? 'operation rate readOnly capacity must be an integer from 1 to 10000' : 'operation rate capacity must be an integer from 1 to 10000')
  }
  if (!Number.isFinite(rate) || rate < 0.1 || rate > 10_000) {
    throw new TypeError(readOnly ? 'operation rate readOnly refill must be from 0.1 to 10000 per second' : 'operation rate refill must be from 0.1 to 10000 per second')
  }
  return { capacity: cap, refillPerSecond: rate, idleMs: Math.max(60_000, cap / rate * 1000), message: `operation rate limit exceeded (${label})` }
}

export class OpRateLimiter {
  private readonly defaultConfig: BucketConfig
  private readonly readOnlyConfig: BucketConfig
  private readonly sessionConfig: BucketConfig
  private readonly defaultBuckets = new Map<string, Bucket>()
  private readonly readOnlyBuckets = new Map<string, Bucket>()
  private readonly sessionBuckets = new Map<string, Bucket>()

  constructor(config: OpRateLimiterOptions = {}, private readonly now: () => number = () => performance.now()) {
    this.defaultConfig = bucketConfig(config, 200, 60, false, 'default bucket')
    this.readOnlyConfig = bucketConfig(config.readOnly ?? {}, 100, 30, true, 'read-only bucket')
    // The browser session bucket has its own larger default; an explicit top-level capacity / refill still applies to it.
    const sessionOptions: OpRateBucketOptions = {
      capacity: config.session?.capacity ?? config.capacity,
      refillPerSecond: config.session?.refillPerSecond ?? config.refillPerSecond,
    }
    this.sessionConfig = bucketConfig(sessionOptions, 1000, 300, false, 'session bucket')
  }

  consume(key: string, cls: OpRateClass = 'default'): void {
    if (!key) throw new TypeError('operation rate key must not be empty')
    // Browser sessions share one bucket for read-only and command calls, so a second window does not double-charge.
    const session = key.startsWith('session:')
    const readOnly = cls === 'readOnly'
    const config = session ? this.sessionConfig : readOnly ? this.readOnlyConfig : this.defaultConfig
    const buckets = session ? this.sessionBuckets : readOnly ? this.readOnlyBuckets : this.defaultBuckets
    const now = this.now()
    let bucket = buckets.get(key)
    if (!bucket) {
      if (buckets.size >= MAX_BUCKETS) {
        this.recycle(buckets, config, now)
        if (buckets.size >= MAX_BUCKETS) throw this.budgetError(config, Math.ceil(1000 / config.refillPerSecond))
      }
      bucket = { tokens: config.capacity, refilledAt: now, usedAt: now }
      buckets.set(key, bucket)
    }

    const elapsedMs = Math.max(0, now - bucket.refilledAt)
    const tokens = Math.min(config.capacity, bucket.tokens + elapsedMs * config.refillPerSecond / 1000)
    bucket.tokens = tokens
    bucket.refilledAt = Math.max(bucket.refilledAt, now)
    bucket.usedAt = Math.max(bucket.usedAt, now)
    if (tokens < 1) throw this.budgetError(config, Math.max(1, Math.ceil((1 - tokens) / config.refillPerSecond * 1000)))
    bucket.tokens = tokens - 1
  }

  private recycle(buckets: Map<string, Bucket>, config: BucketConfig, now: number): void {
    for (const [key, bucket] of buckets) {
      if (now >= bucket.usedAt && now - bucket.usedAt >= config.idleMs) buckets.delete(key)
    }
  }

  private budgetError(config: BucketConfig, retryAfterMs: number): KernelError {
    return new KernelError(makeProblem('RATE_BUDGET', config.message, { retryable: true, retryAfterMs }))
  }
}

export interface RateLimitedNote { principal: string; operations: Record<string, number>; count: number; windowStart: number; windowEnd: number }

/** Only the principal class leaves the process; session ids and token hashes stay out of the ledger. */
export function principalLabel(key: string): string {
  if (key.startsWith('agent:') || key.startsWith('engine:')) return key
  if (key.startsWith('session:')) return 'session'
  if (key.startsWith('service:')) return 'service'
  return 'other'
}

interface AuditWindow { windowStart: number; count: number; operations: Record<string, number> }

/** Aggregates refused calls per principal into whole-minute ledger notes. */
export class OpRateAudit {
  private readonly windows = new Map<string, AuditWindow>()

  constructor(
    private readonly write: (note: RateLimitedNote) => void,
    private readonly counters: Map<string, number>,
    private readonly now: () => number = () => Date.now(),
  ) {}

  record(key: string, operation: string): void {
    const label = principalLabel(key)
    this.counters.set(label, (this.counters.get(label) ?? 0) + 1)
    const windowStart = Math.floor(this.now() / 60_000) * 60_000
    let window = this.windows.get(label)
    if (window && window.windowStart !== windowStart) {
      this.emit(label, window)
      this.windows.delete(label)
      window = undefined
    }
    if (!window) {
      window = { windowStart, count: 0, operations: {} }
      this.windows.set(label, window)
    }
    window.count += 1
    window.operations[operation] = (window.operations[operation] ?? 0) + 1
  }

  flush(force = false): void {
    const now = this.now()
    for (const [label, window] of [...this.windows]) {
      if (!force && now < window.windowStart + 60_000) continue
      this.emit(label, window)
      this.windows.delete(label)
    }
  }

  private emit(label: string, window: AuditWindow): void {
    try {
      this.write({ principal: label, operations: { ...window.operations }, count: window.count, windowStart: window.windowStart, windowEnd: window.windowStart + 60_000 })
    } catch {
      // A failing ledger write must never break the caller; the window is dropped either way.
    }
  }
}
