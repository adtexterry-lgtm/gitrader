// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest'
import { loadGateConformanceCases } from '../conformance/risk-gate/load'
import { validateBySchemaId } from '../src/validate'

const inputSchema = 'urn:gitrader:schema:risk-gate:1#/$defs/GateInput'
const snapshotSchema = 'urn:gitrader:schema:risk-gate:1#/$defs/GateSnapshot'

describe('cancel price witnesses', () => {
  it('accepts the optional per-instrument field and preserves it in GateSnapshot', () => {
    const base = structuredClone(loadGateConformanceCases().find((item) => item.name === '03-cancel-system')!.input)
    const checks = [
      { instrumentId: 'hyperliquid:BTC', quote: 'USDC', mark: { price: '80000', ts: base.now, source: 'venue_mark' } },
      { instrumentId: 'hyperliquid:ETH' },
    ]
    const input = { ...base, cancelPriceChecks: checks }
    expect(validateBySchemaId(inputSchema, input).ok).toBe(true)
    expect(validateBySchemaId(inputSchema, base).ok).toBe(true)
    const snapshot = { ...input, policy: null } as Record<string, unknown>
    delete snapshot.target
    expect(validateBySchemaId(snapshotSchema, snapshot).ok).toBe(true)
  })

  it('rejects malformed optional mark witnesses', () => {
    const base = structuredClone(loadGateConformanceCases().find((item) => item.name === '03-cancel-system')!.input)
    expect(validateBySchemaId(inputSchema, { ...base, cancelPriceChecks: [{ instrumentId: 'hyperliquid:BTC', mark: { price: '80000', ts: base.now, source: 'last' } }] }).ok).toBe(false)
    expect(validateBySchemaId(inputSchema, { ...base, cancelPriceChecks: [{ instrumentId: 'hyperliquid:BTC', mark: { price: '80000', source: 'venue_mark' } }] }).ok).toBe(false)
  })
})
