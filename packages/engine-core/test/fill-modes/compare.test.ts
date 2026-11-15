// SPDX-License-Identifier: CPAL-1.0
// 同一段合成行情、同一个策略，分别按 'bar' 与 'book' 成交，把差异摊开（REPORT-9-T7 的差异表就来自这里的输出）。
// 这里既断言「两种模式都真的跑起来了、数字确实不同」，也把逐笔成交口径的差算出来，避免只凭印象写报告。
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { runBacktest, type BacktestRun } from '../../src/strategy/backtest'
import { loadStrategyFile } from '../../src/strategy/loader'
import type { Candle } from '../../src/types'
import { STEP, syntheticMarket } from './synthetic'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const EXAMPLES = join(HERE, '..', '..', 'examples', 'strategies')

interface Row {
  strategy: string
  mode: 'bar' | 'book'
  fills: number
  trips: number
  finalEquity: number
  fees: number
  maxDd: number
  /** 成交额加权的「价差成本」：买单按高于基准、卖单按低于基准计（相对该根开盘价，bps）。 */
  costBps: number
}

/** 价差成本：成交价相对同根 K 线开盘价的不利偏移（bps）。两种模式用同一把尺子量。 */
function costBps(run: BacktestRun, candles: readonly Candle[]): number {
  const open = new Map<number, number>(candles.map((c) => [c.t, c.o]))
  let notional = 0
  let cost = 0
  for (const t of run.trades) {
    const o = open.get(t.t)
    if (o === undefined) continue
    const signed = t.side === 'buy' ? 1 : -1
    cost += ((t.price - o) / o) * signed * t.size * t.price
    notional += t.size * t.price
  }
  return notional > 0 ? (cost / notional) * 1e4 : 0
}

function row(strategy: string, mode: 'bar' | 'book', run: BacktestRun, candles: readonly Candle[]): Row {
  return {
    strategy,
    mode,
    fills: run.stats.fills,
    trips: run.stats.trades,
    finalEquity: run.stats.finalEquity,
    fees: run.stats.feesPaid,
    maxDd: run.stats.maxDrawdownRatio,
    costBps: Number(costBps(run, candles).toFixed(2)),
  }
}

const f = (x: number, d = 2): string => x.toFixed(d)

describe('同一合成行情下 bar 与 book 的成交差异', () => {
  it('ema-cross：两种模式的成交价、成交量、权益都不同，差异逐项可解释', async () => {
    const loaded = await loadStrategyFile(join(EXAMPLES, 'ema-cross.ts'))
    expect(loaded.errors).toEqual([])
    const def = loaded.def!
    const { candles, records } = syntheticMarket({ bars: 200, depth: 4, levelSize: 60, tick: 0.0008 })

    // 共同的撮合参数：只有 fillMode 不同，其他一律一致（手续费口径相同，便于只比价差与量）
    const base = { intervalMs: STEP, initialCash: 10_000, leverage: 1, feeRate: 0.00045, slippageBps: 2 }
    const barRun = runBacktest(def, candles, undefined, { ...base, fillMode: 'bar' })
    const bookRun = runBacktest(def, candles, undefined, { ...base, fillMode: 'book', bookFeed: { records } })

    const rows = [row('ema-cross', 'bar', barRun, candles), row('ema-cross', 'book', bookRun, candles)]
    console.log(
      ['| 模式 | 成交笔数 | 往返笔数 | 期末权益 | 手续费 | 最大回撤 | 价差成本(bps) |', '|---|---|---|---|---|---|---|']
        .concat(rows.map((r) => `| ${r.mode} | ${r.fills} | ${r.trips} | ${f(r.finalEquity)} | ${f(r.fees, 4)} | ${f(r.maxDd, 6)} | ${r.costBps} |`))
        .join('\n'),
    )

    expect(barRun.stats.fills).toBeGreaterThan(0)
    expect(bookRun.stats.fills).toBeGreaterThan(0)
    // 换「成交口径」必须真的改变结果，否则说明 fillMode 没生效
    expect(bookRun.stats.finalEquity).not.toBe(barRun.stats.finalEquity)
    // 'book' 模式的成交价只可能来自盘口：与同根开盘价的距离应当明显偏离固定 2bps 滑点
    const bookPrices = new Set(bookRun.trades.map((t) => t.price))
    const barPrices = new Set(barRun.trades.map((t) => t.price))
    expect([...bookPrices].some((p) => !barPrices.has(p))).toBe(true)
  }, 60_000)

  it('盘口越薄，book 模式的成交价越差（价差成本随档位深度单调变大）', async () => {
    const loaded = await loadStrategyFile(join(EXAMPLES, 'ema-cross.ts'))
    const def = loaded.def!
    const base = { intervalMs: STEP, initialCash: 10_000, leverage: 1, feeRate: 0, slippageBps: 0, fillMode: 'book' as const }
    const thin = syntheticMarket({ bars: 200, depth: 2, levelSize: 10, tick: 0.0008 })
    const thick = syntheticMarket({ bars: 200, depth: 6, levelSize: 400, tick: 0.0008 })
    const thinRun = runBacktest(def, thin.candles, undefined, { ...base, bookFeed: { records: thin.records } })
    const thickRun = runBacktest(def, thick.candles, undefined, { ...base, bookFeed: { records: thick.records } })
    const thinCost = costBps(thinRun, thin.candles)
    const thickCost = costBps(thickRun, thick.candles)
    console.log(`薄簿价差成本 ${f(thinCost)} bps / 厚簿 ${f(thickCost)} bps；薄簿成交 ${thinRun.stats.fills} 笔、未成交占比 ${f(thinRun.stats.unfilledShare, 4)}`)
    expect(thinCost).toBeGreaterThan(thickCost)
    expect(thinRun.stats.unfilledShare).toBeGreaterThan(thickRun.stats.unfilledShare)
  }, 60_000)

  it("缺省模式仍是 'bar'：不填 fillMode 与显式写 'bar' 逐字段相同", async () => {
    const loaded = await loadStrategyFile(join(EXAMPLES, 'ema-cross.ts'))
    const def = loaded.def!
    const { candles } = syntheticMarket({ bars: 120 })
    const base = { intervalMs: STEP, initialCash: 10_000, leverage: 1, feeRate: 0.00045, slippageBps: 2 }
    const implicit = runBacktest(def, candles, undefined, { ...base })
    const explicit = runBacktest(def, candles, undefined, { ...base, fillMode: 'bar' })
    expect(JSON.stringify(implicit)).toBe(JSON.stringify(explicit))
  }, 60_000)
})
