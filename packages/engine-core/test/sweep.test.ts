// SPDX-License-Identifier: CPAL-1.0
// 参数扫描：轴生成、笛卡尔积、逐试验统计、CSCV 过拟合概率与去膨胀 Sharpe 的用例。
import { describe, expect, it } from 'vitest'
import { axesFromParams, countCombinations, gridCombinations, runSweep, sampleGrid } from '../src/strategy/sweep'
import { runSweep as runSweepFromStrategy } from '../src/strategy'
import { Simulator, inferIntervalMs, type SimOptions } from '../src/strategy/simulator'
import type { Candle } from '../src/types'
import type { ParamDef, StrategyDef } from '../src/strategy/types'

const H = 3_600_000

function rising(n: number): Candle[] {
  const out: Candle[] = []
  for (let i = 0; i < n; i++) {
    const t = i * H
    const o = 100 + i
    out.push({ t, o, h: o + 1, l: o - 1, c: o + 0.5, v: 1 })
  }
  return out
}

const signStrategy: StrategyDef = {
  id: 'sign',
  name: 'sign',
  version: '1',
  desc: '',
  tags: [],
  params: [{ key: 'sign', label: 'sign', type: 'select', default: '1', options: ['1', '-1'] }],
  defaults: { sign: '1' },
  evaluate(candles, params) {
    const v = Number(params.sign)
    return { target: candles.map(() => v), reasons: candles.map(() => ''), overlays: {}, warmup: 0 }
  },
}

const simOpts: SimOptions = { initialCash: 1000, leverage: 1, feeRate: 0, slippageBps: 0 }

describe('axesFromParams', () => {
  const defs: ParamDef[] = [
    { key: 'n', label: 'n', type: 'integer', default: 2, min: 1, max: 3, step: 1 },
    { key: 'flag', label: 'f', type: 'boolean', default: false },
    { key: 'mode', label: 'm', type: 'select', default: 'a', options: ['a', 'b'] },
    { key: 'x', label: 'x', type: 'number', default: 0.5 },
    { key: 'h', label: 'h', type: 'number', default: 1, min: 0, max: 1, step: 0.5, hidden: true },
  ]

  it('默认取非 hidden 定义，按 keys 时按 keys 顺序', () => {
    expect(axesFromParams(defs)).toEqual([
      { key: 'n', values: [1, 2, 3] },
      { key: 'flag', values: [false, true] },
      { key: 'mode', values: ['a', 'b'] },
      { key: 'x', values: [0.5] },
    ])
    expect(axesFromParams(defs, { keys: ['mode', 'n'] })).toEqual([
      { key: 'mode', values: ['a', 'b'] },
      { key: 'n', values: [1, 2, 3] },
    ])
  })

  it('超过 maxPoints 时等距抽样', () => {
    const axes = axesFromParams(
      [{ key: 'p', label: 'p', type: 'number', default: 0, min: 0, max: 1, step: 0.1 }],
      { maxPoints: 3 },
    )
    expect(axes).toHaveLength(1)
    const values = axes[0]!.values
    expect(values).toHaveLength(3)
    expect(values[0] as number).toBeCloseTo(0, 9)
    expect(values[1] as number).toBeCloseTo(0.5, 9)
    expect(values[2] as number).toBeCloseTo(1, 9)
  })
})

describe('gridCombinations', () => {
  const axes = [{ key: 'a', values: [1, 2] }, { key: 'b', values: ['x', 'y', 'z'] }]

  it('第一轴变化最慢', () => {
    expect(gridCombinations(axes)).toEqual([
      { a: 1, b: 'x' },
      { a: 1, b: 'y' },
      { a: 1, b: 'z' },
      { a: 2, b: 'x' },
      { a: 2, b: 'y' },
      { a: 2, b: 'z' },
    ])
  })

  it('超过 maxTrials 抛 RangeError；空轴返回空参数', () => {
    expect(() => gridCombinations(axes, 5)).toThrow(RangeError)
    expect(gridCombinations([])).toEqual([{}])
  })
})

