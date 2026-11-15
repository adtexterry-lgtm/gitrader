// SPDX-License-Identifier: CPAL-1.0
// 报告渲染：首屏第一行的证据等级、三个强制指标的呈现、样本内横幅的逐字判定。
import { describe, expect, it } from 'vitest'
import { IN_SAMPLE_BANNER, optimize, type OptimizeRequest } from '../src/optimize'
import { renderReport, reportHeadline } from '../src/report'
import { bars, simOptions, smaCross } from './fixtures'

const smallSpace = {
  fast: { type: 'integer', min: 2, max: 8, step: 6 },
  slow: { type: 'integer', min: 10, max: 30, step: 20 },
  allowShort: { type: 'boolean' },
} as const

const base: OptimizeRequest = {
  strategy: smaCross,
  candles: bars(200),
  space: smallSpace,
  search: { kind: 'grid' },
  validation: { kind: 'walk-forward', trainBars: 100, testBars: 40, step: 40 },
  seed: 3,
  sim: simOptions,
}

describe('renderReport', () => {
  it('只有样本内结果时，第一行逐字是「样本内，不可作为前向证据」', () => {
    const result = optimize({ ...base, validation: { kind: 'walk-forward', trainBars: 180, testBars: 40 } })
    const report = renderReport(result)
    const firstLine = report.split('\n')[0]
    expect(firstLine).toBe('样本内，不可作为前向证据')
    expect(firstLine).toBe(IN_SAMPLE_BANNER)
    expect(reportHeadline(result)).toBe(IN_SAMPLE_BANNER)
    expect(report.indexOf(IN_SAMPLE_BANNER)).toBe(0)
  })

  it('有样本外证据时第一行说明证据种类与折数，不挂样本内横幅', () => {
    const result = optimize(base)
    const report = renderReport(result)
    expect(report.split('\n')[0]).toBe('样本外证据：walk-forward 2 折（样本外收益 78 期）')
    expect(report).not.toContain(IN_SAMPLE_BANNER)
  })

  it('留出期时第一行写留出根数', () => {
    const result = optimize({ ...base, validation: { kind: 'holdout', holdoutBars: 50 } })
    expect(renderReport(result).split('\n')[0]).toBe('样本外证据：留出期 50 根（未参与寻优）')
  })

  it('报告里三个强制指标都带数字，并记录种子与最优参数', () => {
    const result = optimize(base)
    const report = renderReport(result)
    expect(report).toContain('试验次数: 8')
    expect(report).toMatch(/PBO: \d\.\d{4}/)
    expect(report).toMatch(/DSR: \d\.\d{4}/)
    expect(report).toContain('种子 0') // 网格不用随机数
    expect(result.best).not.toBeNull()
    const params = Object.keys(result.best!.params).sort()
    expect(report).toContain('- 寻优区间: [0, 200)（留出期与盲段不参与寻优、PBO、DSR）')
    expect(report).toContain(`样本内最优参数: ${params.map((key) => `${key}=${String(result.best!.params[key])}`).join(', ')}`)
    expect(report).toContain('## 样本外验证')
    expect(report).toContain('样本外分数:')
  })

  it('PBO 不可算时写「不适用」并把原因放进指标缺口，不写 0', () => {
    const result = optimize({ ...base, space: { fast: { type: 'integer', min: 2, max: 2 } } })
    expect(result.trialCount).toBe(1)
    const report = renderReport(result)
    expect(report).toContain('PBO: 不适用')
    expect(report).toContain('DSR: 不适用')
    expect(report).toContain('指标缺口:')
    expect(report).toContain('至少 2 个试验')
  })

  it('样本内结果仍然把样本内分数写清楚，但排在横幅之后', () => {
    const result = optimize({ ...base, validation: { kind: 'walk-forward', trainBars: 180, testBars: 40 } })
    const report = renderReport(result)
    const bannerAt = report.indexOf(IN_SAMPLE_BANNER)
    const scoreAt = report.indexOf('最优样本内分数')
    expect(bannerAt).toBe(0)
    expect(scoreAt).toBeGreaterThan(bannerAt)
  })
})
