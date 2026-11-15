// SPDX-License-Identifier: CPAL-1.0
// fix-r4 D1：内核共享预算不分档，测试网 275 个 dex 的后台发现把 576 的上限吃满，用户查询（K 线）排不进、10 s 超时。
// 连接器在共享预算前自带 query/background 分档闸；这些用例在“后台不停地抢”时仍要让 query 与 trade 立刻通过。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { KernelRateBudget } from '../../kernel/src/budget'
import { createWeightBudget, withKindCaps } from '../src/budget'
import type { RateBudget } from '../src/budget'

afterEach(() => { vi.useRealTimers() })

const setup = () => {
  vi.useFakeTimers({ now: 1_800_000_000_000 })
  const clock = () => Date.now()
  const shared = new KernelRateBudget({ limit: 1200, windowMs: 60_000, clock: { now: clock } })
  return { shared, budget: withKindCaps(shared as unknown as RateBudget, clock) }
}

describe('withKindCaps', () => {
  it('后台发现灌满后，query 仍能在 1 s 内拿到权重，而不是等到后台滚出窗口', async () => {
    const { shared, budget } = setup()
    // 后台一直抢：每次 20，不 await（相当于 discover 的循环），推进时间让它们尽量多拿
    for (let i = 0; i < 60; i++) void budget.acquire(20, { kind: 'background', priority: 'low' }).catch(() => {})
    await vi.advanceTimersByTimeAsync(5_000)
    expect(shared.used()).toBeLessThanOrEqual(252 + 20) // 35% × 720 的后台份额
    let got = false
    void budget.acquire(20, { kind: 'query', priority: 'low' }).then(() => { got = true })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(got).toBe(true)
  })

  it('没有闸时同样场景 query 拿不到（红灯对照：共享预算只有 576 的总上限）', async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 })
    const shared = new KernelRateBudget({ limit: 1200, windowMs: 60_000, clock: { now: () => Date.now() } })
    for (let i = 0; i < 60; i++) void shared.acquire(20, { priority: 'low' })
    await vi.advanceTimersByTimeAsync(5_000)
    let got = false
    void shared.acquire(20, { priority: 'low' }).then(() => { got = true })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(got).toBe(false)
  })

  it('trade 不过闸，后台灌满时下单权重立刻通过', async () => {
    const { budget } = setup()
    for (let i = 0; i < 60; i++) void budget.acquire(20, { kind: 'background', priority: 'low' }).catch(() => {})
    await vi.advanceTimersByTimeAsync(5_000)
    let got = false
    void budget.acquire(1, { kind: 'trade', priority: 'high' }).then(() => { got = true })
    await vi.advanceTimersByTimeAsync(10)
    expect(got).toBe(true)
  })

  it('自带分档的预算原样返回，不再包第二层', () => {
    const own = createWeightBudget({ clock: () => 0 })
    expect(withKindCaps(own, () => 0)).toBe(own)
  })

  it('query 等待遵守 signal：中止后拒绝，不无限挂起', async () => {
    const { budget } = setup()
    for (let i = 0; i < 60; i++) void budget.acquire(20, { kind: 'background', priority: 'low' }).catch(() => {})
    await vi.advanceTimersByTimeAsync(1_000)
    // 把 query 份额也占满
    for (let i = 0; i < 40; i++) void budget.acquire(20, { kind: 'query', priority: 'low' }).catch(() => {})
    await vi.advanceTimersByTimeAsync(1_000)
    const ctl = new AbortController()
    const p = budget.acquire(20, { kind: 'query', priority: 'low', signal: ctl.signal })
    const settled = expect(p).rejects.toBeTruthy()
    ctl.abort(new Error('timeout'))
    await settled
  })
})
