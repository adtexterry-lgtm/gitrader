// SPDX-License-Identifier: CPAL-1.0
import type { BacktestEvidencePack, BacktestResult, BacktestSpec, BacktestState, EvidencePack, EvidencePackDraft, Experiment, Instrument, LabRun, MandateId, Origin, Sha256Digest } from '../proto'
import { CANDLES_DIGEST_METHOD, LLM_LEAK_MARGIN_DAYS, TRIAL_WINDOW_DAYS, missingBacktestAssumptions, validateBySchemaId, validateBacktestResult, candlesDigest } from '../proto'
import { explainBacktestSpec } from './spec-explain'
import type { ActorCtx } from '../trading'
import { CONCLUSION_REDLINE, type LabService } from '../lab'
import { tx } from '../db'
import { fail, toProblem } from '../util/errors'
import { digestOf } from '../util/hash'
import { newId, ulid } from '../util/ids'
import { systemOrigin } from '../util/origin'

type RawCall = (engineId: string, method: string, params: any) => Promise<any>
type Detail = { engineId: string; spec: BacktestSpec; origin: Origin; executor: LabRun['executor']; jobId?: string; replayId?: string; result?: BacktestResult; strategySha256?: Sha256Digest; error?: { code: number; digest: Sha256Digest } }
const RUNS = 'lab-run'
const DETAILS = 'lab-run-detail'
const FREEZES = 'lab-freeze'
const JOBS = 'lab-job-index'
const REPLAYS = 'lab-replay-index'

function bad(message = 'Invalid experiment run input'): never { return fail('INVALID_PARAMS', message) }
function evidence(message = 'Experiment evidence is incomplete'): never { return fail('EXPERIMENT_EVIDENCE_INCOMPLETE', message) }
function contradiction(message = 'Experiment evidence contradicts the recorded run'): never { return fail('EXPERIMENT_TRANSITION_DENIED', message) }
function clone<T>(value: T): T { try { return JSON.parse(JSON.stringify(value)) as T } catch { return bad() } }
function record(value: unknown): value is Record<string, any> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function overlap(a: { from: number; to: number }, b: { from: number; to: number }): boolean { return Math.max(a.from, b.from) < Math.min(a.to, b.to) }
function errorCode(code: string, message: string): never { return fail(code as never, message) }

const DOWNGRADE_OK = new Set(['funding', 'liquidation'])
/** 返回第一个与请求冲突的键；null = 一致。引擎可以「补」键、可以把没建模的 funding/liquidation 降成 false，但不能放宽成本。 */
export function assumptionConflict(requested: Record<string, unknown>, effective: Record<string, unknown>): string | null {
  for (const [key, want] of Object.entries(requested)) {
    const got = effective[key]
    if (key === 'fees') {
      const ok = want === 'venue' ? record(got) && typeof got.maker === 'string' && typeof got.taker === 'string' : digestOf(got ?? null) === digestOf(want)
      if (!ok) return key
    } else if (DOWNGRADE_OK.has(key)) {
      if (typeof got !== 'boolean' || (want === false && got === true)) return key   // 请求 true 引擎降成 false 允许（引擎有 warning）；请求 false 不许变 true
    } else if (key === 'latencyMs') {
      if (typeof want !== 'number' || typeof got !== 'number' || got > want) return key   // 未建模：采用值只能 ≤ 请求值
    } else if (digestOf(got ?? null) !== digestOf(want)) return key                     // slippageBps / fillModel / maxVolumeShare / liquidationPenaltyRatio / x-* 必须原样回写
  }
  return null
}

export class LabRuns {
  constructor(readonly lab: LabService, private readonly raw: RawCall) {}

  all(): LabRun[] {
    const rows = this.lab.k.db.prepare(
      `SELECT d.doc FROM docs d JOIN (SELECT id, MAX(ver) mv FROM docs WHERE coll=? GROUP BY id) m
       ON d.coll=? AND d.id=m.id AND d.ver=m.mv ORDER BY d.updated_at, d.id`,
    ).all(RUNS, RUNS) as { doc: string }[]
    return rows.map((row) => JSON.parse(row.doc) as LabRun)
  }

