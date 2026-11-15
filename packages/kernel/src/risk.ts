// SPDX-License-Identifier: CPAL-1.0
// 风控：策略服务（用户签名文档、验签、收紧 / 放宽 / 临时放宽）+ 风控闸（预检，纯计算）。
// 铁律（契约 §5.1）：Agent 没有任何入口改限额——收紧要会话，放宽要 PIN 在场证明；策略缺失或验签失败 → HALTED（失败即停）。
import {
  STRONG_ATTESTATION_METHODS, RISK_PRESETS, MANDATE_DEFAULTS, GATE_STAGES, GATE_SCHEMA, makeProblem, DENY_LLM_LIVE_ENTRIES_DEFAULT,
} from './proto'
import type {
  Account, Attestation, AttestationMethod, Decimal, GateDecision, GateInput, GateSnapshot, GateTarget, Instrument, Mandate, Origin, PrecheckStats, Protector, RiskLimits, RiskPolicy, RuleCode, RuleHit, TradingScope,
} from './proto'
export type { PrecheckStats } from './proto'
import { assertProof } from './auth'
import type { HumanProof } from './auth'
import type { Docs } from './db'
import type { EventBus } from './events'
import { InstallKey } from './install-key'
import type { Ledger } from './ledger'
import { isLooser, limitsOfPreset, protectorsOfPreset } from './risk-policy'
import type { AccountSnapshot, MarkPrice, NormalizedIntent } from './connector'
import type { TradingStateService } from './trading-state'
import { ORG_SCOPE } from './trading-state'
import type { ConfigRisk } from './config'
import { DEFAULT_PRESET_ID } from './config'
import { KernelError } from './util/errors'
import { digestOf } from './util/hash'
import { newId } from './util/ids'
import { systemOrigin } from './util/origin'
import type { Clock } from './util/clock'
import { adjustedGateTarget, effectiveGateAction, evaluateGateStages } from './risk-gate/stages'
import { assembleGateInput, canonicalGateInput, cleanGateValue, gateSnapshotDigest, gateTargetDigest, policyRefOf, sizePrecisionAdjustment } from './risk-gate/assemble'
import * as dec from './util/dec'
import { checkGateDecisionConsistency } from '@gitrader/protocol'
import { isDeepStrictEqual } from 'node:util'

const COLL = 'policy'
const DRIFT_COLL = 'approval-price-bound'
interface DriftRule { version: number; maxDriftBps: number; attestation: Attestation }
const strong = (m: AttestationMethod): boolean => (STRONG_ATTESTATION_METHODS as readonly string[]).includes(m)
const SYSTEM = (tool: string): Origin => systemOrigin(tool, 'risk')

export type PolicyPatch = {
  limits?: { [K in keyof RiskLimits]?: RiskLimits[K] | null }
  protectors?: Protector[]
  failClosed?: RiskPolicy['failClosed']
  dailyResetAt?: string
  denyLlmLiveEntries?: boolean
  /** 内核本地参数，不扩展冻结的 RiskPolicy / RiskLimits。 */
  maxDriftBps?: number
}

export interface PolicyIntegrity { ok: boolean; problems: string[] }

export interface RiskStatsActorBucket {
  denied: number
  review: number
  rules: Partial<Record<RuleCode, number>>
  /** 该 actor 创建的提案数；只在有提案的 actor 上出现。 */
  proposals?: number
}

export interface RiskStats {
  denied: number
  review: number
  deduplicatedBy: string
  byActor: Record<string, RiskStatsActorBucket>
  byRule: Partial<Record<RuleCode, number>>
}

export interface GateReplayDifference { field: string; recorded?: unknown; replayed?: unknown; reason?: string }
export interface GateReplayResult {
  status: 'identical' | 'diff'
  differences: GateReplayDifference[]
  recordedRulesetVersion?: string
  currentRulesetVersion?: string
}
type GateReplayEvaluator = (input: GateInput) => GateDecision
const CURRENT_GATE_RULESET_VERSION = '0.1.2'

export class RiskService {
  integrity: PolicyIntegrity = { ok: true, problems: [] }
  private replayEvaluator?: GateReplayEvaluator

  constructor(private docs: Docs, private ledger: Ledger, private events: EventBus, private clock: Clock, private installKey: InstallKey) {}

  signGateDigest(digest: string): string { return this.installKey.sign(digest) }

  bindReplayEvaluator(evaluator: GateReplayEvaluator): void { this.replayEvaluator = evaluator }

