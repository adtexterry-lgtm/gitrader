// SPDX-License-Identifier: CPAL-1.0
// 属性测试（批 10 欠交件 · 不变式 5）：sim-book 流动性守恒 + 订单 id 去重幂等。
//
// 被测实现：src/book.ts（MarketBook 的 consumedBid / consumedAsk 台账 + consume/availableAt）
//           与 src/engine.ts（SimBook 逐档吃量、FOK 试算不落账、订单 id 去重 engine.ts:259）。
//
// 断的不变式（守恒等式）：
//   每一档：size == available + consumed，且 consumed ≥ 0、0 ≤ available ≤ size；
//   每一侧：Σavailable == Σsize − Σconsumed；
//   整簿：Σsize(初始注入) − Σconsumed == Σavailable（随机成交序列跑完仍成立）；
//   成交只吃对手侧，主动方向买 → 只动卖档；且一次吃到的量 ≤ 本次成交量、≤ 吃掉前的可吃量；
//   挂单成交：委托簿可吃量的下降量恰好等于回报里的成交量（不多吃也不少记）；
//   FOK 吃不下 → 盘口可吃量一格不动（试算不落账）。
//
// 随机源：本文件自带的 mulberry32，种子写死 42。
import { describe, expect, it } from 'vitest'
import { add, cmp, fx, str, sub, type Fx } from '@gitrader/protocol/decimal'
import { SimBook } from '../src'
import type { BookSide, LevelTuple, SimBookOptions } from '../src'

