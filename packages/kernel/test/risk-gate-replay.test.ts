// SPDX-License-Identifier: CPAL-1.0
import { afterEach, describe, expect, it } from 'vitest'
import type { Decimal, GateDecision, GateInput, Sha256Digest } from '@gitrader/protocol'
import { GATE_STAGES } from '@gitrader/protocol'
import { loadGateConformanceCases } from '../../protocol/conformance/risk-gate/load'
import { makeHarness } from './helpers/harness'
import type { Harness } from './helpers/harness'
import { gateSnapshotOf } from '../src/risk-gate/assemble'
import { InstallKey } from '../src/install-key'
import { digestOf } from '../src/util/hash'

let h: Harness | undefined
afterEach(async () => { await h?.cleanup() })

const source = loadGateConformanceCases().find((fixture) => fixture.name === '01-open-agent')!.input
const replayId = (index: number): GateInput['precheckId'] => `pck_replay_${String(index).padStart(4, '0')}` as GateInput['precheckId']
const decimal = (value: string): Decimal => value as Decimal

function seededInput(harness: Harness, index: number): GateInput {
  const input = structuredClone(source)
  input.precheckId = replayId(index)
  input.policy = harness.k.risk.current() ?? null
  input.policyIntegrity = { ...harness.k.risk.integrity }
  input.now = 1000
  if (input.mark) input.mark.ts = input.now
  expect(input.mark?.ts).toBe(input.now)
  if (input.target.kind === 'order') {
    input.target.intent.size = decimal(`${(index % 10 + 1) / 1000}`)
    input.target.intent.price = decimal(`${80000 + index}`)
  }
  input.snapshot.equity = decimal(`${10000 + index}`)
  input.snapshot.available = decimal(`${8000 + index}`)
  input.stats.dailyNotional = decimal(`${index}`)
  return input
}

function appendDecision(harness: Harness, input: GateInput, decision: GateDecision, snapshot = gateSnapshotOf(input), target = input.target): void {
  const orderIntent = target.kind === 'order' ? target.intent : undefined
  harness.k.ledger.append({
    type: 'risk.precheck', origin: harness.human().origin,
    subject: { precheckId: decision.precheckId, accountId: input.account.accountId, ...(orderIntent ? { instrumentId: orderIntent.instrumentId, clientOrderId: orderIntent.clientOrderId } : {}) },
    precheck: { precheckId: decision.precheckId, verdict: decision.verdict, policyVersion: decision.policyVersion, estimates: decision.estimates },
    ...(decision.verdict === 'allow' ? {} : { ruleHits: decision.ruleHits }),
    payload: { gate: { decision, snapshot, target } },
  })
}

