// SPDX-License-Identifier: CPAL-1.0
// 指标计算：复用 @gitrader/stats（Sharpe / PSR / DSR / 信息比率），补齐 QD 结果字典里
// strategy_review 那套口径的 profit factor / expectancy / avg win-loss / 连续盈亏笔数，
// 以及 QD 结果字典里没有的 calmar / exposure / turnover / 资金费。
import { dsr as dsrStat, informationRatio as irStat, kurtosis as kurtosisStat, psr as psrStat, sharpe as sharpeStat, skewness as skewnessStat } from '@gitrader/stats'
import { monthlyReturns } from './curve'
import { fmt2, fmtMoney, fmtNum, fmtPct } from './format'
import type { InformationRatioBlock, MonthReturn, ReportInput, ReportMetric, ReportMetrics, ReportTrade } from './types'

/** 浮点容差：仓位视为 0 的阈值。 */
const EPS = 1e-12
const YEAR_MS = 365 * 86_400_000

/**
 * QD metrics.py 的信息比率分级上界（weak < 0.30 ≤ acceptable < 0.50 ≤ good < 1.00 ≤ exceptional）。
 * Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/backtest/metrics.py:27-32; adapted.
 */
const IR_BANDS: readonly (readonly [number, string])[] = [
  [0.3, 'weak'],
  [0.5, 'acceptable'],
  [1.0, 'good'],
  [Number.POSITIVE_INFINITY, 'exceptional'],
]

export function classifyInformationRatio(value: number): string {
  for (const [upper, label] of IR_BANDS) if (value < upper) return label
  return IR_BANDS[IR_BANDS.length - 1]![1]
}

/** 每期简单收益 r_i = v_i / v_{i-1} - 1（与 engine-core evidence.periodReturns 同口径）。 */
export function periodReturns(equity: readonly { t: number; v: number }[]): number[] {
  const out: number[] = []
  for (let i = 1; i < equity.length; i++) {
    const prev = equity[i - 1]!
    const cur = equity[i]!
    if (!Number.isFinite(prev.v) || !Number.isFinite(cur.v)) continue
    if (prev.v <= 0) continue
    out.push(cur.v / prev.v - 1)
  }
  return out
}

/** 平仓成交：仓位从非零被这笔成交减少（含反手，反手同时也算开新仓）。 */
export interface ClosedFill {
  trade: ReportTrade
  pnl: number
}

export interface ClosedFillScan {
  closed: ClosedFill[]
  /** 持仓区间总时长（ms）。 */
  holdMs: number
  /** 重建的持仓区间数（含期末未平的）。 */
  intervals: number
  /** 期末是否仍有持仓。 */
  endOpen: boolean
}

/**
 * 按逐笔成交重建仓位，切出平仓成交与持仓区间。
 * 仓位口径：buy 记 +size、sell 记 -size；本笔成交与仓位反向即平仓成交（含反手）。
 */
export function scanClosedFills(trades: readonly ReportTrade[], lastT: number): ClosedFillScan {
  const closed: ClosedFill[] = []
  let pos = 0
  let holdMs = 0
  let intervals = 0
  let openAt: number | null = null

  for (const trade of trades) {
    const delta = trade.side === 'buy' ? trade.size : -trade.size
    const before = pos
    const after = before + delta
    if (Math.abs(before) <= EPS && Math.abs(after) > EPS) {
      openAt = trade.t
      intervals += 1
    } else if (Math.abs(before) > EPS && Math.sign(delta) !== Math.sign(before)) {
      closed.push({ trade, pnl: Number.isFinite(trade.pnl) ? trade.pnl : 0 })
      if (Math.abs(after) <= EPS) {
        if (openAt !== null) holdMs += Math.max(0, trade.t - openAt)
        openAt = null
      } else {
        // 反手：旧仓在此平掉，新仓从这里开始计时。
        if (openAt !== null) holdMs += Math.max(0, trade.t - openAt)
        openAt = trade.t
        intervals += 1
      }
    }
    pos = after
  }

  const endOpen = Math.abs(pos) > EPS
  if (endOpen && openAt !== null) holdMs += Math.max(0, lastT - openAt)
  return { closed, holdMs, intervals, endOpen }
}

export interface Streaks {
  maxWins: number
  maxLosses: number
}

/**
 * 最大连续盈利 / 亏损笔数（按成交顺序）。
 * 口径对齐 QD `strategy_review.py:526-531`：只有 pnl > 0 才清零连亏，只有 pnl < 0 才清零连赢，
 * pnl 为 0 的笔既不累加也不打断两边。
 */
