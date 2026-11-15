// SPDX-License-Identifier: CPAL-1.0
import type { Experiment, ExperimentExecutor, ExperimentLlm, ExperimentOwner, ExperimentRun, MandateId, Origin, Sha256Digest } from './proto'
import { KNOWN_MODEL_TRAINING_CUTOFFS } from './proto'
import { validateBySchemaId, validateExperiment } from './proto'
import type { Kernel } from './kernel'
import type { ActorCtx } from './trading'
import { tx } from './db'
import { LabArtifacts } from './lab/artifacts'
import { LabRuns } from './lab/runs'
import { LabForward } from './lab/forward'
import { LabStages } from './lab/stage'
import { LabExport } from './lab/export'
import { fail } from './util/errors'
import { newId, ulid } from './util/ids'
import { digestOf } from './util/hash'
import { D, str, sum } from './util/dec'
import { isAppendOnlyViolation, isReadonlyPatch } from './proto'

const COLL = 'experiment'
const LEDGER_ORG = 'org_local'
const CREATE_KEYS = new Set(['stage', 'title', 'hypothesis', 'subject', 'params', 'assumptions', 'data', 'lineage', 'holdoutWindow', 'llm', 'conclusion', 'conclusions', 'notes'])
const UPDATE_KEYS = new Set(['title', 'hypothesis', 'subject', 'params', 'assumptions', 'data', 'conclusion', 'conclusions', 'notes', 'llm', 'lineage', 'holdoutWindow'])
export const CONCLUSION_REDLINE = /\u4fdd\u5b88|\u6fc0\u8fdb|\u7a33\u8d5a|\u8dd1\u8d62|AI\s*帮你赚钱|保证收益/

type Plain = Record<string, unknown>

function invalid(message = 'Invalid experiment input'): never {
  return fail('INVALID_PARAMS', message)
}

/** R3-12：subject 写错时给出 JSON 指针路径（相对 patch），不再只回一句「Invalid experiment input」。 */
function badSubject(problems: string[]): never {
  return invalid(`Invalid experiment subject: ${problems.join('; ')}. A pin is {kind, id, version, sha256}; sha256 is the strategySha256 of a backtest result (docs/user/04 section 7).`)
}

function pinProblems(base: string, pin: unknown): string[] {
  if (!record(pin)) return [`${base} must be an object {kind, id, version, sha256}`]
  return (['kind', 'id', 'version'] as const).filter((field) => typeof pin[field] !== 'string').map((field) => `${base}/${field} must be a string`)
}

function record(value: unknown): value is Plain {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function assertSafeShape(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value !== 'object') return
  if (seen.has(value)) return invalid()
  seen.add(value)
  if (Array.isArray(value)) {
    for (const item of value) assertSafeShape(item, seen)
  } else {
    for (const [key, item] of Object.entries(value)) {
      if (/[.\[\]]/.test(key)) return invalid()
      assertSafeShape(item, seen)
    }
  }
  seen.delete(value)
}

function clone<T>(value: T): T {
  try { return JSON.parse(JSON.stringify(value)) as T } catch { return invalid() }
}

function checkKeys(value: Plain, allowed: Set<string>): void {
  for (const key of Object.keys(value)) if (!allowed.has(key)) invalid()
}

function checkText(value: unknown): string {
  if (typeof value !== 'string') return invalid()
  if (CONCLUSION_REDLINE.test(value)) return fail('EXPERIMENT_FORBIDDEN', 'Conclusion text contains prohibited return language')
  return value
}

function asDigest(value: unknown): Sha256Digest | undefined {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value) ? value as Sha256Digest : undefined
}

function stripWorkflow(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripWorkflow)
  if (!record(value)) return value
  const out: Plain = {}
  for (const [key, child] of Object.entries(value)) if (key !== 'id' && key !== 'params') out[key] = stripWorkflow(child)
  return out
}

function hasLlmNode(nodes: unknown): boolean {
  if (!Array.isArray(nodes)) return false
  return nodes.some((node) => record(node) && [node.type, node.kind].some((value) => typeof value === 'string' && value.toLowerCase().includes('llm')))
}

