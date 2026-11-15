// SPDX-License-Identifier: CPAL-1.0
import type { AccountId, EvidencePack, Experiment, ExperimentStage, ExperimentTransitionEvidence, ForwardEvidencePack, MandateId, Origin, Sha256Digest } from '../proto'
import { EXPERIMENT_STAGES, checkTransition, validateBySchemaId } from '../proto'
import type { ActorCtx } from '../trading'
import type { HumanProof } from '../auth'
import { assertProof } from '../auth'
import type { LabService } from '../lab'
import { tx } from '../db'
import { fail } from '../util/errors'
import { digestOf } from '../util/hash'
import { newId, ulid } from '../util/ids'
import { resolveAlias } from '../proto'
import type { StageSnapshotBatch } from './forward'

type Plain = Record<string, any>
type Entry = { type: string; ts: number; subject: Record<string, any>; payload?: Record<string, any>; origin: Origin }
const ORG = 'org_local'

function denied(message: string): never { return fail('EXPERIMENT_TRANSITION_DENIED', message) }
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T }
function sameExecutor(a: NonNullable<Experiment['runs']>[number]['executor'], b: NonNullable<Experiment['runs']>[number]['executor']): boolean {
  if (!a || !b || a.kind !== b.kind) return false
  return a.kind === 'agent'
    ? b.kind === 'agent' && a.mandateId === b.mandateId
    : b.kind === 'engine' && a.engineId === b.engineId && a.instanceId === b.instanceId
}

export class LabStages {
  constructor(readonly lab: LabService) {}

  parallel(exp: Experiment): Experiment[] {
    const all = this.lab.all()
    const family = (item: Experiment): Set<string> => {
      const ids = new Set<string>([item.experimentId])
      let parent = item.lineage?.parentExperimentId
      while (parent && !ids.has(parent)) {
        ids.add(parent)
        parent = all.find((entry) => entry.experimentId === parent)?.lineage?.parentExperimentId
      }
      return ids
    }
    const familyIds = family(exp)
    const expRuns = (exp.runs ?? []).filter((run) => run.to === null && run.executor)
    const overlapsExecutor = (other: Experiment): boolean => (other.runs ?? []).some((run) =>
      run.to === null && run.executor && expRuns.some((own) => sameExecutor(own.executor, run.executor) && Math.max(own.from, run.from) <= this.lab.k.clock.now()),
    )
    return all.filter((other) => {
      if (other.experimentId === exp.experimentId) return true
      const otherFamily = family(other)
      if ([...familyIds].some((id) => otherFamily.has(id))) return true
      return overlapsExecutor(other)
    })
  }

