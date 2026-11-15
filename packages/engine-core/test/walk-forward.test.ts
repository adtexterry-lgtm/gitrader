// SPDX-License-Identifier: CPAL-1.0
// Walk-forward 用例：窗口生成、训练窗扫描到测试窗样本外、先涨后跌、选项非法、确定性。
import { describe, expect, it } from 'vitest'
import { runWalkForward, walkForwardWindows } from '../src/strategy/walk-forward'
import { gridCombinations } from '../src/strategy/sweep'
import type { SimOptions } from '../src/strategy/simulator'
import type { Candle } from '../src/types'
import type { StrategyDef } from '../src/strategy/types'

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

function fromCloses(closes: number[]): Candle[] {
  const out: Candle[] = []
  for (let i = 0; i < closes.length; i++) {
    const t = i * H
    const c = closes[i]!
    out.push({ t, o: c, h: c + 1, l: c - 1, c, v: 1 })
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

const grid = gridCombinations([{ key: 'sign', values: ['1', '-1'] }])

describe('walkForwardWindows', () => {
  it('step 缺省为 testBars', () => {
    expect(walkForwardWindows(100, 40, 20)).toEqual([
      { index: 0, train: [0, 40], test: [40, 60] },
      { index: 1, train: [20, 60], test: [60, 80] },
      { index: 2, train: [40, 80], test: [80, 100] },
    ])
  })

  it('给定 step 时窗口更密', () => {
    const windows = walkForwardWindows(100, 40, 20, 10)
    expect(windows).toHaveLength(5)
    expect(windows[windows.length - 1]!.test).toEqual([80, 100])
  })

  it('K 线不足时没有窗口', () => {
    expect(walkForwardWindows(50, 40, 20)).toEqual([])
  })
})

describe('runWalkForward', () => {
  it('单调上涨：三折都选做多，样本外拼接与效率比为正', () => {
    const res = runWalkForward(signStrategy, rising(100), grid, simOpts, { trainBars: 40, testBars: 20 })
    expect(res.folds).toHaveLength(3)
    for (const fold of res.folds) {
      expect(fold.bestParams.sign).toBe('1')
      expect(fold.trainSharpe).toBeGreaterThan(0)
      expect(fold.testSharpe).toBeGreaterThan(0)
      expect(fold.testReturns).toHaveLength(19)
    }
    expect(res.oosReturns).toHaveLength(57)
    expect(res.oosSharpe).toBeGreaterThan(0)
    expect(res.efficiency).not.toBeNull()
    expect(res.efficiency as number).toBeGreaterThan(0)
    expect(res.warnings).toEqual([])
  })

  it('先涨后跌：折内最优方向随训练窗切换，样本外交替', () => {
    const closes: number[] = []
    for (let i = 0; i < 60; i++) closes.push(100 + i)
    for (let i = 60; i < 120; i++) closes.push(160 - (i - 59))
    const res = runWalkForward(signStrategy, fromCloses(closes), grid, simOpts, { trainBars: 40, testBars: 20 })

    const first = res.folds[0]!
    expect(first.bestParams.sign).toBe('1')
    expect(first.testSharpe).toBeGreaterThan(0)

    const last = res.folds[res.folds.length - 1]!
    expect(last.window.train).toEqual([60, 100])
    expect(last.window.test).toEqual([100, 120])
    expect(last.bestParams.sign).toBe('-1')
    expect(last.testSharpe).toBeGreaterThan(0)

    expect(res.folds.some((f) => f.testSharpe < 0)).toBe(true)
  })

  it('选项非法与 K 线不足', () => {
    const invalid = runWalkForward(signStrategy, rising(100), grid, simOpts, { trainBars: 1, testBars: 20 })
    expect(invalid.folds).toEqual([])
    expect(invalid.warnings).toEqual(['invalid walk-forward options'])

    const short = runWalkForward(signStrategy, rising(50), grid, simOpts, { trainBars: 40, testBars: 20 })
    expect(short.folds).toEqual([])
    expect(short.warnings).toEqual(['not enough candles for one window'])
  })

  it('同参数两次结果相同', () => {
    const a = runWalkForward(signStrategy, rising(100), grid, simOpts, { trainBars: 40, testBars: 20 })
    const b = runWalkForward(signStrategy, rising(100), grid, simOpts, { trainBars: 40, testBars: 20 })
    expect(a).toEqual(b)
  })
})

describe('walkForwardWindows embargo / blindHoldout', () => {
  it('embargo 空在训练窗与测试窗之间', () => {
    const windows = walkForwardWindows(100, 40, 20, 20, { embargoBars: 5 })
    expect(windows).toEqual([
      { index: 0, train: [0, 40], test: [45, 65], embargo: 5 },
      { index: 1, train: [20, 60], test: [65, 85], embargo: 5 },
    ])
    expect(windows).toHaveLength(2)
    for (const w of windows) expect(w.embargo).toBe(5)
  })

  it('盲留出段之外的窗口', () => {
    const windows = walkForwardWindows(100, 40, 20, 20, { blindHoldoutBars: 20 })
    expect(windows).toEqual([
      { index: 0, train: [0, 40], test: [40, 60] },
      { index: 1, train: [20, 60], test: [60, 80] },
    ])
  })

  it('embargo 与盲留出段同时生效', () => {
    const windows = walkForwardWindows(100, 40, 20, 20, { embargoBars: 5, blindHoldoutBars: 15 })
    expect(windows).toHaveLength(2)
    expect(windows[0]!.test).toEqual([45, 65])
    expect(windows[1]!.test).toEqual([65, 85])
  })
})

describe('runWalkForward embargo / blindHoldout', () => {
  it('结果带 holdout 与 embargoBars', () => {
    const res = runWalkForward(signStrategy, rising(100), grid, simOpts, {
      trainBars: 40,
      testBars: 20,
      embargoBars: 5,
      blindHoldoutBars: 15,
    })
    expect(res.folds).toHaveLength(2)
    expect(res.holdout).toEqual([85, 100])
    expect(res.embargoBars).toBe(5)
    expect(res.oosReturns).toHaveLength(38)

    const plain = runWalkForward(signStrategy, rising(100), grid, simOpts, { trainBars: 40, testBars: 20 })
    expect(plain.holdout).toBeNull()
    expect(plain.embargoBars).toBe(0)
    expect(plain.folds).toHaveLength(3)
    expect(plain.oosReturns).toHaveLength(57)
  })

  it('选项非法时无折', () => {
    const badEmbargo = runWalkForward(signStrategy, rising(100), grid, simOpts, {
      trainBars: 40,
      testBars: 20,
      embargoBars: -1,
    })
    expect(badEmbargo.folds).toEqual([])
    expect(badEmbargo.warnings).toEqual(['invalid walk-forward options'])

    const badBlind = runWalkForward(signStrategy, rising(100), grid, simOpts, {
      trainBars: 40,
      testBars: 20,
      blindHoldoutBars: 100,
    })
    expect(badBlind.folds).toEqual([])
    expect(badBlind.warnings).toEqual(['invalid walk-forward options'])
  })
})
