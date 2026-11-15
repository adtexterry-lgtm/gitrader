// SPDX-License-Identifier: CPAL-1.0
// 自包含 HTML 报告：内联 CSS + 内联 SVG，无 <script>、无外部字体、无外链资源。
import { reportDigest } from './digest'
import { fmtDate, fmtDuration, fmtMoney, fmtPct, fmtTime, escapeHtml as esc } from './format'
import { MAX_TRADE_ROWS, renderMarkdown } from './markdown'
import { computeReportMetrics, headlineMetrics } from './metrics'
import { drawdownChartSvg, equityChartSvg, monthlyHeatmapSvg } from './svg'
import type { ReportInput, ReportMetrics } from './types'
import { DISCLAIMER } from './types'

/** 曲线降采样上限（HTML 里两条曲线共用）。 */
export const CHART_SAMPLE_LIMIT = 240

const CSS = `
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:#0a1119;color:#d7e2ee;font:14px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,"Noto Sans SC",sans-serif}
.wrap{max-width:980px;margin:0 auto;padding:28px 20px 64px}
h1{font-size:26px;margin:0 0 6px;letter-spacing:.2px}
h2{font-size:16px;margin:30px 0 10px;padding-bottom:6px;border-bottom:1px solid #1e2b3a;color:#9fd0ff;letter-spacing:.4px}
.meta{color:#7d8fa3;font-size:12px;margin:0 0 14px;word-break:break-all}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.warn{border:1px solid #3a2f16;background:#1a1408;color:#f0c674}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;margin:12px 0}
.card{background:#101b27;border:1px solid #1e2b3a;border-radius:8px;padding:12px 14px}
.card .k{color:#7d8fa3;font-size:12px}
.card .v{font-size:22px;margin-top:4px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
table{width:100%;border-collapse:collapse;margin:8px 0 4px;font-size:13px}
th,td{padding:6px 8px;border-bottom:1px solid #16222f;text-align:left;vertical-align:top}
th{color:#7d8fa3;font-weight:600;font-size:12px;text-transform:none}
td.num,th.num{text-align:right;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
tr:hover td{background:#0e1720}
.chart{display:block;margin:8px 0 4px;border-radius:6px}
.note{color:#7d8fa3;font-size:12px}
.disclaimer{margin-top:26px;padding:12px 14px;border:1px solid #2a3a4a;border-radius:8px;background:#0d1620;color:#b8c8d8}
.foot{color:#5f7186;font-size:12px;margin-top:10px}
`.trim()

function table(headers: string[], rows: string[][], numeric: number[] = []): string {
  const th = headers.map((h, i) => `<th${numeric.includes(i) ? ' class="num"' : ''}>${esc(h)}</th>`).join('')
  const body = rows
    .map((row) => `<tr>${row.map((cell, i) => `<td${numeric.includes(i) ? ' class="num"' : ''}>${cell}</td>`).join('')}</tr>`)
    .join('')
  return `<table><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table>`
}

/** 百分数展示：不可算时只留 '—'。 */
function withPercent(value: string): string {
  return value === '—' ? value : `${value}%`
}

function section(title: string, body: string): string {
  return `<section><h2>${esc(title)}</h2>${body}</section>`
}

function assumptionTable(input: ReportInput): string {
  const raw = input.result.assumptions
  const fields: readonly (readonly [string, string])[] = [
    ['fees', '手续费'],
    ['slippageBps', '滑点（bps）'],
    ['fillModel', '成交模型'],
    ['funding', '资金费'],
    ['liquidation', '强平'],
  ]
  const rows = fields.map(([key, label]) => {
    const value = raw?.[key]
    const text = value === undefined ? '未记录' : value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value)
    return [esc(label), esc(text)]
  })
  return table(['假设项', '取值'], rows)
}

function paramTable(input: ReportInput): string {
  const params = input.result.params
  if (params === undefined || Object.keys(params).length === 0) return '<p class="note">无参数记录</p>'
  const rows = Object.keys(params)
    .sort()
    .map((key) => [esc(key), esc(String(params[key]))])
  return table(['参数', '取值'], rows)
}

