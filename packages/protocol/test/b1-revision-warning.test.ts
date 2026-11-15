// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest'
import { asDecimal } from '../src/model/decimal'
import type { GateDecision } from '../src/model/risk'
import { checkGateDecisionConsistency } from '../src/risk-gate/consistency'
import { validateBySchemaId } from '../src/validate'

const schemaId = 'urn:gitrader:schema:risk-gate:1#/$defs/GateDecision'
const digest = `sha256:${'a'.repeat(64)}` as GateDecision['snapshotDigest']

function decision(decision: 'ALLOW' | 'LIMIT' = 'ALLOW'): GateDecision {
  const limitHit = { ruleId: 'policy#limit', code: 'ORDER_NOTIONAL' as const, limit: asDecimal('10'), actual: asDecimal('12'), unit: 'USD', action: 'limit' as const, scope: 'account' as const }
  return {
    precheckId: 'pck_revision' as GateDecision['precheckId'], verdict: 'allow', policyVersion: 1,
    ruleHits: decision === 'LIMIT' ? [limitHit] : [], estimates: {},
    gate: { schema: 'gitrader-risk-gate/1', rulesetVersion: 'revision' }, decision, action: 'open',
    targetDigest: digest, adjustedTargetDigest: decision === 'LIMIT' ? `sha256:${'b'.repeat(64)}` : digest,
    applied: decision === 'LIMIT' ? [{ ruleId: 'policy#limit', code: 'ORDER_NOTIONAL', field: 'size', from: asDecimal('2'), to: asDecimal('1'), unit: 'unit' }] : [],
    allowedActions: { open: true, reduce: true, cancel: true, cancel_protective: false, amend: true, leverage: true, deadman_arm: true, deadman_disarm: false },
    irreversibility: 'high', stages: [], monitorHits: [], snapshotDigest: digest,
    policyRef: { policyId: 'pol_revision' as never, version: 1, digest },
    mandateRef: { mandateId: 'mdt_revision' as never, version: 1, digest, effectiveLevel: 'L1', effectiveStatus: 'active' },
    dryRun: false, attestation: { method: 'system', by: 'kernel', at: 1, digest, sig: 'fixture' },
  }
}

function warning(overrides: Record<string, unknown> = {}) {
  return {
    ruleId: 'policy#stale-price', code: 'STALE_PRICE', field: 'markPrice',
    from: '123.45', to: '123.45', unit: 'USD', kind: 'warning', ...overrides,
  }
}

function withWarning(d: GateDecision, applied = [...d.applied, warning() as never]): GateDecision {
  d.ruleHits = [...d.ruleHits, {
    ruleId: 'policy#stale-price', code: 'STALE_PRICE', limit: asDecimal('1'), actual: asDecimal('1'),
    unit: 'USD', action: 'warn', scope: 'account',
  }]
  d.applied = applied as GateDecision['applied']
  return d
}

describe('STALE_PRICE applied warning', () => {
  it('allows a validated mark-price warning without changing an ALLOW target digest', () => {
    const d = withWarning(decision())
    expect(d.targetDigest).toBe(d.adjustedTargetDigest)
    expect(checkGateDecisionConsistency(d)).toEqual([])
  })

  it('allows a real LIMIT size adjustment alongside a warning', () => {
    const d = withWarning(decision('LIMIT'))
    expect(checkGateDecisionConsistency(d)).toEqual([])
  })

  it('rejects a warning-only LIMIT as lacking a real adjustment', () => {
    const d = withWarning(decision('LIMIT'), [warning() as never])
    expect(checkGateDecisionConsistency(d)).toContain('LIMIT requires a nonempty applied list')
  })

  it('continues to reject a real size adjustment on ALLOW', () => {
    const d = decision()
    d.applied = [{ ruleId: 'policy#size', code: 'ORDER_NOTIONAL', field: 'size', from: asDecimal('2'), to: asDecimal('1'), unit: 'unit' }]
    expect(checkGateDecisionConsistency(d)).toContain('ALLOW requires an empty applied list')
  })

  it.each([
    ['wrong code', { code: 'ORDER_NOTIONAL' }],
    ['wrong field', { field: 'size' }],
    ['number', { from: 123, to: 123 }],
    ['zero', { from: '0', to: '0' }],
    ['negative', { from: '-1', to: '-1' }],
    ['unequal values', { to: '124' }],
    ['no matching warn hit', { ruleId: 'policy#missing' }],
    ['markPrice without kind', { kind: undefined }],
  ])('rejects an invalid warning: %s', (_name, overrides) => {
    const d = withWarning(decision(), [warning(overrides) as never])
    expect(checkGateDecisionConsistency(d).length).toBeGreaterThan(0)
  })

  it('validates the warning shape in the GateDecision schema', () => {
    const d = withWarning(decision())
    expect(validateBySchemaId(schemaId, d).ok).toBe(true)
    expect(validateBySchemaId(schemaId, { ...d, applied: [warning({ field: 'size' })] }).ok).toBe(false)
    expect(validateBySchemaId(schemaId, { ...d, applied: [warning({ kind: undefined })] }).ok).toBe(false)
  })
})
