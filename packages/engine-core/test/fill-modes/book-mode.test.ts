// SPDX-License-Identifier: CPAL-1.0
// 'book' 成交模式的边界用例。重点不是「能跑」，而是每条失败路径都真的报错、且报的是哪个 code：
// 缺数据 / 数据没覆盖到成交时刻 / 盘口吃不到量 / 选项冲突——任何一条都不许悄悄退回 'bar'（自查项 S15，成长档案 G16）。
import { describe, expect, it } from 'vitest'
import { BookFiller, FillModeError, type MarketRecord } from '../../src/strategy/fill-modes'
import { Simulator } from '../../src/strategy/simulator'
import { simulateSeries } from '../../src/strategy/backtest'
import type { SignalSeries } from '../../src/strategy/types'
import type { Candle } from '../../src/types'
import { STEP, T0, syntheticMarket } from './synthetic'

const T = (i: number): number => T0 + i * STEP

/** 一根价格恒为 px 的 K 线（开高低收相同）。 */
function bar(i: number, px: number, over: Partial<Candle> = {}): Candle {
  return { t: T(i), o: px, h: px, l: px, c: px, v: 100, ...over }
}

/** 单档盘口快照：买一 / 卖一各一档，量可以很小，用来制造部分成交与吃空。 */
function snapshot(ts: number, bid: number, ask: number, size: number, instrument = 'syn'): MarketRecord {
  return { type: 'book_snapshot', ts, instrument, bids: [[String(bid), String(size)]], asks: [[String(ask), String(size)]] }
}

/** 多档快照：mid 上下按 tick 排开，每档同样量。 */
function ladder(ts: number, mid: number, depth = 3, levelSize = 200, tick = 0.001, halfSpread = 0.0005): MarketRecord {
  const bids: Array<[string, string]> = []
  const asks: Array<[string, string]> = []
  for (let k = 0; k < depth; k += 1) {
    bids.push([String(round4(mid * (1 - halfSpread - k * tick))), String(levelSize)])
    asks.push([String(round4(mid * (1 + halfSpread + k * tick))), String(levelSize)])
  }
  return { type: 'book_snapshot', ts, instrument: 'syn', bids, asks }
}

const round4 = (x: number): number => Math.round(x * 10_000) / 10_000

const codeOf = (fn: () => unknown): string => {
  try {
    fn()
  } catch (error) {
    if (error instanceof FillModeError) return error.code
    return `非 FillModeError：${error instanceof Error ? error.message : String(error)}`
  }
  return '没有抛错'
}

const flatSeries = (targets: number[], warmup = 0): SignalSeries => ({
  target: targets,
  reasons: targets.map((t) => (t === 0 ? '' : 'test')),
  overlays: {},
  warmup,
})