  replay(precheckId: string): GateReplayResult {
    if (!precheckId) throw new KernelError(makeProblem('INVALID_PARAMS', 'precheckId is required'))
    let entry: ReturnType<Ledger['findGate']>
    try { entry = this.ledger.findGate(precheckId) } catch {
      return { status: 'diff', differences: [{ field: 'gate', reason: 'ledger gate record is malformed' }], currentRulesetVersion: CURRENT_GATE_RULESET_VERSION }
    }
    if (!entry) throw new KernelError(makeProblem('INVALID_PARAMS', `no gate record for ${precheckId}`))
    const differences: GateReplayDifference[] = []
    const add = (field: string, reason: string, recorded?: unknown, replayed?: unknown): void => {
      differences.push({ field, reason, ...(recorded === undefined ? {} : { recorded }), ...(replayed === undefined ? {} : { replayed }) })
    }
    const payload = (entry as typeof entry & { payload?: unknown }).payload
    const gate = payload !== null && typeof payload === 'object' ? (payload as { gate?: unknown }).gate : undefined
    if (gate === undefined || gate === null || typeof gate !== 'object') {
      add('gate', 'recorded gate payload is missing or malformed')
      return { status: 'diff', differences }
    }
    const recordedGate = gate as { decision?: unknown; snapshot?: unknown; target?: unknown }
    if (!this.replayEvaluator) {
      add('replay', 'deterministic evaluator is not bound')
      return { status: 'diff', differences }
    }
    if (recordedGate.decision === null || typeof recordedGate.decision !== 'object') {
      add('decision', 'recorded decision is missing or malformed')
      return { status: 'diff', differences }
    }
    if (recordedGate.snapshot === null || typeof recordedGate.snapshot !== 'object') {
      add('snapshot', 'recorded snapshot is missing or malformed')
      return { status: 'diff', differences }
    }
    if (recordedGate.target === null || typeof recordedGate.target !== 'object') {
      add('target', 'recorded target is missing or malformed')
      return { status: 'diff', differences }
    }
    const decision = recordedGate.decision as GateDecision
    const snapshot = recordedGate.snapshot as GateSnapshot
    const target = recordedGate.target as GateTarget
    const recordedRulesetVersion = typeof decision.gate?.rulesetVersion === 'string' ? decision.gate.rulesetVersion : undefined
    const currentRulesetVersion = CURRENT_GATE_RULESET_VERSION
    if (!recordedRulesetVersion) add('gate.rulesetVersion', 'recorded ruleset version is missing')
    else if (recordedRulesetVersion !== currentRulesetVersion) add('gate.rulesetVersion', 'ruleset version differs', recordedRulesetVersion, currentRulesetVersion)
    if (decision.precheckId !== precheckId || entry.precheck?.precheckId !== precheckId || (entry.subject as { precheckId?: string } | undefined)?.precheckId !== precheckId || snapshot.precheckId !== precheckId) {
      add('precheckId', 'recorded precheck identifiers do not agree')
    }
    const decisionAttestation = decision.attestation
    if (!decisionAttestation || typeof decisionAttestation.digest !== 'string' || typeof decisionAttestation.sig !== 'string') {
      add('decision.attestation', 'recorded decision attestation is missing or malformed')
    } else {
      const { attestation: _attestation, ...unsigned } = decision
      const actualDigest = digestOf(unsigned)
      if (actualDigest !== decisionAttestation.digest) add('decision.attestation.digest', 'recorded decision digest does not match its body')
      else if (!InstallKey.verify(this.installKey.publicKey, actualDigest, decisionAttestation.sig)) add('decision.attestation.sig', 'recorded decision signature is invalid')
    }
    let historicalPolicy: RiskPolicy | null = null
    const snapshotPolicy = snapshot.policy
    if (!isDeepStrictEqual(decision.policyRef, snapshotPolicy)) add('policyRef', 'decision policy reference does not match snapshot')
    if (snapshotPolicy !== null) {
      if (!snapshotPolicy || typeof snapshotPolicy !== 'object' || typeof snapshotPolicy.policyId !== 'string' || !Number.isInteger(snapshotPolicy.version) || typeof snapshotPolicy.digest !== 'string') {
        add('policy', 'historical policy reference is malformed')
      } else {
        try {
          const stored = this.docs.get<RiskPolicy>('policy', snapshotPolicy.policyId, snapshotPolicy.version)
          if (!stored) add('policy', 'historical policy document is missing')
          else if (stored.policyId !== snapshotPolicy.policyId || stored.version !== snapshotPolicy.version || stored.attestation?.digest !== snapshotPolicy.digest) add('policy', 'historical policy identity or digest differs from reference')
          else {
            const { attestation, ...body } = stored
            if (digestOf(body) !== attestation.digest) add('policy', 'historical policy body digest is invalid')
            else if (!InstallKey.verify(this.installKey.publicKey, attestation.digest, attestation.sig)) add('policy', 'historical policy signature is invalid')
            else historicalPolicy = stored
          }
        } catch {
          add('policy', 'historical policy document is malformed')
        }
      }
    }
    if (snapshotPolicy === null && decision.policyRef !== null) add('policy', 'recorded policy reference is inconsistent')
    try {
      if (gateTargetDigest(target) !== decision.targetDigest) add('targetDigest', 'recorded target digest does not match target')
      const computedSnapshotDigest = digestOf(snapshot)
      if (computedSnapshotDigest !== decision.snapshotDigest) add('snapshotDigest', 'recorded snapshot digest does not match snapshot')
      if (differences.length > 0) return { status: 'diff', differences, ...(recordedRulesetVersion ? { recordedRulesetVersion } : {}), currentRulesetVersion }
      const replayInput = cleanGateValue({ ...snapshot, target, policy: historicalPolicy }) as GateInput
      const replayed = this.replayEvaluator(canonicalGateInput(replayInput))
      if (decision.decision !== replayed.decision) add('decision', 'replayed decision differs', decision.decision, replayed.decision)
      const comparableRules = (hits: RuleHit[]): Omit<RuleHit, 'message'>[] => hits.map(({ message: _message, ...hit }) => hit)
      if (!isDeepStrictEqual(comparableRules(decision.ruleHits), comparableRules(replayed.ruleHits))) add('ruleHits', 'replayed rule hits differ')
      if (!isDeepStrictEqual(decision.applied, replayed.applied)) add('applied', 'replayed adjustments differ', decision.applied, replayed.applied)
      if (!isDeepStrictEqual(decision.allowedActions, replayed.allowedActions)) add('allowedActions', 'replayed allowed actions differ')
    } catch {
      add('replay', 'recorded gate input cannot be safely evaluated')
    }
    return { status: differences.length === 0 ? 'identical' : 'diff', differences, ...(recordedRulesetVersion ? { recordedRulesetVersion } : {}), currentRulesetVersion }
  }

  private chain(): { policyId: string; versions: RiskPolicy[] } | undefined {
    const all = this.docs.list<RiskPolicy>(COLL)
    const head = all.find((p) => p.scope.type === 'org')
    if (!head) return undefined
    return { policyId: head.policyId, versions: this.docs.versions<RiskPolicy>(COLL, head.policyId) }
  }
  current(): RiskPolicy | undefined { const c = this.chain(); return c?.versions[c.versions.length - 1] }
  history(): RiskPolicy[] { return this.chain()?.versions ?? [] }

  private attest(p: object, method: AttestationMethod): Attestation {
    const digest = digestOf(p)
    return { method, by: 'usr_local', at: this.clock.now(), digest, sig: this.installKey.sign(digest) }
  }

  /** 验签 + 单调性 + "非强签名版本不得比最近一次强签名版本更宽"。结果存到 this.integrity。 */
  verify(): PolicyIntegrity {
    const problems: string[] = []
    const c = this.chain()
    if (!c) {
      const had = this.ledger.query({ types: ['policy.changed', 'policy.relaxed'], limit: 1 }).length > 0
      if (had) problems.push('risk policy is missing but the ledger shows it existed')
    } else {
      let lastStrong: RiskPolicy | undefined
      c.versions.forEach((v, i) => {
        if (v.version !== i + 1) problems.push(`policy version sequence broken at index ${i}`)
        const { attestation, ...rest } = v
        if (!attestation || digestOf(rest) !== attestation.digest) problems.push(`policy v${v.version}: digest mismatch`)
        else if (!InstallKeyVerify(this.installKey, attestation)) problems.push(`policy v${v.version}: signature invalid`)
        if (attestation && strong(attestation.method)) lastStrong = v
        else if (lastStrong) {
          const why = isLooser(v, lastStrong)
          if (why.length) problems.push(`policy v${v.version} (${attestation?.method}) is looser than strong-signed v${lastStrong.version}: ${why.join(',')}`)
        }
      })
    }
    const drift = this.docs.versions<DriftRule>(DRIFT_COLL, 'org')
    let ceiling = 30
    for (const [i, v] of drift.entries()) {
      const { attestation, ...body } = v
      if (v.version !== i + 1 || !Number.isSafeInteger(v.maxDriftBps) || v.maxDriftBps < 0) problems.push('approval price bound version or value invalid')
      if (!attestation || digestOf(body) !== attestation.digest || !InstallKeyVerify(this.installKey, attestation)) problems.push('approval price bound signature invalid')
      if (attestation && strong(attestation.method)) ceiling = v.maxDriftBps
      else if (v.maxDriftBps > ceiling) problems.push('approval price bound widened without PIN')
      ceiling = Math.min(ceiling, v.maxDriftBps)
    }
    const recorded = [...this.ledger.iterate()].filter((e) => (e.payload as Record<string, unknown> | undefined)?.localRule === DRIFT_COLL)
    if (recorded.length > drift.length) problems.push('signed approval price bound history is missing')
    this.integrity = { ok: problems.length === 0, problems }
    return this.integrity
  }

