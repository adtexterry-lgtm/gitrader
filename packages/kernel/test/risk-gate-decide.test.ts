// SPDX-License-Identifier: CPAL-1.0
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { checkGateDecisionConsistency, GATE_STAGES, validateBySchemaId } from '@gitrader/protocol'
import { loadGateConformanceCases } from '../../protocol/conformance/risk-gate/load'
import type { GateInput } from '@gitrader/protocol'
import { RiskGate, RiskService } from '../src/risk'
import { assembleGateInput, gateSnapshotOf, gateTargetDigest } from '../src/risk-gate/assemble'
import type { AccountSnapshot, NormalizedIntent } from '../src/connector'
import { InstallKey } from '../src/install-key'
import type { TradingStateService } from '../src/trading-state'
import { digestOf } from '../src/util/hash'
import { asDecimal } from '@gitrader/protocol'

const decimal = (value: string) => asDecimal(value)

const testHome = mkdtempSync(join(tmpdir(), 'gitrader-k1-'))
afterAll(() => {
  const tempRoot = resolve(tmpdir()) + sep
  const createdHome = resolve(testHome)
  if (createdHome.startsWith(tempRoot)) rmSync(createdHome, { recursive: true, force: true })
})
const key = InstallKey.loadOrCreate(join(testHome, 'risk-gate-test-key.json'), 1000)
const risk = {
  signGateDigest: (digest: string) => key.sign(digest),
  current: () => undefined,
  integrity: { ok: true, problems: [] },
} as unknown as RiskService
const gate = new RiskGate(risk, {} as TradingStateService)
const cases = loadGateConformanceCases()

