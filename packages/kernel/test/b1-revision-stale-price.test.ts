// SPDX-License-Identifier: CPAL-1.0
import { afterEach, describe, expect, it } from 'vitest'
import { asDecimal } from '@gitrader/protocol'
import type { GateDecision, OrderIntent, Position } from '../src/proto'
import { BTC } from './helpers/fake-connector'
import { makeAgent, makeHarness } from './helpers/harness'
import type { Harness } from './helpers/harness'
import { newClientOrderId } from '../src/util/ids'
import { mkOrigin } from '../src/util/origin'

let h: Harness | undefined
afterEach(async () => { await h?.cleanup(); h = undefined })

function intent(accountId: string, extra: Partial<OrderIntent> = {}): OrderIntent {
  return { accountId: accountId as never, instrumentId: BTC, side: 'sell', type: 'market', size: asDecimal('0.01'), reduceOnly: true, clientOrderId: newClientOrderId(), reason: 'X2K regression fixture', ...extra }
}

function longPosition(accountId: string, size = '0.01'): Position {
  return { accountId: accountId as never, instrumentId: BTC, side: 'long', size: asDecimal(size), entryPrice: asDecimal('80000'), markPrice: asDecimal('80000'), notional: asDecimal(String(Number(size) * 80_000)), unrealizedPnl: asDecimal('0'), realizedPnl: asDecimal('0'), leverage: 1, marginMode: 'cross', liquidationPrice: null, fundingSinceOpen: asDecimal('0'), openedAt: 0, updatedAt: 0 }
}

function staleVenueMark(harness: Harness): void {
  harness.live.frozenMarkTs = harness.clock.now() - 5_001
}

function gateFor(harness: Harness, clientOrderId: string): GateDecision | undefined {
  const entry = [...harness.k.ledger.iterate()].reverse().find((item) => item.type === 'order.intent' && item.subject.clientOrderId === clientOrderId)
  return (entry?.payload as { gate?: { decision?: GateDecision } } | undefined)?.gate?.decision
}