describe('runSweep', () => {
  const grid = gridCombinations([{ key: 'sign', values: ['1', '-1'] }])

  it('两组试验的统计、best、dsr、pbo 与确定性', () => {
    const res = runSweep(signStrategy, rising(40), grid, simOpts, { pboBlocks: 4 })
    expect(res.trials).toHaveLength(2)
    expect(res.trials[0]!.params.sign).toBe('1')
    expect(res.trials[1]!.params.sign).toBe('-1')
    for (const trial of res.trials) expect(trial.returns).toHaveLength(39)
    expect(res.trials[0]!.sharpe).toBeGreaterThan(0)
    expect(res.trials[1]!.sharpe).toBeLessThan(0)
    expect(res.trials[0]!.stats.finalEquity).toBeGreaterThan(1000)
    expect(res.trials[1]!.stats.finalEquity).toBeLessThan(1000)
    expect(res.best).toEqual({
      index: 0,
      params: res.trials[0]!.params,
      sharpe: res.trials[0]!.sharpe,
    })
    expect(res.trialVariance).toBeGreaterThan(0)
    expect(res.dsr).not.toBeNull()
    expect(res.dsr as number).toBeGreaterThanOrEqual(0)
    expect(res.dsr as number).toBeLessThanOrEqual(1)
    expect(res.pbo).not.toBeNull()
    expect(res.pbo!.combos).toBe(6)
    expect(res.pbo!.pbo).toBe(0)
    expect(res.warnings).toEqual([])
    expect(runSweep(signStrategy, rising(40), grid, simOpts, { pboBlocks: 4 })).toEqual(res)
  })

  it('期数不足 blocks 时 pbo 为 null 并给 warning，dsr 仍算', () => {
    const res = runSweep(signStrategy, rising(40), grid, simOpts, { pboBlocks: 40 })
    expect(res.pbo).toBeNull()
    expect(res.warnings.some((w) => w.startsWith('pbo skipped'))).toBe(true)
    expect(res.dsr).not.toBeNull()
  })

  it('anchor 固定参数后各试验 Sharpe 相等', () => {
    const anchored: StrategyDef = {
      ...signStrategy,
      anchor(_c, p) {
        return { ...p, sign: '1' }
      },
    }
    const res = runSweep(anchored, rising(40), grid, simOpts, { pboBlocks: 4 })
    expect(res.trials[0]!.sharpe).toBe(res.trials[1]!.sharpe)
    expect(res.best!.index).toBe(0)
    expect(res.trialVariance).toBe(0)
  })

  it('K 线少于 2 根时直接返回', () => {
    const res = runSweep(signStrategy, rising(1), [{ sign: '1' }], simOpts)
    expect(res.trials).toEqual([])
    expect(res.best).toBeNull()
    expect(res.warnings).toEqual(['too few candles'])
  })

  it('与单次回测驱动模拟器结果一致', () => {
    const candles = rising(30)
    const swept = runSweep(signStrategy, candles, [{ sign: '1' }], simOpts).trials[0]!.stats
    const series = signStrategy.evaluate(candles, { sign: '1' })
    const s = new Simulator(simOpts)
    for (let k = 0; k < candles.length; k++) {
      const hasSignal = k > 0 && k - 1 >= series.warmup
      s.onBar(k, candles[k]!, hasSignal ? series.target[k - 1]! : null, hasSignal ? series.reasons[k - 1] || '' : '')
    }
    expect(swept).toEqual(s.stats(candles, inferIntervalMs(candles)))
  })

  it('strategy/index 导出的 runSweep 与直接导入是同一函数', () => {
    expect(runSweepFromStrategy).toBe(runSweep)
  })
})

describe('countCombinations', () => {
  it('各轴取值数相乘；空轴为 1', () => {
    expect(countCombinations([{ key: 'a', values: [1, 2] }, { key: 'b', values: ['x', 'y', 'z'] }])).toBe(6)
    expect(countCombinations([])).toBe(1)
  })
})

describe('sampleGrid', () => {
  const ten = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]
  const threeAxes = [
    { key: 'a', values: ten },
    { key: 'b', values: ten },
    { key: 'c', values: ten },
  ]

  it('超过 maxTrials 时蓄水池抽样，index 互异且解码正确、同 seed 可复现', () => {
    const picked = sampleGrid(threeAxes, { maxTrials: 50, seed: 1 })
    expect(picked).toHaveLength(50)
    const seen = new Set<number>()
    const grid = gridCombinations(threeAxes, 1000)
    for (const item of picked) {
      expect(item.index).toBeGreaterThanOrEqual(0)
      expect(item.index).toBeLessThan(1000)
      expect(seen.has(item.index)).toBe(false)
      seen.add(item.index)
      expect(item.params).toEqual(grid[item.index])
    }
    expect(sampleGrid(threeAxes, { maxTrials: 50, seed: 1 })).toEqual(picked)
    expect(sampleGrid(threeAxes, { maxTrials: 50, seed: 2 })).not.toEqual(picked)
  })

  it('约束过滤：全部满足约束，总数 ≤ maxTrials 时返回全部且按 index 升序', () => {
    const picked = sampleGrid(threeAxes, {
      maxTrials: 1000,
      constraints: (p) => (p.a as number) < (p.b as number),
    })
    expect(picked).toHaveLength(450)
    for (const item of picked) expect(item.params.a as number).toBeLessThan(item.params.b as number)
    for (let i = 1; i < picked.length; i++) expect(picked[i]!.index).toBeGreaterThan(picked[i - 1]!.index)
  })

  it('总数 ≤ maxTrials 时按字典序返回全部', () => {
    const axes = [{ key: 'a', values: [1, 2] }, { key: 'b', values: ['x', 'y', 'z'] }]
    const picked = sampleGrid(axes, { maxTrials: 10 })
    expect(picked.map((item) => item.params)).toEqual(gridCombinations(axes))
    expect(picked.map((item) => item.index)).toEqual([0, 1, 2, 3, 4, 5])
  })

  it('maxTrials ≤ 0 抛 RangeError', () => {
    expect(() => sampleGrid(threeAxes, { maxTrials: 0 })).toThrow(RangeError)
    expect(() => sampleGrid(threeAxes, { maxTrials: -3 })).toThrow(RangeError)
  })
})