function tradeTable(input: ReportInput): string {
  const trades = input.result.trades ?? []
  if (trades.length === 0) return '<p class="note">无成交</p>'
  const rows = trades.slice(0, MAX_TRADE_ROWS).map((t) => [
    `<span class="mono">${esc(fmtTime(t.t))}</span>`,
    t.side === 'buy' ? '买入' : '卖出',
    esc(fmtMoney(t.price, 4)),
    esc(fmtMoney(t.size, 6)),
    esc(fmtMoney(t.pnl)),
    esc(fmtMoney(t.fee, 4)),
    esc(t.reason ?? ''),
  ])
  const more = trades.length > MAX_TRADE_ROWS ? `<p class="note">共 ${trades.length} 笔成交，表格只列前 ${MAX_TRADE_ROWS} 笔。</p>` : ''
  return table(['时间', '方向', '价格', '数量', '盈亏', '手续费', '原因'], rows, [2, 3, 4, 5]) + more
}

function evidenceSection(input: ReportInput): string {
  if (input.evidence === undefined) return '<p class="note">未附带证据摘要</p>'
  const e = input.evidence
  const rows: string[][] = [
    ['收益期数', String(e.periods)],
    ['期长', esc(fmtDuration(e.periodMs))],
    ['每年期数', e.periodsPerYear.toFixed(2)],
    ['每期夏普', e.sharpe.toFixed(4)],
    ['年化夏普', e.sharpeAnnualized.toFixed(4)],
    ['PSR', e.psr === null ? '—' : `${fmtPct(e.psr)}%`],
    ['DSR', e.dsr === null ? '—' : `${fmtPct(e.dsr)}%`],
    ['偏度 / 峰度', `${e.skewness.toFixed(4)} / ${e.kurtosis.toFixed(4)}`],
    ['夏普 95% 区间', e.sharpeCi95 === null ? '—' : `${e.sharpeCi95[0].toFixed(4)} … ${e.sharpeCi95[1].toFixed(4)}`],
    ['试验次数', String(e.trialCount)],
  ]
  if (e.warnings.length > 0) rows.push(['告警', esc(e.warnings.join('; '))])
  return table(['项', '取值'], rows, [1])
}

