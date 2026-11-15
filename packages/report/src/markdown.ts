// SPDX-License-Identifier: CPAL-1.0
// Markdown 报告。章节顺序照 QD ai_report_pdf.py 的专业报告（摘要 → 质量 → 维度 → 情景 → 风险 → 主张 → 局限 → 证据 → 方法），
// 这里对应：摘要 → 数据质量 → 指标 → 曲线与月度 → 风险 → 参数 → 交易明细 → 证据 → 方法 → 免责声明。
import { monthlyReturns } from './curve'
import { reportDigest } from './digest'
import { fmtDate, fmtDuration, fmtMoney, fmtPct, fmtTime, mdCell } from './format'
import { computeReportMetrics, headlineMetrics } from './metrics'
import type { ReportInput, ReportMetrics } from './types'
import { DISCLAIMER } from './types'

/** 交易明细行数上限（与 HTML 一致）。 */
export const MAX_TRADE_ROWS = 200

const ASSUMPTION_FIELDS: readonly (readonly [string, string])[] = [
  ['fees', '手续费'],
  ['slippageBps', '滑点（bps）'],
  ['fillModel', '成交模型'],
  ['funding', '资金费'],
  ['liquidation', '强平'],
]

function assumptionRows(input: ReportInput): [string, string][] {
  const raw = input.result.assumptions
  return ASSUMPTION_FIELDS.map(([key, label]) => {
    const value = raw?.[key]
    if (value === undefined) return [label, '未记录']
    if (value !== null && typeof value === 'object') return [label, JSON.stringify(value)]
    return [label, String(value)]
  })
}

function titleOf(input: ReportInput): string {
  return input.title ?? '回测报告'
}

/** 百分数展示：不可算时只留 '—'，不要 '—%'。 */
function withPercent(value: string): string {
  return value === '—' ? value : `${value}%`
}

function paramRows(input: ReportInput): [string, string][] {
  const params = input.result.params
  if (params === undefined) return []
  return Object.keys(params)
    .sort()
    .map((key) => [key, String(params[key])] as [string, string])
}

