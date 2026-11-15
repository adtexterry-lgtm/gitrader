// SPDX-License-Identifier: CPAL-1.0
// 行情 REST 熔断器接线：info 类请求走熔断，熔断开启时不联网、不扣预算，直接 VENUE_UNAVAILABLE。
import { afterEach, describe, expect, it } from 'vitest'
import type { BudgetUsage, RateBudget } from '../src/budget'
import { HyperliquidConnector } from '../src/connector'
import type { HyperliquidConnectorOptions } from '../src/connector'
import { ProblemError } from '../src/errors'
import { FakeHl, FakeWS, FakeWebSocket } from './helpers/fake-hl'

function make(over: Partial<HyperliquidConnectorOptions> = {}) {
  const hl = new FakeHl()
  const t = { now: 0 }
  // useWs：避免 REST 轮询的 allMids 成败掺进熔断计数，只留测试自己发的 info 请求
  const c = new HyperliquidConnector({
    environment: 'mainnet', fetchImpl: hl.fetch, WebSocketImpl: FakeWS, useWs: true, discoveryIntervalMs: 0, clock: () => t.now, ...over,
  })
  return { hl, t, c }
}

/** 让某个 info type 连续抛传输错误（fetch 层失败）。 */
function breakInfo(hl: FakeHl, type: string): void {
  hl.info.set(type, () => { throw new TypeError('fetch failed') })
}

/** 让某个 info type 连续返回 5xx。 */
function failInfo(hl: FakeHl, type: string, status = 503): void {
  hl.info.set(type, () => new Response('upstream detail', { status }))
}

async function tripCircuit(c: HyperliquidConnector): Promise<void> {
  for (let i = 0; i < 5; i++) await expect(c.candles('hyperliquid:BTC', '1m')).rejects.toThrow()
}

async function circuitError(fn: () => Promise<unknown>): Promise<ProblemError> {
  try {
    await fn()
  } catch (e) {
    expect(e).toBeInstanceOf(ProblemError)
    return e as ProblemError
  }
  throw new Error('expected the call to reject with ProblemError')
}

class CountingBudget implements RateBudget {
  acquires = 0
  charges = 0
  async acquire(): Promise<void> { this.acquires += 1 }
  charge(): void { this.charges += 1 }
  penalize(): void {}
  reportOk(): void {}
  usage(): BudgetUsage {
    return { used: 0, target: 720, limit: 1200, ratio: 0, windowMs: 60_000, backoffUntil: 0, byKind: { trade: 0, query: 0, background: 0 } }
  }
}

afterEach(() => { FakeWebSocket.reset() })

