// SPDX-License-Identifier: CPAL-1.0
// 对账主入口：把两侧视图 → 差异 + 建议。
//
// 这个函数是纯的：
//   · 不读系统时钟（时间一律取 options.now）；
//   · 不读写文件、不发请求、不碰全局状态；
//   · 输入对象一个字段都不改（返回值是新建的对象），所以调用方可以放心把账本快照直接递进来。
// 它也不改账：输出里只有 Finding（差异 + 建议动作 + 证据）。改账由内核按人定的规则执行。
import { classifyFills, inferredSizeByInstrument } from './fills'
import { buildLinkIndex } from './links'
import type { LinkIndex } from './links'
import { classifyOrders } from './orders'
import { classifyPositions } from './positions'
import { isStale, resolveOptions, type ResolvedOptions } from './tolerance'
import type {
  Evidence, Finding, ReconcileCoverage, ReconcileCounts, ReconcileInput, ReconcileOptions, ReconcileReport, VenueReportKind, Verdict,
} from './types'
import { isDecimalString } from './decimal'

const SEVERITY_RANK: Record<Finding['severity'], number> = { blocker: 0, warn: 1, info: 2 }

/** 输入自检：数量 / 价格必须是十进制字符串，时间必须是有限数字。映射写错时立刻报错，不静默产出错结论。 */
export function validateInput(input: ReconcileInput): void {
  const bad = (what: string, value: unknown): never => {
    throw new TypeError(`${what} must be ${typeof value === 'number' ? 'a finite epoch-ms number' : 'a decimal string'}: ${JSON.stringify(value)}`)
  }
  if (input.local.accountId === '') bad('local.accountId', input.local.accountId)
  for (const o of input.local.orders) {
    if (!isDecimalString(o.size)) bad(`local.orders[${o.orderId}].size`, o.size)
    if (!isDecimalString(o.filledSize)) bad(`local.orders[${o.orderId}].filledSize`, o.filledSize)
    if (!Number.isFinite(o.createdAt)) bad(`local.orders[${o.orderId}].createdAt`, o.createdAt)
  }
  for (const f of input.local.fills) {
    if (!isDecimalString(f.size)) bad(`local.fills[${f.venueFillId}].size`, f.size)
    if (!isDecimalString(f.price)) bad(`local.fills[${f.venueFillId}].price`, f.price)
    if (!Number.isFinite(f.ts)) bad(`local.fills[${f.venueFillId}].ts`, f.ts)
  }
  for (const p of input.local.positions) {
    if (!isDecimalString(p.size)) bad(`local.positions[${p.instrumentId}].size`, p.size)
  }
  for (const o of input.venue.openOrders) {
    if (o.filledSize !== undefined && !isDecimalString(o.filledSize)) bad(`venue.openOrders[${o.venueOrderId}].filledSize`, o.filledSize)
    if (o.price != null && !isDecimalString(o.price)) bad(`venue.openOrders[${o.venueOrderId}].price`, o.price)
  }
  for (const o of input.venue.historyOrders ?? []) {
    if (o.filledSize !== undefined && !isDecimalString(o.filledSize)) bad(`venue.historyOrders[${o.venueOrderId}].filledSize`, o.filledSize)
  }
  for (const f of input.venue.fills) {
    if (!isDecimalString(f.size)) bad(`venue.fills[${f.venueFillId}].size`, f.size)
    if (!isDecimalString(f.price)) bad(`venue.fills[${f.venueFillId}].price`, f.price)
    if (!Number.isFinite(f.ts)) bad(`venue.fills[${f.venueFillId}].ts`, f.ts)
  }
  for (const p of input.venue.positions) {
    if (!isDecimalString(p.size)) bad(`venue.positions[${p.instrumentId}].size`, p.size)
  }
  if (!Number.isFinite(input.venue.asOf)) bad('venue.asOf', input.venue.asOf)
  if (!Number.isFinite(input.local.asOf)) bad('local.asOf', input.local.asOf)
}

function coverageFindings(input: ReconcileInput, opts: ResolvedOptions): Finding[] {
  const accountId = input.local.accountId
  const findings: Finding[] = []
  const unavailable = [...(input.venue.unavailable ?? [])]
  for (const kind of ['openOrders', 'historyOrders', 'fills', 'positions'] as VenueReportKind[]) {
    if (!unavailable.includes(kind)) continue
    findings.push({
      code: 'venue_report_unavailable',
      severity: 'warn',
      subject: { accountId },
      detail: `场所本次给不出 ${kind} 报告：相关结论只能停在「需要人工」，不能当成「场所没有」`,
      advice: {
        action: 'informational',
        why: '该场所 / 该连接器不提供这类报告，任何「场所没有」的结论都不成立。',
        requiresHuman: true,
      },
      evidence: [{ report: 'options', id: 'venue.unavailable', field: kind, value: 'true' }],
      tags: ['coverage_limited', kind],
    })
  }
  if (isStale(input.venue.asOf, opts)) {
    findings.push({
      code: 'snapshot_stale',
      severity: 'warn',
      subject: { accountId },
      detail: `场所视图生成于 ${opts.now - input.venue.asOf} ms 前，超过新鲜度阈值 ${opts.staleAfterMs} ms`,
      advice: { action: 'wait_and_recheck', why: '场所视图太旧，基于它得出的「已完成 / 未记账」结论不可靠，先刷新再判。', requiresHuman: true },
      evidence: [{ report: 'options', id: 'venue.asOf', field: 'ageMs', value: String(opts.now - input.venue.asOf) }],
    })
  }
  if (isStale(input.local.asOf, opts)) {
    findings.push({
      code: 'snapshot_stale',
      severity: 'warn',
      subject: { accountId },
      detail: `账本视图生成于 ${opts.now - input.local.asOf} ms 前，超过新鲜度阈值 ${opts.staleAfterMs} ms`,
      advice: { action: 'wait_and_recheck', why: '账本视图太旧，差异可能只是没落盘，刷新后再对一次。', requiresHuman: true },
      evidence: [{ report: 'options', id: 'local.asOf', field: 'ageMs', value: String(opts.now - input.local.asOf) }],
    })
  }
  if (input.venue.truncated === true) {
    findings.push({
      code: 'venue_fills_truncated',
      severity: 'warn',
      subject: { accountId },
      detail: '成交回补被场所条数上限截断：更早的成交可能没取到，缺口推断会偏大',
      advice: {
        action: 'query_order_status',
        why: '成交列表被截断时，「账本少记了成交」可能只是回补没取全；先按订单号查详情再改账。',
        requiresHuman: true,
      },
      evidence: [{ report: 'options', id: 'venue.truncated', field: 'truncated', value: 'true' }],
    })
  }
  return findings
}