export function maxStreaks(pnls: readonly number[]): Streaks {
  let maxWins = 0
  let maxLosses = 0
  let curWins = 0
  let curLosses = 0
  for (const pnl of pnls) {
    if (pnl > 0) {
      curWins += 1
      curLosses = 0
      if (curWins > maxWins) maxWins = curWins
    } else if (pnl < 0) {
      curLosses += 1
      curWins = 0
      if (curLosses > maxLosses) maxLosses = curLosses
    }
  }
  return { maxWins, maxLosses }
}

function sum(xs: readonly number[]): number {
  let total = 0
  for (const x of xs) total += x
  return total
}

function metric(
  key: string,
  label: string,
  value: string,
  raw: number | null,
  source: 'stats' | 'computed',
  unit?: string,
): ReportMetric {
  const row: ReportMetric = { key, label, value, raw, source }
  if (unit !== undefined) row.unit = unit
  return row
}

function pctMetric(key: string, label: string, value: number | null, source: 'stats' | 'computed'): ReportMetric {
  if (value === null || !Number.isFinite(value)) return metric(key, label, '—', null, source, '%')
  return metric(key, label, fmtPct(value), value, source, '%')
}

function ratioMetric(key: string, label: string, value: number | null, source: 'stats' | 'computed'): ReportMetric {
  if (value === null || !Number.isFinite(value)) return metric(key, label, '—', null, source)
  return metric(key, label, fmt2(value), value, source)
}

function moneyMetric(key: string, label: string, value: number | null, source: 'stats' | 'computed'): ReportMetric {
  if (value === null || !Number.isFinite(value)) return metric(key, label, '—', null, source)
  return metric(key, label, fmtMoney(value), value, source)
}

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/backtest/metrics.py:35-117; adapted.
// 改动：QD 用 pandas 按交易所日历剔除不连续区间，这里只要求时间戳有交集（同频对齐由调用方保证），
// 主动收益与跟踪误差的算术复用 @gitrader/stats 的 informationRatio（该函数本身也是从 metrics.py:35 移植的）。
/**
 * 对齐基准：按共同时间戳取水平值，算出每期主动收益，交给 @gitrader/stats 的 informationRatio。
 * 年化因子由共同时间戳的中位间隔推出（365 天 / 期长），与 QD 的 _FREQUENCY_SECONDS 换算同构。
 */
export function computeInformationRatio(
  equity: readonly { t: number; v: number }[],
  benchmark: readonly { t: number; v: number }[],
): InformationRatioBlock | null {
  if (benchmark.length < 3 || equity.length < 3) return null
  const byTime = new Map<number, number>()
  for (const p of benchmark) if (Number.isFinite(p.t) && Number.isFinite(p.v)) byTime.set(p.t, p.v)
  const common: { t: number; p: number; b: number }[] = []
  for (const p of equity) {
    if (!Number.isFinite(p.t) || !Number.isFinite(p.v)) continue
    const b = byTime.get(p.t)
    if (b === undefined || !Number.isFinite(b)) continue
    common.push({ t: p.t, p: p.v, b })
  }
  if (common.length < 3) return null

  const diffs: number[] = []
  for (let i = 1; i < common.length; i++) {
    const dt = common[i]!.t - common[i - 1]!.t
    if (dt > 0) diffs.push(dt)
  }
  if (diffs.length === 0) return null
  diffs.sort((a, b) => a - b)
  const mid = Math.floor(diffs.length / 2)
  const periodMs = diffs.length % 2 === 1 ? diffs[mid]! : (diffs[mid - 1]! + diffs[mid]!) / 2
  if (!(periodMs > 0)) return null
  const factor = YEAR_MS / periodMs

  const portRets: number[] = []
  const benchRets: number[] = []
  for (let i = 1; i < common.length; i++) {
    const prev = common[i - 1]!
    const cur = common[i]!
    if (prev.p <= 0 || prev.b <= 0) continue
    portRets.push(cur.p / prev.p - 1)
    benchRets.push(cur.b / prev.b - 1)
  }
  if (portRets.length === 0) return null

  const stat = irStat(portRets, benchRets, { periodsPerYear: factor })
  const activeReturnAnnualized = stat.activeMean * factor
  const trackingErrorAnnualized = stat.trackingError * Math.sqrt(factor)
  return {
    ir: stat.ir,
    classification: stat.ir === null ? 'insufficient_history' : classifyInformationRatio(stat.ir),
    observations: stat.n,
    annualizationFactor: factor,
    activeReturnAnnualized,
    trackingErrorAnnualized,
  }
}