describe("'book' 模式：成交价与量都取盘口", () => {
  it('买用最优卖价、卖用最优买价，不看 K 线开盘价（盘口被故意挪开 5%）', () => {
    const candles = [bar(0, 100), bar(1, 100)]
    const records: MarketRecord[] = [ladder(T(1), 105)]
    const sim = new Simulator({
      initialCash: 10_000, leverage: 1, feeRate: 0, slippageBps: 0,
      fillMode: 'book', bookFeed: { records },
    })
    sim.onBar(0, candles[0]!, null, '')
    sim.onBar(1, candles[1]!, 0.5, 'signal')
    const trade = sim.trades[0]!
    expect(trade.price).toBeCloseTo(105 * 1.0005, 6)
    expect(trade.price).toBeGreaterThan(candles[1]!.o)
    // 定仓位也按盘口最优价：满仓 1× 时成交量 × 成交价 = 权益 × 目标
    expect(trade.size * trade.price).toBeCloseTo(0.5 * 10_000, 6)
    expect(sim.fillMode).toBe('book')
  })

  it('卖单吃买档：成交价等于最优买价', () => {
    const candles = [bar(0, 100), bar(1, 100)]
    const records: MarketRecord[] = [ladder(T(1), 105)]
    const sim = new Simulator({
      initialCash: 10_000, leverage: 1, feeRate: 0, slippageBps: 0,
      fillMode: 'book', bookFeed: { records },
    })
    sim.onBar(0, candles[0]!, null, '')
    sim.onBar(1, candles[1]!, -0.5, 'signal')
    expect(sim.trades[0]!.side).toBe('sell')
    expect(sim.trades[0]!.price).toBeCloseTo(105 * 0.9995, 6)
  })

  it('单档不够就逐档吃，成交价是各档成交额的加权均价（按定义手算，不引用实现）', () => {
    // 每档 25，六档共 150；满仓目标量约 99.95 会吃掉第 0..3 档
    const candles = [bar(0, 100), bar(1, 100)]
    const records: MarketRecord[] = [ladder(T(1), 100, 6, 25)]
    const sim = new Simulator({
      initialCash: 10_000, leverage: 1, feeRate: 0, slippageBps: 0,
      fillMode: 'book', bookFeed: { records },
    })
    sim.onBar(0, candles[0]!, null, '')
    sim.onBar(1, candles[1]!, 1, 'signal')
    const asks = [0, 1, 2, 3, 4, 5].map((k) => round4(100 * (1 + 0.0005 + k * 0.001)))
    const wanted = 10_000 / asks[0]! // 定仓位用最优卖价
    let left = wanted
    let notional = 0
    for (const px of asks) {
      const take = Math.min(left, 25)
      notional += take * px
      left -= take
      if (left <= 0) break
    }
    const trade = sim.trades[0]!
    expect(trade.size).toBeCloseTo(wanted, 9)
    expect(trade.price).toBeCloseTo(notional / wanted, 6)
    expect(trade.price).toBeGreaterThan(asks[0]!)
    expect(trade.price).toBeLessThan(asks[5]!)
  })

  it('簿上量不足：只成交吃得到的那部分，余额记进未成交名义（不追单、不按 K 线量补齐）', () => {
    const candles = [bar(0, 100), bar(1, 100)]
    const records: MarketRecord[] = [ladder(T(1), 100, 2, 5)]
    const sim = new Simulator({
      initialCash: 10_000, leverage: 1, feeRate: 0, slippageBps: 0,
      fillMode: 'book', bookFeed: { records },
    })
    sim.onBar(0, candles[0]!, null, '')
    sim.onBar(1, candles[1]!, 1, 'signal')
    const trade = sim.trades[0]!
    expect(trade.size).toBeCloseTo(10, 9) // 两档 × 5
    expect(sim.unfilledNotional).toBeGreaterThan(0)
    const stats = sim.stats(candles, STEP)
    expect(stats.unfilledShare).toBeGreaterThan(0)
    expect(stats.unfilledShare).toBeLessThan(1)
  })

  it('手续费按盘口成交额计（单价 × 数量 × feeRate），与 bar 模式同一套记账', () => {
    const candles = [bar(0, 100), bar(1, 100)]
    const records: MarketRecord[] = [ladder(T(1), 100, 5, 100)]
    const sim = new Simulator({
      initialCash: 10_000, leverage: 1, feeRate: 0.001, slippageBps: 0,
      fillMode: 'book', bookFeed: { records },
    })
    sim.onBar(0, candles[0]!, null, '')
    sim.onBar(1, candles[1]!, 1, 'signal')
    const trade = sim.trades[0]!
    expect(trade.fee).toBeCloseTo(trade.size * trade.price * 0.001, 9)
    expect(sim.feesPaid).toBeCloseTo(trade.fee, 9)
  })

  it('手数步长在 book 模式仍然生效（先归一再按盘口吃）', () => {
    const candles = [bar(0, 100), bar(1, 100)]
    const records: MarketRecord[] = [ladder(T(1), 100, 5, 100)]
    const sim = new Simulator({
      initialCash: 10_000, leverage: 1, feeRate: 0, slippageBps: 0, lotStep: 1,
      fillMode: 'book', bookFeed: { records },
    })
    sim.onBar(0, candles[0]!, null, '')
    sim.onBar(1, candles[1]!, 1, 'signal')
    expect(Number.isInteger(sim.trades[0]!.size)).toBe(true)
    expect(sim.trades[0]!.size).toBe(99)
  })

  it('只看成交时刻已经可见的盘口：后面才到的离谱价不参与成交', () => {
    const candles = [bar(0, 100), bar(1, 100), bar(2, 100), bar(3, 100)]
    const records: MarketRecord[] = [
      ladder(T(0), 100),
      ladder(T(2), 900, 1, 1000), // 未来记录：价格是 9 倍，若被偷看会立刻暴露
    ]
    const sim = new Simulator({
      initialCash: 10_000, leverage: 1, feeRate: 0, slippageBps: 0,
      fillMode: 'book', bookFeed: { records },
    })
    sim.onBar(0, candles[0]!, null, '')
    sim.onBar(1, candles[1]!, 1, 'signal')
    expect(sim.trades[0]!.price).toBeCloseTo(100 * 1.0005, 6)
  })

  it('book 模式 + maxVolumeShare：想要的名义只记一次，未成交占比不被打折', () => {
    // 按定义手算：最优卖价与想要量都取自盘口，上限 5 个（K 线量 10 × 0.5）
    const candles = [bar(0, 100), bar(1, 100, { v: 10 })]
    const records: MarketRecord[] = [ladder(T(1), 100, 5, 100)]
    const sim = new Simulator({
      initialCash: 10_000, leverage: 1, feeRate: 0, slippageBps: 0, maxVolumeShare: 0.5,
      fillMode: 'book', bookFeed: { records },
    })
    sim.onBar(0, candles[0]!, null, '')
    sim.onBar(1, candles[1]!, 1, 'signal')
    const ask = Math.round(100 * 1.0005 * 10_000) / 10_000
    const want = 10_000 / ask
    const expected = (want - 5) / want
    expect(sim.stats(candles, STEP).unfilledShare).toBeCloseTo(expected, 5)
    expect(sim.trades[0]!.size).toBeCloseTo(5, 9)
  })

  it('同一条记录流跑两遍结果完全一致（确定性）', () => {
    const { candles, records } = syntheticMarket({ bars: 60 })
    const targets = candles.map((_, i) => (i < 5 ? 0 : i % 2 === 0 ? 0.3 : -0.2))
    const s = flatSeries(targets)
    const run = (): string =>
      JSON.stringify(simulateSeries(s, candles, { fillMode: 'book', bookFeed: { records }, initialCash: 10_000, leverage: 1 }))
    expect(run()).toBe(run())
  })
})