  maxDriftBps(): number { return this.docs.get<DriftRule>(DRIFT_COLL, 'org')?.maxDriftBps ?? 30 }
  exportPolicy(): object { return { policy: this.current() ?? null, approvalPriceBound: this.docs.get<DriftRule>(DRIFT_COLL, 'org') ?? null, integrity: this.verify() } }
  stats(opts: { sinceTs?: number } = {}): RiskStats {
    const sinceTs = opts.sinceTs
    const denied = new Set<string>()
    const review = new Set<string>()
    const byActor: Record<string, RiskStatsActorBucket> = {}
    const byRule: Partial<Record<RuleCode, number>> = {}
    const bucket = (actor: string): RiskStatsActorBucket => (byActor[actor] ??= { denied: 0, review: 0, rules: {} })
    for (const e of this.ledger.iterate()) {
      // 起点过滤按账本条目的事件时间 ts（未传 sinceTs 时不过滤）。
      if (sinceTs !== undefined && e.ts < sinceTs) continue
      if (e.type === 'proposal.created') {
        const proposed = bucket(e.origin.actor)
        proposed.proposals = (proposed.proposals ?? 0) + 1
        continue
      }
      const gate = (e.payload as { gate?: { decision?: GateDecision; snapshot?: GateSnapshot } } | undefined)?.gate
      if (!gate?.decision || !gate.snapshot || gate.snapshot.dryRun) continue
      const key = `${e.subject.accountId ?? ''}:${e.subject.clientOrderId ?? gate.decision.targetDigest}`
      const verdict = gate.decision.verdict
      const newReview = verdict === 'review' && !review.has(key)
      const newDeny = (gate.snapshot.path === 'direct' || gate.snapshot.path === 'approved' || gate.snapshot.path === 'proposal') && verdict === 'deny' && !denied.has(key)
      if (!newReview && !newDeny) continue
      if (newReview) review.add(key)
      if (newDeny) denied.add(key)
      const b = bucket(e.origin.actor)
      if (newReview) b.review++
      if (newDeny) b.denied++
      const seenCodes = new Set<RuleCode>()
      for (const hit of gate.decision.ruleHits) {
        if (seenCodes.has(hit.code)) continue
        seenCodes.add(hit.code)
        b.rules[hit.code] = (b.rules[hit.code] ?? 0) + 1
        byRule[hit.code] = (byRule[hit.code] ?? 0) + 1
      }
    }
    return { denied: denied.size, review: review.size, deduplicatedBy: 'accountId+clientOrderId', byActor, byRule }
  }
  private writeDrift(value: number, method: AttestationMethod, origin: Origin): void {
    if (!Number.isSafeInteger(value) || value < 0) throw new KernelError(makeProblem('INVALID_PARAMS', 'maxDriftBps must be a non-negative integer'))
    const prior = this.docs.get<DriftRule>(DRIFT_COLL, 'org')
    if (prior?.maxDriftBps === value) return
    const body = { version: (prior?.version ?? 0) + 1, maxDriftBps: value }
    const rule = { ...body, attestation: this.attest(body, method) }
    this.docs.put(DRIFT_COLL, 'org', rule, body.version)
    this.ledger.append({ type: 'annotation', origin, subject: { orgId: 'org_local' }, payload: { localRule: DRIFT_COLL, ...body, digest: rule.attestation.digest, method, change: value > (prior?.maxDriftBps ?? 30) ? 'relax' : 'tighten' } })
  }

  /** 生效限额：当前版本 + 临时放宽（未到期时覆盖对应字段）。 */
  effectiveLimits(now = this.clock.now()): RiskLimits {
    const cur = this.current()
    if (!cur) return { maxSlippageBps: 50 }
    const r = cur.temporaryRelax
    return r && r.until > now && r.from <= now ? ({ ...cur.limits, ...r.fields } as RiskLimits) : cur.limits
  }

  private write(base: Omit<RiskPolicy, 'attestation' | 'version'>, method: AttestationMethod, type: 'policy.changed' | 'policy.relaxed' | 'policy.reverted', origin: Origin, why: Record<string, unknown>): RiskPolicy {
    const prev = this.current()
    const version = (prev?.version ?? 0) + 1
    const body = { ...base, version } as Omit<RiskPolicy, 'attestation'>
    const doc: RiskPolicy = { ...body, attestation: this.attest(body, method) }
    this.docs.put(COLL, doc.policyId, doc, version)
    this.ledger.append({ type, origin, subject: { policyId: doc.policyId }, payload: { version, method, digest: doc.attestation.digest, ...why }, attestation: 'user-asserted' })
    this.events.publish('risk.state', { kind: 'policy', version, ts: this.clock.now() })
    this.verify()
    return doc
  }

  private merge(cur: RiskPolicy, patch: PolicyPatch): Omit<RiskPolicy, 'attestation' | 'version'> {
    const limits: Record<string, unknown> = { ...cur.limits }
    for (const [k, v] of Object.entries(patch.limits ?? {})) { if (v === null) delete limits[k]; else limits[k] = v }
    if (limits.maxSlippageBps === undefined) throw new KernelError(makeProblem('INVALID_PARAMS', 'limits.maxSlippageBps is required'))
    const { attestation: _a, version: _v, ...rest } = cur
    return { ...rest, limits: limits as unknown as RiskLimits, protectors: patch.protectors ?? cur.protectors, failClosed: patch.failClosed ?? cur.failClosed, dailyResetAt: patch.dailyResetAt ?? cur.dailyResetAt, denyLlmLiveEntries: patch.denyLlmLiveEntries ?? cur.denyLlmLiveEntries ?? DENY_LLM_LIVE_ENTRIES_DEFAULT, temporaryRelax: cur.temporaryRelax ?? null }
  }