function ownerFor(actor: ActorCtx): ExperimentOwner {
  if (actor.origin.actorType === 'human') {
    const userId = actor.principal.kind === 'session' ? actor.principal.userId : actor.origin.actor.slice(actor.origin.actor.indexOf(':') + 1)
    return { actorType: 'human', userId }
  }
  switch (actor.principal.kind) {
    case 'session': return { actorType: 'human', userId: actor.principal.userId }
    case 'agent': {
      const mandateId = actor.principal.mandateId as MandateId
      return { actorType: 'llm-agent', mandateId }
    }
    case 'engine': {
      const mandateId = actor.principal.mandateId as MandateId
      return { actorType: 'engine', mandateId }
    }
    case 'service': return { actorType: 'system' }
  }
}

export class LabService {
  readonly artifacts: LabArtifacts
  readonly runTable: LabRuns
  readonly forwardStats: LabForward
  readonly stages: LabStages
  readonly exports: LabExport

  constructor(readonly k: Kernel, raw?: (engineId: string, method: string, params: any) => Promise<any>) {
    this.artifacts = new LabArtifacts(k.home, k.docs)
    const capturedRaw = raw ?? k.gep.callEngine.bind(k.gep)
    this.runTable = new LabRuns(this, capturedRaw)
    this.forwardStats = new LabForward(this)
    this.stages = new LabStages(this)
    this.exports = new LabExport(this)
  }

  forward(engineId: string, method: string, params: any, actor?: ActorCtx): Promise<any> {
    return this.runTable.forward(engineId, method, params, actor)
  }

  stage(id: string, to: unknown, actor: ActorCtx, proof?: import('./auth').HumanProof): Promise<Experiment> {
    return this.stages.stage(id, to, actor, proof)
  }

  export(id: string): Promise<Record<string, unknown>> {
    return this.exports.export(id)
  }

  verify(input: unknown): Promise<{ status: 'identical' | 'diff'; differences: string[] }> {
    return this.exports.verify(input)
  }

  async handle(action: string, args: Record<string, any>, actor: ActorCtx): Promise<unknown> {
    if (!record(args)) return invalid()
    assertSafeShape(args)
    switch (action) {
      case 'create': return this.create(args.patch, actor, args.engineId)
      case 'get': return this.load(String(args.experimentId ?? ''))
      case 'list': {
        const all = this.all().sort((a, b) => b.updatedAt - a.updatedAt)
        const offset = Math.max(0, Math.trunc(Number(args.cursor ?? 0)) || 0)
        const requestedLimit = Math.trunc(Number(args.limit ?? 20))
        const limit = Number.isFinite(requestedLimit) && requestedLimit > 0 ? Math.min(requestedLimit, 200) : 20
        return { items: all.slice(offset, offset + limit), ...(offset + limit < all.length ? { next: String(offset + limit) } : {}) }
      }
      case 'update': return this.update(String(args.experimentId ?? ''), args.patch, actor, args.engineId)
      case 'attach': return this.attach(String(args.experimentId ?? ''), args.attach, actor)
      case 'pack': return this.runTable.pack(String(args.experimentId ?? ''), args.pack, args.holdoutWindow, actor)
      case 'stage': return this.stages.stage(String(args.experimentId ?? ''), args.to, actor, actor.proof)
      case 'export': return this.exports.export(String(args.experimentId ?? ''))
      case 'verify': return this.exports.verify(args.bundle)
      default: return invalid('Unknown experiment action')
    }
  }

  load(id: string): Experiment {
    if (!id || id.length > 128) return invalid()
    const value = this.k.docs.get<Experiment>(COLL, id)
    if (!value) return fail('EXPERIMENT_EVIDENCE_INCOMPLETE', 'Experiment does not exist')
    return value
  }

  all(): Experiment[] {
    const rows = this.k.db.prepare(
      `SELECT d.doc FROM docs d JOIN (SELECT id, MAX(ver) mv FROM docs WHERE coll=? GROUP BY id) m
       ON d.coll=? AND d.id=m.id AND d.ver=m.mv ORDER BY d.updated_at DESC, d.id`,
    ).all(COLL, COLL) as { doc: string }[]
    return rows.map((row) => JSON.parse(row.doc) as Experiment)
  }

