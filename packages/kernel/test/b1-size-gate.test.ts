// SPDX-License-Identifier: CPAL-1.0
import { afterEach, describe, expect, it } from 'vitest'
import { asDecimal, type OrderIntent, type Position } from '@gitrader/protocol'
import type { GateDecision, GateInput } from '@gitrader/protocol'
import { makeHarness } from './helpers/harness'
import type { Harness } from './helpers/harness'
import { BTC } from './helpers/fake-connector'
import { newClientOrderId } from '../src/util/ids'
import { gateTargetDigest } from '../src/risk-gate/assemble'
import { digestOf } from '../src/util/hash'
import { GateTicketAuthority } from '../src/risk-gate/tickets'
import { adjustedGateTarget } from '../src/risk-gate/stages'

let h: Harness | undefined
afterEach(async () => { await h?.cleanup() })

function useQuarterStep(harness: Harness): void {
  for (const connector of [harness.sim, harness.live]) {
    connector.instrumentsList[0]!.size = { step: asDecimal('0.00025'), decimals: 5, min: asDecimal('0.00025') }
  }
}

function intent(accountId: string, size: string, extra: Partial<OrderIntent> = {}): OrderIntent {
  return { accountId: accountId as never, instrumentId: BTC as never, side: 'buy', type: 'limit', size: asDecimal(size), price: asDecimal('80000'), tif: 'gtc', clientOrderId: newClientOrderId(), ...extra }
}

function enableSizeLimit(harness: Harness): void {
  const current = harness.k.risk.current()!
  const { attestation: _attestation, ...body } = current
  const next = { ...body, limits: { ...current.limits, maxOrderNotional: asDecimal('80') }, limitMode: { size: true } }
  const digest = digestOf(next)
  harness.k.docs.put('policy', current.policyId, { ...next, attestation: { ...current.attestation, digest, sig: harness.k.installKey.sign(digest) } }, current.version)
}