  private save(row: LabRun, detail: Detail): void {
    tx(this.lab.k.db, () => {
      this.lab.k.docs.put(RUNS, row.runId, row)
      this.lab.k.docs.put(DETAILS, row.runId, detail)
      if (detail.jobId) this.lab.k.docs.put(JOBS, `${detail.engineId}:${detail.jobId}`, { runId: row.runId })
      if (detail.replayId) this.lab.k.docs.put(REPLAYS, `${detail.engineId}:${detail.replayId}`, { runId: row.runId })
    })
  }

  private load(runId: string): { row: LabRun; detail: Detail } {
    const row = this.lab.k.docs.get<LabRun>(RUNS, runId)
    const detail = this.lab.k.docs.get<Detail>(DETAILS, runId)
    if (!row || !detail) return evidence('Run record is missing')
    return { row, detail }
  }

  private checkAgent(row: LabRun, actor?: ActorCtx): void {
    if (actor?.principal.kind === 'agent' && (row.executor.kind !== 'agent' || row.executor.mandateId !== actor.principal.mandateId)) {
      errorCode('EXPERIMENT_FORBIDDEN', 'Agent cannot access this experiment run')
    }
  }

  private async resolvedExecutor(engineId: string, spec: BacktestSpec, actor?: ActorCtx): Promise<LabRun['executor']> {
    if (actor?.principal.kind === 'agent') return { kind: 'agent', mandateId: actor.principal.mandateId as MandateId }
    let codeDigest: Sha256Digest | null = null
    const strategyId = spec.subject.strategy?.id
    if (strategyId) {
      try {
        const result = await this.raw(engineId, 'strategy.list', {})
        const digest = result?.strategies?.find((item: any) => item?.id === strategyId)?.sha256
        if (typeof digest === 'string' && /^sha256:[a-f0-9]{64}$/.test(digest)) codeDigest = digest as Sha256Digest
      } catch { /* Missing engine code identity remains explicit as null. */ }
    }
    return { kind: 'engine', engineId, instanceId: `inst_${ulid(this.lab.k.clock.now())}` as never, codeDigest }
  }

  private async start(engineId: string, method: 'backtest.run' | 'replay.start', input: unknown, actor?: ActorCtx): Promise<unknown> {
    if (!record(input)) return bad()
    const experimentId = input.experimentId
    if (experimentId !== undefined && typeof experimentId !== 'string') return bad()
    const exp = experimentId ? this.lab.load(experimentId) : undefined
    if (exp && actor) this.lab.assertOwner(exp, actor)
    const specValue = input.spec
    const spec = clone((record(specValue) ? specValue : {}) as BacktestSpec)
    const cleanParams = clone(input)
    delete cleanParams.experimentId
    const specDigest = digestOf(spec)
    const at = this.lab.k.clock.now()
    const runId = `run_${ulid(at)}`
    const executor: LabRun['executor'] = actor?.principal.kind === 'agent'
      ? { kind: 'agent', mandateId: actor.principal.mandateId as MandateId }
      : { kind: 'engine', engineId, instanceId: `inst_${ulid(at)}` as never, codeDigest: null }
    const origin = actor?.origin ?? systemOrigin('lab:run')
    const kind = method === 'backtest.run' ? 'backtest' : 'replay'
    const row: LabRun = {
      runId, kind, ...(experimentId ? { experimentId } : {}), executor,
      subjectKey: exp?.subjectKey ?? null, specDigest, instruments: Array.isArray(spec.instruments) ? clone(spec.instruments) : [],
      window: { from: Number.isSafeInteger(spec.from) ? spec.from : 0, to: Number.isSafeInteger(spec.to) ? spec.to : 0 },
      startedAt: at, status: kind === 'backtest' ? 'queued' : 'running',
    }
    const detail: Detail = { engineId, spec, origin, executor, ...(executor.kind === 'engine' ? { strategySha256: executor.codeDigest ?? undefined } : {}) }
    this.save(row, detail)
    try {
      const why = explainBacktestSpec(specValue)
      if (why || !Number.isSafeInteger(spec.from) || !Number.isSafeInteger(spec.to) || spec.from < 0) return bad(`Invalid backtest specification: ${why ?? '/from and /to must be non-negative integer milliseconds'}`)
      row.executor = await this.resolvedExecutor(engineId, spec, actor)
      detail.executor = row.executor
      if (row.executor.kind === 'engine') detail.strategySha256 = row.executor.codeDigest ?? undefined
      const touch = this.lab.all().filter((item) => item.frozen?.holdout && !item.holdoutRunId)
      tx(this.lab.k.db, () => {
        this.save(row, detail)
        for (const current of touch) {
          const owner = this.lab.load(current.experimentId)
          const freeze = this.lab.k.docs.get<{ instruments: string[]; window: { from: number; to: number } }>(FREEZES, owner.experimentId)
          if (!freeze || !owner.frozen?.holdout || owner.holdoutRunId || !freeze.instruments.some((id) => spec.instruments.includes(id)) || !overlap(freeze.window, row.window)) continue
          const next = clone(owner)
          next.holdoutRunId = runId
          this.lab.write(owner, next, { holdoutRunId: runId }, origin)
        }
      })
      const result = await this.raw(engineId, method, cleanParams)
      const id = kind === 'backtest' ? result?.jobId : result?.replayId
      if (typeof id !== 'string' || !id) return contradiction('Engine did not return a valid run identifier')
      if (kind === 'backtest') detail.jobId = id
      else detail.replayId = id
      row.status = 'running'
      this.save(row, detail)
      return { ...result, runId }
    } catch (error) {
      const problem = toProblem(error)
      detail.error = { code: problem.code, digest: digestOf({ name: problem.name, message: problem.message }) }
      row.status = 'failed'
      this.save(row, detail)
      throw error
    }
  }

