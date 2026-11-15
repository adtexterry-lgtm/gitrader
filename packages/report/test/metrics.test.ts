// SPDX-License-Identifier: CPAL-1.0
// 指标口径测试：每条断言旁边写算式。夹具是 12 笔成交 / 25 个权益点（见 fixture.ts 注释）。
import { describe, expect, it } from 'vitest'
import { runBacktest, type Candle, type StrategyDef } from '@gitrader/engine-core'
import { computeInformationRatio, computeReportMetrics, scanClosedFills, maxStreaks } from '../src/metrics'
import { metricOf } from '../src/types'
import type { ReportInput } from '../src/types'
import { buildEmptyFixture, buildFixture, fixtureEquity, fixtureTrades } from './fixture'

function metricsOf(input: ReportInput) {
  return computeReportMetrics(input)
}

describe('利润 / 期望类的口径', () => {
  it('盈利因子 = 总盈利 / |总亏损| = (20+4+6) / (5+25) = 45/30 = 1.5', () => {
    const row = metricOf(metricsOf({ result: buildFixture() }), 'profit_factor')
    expect(row?.raw).toBeCloseTo(1.5, 12)
    expect(row?.value).toBe('1.50')
  })

  it('单笔期望 = 平仓 pnl 均值 = (20-5-25+4+6+15)/6 = 15/6 = 2.5', () => {
    const row = metricOf(metricsOf({ result: buildFixture() }), 'expectancy')
    expect(row?.raw).toBeCloseTo(2.5, 12)
    expect(row?.value).toBe('2.50')
  })

  it('平均盈利 = 45/4 = 11.25（4 笔盈利）；平均亏损 = -30/2 = -15；盈亏额比 = 11.25/15 = 0.75', () => {
    const m = metricsOf({ result: buildFixture() })
    expect(metricOf(m, 'avg_win')?.raw).toBeCloseTo(11.25, 12)
    expect(metricOf(m, 'avg_loss')?.raw).toBeCloseTo(-15, 12)
    expect(metricOf(m, 'profit_loss_ratio')?.raw).toBeCloseTo(0.75, 12)
  })

  it('最大连续亏损 = 2（-5, -25）；最大连续盈利 = 3（4, 6, 15）', () => {
    const m = metricsOf({ result: buildFixture() })
    expect(metricOf(m, 'max_consecutive_losses')?.raw).toBe(2)
    expect(metricOf(m, 'max_consecutive_wins')?.raw).toBe(3)
  })

  it('胜率 = 4 胜 / (4 胜 + 2 负) = 0.6667 → 66.67%', () => {
    const row = metricOf(metricsOf({ result: buildFixture() }), 'win_rate')
    expect(row?.raw).toBeCloseTo(4 / 6, 12)
    expect(row?.value).toBe('66.67')
    expect(row?.unit).toBe('%')
  })

  it('平仓笔数 6、成交笔数 12（开仓 6 + 平仓 6）', () => {
    const m = metricsOf({ result: buildFixture() })
    expect(m.closedTrades).toBe(6)
    expect(metricOf(m, 'closed_trades')?.raw).toBe(6)
    expect(metricOf(m, 'total_trades')?.raw).toBe(12)
  })

  it('手续费 = 6 笔平仓 × 0.5 = 3；资金费取统计块 0.25', () => {
    const m = metricsOf({ result: buildFixture() })
    expect(metricOf(m, 'total_commission')?.raw).toBeCloseTo(3, 12)
    expect(metricOf(m, 'funding_paid')?.raw).toBeCloseTo(0.25, 12)
  })
})