  private configApplied(): { digest: string; at: number } | undefined {
    return this.docs.get<{ digest: string; at: number }>('risk', 'config_applied')
  }
  private markConfigApplied(digest: string): void {
    this.docs.put('risk', 'config_applied', { digest, at: this.clock.now() })
  }
  private appendConfigApplied(digest: string, tightened: string[], ignored: string[]): void {
    this.ledger.append({ type: 'annotation', origin: SYSTEM('config:apply'), subject: { orgId: 'org_local' }, payload: { kind: 'policy.config_applied', digest, tightened, ignored } })
  }

  /** 启动时按配置文件播种 / 对齐。配置只能把策略*收紧或保持*；更宽的配置被忽略并报告（放宽走人面 + PIN）。 */
  seedFromConfig(cfg: ConfigRisk): { action: 'created' | 'tightened' | 'unchanged' | 'ignored-looser'; warnings: string[] } {
    const drift = cfg.maxDriftBps ?? 30
    const driftMissing = !this.docs.get<DriftRule>(DRIFT_COLL, 'org')
    const driftHad = driftMissing && [...this.ledger.iterate()].some((e) => (e.payload as Record<string, unknown> | undefined)?.localRule === DRIFT_COLL)
    const driftWarnings = drift > this.maxDriftBps() ? ['gitrader.json maxDriftBps widening ignored; use PIN presence'] : []
    if (!driftHad && (cfg.maxDriftBps !== undefined || !driftMissing)) this.writeDrift(Math.min(drift, this.maxDriftBps()), 'system', SYSTEM('config:price-bound'))
    const presetId = cfg.preset ?? DEFAULT_PRESET_ID
    const limits = { ...limitsOfPreset(presetId), ...(cfg.limits ?? {}) } as RiskLimits
    if (limits.maxSlippageBps === undefined) limits.maxSlippageBps = 50
    const protectors = cfg.protectors?.length ? cfg.protectors : protectorsOfPreset(presetId)
    const failClosed = cfg.failClosed ?? { stalePriceMs: 5000, onMissingPrice: 'deny' as const }
    const dailyResetAt = cfg.dailyResetAt ?? '00:00Z'
    const denyLlmLiveEntries = cfg.denyLlmLiveEntries ?? DENY_LLM_LIVE_ENTRIES_DEFAULT
    // ADR-3：缺省不落字段（= false），老配置不会被写出一条显式 false。
    const requireStopOnAgentOpen = cfg.requireStopOnAgentOpen
    const valuationCcy = cfg.valuationCcy ?? 'USDC'
    const stopRequired = (v: boolean | undefined): boolean => v === true
    const cfgDigest = digestOf({ preset: presetId, limits, protectors, failClosed, dailyResetAt, denyLlmLiveEntries, requireStopOnAgentOpen: stopRequired(requireStopOnAgentOpen), maxDriftBps: drift })
    const cur = this.current()
    const applied = this.configApplied()
    const want: Pick<RiskPolicy, 'limits' | 'failClosed' | 'dailyResetAt' | 'denyLlmLiveEntries' | 'requireStopOnAgentOpen'> & { protectors: Protector[] } = {
      limits, protectors, failClosed, dailyResetAt, denyLlmLiveEntries,
      ...(requireStopOnAgentOpen === undefined ? {} : { requireStopOnAgentOpen }),
    }
    if (!cur) {
      // 账本里出现过风控策略、现在却没了 = 被删（失败即停）：不能悄悄重新播种掩盖它，交给 verify() 判 HALTED。
      if (this.ledger.query({ types: ['policy.changed', 'policy.relaxed'], limit: 1 }).length > 0) return { action: 'unchanged', warnings: ['the signed risk policy is missing although the ledger shows it existed; not re-seeding (trading stays HALTED)'] }
      this.write({ policyId: newId('pol'), scope: { type: 'org', id: 'org_local' }, limits, protectors, failClosed, denyLlmLiveEntries, temporaryRelax: null, dailyResetAt, valuationCcy }, 'system', 'policy.changed', SYSTEM('config:seed'), { reason: 'initial policy from gitrader.json', preset: presetId })
      this.markConfigApplied(cfgDigest)
      return { action: 'created', warnings: driftWarnings }
    }
    // ADR-7：配置文件摘要没变 → 不合并，保留工作台 PIN 放宽过的签名策略。
    if (applied?.digest === cfgDigest) return { action: 'unchanged', warnings: driftWarnings }
    // 老 home 第一次升级：只记下当前配置摘要，视为已应用，不冲掉已有的放宽。
    if (!applied) {
      this.markConfigApplied(cfgDigest)
      return { action: 'unchanged', warnings: driftWarnings }
    }
    if (digestOf({ l: cur.limits, p: cur.protectors ?? [], f: cur.failClosed, r: cur.dailyResetAt, k: cur.denyLlmLiveEntries !== false, s: stopRequired(cur.requireStopOnAgentOpen) }) === digestOf({ l: limits, p: protectors, f: failClosed, r: dailyResetAt, k: denyLlmLiveEntries, s: stopRequired(requireStopOnAgentOpen) })) {
      this.markConfigApplied(cfgDigest)
      return { action: 'unchanged', warnings: driftWarnings }
    }
    const why = isLooser(want, cur)
    // ADR-3：现策略开启、配置关闭或缺省 = 放宽。
    if (cur.requireStopOnAgentOpen === true && want.requireStopOnAgentOpen !== true) why.push('requireStopOnAgentOpen')
    const warnings = [...driftWarnings, ...(why.length ? [`gitrader.json looser risk fields ignored (${why.join(', ')}); loosening needs PIN presence.`] : [])]
    // 每个字段分别判断；较宽字段保留签名值，其余收紧仍生效。
    const merged = structuredClone(want)
    const lm = merged.limits as unknown as Record<string, unknown>
    const old = cur.limits as unknown as Record<string, unknown>
    for (const key of why) {
      if (key in lm || key in old) { if (old[key] === undefined) delete lm[key]; else lm[key] = old[key] }
      else if (key === 'denyLlmLiveEntries') merged.denyLlmLiveEntries = cur.denyLlmLiveEntries !== false
      else if (key === 'requireStopOnAgentOpen') merged.requireStopOnAgentOpen = cur.requireStopOnAgentOpen === true
      else if (key === 'dailyResetAt') merged.dailyResetAt = cur.dailyResetAt
      else if (key.startsWith('failClosed.')) Object.assign(merged.failClosed, { [key.slice(11)]: cur.failClosed[key.slice(11) as keyof typeof cur.failClosed] })
    }
    const protectorKey = (p: Protector, i: number): string => p.kind === 'plugin' ? `plugin:${p.pluginId}:${i}` : p.kind === 'stoploss_guard' ? `stoploss_guard:${p.scope}` : p.kind
    for (const [i, p] of (cur.protectors ?? []).entries()) {
      const key = protectorKey(p, i)
      if (!why.includes(`protector:${key}`)) continue
      const index = merged.protectors.findIndex((item, n) => protectorKey(item, n) === key)
      if (index >= 0) merged.protectors[index] = p
      else merged.protectors.push(p)
    }
    const changes: { field: string; from: unknown; to: unknown }[] = []
    const oldLimits = cur.limits as unknown as Record<string, unknown>
    const newLimits = merged.limits as unknown as Record<string, unknown>
    for (const key of new Set([...Object.keys(oldLimits), ...Object.keys(newLimits)])) {
      if (!isDeepStrictEqual(oldLimits[key], newLimits[key])) changes.push({ field: key, from: oldLimits[key], to: newLimits[key] })
    }
    if (!isDeepStrictEqual(cur.protectors ?? [], merged.protectors ?? [])) changes.push({ field: 'protectors', from: cur.protectors ?? [], to: merged.protectors ?? [] })
    for (const key of ['stalePriceMs', 'onMissingPrice'] as const) {
      if (!isDeepStrictEqual(cur.failClosed[key], merged.failClosed[key])) changes.push({ field: `failClosed.${key}`, from: cur.failClosed[key], to: merged.failClosed[key] })
    }
    if (cur.dailyResetAt !== merged.dailyResetAt) changes.push({ field: 'dailyResetAt', from: cur.dailyResetAt, to: merged.dailyResetAt })
    const oldDeny = cur.denyLlmLiveEntries !== false
    const newDeny = merged.denyLlmLiveEntries !== false
    if (oldDeny !== newDeny) changes.push({ field: 'denyLlmLiveEntries', from: oldDeny, to: newDeny })
    const oldStop = stopRequired(cur.requireStopOnAgentOpen)
    const newStop = stopRequired(merged.requireStopOnAgentOpen)
    if (oldStop !== newStop) changes.push({ field: 'requireStopOnAgentOpen', from: oldStop, to: newStop })
    const valueText = (v: unknown): string => v === undefined ? '缺省' : typeof v === 'string' ? v : JSON.stringify(v)
    const tightened = changes.map((c) => c.field)
    const tightenedWarnings = changes.map((c) => `配置文件把 ${c.field} 由 ${valueText(c.from)} 收紧为 ${valueText(c.to)}`)
    if (digestOf({ ...merged, requireStopOnAgentOpen: stopRequired(merged.requireStopOnAgentOpen) }) === digestOf({ limits: cur.limits, protectors: cur.protectors ?? [], failClosed: cur.failClosed, dailyResetAt: cur.dailyResetAt, denyLlmLiveEntries: cur.denyLlmLiveEntries !== false, requireStopOnAgentOpen: stopRequired(cur.requireStopOnAgentOpen) })) {
      this.appendConfigApplied(cfgDigest, [], why)
      this.markConfigApplied(cfgDigest)
      return { action: why.length ? 'ignored-looser' : 'unchanged', warnings }
    }
    this.write({ ...this.merge(cur, {}), ...merged }, 'system', 'policy.changed', SYSTEM('config:tighten'), { reason: 'gitrader.json stricter fields merged', preset: presetId, ignored: why })
    this.appendConfigApplied(cfgDigest, tightened, why)
    this.markConfigApplied(cfgDigest)
    return { action: 'tightened', warnings: [...warnings, ...tightenedWarnings] }
  }