  private async observe(engineId: string, method: string, input: unknown, actor?: ActorCtx): Promise<unknown> {
    if (!record(input)) return bad()
    const isReplay = method.startsWith('replay.')
    const foreignId = isReplay ? input.replayId : input.jobId
    if (typeof foreignId !== 'string' || !foreignId) return bad()
    const collection = isReplay ? REPLAYS : JOBS
    const indexKey = `${engineId}:${foreignId}`
    let index = this.lab.k.docs.get<{ runId: string }>(collection, indexKey)
    if (!index) {
      // Pre-index installations: select only the matching identifier, then persist the lookup.
      const legacy = this.lab.k.db.prepare(
        `SELECT d.id AS runId FROM docs d WHERE d.coll=? AND d.ver=(SELECT MAX(v.ver) FROM docs v WHERE v.coll=d.coll AND v.id=d.id)
         AND json_valid(d.doc) AND json_extract(d.doc,'$.engineId')=? AND json_extract(d.doc,?)=? LIMIT 1`,
      ).get(DETAILS, engineId, isReplay ? '$.replayId' : '$.jobId', foreignId) as { runId: string } | undefined
      if (!legacy) return evidence('Run record is not known to this engine')
      index = legacy
      this.lab.k.docs.put(collection, indexKey, index)
    }
    const found = this.load(index.runId)
    if (found.detail.engineId !== engineId || (isReplay ? found.detail.replayId : found.detail.jobId) !== foreignId) return evidence('Run index does not match this engine')
    this.checkAgent(found.row, actor)
    const result = await this.raw(engineId, method, clone(input))
    if (method.endsWith('.status') || method.endsWith('.stop') || method.endsWith('.cancel')) {
      const state = result?.state
      if (isReplay) found.row.status = state === 'done' ? 'done' : state === 'stopped' || method.endsWith('.stop') ? 'cancelled' : state === 'running' || state === 'paused' ? 'running' : found.row.status
      else if (state === 'queued' || state === 'running' || state === 'done' || state === 'failed' || state === 'cancelled') found.row.status = state as BacktestState
      else if (method.endsWith('.cancel')) found.row.status = 'cancelled'
      this.save(found.row, found.detail)
      return { ...result, runId: found.row.runId }
    }
    if (!validateBacktestResult(result).ok || !record(result)) {
      found.row.status = 'failed'
      this.save(found.row, found.detail)
      return contradiction('Engine returned an invalid backtest result')
    }
    const backtestResult = clone(result as BacktestResult)
    if (backtestResult.specDigest !== found.row.specDigest || backtestResult.jobId !== found.detail.jobId) {
      return contradiction('Backtest result identity differs from the recorded run')
    }
    if (found.detail.result) return { ...found.detail.result, runId: found.row.runId }
    found.detail.result = backtestResult
    found.detail.strategySha256 = backtestResult.strategySha256
    found.row.status = 'done'
    found.row.resultDigest = digestOf(backtestResult)
    found.row.stats = { sharpe: backtestResult.stats.sharpe, nObs: backtestResult.equity.length }
    tx(this.lab.k.db, () => {
      this.save(found.row, found.detail!)
      this.lab.k.ledger.append({
        type: 'backtest.completed', origin: found.detail!.origin,
        subject: { orgId: 'org_local', ...(found.row.experimentId ? { experimentId: found.row.experimentId } : {}) },
        payload: { source: 'backtest', runId: found.row.runId, specDigest: found.row.specDigest, resultDigest: found.row.resultDigest },
      })
    })
    return { ...found.detail.result, runId: found.row.runId }
  }

