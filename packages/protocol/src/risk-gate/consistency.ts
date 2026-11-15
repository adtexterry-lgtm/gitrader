// SPDX-License-Identifier: Apache-2.0
import { RULE_CODES } from '../model/problem'
import { isDecimal } from '../model/decimal'
import type { GateDecision } from '../model/risk'

/** 返回 GateDecision 固定三值映射中的结构问题；不改变或补全判定。 */
export function checkGateDecisionConsistency(d: GateDecision): string[] {
  const problems: string[] = []
  const realAdjustments = d.applied.filter((adjustment) => adjustment.kind !== 'warning')

  d.applied.forEach((adjustment, index) => {
    const kind = (adjustment as { kind?: unknown }).kind
    if (kind === 'warning') {
      if (adjustment.field !== 'markPrice') problems.push(`applied[${index}] warning field must be markPrice`)
      if (adjustment.code !== 'STALE_PRICE') problems.push(`applied[${index}] warning code must be STALE_PRICE`)
      const { from, to } = adjustment
      if (!isDecimal(from) || !isDecimal(to) || from === '0' || from.startsWith('-') || from !== to) {
        problems.push(`applied[${index}] warning from/to must be equal positive Decimal values`)
      }
      if (typeof adjustment.unit !== 'string' || adjustment.unit.length === 0) {
        problems.push(`applied[${index}] warning unit must be a quote currency`)
      }
      if (!d.ruleHits.some((hit) => hit.ruleId === adjustment.ruleId && hit.code === adjustment.code && hit.action === 'warn')) {
        problems.push(`applied[${index}] warning requires a matching warn rule hit`)
      }
    } else {
      if (kind !== undefined) problems.push(`applied[${index}] has an unknown kind`)
      if (adjustment.field === 'markPrice') problems.push(`applied[${index}] markPrice requires kind warning`)
    }
  })

  if (d.decision === 'ALLOW') {
    if (d.verdict !== 'allow') problems.push(`decision ALLOW is inconsistent with verdict ${d.verdict}`)
    if (realAdjustments.length !== 0) problems.push('ALLOW requires an empty applied list')
    if (d.targetDigest !== d.adjustedTargetDigest) problems.push('ALLOW requires targetDigest and adjustedTargetDigest to match')
  } else if (d.decision === 'LIMIT') {
    if (d.verdict !== 'allow') problems.push(`decision LIMIT is inconsistent with verdict ${d.verdict}`)
    if (realAdjustments.length === 0) problems.push('LIMIT requires a nonempty applied list')
    if (!d.ruleHits.some((hit) => hit.action === 'limit')) problems.push('LIMIT requires at least one limit rule hit')
  } else if (d.decision === 'BLOCK') {
    if (d.verdict !== 'deny' && d.verdict !== 'review') problems.push(`decision BLOCK is inconsistent with verdict ${d.verdict}`)
  } else {
    problems.push(`unknown gate decision ${String(d.decision)}`)
  }

  if (d.verdict === 'allow' && d.ruleHits.some((hit) => hit.action === 'deny')) {
    problems.push('allow verdict cannot include deny rule hits')
  }

  if (d.verdict === 'review') {
    if (!d.escalation) problems.push('review verdict requires human_approval escalation')
    else {
      if (d.escalation.to !== 'human_approval') problems.push('review escalation target must be human_approval')
      if (!(RULE_CODES as readonly string[]).includes(d.escalation.reason)) problems.push('review escalation reason must be a RuleCode')
    }
  } else if (d.escalation !== undefined) {
    problems.push('non-review verdict cannot have escalation')
  }

  d.monitorHits.forEach((hit, index) => {
    if (hit.action !== 'warn') problems.push(`monitorHits[${index}].action must be warn; got ${hit.action}`)
  })

  return problems
}