  assertOwner(exp: Experiment, actor: ActorCtx): void {
    if (actor.origin.actorType === 'human') return
    const principalMandate = actor.principal.kind === 'agent' || actor.principal.kind === 'engine'
      ? actor.principal.mandateId : undefined
    if (exp.owner) {
      if (exp.owner.actorType === actor.origin.actorType && principalMandate !== undefined && exp.owner.mandateId === principalMandate) return
      if (exp.owner.actorType === 'system' && actor.origin.actorType === 'system' && exp.origin.actor === actor.origin.actor) return
      return fail('EXPERIMENT_FORBIDDEN', 'Experiment owner mismatch')
    }
    if (actor.principal.kind === 'agent' && actor.origin.actorType === 'llm-agent' &&
      exp.origin.actorType === 'llm-agent' && exp.origin.actor === `agent:${actor.principal.keyId}`) return
    return fail('EXPERIMENT_FORBIDDEN', 'Experiment owner cannot be inferred')
  }

  write(cur: Experiment | undefined, next: Experiment, patch: unknown, origin: Origin): Experiment {
    const at = this.k.clock.now()
    const currentVersion = cur?.version ?? 0
    const doc = clone(next)
    doc.version = currentVersion + 1
    doc.updatedAt = at
    const valid = validateExperiment(doc)
    if (!valid.ok) return invalid('Experiment does not match its protocol schema')
    const docDigest = digestOf(doc)
    tx(this.k.db, () => {
      const row = this.k.db.prepare('SELECT MAX(ver) AS ver FROM docs WHERE coll=? AND id=?').get(COLL, doc.experimentId) as { ver: number | null }
      if ((row.ver ?? 0) !== currentVersion) return fail('BUSY', 'Experiment changed while this write was being prepared')
      this.k.docs.put(COLL, doc.experimentId, doc, doc.version)
      if (!cur) {
        this.k.ledger.append({ type: 'experiment.created', origin, subject: { orgId: LEDGER_ORG, experimentId: doc.experimentId }, payload: { doc, docDigest } })
      } else {
        this.k.ledger.append({ type: 'experiment.updated', origin, subject: { orgId: LEDGER_ORG, experimentId: doc.experimentId }, payload: { fromVersion: currentVersion, toVersion: doc.version, patch, doc, docDigest } })
      }
    })
    return doc
  }

  private async resolveSubject(subjectInput: unknown, paramsInput: unknown, engineId?: unknown): Promise<{ subject: Experiment['subject']; subjectKey: Sha256Digest | null; workflowLlm: boolean }> {
    if (subjectInput !== undefined && !record(subjectInput)) return badSubject(['/subject must be an object'])
    const given = record(subjectInput) ? clone(subjectInput) : {}
    const params = paramsInput ?? given.params ?? {}
    if (!record(params)) return badSubject(['/subject/params must be an object'])
    const subject: Experiment['subject'] = { params: clone(params) as Experiment['subject']['params'] }
    let strategyHash: Sha256Digest | undefined
    let workflowHash: Sha256Digest | undefined
    if (given.strategy !== undefined) {
      const pin = given.strategy as { kind: string; id: string; version: string; sha256?: unknown }
      const strategyProblems = pinProblems('/subject/strategy', pin)
      if (strategyProblems.length) return badSubject(strategyProblems)
      const strategyId = pin.id
      const statuses = this.k.gep.status() as { engineId: string; state: string }[]
      const engine = statuses.find((item) => item.state === 'ready' && (engineId === undefined || item.engineId === engineId))
      if (engine) {
        try {
          const result = await this.k.gep.callEngine(engine.engineId, 'strategy.list', {}) as { strategies?: { id: string; sha256?: string }[] }
          strategyHash = asDigest(result.strategies?.find((entry) => entry.id === strategyId)?.sha256)
        } catch { /* unavailable strategies leave subjectKey unset */ }
      }
      const supplied = asDigest(pin.sha256)
      if (strategyHash || supplied) subject.strategy = { kind: pin.kind, id: pin.id, version: pin.version, sha256: strategyHash ?? supplied as Sha256Digest }
    }
    let workflowLlm = false
    if (given.workflow !== undefined) {
      const pin = given.workflow as { kind: string; id: string; version: string; sha256?: unknown }
      const workflowProblems = pinProblems('/subject/workflow', pin)
      if (workflowProblems.length) return badSubject(workflowProblems)
      const workflow = this.k.docs.get<Plain>('workflow', pin.id)
      if (workflow && Array.isArray(workflow.nodes) && Array.isArray(workflow.edges)) {
        workflowHash = digestOf(stripWorkflow({ nodes: workflow.nodes, edges: workflow.edges }))
        workflowLlm = hasLlmNode(workflow.nodes)
      }
      const supplied = asDigest(pin.sha256)
      if (workflowHash || supplied) subject.workflow = { kind: pin.kind, id: pin.id, version: pin.version, sha256: workflowHash ?? supplied as Sha256Digest }
    }
    const unresolved = (given.strategy !== undefined && !strategyHash) || (given.workflow !== undefined && !workflowHash)
    const hasResolvedPin = !!strategyHash || !!workflowHash
    const subjectKey = hasResolvedPin && !unresolved ? strategyHash ?? workflowHash ?? null : null
    return { subject, subjectKey, workflowLlm }
  }