  async forward(engineId: string, method: string, params: any, actor?: ActorCtx): Promise<any> {
    if (!['backtest.run', 'backtest.status', 'backtest.result', 'backtest.cancel', 'replay.start', 'replay.status', 'replay.stop'].includes(method)) return this.raw(engineId, method, params)
    if (method === 'backtest.run' || method === 'replay.start') return this.start(engineId, method, params, actor)
    return this.observe(this.ownerOf(engineId, method, params), method, params, actor)
  }

  /** R3-14：status / result / cancel / stop 只带作业号，调用方给的引擎（缺省 = 第一个就绪引擎）不一定是启动它的那个；按作业表转给启动这个作业的引擎。查不到或有歧义就保持调用方给的引擎。 */
  private ownerOf(engineId: string, method: string, params: unknown): string {
    if (!record(params)) return engineId
    const isReplay = method.startsWith('replay.')
    const foreignId = isReplay ? params.replayId : params.jobId
    if (typeof foreignId !== 'string' || !foreignId) return engineId
    const collection = isReplay ? REPLAYS : JOBS
    if (this.lab.k.docs.get(collection, `${engineId}:${foreignId}`)) return engineId
    const suffix = `:${foreignId}`
    const rows = this.lab.k.db.prepare('SELECT DISTINCT id FROM docs WHERE coll=? AND substr(id, ?) = ?').all(collection, -suffix.length, suffix) as { id: string }[]
    const owners = [...new Set(rows.map((row) => row.id.slice(0, -suffix.length)))]
    return owners.length === 1 ? owners[0]! : engineId
  }

