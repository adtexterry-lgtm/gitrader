// SPDX-License-Identifier: CPAL-1.0
// 频率预算：Bitget 是「每秒次数」模型（查询 20/s、下单 10/s），下单类 weight 0 但仍要 acquire(0)。
import { describe, expect, it } from 'vitest'
import { BITGET_ORDER_LIMIT_PER_SEC, BITGET_QUERY_LIMIT_PER_SEC, BITGET_WEIGHTS, createCountBudget, orderWeight } from '../src/budget'

/** 可控时钟：测试里手动推进，避免真实等待。 */
function fakeTime(start = 1_000): { clock: () => number; advance: (ms: number) => void } {
  let now = start
  return { clock: () => now, advance: (ms) => { now += ms } }
}

describe('配额上限', () => {
  it('缺省查询上限 20 次 / 秒，目标 60% = 12', () => {
    const t = fakeTime()
    const budget = createCountBudget({ clock: t.clock, sleep: async () => {} })
    expect(budget.usage().limit).toBe(BITGET_QUERY_LIMIT_PER_SEC)
    expect(budget.usage().target).toBe(12)
  })
  it('下单桶上限 10 次 / 秒', () => {
    const t = fakeTime()
    const budget = createCountBudget({ clock: t.clock, sleep: async () => {} })
    expect(budget.usage().orders.limit).toBe(BITGET_ORDER_LIMIT_PER_SEC)
  })
  it('trade 档可用满 target，query 档只有一半', async () => {
    const t = fakeTime()
    const budget = createCountBudget({ clock: t.clock, sleep: async () => {} })
    await budget.acquire(1, { kind: 'trade' })
    await budget.acquire(1, { kind: 'query' })
    await budget.acquire(1, { kind: 'background' })
    const usage = budget.usage()
    expect(usage.byKind.trade).toBe(1)
    expect(usage.byKind.query).toBe(1)
    expect(usage.byKind.background).toBe(1)
    expect(usage.used).toBe(3)
  })
  it('超过 query 档上限就等待（sleep 被调用，时间推进后放行）', async () => {
    const t = fakeTime()
    const sleeps: number[] = []
    const budget = createCountBudget({
      clock: t.clock,
      sleep: async (ms) => { sleeps.push(ms); t.advance(ms) },
    })
    for (let i = 0; i < 8; i++) await budget.acquire(1, { kind: 'query' })
    expect(sleeps.length).toBeGreaterThan(0)
  })
  it('order 请求 weight 0 也记进 orders 桶', async () => {
    const t = fakeTime()
    const budget = createCountBudget({ clock: t.clock, sleep: async () => {} })
    await budget.acquire(0, { kind: 'trade', order: true })
    expect(budget.usage().orders.lastSec).toBe(1)
    expect(budget.usage().used).toBe(0)
  })
  it('orders 桶满了会等待（下单 10/s 的真实限频）', async () => {
    const t = fakeTime()
    const sleeps: number[] = []
    const budget = createCountBudget({
      clock: t.clock,
      sleep: async (ms) => { sleeps.push(ms); t.advance(ms) },
    })
    for (let i = 0; i < 11; i++) await budget.acquire(0, { kind: 'trade', order: true })
    expect(sleeps.length).toBe(1)
    expect(budget.usage().orders.lastSec).toBeLessThanOrEqual(BITGET_ORDER_LIMIT_PER_SEC)
  })
})

describe('退避', () => {
  it('penalize 立刻锁住窗口（acquire 会等）', async () => {
    const t = fakeTime()
    const sleeps: number[] = []
    const budget = createCountBudget({ clock: t.clock, sleep: async (ms) => { sleeps.push(ms); t.advance(ms) } })
    budget.penalize(3_000)
    await budget.acquire(0)
    expect(sleeps[0]).toBe(3_000)
  })
  it('penalize 无参时按指数增长（5 s → 10 s）', async () => {
    const t = fakeTime()
    const sleeps: number[] = []
    const budget = createCountBudget({ clock: t.clock, sleep: async (ms) => { sleeps.push(ms); t.advance(ms) } })
    budget.penalize()
    await budget.acquire(0)
    budget.penalize()
    await budget.acquire(0)
    expect(sleeps[0]).toBe(5_000)
    expect(sleeps[1]).toBe(10_000)
  })
  it('usage().backoffUntil 在退避期内非 0', () => {
    const t = fakeTime()
    const budget = createCountBudget({ clock: t.clock, sleep: async () => {} })
    budget.penalize(1_000)
    expect(budget.usage().backoffUntil).toBe(t.clock() + 1_000)
  })
  it('reportOk 在退避结束后清零（下一次 penalize 从 5 s 起）', async () => {
    const t = fakeTime()
    const sleeps: number[] = []
    const budget = createCountBudget({ clock: t.clock, sleep: async (ms) => { sleeps.push(ms); t.advance(ms) } })
    budget.penalize(2_000)
    t.advance(2_001)
    budget.reportOk()
    budget.penalize()
    await budget.acquire(0)
    expect(sleeps[0]).toBe(5_000)
  })
  it('退避期间 weight 0 的请求也排队（教训 11）', async () => {
    const t = fakeTime()
    const sleeps: number[] = []
    const budget = createCountBudget({ clock: t.clock, sleep: async (ms) => { sleeps.push(ms); t.advance(ms) } })
    budget.penalize(1_500)
    await budget.acquire(0, { kind: 'trade', order: true })
    expect(sleeps).toEqual([1_500])
  })
})

describe('账目与权重表', () => {
  it('charge 事后补记权重', () => {
    const t = fakeTime()
    const budget = createCountBudget({ clock: t.clock, sleep: async () => {} })
    budget.charge(3, 'background')
    expect(budget.usage().used).toBe(3)
    expect(budget.usage().ratio).toBeCloseTo(3 / BITGET_QUERY_LIMIT_PER_SEC)
  })
  it('窗口外的记数被清掉', async () => {
    const t = fakeTime()
    const budget = createCountBudget({ clock: t.clock, sleep: async () => {} })
    budget.charge(5)
    t.advance(1_001)
    expect(budget.usage().used).toBe(0)
  })
  it('usage 里有 windowMs / limit / target', () => {
    const budget = createCountBudget({ sleep: async () => {} })
    const usage = budget.usage()
    expect(usage.windowMs).toBe(1_000)
    expect(usage.limit).toBe(20)
    expect(usage.target).toBe(12)
  })
  it('下单类端点的权重是 0，查询类是 1', () => {
    expect(orderWeight()).toBe(0)
    expect(BITGET_WEIGHTS.order).toBe(0)
    expect(BITGET_WEIGHTS.cancel).toBe(0)
    expect(BITGET_WEIGHTS.amend).toBe(0)
    expect(BITGET_WEIGHTS.cancelAll).toBe(0)
    expect(BITGET_WEIGHTS.accounts).toBe(1)
    expect(BITGET_WEIGHTS.positions).toBe(1)
    expect(BITGET_WEIGHTS.fills).toBe(1)
    expect(BITGET_WEIGHTS.detail).toBe(1)
    expect(BITGET_WEIGHTS.ordersPending).toBe(1)
  })
  it('自定义 limit / orderLimit 会作用到 usage', () => {
    const budget = createCountBudget({ limit: 10, targetRatio: 0.5, orderLimit: 4, sleep: async () => {} })
    expect(budget.usage().limit).toBe(10)
    expect(budget.usage().target).toBe(5)
    expect(budget.usage().orders.limit).toBe(4)
  })
})
