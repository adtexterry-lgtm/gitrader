// SPDX-License-Identifier: CPAL-1.0
// 测试夹具：12 笔成交的手工回测结果（算式见 metrics.test.ts 注释）。
import type { BacktestResult, CurvePoint, ReportTrade } from '../src/types'

const DAY = 86_400_000
export const BASE_T = Date.UTC(2024, 0, 1)

/** 12 笔成交：6 组「开 → 平」，每笔开仓手续费 0、平仓手续费 0.5。 */
export function fixtureTrades(): ReportTrade[] {
  const t = (day: number): number => BASE_T + day * DAY
  return [
    { t: t(0), side: 'buy', price: 100, size: 1, pnl: 0, fee: 0, reason: 'entry' },
    { t: t(2), side: 'sell', price: 120.5, size: 1, pnl: 20, fee: 0.5, reason: 'exit' },
    { t: t(4), side: 'buy', price: 100, size: 1, pnl: 0, fee: 0, reason: 'entry' },
    { t: t(6), side: 'sell', price: 95.5, size: 1, pnl: -5, fee: 0.5, reason: 'stop' },
    { t: t(8), side: 'buy', price: 100, size: 5, pnl: 0, fee: 0, reason: 'entry' },
    { t: t(10), side: 'sell', price: 95.1, size: 5, pnl: -25, fee: 0.5, reason: 'stop' },
    { t: t(12), side: 'buy', price: 100, size: 2, pnl: 0, fee: 0, reason: 'entry' },
    { t: t(14), side: 'sell', price: 102.25, size: 2, pnl: 4, fee: 0.5, reason: 'exit' },
    { t: t(16), side: 'buy', price: 100, size: 4, pnl: 0, fee: 0, reason: 'entry' },
    { t: t(18), side: 'sell', price: 101.625, size: 4, pnl: 6, fee: 0.5, reason: 'exit' },
    { t: t(20), side: 'buy', price: 100, size: 1, pnl: 0, fee: 0, reason: 'entry' },
    { t: t(22), side: 'sell', price: 115.5, size: 1, pnl: 15, fee: 0.5, reason: 'exit' },
  ]
}

/** 权益曲线：起算 100，逐日把已实现盈亏加进去（day 0..24，25 点）。 */
export function fixtureEquity(trades: readonly ReportTrade[] = fixtureTrades()): CurvePoint[] {
  const out: CurvePoint[] = []
  for (let day = 0; day <= 24; day++) {
    const t = BASE_T + day * DAY
    let v = 100
    for (const trade of trades) if (trade.t <= t) v += trade.pnl
    out.push({ t, v })
  }
  return out
}

/**
 * 12 笔成交 / 25 个权益点的结果。
 *
 * 算式：
 * - 平仓 pnl = [20, -5, -25, 4, 6, 15]；总盈利 45，总亏损 30 → 盈利因子 45/30 = 1.5
 * - 单笔期望 = (20-5-25+4+6+15)/6 = 15/6 = 2.5
 * - 平均盈利 45/4 = 11.25；平均亏损 -30/2 = -15；比值 0.75
 * - 胜 4 / 负 2 → 胜率 4/6 = 0.6667；连续亏损最多 2（-5,-25）；连续盈利最多 3
 * - 持仓 6 段 × 2 天 = 12 天，权益跨度 24 天 → 持仓时间占比 0.5
 * - 成交额 = 开仓 1400 + 平仓 1418 = 2818；换手率 2818/100 = 28.18
 * - 手续费 6 × 0.5 = 3；资金费 0.25（统计块给）
 * - 权益峰值 120、谷 90 → 最大回撤 0.25（与统计块一致）
 * - 统计块的年化收益 0.5 是引擎口径（夹具给定），卡玛 = 0.5 / 0.25 = 2
 */