  async pack(expId: string, input: unknown, holdoutWindow: unknown, actor: ActorCtx): Promise<Experiment> {
    const exp = this.lab.load(expId)
    holdoutWindow = holdoutWindow ?? exp.holdoutWindow ?? undefined
    this.lab.assertOwner(exp, actor)
    if (!record(input) || Object.keys(input).some((key) => key !== 'runId' && key !== 'note') || typeof input.runId !== 'string' || !input.runId ||
      (input.note !== undefined && typeof input.note !== 'string')) return contradiction('Pack accepts only a run reference and an optional note')
    const existing = exp.packs?.find((item) => item.runId === input.runId)
    if (existing) return exp
    let { row, detail } = this.load(input.runId)
    if (row.packId) return errorCode('EXPERIMENT_FORBIDDEN', 'Run is already linked to an evidence pack')
    if (row.kind !== 'backtest') return evidence('Only completed backtest runs can be packed')
    if (row.status !== 'done' || !detail.result) {
      if (!detail.jobId) return evidence('Backtest result is not available')
      await this.forward(detail.engineId, 'backtest.result', { jobId: detail.jobId }, actor)
      ;({ row, detail } = this.load(input.runId))
    }
    if (row.status !== 'done' || !detail.result) return evidence('Backtest result is not complete')
    if (detail.result.specDigest !== row.specDigest || detail.result.jobId !== detail.jobId) return contradiction('Stored backtest result identity differs from the recorded run')
    if (row.experimentId && row.experimentId !== expId) return errorCode('EXPERIMENT_FORBIDDEN', 'Run belongs to another experiment')
    const runSpec = detail.spec
    if (!this.sameSubject(exp, runSpec) || (row.experimentId === undefined && actor.principal.kind !== 'agent' && actor.principal.kind !== 'session')) return errorCode('EXPERIMENT_FORBIDDEN', 'Run subject does not belong to this experiment')
    if (actor.principal.kind === 'agent' && (row.executor.kind !== 'agent' || row.executor.mandateId !== actor.principal.mandateId)) return errorCode('EXPERIMENT_FORBIDDEN', 'Run belongs to another agent mandate')
    const draft = detail.result.pack
    if (!draft || !validateBySchemaId('urn:gitrader:schema:model:0.1:EvidencePackDraft', draft).ok) return evidence('Engine evidence pack draft is missing or invalid')
    const effective = detail.result.assumptions as unknown as Record<string, unknown>
    const bad: string[] = []
    if (digestOf(draft.spec) !== digestOf(runSpec)) bad.push('spec')
    if (draft.specDigest !== row.specDigest) bad.push('specDigest')
    if (draft.window.from !== runSpec.from || draft.window.to !== runSpec.to) bad.push('window')
    if (draft.seed !== runSpec.seed) bad.push('seed')
    if (digestOf(draft.assumptions) !== digestOf(effective)) bad.push('draft.assumptions != result.assumptions')
    const conflict = assumptionConflict(runSpec.assumptions as unknown as Record<string, unknown>, effective)
    if (conflict) bad.push(`assumptions.${conflict} (requested value was not honoured)`)
    if (bad.length) return contradiction(`Draft, result and recorded specification disagree: ${bad.join('; ')}`)
    if (missingBacktestAssumptions(draft.assumptions).length || missingBacktestAssumptions(detail.result.assumptions).length) return evidence('Backtest assumptions are incomplete')
    const identityDigest = detail.result.strategySha256 ?? detail.strategySha256
    if (!exp.subjectKey || !identityDigest) return evidence('Resolved strategy identity is missing')
    if (identityDigest !== exp.subjectKey) return contradiction('Engine strategy identity differs from the experiment subject')
    const data = await this.validateData(draft, runSpec)
    const instrumentMeta = this.validateInstruments(draft.instrumentMeta, runSpec.instruments)
    const artifacts = this.validateArtifacts(draft, detail.engineId)
    const returnsArtifact = draft.returnsArtifact ? this.validateReturns(draft.returnsArtifact.artifactId, draft.returnsArtifact.sha256, detail.engineId) : undefined
    const now = this.lab.k.clock.now()
    const freeze = this.lab.k.docs.get<{ window: { from: number; to: number }; instruments: string[]; assumptions: unknown; seed: number; subjectKey: Sha256Digest | null }>(FREEZES, expId)
    const kind: 'backtest' | 'holdout' = freeze && row.runId === exp.holdoutRunId ? 'holdout' : 'backtest'
    let next = clone(exp)
    let freezeAfter = freeze
    if (!freeze) {
      if (kind !== 'backtest' || !this.validWindow(holdoutWindow) || Object.keys(holdoutWindow).some((key) => key !== 'from' && key !== 'to')) return evidence('The first backtest pack requires a holdout window: pass holdoutWindow or set it on the experiment first')
      const candidateFreeze = { window: holdoutWindow, instruments: clone(runSpec.instruments), assumptions: clone(runSpec.assumptions), seed: runSpec.seed, subjectKey: exp.subjectKey }
      if (this.all().some((other) => candidateFreeze.instruments.some((id) => other.instruments.includes(id)) && overlap(candidateFreeze.window, other.window))) return contradiction('A recorded run intersects the proposed holdout window')
      freezeAfter = candidateFreeze
      next.frozen = { ...(next.frozen ?? { hypothesis: false, subject: false, holdout: false }), hypothesis: true, subject: true, holdout: true }
      next.holdoutWindow = clone(holdoutWindow as Experiment['holdoutWindow'])
    } else if (kind === 'holdout') {
      const runInstruments = [...row.instruments].sort()
      const frozenInstruments = [...freeze.instruments].sort()
      const exactInstrumentSet = runInstruments.length === row.instruments.length && frozenInstruments.length === freeze.instruments.length &&
        runInstruments.length === frozenInstruments.length && runInstruments.every((id, index) => id === frozenInstruments[index])
      if (row.runId !== exp.holdoutRunId || !this.equalWindow(holdoutWindow, freeze.window) || !this.equalWindow(row.window, freeze.window) || !exactInstrumentSet ||
        digestOf(runSpec.assumptions) !== digestOf(freeze.assumptions) || runSpec.seed !== freeze.seed || exp.subjectKey !== freeze.subjectKey) return contradiction('Holdout run does not match the frozen experiment')
    } else if (row.runId === exp.holdoutRunId || (row.instruments.some((id) => freeze.instruments.includes(id)) && overlap(row.window, freeze.window))) {
      return contradiction('A holdout-touching run can only produce the designated holdout pack')
    }
    const contamination = this.llmEvidence(exp, row.window.from)
    const trials = this.trialsFor(exp, row.executor, now)
    const packId = newId('pck', now)
    const partial = {
      schema: 'gitrader-experiment/1' as const, packId, experimentId: expId, runId: row.runId,
      subjectKey: exp.subjectKey ?? null, window: clone(draft.window), at: now,
      trialCount: trials.trialCount, trialStats: trials.trialStats,
      provenance: { kernelVersion: String(this.lab.k.status().version), protocolVersion: '0.1.12' },
      kind, tier: 'hypothetical' as const, spec: clone(runSpec), specDigest: row.specDigest,
      assumptions: clone(detail.result.assumptions), seed: runSpec.seed, data,
      instrumentMeta, stats: clone(detail.result.stats),
      biasChecks: { lookahead: detail.result.biasChecks?.lookahead ?? 'not_run', recursive: detail.result.biasChecks?.recursive ?? 'not_run' },
      ...(draft.partitions ? { partitions: clone(draft.partitions) } : {}), artifacts,
      ...(returnsArtifact ? { returnsArtifact } : {}), llm: contamination,
    }
    const digest = digestOf(partial)
    const pack: EvidencePack = { ...partial, attestation: { alg: 'ed25519', keyId: this.lab.k.installKey.keyId, digest, sig: this.lab.k.installKey.sign(digest) } } as EvidencePack
    if (!validateBySchemaId('urn:gitrader:schema:model:0.1:EvidencePack', pack).ok) return contradiction('Kernel evidence pack failed protocol validation')
    if (!row.experimentId) { row.experimentId = exp.experimentId; row.subjectKey = exp.subjectKey ?? null }
    row.packId = packId
    next.packs = [...(next.packs ?? []), { packId, kind, tier: 'hypothetical', digest, at: now, runId: row.runId }]
    if (input.note !== undefined) {
      if (CONCLUSION_REDLINE.test(input.note)) return fail('EXPERIMENT_FORBIDDEN', 'Note contains prohibited return language')
      next.notes = [...(next.notes ?? []), { text: input.note, origin: actor.origin, at: now }]
    }
    const linkIds = [...artifacts.map((artifact) => artifact.artifactId), ...(returnsArtifact ? [returnsArtifact.artifactId] : [])]
    this.lab.artifacts.link(expId, packId, linkIds)
    const txResult = tx(this.lab.k.db, () => {
      this.lab.k.docs.put('lab-pack', packId, pack)
      this.save(row, detail)
      if (freezeAfter) this.lab.k.docs.put(FREEZES, expId, freezeAfter)
      return this.lab.write(exp, next, { packId, runId: row.runId }, actor.origin)
    })
    return txResult
  }

