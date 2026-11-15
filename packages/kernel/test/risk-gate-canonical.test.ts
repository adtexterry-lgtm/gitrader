// SPDX-License-Identifier: CPAL-1.0
import { describe, expect, it } from 'vitest'
import { asDecimal, type AccountId, type GateInput, type GateTarget, type GroupId, type RiskPolicy, type Sha256Digest } from '@gitrader/protocol'
import { canonicalGateInput, canonicalGateTarget, cleanGateValue, gateSnapshotDigest, gateTargetDigest, policyRefOf } from '../src/risk-gate/assemble'
import { normalizeRiskTarget } from '../src/normalize'
import { digestOf } from '../src/util/hash'
import type { NormalizedIntent } from '../src/connector'
import { loadGateConformanceCases } from '../../protocol/conformance/risk-gate/load'

const decimal = (value: string) => asDecimal(value)
const orderIntent = (side: 'buy' | 'sell' = 'sell', extra: Partial<NormalizedIntent> = {}): NormalizedIntent => ({
  accountId: 'acct_test' as AccountId, instrumentId: 'venue:asset', side, type: 'limit', size: decimal('2'), price: decimal('10'), tif: 'gtc', clientOrderId: '0123456789abcdef0123456789abcdef', ...extra,
})

const target = (intent = orderIntent()): Extract<GateTarget, { kind: 'order' }> => ({ kind: 'order', intent })

const gateInput = (overrides: Partial<GateInput> = {}): GateInput => {
  const input: GateInput = {
  precheckId: 'pck_test', dryRun: true, action: 'open', actorClass: 'agent', originActorType: 'engine',
  account: { accountId: 'acct_test' as AccountId, venue: 'venue', mode: 'paper', groupIds: ['grp_z', 'grp_a'] as GroupId[] },
  snapshot: { equity: decimal('100'), available: decimal('80'), availableDeductsOpenOrders: false, positions: [], openOrders: [], stopLossOrderIds: [], asOf: 10, stale: false },
  mandate: null, mandateIntegrity: { ok: true, problems: [] },
  policy: null, policyIntegrity: { ok: true, problems: [] }, path: 'direct', now: 11,
  stats: { dailyNotional: decimal('0'), mandateDailyNotional: decimal('0'), ordersLastMinute: 0, mandateOrdersLastMinute: 0, ordersToday: 0, mandateOrdersToday: 0 },
  reserved: { account: { margin: decimal('0'), notional: decimal('0'), count: 0 }, byInstrument: {}, today: { notional: decimal('0'), count: 0 }, lastMinute: { count: 0 } },
  states: [], killSwitch: { tripped: false }, protectorResults: [], target: target(),
  instrument: structuredClone(loadGateConformanceCases()[0]!.input.instrument!),
  }
  return Object.assign(input, overrides)
}

const policy = (version: number): RiskPolicy => ({
  policyId: 'pol_test', version, scope: { type: 'account', id: 'acct_test' as AccountId },
  limits: { maxSlippageBps: 10 }, failClosed: { stalePriceMs: 100, onMissingPrice: 'deny' },
  dailyResetAt: '00:00Z', valuationCcy: 'USD',
  attestation: { method: 'system', by: 'kernel', at: 1, digest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Sha256Digest, sig: 'signature' },
})

