// SPDX-License-Identifier: CPAL-1.0
// GQ-01：区间 K 线 / 资金费历史是用户触发的查询，必须走 query 档，后台发现灌满时仍能放行。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { KernelRateBudget } from '../../kernel/src/budget'
import { createWeightBudget } from '../src/budget'
import type { RateBudget } from '../src/budget'
import { HyperliquidConnector } from '../src/connector'
import { FX_NOW, FakeHl } from './helpers/fake-hl'

afterEach(() => { vi.useRealTimers() })

const HOUR = 3_600_000
/** 每小时一根的假 K 线 / 资金费行，按请求区间回答。 */
function wireHistory(hl: FakeHl): void {
  hl.info.set('candleSnapshot', (b) => {
    const r = b.req
    const out = []
    for (let t = Math.ceil(r.startTime / HOUR) * HOUR; t <= r.endTime && out.length < 500; t += HOUR) {
      out.push({ t, T: t + HOUR - 1, s: 'BTC', i: '1h', o: '1', c: '1', h: '1', l: '1', v: '1', n: 1 })
    }
    return out
  })
  hl.info.set('fundingHistory', (b) => {
    const out = []
    for (let t = Math.ceil(b.startTime / HOUR) * HOUR; t <= b.endTime && out.length < 500; t += HOUR) {
      out.push({ coin: 'BTC', fundingRate: '0.0000125', premium: '0.0001', time: t })
    }
    return out
  })
}

describe('GQ-01 区间历史走查询档', () => {
  it('后台档被灌满时，区间 K 线不排队等窗口滚动（改前：被后台桶卡 ~60 s）', async () => {
    const hl = new FakeHl()
    let now = FX_NOW
    // 自带分档的预算 + 注入的 sleep：被限流时只推进假时钟，不真等
    const budget = createWeightBudget({ clock: () => now, sleep: async (ms) => { now += ms } })
    const c = new HyperliquidConnector({ environment: 'mainnet', fetchImpl: hl.fetch, useWs: false, discoveryIntervalMs: 0, clock: () => now, budget })
    await c.market.refreshInstruments() // 7 次后台请求，共 140 权重
    budget.charge(120, 'background')    // 模拟 testnet 发现流程把后台桶灌到 > 252
    wireHistory(hl)
    const t0 = now
    const out = await c.candles('hyperliquid:BTC', '1h', { from: FX_NOW - 72 * HOUR, to: FX_NOW })
    expect(out.length).toBeGreaterThan(60)   // 72 小时内每小时一根（边界对齐方式不同会差 1）
    expect(now - t0).toBeLessThan(1_000)           // 改前这里是 ~60_000（等后台权重滚出窗口）
    const used = budget.usage().byKind
    expect(used.query).toBeGreaterThan(0)          // 这次历史请求记在查询档
    expect(used.background).toBe(140 + 120)        // 后台档没有被这次请求再加
  })

  it('反例：后台发现本身仍走后台档（不能把 loadDex 也改成 query）', async () => {
    const hl = new FakeHl()
    const budget = createWeightBudget({ clock: () => FX_NOW })
    const c = new HyperliquidConnector({ environment: 'mainnet', fetchImpl: hl.fetch, useWs: false, discoveryIntervalMs: 0, clock: () => FX_NOW, budget })
    await c.market.refreshInstruments()
    expect(budget.usage().byKind).toEqual({ trade: 0, query: 0, background: 140 })
  })

  it('资金费历史同样走查询档', async () => {
    const hl = new FakeHl()
    let now = FX_NOW
    const budget = createWeightBudget({ clock: () => now, sleep: async (ms) => { now += ms } })
    const c = new HyperliquidConnector({ environment: 'mainnet', fetchImpl: hl.fetch, useWs: false, discoveryIntervalMs: 0, clock: () => now, budget })
    await c.market.refreshInstruments()
    budget.charge(120, 'background')
    wireHistory(hl)
    const t0 = now
    const out = await c.fundingHistory('hyperliquid:BTC', { from: FX_NOW - 24 * HOUR, to: FX_NOW })
    expect(out.length).toBeGreaterThan(20)
    expect(now - t0).toBeLessThan(1_000)
    expect(budget.usage().byKind.query).toBeGreaterThan(0)
  })

  it('真实形状：内核共享预算 + 后台发现一直在抢，区间 K 线仍在 3 s 内返回', async () => {
    vi.useFakeTimers({ now: FX_NOW })
    const clock = () => Date.now()
    const hl = new FakeHl()
    const shared = new KernelRateBudget({ limit: 1200, windowMs: 60_000, clock: { now: clock } })
    const c = new HyperliquidConnector({ environment: 'mainnet', fetchImpl: hl.fetch, useWs: false, discoveryIntervalMs: 0, clock, budget: shared as unknown as RateBudget })
    await c.market.refreshInstruments()
    // 发现流程一直抢后台档（60 笔 × 20，不 await）
    for (let i = 0; i < 60; i++) void c.budget.acquire(20, { kind: 'background', priority: 'low' }).catch(() => {})
    await vi.advanceTimersByTimeAsync(5_000)
    wireHistory(hl)
    let done = false
    void c.candles('hyperliquid:BTC', '1h', { from: FX_NOW - 72 * HOUR, to: FX_NOW }).then(() => { done = true })
    await vi.advanceTimersByTimeAsync(3_000)
    expect(done).toBe(true) // 改前：后台档满，要等 ~60 s，3 s 内不会完成
  })
})
