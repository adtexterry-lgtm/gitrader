// SPDX-License-Identifier: CPAL-1.0
// 四个模板都跑一遍合成行情（engine-core 公开 synthCandles，种子固定）：能出成交、敞口不越界、可重放。
// 合成数据不代表任何真实行情，这里的数字只证明「模板在会动的价格上能工作」，不证明收益。
import { describe, expect, it } from 'vitest'
import { TEMPLATES } from '../src/index'
import { runBot } from '../src/engine'
import { GridBot } from '../src/grid'
import { DcaBot } from '../src/dca'
import { MartingaleBot } from '../src/martingale'
import { TrendBot } from '../src/trend'
import { synthetic } from './helpers'

const candles = synthetic(300, 11, 100)
const lo = Math.min(...candles.map((c) => c.l))
const hi = Math.max(...candles.map((c) => c.h))

describe('synthetic backtest per template', () => {
  it('grid: trades inside a bracket built from the sample range and stays under its cap', () => {
    const bot = new GridBot({
      lowerPrice: Math.floor(lo),
      upperPrice: Math.ceil(hi),
      gridCount: 10,
      gridMode: 'arithmetic',
      gridDirection: 'long',
      qtyPerGrid: 0.1,
      boundaryAction: 'hold',
      stopLossPct: 0,
      maxExposureNotional: 5_000,
    })
    const run = runBot(bot, candles)
    expect(run.fills.length).toBeGreaterThan(0)
    expect(run.maxExposure).toBeLessThanOrEqual(5_000 + 1e-9)
    expect(run.equity).toHaveLength(candles.length)
  })

  it('grid: a geometric grid also trades on the same sample', () => {
    const bot = new GridBot({
      lowerPrice: Math.floor(lo),
      upperPrice: Math.ceil(hi),
      gridCount: 10,
      gridMode: 'geometric',
      qtyPerGrid: 0.1,
      boundaryAction: 'hold',
      stopLossPct: 0,
      maxExposureNotional: 5_000,
    })
    const run = runBot(bot, candles)
    expect(run.fills.length).toBeGreaterThan(0)
    expect(run.maxExposure).toBeLessThanOrEqual(5_000 + 1e-9)
  })

  it('dca: never exceeds maxOrders or the exposure cap', () => {
    const bot = new DcaBot({
      frequency: 'daily',
      notionalPerOrder: 100,
      maxOrders: 20,
      dipBuyEnabled: true,
      dipThresholdPct: 2,
      takeProfitPct: 0,
      stopLossPct: 0,
      maxExposureNotional: 2_000,
    })
    const run = runBot(bot, candles)
    expect(run.fills.length).toBeGreaterThan(0)
    expect(run.fills.length).toBeLessThanOrEqual(20)
    expect(run.maxExposure).toBeLessThanOrEqual(2_000 + 1e-9)
  })

  it('martingale: add count stays within maxAdds and exposure stays under the cap', () => {
    const bot = new MartingaleBot({
      direction: 'long',
      baseNotional: 100,
      multiplier: 1.5,
      addDropPct: 2,
      maxAdds: 5,
      maxTotalNotional: 2_000,
      takeProfitPct: 3,
      stopLossPct: 20,
      maxExposureNotional: 2_000,
    })
    const run = runBot(bot, candles)
    expect(run.fills.length).toBeGreaterThanOrEqual(1)
    const opens = run.fills.filter((f) => f.side === 'buy').length
    expect(opens).toBeLessThanOrEqual(6)
    expect(run.maxExposure).toBeLessThanOrEqual(2_000 + 1e-9)
  })

  it('trend: trades and stays under its cap', () => {
    const bot = new TrendBot({
      maPeriod: 20,
      maType: 'SMA',
      confirmBars: 2,
      positionPct: 50,
      direction: 'both',
      trailingStopPct: 5,
      stopLossPct: 8,
      maxExposureNotional: 3_000,
    })
    const run = runBot(bot, candles)
    expect(run.fills.length).toBeGreaterThan(0)
    expect(run.maxExposure).toBeLessThanOrEqual(3_000 + 1e-9)
  })

  it('every template replays byte-identically on the same synthetic sample', () => {
    for (const id of Object.keys(TEMPLATES) as (keyof typeof TEMPLATES)[]) {
      const params = defaultParamsFor(id)
      const a = runBot(TEMPLATES[id].create(params), candles)
      const b = runBot(TEMPLATES[id].create(params), candles)
      expect(JSON.stringify(a)).toBe(JSON.stringify(b))
    }
  })
})

function defaultParamsFor(id: keyof typeof TEMPLATES): Record<string, unknown> {
  const params: Record<string, unknown> = {}
  for (const p of TEMPLATES[id].params) params[p.key] = p.default
  if (id === 'grid') {
    params.lowerPrice = Math.floor(lo)
    params.upperPrice = Math.ceil(hi)
    params.maxExposureNotional = 5_000
  }
  return params
}
