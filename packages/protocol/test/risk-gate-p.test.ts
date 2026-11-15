// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asDecimal, formatDecimal, PROBLEM_CODES } from '../src/model'
import type { GateDecision, GateStage, RuleCode, RuleHitAction } from '../src/model'
import { checkPluginManifestIssues, PLUGIN_ISSUE_CODES, type PluginIssueCode, type PluginManifest } from '../src/plugin/manifest'
import { validateBySchemaId, validateConnectorAccountSnapshot, validateOrderIntent, validatePluginManifest, validatePrecheckResult, validateRiskPolicy, validateRuleHit } from '../src/validate'
import { checkGateDecisionConsistency } from '../src/risk-gate/consistency'
import { loadGateConformanceCases, type GateConformanceCase } from '../conformance/risk-gate/load'
import { contract, sample } from './helpers'

const stages: GateStage[] = ['SYS', 'KILL', 'STATE', 'MANDATE', 'LLM', 'ALLOWLIST', 'CONST', 'EXPOSURE', 'BUYING_POWER', 'LOSS', 'RATE', 'PROTECTOR', 'APPROVAL']

function hit(action: RuleHitAction) {
  return { ruleId: 'pol_test#rule', code: 'NEEDS_APPROVAL' as const, limit: asDecimal('1'), actual: asDecimal('2'), unit: 'count', action, scope: 'account' }
}

function validDecision(decision: GateDecision['decision']): GateDecision {
  const verdict = decision === 'BLOCK' ? 'deny' : 'allow'
  const applied = decision === 'LIMIT'
    ? [{ ruleId: 'pol_test#size', code: 'ORDER_NOTIONAL' as const, field: 'size' as const, from: asDecimal('2'), to: asDecimal('1'), unit: 'unit' }]
    : []
  return {
    precheckId: 'pck_test' as GateDecision['precheckId'],
    verdict,
    policyVersion: 1,
    ruleHits: decision === 'ALLOW' ? [] : [hit(decision === 'LIMIT' ? 'limit' : 'deny')],
    estimates: {},
    gate: { schema: 'gitrader-risk-gate/1', rulesetVersion: '1' },
    decision,
    action: 'open',
    targetDigest: 'sha256:target',
    adjustedTargetDigest: decision === 'LIMIT' ? 'sha256:adjusted' : 'sha256:target',
    applied,
    allowedActions: { open: true, reduce: true, cancel: true, cancel_protective: false, amend: true, leverage: true, deadman_arm: true, deadman_disarm: false },
    irreversibility: 'high',
    stages: [...stages],
    monitorHits: [],
    snapshotDigest: 'sha256:snapshot',
    policyRef: { policyId: 'pol_test' as never, version: 1, digest: 'sha256:policy' },
    mandateRef: { mandateId: 'mdt_test' as never, version: 1, digest: 'sha256:mandate', effectiveLevel: 'L1', effectiveStatus: 'active' },
    dryRun: false,
    attestation: { method: 'system', by: 'kernel', at: 1, digest: 'sha256:decision', sig: 'sig' },
  }
}