  private normalizeLlm(input: unknown, actor: ActorCtx, workflowLlm: boolean, prior?: ExperimentLlm): ExperimentLlm | undefined {
    if (input === undefined && actor.origin.actorType !== 'llm-agent' && !workflowLlm) return prior
    const source = input === undefined ? {} : input
    if (!record(source)) return invalid()
    if (source.derivedFrom !== undefined) return fail('EXPERIMENT_FIELD_READONLY', 'LLM derivedFrom is kernel controlled')
    const involved = source.involved ?? prior?.involved ?? (actor.origin.actorType === 'llm-agent' || workflowLlm)
    if (involved !== true) return fail('EXPERIMENT_FIELD_READONLY', 'LLM involvement cannot be set false')
    const rawModels = source.models ?? prior?.models ?? []
    if (!Array.isArray(rawModels)) return invalid()
    const models = rawModels.map((raw) => {
      if (!record(raw) || typeof raw.id !== 'string' || !raw.id) return invalid()
      if (input !== undefined && raw.source !== undefined) return fail('EXPERIMENT_FIELD_READONLY', 'LLM model source is kernel controlled')
      const known = KNOWN_MODEL_TRAINING_CUTOFFS[raw.id]
      const previous = prior?.models.find((item) => item.id === raw.id)?.trainingCutoff
      const trainingCutoff = raw.trainingCutoff
      if (trainingCutoff !== undefined && (typeof trainingCutoff !== 'number' || !Number.isSafeInteger(trainingCutoff))) return invalid()
      const minimum = Math.max(known ?? Number.MIN_SAFE_INTEGER, previous ?? Number.MIN_SAFE_INTEGER)
      if (trainingCutoff !== undefined && trainingCutoff < minimum) return fail('EXPERIMENT_FIELD_READONLY', 'LLM training cutoff cannot move earlier')
      const cutoff = Math.max(known ?? Number.MIN_SAFE_INTEGER, previous ?? Number.MIN_SAFE_INTEGER, trainingCutoff ?? Number.MIN_SAFE_INTEGER)
      return { id: raw.id, ...(cutoff !== Number.MIN_SAFE_INTEGER ? { trainingCutoff: cutoff } : {}), source: known !== undefined ? 'kernel-table' as const : 'declared' as const }
    })
    const derivedFrom = workflowLlm ? 'workflow' : actor.origin.actorType === 'llm-agent' ? 'creator' : 'declared'
    return { involved: true, derivedFrom, models }
  }