describe('B1-R1 order size precision', () => {
  it('rounds through public TradingService and preserves ledger and replay evidence', async () => {
    h = await makeHarness()
    useQuarterStep(h)

    const result = await h.k.trading.place({ intent: intent(h.paper.accountId, '0.001374') }, h.human())

    expect(result.order?.status).toBe('open')
    expect(h.sim.submitted).toHaveLength(1)
    expect(h.sim.submitted[0]!.intent.size).toBe('0.00125')
    expect(h.sim.submitted[0]!.ctx.gate?.ticketId).toBeTruthy()
    const order = h.k.ledger.query({ types: ['order.intent'] }).at(-1)!
    expect((order.payload as { intent: { size: string } }).intent.size).toBe('0.00125')
    const gate = (order.payload as { gate: { decision: { decision: string; targetDigest: string; adjustedTargetDigest: string; applied: unknown[]; ruleHits: Array<{ code: string; action: string }> }; target: GateInput['target'] } }).gate
    expect(gate.decision.decision).toBe('LIMIT')
    expect(gate.decision.applied).toEqual([expect.objectContaining({ code: 'SIZE_PRECISION', from: '0.001374', to: '0.00125' })])
    expect((gate.target as Extract<GateInput['target'], { kind: 'order' }>).intent.size).toBe('0.001374')
    expect(gate.decision.targetDigest).toBe(gateTargetDigest(gate.target))
    expect(gate.decision.ruleHits).toContainEqual(expect.objectContaining({ code: 'SIZE_PRECISION', action: 'limit' }))
    // fix-r4 C13：取整命中带人话说明
    expect(gate.decision.ruleHits).toContainEqual(expect.objectContaining({ code: 'SIZE_PRECISION', message: 'size rounded to instrument step: 0.001374 -> 0.00125' }))
    expect(gateTargetDigest({ kind: 'order', intent: h.sim.submitted[0]!.intent as never })).toBe(gate.decision.adjustedTargetDigest)
    const precheckId = h.sim.submitted[0]!.ctx.gate!.precheckId
    expect(precheckId).toBeTruthy()
    expect(h.k.risk.replay(precheckId!).status).toBe('identical')
  })

  it('denies a size that rounds to zero without calling the connector', async () => {
    h = await makeHarness()
    useQuarterStep(h)

    const result = await h.k.trading.place({ intent: intent(h.paper.accountId, '0.00024') }, h.human())

    expect(result.order?.status).toBe('denied')
    expect(h.sim.submitted).toHaveLength(0)
    expect(result.order?.problem?.ruleHits).toContainEqual(expect.objectContaining({ code: 'SIZE_PRECISION' }))
  })

  it('retains notional conversion precision until the gate rounds it', async () => {
    h = await makeHarness()
    useQuarterStep(h)
    const raw = { ...intent(h.paper.accountId, '0'), size: undefined, notional: asDecimal('110') }

    await h.k.trading.place({ intent: raw }, h.human())

    expect(h.sim.submitted[0]!.intent.size).toBe('0.00125')
    const order = h.k.ledger.query({ types: ['order.intent'] }).at(-1)!
    const gate = (order.payload as { gate: { decision: { applied: Array<{ from: string; to: string }> } } }).gate
    expect(gate.decision.applied[0]).toMatchObject({ from: '0.001375', to: '0.00125' })
  })

  it('rounds a reduce-only order through the same CONST gate', async () => {
    h = await makeHarness()
    useQuarterStep(h)
    const position: Position = {
      accountId: h.paper.accountId as never, instrumentId: BTC as never, side: 'long', size: asDecimal('0.01'),
      entryPrice: asDecimal('80000'), markPrice: asDecimal('80000'), notional: asDecimal('800'), unrealizedPnl: asDecimal('0'), realizedPnl: asDecimal('0'),
      leverage: 1, marginMode: 'cross', liquidationPrice: null, fundingSinceOpen: asDecimal('0'), openedAt: 0, updatedAt: 0,
    }
    h.sim.positions.set(h.paper.accountId, [position])

    await h.k.trading.place({ intent: intent(h.paper.accountId, '0.001374', { side: 'sell', reduceOnly: true }) }, h.human())

    expect(h.sim.submitted[0]!.intent.size).toBe('0.00125')
    expect(h.sim.submitted[0]!.intent.reduceOnly).toBe(true)
  })

  it('keeps an exact step unchanged and applies no adjustment', async () => {
    h = await makeHarness()
    useQuarterStep(h)

    await h.k.trading.place({ intent: intent(h.paper.accountId, '0.00125') }, h.human())

    expect(h.sim.submitted[0]!.intent.size).toBe('0.00125')
    const order = h.k.ledger.query({ types: ['order.intent'] }).at(-1)!
    const gate = (order.payload as { gate: { decision: { decision: string; applied: unknown[] } } }).gate
    expect(gate.decision.decision).toBe('ALLOW')
    expect(gate.decision.applied).toEqual([])
  })

  it('rejects a forged assembly adjustment when recomputation differs', async () => {
    h = await makeHarness()
    useQuarterStep(h)
    let captured: GateInput | undefined
    const decide = h.k.gate.decide.bind(h.k.gate)
    h.k.gate.decide = ((input: GateInput) => { captured = structuredClone(input); return decide(input) }) as typeof h.k.gate.decide
    await h.k.trading.preview(intent(h.paper.accountId, '0.001374'), h.human())
    expect(captured).toBeDefined()

    const forged = structuredClone(captured!)
    forged.assemblyAdjustments = [{ ruleId: `${BTC}#sizePrecision`, code: 'SIZE_PRECISION', field: 'size', from: '0.001374' as never, to: '0.0015' as never, unit: 'BTC' }]
    const decision = decide(forged)

    expect(decision.decision).toBe('BLOCK')
    expect(decision.verdict).toBe('deny')
    expect(decision.applied).toEqual([])
  })

  it('retains the precision limit hit after a second risk-cap adjustment', async () => {
    h = await makeHarness()
    useQuarterStep(h)
    enableSizeLimit(h)

    await h.k.trading.place({ intent: intent(h.paper.accountId, '0.001374', { allowAdjust: ['size'] }) }, h.human())

    expect(h.sim.submitted[0]!.intent.size).toBe('0.001')
    const order = h.k.ledger.query({ types: ['order.intent'] }).at(-1)!
    const gate = (order.payload as { gate: { target: GateInput['target']; decision: GateDecision } }).gate
    expect(gate.decision.decision).toBe('LIMIT')
    expect(gate.decision.applied).toEqual([
      expect.objectContaining({ code: 'SIZE_PRECISION', from: '0.001374', to: '0.00125' }),
      expect.objectContaining({ code: 'ORDER_NOTIONAL', from: '0.00125', to: '0.001' }),
    ])
    expect(gate.decision.stages).toContain('CONST')
    expect(gate.decision.ruleHits).toContainEqual(expect.objectContaining({ code: 'SIZE_PRECISION', action: 'limit', actual: '0.001374', limit: '0.00125' }))
    expect(gate.decision.ruleHits).toContainEqual(expect.objectContaining({ code: 'ORDER_NOTIONAL', action: 'limit' }))
    expect(gate.decision.targetDigest).toBe(gateTargetDigest(gate.target))
    expect(gate.decision.adjustedTargetDigest).toBe(gateTargetDigest({ kind: 'order', intent: h.sim.submitted[0]!.intent as never }))
    const precheckId = h.sim.submitted[0]!.ctx.gate!.precheckId!
    expect(h.k.risk.replay(precheckId).status).toBe('identical')
  })

  it('blocks a forged adjustment before optional size limiting and refuses a ticket', async () => {
    h = await makeHarness()
    useQuarterStep(h)
    enableSizeLimit(h)
    let captured: GateInput | undefined
    const decide = h.k.gate.decide.bind(h.k.gate)
    h.k.gate.decide = ((input: GateInput) => { captured = structuredClone(input); return decide(input) }) as typeof h.k.gate.decide
    await h.k.trading.preview(intent(h.paper.accountId, '0.001374', { allowAdjust: ['size'] }), h.human())
    expect(captured).toBeDefined()

    const forged = structuredClone(captured!)
    forged.assemblyAdjustments = [{ ...forged.assemblyAdjustments![0]!, to: asDecimal('0.0015') }]
    const decision = decide(forged)

    expect(decision.decision).toBe('BLOCK')
    expect(decision.verdict).toBe('deny')
    expect(decision.applied).toEqual([])
    expect(decision.adjustedTargetDigest).toBe(decision.targetDigest)
    const authority = new GateTicketAuthority(h.k.installKey, h.clock)
    expect(() => authority.issue(forged, decision, adjustedGateTarget(forged.target, decision.applied))).toThrow()
  })
})