describe('checkGateDecisionConsistency', () => {
  it('accepts ALLOW when verdict is allow and applied is empty', () => {
    expect(checkGateDecisionConsistency(validDecision('ALLOW'))).toEqual([])
  })

  it('accepts LIMIT when verdict is allow and applied is nonempty', () => {
    expect(checkGateDecisionConsistency(validDecision('LIMIT'))).toEqual([])
  })

  it('accepts BLOCK with deny and preserves applied adjustments', () => {
    const d = validDecision('BLOCK')
    d.applied = [{ ruleId: 'pol_test#size', code: 'ORDER_NOTIONAL', field: 'size', from: asDecimal('2'), to: asDecimal('1'), unit: 'unit' }]
    expect(checkGateDecisionConsistency(d)).toEqual([])
  })

  it('accepts BLOCK with review and a human approval escalation', () => {
    const d = validDecision('BLOCK')
    d.verdict = 'review'
    d.ruleHits = [hit('review')]
    d.escalation = { to: 'human_approval', reason: 'NEEDS_APPROVAL' }
    expect(checkGateDecisionConsistency(d)).toEqual([])
  })

  it.each([
    ['ALLOW with deny', 'ALLOW', 'deny'],
    ['ALLOW with review', 'ALLOW', 'review'],
    ['LIMIT with deny', 'LIMIT', 'deny'],
    ['LIMIT with review', 'LIMIT', 'review'],
    ['BLOCK with allow', 'BLOCK', 'allow'],
  ] as const)('reports a verdict mismatch for %s', (_name, decision, verdict) => {
    const d = validDecision(decision)
    d.verdict = verdict
    if (verdict === 'review') d.escalation = { to: 'human_approval', reason: 'NEEDS_APPROVAL' }
    expect(checkGateDecisionConsistency(d)).toEqual([
      `decision ${decision} is inconsistent with verdict ${verdict}`,
      ...(decision === 'BLOCK' && verdict === 'allow' ? ['allow verdict cannot include deny rule hits'] : []),
    ])
  })

  it('reports ALLOW with nonempty applied', () => {
    const d = validDecision('ALLOW')
    d.applied = [{ ruleId: 'pol_test#size', code: 'ORDER_NOTIONAL', field: 'size', from: asDecimal('2'), to: asDecimal('1'), unit: 'unit' }]
    expect(checkGateDecisionConsistency(d)).toEqual(['ALLOW requires an empty applied list'])
  })

  it('rejects deny rule hits when verdict is allow', () => {
    const d = validDecision('ALLOW')
    d.ruleHits = [hit('limit'), hit('deny')]
    expect(checkGateDecisionConsistency(d)).toEqual(['allow verdict cannot include deny rule hits'])
  })

  it('requires a limit rule hit for LIMIT', () => {
    const d = validDecision('LIMIT')
    d.ruleHits = [hit('warn')]
    expect(checkGateDecisionConsistency(d)).toEqual(['LIMIT requires at least one limit rule hit'])
  })

  it('requires ALLOW target digests to match', () => {
    const d = validDecision('ALLOW')
    d.adjustedTargetDigest = 'sha256:adjusted'
    expect(checkGateDecisionConsistency(d)).toEqual(['ALLOW requires targetDigest and adjustedTargetDigest to match'])
  })

  it('reports LIMIT with empty applied', () => {
    const d = validDecision('LIMIT')
    d.applied = []
    expect(checkGateDecisionConsistency(d)).toEqual(['LIMIT requires a nonempty applied list'])
  })

  it('reports review without escalation', () => {
    const d = validDecision('BLOCK')
    d.verdict = 'review'
    d.ruleHits = [hit('review')]
    expect(checkGateDecisionConsistency(d)).toEqual(['review verdict requires human_approval escalation'])
  })

  it('reports an invalid review escalation target', () => {
    const d = validDecision('BLOCK')
    d.verdict = 'review'
    d.ruleHits = [hit('review')]
    d.escalation = { to: 'other' as never, reason: 'NEEDS_APPROVAL' }
    expect(checkGateDecisionConsistency(d)).toEqual(['review escalation target must be human_approval'])
  })

  it('reports an invalid review escalation reason', () => {
    const d = validDecision('BLOCK')
    d.verdict = 'review'
    d.ruleHits = [hit('review')]
    d.escalation = { to: 'human_approval', reason: 'UNKNOWN' as never }
    expect(checkGateDecisionConsistency(d)).toEqual(['review escalation reason must be a RuleCode'])
  })

  it.each([
    ['allow', 'ALLOW'], ['allow', 'LIMIT'], ['deny', 'BLOCK'],
  ] as const)('reports escalation on non-review verdict %s / %s', (verdict, decision) => {
    const d = validDecision(decision)
    d.verdict = verdict
    d.escalation = { to: 'human_approval', reason: 'NEEDS_APPROVAL' }
    expect(checkGateDecisionConsistency(d)).toContain('non-review verdict cannot have escalation')
  })

  it('accepts monitor hits whose actions are warn', () => {
    const d = validDecision('ALLOW')
    d.monitorHits = [hit('warn')]
    expect(checkGateDecisionConsistency(d)).toEqual([])
  })

  it.each(['deny', 'review', 'limit'] as const)('rejects monitor hit action %s', (action) => {
    const d = validDecision('ALLOW')
    d.monitorHits = [hit(action)]
    expect(checkGateDecisionConsistency(d)).toEqual([`monitorHits[0].action must be warn; got ${action}`])
  })

  it('allows warn rule hits without changing a valid BLOCK mapping', () => {
    const d = validDecision('BLOCK')
    d.ruleHits = [hit('deny'), hit('warn')]
    expect(checkGateDecisionConsistency(d)).toEqual([])
  })

  it('does not mutate the input decision', () => {
    const d = validDecision('LIMIT')
    const before = structuredClone(d)
    checkGateDecisionConsistency(d)
    expect(d).toEqual(before)
  })
})

