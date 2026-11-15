// SPDX-License-Identifier: Apache-2.0
import { readdirSync, readFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Decimal, Ms } from '../../src/model/decimal'
import type { Experiment, ExperimentStage } from '../../src/model/signal'
import type { Candle } from '../../src/model/instrument'
import type { InstrumentId, Sha256Digest } from '../../src/model/ids'
import type {
  ExperimentTransitionEvidence,
  ForwardStats,
  ForwardStatsInput,
} from '../../src/model/experiment'
import { validateBySchemaId } from '../../src/validate'

export type ExperimentConformanceCase =
  | {
      id: string
      kind: 'transition'
      input: { experiment: Experiment; to: ExperimentStage; evidence: ExperimentTransitionEvidence; now: Ms }
      expect: { ok: boolean; missing: string[] }
      then?: { to: ExperimentStage; now: Ms; expect: { ok: boolean; missing: string[] } }[]
    }
  | { id: string; kind: 'readonly'; input: { patch: object }; expect: { paths: string[] } }
  | { id: string; kind: 'append-only'; input: { current: Experiment; next: Experiment }; expect: { paths: string[] } }
  | { id: string; kind: 'schema'; input: { schema: string; value: unknown }; expect: { ok: boolean; readonlyPaths?: string[] } }
  | { id: string; kind: 'candles-digest'; streams: { instrumentId: InstrumentId; candles: Candle[]; variants: Candle[][]; digest: Sha256Digest }[] }
  | {
      id: string
      kind: 'kernel-contract'
      rule: 'frozen' | 'trial-count' | 'holdout' | 'llm-attribution' | 'lifecycle'
      steps: { operation: string; given: Record<string, unknown>; expect: Record<string, unknown> }[]
    }

export interface ForwardConformanceCase {
  id: string
  input: ForwardStatsInput
  expect: {
    sample: ForwardStats['sample']
    realizedPnl: Decimal
    unrealizedPnlEnd: Decimal
    fees: Decimal
    funding: Decimal
    returnRatio: number
    maxDrawdownRatio: number
    sharpe: number | null
    sortino: number | null
    winRatio: number | null
  }
  tolerance: number
}

function readCases<T>(directory: string | undefined, kind: 'experiment' | 'forward', schemaName: string): T[] {
  const casesDirectory = directory === undefined
    ? fileURLToPath(new URL(kind === 'forward' ? './forward/' : './cases/', import.meta.url))
    : resolve(directory)
  let files: string[]
  try {
    files = readdirSync(casesDirectory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name)
      .sort()
  } catch {
    throw new Error(`Unable to read ${kind} cases directory: ${basename(casesDirectory)}`)
  }
  if (files.length === 0) throw new Error(`No JSON ${kind} cases in directory: ${basename(casesDirectory)}`)

  const cases: T[] = []
  const ids = new Set<string>()
  for (const file of files) {
    let value: unknown
    try {
      value = JSON.parse(readFileSync(join(casesDirectory, file), 'utf8'))
    } catch {
      throw new Error(`Malformed JSON ${kind} case: ${basename(file)}`)
    }
    const result = validateBySchemaId(`urn:gitrader:schema:model:0.1:${schemaName}`, value)
    if (!result.ok) {
      const paths = result.issues.map((issue) => issue.path || '/').join(', ')
      throw new Error(`Invalid ${kind} case ${basename(file)} at ${paths}`)
    }
    const item = result.value as T & { id: string }
    if (ids.has(item.id)) throw new Error(`Duplicate ${kind} case id in: ${basename(file)}`)
    ids.add(item.id)
    cases.push(item)
  }
  return cases
}

/** Load standalone transition, readonly, append-only and future-kernel contract cases. */
export function loadExperimentCases(directory?: string): ExperimentConformanceCase[] {
  return readCases<ExperimentConformanceCase>(directory, 'experiment', 'ExperimentConformanceCase')
}

/** Load forward-statistics inputs and hand-calculated expectations without executing the helper. */
export function loadForwardCases(directory?: string): ForwardConformanceCase[] {
  return readCases<ForwardConformanceCase>(directory, 'forward', 'ForwardConformanceCase')
}