  private verifyLineage(parentId: unknown, experimentId: string): void {
    if (parentId === undefined) return
    if (typeof parentId !== 'string' || !parentId || parentId === experimentId) return invalid()
    const seen = new Set<string>([experimentId])
    let current: string | undefined = parentId
    while (current) {
      if (seen.has(current)) return invalid('Experiment lineage contains a cycle')
      seen.add(current)
      const parent: Experiment | undefined = this.k.docs.get<Experiment>(COLL, current)
      if (!parent) return invalid('Experiment lineage parent does not exist')
      current = parent.lineage?.parentExperimentId
    }
  }

  private async create(input: unknown, actor: ActorCtx, engineId?: unknown): Promise<Experiment> {
    if (!record(input)) return invalid()
    assertSafeShape(input)
    const readonly = isReadonlyPatch(Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'stage')))
    if (input.frozen !== undefined) return fail('EXPERIMENT_FIELD_FROZEN', 'Frozen fields are kernel controlled')
    if (readonly.length || input.biasChecks !== undefined) return fail('EXPERIMENT_FIELD_READONLY', 'Read-only experiment fields cannot be set on create')
    checkKeys(input, CREATE_KEYS)
    const checked = validateBySchemaId('urn:gitrader:schema:model:0.1:ExperimentCreatePatch', { title: input.title, hypothesis: input.hypothesis, ...(input.params !== undefined ? { params: input.params } : {}) })
    if (!checked.ok) return invalid('Invalid experiment create shape')
    const now = this.k.clock.now()
    const experimentId = newId('exp', now)
    const resolved = await this.resolveSubject(input.subject, input.params, engineId)
    this.verifyLineage((input.lineage as Plain | undefined)?.parentExperimentId, experimentId)
    const llm = this.normalizeLlm(input.llm, actor, resolved.workflowLlm)
    const candidate: Experiment = {
      experimentId,
      title: input.title as string,
      hypothesis: input.hypothesis as string,
      stage: 'hypothesis',
      subject: resolved.subject,
      origin: actor.origin,
      createdAt: now,
      updatedAt: now,
      owner: ownerFor(actor),
      version: 0,
      subjectKey: resolved.subjectKey,
      executorKind: null,
      stageEnteredAt: now,
      frozen: { hypothesis: false, subject: false, holdout: false },
      holdoutRunId: null,
      runs: [],
      packs: [],
      conclusions: [],
      notes: [],
      ...(input.assumptions !== undefined ? { assumptions: clone(input.assumptions) as Experiment['assumptions'] } : {}),
      ...(input.data !== undefined ? { data: clone(input.data) as Experiment['data'] } : {}),
      ...(input.holdoutWindow !== undefined ? { holdoutWindow: clone(input.holdoutWindow) as Experiment['holdoutWindow'] } : {}),
      ...(input.lineage !== undefined ? { lineage: clone(input.lineage) as Experiment['lineage'] } : {}),
      ...(llm ? { llm } : {}),
    }
    if (input.conclusion !== undefined) {
      const text = checkText(typeof input.conclusion === 'string' ? input.conclusion : record(input.conclusion) ? input.conclusion.text : undefined)
      candidate.conclusion = { text, origin: actor.origin, at: now }
      candidate.conclusions = [{ text, origin: actor.origin, at: now, version: 1 }]
    }
    if (input.conclusions !== undefined) candidate.conclusions = this.stampConclusions(input.conclusions, actor.origin, now, 1)
    if (input.notes !== undefined) candidate.notes = this.stampNotes(input.notes, actor.origin, now)
    return this.write(undefined, candidate, input, actor.origin)
  }

  private stampConclusions(value: unknown, origin: Origin, at: number, version: number): NonNullable<Experiment['conclusions']> {
    if (!Array.isArray(value)) return invalid()
    return value.map((item) => {
      if (!record(item)) return invalid()
      return { text: checkText(item.text), origin, at, version }
    })
  }

  private stampNotes(value: unknown, origin: Origin, at: number): NonNullable<Experiment['notes']> {
    if (!Array.isArray(value)) return invalid()
    return value.map((item) => {
      if (!record(item) || typeof item.text !== 'string') return invalid()
      return { text: item.text, origin, at }
    })
  }

  private async update(id: string, patchInput: unknown, actor: ActorCtx, engineId?: unknown): Promise<Experiment> {
    const cur = this.load(id)
    this.assertOwner(cur, actor)
    if (!record(patchInput)) return invalid()
    assertSafeShape(patchInput)
    if (cur.frozen?.hypothesis && Object.hasOwn(patchInput, 'hypothesis')) return fail('EXPERIMENT_FIELD_FROZEN', 'Experiment hypothesis is frozen')
    if (cur.frozen?.subject && ['subject', 'params', 'assumptions'].some((key) => Object.hasOwn(patchInput, key))) return fail('EXPERIMENT_FIELD_FROZEN', 'Experiment subject is frozen')
    if (cur.frozen?.holdout && Object.hasOwn(patchInput, 'holdoutWindow')) return fail('EXPERIMENT_FIELD_FROZEN', 'Experiment holdout window is frozen')
    if (patchInput.frozen !== undefined) return fail('EXPERIMENT_FIELD_FROZEN', 'Frozen fields are kernel controlled')
    if (patchInput.biasChecks !== undefined) return fail('EXPERIMENT_FIELD_READONLY', 'Bias checks are kernel controlled')
    const readonly = isReadonlyPatch(patchInput)
    if (readonly.length) return fail('EXPERIMENT_FIELD_READONLY', 'Read-only experiment fields cannot be changed')
    const llmPatch = patchInput.llm
    if (record(llmPatch) && (llmPatch.derivedFrom !== undefined || (Array.isArray(llmPatch.models) && llmPatch.models.some((m) => record(m) && m.source !== undefined)))) return fail('EXPERIMENT_FIELD_READONLY', 'LLM provenance fields are kernel controlled')
    checkKeys(patchInput, UPDATE_KEYS)
    const now = this.k.clock.now()
    const validationPatch = clone(patchInput) as Plain
    const nextVersion = (cur.version ?? 0) + 1
    if (record(validationPatch.llm) && Array.isArray(validationPatch.llm.models)) {
      validationPatch.llm.models = validationPatch.llm.models.map((model) => {
        if (!record(model) || typeof model.id !== 'string') return model
        return { ...model, source: KNOWN_MODEL_TRAINING_CUTOFFS[model.id] !== undefined ? 'kernel-table' : 'declared' }
      })
    }
    if (Array.isArray(validationPatch.conclusions)) {
      const priorLength = cur.conclusions?.length ?? 0
      validationPatch.conclusions = validationPatch.conclusions.map((item, index) => index < priorLength ? item :
        record(item) ? { ...item, origin: actor.origin, at: now, version: nextVersion } : item)
    }
    if (Array.isArray(validationPatch.notes)) {
      const priorLength = cur.notes?.length ?? 0
      validationPatch.notes = validationPatch.notes.map((item, index) => index < priorLength ? item :
        record(item) ? { ...item, origin: actor.origin, at: now } : item)
    }
    const patchSchema = validateBySchemaId('urn:gitrader:schema:model:0.1:ExperimentPatch', validationPatch)
    if (!patchSchema.ok) return invalid('Invalid experiment patch shape')

    const next = clone(cur)
    const patch = clone(patchInput)
    if (Object.hasOwn(patch, 'params')) {
      const resolved = await this.resolveSubject({ ...next.subject, params: patch.params }, patch.params, engineId)
      next.subject = resolved.subject
      next.subjectKey = resolved.subjectKey
      if (resolved.workflowLlm) next.llm = this.normalizeLlm(undefined, actor, true, next.llm)
    }
    if (Object.hasOwn(patch, 'subject')) {
      const resolved = await this.resolveSubject(patch.subject, (patch.subject as Plain).params, engineId)
      next.subject = resolved.subject
      next.subjectKey = resolved.subjectKey
      if (resolved.workflowLlm) next.llm = this.normalizeLlm(undefined, actor, true, next.llm)
    }
    if (Object.hasOwn(patch, 'title')) next.title = patch.title as string
    if (Object.hasOwn(patch, 'hypothesis')) next.hypothesis = patch.hypothesis as string
    if (Object.hasOwn(patch, 'assumptions')) next.assumptions = clone(patch.assumptions) as Experiment['assumptions']
    if (Object.hasOwn(patch, 'data')) next.data = clone(patch.data as NonNullable<Experiment['data']>)
    if (Object.hasOwn(patch, 'lineage')) {
      this.verifyLineage((patch.lineage as Plain | undefined)?.parentExperimentId, id)
      next.lineage = clone(patch.lineage) as Experiment['lineage']
    }
    if (Object.hasOwn(patch, 'holdoutWindow')) next.holdoutWindow = clone(patch.holdoutWindow) as Experiment['holdoutWindow']
    if (Object.hasOwn(patch, 'conclusions')) next.conclusions = clone(patch.conclusions as NonNullable<Experiment['conclusions']>)
    if (Object.hasOwn(patch, 'notes')) next.notes = clone(patch.notes as NonNullable<Experiment['notes']>)
    const rawAppendViolations = isAppendOnlyViolation(cur, next)
    if (rawAppendViolations.length) return fail('EXPERIMENT_APPEND_ONLY', 'Append-only experiment fields cannot be rewritten')
    const version = nextVersion
    if (Object.hasOwn(patch, 'conclusions')) {
      const raw = patch.conclusions as NonNullable<Experiment['conclusions']>
      const priorLength = cur.conclusions?.length ?? 0
      next.conclusions = [...(cur.conclusions ?? []), ...this.stampConclusions(raw.slice(priorLength), actor.origin, now, version)]
    }
    if (Object.hasOwn(patch, 'notes')) {
      const raw = patch.notes as NonNullable<Experiment['notes']>
      const priorLength = cur.notes?.length ?? 0
      next.notes = [...(cur.notes ?? []), ...this.stampNotes(raw.slice(priorLength), actor.origin, now)]
    }
    if (Object.hasOwn(patch, 'conclusion')) {
      const value = patch.conclusion
      const text = checkText(typeof value === 'string' ? value : record(value) ? value.text : undefined)
      next.conclusion = { text, origin: actor.origin, at: now }
      next.conclusions = [...(next.conclusions ?? []), { text, origin: actor.origin, at: now, version: (cur.version ?? 0) + 1 }]
    }
    if (Object.hasOwn(patch, 'llm')) next.llm = this.normalizeLlm(patch.llm, actor, !!next.subject.workflow && this.workflowHasLlm(next.subject.workflow.id), cur.llm)
    else if (actor.origin.actorType === 'llm-agent') next.llm = this.normalizeLlm(undefined, actor, !!next.subject.workflow && this.workflowHasLlm(next.subject.workflow.id), cur.llm)
    const appendViolations = isAppendOnlyViolation(cur, next)
    if (appendViolations.length) return fail('EXPERIMENT_APPEND_ONLY', 'Append-only experiment fields cannot be rewritten')
    return this.write(cur, next, patchInput, actor.origin)
  }

  private workflowHasLlm(id: string): boolean {
    return hasLlmNode(this.k.docs.get<Plain>('workflow', id)?.nodes)
  }

  private async attach(id: string, input: unknown, actor: ActorCtx): Promise<Experiment> {
    const cur = this.load(id)
    this.assertOwner(cur, actor)
    const attachSchema = validateBySchemaId('urn:gitrader:schema:model:0.1:ExperimentAttach', input)
    if (!attachSchema.ok || !record(input) || !record(input.run)) return invalid('Invalid experiment attach shape')
    const runInput = input.run
    const executorInput = runInput.executor as ExperimentExecutor
    const accountId = runInput.accountId
    if (typeof accountId !== 'string') return invalid()
    const account = this.k.accounts.get(accountId)
    if (account.mode !== 'paper') return fail('EXPERIMENT_FORBIDDEN', 'Only paper accounts can be attached in this stage')
    let executor: ExperimentExecutor
    if (executorInput.kind === 'agent') {
      if (actor.principal.kind !== 'agent' || actor.principal.mandateId !== executorInput.mandateId) return fail('EXPERIMENT_FORBIDDEN', 'Agent executor must match the authenticated key')
      const mandate = this.k.agents.effective(executorInput.mandateId, this.k.clock.now())
      if (!mandate || !mandate.accounts.includes(account.accountId as never)) return fail('EXPERIMENT_FORBIDDEN', 'Agent mandate does not cover the account')
      executor = { kind: 'agent', mandateId: executorInput.mandateId }
    } else if (executorInput.kind === 'engine') {
      if (actor.principal.kind !== 'session') return fail('EXPERIMENT_FORBIDDEN', 'Engine attach requires a human actor')
      const engineId = executorInput.engineId
      const binding = this.k.docs.get<{ accounts?: { accountId: string; mandateId: string }[] }>('enginebind', engineId)
      const bound = binding?.accounts?.find((entry) => entry.accountId === account.accountId)
      if (!bound) return fail('EXPERIMENT_FORBIDDEN', 'Engine is not bound to the account')
      const [status, listed] = await Promise.all([
        this.k.gep.callEngine(engineId, 'strategy.status', {}) as Promise<{ instances?: { instanceId: string; strategyId: string; accountId: string }[] }>,
        this.k.gep.callEngine(engineId, 'strategy.list', {}) as Promise<{ strategies?: { id: string; sha256?: string }[] }>,
      ])
      const instance = status.instances?.find((item) => item.instanceId === executorInput.instanceId && item.accountId === account.accountId)
      if (!instance) return fail('EXPERIMENT_FORBIDDEN', 'Engine strategy instance is not attached to the account')
      const codeDigest = asDigest(listed.strategies?.find((item) => item.id === instance.strategyId)?.sha256) ?? null
      executor = { kind: 'engine', engineId, instanceId: executorInput.instanceId, codeDigest }
    } else return invalid()
    const duplicate = (cur.runs ?? []).some((existing) => {
      if (existing.accountId !== account.accountId || existing.to !== null || !existing.executor || existing.executor.kind !== executor.kind) return false
      return existing.executor.kind === 'agent'
        ? executor.kind === 'agent' && existing.executor.mandateId === executor.mandateId
        : executor.kind === 'engine' && existing.executor.engineId === executor.engineId && existing.executor.instanceId === executor.instanceId
    })
    if (duplicate) return fail('EXPERIMENT_TRANSITION_DENIED', 'An active run already uses this account and executor')
    const at = this.k.clock.now()
    const headSeq = this.k.ledger.head().seq
    const runId = `run_${ulid(at)}`
    const run: ExperimentRun = {
      runId,
      stage: cur.stage,
      accountId: account.accountId,
      executor,
      from: at,
      to: null,
      attachedAt: at,
      ledgerRange: { fromSeq: headSeq, toSeq: headSeq },
    }
    const snapshot = await this.k.bus.snapshot(account, { maxAgeMs: 0 })
    const start = {
      runId,
      at,
      equity: snapshot.equity,
      unrealizedPnl: str(sum(snapshot.positions.map((position) => D(position.unrealizedPnl)))),
      valuationCcy: account.paper?.ccy ?? 'USD',
      positions: snapshot.positions,
    }
    const next = clone(cur)
    if (next.executorKind && next.executorKind !== executor.kind) return fail('EXPERIMENT_FORBIDDEN', 'Experiment executor kind cannot change')
    next.executorKind = executor.kind
    next.runs = [...(next.runs ?? []), run]
    const valid = validateExperiment(next)
    if (!valid.ok) return invalid('Attached run does not match its protocol schema')
    await this.forwardStats.start(next, at)
    return tx(this.k.db, () => {
      const saved = this.write(cur, next, { attach: { run: runInput } }, actor.origin)
      this.k.docs.put('lab-start', runId, start)
      if (Object.hasOwn(runInput, 'from')) {
        this.k.ledger.append({
          type: 'annotation',
          origin: actor.origin,
          subject: { orgId: LEDGER_ORG, experimentId: cur.experimentId },
          payload: { action: 'experiment.attach', warning: 'Caller-supplied run.from was ignored' },
        })
      }
      return saved
    })
  }
}