describe('P-03 risk protocol schema additions', () => {
  const seed = contract('plugin-nautilus') as PluginManifest
  const protectorManifest = (protector: PluginManifest['protector']): PluginManifest => ({
    ...seed,
    id: 'protector.acme.guard',
    vendor: { ...seed.vendor, id: 'acme' },
    permissions: [],
    kind: 'protector',
    package: 'block',
    protector,
  })
  const issue = (m: PluginManifest, code: PluginIssueCode) => checkPluginManifestIssues(m).filter((item) => item.code === code)
  const templates = [
    { kind: 'cooldown', afterOpenSec: 5 },
    { kind: 'stoploss_guard', windowMin: 60, maxStoplosses: 3, pauseMin: 10, scope: 'instrument' },
    { kind: 'drawdown_pause', windowHours: 24, maxDrawdownRatio: '0.2', pauseMin: 60 },
    { kind: 'low_profit_lock', windowHours: 24, minProfitRatio: '0.05', lockMin: 60 },
    { kind: 'max_consecutive_failures', count: 3, pauseMin: 30 },
  ]

  it.each(templates)('accepts a valid built-in protector template: $kind', (rule) => {
    expect(validatePluginManifest(protectorManifest({ rules: [rule] } as never)).ok).toBe(true)
  })

  it.each([
    ['plugin', { kind: 'plugin', pluginId: 'protector.example', params: {} }],
    ['unknown', { kind: 'unknown_kind' }],
  ] as const)('reports PROTECTOR_RULES_INVALID for %s at its kind path', (_name, rule) => {
    const m = protectorManifest({ rules: [rule as never] })
    const result = validatePluginManifest(m)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.issues).toContainEqual(expect.objectContaining({ code: 'PROTECTOR_RULES_INVALID', path: '/protector/rules/0/kind' }))
  })

  it.each([
    ['builtin', 'builtin'],
    ['plugin source object', { pluginId: 'protector.fixture', version: '1.0.0' }],
    ['undefined source', undefined],
  ] as const)('rejects an own source property (%s) on a protector rule', (_name, source) => {
    const m = protectorManifest({ rules: [{ ...templates[0], source }] as never })
    const sourceIssue = issue(m, 'PROTECTOR_RULES_INVALID').find((item) => item.path === '/protector/rules/0/source')
    expect(sourceIssue).toEqual(expect.objectContaining({
      code: 'PROTECTOR_RULES_INVALID',
      path: '/protector/rules/0/source',
      message: 'protector rules must not declare source; the kernel assigns it when merging',
    }))
  })

  it('rejects protector fields on non-protector plugins at /protector', () => {
    const m = { ...seed, protector: { rules: [] } } as PluginManifest
    const result = validatePluginManifest(m)
    expect(result.ok).toBe(false)
    expect(issue(m, 'PROTECTOR_RULES_INVALID')).toContainEqual(expect.objectContaining({ path: '/protector' }))
  })

  it('checks protector pre and budgetMs types without imposing a numeric range', () => {
    expect(validatePluginManifest(protectorManifest({ pre: 'yes' as never })).ok).toBe(false)
    expect(validatePluginManifest(protectorManifest({ budgetMs: '20' as never })).ok).toBe(false)
    expect(validatePluginManifest(protectorManifest({ pre: true, budgetMs: -1, rules: [] })).ok).toBe(true)
  })

  it('accepts empty rules and a legacy manifest without protector', () => {
    expect(validatePluginManifest(protectorManifest({ rules: [] })).ok).toBe(true)
    expect(validatePluginManifest(seed).ok).toBe(true)
  })

  it('keeps legacy RiskPolicy, OrderIntent and connector AccountSnapshot valid', () => {
    expect(validateRiskPolicy(sample('RiskPolicy')).ok).toBe(true)
    expect(validateOrderIntent(sample('OrderIntent')).ok).toBe(true)
    expect(validateConnectorAccountSnapshot(sample('ConnectorAccountSnapshot')).ok).toBe(true)
  })

  it('validates new order, RuleHit, policy and account fields and rejects invalid enums', () => {
    const order = sample('OrderIntent')
    expect(validateOrderIntent({ ...order, allowAdjust: ['size', 'leverage', 'maxSlippageBps'] }).ok).toBe(true)
    expect(validateOrderIntent({ ...order, allowAdjust: ['unknown'] }).ok).toBe(false)
    const ruleHit = { ruleId: 'policy#limit', code: 'ORDER_NOTIONAL', limit: '10', actual: '20', unit: 'unit', action: 'limit', scope: 'account' }
    expect(validateRuleHit(ruleHit).ok).toBe(true)
    expect(validateRuleHit({ ...ruleHit, action: 'other' }).ok).toBe(false)
    const policy = sample('RiskPolicy')
    expect(validateRiskPolicy({ ...policy, limitMode: { size: true }, killSwitch: { file: true, onTrip: { cancelAll: true, keepStopLoss: true, closeAll: false } }, failClosed: { ...policy.failClosed, staleAccountMs: 1000 }, protectors: [{ kind: 'cooldown', afterOpenSec: 5, mode: 'monitor', source: { pluginId: 'protector.acme.guard', version: '1.0.0' } }] }).ok).toBe(true)
    expect(validateRiskPolicy({ ...policy, protectors: [{ kind: 'cooldown', afterOpenSec: 5, mode: 'unknown' }] }).ok).toBe(false)
    const account = sample('ConnectorAccountSnapshot')
    expect(validateConnectorAccountSnapshot({ ...account, availableDeductsOpenOrders: false, openOrders: [{ instrumentId: 'hyperliquid:BTC', side: 'buy', notional: '10', count: 1 }], stopLossOrderIds: ['ord_test'], rules: { maxOpenOrders: { cap: 10, current: 1 }, marketPriceBandBps: 800, minOrderNotional: '5' } }).ok).toBe(true)
    expect(validateConnectorAccountSnapshot({ ...account, openOrders: [{ instrumentId: 'hyperliquid:BTC', side: 'up', notional: '10', count: 1 }] }).ok).toBe(false)
  })

  it('uses the protocol verdicts and exposes decimal and ticket-code behavior', () => {
    expect(validatePrecheckResult(contract('precheck-allow')).ok).toBe(true)
    expect(formatDecimal('001.2300')).toBe(asDecimal('1.23'))
    expect(PROBLEM_CODES.GATE_TICKET_INVALID).toEqual({ code: 2010, name: 'GATE_TICKET_INVALID', category: 'RISK', retryable: false })
    expect(PROBLEM_CODES.GATE_TICKET_EXPIRED).toEqual({ code: 2011, name: 'GATE_TICKET_EXPIRED', category: 'RISK', retryable: true })
    expect(PLUGIN_ISSUE_CODES).toContain('PROTECTOR_RULES_INVALID')
  })
})