  /** 收紧：会话即可。比当前更宽 → 拒绝（请走 relax + PIN）。Agent 没有这个入口。 */
  tighten(patch: PolicyPatch, proof: HumanProof, origin: Origin): RiskPolicy {
    assertProof(proof, 'session')
    const cur = this.requireCurrent()
    const next = this.merge(cur, patch)
    const why = isLooser(next, cur)
    if (patch.maxDriftBps !== undefined && patch.maxDriftBps > this.maxDriftBps()) why.push('maxDriftBps')
    if (why.length) throw new KernelError(makeProblem('AUTH_FAILED', `this change loosens the policy (${why.join(', ')}); use relax with PIN presence`))
    // ADR-33：临时放宽是覆盖层。被收紧的键从覆盖层里去掉（空了置 null），收紧后的生效值 = 新基线。
    const overlay = cur.temporaryRelax
    const cleared = overlay ? isLooser(cur, next).filter((k) => k in overlay.fields) : []
    if (overlay && cleared.length) {
      const fields = Object.fromEntries(Object.entries(overlay.fields).filter(([k]) => !cleared.includes(k)))
      next.temporaryRelax = Object.keys(fields).length ? { ...overlay, fields } : null
    }
    if (patch.maxDriftBps !== undefined) this.writeDrift(patch.maxDriftBps, proof.presence === 'pin' ? 'pin' : 'session', origin)
    return this.write(next, proof.presence === 'pin' ? 'pin' : 'session', 'policy.changed', origin, { change: 'tighten', patch: summarize(patch), ...(cleared.length ? { clearedRelax: cleared } : {}) })
  }

  /** 放宽：必须 PIN 在场证明。写 policy.relaxed。 */
  relax(patch: PolicyPatch, proof: HumanProof, origin: Origin): RiskPolicy {
    assertProof(proof, 'pin')
    const cur = this.requireCurrent()
    const next = this.merge(cur, patch)
    if (patch.maxDriftBps !== undefined) this.writeDrift(patch.maxDriftBps, 'pin', origin)
    return this.write(next, 'pin', 'policy.relaxed', origin, { change: 'relax', patch: summarize(patch), loosened: isLooser(next, cur) })
  }

  /**
   * v0.1.2：大模型来源的实盘开仓开关。开（deny=true）是收紧，会话即可；
   * 关（deny=false）是放宽，只能人面 + PIN，且入账 policy.relaxed 并带明确的 allow_llm_live_entries 标记。
   */
  setDenyLlmLiveEntries(deny: boolean, proof: HumanProof, origin: Origin): RiskPolicy {
    if (deny) return this.tighten({ denyLlmLiveEntries: true }, proof, origin)
    assertProof(proof, 'pin')
    const cur = this.requireCurrent()
    return this.write(this.merge(cur, { denyLlmLiveEntries: false }), 'pin', 'policy.relaxed', origin, { change: 'allow_llm_live_entries', denyLlmLiveEntries: false })
  }