function sortFindings(findings: readonly Finding[]): Finding[] {
  return [...findings].sort((a, b) => {
    const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
    if (bySeverity !== 0) return bySeverity
    if (a.code !== b.code) return a.code < b.code ? -1 : 1
    const keyOf = (f: Finding): string => [f.subject.instrumentId ?? '', f.subject.orderId ?? '', f.subject.clientOrderId ?? '', f.subject.venueOrderId ?? '', f.subject.venueFillId ?? ''].join('|')
    const ka = keyOf(a)
    const kb = keyOf(b)
    return ka < kb ? -1 : ka > kb ? 1 : 0
  })
}

function countFindings(findings: readonly Finding[]): ReconcileCounts {
  return {
    findings: findings.length,
    blocker: findings.filter((f) => f.severity === 'blocker').length,
    warn: findings.filter((f) => f.severity === 'warn').length,
    info: findings.filter((f) => f.severity === 'info').length,
    needsHuman: findings.filter((f) => f.advice.requiresHuman).length,
    inferredFills: findings.filter((f) => f.code === 'fill_missing_inferred').length,
    duplicateFills: findings.filter((f) => f.code === 'fill_duplicate').length,
    conflictingFills: findings.filter((f) => f.code === 'fill_conflict').length,
  }
}

function verdictOf(counts: ReconcileCounts): Verdict {
  if (counts.blocker > 0) return 'blocked'
  if (counts.warn > 0 || counts.needsHuman > 0) return 'attention'
  return 'clean'
}

/** 对账主函数。 */
export function reconcile(input: ReconcileInput, options: ReconcileOptions): ReconcileReport {
  validateInput(input)
  const opts = resolveOptions(options)
  const index: LinkIndex = buildLinkIndex(input)
  const unavailable = (input.venue.unavailable ?? []).slice()
  const coverageBase = {
    openOrdersAvailable: !unavailable.includes('openOrders'),
    historyAvailable: input.venue.historyOrders !== undefined && !unavailable.includes('historyOrders'),
    fillsAvailable: !unavailable.includes('fills'),
  }

  const orders = classifyOrders(input, index, opts, coverageBase)
  const fills = classifyFills(input, index, opts, { fillsAvailable: coverageBase.fillsAvailable })
  const inferredNet = [...inferredSizeByInstrument(fills.inferredFills)].map(([instrumentId, signedSize]) => ({ instrumentId, signedSize }))
  const positions = classifyPositions(input, opts, inferredNet)
  const findings = sortFindings([
    ...coverageFindings(input, opts),
    ...orders.findings,
    ...fills.findings,
    ...positions,
  ])
  const counts = countFindings(findings)
  const coverage: ReconcileCoverage = {
    localOrders: input.local.orders.length,
    localFills: input.local.fills.length,
    localPositions: input.local.positions.length,
    venueOpenOrders: input.venue.openOrders.length,
    venueHistoryOrders: input.venue.historyOrders?.length ?? 0,
    venueFills: input.venue.fills.length,
    venuePositions: input.venue.positions.length,
    venueAgeMs: opts.now - input.venue.asOf,
    truncated: input.venue.truncated === true,
    unavailable,
  }
  const exportedOptions: Required<ReconcileOptions> = {
    now: opts.now,
    clockSkewMs: opts.clockSkewMs,
    venueLatencyMs: opts.venueLatencyMs,
    sizeTolerance: opts.sizeTolerance,
    positionTolerance: opts.positionTolerance,
    priceToleranceBps: opts.priceToleranceBps,
    fillLookbackMs: opts.fillLookbackMs,
    staleAfterMs: opts.staleAfterMs,
    ownClientOrderIdPrefixes: [...opts.ownClientOrderIdPrefixes],
    dedupeFallback: opts.dedupeFallback,
  }
  return {
    accountId: input.local.accountId,
    generatedAt: opts.now,
    verdict: verdictOf(counts),
    findings,
    links: index.resolutions,
    inferredFills: fills.inferredFills,
    dedupe: fills.dedupe,
    needsHuman: findings.filter((f) => f.advice.requiresHuman),
    counts,
    coverage,
    options: exportedOptions,
  }
}

/** 只看某一类差异（渲染 / 人机界面按类分组用）。 */
export function findingsByCode(report: ReconcileReport, code: Finding['code']): Finding[] {
  return report.findings.filter((f) => f.code === code)
}

/** 取某条差异的全部证据（便于界面点开一条差异看依据）。 */
export function evidenceOf(finding: Finding): Evidence[] {
  return finding.evidence
}