describe('X2K stale venue mark execution boundary', () => {
  it('allows only valid old venue marks through the explicit age override', async () => {
    h = await makeHarness()
    let allowStale: boolean | undefined
    let mark: { price: string; ts: number; source?: 'venue_mark' | 'last' | 'mid' } = { price: '80000', ts: h.clock.now() - 5_000, source: 'venue_mark' }
    const source = h.live as unknown as { mark: (_id: string, options?: { allowStale?: boolean }) => typeof mark }
    source.mark = (_id, options) => { allowStale = options?.allowStale; return mark }
    expect(await h.k.bus.gateMark(BTC)).toMatchObject({ price: '80000', source: 'venue_mark' })
    expect(allowStale).toBeUndefined()
    mark = { ...mark, ts: h.clock.now() - 5_001 }
    expect(await h.k.bus.gateMark(BTC)).toBeUndefined()
    expect(await h.k.bus.gateMark(BTC, { allowStale: true })).toMatchObject({ price: '80000', ts: h.clock.now() - 5_001 })
    expect(allowStale).toBe(true)
    mark = { ...mark, ts: h.clock.now() + 1 }
    expect(await h.k.bus.gateMark(BTC, { allowStale: true })).toBeUndefined()
    mark = { ...mark, ts: h.clock.now(), source: 'last' }
    expect(await h.k.bus.gateMark(BTC, { allowStale: true })).toBeUndefined()
    mark = { ...mark, source: 'venue_mark', price: '0' }
    expect(await h.k.bus.gateMark(BTC, { allowStale: true })).toBeUndefined()
  })

  it('executes a PIN human pure reduction and records a non-mutating warning', async () => {
    h = await makeHarness()
    h.sim.positions.set(h.paper.accountId, [longPosition(h.paper.accountId)])
    staleVenueMark(h)
    const proof = await h.pinProof()
    const orderIntent = intent(h.paper.accountId)
    const result = await h.k.trading.place({ intent: orderIntent }, { ...h.human(), proof })
    expect(result.order?.status).toBe('filled')
    expect(h.sim.submitted).toHaveLength(1)
    const decision = gateFor(h, orderIntent.clientOrderId!)!
    expect(decision.decision).toBe('ALLOW')
    expect(decision.targetDigest).toBe(decision.adjustedTargetDigest)
    expect(decision.estimates.notional).toBe('800')
    expect(decision.ruleHits).toContainEqual(expect.objectContaining({ code: 'STALE_PRICE', action: 'warn' }))
    expect(decision.applied).toContainEqual(expect.objectContaining({ kind: 'warning', field: 'markPrice', code: 'STALE_PRICE', from: '80000', to: '80000', unit: 'USDC' }))
    expect(h.k.risk.replay(decision.precheckId).status).toBe('identical')
  })

  it('requires PIN for a stale-price human reduction and sends nothing without it', async () => {
    h = await makeHarness()
    h.sim.positions.set(h.paper.accountId, [longPosition(h.paper.accountId)])
    staleVenueMark(h)
    await expect(h.k.trading.place({ intent: intent(h.paper.accountId) }, h.human()))
      .rejects.toMatchObject({ problem: { name: 'AUTH_FAILED' } })
    expect(h.sim.submitted).toHaveLength(0)
  })

  it('continues to deny a stale-price open without sending it', async () => {
    h = await makeHarness()
    staleVenueMark(h)
    const openIntent = intent(h.paper.accountId, { side: 'buy', reduceOnly: false, size: asDecimal('0.001') })
    const result = await h.k.trading.place({ intent: openIntent }, h.human())
    expect(result.order?.status).toBe('denied')
    expect(result.order?.problem?.ruleHits).toContainEqual(expect.objectContaining({ code: 'STALE_PRICE', action: 'deny' }))
    expect(h.sim.submitted).toHaveLength(0)
  })

  it('turns an agent stale-price reduction into a proposal without sending it', async () => {
    h = await makeHarness()
    const agent = await makeAgent(h, 'auto_limited')
    const open = await h.k.trading.place({ intent: intent(h.paper.accountId, { side: 'buy', reduceOnly: false, size: asDecimal('0.001') }) }, agent.ctx())
    expect(open.order?.status).toBe('filled')
    const submittedBefore = h.sim.submitted.length
    staleVenueMark(h)
    const result = await h.k.trading.place({ intent: intent(h.paper.accountId, { size: asDecimal('0.0005') }) }, agent.ctx())
    expect(result.proposal?.status).toBe('pending')
    expect(result.problem?.ruleHits).toContainEqual(expect.objectContaining({ code: 'STALE_PRICE', action: 'review' }))
    expect(h.sim.submitted).toHaveLength(submittedBefore)
  })

  it('keeps stale account data blocking a PIN human stale-price reduction', async () => {
    h = await makeHarness()
    h.sim.positions.set(h.paper.accountId, [longPosition(h.paper.accountId)])
    h.sim.accountSnapshotOverrides = { stale: true }
    staleVenueMark(h)
    const result = await h.k.trading.place({ intent: intent(h.paper.accountId) }, { ...h.human(), proof: await h.pinProof() })
    expect(result.order?.status).toBe('denied')
    expect(result.order?.problem?.ruleHits).toContainEqual(expect.objectContaining({ code: 'ACCOUNT_UNKNOWN', action: 'deny' }))
    expect(h.sim.submitted).toHaveLength(0)
  })

  it('keeps a stale confirmedAt blocking a PIN reduction even when stale is false', async () => {
    h = await makeHarness()
    h.sim.positions.set(h.paper.accountId, [longPosition(h.paper.accountId)])
    h.sim.accountSnapshotOverrides = { stale: false, confirmedAt: h.clock.now() - 30_001 }
    staleVenueMark(h)
    const result = await h.k.trading.place({ intent: intent(h.paper.accountId) }, { ...h.human(), proof: await h.pinProof() })
    expect(result.order?.status).toBe('denied')
    expect(result.order?.problem?.ruleHits).toContainEqual(expect.objectContaining({ code: 'ACCOUNT_UNKNOWN', action: 'deny' }))
    expect(h.sim.submitted).toHaveLength(0)
  })

  it('does not invent a price or submit a PIN reduction when the mark is missing', async () => {
    h = await makeHarness()
    h.sim.positions.set(h.paper.accountId, [longPosition(h.paper.accountId)])
    h.k.bus.gateMark = async () => undefined
    const orderIntent = intent(h.paper.accountId)
    const result = await h.k.trading.place({ intent: orderIntent }, { ...h.human(), proof: await h.pinProof() })
    expect(result.order?.status).toBe('denied')
    expect(result.order?.problem?.ruleHits).toContainEqual(expect.objectContaining({ code: 'STALE_PRICE', action: 'deny' }))
    expect(h.sim.submitted).toHaveLength(0)
    const decision = gateFor(h, orderIntent.clientOrderId!)!
    expect(decision.priceRef).toBeUndefined()
    expect(decision.applied).not.toContainEqual(expect.objectContaining({ field: 'markPrice' }))
  })

  it('executes a PIN-approved stale agent reduction as human while retaining the agent origin', async () => {
    h = await makeHarness()
    h.sim.positions.set(h.paper.accountId, [longPosition(h.paper.accountId)])
    staleVenueMark(h)
    const agent = await makeAgent(h, 'auto_limited')
    const agentCtx = agent.ctx()
    const result = await h.k.trading.place({ intent: intent(h.paper.accountId) }, agentCtx)
    expect(result.proposal?.status).toBe('pending')
    expect(h.sim.submitted).toHaveLength(0)
    const approved = await h.k.trading.approve(result.proposal!.proposalId, await h.pinProof(), h.human('proposal.approve'))
    expect(approved.status).toBe('executed')
    expect(h.sim.submitted).toHaveLength(1)
    const entry = [...h.k.ledger.iterate()].reverse().find((row) => row.type === 'order.intent' && (row.payload as { path?: string }).path === 'approved')!
    const payload = entry.payload as { gate: { snapshot: { actorClass: string; originActorType: string }; target: { intent: { reduceOnly: boolean } } } }
    expect(payload.gate.snapshot).toMatchObject({ actorClass: 'human', originActorType: 'llm-agent' })
    expect(payload.gate.target.intent.reduceOnly).toBe(true)
    expect(entry.origin.actor).toBe(agentCtx.origin.actor)
  })

  it('flattens a stale-price position through trusted system takeover after the kill latch', async () => {
    h = await makeHarness({ kernel: { sleep: async () => undefined } })
    h.sim.positions.set(h.paper.accountId, [longPosition(h.paper.accountId)])
    staleVenueMark(h)
    h.k.trading.setKillSwitchState({ tripped: true, source: 'manual' })
    const ctx = { principal: { kind: 'service' as const }, origin: mkOrigin('system:kernel', 'takeover.system', 'internal') }
    const rec = await h.k.takeover.execute({ level: 'flatten_all', scope: { type: 'account', id: h.paper.accountId }, reason: 'revision emergency flatten' }, ctx)
    expect(rec).toMatchObject({ ok: true, closeOrders: 1 })
    expect(h.sim.submitted).toHaveLength(1)
    expect(h.sim.positions.get(h.paper.accountId)).toEqual([])
    expect([...h.k.ledger.iterate()].some((row) => row.type === 'takeover.completed' && row.origin.actorType === 'system')).toBe(true)
    const submitted = h.sim.submitted[0]!
    const entry = [...h.k.ledger.iterate()].reverse().find((row) => row.type === 'order.intent' && row.subject.clientOrderId === submitted.intent.clientOrderId)!
    const decision = (entry.payload as { gate: { decision: GateDecision } }).gate.decision
    expect(decision.decision).toBe('ALLOW')
    expect(decision.estimates.notional).toBe('800')
    expect(decision.ruleHits).toContainEqual(expect.objectContaining({ code: 'STALE_PRICE', action: 'warn' }))
    expect(decision.applied).toContainEqual(expect.objectContaining({ kind: 'warning', field: 'markPrice', code: 'STALE_PRICE', from: '80000', to: '80000', unit: 'USDC' }))
    expect(decision.targetDigest).toBe(decision.adjustedTargetDigest)
    expect(h.k.risk.replay(decision.precheckId).status).toBe('identical')
  })

  it('requires PIN before a stale-price human reduce amendment reaches the connector', async () => {
    h = await makeHarness()
    h.sim.positions.set(h.paper.accountId, [longPosition(h.paper.accountId)])
    const opened = await h.k.trading.place({ intent: intent(h.paper.accountId, { type: 'limit', price: asDecimal('79000') }) }, h.human())
    expect(['open', 'untriggered']).toContain(opened.order?.status)
    staleVenueMark(h)
    const request = { accountId: h.paper.accountId, clientOrderId: opened.order!.clientOrderId, price: '78000' }
    await expect(h.k.trading.amend(h.human(), request)).rejects.toMatchObject({ problem: { name: 'AUTH_FAILED' } })
    expect(h.sim.amendCalls).toHaveLength(0)
    h.sim.amend = async (amendCtx, amendRequest) => {
      h!.sim.amendCalls.push({ ctx: amendCtx, req: amendRequest })
      return {
        acks: [{ intentIndex: 0, clientOrderId: amendRequest.clientOrderId!, venueOrderId: opened.order!.venueOrderId!, status: 'open', filledSize: asDecimal('0'), avgFillPrice: null, builder: { attached: false } }],
        receiptHash: 'ab'.repeat(32), requestWeight: 1,
      }
    }
    await h.k.trading.amend({ ...h.human(), proof: await h.pinProof() }, request)
    expect(h.sim.amendCalls).toHaveLength(1)
  })
})