  /** 临时放宽：PIN，≤24 小时，到期由 tick() 自动回收。fields 只能含 RiskLimits 已知键（fix-r4 C1）。 */
  temporaryRelax(fields: Partial<RiskLimits>, until: number, proof: HumanProof, origin: Origin): RiskPolicy {
    assertProof(proof, 'pin')
    if (typeof fields !== 'object' || fields === null || Array.isArray(fields)) throw new KernelError(makeProblem('INVALID_PARAMS', 'fields must be an object of risk limits'))
    const unknown = Object.keys(fields).filter((key) => !RISK_LIMIT_KEYS.includes(key))
    if (unknown.length) throw new KernelError(makeProblem('INVALID_PARAMS', `unknown risk limit field(s): ${unknown.join(', ')}`))
    const now = this.clock.now()
    if (!(until > now) || until - now > MANDATE_DEFAULTS.temporaryRelaxMaxMs) throw new KernelError(makeProblem('INVALID_PARAMS', 'temporary relax must expire within 24 hours'))
    const cur = this.requireCurrent()
    const base = this.merge(cur, {})
    // ADR-33：与仍有效的覆盖层合并（同键以新值为准），until 取本次传入值；合并后任何一项比基线更严都不算放宽，拒绝。
    const live = cur.temporaryRelax && cur.temporaryRelax.until > now ? cur.temporaryRelax : null
    const merged = { ...(live?.fields ?? {}), ...fields }
    const tighter = isLooser(cur, { ...cur, limits: { ...cur.limits, ...merged } }).filter((k) => k in merged)
    if (tighter.length) throw new KernelError(makeProblem('INVALID_PARAMS', `temporary relax must loosen the baseline; tighter than baseline: ${tighter.join(', ')}`))
    return this.write({ ...base, temporaryRelax: { fields: merged, from: now, until, revertToVersion: live?.revertToVersion ?? cur.version } }, 'pin', 'policy.relaxed', origin, { change: 'temporaryRelax', until, fields: summarize({ limits: fields }) })
  }

  /** 到期回收临时放宽（系统签名的收紧版本）。 */
  tick(): boolean {
    const cur = this.current()
    if (!cur?.temporaryRelax || cur.temporaryRelax.until > this.clock.now()) return false
    const base = this.merge(cur, {})
    this.write({ ...base, temporaryRelax: null }, 'system', 'policy.reverted', SYSTEM('risk:relax-expired'), { revertedFrom: cur.version, revertToVersion: cur.temporaryRelax.revertToVersion })
    return true
  }

  private requireCurrent(): RiskPolicy {
    const cur = this.current()
    if (!cur) throw new KernelError(makeProblem('TRADING_STATE', 'no risk policy loaded'))
    return cur
  }
}

/** RiskLimits 的全部键；`satisfies` 保证类型加键时这里编译不过，不会悄悄漏。 */
const RISK_LIMIT_KEYS: readonly string[] = Object.keys({
  maxLeverage: 1, maxOrderNotional: 1, maxPositionNotionalRatio: 1, maxTotalNotionalRatio: 1, maxOpenPositions: 1, maxDailyLossRatio: 1, maxDailyNotional: 1,
  maxSlippageBps: 1, maxOrdersPerMinute: 1, maxDailyOrders: 1, maxCancelsPerMinute: 1, duplicateIntentWindowSec: 1, instrumentAllowlist: 1, venueAllowlist: 1,
} satisfies Record<keyof RiskLimits, 1>)

const InstallKeyVerify = (k: InstallKey, a: Attestation): boolean => {
  // 安装密钥是本机唯一签名者；公钥随密钥对象保存。
  return (k.constructor as unknown as { verify(pub: string, data: string, sig: string): boolean }).verify(k.publicKey, a.digest, a.sig)
}

const summarize = (patch: PolicyPatch): Record<string, unknown> => ({
  limits: Object.fromEntries(Object.entries(patch.limits ?? {}).map(([k, v]) => [k, v === null ? 'removed' : v])),
  ...(patch.protectors ? { protectors: patch.protectors.length } : {}),
  ...(patch.failClosed ? { failClosed: patch.failClosed } : {}),
  ...(patch.dailyResetAt ? { dailyResetAt: patch.dailyResetAt } : {}),
})

// =====================================================================================
// 风控闸（预检）
// =====================================================================================

export interface PrecheckInput {
  intent: NormalizedIntent
  account: Account
  inst: Instrument
  snapshot: AccountSnapshot & { confirmedAt?: number; stale?: boolean; gateOpenOrders?: GateInput['snapshot']['openOrders']; asOf?: number; availableDeductsOpenOrders?: boolean; stopLossOrderIds?: string[] }
  mark?: MarkPrice & { source?: 'venue_mark' | 'last' | 'mid' }
  mandate?: Mandate | null
  /** direct = order.place 直接执行；proposal = 提案路径（实盘由人批准）。 */
  path: 'direct' | 'proposal' | 'approved'
  /** 行为人大类（来自已盖章的 origin.actorType）。 */
  actorType: Origin['actorType']
  stats: PrecheckStats
  rate?: { used: number; limit: number }
  now: number
  precheckId?: GateInput['precheckId']
  dryRun?: boolean
  mandateIntegrity?: { ok: boolean; problems: string[] }
  reserved?: GateInput['reserved']
  killSwitch?: GateInput['killSwitch']
  openOrderValuations?: Record<string, { contractSize: Decimal; mark?: Decimal }>
}

export class RiskGate {
  constructor(private risk: RiskService, private tstate: TradingStateService) {
    this.risk.bindReplayEvaluator?.((input) => this.decide(input))
  }