const gateCases = loadGateConformanceCases()
const gateSchemaDef = (name: string) => `urn:gitrader:schema:risk-gate:1#/$defs/${name}`
const gateCaseSchema = gateSchemaDef('ConformanceCase')
const testDigest = `sha256:${'a'.repeat(64)}` as GateDecision['snapshotDigest']

function mutableCopy<T>(value: T): T {
  return structuredClone(value)
}

function decisionForCase(fixture: GateConformanceCase): GateDecision {
  const { input, expect: expected } = fixture
  const policy = input.policy
  const action: RuleHitAction = expected.decision === 'BLOCK'
    ? 'deny'
    : expected.decision === 'LIMIT' ? 'limit' : 'warn'
  const ruleHits = expected.codes.map((code: RuleCode) => ({
    ruleId: `fixture#${code}`, code, limit: asDecimal('0'), actual: asDecimal('0'), unit: 'unit', action, scope: 'account',
  }))
  const lowIrreversibility = ['reduce', 'cancel', 'deadman_arm'].includes(input.action)
  return {
    precheckId: input.precheckId,
    verdict: expected.verdict,
    policyVersion: policy?.version ?? 0,
    ruleHits,
    estimates: {},
    gate: { schema: 'gitrader-risk-gate/1', rulesetVersion: 'fixture' },
    decision: expected.decision,
    action: input.action,
    targetDigest: testDigest,
    adjustedTargetDigest: expected.decision === 'LIMIT' ? `sha256:${'b'.repeat(64)}` : testDigest,
    applied: expected.applied,
    allowedActions: expected.allowedActions,
    irreversibility: lowIrreversibility ? 'low' : 'high',
    stages: [],
    monitorHits: [],
    snapshotDigest: testDigest,
    policyRef: policy ? { policyId: policy.policyId as never, version: policy.version, digest: testDigest } : null,
    dryRun: input.dryRun,
    attestation: { method: 'system', by: 'kernel', at: input.now, digest: testDigest, sig: 'Zml4dHVyZQ==' },
    ...(expected.verdict === 'review' ? { escalation: { to: 'human_approval' as const, reason: expected.codes[0]! } } : {}),
  }
}