describe('持仓 / 换手 / 卡玛', () => {
  it('持仓时间占比 = 6 段 × 2 天 / 24 天跨度 = 12/24 = 0.5', () => {
    const m = metricsOf({ result: buildFixture() })
    const row = metricOf(m, 'exposure')
    expect(row?.raw).toBeCloseTo(0.5, 12)
    expect(row?.value).toBe('50.00')
  })

  it('成交额 = 开仓 100×1+100×1+100×5+100×2+100×4+100×1 = 1400，平仓 120.5+95.5+475.5+204.5+406.5+115.5 = 1418，合计 2818', () => {
    const m = metricsOf({ result: buildFixture() })
    expect(metricOf(m, 'turnover')?.raw).toBeCloseTo(2818, 6)
    expect(metricOf(m, 'turnover')?.value).toBe('2,818.00')
  })

  it('换手率 = 2818 / 起算权益 100 = 28.18', () => {
    const row = metricOf(metricsOf({ result: buildFixture() }), 'turnover_ratio')
    expect(row?.raw).toBeCloseTo(28.18, 9)
    expect(row?.value).toBe('28.18')
  })

  it('卡玛 = 年化收益 0.5 / 最大回撤 0.25 = 2（回撤是统计块口径，报告不复算）', () => {
    const row = metricOf(metricsOf({ result: buildFixture() }), 'calmar_ratio')
    expect(row?.raw).toBeCloseTo(2, 12)
    expect(row?.value).toBe('2.00')
  })

  it('最大回撤 / 总收益 / 夏普 / 索提诺 直接取统计块（不重算）', () => {
    const m = metricsOf({ result: buildFixture() })
    expect(metricOf(m, 'max_drawdown')?.raw).toBeCloseTo(0.25, 12)
    expect(metricOf(m, 'total_return')?.raw).toBeCloseTo(0.15, 12)
    expect(metricOf(m, 'sharpe_ratio')?.raw).toBeCloseTo(1.5, 12)
    expect(metricOf(m, 'sortino_ratio')?.raw).toBeCloseTo(2, 12)
    expect(metricOf(m, 'final_equity')?.raw).toBeCloseTo(115, 12)
    expect(metricOf(m, 'max_drawdown')?.source).toBe('stats')
    expect(metricOf(m, 'profit_factor')?.source).toBe('computed')
  })
})

describe('月度分桶', () => {
  it('单月曲线：2024-01 收益 = 115/100 - 1 = 0.15', () => {
    const m = metricsOf({ result: buildFixture() })
    expect(m.monthly).toHaveLength(1)
    expect(m.monthly[0]?.key).toBe('2024-01')
    expect(m.monthly[0]?.year).toBe(2024)
    expect(m.monthly[0]?.month).toBe(1)
    expect(m.monthly[0]?.ret).toBeCloseTo(0.15, 12)
    expect(m.monthly[0]?.points).toBe(25)
  })

  it('跨月曲线按「月末权益环比」分桶：110→99 = -10%，99→108 = +9.09%', () => {
    const result = buildFixture()
    result.equity = [
      { t: Date.UTC(2023, 10, 1), v: 100 },
      { t: Date.UTC(2023, 10, 30), v: 110 },
      { t: Date.UTC(2023, 11, 31), v: 99 },
      { t: Date.UTC(2024, 0, 31), v: 108 },
    ]
    const m = metricsOf({ result })
    expect(m.monthly.map((x) => x.key)).toEqual(['2023-11', '2023-12', '2024-01'])
    expect(m.monthly[0]?.ret).toBeCloseTo(0.1, 12)
    expect(m.monthly[1]?.ret).toBeCloseTo(99 / 110 - 1, 12)
    expect(m.monthly[2]?.ret).toBeCloseTo(108 / 99 - 1, 12)
  })
})

describe('信息比率（有基准时）', () => {
  it('基准恒为 10000 时主动收益 = 权益收益，IR = mean/std × sqrt(365)', () => {
    const equity = fixtureEquity(fixtureTrades())
    const benchmark = equity.map((p) => ({ t: p.t, v: 10_000 }))
    const block = computeInformationRatio(equity, benchmark)
    // 独立算一遍：每期 r = v_i/v_{i-1} - 1，样本标准差（ddof 1）。
    const rets: number[] = []
    for (let i = 1; i < equity.length; i++) rets.push(equity[i]!.v / equity[i - 1]!.v - 1)
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length
    const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1))
    expect(block).not.toBeNull()
    expect(block!.observations).toBe(24)
    expect(block!.annualizationFactor).toBeCloseTo(365, 9)
    expect(block!.ir).toBeCloseTo((mean / sd) * Math.sqrt(365), 9)
    expect(block!.activeReturnAnnualized).toBeCloseTo(mean * 365, 9)
    expect(block!.trackingErrorAnnualized).toBeCloseTo(sd * Math.sqrt(365), 9)
    expect(['weak', 'acceptable', 'good', 'exceptional']).toContain(block!.classification)
  })

  it('基准与权益同涨同跌（收益完全相同时）跟踪误差为 0 → 信息比率不可算但不出 NaN', () => {
    const equity = fixtureEquity(fixtureTrades())
    const block = computeInformationRatio(equity, equity.map((p) => ({ t: p.t, v: p.v })))
    expect(block).not.toBeNull()
    expect(block!.ir).toBeNull()
    expect(block!.trackingErrorAnnualized).toBeCloseTo(0, 12)
    expect(block!.classification).toBe('insufficient_history')
  })

  it('没给基准时不出现 information_ratio 行，并记一条告警', () => {
    const m = metricsOf({ result: buildFixture() })
    expect(metricOf(m, 'information_ratio')).toBeUndefined()
    expect(m.warnings.join(' ')).toContain('信息比率未计算')
  })

  it('给了基准时出现 information_ratio 行', () => {
    const result = buildFixture()
    const m = metricsOf({ result, benchmark: result.equity.map((p) => ({ t: p.t, v: 10000 })) })
    expect(metricOf(m, 'information_ratio')).toBeDefined()
  })
})

