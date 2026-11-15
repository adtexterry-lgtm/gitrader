// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { loadGateConformanceCases } from '../conformance/risk-gate/load'
import { PROBLEM_CODES, RULE_CODES, RULE_PROBLEM_DEFAULTS } from '../src/model/problem'
import { validateBySchemaId } from '../src/validate'

const gateInputSchemaRef = 'urn:gitrader:schema:risk-gate:1#/$defs/GateInput'
const riskGateSchema = JSON.parse(readFileSync(new URL('../schemas/risk-gate.json', import.meta.url), 'utf8')) as {
  $defs?: { GateInput?: { properties?: Record<string, { type?: string; items?: { $ref?: string } }> } }
}

describe('B1 protocol additions', () => {
  it('appends the three B1 rule codes', () => {
    // fix-r1：之后的追加（TPSL_INVALID / STOP_REQUIRED）排在后面；B1 三码仍须相邻、按序、只出现一次
    const at = RULE_CODES.indexOf('SIZE_PRECISION')
    expect(RULE_CODES.slice(at, at + 3)).toEqual(['SIZE_PRECISION', 'REDUCE_ONLY_MISMATCH', 'INTENT_EXPIRED'])
    expect(RULE_CODES.filter((c) => c === 'SIZE_PRECISION' || c === 'REDUCE_ONLY_MISMATCH' || c === 'INTENT_EXPIRED')).toHaveLength(3)
    expect(RULE_CODES.indexOf('MANDATE_INCOMPLETE')).toBe(at - 1)
  })

  it('maps each B1 rule code to its existing default problem', () => {
    expect(RULE_PROBLEM_DEFAULTS.SIZE_PRECISION).toBe('PRECISION')
    expect(RULE_PROBLEM_DEFAULTS.REDUCE_ONLY_MISMATCH).toBe('NEEDS_APPROVAL')
    expect(RULE_PROBLEM_DEFAULTS.INTENT_EXPIRED).toBe('GATE_TICKET_EXPIRED')
    expect(PROBLEM_CODES.PRECISION.code).toBe(1002)
    expect(PROBLEM_CODES.NEEDS_APPROVAL.code).toBe(2009)
    expect(PROBLEM_CODES.GATE_TICKET_EXPIRED.code).toBe(2011)
  })

  it('accepts assembly adjustments while preserving the legacy GateInput shape', () => {
    const input = loadGateConformanceCases()[0]!.input
    const assemblyAdjustments = [{
      ruleId: 'size-precision', code: 'SIZE_PRECISION', field: 'size',
      from: '2', to: '1', unit: 'lot',
    }]
    const adjustmentProperty = riskGateSchema.$defs?.GateInput?.properties?.assemblyAdjustments

    expect(adjustmentProperty).toEqual({ type: 'array', items: { $ref: '#/$defs/GateAdjustment' } })
    expect(validateBySchemaId(gateInputSchemaRef, input).ok).toBe(true)
    expect(validateBySchemaId(gateInputSchemaRef, { ...input, assemblyAdjustments }).ok).toBe(true)
  })
})
