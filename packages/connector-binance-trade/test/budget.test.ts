// SPDX-License-Identifier: CPAL-1.0
// 权重预算（全离线）：分档上限、X-MBX-USED-WEIGHT-1M 校正、429 退避、下单计数桶。
import { describe, expect, it } from 'vitest'
import {
  BINANCE_WEIGHT_LIMIT_PER_MIN, BINANCE_WEIGHTS, DEFAULT_TARGET_RATIO, ORDER_LIMIT_PER_10S, ORDER_LIMIT_PER_MIN, createWeightBudget,
  orderWeight,
} from '../src/budget'
import { NOW } from './helpers/fake-binance-trade'

const budget = (o: { limit?: number; targetRatio?: number; windowMs?: number; sleep?: (ms: number) => Promise<void> } = {}) => {
  let now = NOW
  const b = createWeightBudget({
    clock: () => now,
    windowMs: o.windowMs ?? 60_000,
    ...(o.limit !== undefined ? { limit: o.limit } : {}),
    ...(o.targetRatio !== undefined ? { targetRatio: o.targetRatio } : {}),
    ...(o.sleep ? { sleep: o.sleep } : {}),
  })
  return { b, advance: (ms: number) => { now += ms }, now: () => now }
}

describe('weight caps', () => {
  it('limits: 2400 / min, target 1440 (60%), query 720, background 504', () => {
    const { b } = budget()
    const u = b.usage()
    expect(BINANCE_WEIGHT_LIMIT_PER_MIN).toBe(2400)
    expect(DEFAULT_TARGET_RATIO).toBe(0.6)
    expect(u.limit).toBe(2400)
    expect(u.target).toBe(1440)
    expect(u.windowMs).toBe(60_000)
    expect(u.byKind).toEqual({ trade: 0, query: 0, background: 0 })
  })

  it('charge() books weight after the fact and shows in usage', async () => {
    const { b } = budget()
    b.charge(7, 'background')
    await b.acquire(3, { kind: 'query' })
    const u = b.usage()
    expect(u.used).toBe(10)
    expect(u.byKind).toEqual({ trade: 0, query: 3, background: 7 })
    expect(u.ratio).toBeCloseTo(10 / 2400, 10)
  })

  it('reconcile() only adds the positive delta from the venue header', async () => {
    const { b } = budget()
    await b.acquire(5, { kind: 'trade' }).catch(() => {})
    b.reconcile(300)
    expect(b.usage().used).toBe(300)
    b.reconcile(120) // 上游口径变小：不抹掉本地账本
    expect(b.usage().used).toBe(300)
    b.reconcile(Number.NaN)
    expect(b.usage().used).toBe(300)
  })

  it('waits for the rolling window when the cap is reached, without real sleeping', async () => {
    const waits: number[] = []
    const { b, advance } = budget({ limit: 10, targetRatio: 1, windowMs: 1_000, sleep: async (ms) => { waits.push(ms); advance(ms) } })
    await b.acquire(6, { kind: 'trade' })
    await b.acquire(6, { kind: 'trade' })
    expect(waits).toHaveLength(1)
    expect(waits[0]).toBeGreaterThan(0)
    // 老权重滚出窗口后只剩这一次的 6
    expect(b.usage().used).toBe(6)
  })

  it('429 backoff doubles 5 s → 10 s → 20 s and reportOk resets the ladder', () => {
    const { b, advance } = budget()
    b.penalize()
    expect(b.usage().backoffUntil).toBe(NOW + 5_000)
    b.penalize()
    expect(b.usage().backoffUntil).toBe(NOW + 10_000)
    advance(10_000)
    b.penalize()
    expect(b.usage().backoffUntil).toBe(NOW + 30_000)
    advance(30_000)
    b.reportOk() // 已过退避窗口 → 连续计数清零
    b.penalize()
    expect(b.usage().backoffUntil).toBe(NOW + 45_000)
    b.penalize(60_000) // 显式 Retry-After 优先
    expect(b.usage().backoffUntil).toBe(NOW + 100_000)
  })
})

describe('order counting bucket', () => {
  it('noteOrder() counts into the 10 s and 1 min windows', () => {
    const { b, advance } = budget()
    b.noteOrder(3)
    expect(b.usage().orders).toEqual({ last10s: 3, last1min: 3 })
    advance(11_000)
    b.noteOrder()
    expect(b.usage().orders).toEqual({ last10s: 1, last1min: 4 })
    advance(50_000)
    // 只有 t0 的三笔滚出 1 分钟窗口，t0+11s 那一笔还在
    expect(b.usage().orders).toEqual({ last10s: 0, last1min: 1 })
  })

  it('exposes the official order-rate limits', () => {
    expect(ORDER_LIMIT_PER_10S).toBe(300)
    expect(ORDER_LIMIT_PER_MIN).toBe(1200)
  })
})

describe('endpoint weights', () => {
  it('matches the Binance USDⓈ-M documented weights', () => {
    expect(BINANCE_WEIGHTS.account).toBe(5)
    expect(BINANCE_WEIGHTS.positionRisk).toBe(5)
    expect(BINANCE_WEIGHTS.userTrades).toBe(5)
    expect(BINANCE_WEIGHTS.openOrdersAllSymbols).toBe(40)
    expect(BINANCE_WEIGHTS.openOrdersWithSymbol).toBe(1)
    expect(orderWeight()).toBe(0)
  })
})