  private sameSubject(exp: Experiment, spec: BacktestSpec): boolean {
    const strategy = exp.subject.strategy
    const workflow = exp.subject.workflow
    const strategySpec = spec.subject.strategy
    const workflowSpec = spec.subject.workflow
    if (strategy) return !!strategySpec && strategy.id === strategySpec.id && strategy.version === strategySpec.version && digestOf(exp.subject.params) === digestOf(strategySpec.params)
    if (workflow) return !!workflowSpec && workflow.id === workflowSpec.id && String(workflow.version) === String(workflowSpec.version) && digestOf(exp.subject.params) === digestOf(spec.subject.workflow?.json ?? exp.subject.params)
    return false
  }

  private validWindow(value: unknown): value is { from: number; to: number } {
    return record(value) && Number.isSafeInteger(value.from) && Number.isSafeInteger(value.to) && value.from >= 0 && value.to > value.from
  }

  private equalWindow(a: unknown, b: unknown): boolean { return this.validWindow(a) && this.validWindow(b) && a.from === b.from && a.to === b.to }

  private async validateData(draft: EvidencePackDraft, spec: BacktestSpec): Promise<EvidencePackDraft['data']> {
    const data = draft.data
    if (!data || data.candlesDigestMethod !== CANDLES_DIGEST_METHOD || data.timezone !== 'UTC' || data.alignment !== 'open-time' || !Array.isArray(data.candlesDigests)) return evidence('Candle digest metadata is missing')
    const ids = data.candlesDigests.map((item) => item.instrumentId)
    if (new Set(ids).size !== ids.length || ids.length !== spec.instruments.length || spec.instruments.some((id) => !ids.includes(id))) return contradiction('Candle digest instrument set differs from the run')
    for (const item of data.candlesDigests) if (typeof item.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(item.digest)) return contradiction('Candle digest is malformed')
    if (data.candlesDigest !== undefined && (spec.instruments.length !== 1 || data.candlesDigest !== data.candlesDigests[0]?.digest)) return contradiction('Legacy candle digest conflicts with per-instrument metadata')
    let pointInTime: boolean | 'unknown' = 'unknown'
    if (spec.data.source === 'host') {
      let verified = true
      for (const item of data.candlesDigests) {
        try {
          const candles = await this.lab.k.marketStore.read(item.instrumentId, spec.interval, { from: spec.from, to: spec.to })
          if (!candles.length || await candlesDigest(candles) !== item.digest) verified = false
        } catch { verified = false }
      }
      if (verified) pointInTime = true
    }
    return { source: spec.data.source, pointInTime, candlesDigests: clone(data.candlesDigests), candlesDigestMethod: CANDLES_DIGEST_METHOD, timezone: 'UTC', alignment: 'open-time' }
  }