const SEED = 42
const SAMPLES = 600
const STEPS = 12

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const SIZES = ['0.5', '1', '2', '7.5', '0.001', '100']
const pick = <T>(rnd: () => number, xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T

/** 造一份不交叉的盘口：买档从高到低、卖档从低到高，各 k 档。 */
function snapshot(rnd: () => number): { bids: LevelTuple[]; asks: LevelTuple[] } {
  const k = 1 + Math.floor(rnd() * 4)
  const mid = 50 + Math.floor(rnd() * 150)
  const bids: LevelTuple[] = []
  const asks: LevelTuple[] = []
  for (let i = 0; i < k; i += 1) {
    bids.push([String(mid - 1 - i), pick(rnd, SIZES)])
    asks.push([String(mid + 1 + i), pick(rnd, SIZES)])
  }
  return { bids, asks }
}

function newBook(snap: { bids: LevelTuple[]; asks: LevelTuple[] }, options: SimBookOptions = {}): SimBook {
  const sim = new SimBook({ instrument: 'BTCUSDT', ...options })
  sim.apply({ type: 'book_snapshot', ts: 1, instrument: 'BTCUSDT', bids: snap.bids, asks: snap.asks })
  return sim
}

const sides: readonly BookSide[] = ['bid', 'ask']

function totalSize(sim: SimBook, side: BookSide): Fx {
  return sim.book.levels(side).reduce((acc, level) => add(acc, level.size), 0n)
}
function totalAvailable(sim: SimBook, side: BookSide): Fx {
  return sim.book.levels(side).reduce((acc, level) => add(acc, sim.book.availableAt(side, level.price)), 0n)
}
function totalConsumed(sim: SimBook, side: BookSide): Fx {
  return sim.book.levels(side).reduce((acc, level) => add(acc, sim.book.consumedAt(side, level.price)), 0n)
}

/** 每一档的守恒等式：size == available + consumed，且都在合法区间内。 */
function assertLevelConservation(sim: SimBook): void {
  for (const side of sides) {
    for (const level of sim.book.levels(side)) {
      const available = sim.book.availableAt(side, level.price)
      const consumed = sim.book.consumedAt(side, level.price)
      expect(cmp(consumed, 0n)).toBeGreaterThanOrEqual(0)
      expect(cmp(available, 0n)).toBeGreaterThanOrEqual(0)
      expect(cmp(available, level.size)).toBeLessThanOrEqual(0)
      // 守恒等式逐档成立：显示量 = 可吃量 + 已吃量
      expect(add(available, consumed)).toBe(level.size)
    }
    // 每一侧：Σavailable == Σsize − Σconsumed
    expect(sub(totalSize(sim, side), totalConsumed(sim, side))).toBe(totalAvailable(sim, side))
  }
}

describe('不变式 5 · 流动性守恒（种子 42，600 组随机撮合序列）', () => {
  it(`随机逐笔成交跑完，盘口流动性 = 初始注入 − 被吃掉量（${SAMPLES} 组 × ${STEPS} 步）`, () => {
    const rnd = mulberry32(SEED)
    let consumedTotal = 0n
    for (let i = 0; i < SAMPLES; i += 1) {
      const snap = snapshot(rnd)
      const sim = newBook(snap)
      // 初始注入量：快照刚落盘，没有任何消耗
      const injected = { bid: totalSize(sim, 'bid'), ask: totalSize(sim, 'ask') }
      assertLevelConservation(sim)
      expect(totalConsumed(sim, 'bid')).toBe(0n)
      expect(totalConsumed(sim, 'ask')).toBe(0n)

      const tookBySide = { bid: 0n, ask: 0n }
      for (let step = 0; step < STEPS; step += 1) {
        const aggressor = pick(rnd, ['buy', 'sell', 'unknown'] as const)
        const target: BookSide = aggressor === 'buy' ? 'ask' : 'bid'
        const targetLevels = sim.book.levels(target)
        // 六成的成交打在真实档位上（其余打在不存在的价位：吃不到，台账不该动）
        const price = targetLevels.length > 0 && rnd() < 0.6
          ? str(pick(rnd, targetLevels).price)
          : String(50 + Math.floor(rnd() * 200))
        const size = pick(rnd, SIZES)
        const before = { bid: totalConsumed(sim, 'bid'), ask: totalConsumed(sim, 'ask') }
        const beforeAvailable = { bid: totalAvailable(sim, 'bid'), ask: totalAvailable(sim, 'ask') }
        const outcome = sim.book.applyTrade({ type: 'trade', ts: 10 + step, instrument: 'BTCUSDT', price, size, aggressor })

        // 成交只吃对手侧：另一侧的已消耗量一动不动
        const other: BookSide = target === 'ask' ? 'bid' : 'ask'
        expect(totalConsumed(sim, other)).toBe(before[other])
        // 吃到的量 ≤ 本次成交量，且 ≤ 吃掉前的可吃量
        expect(cmp(outcome.consumed, 0n)).toBeGreaterThanOrEqual(0)
        expect(cmp(outcome.consumed, fx(size))).toBeLessThanOrEqual(0)
        expect(cmp(outcome.consumed, beforeAvailable[target])).toBeLessThanOrEqual(0)
        // 方向未知时不消耗
        if (aggressor === 'unknown') expect(outcome.consumed).toBe(0n)
        // 消耗量与台账增量一致（不多记也不少记）
        expect(sub(totalConsumed(sim, target), before[target])).toBe(outcome.consumed)
        tookBySide[target] = add(tookBySide[target], outcome.consumed)
        consumedTotal = add(consumedTotal, outcome.consumed)

        assertLevelConservation(sim)
      }

      // 守恒等式：初始注入 − 被吃掉量 == 现在还能吃到的量（两侧各算一遍）
      for (const side of sides) {
        expect(sub(injected[side], tookBySide[side])).toBe(totalAvailable(sim, side))
        expect(totalConsumed(sim, side)).toBe(tookBySide[side])
      }
      // 吃掉量不可能超过注入量
      expect(cmp(totalConsumed(sim, 'bid'), injected.bid)).toBeLessThanOrEqual(0)
      expect(cmp(totalConsumed(sim, 'ask'), injected.ask)).toBeLessThanOrEqual(0)
    }
    // 随机序列必须真的吃到过流动性，否则守恒等式是空转
    expect(consumedTotal).toBeGreaterThan(0n)
  })

  it(`挂单成交：盘口可吃量的下降量恰好等于回报里的成交量（${SAMPLES} 组随机委托）`, () => {
    const rnd = mulberry32(SEED)
    let filledCases = 0
    for (let i = 0; i < SAMPLES; i += 1) {
      const snap = snapshot(rnd)
      const sim = newBook(snap)
      const side = pick(rnd, ['buy', 'sell'] as const)
      const type = pick(rnd, ['market', 'limit'] as const)
      const tif = pick(rnd, ['gtc', 'ioc', 'fok'] as const)
      const qty = pick(rnd, ['0.5', '1', '3', '25'])
      const limitPrice = pick(rnd, ['40', '60', '120', '200', String(snap.asks[0]?.[0] ?? '101')])
      const before = { bid: totalAvailable(sim, 'bid'), ask: totalAvailable(sim, 'ask') }
      const consumedBefore = { bid: totalConsumed(sim, 'bid'), ask: totalConsumed(sim, 'ask') }
      const report = sim.submit(
        { id: `o-${i}`, side, type, qty, tif, ...(type === 'limit' ? { price: limitPrice } : {}) },
        5,
      )
      const filled = fx(report.filledQty)
      const bookSide: BookSide = side === 'buy' ? 'ask' : 'bid'
      // 我方吃掉的是对手侧：本侧可吃量不变，对手侧正好少掉成交量
      expect(sub(before[bookSide], totalAvailable(sim, bookSide))).toBe(filled)
      const own: BookSide = bookSide === 'ask' ? 'bid' : 'ask'
      expect(totalAvailable(sim, own)).toBe(before[own])
      expect(sub(totalConsumed(sim, bookSide), consumedBefore[bookSide])).toBe(filled)
      // 成交量 = 各笔成交数量之和（逐档吃量的记账闭合）
      const sumFills = report.fills.reduce((acc, f) => add(acc, fx(f.qty)), 0n)
      expect(sumFills).toBe(filled)
      // FOK 吃不下 → 一格都不落账（试算不落账）
      if (tif === 'fok' && report.reason === 'fok_unfillable') {
        expect(filled).toBe(0n)
        expect(totalAvailable(sim, bookSide)).toBe(before[bookSide])
        expect(totalConsumed(sim, bookSide)).toBe(consumedBefore[bookSide])
      }
      if (filled > 0n) filledCases += 1
      assertLevelConservation(sim)
    }
    expect(filledCases).toBeGreaterThan(SAMPLES / 2)
  })

  it(`快照与档位增量重置台账：改过的档位消耗清零，守恒等式仍成立（${SAMPLES} 组）`, () => {
    const rnd = mulberry32(SEED)
    for (let i = 0; i < SAMPLES; i += 1) {
      const snap = snapshot(rnd)
      const sim = newBook(snap)
      // 先吃点量
      const targetSide: BookSide = rnd() < 0.5 ? 'bid' : 'ask'
      const levels = sim.book.levels(targetSide)
      if (levels.length > 0) {
        const price = str(pick(rnd, levels).price)
        sim.book.consume(targetSide, fx(price), fx('0.25'))
      }
      const beforeConsumed = totalConsumed(sim, targetSide)
      const deltas = 1 + Math.floor(rnd() * 3)
      for (let d = 0; d < deltas; d += 1) {
        const side = pick(rnd, ties)
        const action = pick(rnd, ['add', 'update', 'delete'] as const)
        const current = sim.book.levels(side)
        if (action === 'add') {
          // 只在不会交叉的地方加新档，且挑一个当前不存在的价格
          let price = side === 'bid' ? 10 + Math.floor(rnd() * 5) : 300 + Math.floor(rnd() * 5)
          while (sim.book.hasLevel(side, fx(String(price)))) price += 1
          sim.apply({ type: 'book_delta', ts: 100 + d, instrument: 'BTCUSDT', side, action, price: String(price), size: pick(rnd, SIZES) })
        } else if (current.length > 0) {
          const price = str(pick(rnd, current).price)
          if (action === 'update') sim.apply({ type: 'book_delta', ts: 100 + d, instrument: 'BTCUSDT', side, action, price, size: pick(rnd, SIZES) })
          else sim.apply({ type: 'book_delta', ts: 100 + d, instrument: 'BTCUSDT', side, action, price })
        }
        assertLevelConservation(sim)
      }
      // 被 update 过的档位消耗清零；整体守恒仍成立（可能整侧没动，故只断不变量本身）
      for (const side of ties) {
        for (const level of sim.book.levels(side)) {
          const consumed = sim.book.consumedAt(side, level.price)
          expect(cmp(consumed, 0n)).toBeGreaterThanOrEqual(0)
          expect(add(sim.book.availableAt(side, level.price), consumed)).toBe(level.size)
        }
      }
      expect(cmp(totalConsumed(sim, targetSide), beforeConsumed)).toBeLessThanOrEqual(0)
      // 新快照整簿重置：两侧台账清零，可吃量回到注入量
      const fresh = snapshot(rnd)
      sim.apply({ type: 'book_snapshot', ts: 1_000, instrument: 'BTCUSDT', bids: fresh.bids, asks: fresh.asks })
      expect(totalConsumed(sim, 'bid')).toBe(0n)
      expect(totalConsumed(sim, 'ask')).toBe(0n)
      expect(totalAvailable(sim, 'bid')).toBe(totalSize(sim, 'bid'))
      expect(totalAvailable(sim, 'ask')).toBe(totalSize(sim, 'ask'))
      assertLevelConservation(sim)
    }
  })

  it(`订单 id 去重幂等：同一张单喂两遍，第二遍不落账、盘口不动（${SAMPLES} 组）`, () => {
    const rnd = mulberry32(SEED)
    for (let i = 0; i < SAMPLES; i += 1) {
      const snap = snapshot(rnd)
      const sim = newBook(snap)
      const side = pick(rnd, ['buy', 'sell'] as const)
      const qty = pick(rnd, ['0.5', '1', '3'])
      const request = { id: `o-${i}`, side, type: 'market' as const, qty }
      const first = sim.submit(request, 5)
      const availableAfterFirst = { bid: totalAvailable(sim, 'bid'), ask: totalAvailable(sim, 'ask') }
      const consumedAfterFirst = { bid: totalConsumed(sim, 'bid'), ask: totalConsumed(sim, 'ask') }
      const second = sim.submit(request, 6)
      // 第二遍必须被拒，且不产生任何成交
      expect(second.status).toBe('rejected')
      expect(second.reason).toBe('duplicate_order_id')
      expect(second.filledQty).toBe('0')
      expect(second.fills).toEqual([])
      // 盘口与台账一格未动
      expect(totalAvailable(sim, 'bid')).toBe(availableAfterFirst.bid)
      expect(totalAvailable(sim, 'ask')).toBe(availableAfterFirst.ask)
      expect(totalConsumed(sim, 'bid')).toBe(consumedAfterFirst.bid)
      expect(totalConsumed(sim, 'ask')).toBe(consumedAfterFirst.ask)
      // 第一遍的结果可复现：同一快照重放开新簿，结果相同
      const replay = newBook(snap)
      expect(JSON.stringify(replay.submit(request, 5))).toBe(JSON.stringify(first))
      assertLevelConservation(sim)
    }
  })
})

const ties: readonly BookSide[] = ['bid', 'ask']
