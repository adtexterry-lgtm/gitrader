// SPDX-License-Identifier: CPAL-1.0
// 四个机器人模板（网格 / 定投 / 马丁 / 趋势）的冒烟回测：合成 300 根 K 线，走真实加载器 + 回测入口，
// 断言「有成交」「成交方向符合模板语义」「结果字段齐全」，并用协议包的 findPromiseLanguage 扫 desc / 名称 / 参数文案。
// 教学示例，无业绩含义：这里只验证形状与语义，不对收益做任何判断。
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { loadStrategyFile } from '../src/strategy/loader'
import { runBacktest } from '../src/strategy'
import type { BacktestRun } from '../src/strategy/backtest'
import type { StrategyDef } from '../src/strategy/types'
import type { Candle } from '../src/types'
import { findPromiseLanguage } from '../../protocol/src/plugin/manifest'
import { EXAMPLE_STRATEGIES } from './harness'
import { T0 } from './helpers'

const HOUR = 3_600_000
const BARS = 300

/** 合成 K 线：开盘 = 上一根收盘，上下影各 1%（趋势模板的 ATR 需要真实的 high / low）。 */
function candlesFrom(closes: number[]): Candle[] {
  return closes.map((c, i) => {
    const o = i === 0 ? c : closes[i - 1]!
    return { t: T0 + i * HOUR, o, h: Math.max(o, c) * 1.01, l: Math.min(o, c) * 0.99, c, v: 100 }
  })
}

/** 线性段：从 a 走到 b（含两端）。 */
const ramp = (n: number, a: number, b: number): number[] => Array.from({ length: n }, (_, i) => a + ((b - a) * i) / (n - 1))

// 网格：震荡序列（±8%，周期 24 根），会在 8 条网格线上反复穿越。
const GRID_CLOSES = Array.from({ length: BARS }, (_, i) => 100 + 8 * Math.sin((2 * Math.PI * i) / 24))
// 定投 / 马丁：先跌后涨（150 根 100 → 78，150 根 78 → 104）。
const DOWN_THEN_UP = [...ramp(150, 100, 78), ...ramp(150, 78, 104)]
// 趋势：单边上涨（250 根 100 → 160）后一段回落，用来验证移动止损平仓。
const UP_THEN_DROP = [...ramp(250, 100, 160), ...ramp(50, 160, 118)]

const defs: Record<string, StrategyDef> = {}

beforeAll(async () => {
  for (const id of ['grid', 'dca', 'martingale', 'trend-atr']) {
    const r = await loadStrategyFile(join(EXAMPLE_STRATEGIES, `${id}.ts`))
    expect(r.errors, id).toEqual([])
    if (!r.def) throw new Error(`${id} did not load`)
    defs[id] = r.def
  }
})

/** 回测结果的公共形状：字段齐全、数值有限、成交记录完整。 */
function expectComplete(r: BacktestRun, bars: number): void {
  expect(r.candlesUsed).toBe(bars)
  expect(r.equity.length).toBe(bars)
  expect(r.trades.length).toBeGreaterThan(0)
  const statKeys: Array<keyof BacktestRun['stats']> = ['totalReturnRatio', 'annualizedRatio', 'maxDrawdownRatio', 'sharpe', 'sortino', 'winRatio', 'trades', 'avgHoldBars', 'fills', 'spanDays', 'finalEquity', 'feesPaid']
  for (const k of statKeys) expect(typeof r.stats[k], String(k)).toBe('number')
  expect(Number.isFinite(r.stats.finalEquity)).toBe(true)
  for (const t of r.trades) {
    expect(['buy', 'sell']).toContain(t.side)
    for (const v of [t.t, t.price, t.size, t.pnl, t.fee]) expect(Number.isFinite(v)).toBe(true)
    expect(t.price).toBeGreaterThan(0)
    expect(t.size).toBeGreaterThan(0)
    expect(typeof t.reason).toBe('string')
  }
}