function tradeRows(input: ReportInput): string {
  const trades = input.result.trades ?? []
  if (trades.length === 0) return '_无成交_'
  const rows = trades.slice(0, MAX_TRADE_ROWS)
  const lines = ['| 时间 | 方向 | 价格 | 数量 | 盈亏 | 手续费 | 原因 |', '|---|---|---:|---:|---:|---:|---|']
  for (const t of rows) {
    lines.push(
      `| ${fmtTime(t.t)} | ${t.side === 'buy' ? '买入' : '卖出'} | ${fmtMoney(t.price, 4)} | ${fmtMoney(t.size, 6)} | ${fmtMoney(t.pnl)} | ${fmtMoney(t.fee, 4)} | ${mdCell(t.reason ?? '')} |`,
    )
  }
  if (trades.length > MAX_TRADE_ROWS) {
    lines.push('', `_共 ${trades.length} 笔成交，表格只列前 ${MAX_TRADE_ROWS} 笔；完整成交见结果文件。_`)
  }
  return lines.join('\n')
}

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/ai_report_pdf.py:925-1068; adapted.
// 只照抄章节顺序（摘要 → 质量 → 维度 → 情景 → 风险 → 主张 → 局限 → 证据 → 方法），产出是 Markdown 不是 PDF。
/** Markdown 报告（单文件，纯文本）。 */
export function renderMarkdown(input: ReportInput, metricsIn?: ReportMetrics): string {
  const { result } = input
  const metrics = metricsIn ?? computeReportMetrics(input)
  const monthly = metrics.monthly.length > 0 ? metrics.monthly : monthlyReturns(result.equity ?? [])
  const head = headlineMetrics(metrics)
  const digest = reportDigest(result)
  const out: string[] = []

  out.push(`# ${titleOf(input)}`, '')
  out.push(`> 生成时间：${fmtTime(input.generatedAt ?? 0)} ｜ 引擎：${result.engine ? `${result.engine.id} ${result.engine.version}` : '未记录'} ｜ 数据摘要 sha256：\`${digest}\``, '')
  out.push(`> ${DISCLAIMER}`, '')

  out.push('## 摘要', '')
  out.push(`- 总收益：${withPercent(head.totalReturn)}`)
  out.push(`- 最大回撤：${withPercent(head.maxDrawdown)}`)
  out.push(`- 夏普比率：${head.sharpe}`)
  out.push(`- 平仓笔数：${head.trades}`)
  if (result.trialCount !== undefined && result.trialCount > 1) out.push(`- 参数试验次数：${result.trialCount}`)
  out.push('')

  out.push('## 数据质量与假设', '')
  out.push('| 假设项 | 取值 |', '|---|---|')
  for (const [label, value] of assumptionRows(input)) out.push(`| ${label} | ${mdCell(value)} |`)
  out.push('')
  const spanMs = (result.equity ?? []).length > 1 ? result.equity[result.equity.length - 1]!.t - result.equity[0]!.t : 0
  out.push(`- 权益点数：${(result.equity ?? []).length}`)
  out.push(`- 数据跨度：${fmtDate(result.equity?.[0]?.t)} → ${fmtDate(result.equity?.[(result.equity ?? []).length - 1]?.t)}（${fmtDuration(spanMs)}）`)
  out.push(`- 成交笔数：${(result.trades ?? []).length}`)
  if (result.warnings !== undefined && result.warnings.length > 0) {
    out.push('', '结果自带告警：', '')
    for (const w of result.warnings) out.push(`- ${mdCell(w)}`)
  }
  out.push('')

  out.push('## 指标', '')
  out.push('| 指标 | 数值 | 单位 | 口径 |', '|---|---:|---|---|')
  for (const row of metrics.rows) out.push(`| ${mdCell(row.label)} | ${row.value} | ${row.unit ?? ''} | ${row.source === 'stats' ? '统计' : '算术'} |`)
  out.push('')

  out.push('## 曲线与月度收益', '')
  out.push(`图表见 HTML 版本（${'权益曲线 / 回撤曲线 / 月度收益热力表'}）。`, '')
  if (monthly.length === 0) {
    out.push('_无月度数据_')
  } else {
    out.push('| 月份 | 收益 | 点数 |', '|---|---:|---:|')
    for (const m of monthly) out.push(`| ${m.key} | ${fmtPct(m.ret, 2)}% | ${m.points} |`)
  }
  out.push('')

  out.push('## 风险', '')
  const dd = metrics.rows.find((r) => r.key === 'max_drawdown')
  const losses = metrics.rows.find((r) => r.key === 'max_consecutive_losses')
  const exposure = metrics.rows.find((r) => r.key === 'exposure')
  out.push(`- 最大回撤：${withPercent(dd?.value ?? '—')}`)
  out.push(`- 最大连续亏损笔数：${losses?.value ?? '—'}`)
  out.push(`- 持仓时间占比：${withPercent(exposure?.value ?? '—')}`)
  if (result.stats.liquidations !== undefined) out.push(`- 强平次数：${result.stats.liquidations}`)
  out.push('')

  out.push('## 参数', '')
  const params = paramRows(input)
  if (params.length === 0) {
    out.push('_无参数记录_')
  } else {
    out.push('| 参数 | 取值 |', '|---|---|')
    for (const [key, value] of params) out.push(`| ${mdCell(key)} | ${mdCell(value)} |`)
  }
  out.push('')

  out.push(`## 交易明细（最多 ${MAX_TRADE_ROWS} 行）`, '')
  out.push(tradeRows(input), '')

  out.push('## 证据摘要', '')
  if (input.evidence === undefined) {
    out.push('_未附带证据摘要_')
  } else {
    const e = input.evidence
    out.push('| 项 | 取值 |', '|---|---:|')
    out.push(`| 收益期数 | ${e.periods} |`)
    out.push(`| 期长 | ${fmtDuration(e.periodMs)} |`)
    out.push(`| 每年期数 | ${e.periodsPerYear.toFixed(2)} |`)
    out.push(`| 每期夏普 | ${e.sharpe.toFixed(4)} |`)
    out.push(`| 年化夏普 | ${e.sharpeAnnualized.toFixed(4)} |`)
    out.push(`| PSR | ${e.psr === null ? '—' : `${fmtPct(e.psr)}%`} |`)
    out.push(`| DSR | ${e.dsr === null ? '—' : `${fmtPct(e.dsr)}%`} |`)
    out.push(`| 偏度 / 峰度 | ${e.skewness.toFixed(4)} / ${e.kurtosis.toFixed(4)} |`)
    out.push(`| 夏普 95% 区间 | ${e.sharpeCi95 === null ? '—' : `${e.sharpeCi95[0].toFixed(4)} … ${e.sharpeCi95[1].toFixed(4)}`} |`)
    out.push(`| 试验次数 | ${e.trialCount} |`)
    if (e.warnings.length > 0) out.push(`| 告警 | ${mdCell(e.warnings.join('; '))} |`)
  }
  out.push('')

  out.push('## 方法', '')
  out.push(`- 指标来源：统计类指标取自 @gitrader/stats 与结果统计块，其余为报告层算术；每行的「口径」列已标注。`)
  out.push(`- 胜率 / 盈亏因子 / 连续盈亏笔数的分母是**平仓成交**（由逐笔成交重建仓位切出），不是开仓成交。`)
  out.push(`- 持仓时间占比 = 持仓区间总时长 / 权益曲线跨度；成交额合计 = Σ 价格 × 数量；换手率 = 成交额 / 起算权益。`)
  out.push(`- 信息比率仅在给出基准曲线时计算，口径照 QD metrics.calculate_information_ratio（共同时间戳上的主动收益）。`)
  out.push(`- 数据摘要 sha256：\`${digest}\``)
  out.push('')
  out.push(`> ${DISCLAIMER}`)
  out.push('')
  return out.join('\n')
}