describe('边界：没有成交、仓位重建', () => {
  it('空成交结果不崩：平仓 0、胜率不可算、盈利因子 0、给出告警', () => {
    const m = metricsOf({ result: buildEmptyFixture() })
    expect(m.closedTrades).toBe(0)
    expect(metricOf(m, 'win_rate')?.raw).toBeNull()
    expect(metricOf(m, 'win_rate')?.value).toBe('—')
    expect(metricOf(m, 'profit_factor')?.raw).toBe(0)
    expect(m.warnings.join(' ')).toContain('没有平仓成交')
  })

  it('平盘曲线（收益序列全 0）：PSR / DSR 为 null，显示「—」', () => {
    const result = buildEmptyFixture()
    result.trialCount = 5 // 多试验才会算 DSR
    const m = metricsOf({ result })
    expect(metricOf(m, 'psr')?.raw).toBeNull()
    expect(metricOf(m, 'psr')?.value).toBe('—')
    expect(metricOf(m, 'dsr')?.raw).toBeNull()
    expect(metricOf(m, 'dsr')?.value).toBe('—')
  })

  it('仓位重建：反手成交同时算一次平仓，且新仓从反手价重新计时', () => {
    const trades = [
      { t: 0, side: 'buy' as const, price: 100, size: 2, pnl: 0, fee: 0, reason: '' },
      { t: 10, side: 'sell' as const, price: 110, size: 4, pnl: 20, fee: 0, reason: '' },
      { t: 20, side: 'buy' as const, price: 100, size: 4, pnl: 40, fee: 0, reason: '' },
    ]
    const scan = scanClosedFills(trades, 20)
    expect(scan.closed).toHaveLength(2)
    expect(scan.endOpen).toBe(true)
    // 多仓 0→10（10 个单位时间）+ 空仓 10→20（10） = 20；反手 3 次换仓 → 3 段
    expect(scan.holdMs).toBe(20)
    expect(scan.intervals).toBe(3)
  })

  it('最大连续盈亏笔数：0 盈亏的笔不打断两边（QD 只在盈亏方向相反时清零）', () => {
    // 序列 [1, -2, -3, 4, 0, -5, -6, -7]：连赢 1，连亏 2；0 不打断，之后连亏 3。
    expect(maxStreaks([1, -2, -3, 4, 0, -5, -6, -7])).toEqual({ maxWins: 1, maxLosses: 3 })
    // 序列 [1, 2, 0, 3]：0 不清零连赢 → 连赢 3（若打断只能算 2）。
    expect(maxStreaks([1, 2, 0, 3])).toEqual({ maxWins: 3, maxLosses: 0 })
    // 序列 [1, -2, 0, -3, -4]：0 不清零连亏 → 连亏 3（若打断只能算 2）。
    expect(maxStreaks([1, -2, 0, -3, -4])).toEqual({ maxWins: 1, maxLosses: 3 })
    expect(maxStreaks([])).toEqual({ maxWins: 0, maxLosses: 0 })
  })

  it('指标 key 唯一且都是 snake_case，行里 source 只有 stats / computed', () => {
    const m = metricsOf({ result: buildFixture() })
    const keys = m.rows.map((r) => r.key)
    expect(new Set(keys).size).toBe(keys.length)
    for (const key of keys) expect(key).toMatch(/^[a-z][a-z0-9_]*$/)
    for (const row of m.rows) expect(['stats', 'computed']).toContain(row.source)
    expect(keys).toContain('calmar_ratio')
    expect(keys).toContain('exposure')
    expect(keys).toContain('turnover')
  })
})

describe('与 engine-core 的类型兼容', () => {
  it('runBacktest 的返回值能直接作为 ReportInput.result（编译期结构兼容）', () => {
    const accepts = (r: ReturnType<typeof runBacktest>): ReportInput => ({ result: r })
    const def = null as unknown as StrategyDef
    const candles: Candle[] = []
    expect(typeof accepts).toBe('function')
    expect(def).toBeNull()
    expect(candles).toHaveLength(0)
  })
})
