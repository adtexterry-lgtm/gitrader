// SPDX-License-Identifier: CPAL-1.0
// 教学示例 trend-atr：先过真实加载器校验，再用合成 K 线手算核对趋势过滤、ATR 移动止损与理由。
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { loadStrategyFile } from '../src/strategy/loader'
import { EXAMPLE_STRATEGIES } from './harness'
import type { SignalSeries, StrategyDef } from '../src/strategy'
import type { Candle } from '../src/types'

const file = join(EXAMPLE_STRATEGIES, 'trend-atr.ts')
const loaded = loadStrategyFile(file)

const defaults = { emaFast: 20, emaSlow: 50, atrPeriod: 14, atrMultiple: 3, allowShort: true }
/** 实体为 0、上下各留 1 的合成 K 线：每根 TR = 2，ATR = 2，止损距离 = atrMultiple × 2。 */
const mk = (closes: number[]): Candle[] => closes.map((c, i) => ({ t: i * 3_600_000, o: c, c, h: c + 1, l: c - 1, v: 1 }))
/** 用例 A / B：先 30 根单边上涨，第 31 根跌到 120，之后 10 根横在 120。 */
const trendThenDrop = [...Array.from({ length: 30 }, (_, i) => 100 + i), 120, ...new Array<number>(10).fill(120)]

let def: StrategyDef
beforeAll(async () => {
  const r = await loaded
  if (!r.def) throw new Error('trend-atr example did not load')
  def = r.def
})

const run = (candles: Candle[], params: Record<string, number | boolean | string> = defaults): SignalSeries => def.evaluate(candles, params)

describe('trend-atr 教学示例', () => {
  it('通过校验器，名称 / 默认参数符合策略定义', async () => {
    const r = await loaded
    expect(r.errors).toEqual([])
    expect(r.def?.name).toMatch(/teaching example/)
    expect(r.def?.defaults).toEqual({ emaFast: 20, emaSlow: 50, atrPeriod: 14, atrMultiple: 3, allowShort: true })
  })

  it('A：上涨进多，止损上移，跌回止损线平多，翻转后进空并一路持有', () => {
    const s = run(mk(trendThenDrop), { emaFast: 2, emaSlow: 5, atrPeriod: 3, atrMultiple: 3, allowShort: true })
    expect(s.warmup).toBe(5)
    expect(s.target[4]).toBe(0)
    expect(s.target[5]).toBe(1)
    expect(s.overlays.止损线![10]).toBeCloseTo(104)
    expect(s.target[29]).toBe(1)
    expect(s.target[30]).toBe(0)
    expect(s.reasons[30]).toContain('平多')
    expect(s.target[31]).toBe(-1)
    expect(s.reasons[31]).toContain('进空')
    expect(s.target[40]).toBe(-1)
  })

  it('B：禁止做空时，翻转后仍空仓', () => {
    const s = run(mk(trendThenDrop), { emaFast: 2, emaSlow: 5, atrPeriod: 3, atrMultiple: 3, allowShort: false })
    expect(s.target[31]).toBe(0)
    expect(s.target[40]).toBe(0)
  })

  it('C：止损出场后趋势没翻转，不再立刻重进', () => {
    const closes = [...Array.from({ length: 20 }, (_, i) => 100 + i), 112, 113, 114, 115, 116, 117]
    const s = run(mk(closes), { emaFast: 5, emaSlow: 10, atrPeriod: 3, atrMultiple: 3, allowShort: false })
    expect(s.warmup).toBe(10)
    expect(s.target[10]).toBe(1)
    expect(s.target[19]).toBe(1)
    expect(s.target[20]).toBe(0)
    expect(s.reasons[20]).toContain('平多')
    expect(s.target.slice(21, 26)).toEqual([0, 0, 0, 0, 0])
  })

  it('D：空序列与短序列返回全 0 且不抛错', () => {
    const empty = run([], defaults)
    expect(empty.target).toEqual([])
    expect(empty.warmup).toBe(50)
    const short = run(mk(new Array<number>(5).fill(100)), defaults)
    expect(short.target).toEqual([0, 0, 0, 0, 0])
    expect(short.reasons).toEqual(['', '', '', '', ''])
  })
})