  async stage(id: string, toValue: unknown, actor: ActorCtx, proof?: HumanProof): Promise<Experiment> {
    if (this.lab.k.replayFixture) return fail('INVALID_PARAMS', 'forward experiment stage transitions are unavailable in a historical replay home')
    const exp = this.lab.load(id)
    this.lab.assertOwner(exp, actor)
    if (typeof toValue !== 'string' || !(EXPERIMENT_STAGES as readonly string[]).includes(toValue)) return denied('Unknown experiment stage')
    const to = resolveAlias(toValue as ExperimentStage)
    let now = this.lab.k.clock.now()
    const parallel = this.parallel(exp)

    if ((to === 'live_small' || to === 'live') && actor.origin.via === 'mcp') {
      const parallelPayload = parallel.map((item) => ({ experimentId: item.experimentId, stage: item.stage, forward: item.forward ?? null }))
      const payload = { kind: 'experiment_promotion_request', experimentId: id, to, parallel: parallelPayload }
      tx(this.lab.k.db, () => {
        this.lab.k.ledger.append({ type: 'annotation', origin: actor.origin, subject: { orgId: ORG, experimentId: exp.experimentId }, payload })
        this.lab.k.docs.put('lab-promotion-request', `${id}:${ulid(now)}`, { ...payload, at: now, actor: actor.origin.actor })
      })
      return denied('Promotion requests require human review in the workbench')
    }

    if (to === 'live') return denied('Live promotion is outside scope.r1')

    const evidencePacks = this.lab.runTable.packs(exp)
    // fix-r6 R3-08（只许收紧）：Agent 经 MCP 把实验推进到 backtest，要先有一条 backtest 证据包（experiment pack 由已完成的回测生成）。
    // 人在工作台里的推进（via=ui）不受影响；live_small / live 的规则在上面，不变。
    if (to === 'backtest' && actor.origin.via === 'mcp' && resolveAlias(exp.stage) !== 'backtest' && !evidencePacks.some((pack) => pack.kind === 'backtest')) {
      return fail('EXPERIMENT_EVIDENCE_INCOMPLETE', 'Moving an experiment to backtest needs a backtest evidence pack: run a backtest, then call experiment pack with its runId (the first pack also needs a holdoutWindow)')
    }
    let next = clone(exp)
    let candidatePack: ForwardEvidencePack | undefined
    let candidateInput: unknown
    let snapshotBatch: StageSnapshotBatch | undefined
    let pinAttestation: { payload: Plain; alg: 'ed25519'; keyId: string; digest: Sha256Digest; sig: string } | undefined
    let transitionEvidence: ExperimentTransitionEvidence = this.evidence(exp, evidencePacks, actor, parallel, now)

    if (to === 'live_small') {
      let validProof: HumanProof | undefined
      if (actor.origin.actorType === 'human' && actor.origin.via === 'ui') {
        validProof = assertProof(proof, 'pin')
        if (validProof.userId !== actor.origin.actor.replace(/^user:/, '') || validProof.via !== 'ui' || now - validProof.at < 0 || now - validProof.at > 60_000) validProof = undefined
      }
      snapshotBatch = await this.lab.forwardStats.snapshot(exp, 'stage', now)
      if (snapshotBatch) now = snapshotBatch.at
      if (validProof && (validProof.userId !== actor.origin.actor.replace(/^user:/, '') || validProof.via !== 'ui' || now - validProof.at < 0 || now - validProof.at > 60_000)) validProof = undefined
      transitionEvidence = this.evidence(exp, evidencePacks, actor, parallel, now)
      if (validProof) {
        const computed = await this.lab.forwardStats.compute(exp, now, true, snapshotBatch)
        const trial = this.lab.runTable.trials(exp)
        const runId = `run_${ulid(now)}`
        const packId = newId('pck', now)
        const partial = {
          schema: 'gitrader-experiment/1' as const,
          packId,
          experimentId: exp.experimentId,
          runId,
          subjectKey: exp.subjectKey ?? null,
          window: clone(computed.input.window),
          at: now,
          trialCount: trial.trialCount,
          trialStats: clone(trial.trialStats),
          provenance: { kernelVersion: String(this.lab.k.status().version), protocolVersion: '0.1.12' },
          kind: 'forward' as const,
          tier: 'forward_paper' as const,
          forward: clone(computed.stats),
        }
        const digest = digestOf(partial)
        candidatePack = {
          ...partial,
          attestation: { alg: 'ed25519', keyId: this.lab.k.installKey.keyId, digest, sig: this.lab.k.installKey.sign(digest) },
        }
        candidateInput = computed.input
        const by = validProof.userId
        const signed = { experimentId: id, from: exp.stage, to, at: now, forwardPackDigest: digest, parallelExperimentIds: parallel.map((item) => item.experimentId), by, method: 'pin' as const }
        const signedDigest = digestOf(signed)
        pinAttestation = { payload: signed, alg: 'ed25519', keyId: this.lab.k.installKey.keyId, digest: signedDigest, sig: this.lab.k.installKey.sign(signedDigest) }
        transitionEvidence = {
          ...this.evidence(exp, evidencePacks, actor, parallel, now),
          presence: { verified: true, forwardPackDigest: digest },
        }
        next.forward = computed.stats
        next.baseline = computed.baseline
        next.packs = [...(next.packs ?? []), { packId, kind: 'forward', tier: 'forward_paper', digest, at: now, runId }]
        transitionEvidence.packs = [...transitionEvidence.packs, candidatePack]
      }
    }

    const result = checkTransition(next, to, transitionEvidence, now)
    if (!result.ok) {
      if (result.missing.includes('owner')) return fail('EXPERIMENT_FORBIDDEN', 'Experiment owner mismatch')
      if (result.missing.includes('stage.closed') || result.missing.includes('stage.same')) return fail('EXPERIMENT_APPEND_ONLY', 'Closed or unchanged experiment stages cannot be changed')
      return denied(`Stage transition is missing: ${result.missing.join(', ')}`)
    }

    if (to !== 'live_small') {
      snapshotBatch = await this.lab.forwardStats.snapshot(exp, 'stage', now)
      now = snapshotBatch?.at ?? this.lab.k.clock.now()
    }

    if (!candidatePack) {
      next = clone(exp)
      next.stage = to
    }
    next.stage = to
    next.stageEnteredAt = now
    if (to === 'review') {
      if (exp.stage !== 'review') next.reviewFrom = exp.stage
    }
    if (to === 'closed' || to === 'retired') next.runs = (next.runs ?? []).map((run) => run.to === null ? { ...run, to: now } : run)

    await this.lab.forwardStats.start(next, now, snapshotBatch?.start)
    const latestBacktest = [...evidencePacks].filter((pack) => pack.kind === 'backtest').sort((a, b) => b.at - a.at)[0]
    const participatingRuns = exp.runs ?? []
    const comparable = participatingRuns.flatMap((run) => {
      const executor = run.executor
      if (!executor || executor.kind !== 'engine' || !executor.codeDigest || !latestBacktest?.subjectKey) return []
      return [{ mismatch: executor.codeDigest !== latestBacktest.subjectKey }]
    })
    const hasUnknownPin = participatingRuns.some((run) => !run.executor || run.executor.kind !== 'engine' || !run.executor.codeDigest || !latestBacktest?.subjectKey)
    const pinMismatch: boolean | 'unknown' = comparable.some((item) => item.mismatch) ? true : hasUnknownPin || !comparable.length ? 'unknown' : false
    const evidencePackIds = next.packs?.map((item) => item.packId) ?? []
    return tx(this.lab.k.db, () => {
      if (candidatePack && candidateInput) {
        if (!validateBySchemaId('urn:gitrader:schema:model:0.1:EvidencePack', candidatePack).ok) return denied('Kernel forward evidence failed protocol validation')
        this.lab.k.docs.put('lab-pack', candidatePack.packId, candidatePack)
        this.lab.k.docs.put('lab-forward-input', candidatePack.packId, candidateInput)
        if (snapshotBatch) this.lab.k.docs.put('lab-forward-endpoint', candidatePack.packId, {
          at: snapshotBatch.at,
          requestedAt: snapshotBatch.requestedAt,
          sealSeq: snapshotBatch.sealSeq,
          sourceSeqs: snapshotBatch.sourceSeqs,
        })
      }
      const saved = this.lab.write(exp, next, { stage: to }, actor.origin)
      this.lab.k.ledger.append({
        type: 'experiment.stage_changed', ts: now, origin: actor.origin,
        subject: { orgId: ORG, experimentId: exp.experimentId },
        payload: { from: exp.stage, to, evidencePackIds, by: pinAttestation ? pinAttestation.payload.by : actor.origin.actor, pinMismatch, ...(pinAttestation ? { parallelExperimentIds: parallel.map((item) => item.experimentId), attestation: pinAttestation } : {}) },
      })
      return saved
    })
  }

