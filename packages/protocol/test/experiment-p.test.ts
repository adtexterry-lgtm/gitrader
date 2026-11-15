// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest'
import { loadExperimentCases, loadForwardCases } from '../conformance/experiment/load'
import { PROBLEM_CODES } from '../src/model/problem'
import { modelId, validateBySchemaId } from '../src/validate'
import { sample } from './helpers'
import { candlesDigest, checkTransition, computeForwardStats, isAppendOnlyViolation, isReadonlyPatch } from '../src/experiment'

const valid = (name: string, value: unknown) => validateBySchemaId(modelId(name), value).ok

describe('Experiment P2 schema and conformance fixtures', () => {
  it('loads the complete transition/kernel and forward fixture sets through their schemas', () => {
    const cases = loadExperimentCases()
    const forward = loadForwardCases()
    expect(cases).toHaveLength(47)
    expect(cases.map(({ id }) => id)).toEqual([
      '01-hypothesis-backtest', '02-backtest-missing-assumptions', '03-null-subject-direct-shadow',
      '04-llm-unknown-direct-shadow', '05-hash-nonllm-direct-shadow', '06-backtest-holdout-complete-pair',
      '07-old-stage-backtest-pack', '08-contaminated-llm-backtest-shadow', '09-current-holdout-shadow',
      '10-shadow-live-small-ready', '11-shadow-live-small-mcp', '12-shadow-live-small-provisional',
      '13-review-return-shadow', '14-review-overlevel-live-small', '15-closed-to-review',
      '16-live-small-downgrade-shadow', '17-live-small-to-live-r12', '18-draft-alias-backtest',
      '19-readonly-roots-and-nested-llm', '20-append-only-prefix', '21-frozen-fields', '22-trial-count',
      '23-holdout-window-overlap', '24-llm-attribution', '25-holdout-shadow-missing-paper-run',
      '26-nonllm-backtest-shadow', '27-live-to-retired', '28-shadow-to-closed',
      '29-live-to-retired-foreign-owner', '30-closed-to-closed', '31-old-forward-after-downgrade',
      '32-hypothesis-to-review', '33-lifecycle-export',
      '34-retired-bypass', '35-review-retired-bypass', '36-retired-reopen', '37-review-retire',
      '38-update-runs', '39-pack-self-report', '40-pack-reference', '41-engine-pack-draft',
      '42-llm-current-clean-pair', '43-llm-old-pollution-shadow', '44-candles-per-instrument',
      '45-holdout-before-lab-pack', '46-holdout-before-lab-entry', '47-closed-to-retired',
    ])
    expect(new Set(cases.map(({ id }) => id)).size).toBe(cases.length)
    expect(forward).toHaveLength(5)
    expect(new Set(forward.map(({ id }) => id)).size).toBe(forward.length)
  })

  it('accepts legacy and complete new schemas while enforcing the registered boundaries', () => {
    const cases = loadExperimentCases()
    const transition = cases.find((item) => item.id === '06-backtest-holdout-complete-pair')!
    if (transition.kind !== 'transition') throw new Error('fixture kind mismatch')
    const experiment = transition.input.experiment
    const pack = transition.input.evidence.packs[0]
    const draft = structuredClone(pack) as unknown as Record<string, unknown>
    for (const key of ['attestation', 'trialCount', 'trialStats', 'provenance', 'at', 'packId', 'experimentId', 'runId']) delete draft[key]
    const forwardStats = {
      tier: 'forward_paper', runIds: [], accountIds: [], window: { from: 0, to: 86_400_000 },
      ledgerRange: { fromSeq: 0, toSeq: 0 },
      sample: { trades: 0, fills: 0, roundTrips: 0, spanDays: 1, activeDays: 0, snapshotDays: 1 },
      valuationCcy: 'USD', realizedPnl: '0', unrealizedPnlEnd: '0', fees: '0', funding: '0',
      returnRatio: 0, maxDrawdownRatio: 0, sharpe: null, sortino: null, winRatio: null,
      periodsPerYear: 365, includesUnrealized: true, provisional: false, computedAt: 86_400_000,
      computedBy: 'kernel', digest: `sha256:${'a'.repeat(64)}`,
    }
    const labRun = transition.input.evidence.labRuns[0]
    expect(valid('Experiment', sample('Experiment'))).toBe(true)
    expect(valid('Experiment', { ...experiment, forward: forwardStats })).toBe(true)
    expect(valid('BacktestEvidencePack', pack)).toBe(true)
    expect(valid('EvidencePackDraft', draft)).toBe(true)
    expect(valid('ForwardStats', forwardStats)).toBe(true)
    expect(valid('LabRun', labRun)).toBe(true)

    const incompletePack = structuredClone(pack) as unknown as Record<string, unknown>
    delete incompletePack.runId
    expect(valid('BacktestEvidencePack', incompletePack)).toBe(false)
    expect(valid('ForwardStats', { ...forwardStats, realizedPnl: 1 })).toBe(false)
    const forwardPack: Record<string, unknown> = { ...(pack as unknown as Record<string, unknown>), kind: 'forward', tier: 'forward_paper', forward: forwardStats }
    for (const key of ['spec', 'specDigest', 'assumptions', 'seed', 'data', 'instrumentMeta', 'stats', 'biasChecks', 'partitions', 'artifacts', 'returnsArtifact', 'llm']) delete forwardPack[key]
    expect(valid('ForwardEvidencePack', forwardPack)).toBe(true)
    expect(valid('ForwardEvidencePack', { ...forwardPack, forward: { ...forwardStats, tier: 'forward_live' } })).toBe(false)

    const id = experiment.experimentId
    const tool = (value: unknown) => valid('ExperimentToolInput', value)
    expect(tool({ action: 'attach', experimentId: id, attach: { run: { accountId: 'acct_abc' } } })).toBe(false)
    expect(tool({ action: 'attach', experimentId: id, attach: { run: {
      accountId: 'acct_abc', executor: { kind: 'engine', engineId: 'engine', instanceId: 'inst_abc', codeDigest: null },
    } } })).toBe(true)
    expect(tool({ action: 'update', experimentId: id, patch: { stage: 'live' } })).toBe(false)
    expect(tool({ action: 'update', experimentId: id, patch: { metrics: {} } })).toBe(false)
    expect(tool({ action: 'update', experimentId: id, patch: { 'llm.involved': false } })).toBe(false)
    expect(tool({ action: 'update', experimentId: id, patch: { "['stage']": 'live' } })).toBe(false)
    expect(tool({ action: 'update', experimentId: id, patch: { llm: { involved: false } } })).toBe(false)
    expect(tool({ action: 'update', experimentId: id, patch: { llm: { involved: true } } })).toBe(true)
    expect(tool({ action: 'create', patch: { title: 'Example', hypothesis: 'Example', stage: 'live' } })).toBe(true)
    expect(tool({ action: 'create', patch: { title: 'Example', hypothesis: 'Example' } })).toBe(true)
    expect(tool({ action: 'create', patch: { title: 'Example', hypothesis: 'Example', params: { version: 1 }, 'x-note': 'sample' } })).toBe(true)
    expect(tool({ action: 'stage', experimentId: id })).toBe(false)

    const experimentCodes = Object.values(PROBLEM_CODES).filter((info) => info.name.startsWith('EXPERIMENT_'))
    expect(experimentCodes).toHaveLength(6)
    for (const info of experimentCodes) {
      const problem = { code: info.code, name: info.name, category: info.category, message: 'fixture', retryable: info.retryable }
      expect(valid('Problem', problem)).toBe(true)
      expect(valid('Problem', { ...problem, name: `${info.name}_WRONG` })).toBe(false)
      expect(valid('Problem', { ...problem, category: 'PROTOCOL' })).toBe(false)
      expect(valid('Problem', { ...problem, retryable: !info.retryable })).toBe(false)
    }
    expect(valid('Problem', { code: 999999, name: 'LEGACY_UNKNOWN', category: 'PROTOCOL', message: 'fixture', retryable: false })).toBe(true)
  })

  for (const fixture of loadExperimentCases()) {
    // Kernel contracts require the later kernel implementation, not a protocol-side imitation.
    if (fixture.kind === 'kernel-contract') continue
    it(`executes ${fixture.id}`, async () => {
      switch (fixture.kind) {
        case 'transition': {
          const { experiment, evidence, now, to } = structuredClone(fixture.input)
          const steps = [{ to, now, expect: fixture.expect }, ...(fixture.then ?? [])]
          for (const step of steps) {
            const actual = checkTransition(experiment, step.to, evidence, step.now)
            expect(actual, `${fixture.id}: ${experiment.stage} -> ${step.to}`).toEqual(step.expect)
            if (actual.ok) {
              if (step.to === 'review') experiment.reviewFrom = experiment.stage
              experiment.stage = step.to
              experiment.stageEnteredAt = step.now
            }
          }
          break
        }
        case 'readonly':
          expect(isReadonlyPatch(fixture.input.patch)).toEqual(fixture.expect.paths)
          break
        case 'append-only':
          expect(isAppendOnlyViolation(fixture.input.current, fixture.input.next)).toEqual(fixture.expect.paths)
          break
        case 'schema':
          expect(valid(fixture.input.schema, fixture.input.value)).toBe(fixture.expect.ok)
          if (fixture.expect.readonlyPaths) {
            expect(isReadonlyPatch((fixture.input.value as { patch: unknown }).patch)).toEqual(fixture.expect.readonlyPaths)
          }
          break
        case 'candles-digest':
          for (const stream of fixture.streams) {
            for (const candles of [stream.candles, ...stream.variants]) {
              expect(await candlesDigest(candles), stream.instrumentId).toBe(stream.digest)
            }
          }
          break
        default: {
          const unexpected: never = fixture
          throw new Error(`Unhandled fixture: ${JSON.stringify(unexpected)}`)
        }
      }
    })
  }

  for (const fixture of loadForwardCases()) {
    it(`computes forward/${fixture.id}`, async () => {
      const actual = await computeForwardStats(fixture.input)
      expect(actual.sample).toEqual(fixture.expect.sample)
      for (const key of ['realizedPnl', 'unrealizedPnlEnd', 'fees', 'funding'] as const) {
        expect(actual[key], key).toBe(fixture.expect[key])
      }
      for (const key of ['returnRatio', 'maxDrawdownRatio', 'sharpe', 'sortino', 'winRatio'] as const) {
        const expected = fixture.expect[key]
        const value = actual[key]
        if (expected === null) expect(value, key).toBeNull()
        else {
          expect(value, key).not.toBeNull()
          expect(Math.abs((value as number) - expected), key).toBeLessThanOrEqual(fixture.tolerance)
        }
      }
    })
  }
})
