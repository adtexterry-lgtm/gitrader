// SPDX-License-Identifier: CPAL-1.0
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { loadGateConformanceCases } from '../../protocol/conformance/risk-gate/load'
import { asDecimal, type GateInput } from '@gitrader/protocol'
import { InstallKey } from '../src/install-key'
import { RiskGate, type RiskService } from '../src/risk'
import { normalizeRiskTarget } from '../src/normalize'
import type { TradingStateService } from '../src/trading-state'

const home = mkdtempSync(join(tmpdir(), 'gitrader-k1-'))
afterAll(() => {
  const tempRoot = resolve(tmpdir()) + sep
  const createdHome = resolve(home)
  if (createdHome.startsWith(tempRoot)) rmSync(createdHome, { recursive: true, force: true })
})
const key = InstallKey.loadOrCreate(join(home, 'risk-gate-exposure-test-key.json'), 1_000_000)
const gate = new RiskGate({ signGateDigest: (digest: string) => key.sign(digest) } as unknown as RiskService, {} as TradingStateService)
const fixture = () => structuredClone(loadGateConformanceCases().find((item) => item.name === '17-limit-size')!.input) as GateInput
const decimal = (value: string) => asDecimal(value)

function heldPosition(input: GateInput): void {
  input.snapshot.equity = decimal('10000')
  input.snapshot.available = decimal('10000')
  input.snapshot.positions = [{ instrumentId: 'fixture:ASSET', side: 'long', size: decimal('3'), notional: decimal('300'), leverage: 2 }]
  input.snapshot.openOrders = []
  input.policy!.limits.maxOrderNotional = decimal('1000')
  input.mandate!.limits.maxOrderNotional = decimal('1000')
  const intent = (input.target as Extract<GateInput['target'], { kind: 'order' }>).intent
  intent.side = 'sell'
  intent.size = decimal('2')
  intent.price = decimal('100')
  intent.reduceOnly = false
}

describe('risk gate gross exposure and margin', () => {
  it('does not infer a reduction when concurrent close size consumes the position', () => {
    const input = fixture()
    heldPosition(input)
    const target = (input.target as Extract<GateInput['target'], { kind: 'order' }>).intent
    const normalized = normalizeRiskTarget(target, input.snapshot.positions, decimal('2'))
    expect(normalized.action).toBe('open')
    expect(normalized.intent.reduceOnly).not.toBe(true)
  })

  it('applies a position cap to gross reverse-open notional while explicit reduction bypasses it', () => {
    const input = fixture()
    heldPosition(input)
    input.policy!.limits.maxPositionNotionalRatio = decimal('0.04')
    delete (input.target as Extract<GateInput['target'], { kind: 'order' }>).intent.allowAdjust
    const ordinary = gate.decide(input)
    expect(ordinary.decision).toBe('BLOCK')
    expect(ordinary.ruleHits).toContainEqual(expect.objectContaining({ code: 'POSITION_NOTIONAL', actual: '0.05' }))

    const reduction = structuredClone(input)
    reduction.action = 'reduce'
    ;(reduction.target as Extract<GateInput['target'], { kind: 'order' }>).intent.reduceOnly = true
    expect(gate.decide(reduction).decision).toBe('ALLOW')
  })

  it('limits a reverse open by gross position exposure and never limits a true flip', () => {
    const input = fixture()
    heldPosition(input)
    input.policy!.limits.maxPositionNotionalRatio = decimal('0.04')
    ;(input.target as Extract<GateInput['target'], { kind: 'order' }>).intent.allowAdjust = ['size']
    const limited = gate.decide(input)
    expect(limited.decision).toBe('LIMIT')
    expect(limited.applied).toContainEqual(expect.objectContaining({ code: 'POSITION_NOTIONAL', from: '2', to: '1' }))

    const flip = structuredClone(input)
    ;(flip.target as Extract<GateInput['target'], { kind: 'order' }>).intent.size = decimal('4')
    const deniedFlip = gate.decide(flip)
    expect(deniedFlip.decision).toBe('BLOCK')
    expect(deniedFlip.applied).toEqual([])
  })

  it('charges reverse open margin against the entire new order', () => {
    const input = fixture()
    heldPosition(input)
    input.snapshot.available = decimal('50')
    delete input.policy!.limits.maxPositionNotionalRatio
    delete input.policy!.limits.maxTotalNotionalRatio
    delete (input.target as Extract<GateInput['target'], { kind: 'order' }>).intent.allowAdjust
    const decision = gate.decide(input)
    expect(decision.decision).toBe('BLOCK')
    expect(decision.ruleHits).toContainEqual(expect.objectContaining({ code: 'INSUFFICIENT_MARGIN', actual: '100' }))
  })

  it('compares buying power at full precision and reports division rounded toward zero to 18 places', () => {
    const input = fixture()
    input.snapshot.positions = []
    input.snapshot.available = decimal('0.333333333333333333')
    const intent = (input.target as Extract<GateInput['target'], { kind: 'order' }>).intent
    intent.size = decimal('1')
    intent.price = decimal('1')
    intent.leverage = 3
    intent.allowAdjust = []
    input.instrument!.contractSize = decimal('1')
    input.mark = { price: decimal('1'), ts: input.now, source: 'venue_mark' }
    input.policy!.limits.maxOrderNotional = decimal('1000')
    input.mandate!.limits.maxOrderNotional = decimal('1000')
    delete input.policy!.limits.maxPositionNotionalRatio
    const decision = gate.decide(input)
    expect(decision.decision).toBe('BLOCK')
    expect(decision.ruleHits).toContainEqual(expect.objectContaining({ code: 'INSUFFICIENT_MARGIN' }))
    expect(decision.estimates.marginRequired).toBe('0.333333333333333333')
  })
})