describe("'book' 模式：缺数据一律报错，不退回 'bar'", () => {
  it('开了 book 却没给 bookFeed → missing_feed（构造时就报，不等到成交）', () => {
    expect(
      codeOf(() => new Simulator({ initialCash: 1_000, leverage: 1, feeRate: 0, slippageBps: 0, fillMode: 'book' })),
    ).toBe('missing_feed')
  })

  it('bookFeed 里既无 jsonl 也无 records → missing_feed', () => {
    expect(codeOf(() => new BookFiller({}))).toBe('missing_feed')
  })

  it('jsonl 与 records 同时给 → feed_conflict（状态不明不猜）', () => {
    expect(
      codeOf(() => new BookFiller({ jsonl: '', records: [ladder(T(0), 100)] })),
    ).toBe('feed_conflict')
  })

  it('记录为空 → empty_feed', () => {
    expect(codeOf(() => new BookFiller({ records: [] }))).toBe('empty_feed')
  })

  it('数据从更晚的时刻才开始 → stale_feed（不拿 K 线价顶）', () => {
    const filler = new BookFiller({ records: [ladder(T(10), 100)] })
    expect(codeOf(() => filler.execute(T(1), 1))).toBe('stale_feed')
    expect(codeOf(() => filler.topPrice(T(1), 'buy'))).toBe('stale_feed')
  })

  it('成交时刻晚于数据最后一条记录 → stale_feed（不用最后一版盘口静默成交）', () => {
    const filler = new BookFiller({ records: [ladder(T(0), 100), ladder(T(1), 100)] })
    expect(filler.execute(T(1), 1).filled).toBe(1)
    expect(codeOf(() => filler.execute(T(2), 1))).toBe('stale_feed')
    expect(codeOf(() => filler.topPrice(T(2), 'buy'))).toBe('stale_feed')
  })

  it('回测跑到数据末尾之后才成交 → stale_feed（盘口只到第 20 根，第 31 根才开仓）', () => {
    const { candles, records } = syntheticMarket({ bars: 60, depth: 6, levelSize: 5000 })
    const cutoff = candles[20]!.t
    const short = records.filter((r) => r.ts <= cutoff)
    const targets = candles.map((_, i) => (i < 30 ? 0 : 1))
    let error: unknown = null
    try {
      simulateSeries(flatSeries(targets), candles, {
        fillMode: 'book', bookFeed: { records: short }, initialCash: 10_000, leverage: 1,
      })
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(FillModeError)
    expect((error as FillModeError).code).toBe('stale_feed')
  })

  it('盘口被自己吃空后再下单 → no_liquidity（不按 0 成交静默跳过）', () => {
    const filler = new BookFiller({ records: [snapshot(T(0), 99, 101, 5)] })
    expect(filler.execute(T(0), 5).filled).toBe(5)
    expect(codeOf(() => filler.execute(T(0), 1))).toBe('no_liquidity')
  })

  it('数据没通过 sim-book 校验（ts 回退）→ unparsable_feed，报错带行号', () => {
    const bad: MarketRecord[] = [ladder(T(5), 100), ladder(T(1), 100)]
    const err = (() => {
      try {
        new BookFiller({ records: bad })
      } catch (e) {
        return e as FillModeError
      }
      return null
    })()
    expect(err?.code).toBe('unparsable_feed')
    expect(err?.message).toContain('行')
  })

  it('JSONL 文本语法坏了 → unparsable_feed', () => {
    expect(codeOf(() => new BookFiller({ jsonl: '{"type":"book_snapshot"}\n不是 JSON\n' }))).toBe('unparsable_feed')
  })

  it('给了 bookFeed 但没写 fillMode → unknown_mode（不静默忽略盘口数据）', () => {
    expect(
      codeOf(() => new Simulator({ initialCash: 1_000, leverage: 1, feeRate: 0, slippageBps: 0, bookFeed: { records: [ladder(T(0), 100)] } })),
    ).toBe('unknown_mode')
  })

  it('fillMode 写错（拼写 / 大小写）→ unknown_mode', () => {
    expect(
      codeOf(() => new Simulator({ initialCash: 1_000, leverage: 1, feeRate: 0, slippageBps: 0, fillMode: 'Book' as never })),
    ).toBe('unknown_mode')
  })

  it('book 模式 + 保护规则 → unsupported_option（两种价格来源不混用）', () => {
    expect(
      codeOf(() =>
        new Simulator({
          initialCash: 1_000, leverage: 1, feeRate: 0, slippageBps: 0,
          fillMode: 'book', bookFeed: { records: [ladder(T(0), 100)] },
          protection: { stopLossPct: 0.05 },
        }),
      ),
    ).toBe('unsupported_option')
  })

  it('book 模式 + 强平 → unsupported_option', () => {
    expect(
      codeOf(() =>
        new Simulator({
          initialCash: 1_000, leverage: 1, feeRate: 0, slippageBps: 0,
          fillMode: 'book', bookFeed: { records: [ladder(T(0), 100)] }, liquidation: true,
        }),
      ),
    ).toBe('unsupported_option')
  })

  it('回测入口把错误原样抛出来（不吞掉、不换模式跑完）', () => {
    const candles = [bar(0, 100), bar(1, 100)]
    // 第 1 根按上一根的目标仓位 1 下单 → 必须去问盘口，而盘口数据从第 7 根才开始
    expect(codeOf(() => simulateSeries(flatSeries([1, 1]), candles, { fillMode: 'book' }))).toBe('missing_feed')
    expect(
      codeOf(() => simulateSeries(flatSeries([1, 1]), candles, { fillMode: 'book', bookFeed: { records: [ladder(T(7), 100)] } })),
    ).toBe('stale_feed')
  })

  it('全程没有成交时不碰盘口，也就不因数据晚到报错（报错只发生在真要成交的那一刻）', () => {
    const candles = [bar(0, 100), bar(1, 100)]
    expect(() =>
      simulateSeries(flatSeries([0, 0]), candles, { fillMode: 'book', bookFeed: { records: [ladder(T(7), 100)] } }),
    ).not.toThrow()
  })

  it('错误对象带 code 与名字，便于调用方区分「数据问题」和「逻辑 bug」', () => {
    try {
      new Simulator({ initialCash: 1, leverage: 1, feeRate: 0, slippageBps: 0, fillMode: 'book' })
      expect.unreachable('应当抛错')
    } catch (error) {
      expect(error).toBeInstanceOf(FillModeError)
      expect((error as FillModeError).name).toBe('FillModeError')
      expect((error as FillModeError).code).toBe('missing_feed')
    }
  })
})

describe("'book' 模式：输入形式的等价性", () => {
  it('JSONL 与已解析记录得到同一份结果', () => {
    const { candles, records } = syntheticMarket({ bars: 40 })
    const targets = candles.map((_, i) => (i < 3 ? 0 : i % 3 === 0 ? 0.4 : 0.4))
    const s: SignalSeries = { target: targets, reasons: targets.map(() => 'x'), overlays: {}, warmup: 0 }
    const jsonl = records.map((r) => JSON.stringify(r)).join('\n') + '\n'
    const a = simulateSeries(s, candles, { fillMode: 'book', bookFeed: { records }, initialCash: 5_000 })
    const b = simulateSeries(s, candles, { fillMode: 'book', bookFeed: { jsonl }, initialCash: 5_000 })
    expect(JSON.stringify(b)).toBe(JSON.stringify(a))
  })
})
