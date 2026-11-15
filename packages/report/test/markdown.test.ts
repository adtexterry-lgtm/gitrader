// SPDX-License-Identifier: CPAL-1.0
// Markdown 报告：指标表、免责声明、空结果、交易行数上限、参数 / 假设 / 证据 / 摘要。
import { describe, expect, it } from 'vitest'
import { findPromiseLanguage } from '../../protocol/src/plugin/manifest'
import { MAX_TRADE_ROWS, renderMarkdown } from '../src/markdown'
import { DISCLAIMER } from '../src/types'
import { buildBigFixture, buildEmptyFixture, buildFixture } from './fixture'

const fixture = renderMarkdown({ result: buildFixture(), generatedAt: Date.UTC(2024, 5, 1, 12, 0) })

describe('Markdown 结构', () => {
  it('有标题、指标表表头与免责声明', () => {
    expect(fixture.startsWith('# 回测报告')).toBe(true)
    expect(fixture).toContain('## 指标')
    expect(fixture).toContain('| 指标 | 数值 | 单位 | 口径 |')
    expect(fixture).toContain(DISCLAIMER)
  })

  it('指标表里出现盈利因子 1.50 / 单笔期望 2.50 / 持仓占比 50.00 / 卡玛 2.00', () => {
    expect(fixture).toMatch(/\| 盈利因子（总盈利 \/ 总亏损） \| 1\.50 \|/)
    expect(fixture).toMatch(/\| 单笔期望（平仓笔均值） \| 2\.50 \|/)
    expect(fixture).toMatch(/\| 持仓时间占比 \| 50\.00 \| % \|/)
    expect(fixture).toMatch(/\| 卡玛比率（年化收益 \/ 最大回撤） \| 2\.00 \|/)
    expect(fixture).toMatch(/\| 最大连续亏损笔数 \| 2 \| 笔 \|/)
  })

  it('章节顺序照 QD：摘要 → 数据质量 → 指标 → 曲线 → 风险 → 参数 → 交易明细 → 证据 → 方法', () => {
    const order = ['## 摘要', '## 数据质量与假设', '## 指标', '## 曲线与月度收益', '## 风险', '## 参数', '## 交易明细', '## 证据摘要', '## 方法']
    const positions = order.map((h) => fixture.indexOf(h))
    expect(positions.every((p) => p >= 0)).toBe(true)
    for (let i = 1; i < positions.length; i++) expect(positions[i]!).toBeGreaterThan(positions[i - 1]!)
  })

  it('参数表与假设表都在，数据摘要是 64 位 16 进制', () => {
    expect(fixture).toContain('| 参数 | 取值 |')
    expect(fixture).toMatch(/\| fast \| 12 \|/)
    expect(fixture).toContain('| 假设项 | 取值 |')
    expect(fixture).toContain('next-bar-open')
    const digest = /数据摘要 sha256：`([0-9a-f]{64})`/.exec(fixture)
    expect(digest).not.toBeNull()
  })

  it('交易明细最多 200 行，超出时写明总数', () => {
    const md = renderMarkdown({ result: buildBigFixture() })
    const rows = md.split('\n').filter((line) => line.startsWith('| ') && line.includes('signal-'))
    expect(rows.length).toBe(MAX_TRADE_ROWS)
    expect(md).toContain('共 500 笔成交')
  })

  it('空成交结果输出「无成交」而不是崩', () => {
    const md = renderMarkdown({ result: buildEmptyFixture() })
    expect(md).toContain('_无成交_')
    expect(md).toContain(DISCLAIMER)
  })

  it('给证据摘要时渲染 PSR / DSR / 区间', () => {
    const md = renderMarkdown({
      result: buildFixture(),
      evidence: {
        periods: 24,
        periodMs: 86_400_000,
        periodsPerYear: 365,
        sharpe: 0.12,
        sharpeAnnualized: 2.29,
        psr: 0.87,
        dsr: 0.42,
        skewness: -0.3,
        kurtosis: 4.1,
        sharpeCi95: [0.05, 0.2],
        trialCount: 3,
        warnings: [],
      },
    })
    expect(md).toContain('| PSR | 87.00% |')
    expect(md).toContain('| DSR | 42.00% |')
    expect(md).toContain('| 试验次数 | 3 |')
    expect(md).toContain('0.0500 … 0.2000')
  })

  it('零承诺语言：整份报告过 findPromiseLanguage（含标题与摘要）', () => {
    expect(findPromiseLanguage(fixture)).toBeNull()
    expect(findPromiseLanguage(renderMarkdown({ result: buildBigFixture(), title: '回测报告（大样本）' }))).toBeNull()
  })
})
