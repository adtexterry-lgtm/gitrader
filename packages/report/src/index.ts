// SPDX-License-Identifier: CPAL-1.0
// @gitrader/report：回测报告导出（Markdown + 自包含 HTML）。指标键名对齐 QuantDinger，统计量复用 @gitrader/stats。
export { computeReportMetrics, computeInformationRatio, classifyInformationRatio, headlineMetrics, maxStreaks, periodReturns, scanClosedFills } from './metrics'
export type { ClosedFill, ClosedFillScan, Streaks } from './metrics'
export { renderMarkdown, MAX_TRADE_ROWS } from './markdown'
export { renderHtml, renderBoth, CHART_SAMPLE_LIMIT } from './html'
export { run, parseArgs, normalizeResult, USAGE } from './cli'
export type { CliIo, ReportArgs, ArgsError } from './cli'
export { sampleCurve, sampleCurveIndices, drawdownSeries, monthlyReturns, monthKeyUtc, MIN_SAMPLE_LIMIT } from './curve'
export { equityChartSvg, drawdownChartSvg, monthlyHeatmapSvg } from './svg'
export { reportDigest, reportPayload, sha256Hex } from './digest'
export { DISCLAIMER, metricOf } from './types'
export type {
  BacktestResult,
  CurvePoint,
  EvidenceSummaryLike,
  InformationRatioBlock,
  MetricSource,
  MonthReturn,
  ReportInput,
  ReportMetric,
  ReportMetrics,
  ReportStats,
  ReportTrade,
} from './types'