  decide(input: GateInput): GateDecision {
    const i = canonicalGateInput(input)
    const targetDigest = gateTargetDigest(i.target)
    const initialTarget = i.target
    const precisionAdjustments = sizePrecisionAdjustment(i.target, i.instrument)
    const adjustedInput = precisionAdjustments.length ? { ...i, target: adjustedGateTarget(i.target, precisionAdjustments) } as GateInput : i
    let initial = evaluateGateStages(adjustedInput)
    const precisionInstrument = i.instrument
    const adjustedSize = adjustedInput.target.kind === 'order' ? dec.D(adjustedInput.target.intent.size) : undefined
    let precisionHit: RuleHit | undefined
    if (precisionAdjustments.length && precisionInstrument && adjustedSize !== undefined && dec.gt(adjustedSize, dec.ZERO) && !dec.lt(adjustedSize, dec.D(precisionInstrument.size.min))) {
      precisionHit = {
        ruleId: precisionAdjustments[0]!.ruleId, code: 'SIZE_PRECISION', limit: dec.str(dec.D(String(precisionAdjustments[0]!.to))),
        actual: dec.str(dec.D(String(precisionAdjustments[0]!.from))), unit: precisionInstrument.base, action: 'limit', scope: 'instrument',
        message: `size rounded to instrument step: ${dec.str(dec.D(String(precisionAdjustments[0]!.from)))} -> ${dec.str(dec.D(String(precisionAdjustments[0]!.to)))}`,
      }
      const constHits = initial.byStage.CONST ?? []
      if (!constHits.some((hit) => hit.ruleId === precisionHit!.ruleId && hit.code === precisionHit!.code)) {
        initial = { ...initial, byStage: { ...initial.byStage, CONST: [...constHits, precisionHit] } }
      }
    }
    const mismatchedAssembly = i.assemblyAdjustments !== undefined && !isDeepStrictEqual(i.assemblyAdjustments, precisionAdjustments)
    if (mismatchedAssembly) {
      const mismatchHit: RuleHit = {
        ruleId: `${i.instrument?.instrumentId ?? 'gate'}#sizePrecision`, code: 'SIZE_PRECISION',
        limit: '0' as Decimal, actual: '1' as Decimal, unit: 'violations', action: 'deny', scope: 'instrument',
        message: 'assembly adjustment does not match deterministic recomputation',
      }
      initial = { ...initial, byStage: { ...initial.byStage, CONST: [...(initial.byStage.CONST ?? []), mismatchHit] } }
    }
    const flatten = (evaluation: ReturnType<typeof evaluateGateStages>): RuleHit[] => GATE_STAGES.flatMap((stage) => evaluation.byStage[stage] ?? [])
    const initialHits = flatten(initial)
    const intent = adjustedInput.target.kind === 'order' ? adjustedInput.target.intent : undefined
    const position = intent ? i.snapshot.positions.find((p) => p.instrumentId === intent.instrumentId) : undefined
    const opposite = !!position && !!intent && ((position.side === 'long' && intent.side === 'sell') || (position.side === 'short' && intent.side === 'buy'))
    const flip = opposite && !!intent && dec.gt(dec.D(intent.size), dec.D(position!.size))
    const canLimit = !mismatchedAssembly && effectiveGateAction(i) === 'open' && !flip && !!intent && i.policy?.limitMode?.size === true && intent.allowAdjust?.includes('size') === true
    const pluginLimitHits = initialHits.filter((hit) => hit.scope === 'plugin' && hit.action === 'limit')
    let finalHits = initialHits
    let finalEval = initial
    let applied: GateDecision['applied'] = [...precisionAdjustments]
    let adjustedTargetDigest = precisionAdjustments.length ? gateTargetDigest(adjustedInput.target) : targetDigest
    let estimates = initial.estimates
    if (canLimit && intent && initial.sizeCaps.length > 0) {
      const minimum = initial.sizeCaps.reduce((value, cap) => dec.min(value, dec.D(cap.size)), dec.D(intent.size))
      const sizeRule = i.instrument?.size
      const candidate = sizeRule?.step
        ? dec.mul(dec.div(minimum, dec.D(sizeRule.step), 0), dec.D(sizeRule.step))
        : dec.truncTo(minimum, sizeRule?.decimals ?? 0)
      const reference = intent.price !== undefined ? dec.D(intent.price) : i.mark ? dec.D(i.mark.price) : undefined
      const candidateNotional = reference && i.instrument ? dec.mul(dec.mul(candidate, reference), dec.D(i.instrument.contractSize)) : undefined
      const minNotional = i.venueRules?.minOrderNotional ?? i.instrument?.minNotional
      const invalidMinimum = dec.lte(candidate, dec.ZERO) || !!sizeRule?.min && dec.lt(candidate, dec.D(sizeRule.min))
        || minNotional !== undefined && candidateNotional !== undefined && dec.lt(candidateNotional, dec.D(minNotional))
      if (dec.lt(candidate, dec.D(intent.size)) && !invalidMinimum) {
        const capAdjustment = { ruleId: 'gate#size', code: 'ORDER_NOTIONAL' as const, field: 'size' as const, from: intent.size, to: dec.str(candidate), unit: i.instrument?.base ?? 'size' }
        const proposedTarget = adjustedGateTarget(initialTarget, [...precisionAdjustments, capAdjustment])
        const pluginLimits = new Map<string, Decimal>()
        for (const hit of pluginLimitHits) {
          const result = i.protectorResults.find((item) => hit.ruleId === `${item.pluginId}#${item.order}` && item.result.action === 'limit')
          if (result?.result.action === 'limit') pluginLimits.set(`${result.pluginId}\u0000${result.order}`, result.result.to)
        }
        finalEval = evaluateGateStages({ ...i, target: proposedTarget } as GateInput, pluginLimits, initial.estimates.notional)
        if (precisionHit) {
          const constHits = finalEval.byStage.CONST ?? []
          if (!constHits.some((hit) => hit.ruleId === precisionHit!.ruleId && hit.code === precisionHit!.code)) {
            finalEval = { ...finalEval, byStage: { ...finalEval.byStage, CONST: [...constHits, precisionHit] } }
          }
        }
        const secondHits = flatten(finalEval)
        const secondDeny = secondHits.some((hit) => hit.action === 'deny')
        const secondReview = secondHits.some((hit) => hit.action === 'review')
        if (secondDeny) {
          finalHits = secondHits
        } else {
          const corrected = initial.sizeCaps.filter((cap) => dec.lte(candidate, dec.D(cap.size)) && dec.lt(dec.D(cap.size), dec.D(intent.size)))
          const riskAdjustments = corrected.map(({ hit }) => ({ ruleId: hit.ruleId, code: hit.code, field: 'size' as const, from: intent.size, to: dec.str(candidate), unit: i.instrument?.base ?? 'size' }))
          applied = [...precisionAdjustments, ...riskAdjustments]
          if (riskAdjustments.length > 0) {
            const correctedHits = corrected.map(({ hit }) => ({ ...hit, action: 'limit' as const }))
            const byStage = { ...finalEval.byStage }
            for (const stage of GATE_STAGES) {
              const secondStage = finalEval.byStage[stage] ?? []
              const initialStage = initial.byStage[stage] ?? []
              const correctedForStage = correctedHits.filter((hit) => initialStage.some((original) => original.ruleId === hit.ruleId && original.code === hit.code))
              if (correctedForStage.length === 0) continue
              const merged: RuleHit[] = []
              const inserted = new Set<string>()
              for (const original of initialStage) {
                const key = `${original.ruleId}\u0000${original.code}`
                const correctedHit = correctedHits.find((hit) => hit.ruleId === original.ruleId && hit.code === original.code)
                if (correctedHit) { merged.push(correctedHit); inserted.add(key); continue }
                const current = secondStage.find((hit) => hit.ruleId === original.ruleId && hit.code === original.code)
                if (current) merged.push(current)
              }
              for (const current of secondStage) if (!merged.includes(current)) merged.push(current)
              byStage[stage] = merged
            }
            finalEval = { ...finalEval, byStage }
            finalHits = flatten(finalEval)
          } else finalHits = secondHits
          if (!secondReview && applied.length === 0) finalEval = initial
          else { adjustedTargetDigest = gateTargetDigest(proposedTarget); estimates = finalEval.estimates }
        }
      } else if (invalidMinimum) {
        const floorHit: RuleHit = { ruleId: `${i.account.venue}#minOrderNotional`, code: 'ORDER_NOTIONAL', limit: minNotional ?? sizeRule?.min ?? '0' as Decimal, actual: candidateNotional === undefined ? dec.str(candidate) : dec.str(candidateNotional), unit: candidateNotional === undefined ? 'size' : (i.instrument?.quote ?? 'account'), action: 'deny', scope: 'venue' }
        const byStage = { ...initial.byStage, CONST: [...(initial.byStage.CONST ?? []), floorHit] }
        finalEval = { ...initial, byStage }
        finalHits = flatten(finalEval)
      }
    }
    if (pluginLimitHits.length > 0 && finalEval === initial && (!canLimit || applied.length === 0)) finalHits = finalHits.map((hit) => pluginLimitHits.some((limitHit) => limitHit.ruleId === hit.ruleId && limitHit.code === hit.code) ? { ...hit, action: 'deny' as const } : hit)
    const denied = finalHits.some((hit) => hit.action === 'deny')
    const reviewed = finalHits.some((hit) => hit.action === 'review')
    const decision: GateDecision['decision'] = denied || reviewed ? 'BLOCK' : applied.length > 0 ? 'LIMIT' : 'ALLOW'
    const verdict: GateDecision['verdict'] = denied ? 'deny' : reviewed ? 'review' : 'allow'
    if (denied) { applied = []; adjustedTargetDigest = targetDigest; estimates = initial.estimates }
    const stalePriceWarning = verdict === 'allow' && effectiveGateAction(i) === 'reduce' && i.mark
      ? finalHits.find((hit) => hit.code === 'STALE_PRICE' && hit.action === 'warn')
      : undefined
    if (stalePriceWarning && i.mark) applied.push({ ruleId: stalePriceWarning.ruleId, code: 'STALE_PRICE', field: 'markPrice', from: i.mark.price, to: i.mark.price, unit: i.instrument?.quote ?? 'mark', kind: 'warning' })
    if (verdict === 'allow' && (effectiveGateAction(i) === 'cancel' || effectiveGateAction(i) === 'cancel_protective') && (i.actorClass === 'human' || i.actorClass === 'system')) {
      for (const check of i.cancelPriceChecks ?? []) {
        const warning = finalHits.find((hit) => hit.code === 'STALE_PRICE' && hit.action === 'warn' && hit.ruleId.endsWith(`#cancelPrice:${check.instrumentId}`))
        if (warning && check.mark) applied.push({ ruleId: warning.ruleId, code: 'STALE_PRICE', field: 'markPrice', from: check.mark.price, to: check.mark.price, unit: check.quote ?? 'quote', kind: 'warning' })
      }
    }
    const escalation = verdict === 'review' ? { to: 'human_approval' as const, reason: (finalHits.find((hit) => hit.action === 'review')?.code ?? 'NEEDS_APPROVAL') as RuleHit['code'] } : undefined
    const mandate = i.mandate
    const mandateInvalid = !i.mandateIntegrity.ok || !mandate || mandate.status !== 'active' && mandate.status !== 'downgraded' || i.now < mandate.notBefore || i.now >= mandate.notAfter || !mandate.accounts.includes(i.account.accountId as never)
    const unsigned = cleanGateValue({
      precheckId: i.precheckId, verdict, policyVersion: i.policy?.version ?? 0, ruleHits: finalHits, estimates,
      ...(i.mark ? { priceRef: { markPrice: i.mark.price, ts: i.mark.ts } } : {}), expiresAt: i.now + 30_000,
      gate: { schema: GATE_SCHEMA, rulesetVersion: CURRENT_GATE_RULESET_VERSION }, decision, action: i.action, targetDigest, adjustedTargetDigest, applied,
      allowedActions: finalEval.allowedActions, irreversibility: ['reduce', 'cancel', 'deadman_arm'].includes(effectiveGateAction(i)) ? 'low' : 'high',
      ...(escalation ? { escalation } : {}), stages: GATE_STAGES.filter((stage) => Object.prototype.hasOwnProperty.call(finalEval.byStage, stage)),
      monitorHits: finalEval.monitorHits, snapshotDigest: gateSnapshotDigest(i), policyRef: policyRefOf(i.policy),
      ...(mandate ? { mandateRef: { mandateId: mandate.mandateId, version: mandate.version, digest: mandate.attestation.digest, effectiveLevel: mandateInvalid ? 'L0' : mandate.level, effectiveStatus: !i.mandateIntegrity.ok ? 'revoked' : i.now >= mandate.notAfter ? 'expired' : mandate.status } } : {}),
      dryRun: i.dryRun,
    }) as Omit<GateDecision, 'attestation'>
    const digest = digestOf(unsigned)
    const result = { ...unsigned, attestation: { method: 'system', by: 'kernel', at: i.now, digest, sig: this.risk.signGateDigest(digest) } } as GateDecision
    const problems = checkGateDecisionConsistency(result)
    if (problems.length) throw new KernelError(makeProblem('INTERNAL_ERROR', `inconsistent gate decision: ${problems.join('; ')}`))
    return result
  }

