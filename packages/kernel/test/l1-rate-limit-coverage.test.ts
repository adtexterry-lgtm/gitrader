// SPDX-License-Identifier: CPAL-1.0
// WI-L1：操作频率限制的纯内核覆盖（分类、两套桶、账本窗口、指标、配置校验）。
import { describe, expect, it } from 'vitest'
import { classifyOperation, OpRateAudit, OpRateLimiter, principalLabel } from '../src/util/op-rate-limit'
import type { RateLimitedNote } from '../src/util/op-rate-limit'
import { defaultConfig, validateConfig } from '../src/config'
import { EventBus } from '../src/events'
import { Metrics, opRateCounters } from '../src/metrics'

const problemOf = (e: unknown): { name?: string; message?: string; retryable?: boolean } =>
  (e as { problem?: { name?: string; message?: string; retryable?: boolean } }).problem ?? {}

describe('operation rate limit coverage', () => {
  it('engine principal is limited', () => {
    let now = 0
    const limiter = new OpRateLimiter({ capacity: 2, refillPerSecond: 1 }, () => now)
    limiter.consume('engine:e1')
    limiter.consume('engine:e1')
    let caught: unknown
    try {
      limiter.consume('engine:e1')
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(Error)
    expect(problemOf(caught).name).toBe('RATE_BUDGET')
  })

  it('read-only bucket is smaller than the default', () => {
    let now = 0
    const limiter = new OpRateLimiter({}, () => now)
    const key = 'engine:e1'
    for (let i = 0; i < 100; i += 1) limiter.consume(key, 'readOnly')
    let caught: unknown
    try {
      limiter.consume(key, 'readOnly')
    } catch (e) {
      caught = e
    }
    const problem = problemOf(caught)
    expect(problem.message?.startsWith('operation rate limit exceeded (read-only bucket)')).toBe(true)
    expect(problem.retryable).toBe(true)
    for (let i = 0; i < 200; i += 1) limiter.consume(key)
    now += 1
  })

  it('classifies exempt, read-only and default operations', () => {
    for (const [name, params] of [
      ['kill', undefined],
      ['order.place', undefined],
      ['agent.order', { action: 'place' }],
      ['agent.order', { action: 'close' }],
    ] as const) expect(classifyOperation(name, params)).toBe('exempt')
    for (const [name, params] of [
      ['market.quote', undefined],
      ['agent.market', undefined],
      ['order.preview', undefined],
      ['agent.order', { action: 'preview' }],
    ] as const) expect(classifyOperation(name, params)).toBe('readOnly')
    for (const [name, params] of [
      ['status', undefined],
      ['agent.account', undefined],
      ['ledger.query', undefined],
      ['agent.order', { action: 'lookup' }],
    ] as const) expect(classifyOperation(name, params)).toBe('default')
  })

  it('limited call increments metric and writes at most one ledger note per minute', () => {
    const counters = new Map<string, number>()
    const notes: RateLimitedNote[] = []
    let now = 120_000
    const audit = new OpRateAudit((n) => { notes.push(n) }, counters, () => now)
    for (let i = 0; i < 5; i += 1) audit.record('agent:k1', 'agent.market')
    for (let i = 0; i < 2; i += 1) audit.record('agent:k1', 'order.preview')
    expect(notes.length).toBe(0)
    expect(counters.get('agent:k1')).toBe(7)
    now = 180_000
    audit.record('agent:k1', 'agent.market')
    expect(notes.length).toBe(1)
    expect(notes[0]).toEqual({
      principal: 'agent:k1',
      count: 7,
      operations: { 'agent.market': 5, 'order.preview': 2 },
      windowStart: 120000,
      windowEnd: 180000,
    })
    audit.flush(true)
    expect(notes.length).toBe(2)
    expect(notes[1]?.count).toBe(1)
    audit.flush(true)
    expect(notes.length).toBe(2)
  })

  it('session and service labels hide identifiers', () => {
    expect(principalLabel('session:abc')).toBe('session')
    expect(principalLabel('service:deadbeef')).toBe('service')
    expect(principalLabel('agent:k9')).toBe('agent:k9')
    expect(principalLabel('engine:e1')).toBe('engine:e1')
    expect(principalLabel('x')).toBe('other')
  })

  it('config accepts and validates readOnly', () => {
    const base = defaultConfig()
    const problemsFor = (limit: unknown): string[] =>
      validateConfig({ ...base, server: { port: null, operationRateLimit: limit } })
    expect(validateConfig({ ...base, server: { port: null } })).toEqual([])
    expect(problemsFor({ readOnly: { capacity: 0 } }).some((p) => p.includes('readOnly.capacity'))).toBe(true)
    expect(problemsFor({ readOnly: { capacity: 50, refillPerSecond: 10 } }).filter((p) => p.includes('operationRateLimit'))).toEqual([])
  })

  it('metrics render op rate limited counter', () => {
    const events = new EventBus()
    opRateCounters(events).set('agent:k1', 3)
    const rendered = new Metrics({ events, status: () => ({}) }).render()
    expect(rendered).toContain('gitrader_op_rate_limited_total{principal="agent:k1"} 3')
  })
})