describe('info circuit wiring', () => {
  it('opens after the default five failures and then rejects without touching fetch', async () => {
    const { hl, c } = make()
    breakInfo(hl, 'candleSnapshot')
    await tripCircuit(c)
    expect(c.circuit().state).toBe('open')
    expect(c.circuit().opens).toBe(1)

    const before = hl.calls.length
    const err = await circuitError(() => c.candles('hyperliquid:BTC', '1m'))
    expect(err.problem.name).toBe('VENUE_UNAVAILABLE')
    expect(err.problem.retryable).toBe(true)
    expect(err.problem.message).toContain('circuit open')
    expect(err.problem.message).toContain('连不上交易所')
    expect(hl.calls.length).toBe(before) // 熔断开启期间不联网
  })

  it('lets one request through after the cooldown and closes again once it succeeds', async () => {
    const { hl, t, c } = make()
    failInfo(hl, 'candleSnapshot')
    await tripCircuit(c)
    expect(c.circuit().state).toBe('open')

    t.now += 30_000
    const before = hl.calls.length
    const book = await c.book('hyperliquid:BTC')
    expect(book.instrumentId).toBe('hyperliquid:BTC')
    expect(hl.calls.length).toBe(before + 1)
    expect(c.circuit()).toMatchObject({ state: 'closed', failures: 0, openedAt: null })
  })

  it('re-opens when the half_open probe fails, and rejects again without touching fetch', async () => {
    const { hl, t, c } = make()
    breakInfo(hl, 'l2Book')
    for (let i = 0; i < 5; i++) await expect(c.book('hyperliquid:BTC')).rejects.toThrow()
    expect(c.circuit()).toMatchObject({ state: 'open', opens: 1 })

    t.now += 30_000
    const probing = hl.calls.length
    await expect(c.book('hyperliquid:BTC')).rejects.toThrow(/fetch failed/)
    expect(hl.calls.length).toBe(probing + 1) // half_open 放行了这一次
    expect(c.circuit()).toMatchObject({ state: 'open', opens: 2 })

    const after = hl.calls.length
    const err = await circuitError(() => c.book('hyperliquid:BTC'))
    expect(err.problem.name).toBe('VENUE_UNAVAILABLE')
    expect(hl.calls.length).toBe(after)
  })

  it('does not count 4xx (other than 429) as a failure', async () => {
    const { hl, c } = make()
    failInfo(hl, 'candleSnapshot', 400)
    for (let i = 0; i < 5; i++) await expect(c.candles('hyperliquid:BTC', '1m')).rejects.toThrow()
    expect(c.circuit()).toMatchObject({ state: 'closed', failures: 0, opens: 0 })

    const before = hl.calls.length
    await expect(c.candles('hyperliquid:BTC', '1m')).rejects.toThrow()
    expect(hl.calls.length).toBe(before + 1) // 仍然照常发请求
  })
  it('does not touch the budget while the circuit is open', async () => {
    const budget = new CountingBudget()
    const { hl, c } = make({ budget })
    breakInfo(hl, 'candleSnapshot')
    await tripCircuit(c)
    expect(budget.acquires).toBe(5)

    const before = budget.acquires
    const err = await circuitError(() => c.candles('hyperliquid:BTC', '1m'))
    expect(err.problem.name).toBe('VENUE_UNAVAILABLE')
    expect(budget.acquires).toBe(before)
  })

  it('releases the half_open permit when the probe error does not count as a failure', async () => {
    const { hl, t, c } = make()
    failInfo(hl, 'l2Book')
    for (let i = 0; i < 5; i++) await expect(c.book('hyperliquid:BTC')).rejects.toThrow()
    expect(c.circuit()).toMatchObject({ state: 'open', opens: 1 })

    t.now += 30_000
    failInfo(hl, 'l2Book', 400)
    const probing = hl.calls.length
    await expect(c.book('hyperliquid:BTC')).rejects.toThrow()
    expect(hl.calls.length).toBe(probing + 1) // half_open 放行了这一次
    expect(c.circuit().state).toBe('half_open') // 400 不计失败，状态不变

    const beforeNext = hl.calls.length
    await expect(c.book('hyperliquid:BTC')).rejects.toThrow()
    expect(hl.calls.length).toBe(beforeNext + 1) // 许可已归还，下一次仍被放行
    expect(c.circuit().state).toBe('half_open')

    hl.info.delete('l2Book')
    const book = await c.book('hyperliquid:BTC')
    expect(book.instrumentId).toBe('hyperliquid:BTC')
    expect(c.circuit()).toMatchObject({ state: 'closed', failures: 0, openedAt: null })
  })

  it('rejects a concurrent half_open request with a half-open message, not a zero retry delay', async () => {
    const { hl, t, c } = make()
    failInfo(hl, 'l2Book')
    for (let i = 0; i < 5; i++) await expect(c.book('hyperliquid:BTC')).rejects.toThrow()
    t.now += 30_000

    let resolveProbe: (r: Response) => void = () => {}
    hl.info.set('l2Book', () => new Promise<Response>((resolve) => { resolveProbe = resolve }))
    const probing = hl.calls.length
    const inflight = c.book('hyperliquid:BTC').catch((e: unknown) => e)
    while (hl.calls.length < probing + 1) await new Promise((r) => setTimeout(r, 0))
    expect(c.circuit().state).toBe('half_open')

    const err = await circuitError(() => c.book('hyperliquid:BTC'))
    expect(err.problem.name).toBe('VENUE_UNAVAILABLE')
    expect(err.problem.message).toContain('half-open')
    expect(err.problem.message).not.toContain('retry after 0 ms')

    resolveProbe(new Response('bad request', { status: 400 }))
    await inflight
    expect(c.circuit().state).toBe('half_open') // 探针不计失败，许可归还，未永久拒绝
  })
})