function monthlyTable(metrics: ReportMetrics): string {
  if (metrics.monthly.length === 0) return '<p class="note">无月度数据</p>'
  const rows = metrics.monthly.map((m) => [`<span class="mono">${esc(m.key)}</span>`, `${fmtPct(m.ret, 2)}%`, String(m.points)])
  return table(['月份', '收益', '权益点数'], rows, [1, 2])
}

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/ai_report_pdf.py:925-1068; adapted.
// 同上：只照抄章节顺序，图形是内联 SVG 不是 PDF 版式。
/** 自包含 HTML 报告（单文件）。 */
export function renderHtml(input: ReportInput, metricsIn?: ReportMetrics): string {
  const { result } = input
  const metrics = metricsIn ?? computeReportMetrics(input)
  const head = headlineMetrics(metrics)
  const digest = reportDigest(result)
  const equity = result.equity ?? []
  const initial = equity.length > 0 ? equity[0]!.v : result.stats.finalEquity ?? 0
  const spanMs = equity.length > 1 ? equity[equity.length - 1]!.t - equity[0]!.t : 0
  const title = input.title ?? '回测报告'

  const metricRows = metrics.rows.map((row) => [
    esc(row.label),
    `<span class="mono">${esc(row.value)}</span>`,
    esc(row.unit ?? ''),
    row.source === 'stats' ? '统计' : '算术',
  ])
  const riskRows: string[][] = [
    ['最大回撤', withPercent(metrics.rows.find((r) => r.key === 'max_drawdown')?.value ?? '—')],
    ['最大连续亏损笔数', metrics.rows.find((r) => r.key === 'max_consecutive_losses')?.value ?? '—'],
    ['持仓时间占比', withPercent(metrics.rows.find((r) => r.key === 'exposure')?.value ?? '—')],
  ]
  if (result.stats.liquidations !== undefined) riskRows.push(['强平次数', String(result.stats.liquidations)])
  if (result.stats.protectionExits !== undefined) riskRows.push(['保护规则出场', String(result.stats.protectionExits)])

  const warnings: string[] = []
  if (result.warnings !== undefined) warnings.push(...result.warnings)
  for (const w of metrics.warnings) if (!warnings.includes(w)) warnings.push(w)

  const parts: string[] = []
  parts.push('<!doctype html>')
  parts.push('<html lang="zh-CN"><head><meta charset="utf-8">')
  parts.push('<meta name="viewport" content="width=device-width, initial-scale=1">')
  parts.push(`<title>${esc(title)}</title>`)
  parts.push(`<style>${CSS}</style>`)
  parts.push('</head><body><div class="wrap">')
  parts.push(`<h1>${esc(title)}</h1>`)
  parts.push(`<p class="meta">生成时间 ${esc(fmtTime(input.generatedAt ?? 0))} · 引擎 ${esc(result.engine ? `${result.engine.id} ${result.engine.version}` : '未记录')} · 数据摘要 sha256 <span class="mono">${esc(digest)}</span></p>`)
  parts.push(`<p class="disclaimer">${esc(DISCLAIMER)}</p>`)

  parts.push(
    section(
      '摘要',
      `<div class="cards">
        <div class="card"><div class="k">总收益</div><div class="v">${esc(withPercent(head.totalReturn))}</div></div>
        <div class="card"><div class="k">最大回撤</div><div class="v">${esc(withPercent(head.maxDrawdown))}</div></div>
        <div class="card"><div class="k">夏普比率</div><div class="v">${esc(head.sharpe)}</div></div>
        <div class="card"><div class="k">平仓笔数</div><div class="v">${esc(head.trades)}</div></div>
      </div>
      <p class="note">成交 ${(result.trades ?? []).length} 笔 · 权益点 ${equity.length} 个 · 跨度 ${esc(fmtDuration(spanMs))}${result.trialCount !== undefined && result.trialCount > 1 ? ` · 参数试验 ${result.trialCount} 次` : ''}</p>`,
    ),
  )

  parts.push(section('数据质量与假设', assumptionTable(input) + (warnings.length > 0 ? `<p class="note warn" style="padding:8px 10px;border-radius:6px">告警：${esc(warnings.join('；'))}</p>` : '')))
  parts.push(section('指标', table(['指标', '数值', '单位', '口径'], metricRows, [1])))
  parts.push(
    section(
      '曲线与月度收益',
      equityChartSvg(equity, { limit: CHART_SAMPLE_LIMIT, initial }) +
        `<p class="note">权益曲线（${Math.min(equity.length, CHART_SAMPLE_LIMIT)} 点显示，保留端点与最大回撤区间）</p>` +
        drawdownChartSvg(equity, { limit: CHART_SAMPLE_LIMIT, initial }) +
        '<p class="note">回撤曲线（相对历史峰值）</p>' +
        monthlyHeatmapSvg(metrics.monthly) +
        '<p class="note">月度收益热力表（UTC 自然月，月末权益环比）</p>' +
        monthlyTable(metrics),
    ),
  )
  parts.push(section('风险', table(['项', '取值'], riskRows, [1])))
  parts.push(section('参数', paramTable(input)))
  parts.push(section(`交易明细（最多 ${MAX_TRADE_ROWS} 行）`, tradeTable(input)))
  parts.push(section('证据摘要', evidenceSection(input)))
  parts.push(
    section(
      '方法',
      `<ul class="note">
        <li>统计类指标取自 @gitrader/stats 与结果自带统计块，其余为报告层算术；「口径」列已逐行标注。</li>
        <li>胜率 / 盈利因子 / 连续盈亏笔数的分母是平仓成交（由逐笔成交重建仓位切出）。</li>
        <li>持仓时间占比 = 持仓区间总时长 / 权益曲线跨度；成交额合计 = Σ 价格 × 数量；换手率 = 成交额 / 起算权益。</li>
        <li>信息比率仅在给出基准曲线时计算，口径照 QuantDinger metrics.calculate_information_ratio。</li>
        <li>图表为内联 SVG，无脚本、无外部字体、无外链资源。</li>
        <li>数据摘要 sha256：<span class="mono">${esc(digest)}</span></li>
      </ul>`,
    ),
  )
  parts.push(`<p class="disclaimer">${esc(DISCLAIMER)}</p>`)
  parts.push(`<p class="foot">${esc(fmtDate(equity[0]?.t))} → ${esc(fmtDate(equity[equity.length - 1]?.t))} · 由 Gitrader 报告导出生成</p>`)
  parts.push('</div></body></html>')
  return parts.join('\n')
}

/** 同一份输入下 Markdown 与 HTML 的内容必须一致（CLI 用它对账，测试也用它）。 */
export function renderBoth(input: ReportInput): { markdown: string; html: string } {
  const metrics = computeReportMetrics(input)
  return { markdown: renderMarkdown(input, metrics), html: renderHtml(input, metrics) }
}