describe('risk gate canonicalization', () => {
  it('deeply removes undefined object fields without mutating the source and rejects undefined array entries', () => {
    const source = { outer: { keep: 1, omit: undefined }, list: [{ omit: undefined, keep: true }] }
    expect(cleanGateValue(source)).toEqual({ outer: { keep: 1 }, list: [{ keep: true }] })
    expect(Object.hasOwn(source.outer, 'omit')).toBe(true)
    expect(() => cleanGateValue([1, undefined])).toThrow()
  })

  it('sorts semantic arrays with UTF-16 keys so equivalent targets and inputs hash equally', () => {
    const left = gateInput({
      target: { kind: 'cancel', targets: [{ orderId: 'b', clientOrderId: 'b' }, { orderId: 'a', clientOrderId: 'a' }] },
      account: { accountId: 'acct_test', venue: 'venue', mode: 'paper', groupIds: ['z', 'a'] },
      snapshot: { equity: decimal('100'), available: decimal('80'), availableDeductsOpenOrders: false, positions: [{ instrumentId: 'venue:z', side: 'long', size: decimal('1'), notional: decimal('1'), leverage: 1 }, { instrumentId: 'venue:a', side: 'short', size: decimal('1'), notional: decimal('1'), leverage: 1 }], openOrders: [], stopLossOrderIds: ['z', 'a'], asOf: 10, stale: false },
      states: [{ scope: { type: 'account', id: 'z' }, state: 'ACTIVE', reason: 'r' }, { scope: { type: 'account', id: 'a' }, state: 'ACTIVE', reason: 'r' }],
      protectorResults: [{ pluginId: 'z', version: '1', sourceDigest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', order: 2, mode: 'monitor', seq: 1, result: { action: 'pass' }, durationUs: 0 }, { pluginId: 'a', version: '1', sourceDigest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', order: 1, mode: 'monitor', seq: 1, result: { action: 'pass' }, durationUs: 0 }],
    })
    const right = gateInput({
      target: { kind: 'cancel', targets: [{ orderId: 'a', clientOrderId: 'a' }, { orderId: 'b', clientOrderId: 'b' }] },
      account: { accountId: 'acct_test', venue: 'venue', mode: 'paper', groupIds: ['a', 'z'] },
      snapshot: { equity: decimal('100'), available: decimal('80'), availableDeductsOpenOrders: false, positions: [{ instrumentId: 'venue:a', side: 'short', size: decimal('1'), notional: decimal('1'), leverage: 1 }, { instrumentId: 'venue:z', side: 'long', size: decimal('1'), notional: decimal('1'), leverage: 1 }], openOrders: [], stopLossOrderIds: ['a', 'z'], asOf: 10, stale: false },
      states: [{ scope: { type: 'account', id: 'a' }, state: 'ACTIVE', reason: 'r' }, { scope: { type: 'account', id: 'z' }, state: 'ACTIVE', reason: 'r' }],
      protectorResults: [{ pluginId: 'a', version: '1', sourceDigest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', order: 1, mode: 'monitor', seq: 1, result: { action: 'pass' }, durationUs: 0 }, { pluginId: 'z', version: '1', sourceDigest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', order: 2, mode: 'monitor', seq: 1, result: { action: 'pass' }, durationUs: 0 }],
    })
    expect((canonicalGateTarget(left.target) as Extract<GateTarget, { kind: 'cancel' }>).targets.map((x) => x.orderId)).toEqual(['a', 'b'])
    expect(gateTargetDigest(left.target)).toBe(gateTargetDigest(right.target))
    expect(canonicalGateInput(left)).toEqual(canonicalGateInput(right))
  })

  it('changes digests when the target or signed policy version changes and reduces snapshot policy to attestation digest', () => {
    const input = gateInput({ policy: policy(1) })
    expect(gateTargetDigest(target(orderIntent('sell')))).not.toBe(gateTargetDigest(target(orderIntent('buy'))))
    expect(policyRefOf(policy(1))).toEqual({ policyId: 'pol_test', version: 1, digest: policy(1).attestation.digest })
    expect(gateSnapshotDigest(input)).not.toBe(gateSnapshotDigest(gateInput({ policy: policy(2) })))
    expect(gateSnapshotDigest(input)).not.toBe(gateSnapshotDigest(gateInput({ now: 12, policy: policy(1) })))
  })
})

describe('risk target reduction normalization', () => {
  const longPosition = [{ instrumentId: 'venue:asset', side: 'long' as const, size: decimal('5'), notional: decimal('50'), leverage: 2 }]

  it('marks a fitting opposite-side intent as reduce only and records the original target digest', () => {
    const intent = orderIntent('sell')
    const result = normalizeRiskTarget(intent, longPosition)
    expect(result.action).toBe('reduce')
    expect(result.intent.reduceOnly).toBe(true)
    expect(result.originalTargetDigest).toBe(digestOf({ kind: 'order', intent }))
    expect(result.warnings).toEqual([])
  })

  it('canonicalizes nested undefined fields for the original digest without mutating the intent', () => {
    const intent = { ...orderIntent('sell'), nested: { omit: undefined, keep: 'value' } } as NormalizedIntent
    const before = structuredClone(intent)
    const result = normalizeRiskTarget(intent, longPosition)
    expect(intent).toEqual(before)
    expect(result.originalTargetDigest).toBe(gateTargetDigest({ kind: 'order', intent } as GateTarget))
  })

  it('keeps an opposite-side order open when reserved reductions consume the position', () => {
    const result = normalizeRiskTarget(orderIntent('sell'), longPosition, decimal('5'))
    expect(result.action).toBe('open')
    expect(result.intent.reduceOnly).toBeUndefined()
  })

  it('keeps explicit reduce only, strips leverage, and makes the pre-change digest reproducible', () => {
    const intent = orderIntent('sell', { reduceOnly: true, leverage: 4 })
    const result = normalizeRiskTarget(intent, [])
    expect(result.action).toBe('reduce')
    expect(result.intent.leverage).toBeUndefined()
    expect(result.originalTargetDigest).toBe(digestOf({ kind: 'order', intent }))
    expect(result.warnings).toEqual([{ ruleId: 'gate#reduceLeverage', code: 'LEVERAGE', action: 'warn', limit: '0', actual: '4', unit: 'x', scope: 'account' }])
    expect(result.intent.clientOrderId).toBe(intent.clientOrderId)
    expect(result.intent.size).toBe(intent.size)
  })

  it('leaves same-side and position-flipping intents open', () => {
    expect(normalizeRiskTarget(orderIntent('buy'), longPosition).action).toBe('open')
    expect(normalizeRiskTarget(orderIntent('sell', { size: decimal('6') }), longPosition).action).toBe('open')
  })
})