  precheck(i: PrecheckInput): GateDecision {
    const policy = this.risk.current() ?? null
    const scopes: TradingScope[] = [ORG_SCOPE, { type: 'account', id: i.account.accountId }, { type: 'instrument', id: i.intent.instrumentId }, ...i.account.groupIds.map((id) => ({ type: 'group' as const, id }))]
    if (i.mandate) scopes.push({ type: 'mandate', id: i.mandate.mandateId })
    const effective = this.tstate.effective(scopes)
    const states = effective.reasons.map((reason) => ({ scope: reason.scope, state: reason.state, reason: reason.reason, ...(reason.until === undefined ? {} : { until: reason.until }), ...(reason.protector === undefined ? {} : { protector: reason.protector }) }))
    const assembled = assembleGateInput({
      intent: i.intent, account: i.account, inst: i.inst, snapshot: i.snapshot, ...(i.mark ? { mark: i.mark } : {}), ...(i.openOrderValuations ? { openOrderValuations: i.openOrderValuations } : {}), mandate: i.mandate ?? null,
      policy, policyIntegrity: this.risk.integrity, mandateIntegrity: i.mandateIntegrity ?? { ok: true, problems: [] }, states,
      stats: i.stats, ...(i.rate ? { rate: i.rate } : {}), ...(i.reserved ? { reserved: i.reserved } : {}), path: i.path,
      actorType: i.actorType, now: i.now, precheckId: i.precheckId ?? newId('pck'), dryRun: i.dryRun ?? true,
      ...(i.killSwitch ? { killSwitch: i.killSwitch } : {}),
    })
    return this.decide(assembled)
  }
}
export { RISK_PRESETS }
