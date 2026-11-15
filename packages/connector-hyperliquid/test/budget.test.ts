// SPDX-License-Identifier: CPAL-1.0
import { describe, expect, it } from 'vitest'
import { createWeightBudget, exchangeWeight, extraInfoWeight, infoWeight } from '../src/budget'

function harness(opts: Parameters<typeof createWeightBudget>[0] = {}) {
  let now = 1_000_000
  const sleeps: number[] = []
  const budget = createWeightBudget({
    ...opts,
    clock: () => now,
    sleep: async (ms) => { sleeps.push(ms); now += ms },
  })
  return { budget, sleeps, get now() { return now }, advance: (ms: number) => { now += ms } }
}

describe('weight budget', () => {
  it('defaults to 60% of 1200 per minute', () => {
    const h = harness()
    expect(h.budget.usage()).toMatchObject({ target: 720, limit: 1200, used: 0 })
  })

  it('never lets any rolling 60 s window exceed the target (and so never exceeds 60% of the venue limit)', async () => {
    const h = harness()
    const grants: Array<{ ts: number; w: number }> = []
    // 10 分钟里尽可能快地要权重：一半是 20 一次，一半是 2 一次
    const end = h.now + 600_000
    let i = 0
    while (h.now < end) {
      const w = i++ % 2 === 0 ? 20 : 2
      await h.budget.acquire(w)
      grants.push({ ts: h.now, w })
    }
    let maxWindow = 0
    for (const g of grants) {
      const sum = grants.filter((x) => x.ts > g.ts - 60_000 && x.ts <= g.ts).reduce((s, x) => s + x.w, 0)
      maxWindow = Math.max(maxWindow, sum)
    }
    expect(maxWindow).toBeLessThanOrEqual(720)
    expect(maxWindow / 1200).toBeLessThanOrEqual(0.6)
    expect(maxWindow).toBeGreaterThan(600) // 预算真的被用起来了，不是空转
  })

  it('does not wait while there is room', async () => {
    const h = harness()
    for (let k = 0; k < 36; k++) await h.budget.acquire(20)
    expect(h.sleeps).toEqual([])
    expect(h.budget.usage().used).toBe(720)
    await h.budget.acquire(20)
    expect(h.sleeps.length).toBeGreaterThan(0)
  })

  it('background (low) requests only use the first half of the target', async () => {
    const h = harness()
    for (let k = 0; k < 18; k++) await h.budget.acquire(20, { priority: 'low' })
    expect(h.sleeps).toEqual([])
    expect(h.budget.usage().used).toBe(360)
    await h.budget.acquire(20, { priority: 'low' })
    expect(h.sleeps.length).toBe(1)
    // 同样的占用下，交互请求照样立刻放行
    const h2 = harness()
    for (let k = 0; k < 18; k++) await h2.budget.acquire(20, { priority: 'low' })
    await h2.budget.acquire(20, { priority: 'high' })
    expect(h2.sleeps).toEqual([])
  })

  it('splits usage by purpose; trade actions keep a reserved quota that queries and background work can never eat', async () => {
    const h = harness()
    // 用户查询只能用到 target 的 50%（360）
    for (let k = 0; k < 18; k++) await h.budget.acquire(20, { kind: 'query' })
    expect(h.sleeps).toEqual([])
    await h.budget.acquire(20, { kind: 'query' })
    expect(h.sleeps.length).toBe(1) // 第 19 次查询只能等
    const h2 = harness()
    for (let k = 0; k < 18; k++) await h2.budget.acquire(20, { kind: 'query' })
    // 查询已经顶满，交易动作照样立刻放行，一直到 720 的总上限
    for (let k = 0; k < 360; k++) await h2.budget.acquire(1, { kind: 'trade' })
    expect(h2.sleeps).toEqual([])
    expect(h2.budget.usage().byKind).toEqual({ trade: 360, query: 360, background: 0 })
    expect(h2.budget.usage().used).toBe(720)
    // 后台任务（发现、历史 K 线）只能用 35%：252
    const h3 = harness()
    for (let k = 0; k < 12; k++) await h3.budget.acquire(21, { kind: 'background' })
    expect(h3.sleeps).toEqual([])
    await h3.budget.acquire(21, { kind: 'background' })
    expect(h3.sleeps.length).toBe(1)
  })

  it('backs off after a 429 and doubles until a success resets it', async () => {
    const h = harness()
    h.budget.penalize()
    await h.budget.acquire(2)
    expect(h.sleeps[0]).toBeGreaterThanOrEqual(5000)
    h.budget.penalize()
    expect(h.budget.usage().backoffUntil).toBeGreaterThan(h.now)
    await h.budget.acquire(2)
    expect(h.sleeps[1]).toBeGreaterThanOrEqual(10_000)
    h.budget.reportOk()
    h.budget.penalize()
    await h.budget.acquire(2)
    expect(h.sleeps[2]).toBeGreaterThanOrEqual(5000)
    expect(h.sleeps[2]).toBeLessThan(10_000)
  })

  it('charge() books extra weight without waiting', () => {
    const h = harness()
    h.budget.charge(5)
    expect(h.budget.usage().used).toBe(5)
    h.advance(61_000)
    expect(h.budget.usage().used).toBe(0)
  })

  it('weight tables follow the official rules', () => {
    expect(infoWeight('allMids')).toBe(2)
    expect(infoWeight('l2Book')).toBe(2)
    expect(infoWeight('userRole')).toBe(60)
    expect(infoWeight('metaAndAssetCtxs')).toBe(20)
    expect(extraInfoWeight('candleSnapshot', 5000)).toBe(83)
    expect(extraInfoWeight('userFillsByTime', 100)).toBe(5)
    expect(extraInfoWeight('allMids', 1000)).toBe(0)
    expect(exchangeWeight(1)).toBe(1)
    expect(exchangeWeight(40)).toBe(2)
  })
})
