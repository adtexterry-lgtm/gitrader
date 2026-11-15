// SPDX-License-Identifier: CPAL-1.0
// 预算（契约 §1.5.1）：权重窗口、按用途分档、下单计数桶、429 退避、权重 0 也计数。
import { describe, expect, it } from 'vitest'
import { GATE_WEIGHTS, createWeightBudget, orderWeight } from '../src/budget'

const budgetOf = (over: Parameters<typeof createWeightBudget>[0] = {}): ReturnType<typeof createWeightBudget> =>
  createWeightBudget({ clock: () => 1_000, sleep: async () => {}, ...over })

describe('权重预算', () => {
  it('1. 缺省 target = 60% × 200 = 120，窗口 10 s', () => {
    const u = budgetOf().usage()
    expect(u.limit).toBe(200)
    expect(u.target).toBe(120)
    expect(u.windowMs).toBe(10_000)
    expect(u.used).toBe(0)
    expect(u.ratio).toBe(0)
  })

  it('2. acquire 记权重，同用途连续申请会累加', async () => {
    const b = budgetOf()
    await b.acquire(3, { kind: 'query' })
    await b.acquire(4, { kind: 'query' })
    expect(b.usage().used).toBe(7)
    expect(b.usage().byKind.query).toBe(7)
  })

  it('3. 按用途分档：trade 满额、query 50%、background 35%', async () => {
    const b = budgetOf()
    await b.acquire(1, { kind: 'trade' })
    await b.acquire(1, { kind: 'query' })
    await b.acquire(1, { kind: 'background' })
    const u = b.usage()
    expect(u.byKind).toEqual({ trade: 1, query: 1, background: 1 })
  })

  it('4. 超过分档额度时进入等待（sleep 被调用而不是静默放行）', async () => {
    const sleeps: number[] = []
    let now = 1_000
    const b = createWeightBudget({ clock: () => now, sleep: async (ms) => { sleeps.push(ms); now += ms }, limit: 10, targetRatio: 0.5, queryShare: 0.2 })
    // target 5，query 档 = max(1, floor(5*0.2)) = 1
    await b.acquire(1, { kind: 'query' })
    await b.acquire(1, { kind: 'query' })
    expect(sleeps.length).toBeGreaterThan(0)
    expect(sleeps[0]).toBeGreaterThan(0)
  })

  it('5. 权重 0 的请求也进窗口（记录一笔 0 权重事件，不绕过）', async () => {
    const b = budgetOf()
    await b.acquire(0, { kind: 'trade', order: true })
    const u = b.usage()
    expect(u.used).toBe(0)
    expect(u.orders.lastSec).toBe(1)
  })

  it('6. 下单计数桶：超过 orderLimit 会等待（10 次 / 秒的本地上限）', async () => {
    const sleeps: number[] = []
    let now = 1_000
    const b = createWeightBudget({ clock: () => now, sleep: async (ms) => { sleeps.push(ms); now += ms }, orderLimit: 2 })
    await b.acquire(0, { kind: 'trade', order: true })
    await b.acquire(0, { kind: 'trade', order: true })
    await b.acquire(0, { kind: 'trade', order: true })
    expect(sleeps.length).toBeGreaterThan(0)
    expect(sleeps[0]).toBe(1001)
    expect(b.usage().orders.limit).toBe(2)
  })

  it('7. penalize 让 backoffUntil 前进；reportOk 在退避结束后清零', async () => {
    let now = 1_000
    const b = createWeightBudget({ clock: () => now, sleep: async () => {} })
    b.penalize(3_000)
    expect(b.usage().backoffUntil).toBe(4_000)
    now = 4_000
    b.reportOk()
    expect(b.usage().backoffUntil).toBe(0)
  })

  it('8. penalize 不传参数时指数退避（5 s 起，封顶 60 s）', () => {
    const b = budgetOf()
    b.penalize()
    expect(b.usage().backoffUntil).toBe(6_000)
  })

  it('9. charge 补记权重，不等待', () => {
    const b = budgetOf()
    b.charge(5, 'background')
    expect(b.usage().byKind.background).toBe(5)
    expect(b.usage().used).toBe(5)
  })

  it('10. noteOrder 直接记下单计数', () => {
    const b = budgetOf()
    b.noteOrder(3)
    expect(b.usage().orders.lastSec).toBe(3)
  })

  it('11. 窗口滑过后清掉旧事件（比例回落）', async () => {
    let now = 1_000
    const b = createWeightBudget({ clock: () => now, sleep: async () => {}, windowMs: 1_000 })
    await b.acquire(5, { kind: 'trade' })
    expect(b.usage().used).toBe(5)
    now = 2_500
    expect(b.usage().used).toBe(0)
    expect(b.usage().ratio).toBe(0)
  })

  it('12. 权重表：查询类都是 1，下单 / 撤单 / 杠杆是 0', () => {
    expect(GATE_WEIGHTS.accounts).toBe(1)
    expect(GATE_WEIGHTS.positions).toBe(1)
    expect(GATE_WEIGHTS.myTrades).toBe(1)
    expect(GATE_WEIGHTS.order).toBe(0)
    expect(GATE_WEIGHTS.cancel).toBe(0)
    expect(GATE_WEIGHTS.amend).toBe(0)
    expect(orderWeight()).toBe(0)
  })

  it('13. 缺省下单桶 10 / 1 s：同一时刻第 11 单等待恰为 1001 ms', async () => {
    const sleeps: number[] = []
    let now = 1_000
    const b = createWeightBudget({ clock: () => now, sleep: async (ms) => { sleeps.push(ms); now += ms } })
    for (let i = 0; i < 10; i++) await b.acquire(0, { kind: 'trade', order: true })
    await b.acquire(0, { kind: 'trade', order: true })
    expect(sleeps).toEqual([1001])
  })
})
