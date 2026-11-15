// SPDX-License-Identifier: CPAL-1.0
// 把对账结果渲染成人看的纯文本（工作台 / 终端 / 日志都能直接用）。
//
// 只做呈现，不做判定：所有结论与建议都来自 reconcile() 的 Finding，
// 这里不再补任何「应该没事吧」式的口头结论。
import type { Finding, ReconcileReport } from './types'

export interface RenderOptions {
  /** 最多列出多少条差异（其余只给条数）。 */
  maxFindings?: number
  /** 是否逐条列证据（默认列出需人工的那些）。 */
  includeEvidenceFor?: 'needs_human' | 'all' | 'none'
  /** 标题里用的场所名（可选，只影响可读性）。 */
  venueLabel?: string
}

const SEVERITY_LABEL: Record<Finding['severity'], string> = { blocker: '阻断', warn: '注意', info: '提示' }
const VERDICT_LABEL: Record<ReconcileReport['verdict'], string> = {
  clean: '无差异',
  attention: '有需要注意的差异',
  blocked: '有阻断差异，先处理再交易',
}

function iso(ms: number): string {
  return new Date(ms).toISOString()
}

function subjectLine(finding: Finding): string {
  const parts = [finding.subject.instrumentId, finding.subject.orderId, finding.subject.clientOrderId, finding.subject.venueOrderId, finding.subject.venueFillId]
    .filter((x): x is string => typeof x === 'string' && x !== '')
  return parts.length > 0 ? parts.join(' · ') : '（账户级）'
}

function formatFinding(finding: Finding, showEvidence: boolean): string[] {
  const lines = [
    `[${SEVERITY_LABEL[finding.severity]}] ${finding.code} · ${subjectLine(finding)}`,
    `  说明：${finding.detail}`,
    `  建议：${finding.advice.action}${finding.advice.requiresHuman ? '（需人工确认）' : ''} —— ${finding.advice.why}`,
  ]
  if (finding.inferred === true && finding.basis && finding.basis.length > 0) {
    lines.push('  推断依据：')
    for (const item of finding.basis) lines.push(`    · ${item}`)
  }
  if (finding.tags && finding.tags.length > 0) lines.push(`  标记：${finding.tags.join(', ')}`)
  if (showEvidence) {
    for (const e of finding.evidence) lines.push(`  证据：${e.report}[${e.id}].${e.field} = ${e.value}`)
  }
  return lines
}

/** 渲染对账报告。返回逐行文本，调用方自行决定写日志还是显示在界面。 */
export function renderReport(report: ReconcileReport, options: RenderOptions = {}): string {
  const maxFindings = options.maxFindings ?? 50
  const evidenceMode = options.includeEvidenceFor ?? 'needs_human'
  const lines: string[] = []
  const c = report.coverage
  const n = report.counts
  lines.push(`对账报告 · ${report.accountId}${options.venueLabel ? ` · ${options.venueLabel}` : ''} · ${VERDICT_LABEL[report.verdict]}`)
  lines.push(`生成时刻：${iso(report.generatedAt)}`)
  lines.push(`覆盖：本地 ${c.localOrders} 单 / ${c.localFills} 成交 / ${c.localPositions} 持仓；场所 ${c.venueOpenOrders} 挂单 / ${c.venueHistoryOrders} 历史订单 / ${c.venueFills} 成交 / ${c.venuePositions} 持仓；场所视图 ${c.venueAgeMs} ms 前`)
  lines.push(`差异：${n.findings} 条（阻断 ${n.blocker} / 注意 ${n.warn} / 提示 ${n.info}），其中需人工 ${n.needsHuman}；推断成交 ${n.inferredFills} 条；重复到达 ${n.duplicateFills} 组；同号冲突 ${n.conflictingFills} 组`)
  if (report.findings.length === 0) {
    lines.push('', '两侧视图一致：没有发现差异。')
  } else {
    lines.push('', '差异清单：')
    const shown = report.findings.slice(0, maxFindings)
    for (const finding of shown) {
      const showEvidence = evidenceMode === 'all' || (evidenceMode === 'needs_human' && finding.advice.requiresHuman)
      lines.push(...formatFinding(finding, showEvidence))
    }
    if (report.findings.length > shown.length) lines.push(`……其余 ${report.findings.length - shown.length} 条未列出（只给出条数，避免刷屏）`)
  }
  if (report.inferredFills.length > 0) {
    lines.push('', '推断成交（全部标 inferred，须人工确认后才能入账）：')
    for (const fill of report.inferredFills) {
      lines.push(`- ${fill.instrumentId} ${fill.side} ${fill.size} @ ${fill.price} · 场所单号 ${fill.venueOrderId} · 定价来源 ${fill.priceSource}`)
      for (const item of fill.basis) lines.push(`    · ${item}`)
    }
  }
  const multiId = report.links.filter((l) => l.venueOrderIds.length > 1)
  if (multiId.length > 0) {
    lines.push('', '改单后的单号链（客户端单号 → 场所单号）：')
    for (const link of multiId) {
      const flags = [link.ambiguous ? '有歧义' : '', link.broken ? '链断' : ''].filter((x) => x !== '').join('、')
      lines.push(`- ${link.clientOrderId}: ${link.venueOrderIds.join(' → ')}${flags === '' ? '' : `（${flags}）`}`)
    }
  }
  lines.push('', `容差：时钟偏差 ${report.options.clockSkewMs} ms、场所延迟 ${report.options.venueLatencyMs} ms、数量容差 ${report.options.sizeTolerance}、持仓容差 ${report.options.positionTolerance}、均价容差 ${report.options.priceToleranceBps} bp、回补窗口 ${report.options.fillLookbackMs} ms、新鲜度阈值 ${report.options.staleAfterMs} ms`)
  return lines.join('\n')
}