  private evidence(exp: Experiment, packs: EvidencePack[], actor: ActorCtx, parallel: Experiment[], now: number): ExperimentTransitionEvidence {
    const accounts = [...new Set((exp.runs ?? []).map((run) => run.accountId).filter((id): id is AccountId => !!id))]
      .map((accountId) => ({ accountId, mode: this.lab.k.accounts.get(accountId).mode }))
      .filter((account): account is { accountId: AccountId; mode: 'paper' | 'shadow' | 'live' } => ['paper', 'shadow', 'live'].includes(account.mode))
    const runs = this.lab.runTable.all().filter((run) => run.experimentId === exp.experimentId)
    const entries = Array.from(this.lab.k.ledger.iterate()) as Entry[]
    const latestBacktestEntry = entries.filter((entry) => entry.type === 'experiment.stage_changed' && entry.subject.experimentId === exp.experimentId && entry.payload?.to === 'backtest').sort((a, b) => b.ts - a.ts)[0]
    const backtestEnteredAt = latestBacktestEntry?.ts ?? (exp.stage === 'backtest' ? exp.stageEnteredAt : undefined)
    const actorEvidence: ExperimentTransitionEvidence['actor'] = actor.origin.actorType === 'human'
      ? { actorType: 'human' as const, userId: actor.origin.actor.replace(/^user:/, ''), via: actor.origin.via }
      : actor.origin.actorType === 'llm-agent'
        ? { actorType: 'llm-agent' as const, mandateId: actor.principal.kind === 'agent' ? actor.principal.mandateId as MandateId : undefined, via: actor.origin.via }
        : actor.origin.actorType === 'engine'
          ? { actorType: 'engine' as const, mandateId: actor.principal.kind === 'engine' ? actor.principal.mandateId as MandateId : undefined, via: actor.origin.via }
          : { actorType: 'system' as const, via: actor.origin.via }
    const authorizationValid = this.authorizationValid(exp, now)
    const riskPolicyValid = !!this.lab.k.risk.current() && this.lab.k.risk.verify().ok
    return {
      actor: actorEvidence,
      packs,
      labRuns: runs,
      accounts,
      ...(backtestEnteredAt === undefined ? {} : { backtestEnteredAt }),
      authorizationValid,
      riskPolicyValid,
      parallelExperimentsDisclosed: parallel.length > 0,
    }
  }

  private authorizationValid(exp: Experiment, now: number): boolean {
    const runs = (exp.runs ?? []).filter((run) => run.to === null && run.accountId && run.executor)
    if (!runs.length) return false
    return runs.every((run) => {
      const accountId = run.accountId!
      if (run.executor!.kind === 'agent') {
        const mandate = this.lab.k.agents.effective(run.executor!.mandateId, now)
        return !!mandate && (mandate.status === 'active' || mandate.status === 'downgraded') && mandate.accounts.includes(accountId as never) && this.lab.k.agents.verifyMandate(run.executor!.mandateId)
      }
      const executor = run.executor!
      if (executor.kind !== 'engine') return false
      const binding = this.lab.k.docs.get<{ accounts?: { accountId: string; mandateId: string }[] }>('enginebind', executor.engineId)
      const bound = binding?.accounts?.find((item) => item.accountId === accountId)
      if (!bound) return false
      const mandate = this.lab.k.agents.effective(bound.mandateId, now)
      return !!mandate && (mandate.status === 'active' || mandate.status === 'downgraded') && mandate.accounts.includes(accountId as never) && this.lab.k.agents.verifyMandate(bound.mandateId)
    })
  }
}
