// SPDX-License-Identifier: CPAL-1.0
// WI-F3：浏览器会话单独一个更大的调用频率桶（ADR-29，K-r5-13）。
import { describe, expect, it } from 'vitest'
import { OpRateLimiter } from '../src/util/op-rate-limit'

type Problem = { name?: string; message?: string; retryable?: boolean }

const problemOf = (e: unknown): Problem => (e as { problem?: Problem }).problem ?? {}

const caughtOf = (run: () => void): unknown => {
  try {
    run()
  } catch (e) {
    return e
  }
  return undefined
}

describe('session operation rate bucket', () => {
  it('session principal gets a 1000-token bucket', () => {
    let now = 0
    const limiter = new OpRateLimiter({}, () => now)
    for (let i = 0; i < 1000; i += 1) limiter.consume('session:s1')
    const caught = caughtOf(() => limiter.consume('session:s1'))
    const problem = problemOf(caught)
    expect(problem.name).toBe('RATE_BUDGET')
    expect(problem.message).toContain('operation rate limit')
    now += 1
  })

  it('agent principal keeps the 200-token default', () => {
    let now = 0
    const limiter = new OpRateLimiter({}, () => now)
    for (let i = 0; i < 200; i += 1) limiter.consume('agent:k1')
    const caught = caughtOf(() => limiter.consume('agent:k1'))
    expect(problemOf(caught).name).toBe('RATE_BUDGET')
    now += 1
  })

  it('session read-only calls share the session bucket', () => {
    let now = 0
    const limiter = new OpRateLimiter({}, () => now)
    for (let i = 0; i < 1000; i += 1) limiter.consume('session:s1', i % 2 === 0 ? 'readOnly' : 'default')
    expect(() => limiter.consume('session:s1', 'readOnly')).toThrow()
    expect(() => limiter.consume('session:s1')).toThrow()
    now += 1
  })

  it('session bucket refills at 300/s', () => {
    let now = 0
    const limiter = new OpRateLimiter({}, () => now)
    for (let i = 0; i < 1000; i += 1) limiter.consume('session:s1')
    expect(caughtOf(() => limiter.consume('session:s1'))).toBeDefined()
    now += 1000
    for (let i = 0; i < 300; i += 1) limiter.consume('session:s1')
    const caught = caughtOf(() => limiter.consume('session:s1'))
    expect(problemOf(caught).name).toBe('RATE_BUDGET')
  })

  it('config can override the session bucket', () => {
    let now = 0
    const limiter = new OpRateLimiter({ session: { capacity: 10, refillPerSecond: 1 } }, () => now)
    for (let i = 0; i < 10; i += 1) limiter.consume('session:s1')
    const caught = caughtOf(() => limiter.consume('session:s1'))
    expect(problemOf(caught).name).toBe('RATE_BUDGET')
    now += 1
  })
})
