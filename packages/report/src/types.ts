// SPDX-License-Identifier: CPAL-1.0
// 报告输入 / 输出类型。指标键名与 QuantDinger 结果字典对齐（runtime.py 的 camelCase 与
// strategy_review.py 的 snake_case 两套，本包统一用 snake_case，对照表见 REPORT.md）。
//
// 说明：engine-core 的包入口没有导出 BacktestResult（它来自 packages/protocol/src/gep/backtest.ts，
// 由 engine-core/src/proto.ts 内部转出）。这里用结构化声明描述「两种形态都能喂进来」的字段集，
// test/metrics.test.ts 里有编译期断言：engine-core 的 runBacktest 返回值必须能直接赋给 ReportInput。

/** 权益曲线点（与 BacktestResult.equity 同形）。 */
export interface CurvePoint {
  t: number
  v: number
}

/** 一笔成交（与 protocol BacktestTrade / engine-core BacktestTrade 同形；reason 可缺）。 */
export interface ReportTrade {
  t: number
  side: 'buy' | 'sell'
  price: number
  size: number
  /** 该笔成交实现的盈亏，已扣本笔手续费；纯开仓为 -手续费。 */
  pnl: number
  fee: number
  reason?: string
}

/** 回测统计块：protocol BacktestStats 与 engine-core SimStats 的公共字段 + 各自扩展字段。 */
export interface ReportStats {
  totalReturnRatio: number
  annualizedRatio: number
  maxDrawdownRatio: number
  sharpe: number
  sortino?: number
  winRatio: number
  profitFactor?: number | null
  trades: number
  fills?: number
  avgHoldBars?: number
  spanDays?: number
  finalEquity?: number
  /** engine-core 独有。 */
  feesPaid?: number
  fundingPaid?: number
  liquidations?: number
  protectionExits?: number
  unfilledShare?: number
}

/** 回测结果（protocol BacktestResult 的超集；engine-core SimulationOutput 也是它的子集）。 */
export interface BacktestResult {
  jobId?: string
  specDigest?: string
  strategySha256?: string
  dataDigest?: string
  engine?: { id: string; version: string }
  /** 实际采用的假设（费 / 滑点 / 成交模型 / 资金费 / 强平）。 */
  assumptions?: Record<string, unknown>
  stats: ReportStats
  equity: CurvePoint[]
  trades: ReportTrade[]
  openPosition?: unknown
  params?: Record<string, unknown>
  trialCount?: number
  warnings?: string[]
  biasChecks?: Record<string, unknown>
  artifacts?: { artifactId: string; kind: string }[]
}

/** evidence 摘要（与 engine-core EvidenceSummary 同形，本包不复算，只展示）。 */
export interface EvidenceSummaryLike {
  periods: number
  periodMs: number
  periodsPerYear: number
  sharpe: number
  sharpeAnnualized: number
  psr: number | null
  dsr: number | null
  skewness: number
  kurtosis: number
  sharpeCi95: [number, number] | null
  trialCount: number
  warnings: string[]
}

export interface ReportInput {
  result: BacktestResult
  /** 已有证据摘要（不重算，直接展示）。 */
  evidence?: EvidenceSummaryLike
  /** 基准曲线（与 result.equity 同频，或至少时间戳有交集）；给了才算信息比率。 */
  benchmark?: CurvePoint[]
  title?: string
  /** 生成时间戳（ms）。缺省取 0 以便测试确定性；CLI 会传 Date.now()。 */
  generatedAt?: number
}

/** 指标来源：'stats' = 来自 @gitrader/stats 的统计函数或结果自带的统计块；'computed' = 本包算术。 */
export type MetricSource = 'stats' | 'computed'

export interface ReportMetric {
  /** 与 QD 结果字典对齐的键名（snake_case）。 */
  key: string
  label: string
  /** 已格式化的展示值；不可算时为 '—'。 */
  value: string
  /** 原始数值（不可算时为 null），供机器读 / 精确断言。 */
  raw: number | null
  unit?: string
  source: MetricSource
}

/** 一个自然月的收益分桶（UTC）。ret = 月末权益 / 上月末权益 - 1。 */
export interface MonthReturn {
  /** 'YYYY-MM' */
  key: string
  year: number
  /** 1-12 */
  month: number
  ret: number
  /** 该月的权益点数。 */
  points: number
}

/** 有基准时的信息比率块（口径照 QD metrics.calculate_information_ratio）。 */
export interface InformationRatioBlock {
  ir: number | null
  classification: string
  observations: number
  annualizationFactor: number
  /** 年化主动收益（每期均值 × 年化因子）。 */
  activeReturnAnnualized: number
  /** 年化跟踪误差（每期样本标准差 × sqrt(年化因子)）。 */
  trackingErrorAnnualized: number
}

export interface ReportMetrics {
  /** 扁平指标表（顺序即渲染顺序）。 */
  rows: ReportMetric[]
  monthly: MonthReturn[]
  informationRatio: InformationRatioBlock | null
  /** 平仓成交笔数（胜率 / 盈亏因子的分母口径）。 */
  closedTrades: number
  warnings: string[]
}

/** 固定免责声明，一行，不含收益表述。 */
export const DISCLAIMER = '本报告为历史数据回测结果，不构成任何预测或建议。'

/** 按 key 取一条指标。 */
export function metricOf(metrics: ReportMetrics, key: string): ReportMetric | undefined {
  return metrics.rows.find((m) => m.key === key)
}