  private validateInstruments(value: Instrument[], expected: string[]): Instrument[] {
    if (!Array.isArray(value)) return evidence('Instrument metadata is missing')
    const ids = value.map((item) => item?.instrumentId)
    const stray = ids.filter((id) => !expected.includes(id))
    if (new Set(ids).size !== ids.length || stray.length) return contradiction(`Instrument metadata names instruments outside the run: ${stray.join(', ') || 'duplicate entries'}`)
    return clone(value) // 缺的项不报错：包里 instrumentMeta 少于 spec.instruments 即表示「宿主没有这个标的的合约表」
  }

  private validateArtifacts(draft: EvidencePackDraft, engineId: string): BacktestEvidencePack['artifacts'] {
    if (!Array.isArray(draft.artifacts)) return evidence('Required evidence artifacts are missing')
    const required = new Set(['trades', 'equity'])
    const output: BacktestEvidencePack['artifacts'] = []
    for (const ref of draft.artifacts) {
      const artifact = this.lab.artifacts.get(ref.artifactId)
      if (!artifact || artifact.engineId !== engineId || artifact.kind !== ref.kind || artifact.sha256 !== ref.sha256 || artifact.sizeBytes !== ref.sizeBytes || artifact.mediaType !== ref.mediaType) return contradiction('Artifact metadata differs from the stored engine artifact')
      if (ref.kind === 'trades' || ref.kind === 'equity') required.delete(ref.kind)
      this.lab.artifacts.read(ref.artifactId)
      output.push({ artifactId: artifact.artifactId, sha256: artifact.sha256, kind: artifact.kind as 'trades' | 'equity', sizeBytes: artifact.sizeBytes, mediaType: artifact.mediaType })
    }
    if (required.size) return evidence('Trades and equity artifacts are both required')
    return output
  }

