// SPDX-License-Identifier: CPAL-1.0
import { describe, expect, it } from 'vitest'
import {
  candlesDigest, checkTransition, computeForwardStats, isAppendOnlyViolation, isReadonlyPatch, validateBySchemaId,
} from '../src/proto'
import { loadExperimentCases, loadForwardCases } from '../../protocol/conformance/experiment/load'

describe('experiment protocol fixtures used by the kernel lab', () => {
  it('executes pure experiment fixtures without treating kernel-contract cases as results', async () => {
    const cases = loadExperimentCases().filter((fixture) => fixture.kind !== 'kernel-contract')
    for (const fixture of cases) {
      switch (fixture.kind) {
        case 'transition': {
          const { experiment, evidence, now, to } = structuredClone(fixture.input)
          for (const step of [{ to, now, expect: fixture.expect }, ...(fixture.then ?? [])]) {
            const actual = checkTransition(experiment, step.to, evidence, step.now)
            expect(actual, fixture.id).toEqual(step.expect)
            if (actual.ok) {
              if (step.to === 'review' && experiment.stage !== 'review') experiment.reviewFrom = experiment.stage
              experiment.stage = step.to
              experiment.stageEnteredAt = step.now
            }
          }
          break
        }
        case 'readonly': expect(isReadonlyPatch(fixture.input.patch), fixture.id).toEqual(fixture.expect.paths); break
        case 'append-only': expect(isAppendOnlyViolation(fixture.input.current, fixture.input.next), fixture.id).toEqual(fixture.expect.paths); break
        case 'schema': {
          expect(validateBySchemaId(`urn:gitrader:schema:model:0.1:${fixture.input.schema}`, fixture.input.value).ok, fixture.id).toBe(fixture.expect.ok)
          if (fixture.expect.readonlyPaths) expect(isReadonlyPatch((fixture.input.value as { patch: unknown }).patch), fixture.id).toEqual(fixture.expect.readonlyPaths)
          break
        }
        case 'candles-digest':
          for (const stream of fixture.streams) for (const candles of [stream.candles, ...stream.variants]) {
            expect(await candlesDigest(candles), `${fixture.id}:${stream.instrumentId}`).toBe(stream.digest)
          }
          break
        default: {
          const unexpected: never = fixture
          throw new Error(`Unexpected pure fixture kind: ${String(unexpected)}`)
        }
      }
    }
  })

  it('recomputes every hand-calculated forward statistics fixture', async () => {
    for (const fixture of loadForwardCases()) {
      const actual = await computeForwardStats(fixture.input)
      expect(actual.sample, fixture.id).toEqual(fixture.expect.sample)
      for (const key of ['realizedPnl', 'unrealizedPnlEnd', 'fees', 'funding'] as const) expect(actual[key], `${fixture.id}:${key}`).toBe(fixture.expect[key])
      for (const key of ['returnRatio', 'maxDrawdownRatio', 'sharpe', 'sortino', 'winRatio'] as const) {
        const expected = fixture.expect[key]
        const value = actual[key]
        if (expected === null) expect(value, `${fixture.id}:${key}`).toBeNull()
        else {
          expect(value, `${fixture.id}:${key}`).not.toBeNull()
          expect(Math.abs((value as number) - expected), `${fixture.id}:${key}`).toBeLessThanOrEqual(fixture.tolerance)
        }
      }
    }
  })
})