describe('四个机器人模板：合成 300 根 K 线的回测冒烟', () => {
  it('desc / 名称 / 参数文案没有承诺类用语（findPromiseLanguage）', () => {
    for (const [id, d] of Object.entries(defs)) {
      for (const text of [d.desc, d.name, d.nameZh ?? '', ...d.params.flatMap((x) => [x.label, x.help ?? ''])]) {
        expect(findPromiseLanguage(text), `${id}: ${text}`).toBeNull()
      }
    }
  })

  it('网格：震荡里低买高卖、仓位按格步进，逐格独立止盈', () => {
    const def = defs.grid!
    const r = runBacktest(def, candlesFrom(GRID_CLOSES), def.defaults, { feeRate: 0, slippageBps: 0 })
    expectComplete(r, BARS)
    expect(r.params.grids).toBe(8)
    expect(r.params.gridMode).toBe('arithmetic')
    expect(r.params.boundaryAction).toBe('pause')

    const sides = r.trades.map((t) => t.side)
    expect(sides[0]).toBe('buy') // 价格从中心价往下走：先买第一格
    expect(sides).toContain('sell')
    // 低买高卖，且每一格独立止盈：卖出价一定高于它之前最近的一笔买入价，买入价一定低于它之前最近的一笔卖出价。
    // （同一根 K 线上可以连着一格一格加减，所以买卖不保证逐笔交替，但方向与价格的关系是固定的。）
    let lastBuy = 0
    let lastSell = 0
    for (const t of r.trades) {
      if (t.side === 'buy') {
        if (lastSell > 0) expect(t.price, `买 ${t.price} 应低于上一次卖 ${lastSell}`).toBeLessThan(lastSell)
        lastBuy = t.price
      } else {
        expect(t.price, `卖 ${t.price} 应高于上一次买 ${lastBuy}`).toBeGreaterThan(lastBuy)
        lastSell = t.price
      }
    }
    expect(r.trades.filter((t) => t.side === 'buy').length).toBeGreaterThan(1)

    // 目标仓位只取 0…1 之间 1/grids 的整数倍（每格一份，不跨格加码）
    const steps = r.series.target.map((x) => Math.round(x * 8))
    for (const s of steps) expect(s).toBeGreaterThanOrEqual(0)
    for (const s of steps) expect(s).toBeLessThanOrEqual(8)
    for (const x of r.series.target) expect(Math.abs(x * 8 - Math.round(x * 8))).toBeLessThan(1e-6)
    expect(new Set(steps).size).toBeGreaterThanOrEqual(3) // 至少走过三档
    expect(r.overlays['网格上沿']![0]).toBeCloseTo(110)
    expect(r.overlays['网格下沿']![0]).toBeCloseTo(90)
  })

  it('网格：等比格子与越界处理（stop_loss / hold）生效', () => {
    const def = defs.grid!
    const geo = runBacktest(def, candlesFrom(GRID_CLOSES), { ...def.defaults, gridMode: 'geometric' }, { feeRate: 0, slippageBps: 0 })
    expectComplete(geo, BARS)
    expect(geo.overlays['网格上沿']![0]).toBeCloseTo(110) // 上下限不变，只是中间格子按等比排
    expect(geo.trades.length).toBeGreaterThan(0)

    // 越界：一条单边下跌序列跌穿下沿。pause 停在满格，stop_loss 越界清仓。
    const falling = candlesFrom(ramp(BARS, 100, 70))
    const paused = runBacktest(def, falling, def.defaults, { feeRate: 0, slippageBps: 0 })
    const stopped = runBacktest(def, falling, { ...def.defaults, boundaryAction: 'stop_loss' }, { feeRate: 0, slippageBps: 0 })
    expect(paused.series.target.at(-1)).toBe(1) // 跌出区间：满仓
    expect(stopped.series.target.at(-1)).toBe(0) // 跌出区间：清仓
    expect(stopped.trades.at(-1)!.side).toBe('sell')
  })

  it('定投：固定周期固定金额，只买不卖（止盈线默认关闭）', () => {
    const def = defs.dca!
    const r = runBacktest(def, candlesFrom(DOWN_THEN_UP), def.defaults, { feeRate: 0, slippageBps: 0 })
    expectComplete(r, BARS)
    expect(r.params.everyBars).toBe(24)
    expect(r.params.orders).toBe(10)
    expect(r.params.totalBudgetPct).toBe(100)

    // 只做多：全部是买入
    for (const t of r.trades) expect(t.side).toBe('buy')
    // 每 24 根一份，300 根最多 10 份（orders 封顶 = 总额上限）
    expect(r.trades.length).toBe(10)
    for (const t of r.trades) expect(t.reason).toContain('定投')
    // 份数单调累加：目标仓位 = k / orders
    expect(r.series.target.at(-1)).toBeCloseTo(1)
    const targets = r.series.target.filter((x, i, a) => i === 0 || x !== a[i - 1])
    expect(targets).toEqual([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1])

    // 总预算 50% 时，同样的节奏只用到一半仓位
    const half = runBacktest(def, candlesFrom(DOWN_THEN_UP), { ...def.defaults, totalBudgetPct: 50 }, { feeRate: 0, slippageBps: 0 })
    expect(half.series.target.at(-1)).toBeCloseTo(0.5)
    expect(half.trades.length).toBe(10)
  })

  it('马丁：先跌后涨序列下止损加倍重进、数量递增，止盈归零，层数封顶', () => {
    const def = defs.martingale!
    const r = runBacktest(def, candlesFrom(DOWN_THEN_UP), def.defaults, { feeRate: 0, slippageBps: 0 })
    expectComplete(r, BARS)
    expect(r.params.multiplier).toBe(2)
    expect(r.params.maxDoublings).toBe(3)

    // 目标仓位只取 baseSize × 2^level（level ≤ maxDoublings），封顶 1
    const allowed = [0, 0.1, 0.2, 0.4, 0.8, 1]
    expect(r.series.target.length).toBe(BARS)
    for (const x of r.series.target) expect(allowed.some((a) => Math.abs(a - x) < 1e-9), `target=${x}`).toBe(true)
    // 有加仓：先出现基础层，再出现更重的层（0.1 → 0.2 起）
    const lv = r.series.target.map((x) => Math.round(x * 10))
    expect(lv.indexOf(1)).toBeGreaterThan(-1)
    expect(lv.indexOf(2)).toBeGreaterThan(lv.indexOf(1))
    expect(Math.max(...lv)).toBeGreaterThanOrEqual(2)
    // 买入数量递增：存在后面某一笔买入显著大于前面某一笔
    const buys = r.trades.filter((t) => t.side === 'buy')
    expect(buys.length).toBeGreaterThan(3)
    expect(buys[0]!.size).toBeGreaterThan(0)
    const grew = buys.some((a, i) => buys.some((b, j) => j > i && b.size > a.size * 1.5))
    expect(grew).toBe(true)
    // 有止盈也有止损：理由里两种都出现过
    expect(r.series.reasons.some((x) => x.includes('止盈'))).toBe(true)
    expect(r.series.reasons.some((x) => x.includes('止损'))).toBe(true)
  })

  it('趋势：EMA 交叉开仓、ATR 移动止损平仓', () => {
    const def = defs['trend-atr']!
    const r = runBacktest(def, candlesFrom(UP_THEN_DROP), def.defaults, { feeRate: 0, slippageBps: 0 })
    expectComplete(r, BARS)
    expect(r.params.emaFast).toBe(20)
    expect(r.params.emaSlow).toBe(50)
    expect(r.params.atrMultiple).toBe(3)
    expect(r.series.warmup).toBe(50)

    const sides = r.trades.map((t) => t.side)
    expect(sides[0]).toBe('buy') // 单边上涨：先做多
    expect(sides).toContain('sell') // 回落触发移动止损

    // 开仓那根的目标由 0 变 1，且当时快线在慢线上方（交叉处开仓）
    const firstBuyBar = r.series.target.findIndex((x) => x === 1)
    expect(firstBuyBar).toBeGreaterThanOrEqual(50)
    expect(r.series.reasons[firstBuyBar]).toContain('进多')
    const fast = r.overlays['EMA快']![firstBuyBar]!
    const slow = r.overlays['EMA慢']![firstBuyBar]!
    expect(fast).toBeGreaterThan(slow)
    expect(r.series.target[firstBuyBar - 1]).toBe(0)

    // 平仓：收盘跌破止损线 → 平多，且止损线一路抬高（只朝有利方向移动）
    const exitBar = r.series.reasons.findIndex((x) => x.includes('平多'))
    expect(exitBar).toBeGreaterThan(firstBuyBar)
    const stopLine = r.overlays['止损线']!
    for (let k = firstBuyBar + 1; k < exitBar; k++) expect(stopLine[k]!).toBeGreaterThanOrEqual(stopLine[k - 1]!)
    expect(r.series.target[exitBar]).toBe(0)
  })
})