/** 结果里的统计块 + 逐笔成交 → 扁平指标表 + 月度分桶 + 信息比率。 */
export function computeReportMetrics(input: ReportInput): ReportMetrics {
  const { result } = input
  const stats = result.stats
  const equity = result.equity ?? []
  const trades = result.trades ?? []
  const warnings: string[] = []
  const lastT = equity.length > 0 ? equity[equity.length - 1]!.t : trades.length > 0 ? trades[trades.length - 1]!.t : 0
  const firstT = equity.length > 0 ? equity[0]!.t : trades.length > 0 ? trades[0]!.t : 0
  const scan = scanClosedFills(trades, lastT)
  const pnls = scan.closed.map((c) => c.pnl)
  const wins = pnls.filter((p) => p > 0)
  const losses = pnls.filter((p) => p < 0)
  const grossProfit = sum(wins)
  const grossLoss = Math.abs(sum(losses))
  const decided = wins.length + losses.length

  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? grossProfit : 0
  const avgWin = wins.length > 0 ? grossProfit / wins.length : null
  const avgLoss = losses.length > 0 ? sum(losses) / losses.length : null
  const expectancy = pnls.length > 0 ? sum(pnls) / pnls.length : null
  const profitLossRatio = avgWin !== null && avgLoss !== null && avgLoss !== 0 ? avgWin / Math.abs(avgLoss) : null
  const winRate = decided > 0 ? wins.length / decided : null
  const streaks = maxStreaks(pnls)

  const feesPaid = typeof stats.feesPaid === 'number' && Number.isFinite(stats.feesPaid) ? stats.feesPaid : sum(trades.map((t) => (Number.isFinite(t.fee) ? t.fee : 0)))
  const fundingPaid = typeof stats.fundingPaid === 'number' && Number.isFinite(stats.fundingPaid) ? stats.fundingPaid : 0
  const turnover = sum(trades.map((t) => Math.abs(t.price * t.size)))
  const initialEquity = equity.length > 0 ? equity[0]!.v : stats.finalEquity !== undefined ? stats.finalEquity / (1 + stats.totalReturnRatio) : null
  const turnoverRatio = initialEquity !== null && initialEquity > 0 ? turnover / initialEquity : null
  const spanMs = lastT - firstT
  const exposure = spanMs > 0 ? Math.min(1, scan.holdMs / spanMs) : null
  const calmar = Number.isFinite(stats.maxDrawdownRatio) && stats.maxDrawdownRatio > 0 ? stats.annualizedRatio / stats.maxDrawdownRatio : null

  const returns = periodReturns(equity)
  let psr: number | null = null
  let dsr: number | null = null
  if (input.evidence) {
    psr = input.evidence.psr
    dsr = input.evidence.dsr
  } else if (returns.length >= 2) {
    // 平盘（收益序列全相等，含全 0 / 方差为 0）时 PSR / DSR 无定义，给 null（同 engine-core evidence.ts:87-96）。
    const flat = returns.every((r) => r === returns[0])
    const sr = sharpeStat(returns)
    const skew = returns.length >= 3 ? skewnessStat(returns) : 0
    const kurt = returns.length >= 4 ? kurtosisStat(returns) : 3
    if (!flat) {
      const p = psrStat(sr, { n: returns.length, skew, kurt })
      psr = Number.isFinite(p) ? p : null
      const trials = Math.max(1, Math.floor(result.trialCount ?? 1))
      if (trials > 1) {
        const d = dsrStat(sr, { n: returns.length, nTrials: trials, trialVariance: 0, skew, kurt })
        dsr = Number.isFinite(d) ? d : null
      }
    }
  }

  const irBlock = input.benchmark !== undefined ? computeInformationRatio(equity, input.benchmark) : null

  const rows: ReportMetric[] = [
    pctMetric('total_return', '总收益', Number.isFinite(stats.totalReturnRatio) ? stats.totalReturnRatio : null, 'stats'),
    pctMetric('annualized_return', '年化收益', Number.isFinite(stats.annualizedRatio) ? stats.annualizedRatio : null, 'stats'),
    pctMetric('max_drawdown', '最大回撤', Number.isFinite(stats.maxDrawdownRatio) ? stats.maxDrawdownRatio : null, 'stats'),
    ratioMetric('sharpe_ratio', '夏普比率', Number.isFinite(stats.sharpe) ? stats.sharpe : null, 'stats'),
  ]
  if (input.evidence) {
    rows.push(ratioMetric('sharpe_annualized', '年化夏普', Number.isFinite(input.evidence.sharpeAnnualized) ? input.evidence.sharpeAnnualized : null, 'stats'))
  }
  if (typeof stats.sortino === 'number') {
    rows.push(ratioMetric('sortino_ratio', '索提诺比率', Number.isFinite(stats.sortino) ? stats.sortino : null, 'stats'))
  }
  rows.push(
    ratioMetric('calmar_ratio', '卡玛比率（年化收益 / 最大回撤）', calmar, 'computed'),
    pctMetric('win_rate', '胜率', winRate, 'computed'),
    ratioMetric('profit_factor', '盈利因子（总盈利 / 总亏损）', Number.isFinite(profitFactor) ? profitFactor : null, 'computed'),
    ratioMetric('profit_loss_ratio', '盈亏额比（平均盈利 / 平均亏损）', profitLossRatio, 'computed'),
    moneyMetric('expectancy', '单笔期望（平仓笔均值）', expectancy, 'computed'),
  )
  rows.push(
    moneyMetric('avg_win', '平均盈利', avgWin, 'computed'),
    moneyMetric('avg_loss', '平均亏损（负数）', avgLoss, 'computed'),
    metric('max_consecutive_wins', '最大连续盈利笔数', String(streaks.maxWins), streaks.maxWins, 'computed', '笔'),
    metric('max_consecutive_losses', '最大连续亏损笔数', String(streaks.maxLosses), streaks.maxLosses, 'computed', '笔'),
    metric('total_trades', '成交笔数', String(Number.isFinite(stats.trades) ? stats.trades : trades.length), Number.isFinite(stats.trades) ? stats.trades : trades.length, 'stats', '笔'),
    metric('closed_trades', '平仓笔数', String(scan.closed.length), scan.closed.length, 'computed', '笔'),
    moneyMetric('total_commission', '手续费合计', feesPaid, typeof stats.feesPaid === 'number' ? 'stats' : 'computed'),
    moneyMetric('funding_paid', '资金费合计', fundingPaid, typeof stats.fundingPaid === 'number' ? 'stats' : 'computed'),
    pctMetric('exposure', '持仓时间占比', exposure, 'computed'),
    moneyMetric('turnover', '成交额合计', turnover, 'computed'),
    ratioMetric('turnover_ratio', '换手率（成交额 / 起算权益）', turnoverRatio, 'computed'),
  )
  if (stats.finalEquity !== undefined) {
    rows.push(moneyMetric('final_equity', '期末权益', Number.isFinite(stats.finalEquity) ? stats.finalEquity : null, 'stats'))
  }
  rows.push(
    pctMetric('psr', 'PSR（概率化夏普）', psr, 'stats'),
    pctMetric('dsr', 'DSR（去膨胀夏普）', dsr, 'stats'),
  )
  if (input.benchmark !== undefined) {
    rows.push(ratioMetric('information_ratio', '信息比率（年化主动收益 / 年化跟踪误差）', irBlock?.ir ?? null, 'stats'))
  }

  if (scan.closed.length === 0) warnings.push('没有平仓成交：胜率 / 盈亏因子 / 连续盈亏笔数不可算')
  if (!(stats.maxDrawdownRatio > 0)) warnings.push('最大回撤为 0：卡玛比率不可算')
  if (input.benchmark === undefined) warnings.push('未提供基准曲线：信息比率未计算')
  else if (irBlock === null) warnings.push('基准与权益曲线的共同时间戳不足：信息比率不可算')

  const monthly: MonthReturn[] = monthlyReturns(equity)
  if (monthly.length === 0) warnings.push('权益曲线为空：月度收益热力表无数据')

  return { rows, monthly, informationRatio: irBlock, closedTrades: scan.closed.length, warnings }
}

/** 摘要卡用的四个关键值（缺失时为 '—'）。 */
export function headlineMetrics(metrics: ReportMetrics): { totalReturn: string; maxDrawdown: string; sharpe: string; trades: string } {
  const pick = (key: string): string => metrics.rows.find((m) => m.key === key)?.value ?? '—'
  return {
    totalReturn: pick('total_return'),
    maxDrawdown: pick('max_drawdown'),
    sharpe: pick('sharpe_ratio'),
    trades: fmtNum(metrics.closedTrades, 0),
  }
}