describe('deterministic risk gate replay', () => {
  it('replays 200 deterministic signed historical inputs without mutation', async () => {
    h = await makeHarness()
    const originals: Array<{ input: GateInput; decision: GateDecision; before: GateInput }> = []
    const capture: GateDecision[] = []
    const decide = h.k.gate.decide.bind(h.k.gate)
    h.k.gate.decide = ((input) => { const result = decide(input); capture.push(result); return result }) as typeof h.k.gate.decide
    for (let index = 0; index < 200; index++) {
      const input = seededInput(h, index), before = structuredClone(input)
      const decision = h.k.gate.decide(input)
      expect(input).toEqual(before)
      appendDecision(h, input, decision)
      originals.push({ input, decision, before })
    }
    await h.k.risk.tighten({ limits: { maxSlippageBps: 49 } }, await h.sessionProof(), h.human('risk.tighten').origin)
    const beforeHead = h.k.ledger.head(), integrity = structuredClone(h.k.risk.integrity), connectorCalls = h.sim.submitted.length + h.live.submitted.length
    for (const { input, decision, before } of originals) {
      capture.length = 0
      const replay = h.k.risk.replay(input.precheckId)
      expect(replay.status, input.precheckId).toBe('identical')
      expect(input).toEqual(before)
      expect(capture).toHaveLength(1)
      const { attestation: _originalAttestation, ...originalUnsigned } = decision
      const { attestation: _replayedAttestation, ...replayedUnsigned } = capture[0]!
      expect(JSON.stringify(replayedUnsigned)).toBe(JSON.stringify(originalUnsigned))
      expect(h.k.ledger.head()).toEqual(beforeHead)
      expect(h.k.risk.integrity).toEqual(integrity)
      expect(h.sim.submitted.length + h.live.submitted.length).toBe(connectorCalls)
    }
  })

  it('rejects unknown ids and reports header-only records as diffs', async () => {
    h = await makeHarness()
    expect(() => h!.k.risk.replay(replayId(900))).toThrowError(expect.objectContaining({ problem: expect.objectContaining({ name: 'INVALID_PARAMS' }) }))
    const input = seededInput(h, 901), decision = h.k.gate.decide(input)
    h.k.ledger.append({ type: 'risk.precheck', origin: h.human().origin, subject: { precheckId: input.precheckId, accountId: input.account.accountId }, precheck: { precheckId: input.precheckId, verdict: decision.verdict, policyVersion: decision.policyVersion, estimates: decision.estimates }, ...(decision.verdict === 'allow' ? {} : { ruleHits: decision.ruleHits }), payload: {} })
    expect(h.k.risk.replay(input.precheckId)).toMatchObject({ status: 'diff', differences: [expect.objectContaining({ field: 'gate' })] })
  })

  it('reports tampered signatures, snapshots, targets, and ruleset versions', async () => {
    h = await makeHarness()
    const base = seededInput(h, 910), valid = h.k.gate.decide(base), snapshot = gateSnapshotOf(base)
    const badSig = { ...valid, attestation: { ...valid.attestation, sig: 'invalid-signature' } }
    appendDecision(h, { ...base, precheckId: replayId(911) }, { ...badSig, precheckId: replayId(911) } as GateDecision, { ...snapshot, precheckId: replayId(911) } as typeof snapshot)
    const badSnapshotInput = seededInput(h, 912), badSnapshotDecision = h.k.gate.decide(badSnapshotInput)
    const originalSnapshot = gateSnapshotOf(badSnapshotInput)
    appendDecision(h, badSnapshotInput, badSnapshotDecision, { ...originalSnapshot, snapshot: { ...originalSnapshot.snapshot, equity: decimal('999999') } })
    const badTargetInput = seededInput(h, 913), badTargetDecision = h.k.gate.decide(badTargetInput)
    const badTarget = structuredClone(badTargetInput.target)
    if (badTarget.kind === 'order') badTarget.intent.price = decimal('79999')
    appendDecision(h, badTargetInput, badTargetDecision, gateSnapshotOf(badTargetInput), badTarget)
    expect(h.k.risk.replay(replayId(911)).status).toBe('diff')
    expect(h.k.risk.replay(replayId(912))).toMatchObject({ status: 'diff', differences: expect.arrayContaining([expect.objectContaining({ field: 'snapshotDigest' })]) })
    expect(h.k.risk.replay(replayId(913)).status).toBe('diff')
    const versionInput = seededInput(h, 914), oldDecision = h.k.gate.decide(versionInput)
    const { attestation: _attestation, ...body } = oldDecision
    const changedBody = { ...body, gate: { ...body.gate, rulesetVersion: '0.0.9' } }
    const digest = digestOf(changedBody) as Sha256Digest
    const changedDecision = { ...changedBody, attestation: { ...oldDecision.attestation, digest, sig: h.k.installKey.sign(digest) } } as GateDecision
    appendDecision(h, versionInput, changedDecision)
    expect(h.k.risk.replay(versionInput.precheckId)).toMatchObject({ status: 'diff', recordedRulesetVersion: '0.0.9', currentRulesetVersion: '0.1.2' })
  })

  it('reports missing and corrupt historical policy documents without fallback', async () => {
    h = await makeHarness()
    const input = seededInput(h, 920), decision = h.k.gate.decide(input)
    appendDecision(h, input, decision)
    const policy = input.policy!
    h.k.docs.delete('policy', policy.policyId)
    const missingPolicy = h.k.risk.replay(input.precheckId)
    expect(missingPolicy).toMatchObject({ status: 'diff', differences: expect.arrayContaining([expect.objectContaining({ field: 'policy', reason: expect.any(String) })]) })
    expect(missingPolicy.differences.some((difference) => difference.field === 'snapshotDigest')).toBe(false)
    h.k.docs.put('policy', policy.policyId, policy, policy.version)
    const restoreInput = seededInput(h, 921), restoreDecision = h.k.gate.decide(restoreInput)
    appendDecision(h, restoreInput, restoreDecision)
    const historical = restoreInput.policy!
    h.k.docs.put('policy', historical.policyId, { ...historical, limits: { ...historical.limits, maxSlippageBps: 1 } }, historical.version)
    expect(h.k.risk.replay(restoreInput.precheckId)).toMatchObject({ status: 'diff', differences: [expect.objectContaining({ field: 'policy', reason: expect.any(String) })] })
  })

  it('finds a full gate record beyond the query page limit', async () => {
    h = await makeHarness()
    for (let index = 0; index < 1001; index++) h.k.ledger.append({ type: 'annotation', origin: h.human().origin, subject: { accountId: h.paper.accountId }, payload: { index } })
    const input = seededInput(h, 930), decision = h.k.gate.decide(input)
    appendDecision(h, input, decision)
    expect(h.k.ledger.findGate(input.precheckId)?.payload).toHaveProperty('gate')
    expect(h.k.risk.replay(input.precheckId).status).toBe('identical')
  })

  it('checks a representative signed decision and optionally measures 1000 decisions', async () => {
    h = await makeHarness()
    const input = structuredClone(source)
    input.policy = h.k.risk.current() ?? null
    input.policyIntegrity = { ...h.k.risk.integrity }
    input.now = 1000
    if (input.mark) input.mark.ts = input.now
    expect(input.mark?.ts).toBe(input.now)
    expect(input.action).toBe('open')
    expect(input.target.kind).toBe('order')
    const correctness = h.k.gate.decide(input)
    expect(correctness.decision).toBe('ALLOW')
    expect(correctness.verdict).toBe('allow')
    expect(correctness.action).toBe('open')
    expect(correctness.stages).toEqual(GATE_STAGES.filter((stage) => stage !== 'PROTECTOR:skipped'))
    expect(InstallKey.verify(h.k.installKey.publicKey, correctness.attestation.digest, correctness.attestation.sig)).toBe(true)
    if (process.env.GITRADER_GATE_BENCHMARK !== '1') return

    const warmup = 100, iterations = 1000
    for (let index = 0; index < warmup; index++) expect(h.k.gate.decide(input).decision).toBe('ALLOW')
    const durations: number[] = []
    for (let index = 0; index < iterations; index++) {
      const started = performance.now(), decision = h.k.gate.decide(input), elapsed = performance.now() - started
      expect(decision.decision).toBe('ALLOW')
      durations.push(elapsed)
    }
    durations.sort((a, b) => a - b)
    const nearest = (p: number): number => durations[Math.ceil(p * iterations) - 1]!
    console.log(`GATE_BENCHMARK ${JSON.stringify({ iterations, warmup, input: 'paper open with applicable stages; normal InstallKey signing', p50Ms: nearest(0.50), p95Ms: nearest(0.95), p99Ms: nearest(0.99), maxMs: durations.at(-1) })}`)
  })
})
