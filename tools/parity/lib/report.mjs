// SPDX-License-Identifier: CPAL-1.0
// 差异表渲染：Markdown（给人）与 JSON（给脚本）。列固定，行序即 diff 计算顺序。
// 表格列：序号 | 类别 | 键 | 字段 | 回测 | 纸面 | 差异 | 严重度 | 判读

import { severityText } from './diff.mjs'

const COLUMNS = ['序号', '类别', '键', '字段', '回测', '纸面', '差异', '严重度', '判读']
const KIND_TEXT = { orders: '订单序列', fills: '成交序列', equity: '最终权益', capability: '能力声明' }

const cell = (v) => {
  if (v === null || v === undefined || v === '') return '—'
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Number(v.toFixed(10)))
  const s = String(v)
  return s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}

export function renderMarkdown({ diff, backtest, paper, preflight, meta = {} }) {
  const out = []
  out.push('# 回测—纸面一致性差异表')
  out.push('')
  out.push(`生成：${meta.generatedAt ?? '（未注明时间）'}　格式版本：${meta.format ?? 'gitrader-parity-diff/1'}`)
  out.push('')
  out.push('| 项目 | 回测侧 | 纸面侧 |')
  out.push('|---|---|---|')
  out.push(`| 运行记录 | ${cell(backtest?.runId)} | ${cell(paper?.runId)} |`)
  out.push(`| 数据来源 | ${cell(backtest?.source?.kind)} | ${cell(paper?.source?.kind)} |`)
  out.push(`| 时钟 | ${cell(backtest?.clock?.mode)} | ${cell(paper?.clock?.mode)} |`)
  out.push(`| 标的 / 周期 | ${cell(`${backtest?.instrument ?? '—'} / ${backtest?.interval ?? '—'}`)} | ${cell(`${paper?.instrument ?? '—'} / ${paper?.interval ?? '—'}`)} |`)
  out.push(`| 最终权益 | ${cell(backtest?.finalEquity)} | ${cell(paper?.finalEquity)} |`)
  out.push('')

  if (preflight) {
    out.push(`## 能力预检：${preflight.verdict === 'ok' ? '可跑（两侧都能用历史数据 + 模拟时钟）' : '停机（纸面侧没有历史回放入口）'}`)
    out.push('')
    out.push('| 检查项 | 结果 | 证据 |')
    out.push('|---|---|---|')
    for (const c of preflight.checks) out.push(`| ${cell(c.id)} | ${c.ok ? '通过' : '缺失'} | ${cell(c.evidence)} |`)
    out.push('')
    if (preflight.missing?.length) {
      out.push('### 缺什么')
      out.push('')
      for (const m of preflight.missing) out.push(`- **${m.what}** —— 建议位置：\`${m.where}\`。理由：${m.why}`)
      out.push('')
    }
  }

  out.push(`## 差异（${diff.summary.total} 行：阻断 ${diff.summary.bySeverity.blocking} / 应修 ${diff.summary.bySeverity.fix} / 备注 ${diff.summary.bySeverity.note}；判定：${diff.summary.verdict}）`)
  out.push('')
  out.push(`| ${COLUMNS.join(' | ')} |`)
  out.push(`|${COLUMNS.map(() => '---').join('|')}|`)
  if (diff.rows.length === 0) out.push(`| — | — | — | — | — | — | — | — | 无差异行 |`)
  for (const r of diff.rows) {
    out.push(`| ${[
      r.n, KIND_TEXT[r.kind] ?? r.kind, r.key, r.field,
      cell(r.backtest), cell(r.paper), cell(r.delta), severityText(r.severity), cell(r.judgement),
    ].join(' | ')} |`)
  }
  out.push('')

  const tol = diff.tolerances ?? {}
  out.push(`容差：价格 ${tol.priceEpsAbs}、数量 ${tol.sizeEpsAbs}、费用 ${tol.feeEpsAbs}、权益 ${tol.equityEpsAbs}（或 ${tol.equityEpsPct} 相对）、成交时刻 ${tol.timeToleranceMs} ms。`)
  out.push('')
  out.push('判读口径：`阻断` = 一致性结论不成立（缺单 / 缺成交 / 成交价或数量不同 / 最终权益超出容差）；`应修` = 口径差（费用、精度、状态语义）；`备注` = 时间基或信息级；`能力声明` 行的意思是**无法核对**，不是一致。')
  out.push('')
  const notes = [...(backtest?.notes ?? []).map((x) => `- 回测侧：${x}`), ...(paper?.notes ?? []).map((x) => `- 纸面侧：${x}`)]
  if (notes.length) {
    out.push('## 两侧自述的已知口径')
    out.push('')
    out.push(...notes)
    out.push('')
  }
  return out.join('\n')
}

export function toJson({ diff, backtest, paper, preflight, meta = {} }) {
  return {
    format: meta.format ?? 'gitrader-parity-diff/1',
    generatedAt: meta.generatedAt ?? null,
    preflight: preflight ?? null,
    summary: diff.summary,
    tolerances: diff.tolerances,
    rows: diff.rows,
    sides: {
      backtest: backtest ? { runId: backtest.runId, source: backtest.source, clock: backtest.clock, finalEquity: backtest.finalEquity, capabilities: backtest.capabilities, notes: backtest.notes } : null,
      paper: paper ? { runId: paper.runId, source: paper.source, clock: paper.clock, finalEquity: paper.finalEquity, capabilities: paper.capabilities, notes: paper.notes } : null,
    },
  }
}
