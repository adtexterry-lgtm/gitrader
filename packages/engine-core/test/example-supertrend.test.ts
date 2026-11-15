// SPDX-License-Identifier: CPAL-1.0
// 教学示例 supertrend：先过真实加载器校验，再用合成 K 线手算核对通道、目标仓位与理由。
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { loadStrategyFile } from '../src/strategy/loader'
import { EXAMPLE_STRATEGIES } from './harness'
import type { SignalSeries, StrategyDef } from '../src/strategy'
import type { Candle } from '../src/types'

const file = join(EXAMPLE_STRATEGIES, 'supertrend.ts')
const loaded = loadStrategyFile(file)

const defaults = { period: 10, multiplier: 3, allowShort: true }
/** 实体为 0、上下各留 1 的合成 K 线：每根 TR = 2，ATR = 2，通道半宽 = multiplier * 2。 */
const mk = (closes: number[]): Candle[] => closes.map((c, i) => ({ t: i * 3_600_000, o: c, c, h: c + 1, l: c - 1, v: 1 }))
const upCloses = Array.from({ length: 60 }, (_, i) => 100 + i)
const downCloses = Array.from({ length: 60 }, (_, i) => 200 - i)

let def: StrategyDef
beforeAll(async () => {
  const r = await loaded
  if (!r.def) throw new Error('supertrend example did not load')
  def = r.def
})

const run = (candles: Candle[], params: Record<string, number | boolean | string> = defaults): SignalSeries => def.evaluate(candles, params)

/** 首根有效 K 线 from 之后到 to 为止，target 发生变化的 index。 */
function changes(target: number[], from: number, to: number): number[] {
  const out: number[] = []
  for (let i = from + 1; i <= to; i++) if (target[i] !== target[i - 1]) out.push(i)
  return out
}

describe('supertrend 教学示例', () => {
  it('通过校验器，名称 / 默认参数符合策略定义', async () => {
    const r = await loaded
    expect(r.errors).toEqual([])
    expect(r.def?.name).toMatch(/teaching example/)
    expect(r.def?.defaults).toEqual({ period: 10, multiplier: 3, allowShort: true })
  })

  it('A：单边上涨，冷却期内为 0，首根有效 K 线向下，随后上破上轨翻多', () => {
    const s = run(mk(upCloses))
    expect(s.warmup).toBe(9)
    expect(s.overlays.上轨![8]).toBeNull()
    expect(s.overlays.上轨![9]).toBeCloseTo(115)
    expect(s.overlays.下轨![9]).toBeCloseTo(103)
    expect(s.target[8]).toBe(0)
    expect(s.target[9]).toBe(-1)
    expect(s.target[59]).toBe(1)
    const at = changes(s.target, 9, 59)
    expect(at).toHaveLength(1)
    expect(s.target[at[0]!]).toBe(1)
    expect(s.reasons[at[0]!]).toContain('上破')
    expect(s.reasons[9]).toContain('初始趋势')
  })

  it('B：单边下跌，首根有效 K 线即空头，之后不翻转，除首根外无理由', () => {
    const s = run(mk(downCloses))
    expect(s.target[9]).toBe(-1)
    expect(s.target[59]).toBe(-1)
    expect(changes(s.target, 9, 59)).toEqual([])
    expect(s.reasons[9]).toContain('初始趋势向下')
    expect(s.reasons.slice(10).every((x) => x === '')).toBe(true)
  })

  it('C：禁止做空时先用 0 代替空头，上破后翻多一次', () => {
    const s = run(mk(upCloses), { ...defaults, allowShort: false })
    expect(s.target[9]).toBe(0)
    expect(s.target[59]).toBe(1)
    const at = changes(s.target, 9, 59)
    expect(at).toHaveLength(1)
    expect(s.target[8]).toBe(0)
    expect(s.target[at[0]!]).toBe(1)
  })

  it('D：空序列与短序列返回全 0 且不抛错', () => {
    const empty = run([])
    expect(empty.target).toEqual([])
    expect(empty.warmup).toBe(9)
    const short = run(mk([100, 101, 102, 103, 104]))
    expect(short.target).toEqual([0, 0, 0, 0, 0])
    expect(short.reasons).toEqual(['', '', '', '', ''])
  })
})