describe('RiskGate.decide', () => {
  it.each(cases)('$name', (fixture) => {
    const decision = gate.decide(fixture.input)
    expect(decision.decision).toBe(fixture.expect.decision)
    expect(decision.verdict).toBe(fixture.expect.verdict)
    expect([...new Set(decision.ruleHits.map((hit) => hit.code))]).toEqual(fixture.expect.codes)
    expect(decision.applied).toEqual(fixture.expect.applied)
    expect(decision.allowedActions).toEqual(fixture.expect.allowedActions)
    expect(checkGateDecisionConsistency(decision)).toEqual([])
    const schemaResult = validateBySchemaId('urn:gitrader:schema:risk-gate:1#/$defs/GateDecision', decision)
    expect(schemaResult.ok, JSON.stringify(schemaResult.ok ? [] : { issues: schemaResult.issues, ruleHits: decision.ruleHits })).toBe(true)
  })

  it('denies stale-account case 12 and preserves a distinct skipped stage on case 15', () => {
    const staleReduce = cases.find((fixture) => fixture.name.startsWith('12-'))!
    expect(gate.decide(staleReduce.input).ruleHits).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'ACCOUNT_UNKNOWN', action: 'deny' })]))
    const skipped = cases.find((fixture) => fixture.name.startsWith('15-'))!
    expect(gate.decide(skipped.input).stages).toContain('PROTECTOR:skipped')
    expect(GATE_STAGES.length).toBeGreaterThan(0)
  })

  it('keeps assembled inputs and snapshots inside the frozen protocol fields', () => {
    const input = cases[0]!.input
    const decision = gate.decide(input)
    const snapshot = gateSnapshotOf(input)
    const allowedInputKeys = new Set(['precheckId', 'dryRun', 'action', 'actorClass', 'originActorType', 'originalTargetDigest', 'account', 'snapshot', 'mark', 'last', 'mandate', 'mandateIntegrity', 'policy', 'policyIntegrity', 'path', 'now', 'stats', 'rate', 'reserved', 'states', 'killSwitch', 'venueRules', 'protectorResults', 'target', 'instrument'])
    const allowedSnapshotKeys = new Set([...allowedInputKeys].filter((key) => key !== 'target' && key !== 'policy').concat('policy'))
    expect(Object.keys(input).every((key) => allowedInputKeys.has(key))).toBe(true)
    expect(Object.keys(snapshot).every((key) => allowedSnapshotKeys.has(key))).toBe(true)
    expect(snapshot).not.toHaveProperty('target')
    expect(snapshot.policy).toEqual(decision.policyRef)
    expect(snapshot).not.toEqual(expect.objectContaining({ policy: input.policy }))
    expect(digestOf(snapshot)).toBe(decision.snapshotDigest)
    for (const object of [input, snapshot]) for (const key of ['normalizationWarnings', 'routeKey', 'openOrderValuations', 'reservedReductionSize', 'uncertainty']) expect(object).not.toHaveProperty(key)
  })

  it('is deterministic for seeded repeated inputs, preserves input, and signs the unsigned decision', () => {
    for (const fixture of cases) {
      const before = structuredClone(fixture.input)
      const first = gate.decide(fixture.input)
      const second = gate.decide(fixture.input)
      expect(JSON.stringify(second)).toBe(JSON.stringify(first))
      expect(fixture.input).toEqual(before)
      const { attestation, ...unsigned } = first
      expect(attestation.digest).toBe(digestOf(unsigned))
      expect(InstallKey.verify(key.publicKey, attestation.digest, attestation.sig)).toBe(true)
    }
  })

  it('treats semantic input array permutations as the same gate snapshot', () => {
    const source = cases[0]?.input as GateInput
    const changed: GateInput = structuredClone(source)
    changed.snapshot.positions.reverse()
    changed.snapshot.openOrders.reverse()
    changed.account.groupIds.reverse()
    changed.snapshot.stopLossOrderIds.reverse()
    changed.states.reverse()
    changed.protectorResults.reverse()
    const decision = gate.decide(source)
    const permuted = gate.decide(changed)
    expect(permuted.snapshotDigest).toBe(decision.snapshotDigest)
    expect(permuted.targetDigest).toBe(decision.targetDigest)
  })

  it('rechecks an exposure size cap using existing and other-instrument notional', () => {
    const fixture = structuredClone(cases.find((item) => item.name === '17-limit-size')!)
    fixture.input.policy!.limits.maxOrderNotional = decimal('10000')
    fixture.input.policy!.limits.maxTotalNotionalRatio = decimal('0.3')
    fixture.input.target.kind === 'order' && (fixture.input.target.intent.size = decimal('20'))
    fixture.input.snapshot.positions = [
      { instrumentId: 'fixture:ASSET', side: 'long', size: decimal('5'), notional: decimal('500'), leverage: 2 },
      { instrumentId: 'fixture:OTHER', side: 'long', size: decimal('8'), notional: decimal('800'), leverage: 2 },
    ]
    fixture.input.snapshot.openOrders = [{ instrumentId: 'fixture:ASSET', side: 'buy', notional: decimal('200'), count: 1 }]
    const decision = gate.decide(fixture.input)
    expect(decision.decision).toBe('LIMIT')
    expect(decision.applied).toContainEqual(expect.objectContaining({ code: 'TOTAL_NOTIONAL', from: '20', to: '15' }))
  })

  it('keeps the original notional for the automatic approval threshold after LIMIT sizing', () => {
    const fixture = structuredClone(cases.find((item) => item.name === '17-limit-size')!)
    fixture.input.account.mode = 'live'
    fixture.input.actorClass = 'agent'
    fixture.input.originActorType = 'llm-agent'
    fixture.input.path = 'direct'
    fixture.input.mandate!.limits.autoMaxOrderNotional = decimal('300')
    fixture.input.policy!.limits.maxOrderNotional = decimal('10000')
    fixture.input.policy!.denyLlmLiveEntries = false
    fixture.input.target.kind === 'order' && (fixture.input.target.intent.size = decimal('10'))

    const approvalOnly = gate.decide(fixture.input)
    expect(approvalOnly.decision).toBe('BLOCK')
    expect(approvalOnly.verdict).toBe('review')
    expect(approvalOnly.ruleHits).toContainEqual(expect.objectContaining({ code: 'NEEDS_APPROVAL', actual: '1000', limit: '300' }))
    expect(approvalOnly.applied).toEqual([])

    fixture.input.policy!.limits.maxOrderNotional = decimal('200')
    const combined = gate.decide(fixture.input)
    expect(combined.decision).toBe('BLOCK')
    expect(combined.verdict).toBe('review')
    expect(combined.ruleHits).toContainEqual(expect.objectContaining({ code: 'ORDER_NOTIONAL', action: 'limit' }))
    expect(combined.ruleHits).toContainEqual(expect.objectContaining({ code: 'NEEDS_APPROVAL', actual: '1000', limit: '300' }))
    expect(combined.applied).toContainEqual(expect.objectContaining({ code: 'ORDER_NOTIONAL', from: '10', to: '2' }))
    expect(combined.estimates.notional).toBe('200')
    expect(combined.targetDigest).toBe(approvalOnly.targetDigest)
    expect(combined.adjustedTargetDigest).not.toBe(combined.targetDigest)
    expect(checkGateDecisionConsistency(combined)).toEqual([])
  })

  it('floors limit sizes to instrument steps and denies sizes below venue minima', () => {
    const fixture = structuredClone(cases.find((item) => item.name === '17-limit-size')!)
    const instrument = fixture.input.instrument
    if (!instrument) throw new Error('fixture lacks instrument metadata')
    instrument.size.step = decimal('3')
    fixture.input.policy!.limits.maxOrderNotional = decimal('1000')
    const floored = gate.decide(fixture.input)
    expect(floored.decision).toBe('LIMIT')
    expect(floored.applied).toContainEqual(expect.objectContaining({ to: '9' }))
    instrument.size.step = decimal('2')
    instrument.size.min = decimal('5')
    fixture.input.policy!.limits.maxOrderNotional = decimal('550')
    const belowMinimum = gate.decide(fixture.input)
    expect(belowMinimum.decision).toBe('BLOCK')
    expect(belowMinimum.verdict).toBe('deny')
    expect(belowMinimum.ruleHits).toContainEqual(expect.objectContaining({ code: 'ORDER_NOTIONAL', action: 'deny' }))
    expect(belowMinimum.applied).toEqual([])
  })

  it('requires both adjustment permissions for plugin limits and accepts the authorized second pass', () => {
    const fixture = structuredClone(cases.find((item) => item.name === '17-limit-size')!)
    const instrument = fixture.input.instrument
    if (!instrument) throw new Error('fixture lacks instrument metadata')
    fixture.input.target.kind === 'order' && (fixture.input.target.intent.size = decimal('1'))
    instrument.size = { step: decimal('0.1'), decimals: 1, min: decimal('0.1') }
    fixture.input.policy!.limits.maxOrderNotional = decimal('10000')
    fixture.input.policy!.protectors = [{ kind: 'plugin', pluginId: 'plugin_fixture', order: 1, source: { pluginId: 'plugin_fixture', version: '1' } }]
    fixture.input.protectorResults = [{
      pluginId: 'plugin_fixture', version: '1', sourceDigest: `sha256:${'c'.repeat(64)}`, order: 1, mode: 'enforce', seq: 1,
      result: { action: 'limit', field: 'size', to: decimal('0.5'), message: 'fixture limit' }, durationUs: 0,
    }]
    const allowed = gate.decide(fixture.input)
    expect(allowed.decision).toBe('LIMIT')
    expect(allowed.applied).toContainEqual(expect.objectContaining({ ruleId: 'plugin_fixture#1', from: '1', to: '0.5' }))
    expect(allowed.ruleHits).toContainEqual(expect.objectContaining({ ruleId: 'plugin_fixture#1', action: 'limit' }))
    fixture.input.target.kind === 'order' && delete fixture.input.target.intent.allowAdjust
    const oneSided = gate.decide(fixture.input)
    expect(oneSided.decision).toBe('BLOCK')
    expect(oneSided.ruleHits).toContainEqual(expect.objectContaining({ ruleId: 'plugin_fixture#1', action: 'deny' }))
    fixture.input.target.kind === 'order' && (fixture.input.target.intent.allowAdjust = ['size'])
    fixture.input.protectorResults[0]!.result = { action: 'limit', field: 'size', to: decimal('1'), message: 'fixture limit' }
    const invalid = gate.decide(fixture.input)
    expect(invalid.decision).toBe('BLOCK')
    expect(invalid.ruleHits).toContainEqual(expect.objectContaining({ code: 'PROTECTOR_UNAVAILABLE', action: 'deny' }))
  })

  it('preserves second-pass approval review and never shrinks a flip order', () => {
    const reviewFixture = structuredClone(cases.find((item) => item.name === '17-limit-size')!)
    reviewFixture.input.account.mode = 'live'
    reviewFixture.input.path = 'proposal'
    reviewFixture.input.mandate!.level = 'L2'
    reviewFixture.input.policy!.limits.maxOrderNotional = decimal('1000')
    const reviewed = gate.decide(reviewFixture.input)
    expect(reviewed.decision).toBe('BLOCK')
    expect(reviewed.verdict).toBe('review')
    expect(reviewed.applied.length).toBeGreaterThan(0)
    expect(reviewed.adjustedTargetDigest).not.toBe(reviewed.targetDigest)
    const flipFixture = structuredClone(cases.find((item) => item.name === '17-limit-size')!)
    flipFixture.input.snapshot.positions = [{ instrumentId: 'fixture:ASSET', side: 'short', size: decimal('5'), notional: decimal('500'), leverage: 2 }]
    const flip = gate.decide(flipFixture.input)
    expect(flip.decision).toBe('BLOCK')
    expect(flip.applied).toEqual([])
    expect(flip.adjustedTargetDigest).toBe(flip.targetDigest)
  })

  it('keeps allowedActions level-based while invalid mandate integrity blocks execution', () => {
    const fixture = structuredClone(cases.find((item) => item.name === '01-open-agent')!)
    fixture.input.mandateIntegrity = { ok: false, problems: ['invalid'] }
    const decision = gate.decide(fixture.input)
    expect(decision.decision).toBe('BLOCK')
    expect(decision.verdict).toBe('deny')
    expect(decision.allowedActions.open).toBe(true)
    expect(decision.ruleHits).toContainEqual(expect.objectContaining({ code: 'MANDATE_EXPIRED', action: 'deny' }))
  })

  it('aggregates full open orders with per-instrument valuations and fails closed when a valuation is missing', () => {
    const fixture = cases.find((item) => item.name === '17-limit-size')!
    const input = fixture.input
    const account = { accountId: input.account.accountId, venue: input.account.venue, mode: 'paper', groupIds: [] } as never
    const inst = input.instrument!
    const common = {
      intent: (input.target as Extract<GateInput['target'], { kind: 'order' }>).intent as unknown as NormalizedIntent,
      account, inst, mandate: input.mandate, policy: input.policy, policyIntegrity: input.policyIntegrity, mandateIntegrity: input.mandateIntegrity,
      states: input.states, stats: input.stats, path: input.path, actorType: input.originActorType, now: input.now, precheckId: input.precheckId, dryRun: input.dryRun,
      mark: input.mark,
    }
    const snapshot = {
      accountId: input.account.accountId, ts: input.snapshot.asOf, equity: input.snapshot.equity, available: input.snapshot.available,
      positions: [], openOrders: [{
        instrumentId: 'fixture:OTHER', venueOrderId: 'venue-order-test', clientOrderId: null, side: 'buy', type: 'limit', price: '10', triggerPrice: null,
        size: '2', origSize: '2', reduceOnly: false, isTrigger: false, createdAt: input.now,
      }],
    } as unknown as AccountSnapshot
    const valued = assembleGateInput({ ...common, snapshot, openOrderValuations: { 'fixture:OTHER': { contractSize: decimal('3') } } })
    expect(valued.snapshot.openOrders).toEqual([{ instrumentId: 'fixture:OTHER', side: 'buy', notional: '60', count: 1 }])
    const unknown = assembleGateInput({ ...common, snapshot })
    expect(unknown.snapshot.stale).toBe(true)
    const blocked = gate.decide(unknown)
    expect(blocked.decision).toBe('BLOCK')
    expect(blocked.ruleHits).toContainEqual(expect.objectContaining({ code: 'ACCOUNT_UNKNOWN' }))
  })

  it('uses the normalized target digest and replays only the frozen GateInput fields', () => {
    const fixture = cases.find((item) => item.name === '17-limit-size')!
    const input = fixture.input
    const account = { accountId: input.account.accountId, venue: input.account.venue, mode: 'paper', groupIds: [] } as never
    const intent = { ...(input.target as Extract<GateInput['target'], { kind: 'order' }>).intent, side: 'sell', size: '2', reduceOnly: false, leverage: 4 } as unknown as NormalizedIntent
    const inst = input.instrument!
    const snapshot = { accountId: input.account.accountId, ts: 1, equity: '10000', available: '10000', positions: [{ instrumentId: intent.instrumentId, side: 'long', size: '2', notional: '200', leverage: 2 }], openOrders: [] } as unknown as AccountSnapshot
    const originalTarget = { kind: 'order', intent } as const
    const assembled = assembleGateInput({
      intent, account, inst, snapshot, mandate: input.mandate, policy: input.policy, policyIntegrity: input.policyIntegrity,
      mandateIntegrity: input.mandateIntegrity, states: [], stats: input.stats, path: 'direct', actorType: 'engine', now: input.now,
      precheckId: input.precheckId, dryRun: true,
    })
    expect(assembled.target.kind).toBe('order')
    if (assembled.target.kind !== 'order') throw new Error('expected order target')
    expect(assembled.target.intent).toMatchObject({ reduceOnly: true })
    expect(assembled.target.intent.leverage).toBeUndefined()
    expect('normalizationWarnings' in assembled).toBe(false)
    const decision = gate.decide(assembled)
    expect(decision.targetDigest).toBe(gateTargetDigest(assembled.target))
    expect(decision.targetDigest).not.toBe(gateTargetDigest(originalTarget))
    expect(JSON.stringify(gate.decide(JSON.parse(JSON.stringify(assembled)) as GateInput))).toBe(JSON.stringify(decision))
  })

  it('preserves explicit snapshot summary fields and never synthesizes confirmedAt from ts', () => {
    const fixture = cases.find((item) => item.name === '17-limit-size')!
    const input = fixture.input
    const account = { accountId: input.account.accountId, venue: input.account.venue, mode: 'paper', groupIds: [] } as never
    const intent = (input.target as Extract<GateInput['target'], { kind: 'order' }>).intent as unknown as NormalizedIntent
    const inst = input.instrument!
    const make = (snapshotExtra: Record<string, unknown>) => assembleGateInput({
      intent, account, inst, snapshot: { accountId: input.account.accountId, ts: 1, equity: '10000', available: '10000', positions: [], openOrders: [], ...snapshotExtra } as unknown as AccountSnapshot,
      mandate: input.mandate, policy: input.policy, policyIntegrity: input.policyIntegrity, mandateIntegrity: input.mandateIntegrity, states: [], stats: input.stats,
      path: 'direct', actorType: 'engine', now: input.now, precheckId: input.precheckId, dryRun: true,
    })
    const old = make({ stale: false })
    expect(old.snapshot.confirmedAt).toBeUndefined()
    expect(gate.decide(old).ruleHits.map((hit) => hit.code)).not.toContain('ACCOUNT_UNKNOWN')
    const supplied = make({ asOf: 22, availableDeductsOpenOrders: true, stopLossOrderIds: ['stop_test'], confirmedAt: 21, stale: false })
    expect(supplied.snapshot).toMatchObject({ asOf: 22, availableDeductsOpenOrders: true, stopLossOrderIds: ['stop_test'], confirmedAt: 21 })
  })

  it('only accepts venue_mark from legacy mark inputs', () => {
    const fixture = cases.find((item) => item.name === '17-limit-size')!
    const input = fixture.input
    const account = { accountId: input.account.accountId, venue: input.account.venue, mode: 'paper', groupIds: [] } as never
    const common = {
      intent: (input.target as Extract<GateInput['target'], { kind: 'order' }>).intent as unknown as NormalizedIntent,
      account, inst: input.instrument!, snapshot: { accountId: input.account.accountId, ts: input.now, equity: '10000', available: '10000', positions: [], openOrders: [] } as unknown as AccountSnapshot,
      mandate: input.mandate, policy: input.policy, policyIntegrity: input.policyIntegrity, mandateIntegrity: input.mandateIntegrity, states: [], stats: input.stats,
      path: 'direct' as const, actorType: 'engine' as const, now: input.now, precheckId: input.precheckId, dryRun: true,
    }
    for (const source of ['last', 'mid', undefined] as const) {
      const assembled = assembleGateInput({ ...common, mark: { price: decimal('100'), ts: input.now, ...(source ? { source } : {}) } })
      expect(assembled.mark).toBeUndefined()
      expect(gate.decide(assembled).ruleHits).toContainEqual(expect.objectContaining({ code: 'STALE_PRICE' }))
    }
    expect(assembleGateInput({ ...common, mark: { price: decimal('100'), ts: input.now, source: 'venue_mark' } }).mark?.source).toBe('venue_mark')
  })

  it('does not attach escalation when a kill denial takes precedence over approval review', () => {
    const fixture = structuredClone(cases.find((item) => item.name === '17-limit-size')!)
    fixture.input.account.mode = 'live'
    fixture.input.path = 'proposal'
    fixture.input.mandate!.level = 'L2'
    fixture.input.killSwitch = { tripped: true }
    const decision = gate.decide(fixture.input)
    expect(decision.verdict).toBe('deny')
    expect(decision.escalation).toBeUndefined()
    expect(checkGateDecisionConsistency(decision)).toEqual([])
  })

  it('keeps an invalid-minimum synthetic hit inside CONST', () => {
    const fixture = structuredClone(cases.find((item) => item.name === '17-limit-size')!)
    fixture.input.policy!.limits.maxOrderNotional = decimal('1000')
    fixture.input.policy!.limits.maxTotalNotionalRatio = decimal('0.1')
    fixture.input.snapshot.positions = [
      { instrumentId: 'fixture:ASSET', side: 'long', size: decimal('10'), notional: decimal('1000'), leverage: 2 },
      { instrumentId: 'fixture:OTHER', side: 'long', size: decimal('20'), notional: decimal('2000'), leverage: 2 },
    ]
    fixture.input.snapshot.openOrders = [{ instrumentId: 'fixture:ASSET', side: 'buy', notional: decimal('500'), count: 1 }]
    fixture.input.policy!.limits.maxOrdersPerMinute = 0
    const decision = gate.decide(fixture.input)
    expect(decision.verdict).toBe('deny')
    expect(decision.applied).toEqual([])
    expect(decision.adjustedTargetDigest).toBe(decision.targetDigest)
    expect(decision.ruleHits.map(({ ruleId, code, action, limit, actual }) => ({ ruleId, code, action, limit, actual }))).toEqual([
      { ruleId: 'pol_fixture#maxOrderNotional', code: 'ORDER_NOTIONAL', action: 'deny', limit: '1000', actual: '2000' },
      { ruleId: 'fixture#minOrderNotional', code: 'ORDER_NOTIONAL', action: 'deny', limit: '1', actual: '0' },
      { ruleId: 'pol_fixture#maxTotalNotionalRatio', code: 'TOTAL_NOTIONAL', action: 'deny', limit: '0.1', actual: '0.55' },
      { ruleId: 'pol_fixture#maxOrdersPerMinute', code: 'RATE_BUDGET', action: 'deny', limit: '0', actual: '1' },
    ])
  })

  it('keeps corrected limits in stage order when a later stage requires review', () => {
    const fixture = structuredClone(cases.find((item) => item.name === '17-limit-size')!)
    fixture.input.policy!.limits.maxTotalNotionalRatio = decimal('0.3')
    fixture.input.snapshot.positions = [
      { instrumentId: 'fixture:ASSET', side: 'long', size: decimal('5'), notional: decimal('500'), leverage: 2 },
      { instrumentId: 'fixture:OTHER', side: 'long', size: decimal('8'), notional: decimal('800'), leverage: 2 },
    ]
    fixture.input.snapshot.openOrders = [{ instrumentId: 'fixture:ASSET', side: 'buy', notional: decimal('200'), count: 1 }]
    fixture.input.account.mode = 'live'
    fixture.input.path = 'proposal'
    fixture.input.mandate!.level = 'L2'
    const decision = gate.decide(fixture.input)
    expect(decision.verdict).toBe('review')
    expect(decision.applied.map(({ code, to }) => ({ code, to }))).toEqual([
      { code: 'ORDER_NOTIONAL', to: '10' }, { code: 'TOTAL_NOTIONAL', to: '10' },
    ])
    expect(decision.ruleHits.map(({ code, action }) => ({ code, action }))).toEqual([
      { code: 'ORDER_NOTIONAL', action: 'limit' }, { code: 'TOTAL_NOTIONAL', action: 'limit' }, { code: 'NEEDS_APPROVAL', action: 'review' },
    ])
  })

  it('clears corrected limits when the second pass still has a deny', () => {
    const fixture = structuredClone(cases.find((item) => item.name === '17-limit-size')!)
    fixture.input.policy!.limits.maxTotalNotionalRatio = decimal('0.3')
    fixture.input.snapshot.positions = [
      { instrumentId: 'fixture:ASSET', side: 'long', size: decimal('5'), notional: decimal('500'), leverage: 2 },
      { instrumentId: 'fixture:OTHER', side: 'long', size: decimal('8'), notional: decimal('800'), leverage: 2 },
    ]
    fixture.input.snapshot.openOrders = [{ instrumentId: 'fixture:ASSET', side: 'buy', notional: decimal('200'), count: 1 }]
    fixture.input.account.mode = 'live'
    fixture.input.path = 'proposal'
    fixture.input.mandate!.level = 'L2'
    fixture.input.policy!.limits.maxOrdersPerMinute = 0
    const decision = gate.decide(fixture.input)
    expect(decision.verdict).toBe('deny')
    expect(decision.applied).toEqual([])
    expect(decision.adjustedTargetDigest).toBe(decision.targetDigest)
    expect(decision.escalation).toBeUndefined()
    expect(decision.ruleHits.map(({ code, action }) => ({ code, action }))).toEqual([
      { code: 'RATE_BUDGET', action: 'deny' }, { code: 'NEEDS_APPROVAL', action: 'review' },
    ])
  })

  it('allows an amend-to-open action to use the same size limit path as open', () => {
    const fixture = structuredClone(cases.find((item) => item.name === '17-limit-size')!)
    fixture.input.action = 'amend'
    fixture.input.target.kind === 'order' && (fixture.input.target.intent.reduceOnly = false)
    const amend = gate.decide(fixture.input)
    const opening = gate.decide({ ...fixture.input, action: 'open' })
    expect(amend.decision).toBe('LIMIT')
    expect(amend.applied).toEqual(opening.applied)
  })

  it('keeps 200 deterministic seeded decisions stable under semantic array permutations', () => {
    for (let seed = 0; seed < 200; seed++) {
      const fixture = cases[seed % cases.length]!
      const input = structuredClone(fixture.input)
      const before = structuredClone(input)
      if (seed % 2 === 1) {
        input.snapshot.positions.reverse()
        input.snapshot.openOrders.reverse()
        input.snapshot.stopLossOrderIds.reverse()
        input.account.groupIds.reverse()
        input.states.reverse()
        input.protectorResults.reverse()
      }
      const first = gate.decide(input)
      const second = gate.decide(input)
      expect(JSON.stringify(second), `${fixture.name}:${seed}`).toBe(JSON.stringify(first))
      expect(input).toEqual(before)
      if (seed % 2 === 1) expect(first.snapshotDigest).toBe(gate.decide(fixture.input).snapshotDigest)
    }
  })
})