export function buildFixture(): BacktestResult {
  const trades = fixtureTrades()
  return {
    jobId: 'job-fixture-001',
    specDigest: 'a'.repeat(64),
    engine: { id: 'engine-core', version: '0.1.0' },
    assumptions: {
      fees: { makerBps: 0, takerBps: 5 },
      slippageBps: 2,
      fillModel: 'next-bar-open',
      funding: 'none',
      liquidation: 'none',
    },
    stats: {
      totalReturnRatio: 0.15,
      annualizedRatio: 0.5,
      maxDrawdownRatio: 0.25,
      sharpe: 1.5,
      sortino: 2,
      winRatio: 4 / 6,
      profitFactor: 1.5,
      trades: 12,
      fills: 12,
      avgHoldBars: 48,
      spanDays: 24,
      finalEquity: 115,
      feesPaid: 3,
      fundingPaid: 0.25,
      liquidations: 0,
    },
    equity: fixtureEquity(trades),
    trades,
    openPosition: null,
    params: { fast: 12, slow: 48 },
    trialCount: 1,
    warnings: [],
  }
}

/** 空成交结果（不崩测试用）：只有权益、没有成交。 */
export function buildEmptyFixture(): BacktestResult {
  return {
    stats: {
      totalReturnRatio: 0,
      annualizedRatio: 0,
      maxDrawdownRatio: 0,
      sharpe: 0,
      winRatio: 0,
      profitFactor: null,
      trades: 0,
      fills: 0,
      avgHoldBars: 0,
      spanDays: 3,
      finalEquity: 100,
    },
    equity: [0, 1, 2, 3].map((day) => ({ t: BASE_T + day * DAY, v: 100 })),
    trades: [],
    params: {},
    warnings: [],
  }
}

/** 跨三个月的小曲线：2023-11 / 2023-12 / 2024-01，月末 100 → 110 → 99 → 108。 */
export function buildMonthlyCurve(): CurvePoint[] {
  return [
    { t: Date.UTC(2023, 10, 1), v: 100 },
    { t: Date.UTC(2023, 10, 15), v: 105 },
    { t: Date.UTC(2023, 10, 30), v: 110 },
    { t: Date.UTC(2023, 11, 15), v: 104 },
    { t: Date.UTC(2023, 11, 31), v: 99 },
    { t: Date.UTC(2024, 0, 10), v: 103 },
    { t: Date.UTC(2024, 0, 31), v: 108 },
  ]
}

/** 大结果（体积测试用）：6000 个权益点跨 16 年、500 笔成交。 */
export function buildBigFixture(): BacktestResult {
  const trades: ReportTrade[] = []
  const equity: CurvePoint[] = []
  const start = Date.UTC(2008, 0, 1)
  for (let i = 0; i < 6000; i++) {
    const v = 10_000 + Math.sin(i / 37) * 1500 + i * 1.5
    equity.push({ t: start + i * DAY, v })
  }
  for (let i = 0; i < 500; i++) {
    const t = start + (i * 12 + 1) * DAY
    trades.push({
      t,
      side: i % 2 === 0 ? 'buy' : 'sell',
      price: 100 + (i % 17),
      size: 0.5 + (i % 5) * 0.25,
      pnl: i % 3 === 0 ? -12.5 : 9.25,
      fee: 0.42,
      reason: `signal-${i}-with-a-longer-note-to-pad-the-report-body`,
    })
  }
  return {
    jobId: 'job-big',
    engine: { id: 'engine-core', version: '0.1.0' },
    assumptions: { fees: { takerBps: 5 }, slippageBps: 2, fillModel: 'next-bar-open', funding: 'none', liquidation: 'none' },
    stats: {
      totalReturnRatio: 0.9,
      annualizedRatio: 0.05,
      maxDrawdownRatio: 0.3,
      sharpe: 0.7,
      sortino: 0.9,
      winRatio: 0.66,
      profitFactor: 1.9,
      trades: trades.length,
      fills: trades.length,
      avgHoldBars: 12,
      spanDays: 6000,
      finalEquity: equity[equity.length - 1]!.v,
      feesPaid: 210,
      fundingPaid: 3.5,
    },
    equity,
    trades,
    params: { fast: 8, slow: 21, risk: 0.02 },
    warnings: ['sample warning'],
  }
}
