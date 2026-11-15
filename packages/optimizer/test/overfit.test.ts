// SPDX-License-Identifier: CPAL-1.0
// 过拟合指标：PBO 与 DSR 的精确数字（期望值来自独立 Python 实现，按论文定义重算），
// 以及「算不出来就 null + 原因」的强制字段约定。
import { describe, expect, it } from 'vitest'
import { describeOverfit, overfitReport } from '../src/overfit'
import { dsrBest, dsrOther, meanMetric, pboFlip, pboMixed, pboStable } from './fixtures'

describe('overfitReport · PBO', () => {
  it('两半段各一边倒 → PBO 恰为 1（块数 2，两个组合都翻车）', () => {
    const report = overfitReport([{ returns: pboFlip[0]! }, { returns: pboFlip[1]! }], 0, { blocks: 2, metric: meanMetric })
    expect(report.pbo).toBe(1)
    expect(report.pboBlocks).toBe(2)
    expect(report.pboCombos).toBe(2)
    expect(report.oosRankMean).toBeCloseTo(1 / 3, 12)
    expect(report.probLossOos).toBe(1)
    expect(report.trials).toBe(2)
    expect(report.periods).toBe(8)
  })

  it('一条试验全程压过另一条 → PBO 恰为 0', () => {
    const report = overfitReport([{ returns: pboStable[0]! }, { returns: pboStable[1]! }], 0, { blocks: 2, metric: meanMetric })
    expect(report.pbo).toBe(0)
    expect(report.oosRankMean).toBeCloseTo(2 / 3, 12)
    expect(report.probLossOos).toBe(0)
    expect(report.missing).toEqual([])
  })

  it('三条策略、4 块、按 Sharpe → PBO = 2/3，样本外平均排名 0.5', () => {
    const report = overfitReport(pboMixed.map((returns) => ({ returns })), 0, { blocks: 4 })
    expect(report.pbo).toBeCloseTo(2 / 3, 12)
    expect(report.pboCombos).toBe(6)
    expect(report.oosRankMean).toBeCloseTo(0.5, 12)
    expect(report.probLossOos).toBe(0)
  })

  it('块数缺省时自动降到不超过周期数的最大偶数块', () => {
    const report = overfitReport([{ returns: pboStable[0]! }, { returns: pboStable[1]! }], 0, { metric: meanMetric })
    expect(report.periods).toBe(8)
    expect(report.pboBlocks).toBe(8)
    expect(report.pbo).not.toBeNull()
  })
})

describe('overfitReport · DSR', () => {
  it('手算夹具的 DSR 精确值 = 0.9928316821273468（Sharpe √3、方差 0.375、n=4）', () => {
    const report = overfitReport([{ returns: dsrBest }, { returns: dsrOther }], 0)
    expect(report.trials).toBe(2)
    expect(report.bestSharpe).toBeCloseTo(Math.sqrt(3), 12)
    expect(report.trialVariance).toBeCloseTo(0.375, 12)
    expect(report.deflatedBenchmark).toBeCloseTo(0.31828384614301347, 12)
    expect(report.dsr).toBeCloseTo(0.9928316821273468, 10)
  })

  it('只换最优试验下标，DSR 的输入 Sharpe 随之改变（不是常量）', () => {
    const first = overfitReport([{ returns: dsrBest }, { returns: dsrOther }], 0)
    const second = overfitReport([{ returns: dsrBest }, { returns: dsrOther }], 1)
    expect(first.bestSharpe).not.toBeCloseTo(second.bestSharpe, 6)
    expect(first.dsr).not.toBe(second.dsr)
  })
})

describe('overfitReport · 强制字段与边界', () => {
  it('只有 1 个试验时仍返回试验次数，PBO / DSR 为 null 且写明原因', () => {
    const report = overfitReport([{ returns: dsrBest }], 0)
    expect(report.trials).toBe(1)
    expect(report.pbo).toBeNull()
    expect(report.dsr).toBeNull()
    expect(report.missing.length).toBe(2)
    expect(report.missing.join('')).toMatch(/PBO 需要至少 2 个试验/)
    expect(report.missing.join('')).toMatch(/DSR 需要至少 2 个试验/)
  })

  it('周期只有 1 期时 PBO 记 null 并说明周期不足', () => {
    const report = overfitReport([{ returns: [0.01] }, { returns: [0.02] }], 1)
    expect(report.trials).toBe(2)
    expect(report.periods).toBe(1)
    expect(report.pbo).toBeNull()
    expect(report.missing.join('')).toMatch(/至少 2 个收益周期/)
  })

  it('试验收益长度不一致或最优下标越界都抛 RangeError', () => {
    expect(() => overfitReport([{ returns: [0.1, 0.2] }, { returns: [0.1] }], 0)).toThrowError(/equal return length/)
    expect(() => overfitReport([{ returns: [0.1, 0.2] }], 3)).toThrowError(/bestIndex out of range/)
    expect(() => overfitReport([], 0)).toThrowError(/at least one trial/)
  })

  it('describeOverfit 把三个强制指标都写成可读行', () => {
    const text = describeOverfit(overfitReport([{ returns: pboFlip[0]! }, { returns: pboFlip[1]! }], 0, { blocks: 2, metric: meanMetric }))
    expect(text).toContain('试验次数: 2')
    expect(text).toContain('PBO: 1.0000')
    expect(text).toContain('DSR:')
    expect(text).toContain('CSCV 块数 2')
  })
})