function schemaAccepts(name: string, value: unknown): boolean {
  return validateBySchemaId(gateSchemaDef(name), value).ok
}

describe('P2 risk-gate conformance fixtures', () => {
  it('covers all actions with unique names and the fixed scenario group counts', () => {
    expect(gateCases).toHaveLength(21)
    expect(new Set(gateCases.map((fixture) => fixture.name)).size).toBe(gateCases.length)
    expect(new Set(gateCases.map((fixture) => fixture.input.action))).toEqual(new Set([
      'open', 'reduce', 'cancel', 'cancel_protective', 'amend', 'leverage', 'deadman_arm', 'deadman_disarm',
    ]))
    expect(gateCases.reduce<Record<string, number>>((counts, fixture) => {
      counts[fixture.expect.decision] = (counts[fixture.expect.decision] ?? 0) + 1
      return counts
    }, {})).toEqual({ ALLOW: 12, BLOCK: 8, LIMIT: 1 })
    expect(gateCases.filter((fixture) => fixture.name.startsWith('09-') || fixture.name.startsWith('12-'))).toHaveLength(2)
    expect(gateCases.filter((fixture) => fixture.name.startsWith('15-') || fixture.name.startsWith('16-'))).toHaveLength(2)
  })

  it('locks the round-three identity, freshness, capability, and buying-power fixtures', () => {
    const get = (name: string) => gateCases.find((fixture) => fixture.name === name)!
    const originalActorType = { agent: 'engine', human: 'human', system: 'system' } as const
    for (const fixture of gateCases.filter((item) => Number(item.name.slice(0, 2)) <= 17)) {
      expect(fixture.input.originActorType).toBe(originalActorType[fixture.input.actorClass])
    }
    const llmLive = get('18-open-live-llm')
    const engineLive = get('19-open-live-engine')
    expect(llmLive.input.actorClass).toBe('agent')
    expect(engineLive.input.actorClass).toBe('agent')
    expect(llmLive.input.originActorType).toBe('llm-agent')
    expect(engineLive.input.originActorType).toBe('engine')
    expect(llmLive.input.account.mode).toBe('live')
    expect(engineLive.input.account.mode).toBe('live')
    expect(llmLive.input.policy?.denyLlmLiveEntries).toBe(true)
    expect(engineLive.input.policy?.denyLlmLiveEntries).toBe(true)
    expect(llmLive.expect).toMatchObject({ decision: 'BLOCK', verdict: 'deny', codes: ['LLM_LIVE_ENTRY'], allowedActions: get('01-open-agent').expect.allowedActions })
    expect(engineLive.expect).toMatchObject({ decision: 'ALLOW', verdict: 'allow', codes: [], allowedActions: get('01-open-agent').expect.allowedActions })

    const legacyFresh = get('20-open-legacy-fresh')
    const confirmedStale = get('21-open-confirmed-stale')
    expect('confirmedAt' in legacyFresh.input.snapshot).toBe(false)
    expect(legacyFresh.input.snapshot.asOf).toBe(900000)
    expect(legacyFresh.input.snapshot.stale).toBe(false)
    expect(legacyFresh.expect).toMatchObject({ decision: 'ALLOW', codes: [] })
    expect(confirmedStale.input.snapshot.confirmedAt).toBe(900000)
    expect(confirmedStale.input.snapshot.stale).toBe(false)
    expect(confirmedStale.input.policy?.failClosed.staleAccountMs).toBe(30000)
    expect(confirmedStale.expect).toMatchObject({ decision: 'BLOCK', codes: ['ACCOUNT_UNKNOWN'] })

    for (const name of ['09-open-stale', '16-protector-unavailable']) {
      expect(get(name).expect.allowedActions).toEqual(get('01-open-agent').expect.allowedActions)
    }
    for (const name of ['10-open-kill', '11-open-reducing', '12-reduce-three-states', '15-protector-skipped']) {
      expect(get(name).expect.allowedActions.amend).toBe(name === '11-open-reducing')
      expect(get(name).expect.allowedActions.reduce).toBe(name === '11-open-reducing')
      expect(get(name).expect.allowedActions.leverage).toBe(false)
    }

    const haltedHuman = get('04-cancel-protective-human')
    expect(haltedHuman.input.states).toEqual([{ scope: { type: 'account', id: haltedHuman.input.account.accountId }, state: 'HALTED', reason: 'fixture halted state' }])
    expect(haltedHuman.expect).toMatchObject({ decision: 'ALLOW', verdict: 'allow', codes: ['TRADING_STATE'], allowedActions: {
      open: false, reduce: true, cancel: true, cancel_protective: true, amend: true, leverage: false, deadman_arm: true, deadman_disarm: true,
    } })

    const buyingPower = get('14-buying-power-not-deducted')
    expect(buyingPower.input.snapshot.availableDeductsOpenOrders).toBe(false)
    expect(buyingPower.input.reserved.account.margin).toBe('40')
    expect(buyingPower.expect).toMatchObject({ decision: 'ALLOW', verdict: 'allow', codes: [] })
  })

  it.each(gateCases)('$name is structurally valid and its projected decision is consistent', (fixture) => {
    expect(validateBySchemaId(gateCaseSchema, fixture).ok).toBe(true)
    expect(schemaAccepts('GateInput', fixture.input)).toBe(true)
    const decision = decisionForCase(fixture)
    expect(schemaAccepts('GateDecision', decision)).toBe(true)
    expect(checkGateDecisionConsistency(decision)).toEqual([])
  })

  it('requires instruments only for order and leverage targets and rejects malformed shared input', () => {
    const withoutOrderInstrument = mutableCopy(gateCases[0]!.input) as unknown as Record<string, unknown>
    delete withoutOrderInstrument.instrument
    expect(schemaAccepts('GateInput', withoutOrderInstrument)).toBe(false)
    const withoutLeverageInstrument = mutableCopy(gateCases[5]!.input) as unknown as Record<string, unknown>
    delete withoutLeverageInstrument.instrument
    expect(schemaAccepts('GateInput', withoutLeverageInstrument)).toBe(false)

    for (const index of [2, 6]) {
      const withoutInstrument = mutableCopy(gateCases[index]!.input) as unknown as Record<string, unknown>
      delete withoutInstrument.instrument
      expect(schemaAccepts('GateInput', withoutInstrument)).toBe(true)
    }
    const cancelAll = mutableCopy(gateCases[2]!.input) as unknown as Record<string, any>
    cancelAll.target = { kind: 'cancel_all', keepProtective: true }
    delete cancelAll.instrument
    expect(schemaAccepts('GateInput', cancelAll)).toBe(true)

    const missingReserved = mutableCopy(gateCases[0]!.input) as unknown as Record<string, any>
    delete missingReserved.reserved
    expect(schemaAccepts('GateInput', missingReserved)).toBe(false)
    const invalidReserved = mutableCopy(gateCases[0]!.input) as unknown as Record<string, any>
    invalidReserved.reserved.account.margin = 0
    expect(schemaAccepts('GateInput', invalidReserved)).toBe(false)
    const missingAction = mutableCopy(gateCases[0]!.input) as unknown as Record<string, any>
    delete missingAction.action
    expect(schemaAccepts('GateInput', missingAction)).toBe(false)
    const unknownAction = mutableCopy(gateCases[0]!.input) as unknown as Record<string, any>
    unknownAction.action = 'unknown'
    expect(schemaAccepts('GateInput', unknownAction)).toBe(false)
    const fractionalTime = mutableCopy(gateCases[0]!.input) as unknown as Record<string, any>
    fractionalTime.now = 1000000.5
    expect(schemaAccepts('GateInput', fractionalTime)).toBe(false)
  })

  it('requires a valid origin actor type in GateInput and GateSnapshot', () => {
    const input = mutableCopy(gateCases[0]!.input) as unknown as Record<string, any>
    input.originActorType = 'engine'
    expect(schemaAccepts('GateInput', input)).toBe(true)
    for (const actorType of ['human', 'engine', 'llm-agent', 'system']) {
      expect(schemaAccepts('GateInput', { ...input, originActorType: actorType })).toBe(true)
    }
    expect(schemaAccepts('GateInput', { ...input, originActorType: 'unknown' })).toBe(false)
    const missingInputOrigin = { ...input }
    delete missingInputOrigin.originActorType
    expect(schemaAccepts('GateInput', missingInputOrigin)).toBe(false)

    const snapshot: Record<string, any> = { ...input, policy: null }
    delete snapshot.target
    expect(schemaAccepts('GateSnapshot', snapshot)).toBe(true)
    const missingSnapshotOrigin: Record<string, any> = { ...snapshot }
    delete missingSnapshotOrigin.originActorType
    expect(schemaAccepts('GateSnapshot', missingSnapshotOrigin)).toBe(false)
  })

  it('binds gate actions to their required target kinds', () => {
    const base = mutableCopy(gateCases[0]!.input) as unknown as Record<string, any>
    base.originActorType = 'engine'
    const targetOf = (kind: string) => gateCases.find((fixture) => fixture.input.target.kind === kind)!.input.target
    const combinations: Array<[string, string, unknown]> = [
      ...(['open', 'reduce', 'amend'] as const).map((action) => [action, 'order', targetOf('order')] as [string, string, unknown]),
      ['cancel', 'cancel', targetOf('cancel')], ['cancel', 'cancel_all', { kind: 'cancel_all', keepProtective: true }],
      ['cancel_protective', 'cancel', targetOf('cancel')], ['cancel_protective', 'cancel_all', { kind: 'cancel_all', keepProtective: false }],
      ['leverage', 'leverage', targetOf('leverage')],
      ['deadman_arm', 'deadman', targetOf('deadman')], ['deadman_disarm', 'deadman', targetOf('deadman')],
    ]
    for (const [action, _kind, target] of combinations) {
      const input: Record<string, any> = { ...base, action, target }
      if (_kind !== 'order' && _kind !== 'leverage') delete input.instrument
      expect(schemaAccepts('GateInput', input)).toBe(true)
    }
    for (const [action, target] of [
      ['open', targetOf('cancel')], ['cancel', targetOf('order')],
      ['leverage', targetOf('deadman')], ['deadman_arm', targetOf('leverage')],
    ] as const) {
      expect(schemaAccepts('GateInput', { ...base, action, target })).toBe(false)
    }
  })

  it('keeps legacy account views valid and checks confirmedAt and static venue rules', () => {
    const legacyAccount = sample('ConnectorAccountSnapshot')
    expect(validateConnectorAccountSnapshot(legacyAccount).ok).toBe(true)
    expect(validateConnectorAccountSnapshot({ ...legacyAccount, confirmedAt: 1000000 }).ok).toBe(true)
    expect(validateConnectorAccountSnapshot({ ...legacyAccount, confirmedAt: 1000000.5 }).ok).toBe(false)

    const snapshot = mutableCopy(gateCases[0]!.input.snapshot) as unknown as Record<string, unknown>
    delete snapshot.confirmedAt
    expect(schemaAccepts('GateAccountView', snapshot)).toBe(true)
    expect(schemaAccepts('GateAccountView', { ...snapshot, confirmedAt: 900000.5 })).toBe(false)

    const capabilities = {
      venue: 'fixture', environments: ['testnet'], instrumentKinds: ['perp'], orderTypes: { limit: 'native' },
      tif: ['gtc'], triggerPriceTypes: ['mark'], rules: { maxOpenOrders: { cap: 10 } },
    }
    expect(validateBySchemaId('urn:gitrader:schema:model:0.1:VenueCapabilities', capabilities).ok).toBe(true)
    expect(validateBySchemaId('urn:gitrader:schema:model:0.1:VenueCapabilities', {
      ...capabilities, rules: { maxOpenOrders: { cap: '10' } },
    }).ok).toBe(false)
  })

  it('requires normalized order fields and accepts exactly the five target variants', () => {
    const normalizedOrder = mutableCopy(gateCases[0]!.input.target)
    expect(schemaAccepts('GateTarget', normalizedOrder)).toBe(true)
    for (const field of ['size', 'tif', 'clientOrderId']) {
      const invalid = mutableCopy(normalizedOrder) as unknown as { intent: Record<string, unknown> }
      delete invalid.intent[field]
      expect(schemaAccepts('GateTarget', invalid)).toBe(false)
    }
    const cancelAll = { kind: 'cancel_all', keepProtective: true }
    const targets = [gateCases[0]!.input.target, gateCases[2]!.input.target, cancelAll, gateCases[5]!.input.target, gateCases[6]!.input.target]
    for (const target of targets) expect(schemaAccepts('GateTarget', target)).toBe(true)
    expect(schemaAccepts('GateTarget', { kind: 'unknown' })).toBe(false)
  })

  it('requires inherited and added decision fields while leaving escalation and mandateRef optional', () => {
    const decision = decisionForCase(gateCases[0]!)
    expect(schemaAccepts('GateDecision', decision)).toBe(true)
    const missingPrecheck = mutableCopy(decision) as unknown as Record<string, unknown>
    delete missingPrecheck.precheckId
    expect(schemaAccepts('GateDecision', missingPrecheck)).toBe(false)
    const missingAddition = mutableCopy(decision) as unknown as Record<string, unknown>
    delete missingAddition.action
    expect(schemaAccepts('GateDecision', missingAddition)).toBe(false)
    expect(schemaAccepts('GateDecision', { ...decision, gate: { ...decision.gate, schema: 'wrong' } })).toBe(false)
    const missingAllowedAction = mutableCopy(decision) as unknown as { allowedActions: Record<string, boolean> }
    delete missingAllowedAction.allowedActions.deadman_disarm
    expect(schemaAccepts('GateDecision', missingAllowedAction)).toBe(false)
  })

  it('validates snapshots, tickets, and all protector verdict variants', () => {
    const snapshot = mutableCopy(gateCases[0]!.input) as unknown as Record<string, any>
    const mandateBefore = structuredClone(snapshot.mandate)
    delete snapshot.target
    snapshot.policy = { policyId: 'pol_fixture', version: 1, digest: testDigest }
    expect(schemaAccepts('GateSnapshot', snapshot)).toBe(true)
    expect(snapshot.mandate).toEqual(mandateBefore)
    expect(schemaAccepts('GateSnapshot', { ...snapshot, policy: null })).toBe(true)

    const ticket = {
      ticketId: 'tk_01J00000000000000000000000', precheckId: 'pck_case001', bootId: 'boot-fixture', accountId: 'acct_fixture', action: 'open',
      targetDigest: testDigest, issuedAt: 1000000, expiresAt: 1001000, sig: 'Zml4dHVyZQ==',
    }
    expect(schemaAccepts('GateTicket', ticket)).toBe(true)
    expect(schemaAccepts('GateTicket', { ...ticket, action: 'unknown' })).toBe(false)
    expect(schemaAccepts('GateTicket', { ...ticket, expiresAt: 1001000.5 })).toBe(false)

    const verdicts = [
      { action: 'pass' },
      { action: 'block', message: 'fixture' },
      { action: 'limit', field: 'size', to: '1', message: 'fixture' },
      { action: 'pause', scope: 'account', minutes: 1440, message: 'fixture' },
    ]
    for (const verdict of verdicts) expect(schemaAccepts('ProtectorPreVerdict', verdict)).toBe(true)
    expect(schemaAccepts('ProtectorPreVerdict', { ...verdicts[3], minutes: 1441 })).toBe(false)
    const invalidLimit = { action: 'limit', field: 'size', message: 'fixture' }
    expect(schemaAccepts('ProtectorPreVerdict', invalidLimit)).toBe(false)
  })

  it('reports empty, malformed, schema-invalid, duplicate-name, and missing directories safely', () => {
    const withTempDirectory = (run: (directory: string) => void) => {
      const directory = mkdtempSync(join(tmpdir(), 'risk-gate-cases-'))
      try { run(directory) } finally { rmSync(directory, { recursive: true, force: true }) }
    }
    withTempDirectory((directory) => {
      expect(() => loadGateConformanceCases(directory)).toThrow(/No JSON risk-gate cases/)
    })
    withTempDirectory((directory) => {
      writeFileSync(join(directory, 'malformed.json'), '{', 'utf8')
      let message = ''
      try { loadGateConformanceCases(directory) } catch (error) { message = (error as Error).message }
      expect(message).toContain('malformed.json')
      expect(message).not.toContain(directory)
      expect(message).not.toContain('{')
    })
    withTempDirectory((directory) => {
      const invalid = mutableCopy(gateCases[0]!) as unknown as Record<string, any>
      invalid.input.action = 'unknown'
      writeFileSync(join(directory, 'invalid-schema.json'), JSON.stringify(invalid), 'utf8')
      let message = ''
      try { loadGateConformanceCases(directory) } catch (error) { message = (error as Error).message }
      expect(message).toContain('invalid-schema.json')
      expect(message).toContain('/input/action')
      expect(message).not.toContain(directory)
      expect(message).not.toContain('unknown')
    })
    withTempDirectory((directory) => {
      const first = mutableCopy(gateCases[0]!)
      const second = mutableCopy(gateCases[1]!)
      first.name = 'duplicate-fixture'
      second.name = 'duplicate-fixture'
      writeFileSync(join(directory, 'a.json'), JSON.stringify(first), 'utf8')
      writeFileSync(join(directory, 'b.json'), JSON.stringify(second), 'utf8')
      expect(() => loadGateConformanceCases(directory)).toThrow('Duplicate risk-gate case name: duplicate-fixture')
    })
    withTempDirectory((parent) => {
      const missing = join(parent, 'absent')
      let message = ''
      try { loadGateConformanceCases(missing) } catch (error) { message = (error as Error).message }
      expect(message).toContain('absent')
      expect(message).not.toContain(parent)
    })
  })
})
