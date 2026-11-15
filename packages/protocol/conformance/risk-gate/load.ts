// SPDX-License-Identifier: Apache-2.0
import { readdirSync, readFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { GateAdjustment, GateDecision, GateInput } from '../../src/model/risk'
import type { RuleCode } from '../../src/model/problem'
import { validateBySchemaId } from '../../src/validate'

export interface GateConformanceCase {
  name: string
  input: GateInput
  expect: {
    decision: GateDecision['decision']
    verdict: GateDecision['verdict']
    codes: RuleCode[]
    applied: GateAdjustment[]
    allowedActions: GateDecision['allowedActions']
  }
}

const CASE_SCHEMA = 'urn:gitrader:schema:risk-gate:1#/$defs/ConformanceCase'

/** Load and schema-validate all standalone cases without changing their input or expectations. */
export function loadGateConformanceCases(directory?: string): GateConformanceCase[] {
  const casesDirectory = directory === undefined
    ? fileURLToPath(new URL('./cases/', import.meta.url))
    : resolve(directory)
  let files: string[]
  try {
    files = readdirSync(casesDirectory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name)
      .sort()
  } catch {
    throw new Error(`Unable to read risk-gate cases directory: ${basename(casesDirectory)}`)
  }
  if (files.length === 0) throw new Error(`No JSON risk-gate cases in directory: ${basename(casesDirectory)}`)

  const cases: GateConformanceCase[] = []
  const names = new Set<string>()
  for (const file of files) {
    let value: unknown
    try {
      value = JSON.parse(readFileSync(join(casesDirectory, file), 'utf8'))
    } catch {
      throw new Error(`Malformed JSON risk-gate case: ${basename(file)}`)
    }
    const result = validateBySchemaId(CASE_SCHEMA, value)
    if (!result.ok) {
      const paths = result.issues.map((issue) => issue.path || '/').join(', ')
      throw new Error(`Invalid risk-gate case ${basename(file)} at ${paths}`)
    }
    const item = result.value as GateConformanceCase
    if (names.has(item.name)) throw new Error(`Duplicate risk-gate case name: ${item.name}`)
    names.add(item.name)
    cases.push(item)
  }
  return cases
}
