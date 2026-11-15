// SPDX-License-Identifier: CPAL-1.0
// 请求预算（按端点计次）：60 次 / 2 s 的三档配额、退避、下单计数、usage 口径。
import { describe, expect, it } from 'vitest'
import {
  createCountBudget, OKX_ACCOUNT_READ_LIMIT, OKX_ENDPOINT_COSTS, OKX_ORDER_LIMIT_PER_INSTRUMENT, OKX_TRADE_LIMIT, orderCost,
} from '../src/budget'
import { NOW } from './helpers/fake-okx-trade'

describe('count budget', () => {
  it('documents the OKX rate buckets', () => {
    expect(OKX_TRADE_LIMIT).toBe(60)
    expect(OKX_ACCOUNT_READ_LIMIT).toBe(10)
    expect(OKX_ORDER_LIMIT_PER_INSTRUMENT).toBe(10)
    expect(OKX_ENDPOINT_COSTS.order).toBe(1)
    expect(orderCost()).toBe(1)
  })

  it('starts empty and reports its limits', () => {
    const budget = createCountBudget({ clock: () => NOW })
    const usage = budget.usage()
    expect(usage).toMatchObject({ used: 0, limit: 60, target: 36, windowMs: 2_000, backoffUntil: 0 })
    expect(usage.ratio).toBe(0)
  })

  it('charges and reports usage per kind', () => {
    const budget = createCountBudget({ clock: () => NOW })
    budget.charge(3, 'trade')
    budget.charge(2, 'query')
    const usage = budget.usage()
    expect(usage.used).toBe(5)
    expect(usage.byKind).toEqual({ trade: 3, query: 2, background: 0 })
  })

  it('does not block below the trade target', async () => {
    let slept = 0
    const budget = createCountBudget({ clock: () => NOW, sleep: async () => { slept += 1 } })
    for (let i = 0; i < 36; i++) await budget.acquire(1)
    expect(slept).toBe(0)
  })

  it('waits when the trade target is exhausted', async () => {
    const waits: number[] = []
    let now = NOW
    const budget = createCountBudget({ clock: () => now, sleep: async (ms) => { waits.push(ms); now += ms } })
    for (let i = 0; i < 36; i++) await budget.acquire(1)
    await budget.acquire(1)
    expect(waits.length).toBe(1)
    expect(waits[0]).toBeGreaterThan(0)
  })

  it('query calls get a smaller share than trade calls', async () => {
    const budget = createCountBudget({ clock: () => NOW, sleep: async () => {} })
    for (let i = 0; i < 18; i++) await budget.acquire(1, { priority: 'low' })
    expect(budget.usage().byKind.query).toBe(18)
  })

  it('penalize() sets a backoff window that acquire() honours', async () => {
    let now = NOW
    const waits: number[] = []
    const budget = createCountBudget({ clock: () => now, sleep: async (ms) => { waits.push(ms); now += ms } })
    budget.penalize(5_000)
    expect(budget.usage().backoffUntil).toBe(NOW + 5_000)
    await budget.acquire(1)
    expect(waits).toEqual([5_000])
  })

  it('reportOk() clears the backoff once it has elapsed', () => {
    let now = NOW
    const budget = createCountBudget({ clock: () => now })
    budget.penalize(1_000)
    now += 1_500
    budget.reportOk()
    expect(budget.usage().backoffUntil).toBe(0)
  })

  it('counts orders in the 2 s and 1 min buckets', () => {
    const budget = createCountBudget({ clock: () => NOW })
    budget.noteOrder(2)
    expect(budget.usage().orders).toEqual({ last2s: 2, last1min: 2 })
  })
})
