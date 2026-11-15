// SPDX-License-Identifier: Apache-2.0
import type { Ms } from '../model/decimal'
import type { AccountId, Sha256Digest } from '../model/ids'
import type { Experiment, ExperimentStage } from '../model/signal'
import {
  EXPERIMENT_APPEND_ONLY_FIELDS,
  EXPERIMENT_READONLY_FIELDS,
  EXPERIMENT_STAGE_ALIASES,
  EXPERIMENT_STAGE_ORDER,
  type BacktestEvidencePack,
  type EvidencePack,
  type EvidencePackRef,
  type ExperimentTransitionEvidence,
  type ForwardEvidencePack,
} from '../model/experiment'
import { missingBacktestAssumptions } from '../gep/backtest'
import { canonicalize } from '../ledger/canonicalize'

type Missing = Set<string>

export function resolveAlias(stage: ExperimentStage): ExperimentStage {
  return EXPERIMENT_STAGE_ALIASES[stage as keyof typeof EXPERIMENT_STAGE_ALIASES] ?? stage
}

export function stageOrder(stage: ExperimentStage): number {
  const normalized = resolveAlias(stage)
  if (normalized === 'review' || normalized === 'closed') return -1
  return EXPERIMENT_STAGE_ORDER.indexOf(normalized as (typeof EXPERIMENT_STAGE_ORDER)[number])
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (!isRecord(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
const add = (missing: Missing, value: string): void => { missing.add(value) }
const result = (missing: Missing): { ok: boolean; missing: string[] } => {
  const paths = [...missing].sort()
  return { ok: paths.length === 0, missing: paths }
}
const isMainline = (stage: ExperimentStage): boolean => stageOrder(stage) >= 0

function linkedPack(exp: Experiment, pack: EvidencePack): boolean {
  if (pack.experimentId !== exp.experimentId) return false
  const digest = pack.attestation?.digest
  if (!digest) return false
  return (exp.packs ?? []).some((ref: EvidencePackRef) =>
    ref.packId === pack.packId && ref.kind === pack.kind && ref.tier === pack.tier && ref.at === pack.at &&
    ref.digest === digest && (ref.runId === undefined || ref.runId === pack.runId),
  )
}

function currentPack(exp: Experiment, pack: EvidencePack, now: Ms): boolean {
  return linkedPack(exp, pack) && Number.isInteger(exp.stageEnteredAt) && Number.isInteger(pack.at) &&
    (exp.stageEnteredAt as number) <= pack.at && pack.at <= now
}

function linkedPacks(exp: Experiment, evidence: ExperimentTransitionEvidence, now: Ms): EvidencePack[] {
  return evidence.packs.filter((pack) => currentPack(exp, pack, now))
}

function isRunTableMatch(exp: Experiment, pack: EvidencePack, evidence: ExperimentTransitionEvidence): boolean {
  return evidence.labRuns.some((run) => run.runId === pack.runId && run.experimentId === exp.experimentId && run.kind === 'backtest' && run.status === 'done')
}

function validPaperRun(exp: Experiment, runId: string, evidence: ExperimentTransitionEvidence, now: Ms): NonNullable<Experiment['runs']>[number] | undefined {
  return (exp.runs ?? []).find((run) => {
    if (run.runId !== runId || !run.executor || run.attachedAt === undefined || run.accountId === undefined) return false
    if (!Number.isInteger(run.attachedAt) || run.attachedAt > now || (run.to !== null && run.to < now)) return false
    return evidence.accounts.some((account) => account.accountId === run.accountId && account.mode === 'paper')
  })
}

function sameWindow(a: { from: number; to: number }, b: { from: number; to: number }): boolean {
  return a.from === b.from && a.to === b.to
}

function sameJson(a: unknown, b: unknown): boolean {
  try {
    return canonicalize(a) === canonicalize(b)
  } catch {
    return false
  }
}

function llmPath(exp: Experiment, currentPacks: EvidencePack[]): boolean {
  if (exp.llm?.involved !== true) return false
  if (!currentPacks.some((pack) => pack.kind === 'backtest')) return true
  return currentPacks.some((pack) => pack.kind === 'backtest' && pack.llm.contaminated !== 'no')
}

function matchingHoldoutPair(exp: Experiment, backtest: BacktestEvidencePack, holdout: BacktestEvidencePack): boolean {
  return !!exp.holdoutWindow && sameWindow(holdout.window, exp.holdoutWindow) &&
    holdout.at >= backtest.at &&
    sameJson(holdout.spec.assumptions, backtest.spec.assumptions) && holdout.seed === backtest.seed &&
    holdout.subjectKey === backtest.subjectKey && holdout.subjectKey === exp.subjectKey && holdout.data.pointInTime === true &&
    holdout.biasChecks.lookahead === 'pass' && holdout.llm.contaminated === 'no'
}

function presenceOkay(evidence: ExperimentTransitionEvidence, digest?: Sha256Digest): boolean {
  return evidence.presence?.verified === true && digest !== undefined && evidence.presence.forwardPackDigest === digest
}

function forwardCandidateMissing(
  exp: Experiment,
  pack: EvidencePack,
  evidence: ExperimentTransitionEvidence,
  now: Ms,
  requireReadiness: boolean,
): string[] {
  const missing: string[] = []
  if (pack.kind !== 'forward' || pack.tier !== 'forward_paper') {
    missing.push('forward.tier')
    return missing
  }
  const forward = (pack as ForwardEvidencePack).forward
  if (forward.tier !== 'forward_paper') missing.push('forward.tier')
  if (requireReadiness && forward.provisional) missing.push('forward.provisional')

  const runs = forward.runIds.map((runId) => validPaperRun(exp, runId, evidence, now))
  const runsValid = forward.runIds.length > 0 && runs.every((run) => run !== undefined)
  if (!runsValid) missing.push('forward.runs')
  const validRuns = runs.filter((run): run is NonNullable<typeof run> => run !== undefined)
  const expectedAccounts = [...new Set(validRuns.map((run) => run.accountId).filter((id): id is AccountId => id !== undefined))].sort()
  const actualAccounts = [...new Set(forward.accountIds)].sort()
  if (!runsValid || expectedAccounts.length !== actualAccounts.length || expectedAccounts.some((id, index) => id !== actualAccounts[index])) missing.push('forward.runs')

  if (!sameWindow(forward.window, pack.window)) missing.push('forward.window')
  if (requireReadiness) {
    const attachedAt = validRuns.map((run) => run.attachedAt as number)
    const start = Math.max(exp.stageEnteredAt as number, ...attachedAt)
    if (forward.window.from !== start || forward.window.to !== now || forward.computedAt !== now || pack.at !== now) missing.push('forward.window')
    if (forward.sample.spanDays < 30) missing.push('forward.spanDays')
    if (forward.sample.roundTrips < 30) missing.push('forward.roundTrips')
    if (forward.sample.activeDays < 10) missing.push('forward.activeDays')
    if (!forward.vsBaseline || !exp.baseline || forward.vsBaseline.baselineId !== exp.baseline.baselineId || !sameWindow(exp.baseline.window, forward.window)) missing.push('forward.baseline')
  }
  if (evidence.authorizationValid !== true) missing.push('authorization')
  if (evidence.riskPolicyValid !== true) missing.push('riskPolicy')
  if (evidence.parallelExperimentsDisclosed !== true) missing.push('parallelExperiments')
  if (evidence.actor.actorType !== 'human' || evidence.actor.via !== 'ui') missing.push('human.ui')
  if (!presenceOkay(evidence, pack.attestation.digest)) missing.push('presence')
  return missing
}

function transitionMissing(
  exp: Experiment,
  from: ExperimentStage,
  to: ExperimentStage,
  evidence: ExperimentTransitionEvidence,
  now: Ms,
): Set<string> {
  const missing = new Set<string>()
  const forward = stageOrder(from)
  const target = stageOrder(to)
  const allLinked = evidence.packs.filter((pack) => linkedPack(exp, pack))
  const current = linkedPacks(exp, evidence, now)

  if (evidence.actor.actorType !== 'human' &&
      !(exp.owner?.mandateId && evidence.actor.mandateId && exp.owner.mandateId === evidence.actor.mandateId && exp.owner.actorType === evidence.actor.actorType)) {
    add(missing, 'owner')
    return missing
  }
  if (!Number.isInteger(now) || (exp.stageEnteredAt !== undefined && (!Number.isInteger(exp.stageEnteredAt) || now < exp.stageEnteredAt))) add(missing, 'now')

  // closed is the true terminal: nothing leaves it, not even retirement (which would otherwise allow a reopen via hypothesis).
  if (from === 'closed') {
    add(missing, 'stage.closed')
    if (from === to) add(missing, 'stage.same')
    return missing
  }
  // Retirement is a side terminal: it never grants a mainline downgrade.
  if (to === 'retired') return missing
  if (from === 'retired') {
    if (to !== 'hypothesis') add(missing, 'stage.retired')
    return missing
  }
  if (from === to) add(missing, 'stage.same')
  if (to === 'live') add(missing, 'scope.r1')

  const targetIsTerminal = to === 'review' || to === 'closed'
  let allowed = targetIsTerminal
  let downgrade = false
  if (from === 'review' && target >= 0) {
    const reviewFrom = exp.reviewFrom === undefined || exp.reviewFrom === null ? -1 : stageOrder(exp.reviewFrom)
    if (!isMainline(exp.reviewFrom as ExperimentStage) || target > reviewFrom) {
      add(missing, 'reviewFrom')
      return missing
    }
    else { allowed = true; downgrade = target < reviewFrom }
  } else if (target >= 0 && forward >= 0 && target < forward) {
    allowed = true
    downgrade = true
  }

  const direct =
    (from === 'hypothesis' && to === 'backtest') ||
    (from === 'hypothesis' && to === 'shadow') ||
    (from === 'backtest' && to === 'holdout') ||
    (from === 'backtest' && to === 'shadow') ||
    (from === 'holdout' && to === 'shadow') ||
    (from === 'shadow' && to === 'live_small')
  if (direct) allowed = true
  if (!allowed && from !== to && to !== 'live') add(missing, 'stage.skip')

  const isReviewReturn = from === 'review' && target >= 0 && !downgrade
  if (target >= 0 && ((forward >= 0 && target > forward) || isReviewReturn) && exp.stageEnteredAt === undefined) add(missing, 'stageEnteredAt')

  if (to === 'backtest' && from === 'hypothesis') {
    if (exp.subjectKey === undefined || exp.subjectKey === null) add(missing, 'subjectKey')
    for (const key of missingBacktestAssumptions(exp.assumptions)) add(missing, `assumptions.${key}`)
  }

  const validPaperRuns = (): boolean => (exp.runs ?? []).some((run) => run.runId !== undefined && validPaperRun(exp, run.runId, evidence, now))
  if (to === 'shadow' && from === 'hypothesis') {
    if (exp.subjectKey !== null && !llmPath(exp, current)) add(missing, 'subjectKey')
    if (!validPaperRuns()) add(missing, 'runs.paper')
  }
  if (to === 'shadow' && from === 'backtest') {
    if (!llmPath(exp, current)) add(missing, 'llm.contaminated')
    if (!validPaperRuns()) add(missing, 'runs.paper')
  }

  if (to === 'holdout' && from === 'backtest') {
    const backtests = current.filter((pack): pack is BacktestEvidencePack => pack.kind === 'backtest')
    const backtestsWithRuns = backtests.filter((pack) => isRunTableMatch(exp, pack, evidence))
    const qualifyingBacktests = backtestsWithRuns.filter((pack) =>
      pack.stats.trades >= 10 && pack.biasChecks.lookahead === 'pass' && pack.data.pointInTime === true && pack.llm.contaminated === 'no',
    )
    if (qualifyingBacktests.length === 0) add(missing, 'backtest.pack')
    if (backtests.length === 0 || backtestsWithRuns.length === 0) add(missing, 'backtest.run')
    if (!backtestsWithRuns.some((pack) => pack.stats.trades >= 10)) add(missing, 'backtest.trades')
    if (!backtestsWithRuns.some((pack) => pack.biasChecks.lookahead === 'pass')) add(missing, 'backtest.lookahead')
    if (!backtestsWithRuns.some((pack) => pack.data.pointInTime === true)) add(missing, 'data.pointInTime')
    if (!backtestsWithRuns.some((pack) => pack.llm.contaminated === 'no') ||
        (exp.llm?.involved === true && current.some((pack) => pack.kind === 'backtest' && pack.llm.contaminated !== 'no'))) add(missing, 'llm.contaminated')
    if (exp.frozen?.holdout !== true || !exp.holdoutWindow) add(missing, 'holdout.frozen')
    if (!exp.holdoutRunId) add(missing, 'holdout.runId')
    const holdouts = current.filter((pack): pack is BacktestEvidencePack => pack.kind === 'holdout' && pack.runId === exp.holdoutRunId)
    const holdoutsWithRuns = holdouts.filter((pack) => isRunTableMatch(exp, pack, evidence))
    if (holdoutsWithRuns.length === 0) add(missing, 'holdout.pack')
    const matchingHoldout = qualifyingBacktests.some((backtest) => holdoutsWithRuns.some((holdout) =>
      matchingHoldoutPair(exp, backtest, holdout),
    ))
    if (!matchingHoldout) {
      add(missing, 'holdout.pack')
      if (qualifyingBacktests.length > 0 && holdoutsWithRuns.length > 0) add(missing, 'holdout.spec')
    }
  }

  if (to === 'shadow' && from === 'holdout') {
    // The one-time holdout pack necessarily predates entry into holdout.
    const since = evidence.backtestEnteredAt
    const labPacks = Number.isInteger(since) && since! >= 0 && since! <= (exp.stageEnteredAt ?? -1)
      ? allLinked.filter((pack): pack is BacktestEvidencePack =>
        (pack.kind === 'backtest' || pack.kind === 'holdout') && Number.isInteger(pack.at) &&
        pack.at >= since! && pack.at <= now && isRunTableMatch(exp, pack, evidence),
      ) : []
    const backtests = labPacks.filter((pack) => pack.kind === 'backtest' && pack.stats.trades >= 10 &&
      pack.biasChecks.lookahead === 'pass' && pack.data.pointInTime === true && pack.llm.contaminated === 'no')
    const holdouts = labPacks.filter((pack) => pack.kind === 'holdout' && pack.runId === exp.holdoutRunId)
    if (!backtests.some((backtest) => holdouts.some((holdout) => matchingHoldoutPair(exp, backtest, holdout)))) add(missing, 'holdout.pack')
    if (!validPaperRuns()) add(missing, 'runs.paper')
  }

  if (to === 'live_small') {
    const forwardPacks = current.filter((pack) => pack.kind === 'forward')
    const reviewSource = exp.reviewFrom == null ? undefined : resolveAlias(exp.reviewFrom)
    const fullReadiness = !(from === 'live' || (from === 'review' && (reviewSource === 'live_small' || reviewSource === 'live')))
    if (fullReadiness && forwardPacks.length === 0) add(missing, 'forward.pack')
    else if (fullReadiness) {
      const candidates = forwardPacks.map((pack) => forwardCandidateMissing(exp, pack, evidence, now, fullReadiness))
      candidates.sort((a, b) => a.length - b.length || a.join('|').localeCompare(b.join('|')))
      for (const path of candidates[0] ?? []) add(missing, path)
    } else {
      const paperForwards = forwardPacks.filter((pack): pack is ForwardEvidencePack =>
        pack.kind === 'forward' && pack.tier === 'forward_paper' && pack.forward.tier === 'forward_paper',
      )
      if (paperForwards.length === 0) add(missing, forwardPacks.length === 0 ? 'forward.pack' : 'forward.tier')
      if (evidence.actor.actorType !== 'human' || evidence.actor.via !== 'ui') add(missing, 'human.ui')
      if (!paperForwards.some((pack) => presenceOkay(evidence, pack.attestation.digest))) add(missing, 'presence')
    }
  }
  return missing
}

export function checkTransition(
  exp: Experiment,
  to: ExperimentStage,
  evidence: ExperimentTransitionEvidence,
  now: Ms,
): { ok: boolean; missing: string[] } {
  const from = resolveAlias(exp.stage)
  const target = resolveAlias(to)
  return result(transitionMissing(exp, from, target, evidence, now))
}

function pathTokens(key: string): string[] {
  return key.replace(/\[['"]?([^'"\]]+)['"]?\]/g, '.$1').split(/[.[\]]+/).filter(Boolean)
}

export function isReadonlyPatch(patch: unknown): string[] {
  if (!isPlainRecord(patch)) return ['patch']
  const readonly = new Set<string>(EXPERIMENT_READONLY_FIELDS)
  const found = new Set<string>()
  const visit = (value: unknown, path: string[]): void => {
    const root = path[0]
    if (root !== undefined) {
      if (readonly.has(root)) {
        found.add(path.join('.'))
        return
      }
    }
    if (root === 'llm' && path[1] === 'involved' &&
        (path.length !== 2 || value !== true)) found.add(path.slice(0, 2).join('.'))
    if (path.length === 1 && root === 'llm' && !isPlainRecord(value)) found.add('llm.involved')
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, [...path, String(index)]))
    } else if (isPlainRecord(value)) {
      for (const [key, child] of Object.entries(value)) visit(child, [...path, ...pathTokens(key)])
    }
  }
  visit(patch, [])
  return [...found].sort()
}

export function isAppendOnlyViolation(cur: Partial<Experiment>, next: Partial<Experiment>): string[] {
  const violations = new Set<string>()
  for (const field of EXPERIMENT_APPEND_ONLY_FIELDS) {
    const oldValue = cur[field]
    const newValue = next[field]
    if (oldValue === undefined) {
      if (newValue !== undefined && !Array.isArray(newValue)) violations.add(field)
      continue
    }
    if (!Array.isArray(oldValue) || !Array.isArray(newValue) || newValue.length < oldValue.length) {
      violations.add(field)
      continue
    }
    for (let index = 0; index < oldValue.length; index++) {
      if (!sameJson(oldValue[index], newValue[index])) {
        violations.add(field)
        break
      }
    }
  }
  return [...violations].sort()
}