  private validateReturns(id: string, sha256: Sha256Digest, engineId: string): BacktestEvidencePack['returnsArtifact'] {
    const artifact = this.lab.artifacts.get(id)
    if (!artifact || artifact.engineId !== engineId || artifact.sha256 !== sha256) return contradiction('Returns artifact metadata differs from the stored engine artifact')
    this.lab.artifacts.read(id)
    return { artifactId: id, sha256 }
  }

  private llmEvidence(exp: Experiment, from: number): BacktestEvidencePack['llm'] {
    const llm = exp.llm ?? { involved: false, derivedFrom: 'declared' as const, models: [] }
    if (!llm.involved) return { ...clone(llm), contaminated: 'no', leakFreeFrom: null }
    if (!llm.models.length || llm.models.some((model) => model.trainingCutoff === undefined)) return { ...clone(llm), contaminated: 'unknown', leakFreeFrom: null }
    const leakFreeFrom = Math.max(...llm.models.map((model) => model.trainingCutoff! + LLM_LEAK_MARGIN_DAYS * 24 * 60 * 60 * 1000))
    return { ...clone(llm), contaminated: from >= leakFreeFrom ? 'no' : 'possible', leakFreeFrom }
  }

  private trialsFor(exp: Experiment, executor: LabRun['executor'] | undefined, now: number): { trialCount: number; trialStats: EvidencePack['trialStats'] } {
    const experiments = this.lab.all()
    const root = (item: Experiment): string => {
      let current = item
      const seen = new Set<string>()
      while (current.lineage?.parentExperimentId) {
        if (seen.has(current.experimentId)) break
        seen.add(current.experimentId)
        const parent = experiments.find((candidate) => candidate.experimentId === current.lineage?.parentExperimentId)
        if (!parent) break
        current = parent
      }
      return current.experimentId
    }
    const familyIds = new Set(experiments.filter((item) => root(item) === root(exp) || (!!exp.subjectKey && item.subjectKey === exp.subjectKey)).map((item) => item.experimentId))
    const completed = this.all().filter((item) => item.kind === 'backtest' && item.status === 'done')
    const familyRuns = completed.filter((item) => item.experimentId && familyIds.has(item.experimentId))
    const recentExecutorRuns = executor ? completed.filter((item) => now - item.startedAt <= TRIAL_WINDOW_DAYS * 24 * 60 * 60 * 1000 && this.sameExecutor(item.executor, executor)) : []
    const relevant = [...new Map([...familyRuns, ...recentExecutorRuns].map((item) => [item.runId, item])).values()]
    const familySpecs = new Set(familyRuns.map((item) => item.specDigest)).size
    const trialStats: EvidencePack['trialStats'] = relevant.map((item) => ({
      runId: item.runId, specDigest: item.specDigest, sharpe: item.stats?.sharpe ?? null, nObs: item.stats?.nObs ?? 0,
    }))
    return { trialCount: Math.max(familySpecs, recentExecutorRuns.length), trialStats }
  }

  private sameExecutor(a: LabRun['executor'], b: LabRun['executor']): boolean {
    return a.kind === b.kind && (a.kind === 'agent' ? a.mandateId === (b as Extract<LabRun['executor'], { kind: 'agent' }>).mandateId : a.engineId === (b as Extract<LabRun['executor'], { kind: 'engine' }>).engineId)
  }

  trials(exp: Experiment): { trialCount: number; trialStats: EvidencePack['trialStats'] } {
    const row = this.all().filter((item) => item.experimentId === exp.experimentId).sort((a, b) => b.startedAt - a.startedAt)[0]
    return this.trialsFor(exp, row?.executor, this.lab.k.clock.now())
  }

  packs(exp: Experiment): EvidencePack[] {
    return (exp.packs ?? []).flatMap((ref) => {
      const pack = this.lab.k.docs.get<EvidencePack>('lab-pack', ref.packId)
      return pack ? [pack] : []
    })
  }
}
