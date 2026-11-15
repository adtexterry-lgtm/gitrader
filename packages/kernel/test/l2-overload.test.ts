// SPDX-License-Identifier: CPAL-1.0
// ADR-27：只读 / 预检类 op 的全局在途上限，以及事件循环延迟过高时的短时卸载。
import { afterEach, describe, expect, it } from 'vitest'
import { defaultConfig, validateConfig } from '../src/config'
import { OverloadGuard } from '../src/util/overload'
import { BTC } from './helpers/fake-connector'
import { makeAgent, makeHarness } from './helpers/harness'
import type { Harness } from './helpers/harness'

type Problem = { name?: string; message?: string; retryable?: boolean; retryAfterMs?: number }

const problemOf = (e: unknown): Problem => (e as { problem?: Problem }).problem ?? {}

/** 同步调用必抛 BUSY：拿到 problem 继续断。 */
function busyProblem(run: () => void): Problem {
  try {
    run()
  } catch (e) {
    return problemOf(e)
  }
  throw new Error('expected the call to throw BUSY')
}

/** 异步 op 调用：抛出的 problem 原样返回；正常返回则视为失败。 */
async function rejectionOf(run: Promise<unknown>): Promise<Problem> {
  try {
    await run
  } catch (e) {
    return problemOf(e)
  }
  throw new Error('expected the op call to throw')
}

let h: Harness | undefined
afterEach(async () => { await h?.cleanup(); h = undefined })

describe('ADR-27 overload protection', () => {
  it('global in-flight cap returns BUSY, not a socket error', () => {
    const guard = new OverloadGuard({ maxInflight: 2, sampleLoopDelay: () => 0 })
    const release = guard.enter('readOnly')
    guard.enter('default')

    const busy = busyProblem(() => guard.enter('readOnly'))
    expect(busy.name).toBe('BUSY')
    expect(busy.retryable).toBe(true)
    expect(busy.retryAfterMs).toBe(250)
    expect(busy.message).toContain('too many concurrent read-only calls (limit 2)')
    expect(guard.stats().inflight).toBe(2)
    expect(guard.stats().rejected).toBe(1)

    release()
    const retry = guard.enter('readOnly')
    expect(guard.stats().inflight).toBe(2)
    retry()
    guard.close()
  })

  it('release is idempotent', () => {
    const guard = new OverloadGuard({ maxInflight: 2, sampleLoopDelay: () => 0 })
    const release = guard.enter('readOnly')
    release()
    release()
    expect(guard.stats().inflight).toBe(0)

    const again = guard.enter('readOnly')
    expect(guard.stats().inflight).toBe(1)
    again()
    again()
    expect(guard.stats().inflight).toBe(0)
    guard.close()
  })

  it('a caller within its fair share is not shed while a heavy caller is', () => {
    const guard = new OverloadGuard({ sampleLoopDelay: () => 500, fairPerSecond: 3 })
    guard.tick()
    for (let i = 0; i < 3; i += 1) guard.enter('readOnly', 'agent:heavy')()
    expect(busyProblem(() => guard.enter('readOnly', 'agent:heavy')).name).toBe('BUSY')
    expect(() => guard.enter('readOnly', 'agent:normal')()).not.toThrow()
    guard.tick() // 新的一秒：份额重置
    expect(() => guard.enter('readOnly', 'agent:heavy')()).not.toThrow()
    guard.close()
  })

  it('loop delay over the threshold sheds read-only', () => {
    let delay = 500
    const guard = new OverloadGuard({ sampleLoopDelay: () => delay })
    guard.tick()
    expect(guard.stats().shedding).toBe(true)
    expect(guard.stats().lastLoopDelayP99Ms).toBe(500)

    const busy = busyProblem(() => guard.enter('readOnly'))
    expect(busy.name).toBe('BUSY')
    expect(busy.retryable).toBe(true)
    expect(busy.retryAfterMs).toBe(250)
    expect(busy.message).toContain('event loop delay p99 500 ms is over 200 ms')

    delay = 10
    guard.tick()
    expect(guard.stats().shedding).toBe(false)
    const release = guard.enter('readOnly')
    expect(guard.stats().inflight).toBe(1)
    release()
    guard.close()
  })

  it('place/cancel/kill pass while read-only is shed', async () => {
    h = await makeHarness({ configure: (c) => { c.server.loopDelayShedMs = 20 } })
    // 连续阻塞事件循环，让真实采样器的 p99 高过阈值。
    const block = (ms: number): void => { const end = performance.now() + ms; while (performance.now() < end) { /* spin */ } }
    for (let i = 0; i < 20; i += 1) {
      block(40)
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    h.k.overloadGuard.tick()
    expect(h.k.overloadGuard.stats().shedding).toBe(true)

    // 卸载只针对 Agent / 引擎的只读调用（人面会话照常可用）
    const agent = await makeAgent(h, 'paper', { accounts: [h.paper.accountId] as never })
    // 公平份额（默认每秒 10 次）：超过份额的同一把钥匙才被卸载；先打满份额，第 11 次应得 BUSY
    const hh = h
    const call = () => hh.k.ops.call(hh.k, 'agent.market', { principal: agent.principal, params: { action: 'quote', instrumentId: BTC }, transport: 'http' })
    for (let i = 0; i < 10; i += 1) await call()
    const quote = await rejectionOf(call())
    expect(quote.name).toBe('BUSY')
    expect(quote.retryAfterMs).toBe(250)
    const humanQuote = await h.k.ops.call(h.k, 'market.quote', { principal: h.session, params: { instrumentId: BTC }, transport: 'ws' }).then(() => 'ok', (e: unknown) => (e as { problem?: { name?: string } }).problem?.name ?? 'error')
    expect(humanQuote).not.toBe('BUSY')

    // exempt：撤一张不存在的单得到业务错误，而不是 BUSY。
    const cancel = await rejectionOf(h.k.ops.call(h.k, 'order.cancel', {
      principal: h.session, params: { accountId: h.paper.accountId, orderId: 'ord_missing' }, transport: 'ws',
    }))
    expect(cancel.name).not.toBe('BUSY')
    expect(cancel.name).toBe('ACCOUNT_NOT_BOUND')
  })

  it('config validates the new keys', () => {
    const base = defaultConfig()
    const problems = (server: Record<string, unknown>): string[] => validateConfig({ ...base, server: { port: null, ...server } })
    expect(problems({ maxInflightReadOps: 8, loopDelayShedMs: 250 })).toEqual([])
    expect(problems({ maxInflightReadOps: 0 }).some((p) => p.includes('server.maxInflightReadOps'))).toBe(true)
    expect(problems({ maxInflightReadOps: 2.5 }).some((p) => p.includes('server.maxInflightReadOps'))).toBe(true)
    expect(problems({ maxInflightReadOps: 10001 }).some((p) => p.includes('server.maxInflightReadOps'))).toBe(true)
    expect(problems({ loopDelayShedMs: 5 }).some((p) => p.includes('server.loopDelayShedMs'))).toBe(true)
    expect(problems({ loopDelayShedMs: 60001 }).some((p) => p.includes('server.loopDelayShedMs'))).toBe(true)
  })
})
