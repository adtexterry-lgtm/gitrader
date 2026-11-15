// SPDX-License-Identifier: CPAL-1.0
import { afterEach, describe, expect, it } from 'vitest'
import { asDecimal } from '@gitrader/protocol'
import type { GateDecision, GateInput, GateTarget, GateTicket, OrderIntent, Position } from '../src/proto'
import { BTC } from './helpers/fake-connector'
import { makeAgent, makeHarness } from './helpers/harness'
import type { Harness } from './helpers/harness'
import { newClientOrderId } from '../src/util/ids'
import { mkOrigin } from '../src/util/origin'
import type { ActorCtx } from '../src/trading'

let h: Harness | undefined
afterEach(async () => { await h?.cleanup(); h = undefined })

function intent(accountId: string, extra: Partial<OrderIntent> = {}): OrderIntent {
  return { accountId: accountId as never, instrumentId: BTC, side: 'sell', type: 'market', size: asDecimal('0.01'), reduceOnly: true, clientOrderId: newClientOrderId(), ...extra }
}

function longPosition(accountId: string, size = '0.01'): Position {
  return { accountId: accountId as never, instrumentId: BTC, side: 'long', size: asDecimal(size), entryPrice: asDecimal('80000'), markPrice: asDecimal('80000'), notional: asDecimal('800'), unrealizedPnl: asDecimal('0'), realizedPnl: asDecimal('0'), leverage: 1, marginMode: 'cross', liquidationPrice: null, fundingSinceOpen: asDecimal('0'), openedAt: 0, updatedAt: 0 }
}

describe('B1 R2 public risk safety', () => {
  it('reviews an agent explicit reduction while HALTED', async () => {
    h = await makeHarness()
    const agent = await makeAgent(h, 'auto_limited')
    const open = await h.k.trading.place({ intent: intent(h.paper.accountId, { side: 'buy', reduceOnly: false, size: asDecimal('0.001'), reason: 'owner fixture' }) }, agent.ctx())
    expect(['filled', 'submitted', 'open']).toContain(open.order?.status)
    const ctx = agent.ctx()
    expect(h.k.orders.positionOwners(h.paper.accountId, BTC).actors).toContain(ctx.origin.actor)
    const submittedBeforeReduce = h.sim.submitted.length
    h.k.tstate.set({ type: 'account', id: h.paper.accountId }, 'HALTED', 'test hold', h.human().origin)
    const result = await h.k.trading.precheckIntent(intent(h.paper.accountId, { size: asDecimal('0.001'), reason: 'HALTED reduce test' }), ctx)
    expect(result.verdict).toBe('review')
    expect(result.stages).toContain('STATE')
    expect(result.ruleHits).toContainEqual(expect.objectContaining({ code: 'TRADING_STATE', action: 'review' }))
    expect(result.allowedActions.reduce).toBe(false)
    expect(result.allowedActions.amend).toBe(false)
    expect(h.sim.submitted).toHaveLength(submittedBeforeReduce)
  })

  it('rejects an explicit reduction without matching position direction or size', async () => {
    h = await makeHarness()
    h.sim.positions.set(h.paper.accountId, [longPosition(h.paper.accountId)])
    const wrongSide = await h.k.trading.precheckIntent(intent(h.paper.accountId, { side: 'buy' }), h.human())
    expect(wrongSide.verdict).toBe('review')
    expect(wrongSide.stages).toContain('CONST')
    expect(wrongSide.ruleHits).toContainEqual(expect.objectContaining({ code: 'REDUCE_ONLY_MISMATCH', action: 'review' }))

    const excess = await h.k.trading.precheckIntent(intent(h.paper.accountId, { size: asDecimal('0.010009') }), h.human())
    expect(excess.verdict).toBe('review')
    expect(excess.ruleHits).toContainEqual(expect.objectContaining({ code: 'REDUCE_ONLY_MISMATCH', action: 'review' }))

    h.sim.positions.set(h.paper.accountId, [])
    const noPosition = await h.k.trading.precheckIntent(intent(h.paper.accountId), h.human())
    expect(noPosition.verdict).toBe('review')
    expect(noPosition.ruleHits).toContainEqual(expect.objectContaining({ code: 'REDUCE_ONLY_MISMATCH', action: 'review' }))
  })

  it('fails stale account snapshots closed for explicit reductions', async () => {
    h = await makeHarness()
    h.sim.positions.set(h.paper.accountId, [longPosition(h.paper.accountId)])
    h.sim.accountSnapshotOverrides = { stale: true }
    const result = await h.k.trading.precheckIntent(intent(h.paper.accountId), h.human())
    expect(result.verdict).toBe('deny')
    expect(result.ruleHits).toContainEqual(expect.objectContaining({ code: 'ACCOUNT_UNKNOWN', action: 'deny' }))
  })

  it('denies an explicit reduction when confirmedAt is one millisecond beyond the stale threshold even if stale is false', async () => {
    h = await makeHarness()
    h.sim.positions.set(h.paper.accountId, [longPosition(h.paper.accountId)])
    h.sim.accountSnapshotOverrides = { stale: false, confirmedAt: h.clock.now() - 30_001 }
    const result = await h.k.trading.precheckIntent(intent(h.paper.accountId), h.human())
    expect(result.verdict).toBe('deny')
    expect(result.ruleHits).toContainEqual(expect.objectContaining({ code: 'ACCOUNT_UNKNOWN', action: 'deny' }))
    expect(h.sim.submitted).toHaveLength(0)
  })

  it('requires more than two seconds of intent lifetime and charges five local units only on actual expiry denial', async () => {
    h = await makeHarness()
    h.sim.positions.set(h.paper.accountId, [longPosition(h.paper.accountId)])
    const before = h.k.bus.budget('hyperliquid')!.used()
    const edge = await h.k.trading.precheckIntent(intent(h.paper.accountId, { expiresAt: h.clock.now() + 2_000 }), h.human())
    expect(edge.verdict).toBe('deny')
    expect(edge.stages).toContain('CONST')
    expect(edge.ruleHits).toContainEqual(expect.objectContaining({ code: 'INTENT_EXPIRED', action: 'deny' }))
    expect(h.k.bus.budget('hyperliquid')!.used()).toBe(before)
    const unsafe = await h.k.trading.precheckIntent(intent(h.paper.accountId, { expiresAt: Number.MAX_SAFE_INTEGER + 1 }), h.human())
    expect(unsafe.verdict).toBe('deny')
    expect(unsafe.ruleHits).toContainEqual(expect.objectContaining({ code: 'INTENT_EXPIRED', action: 'deny' }))

    const denied = await h.k.trading.place({ intent: intent(h.paper.accountId, { expiresAt: h.clock.now() + 2_000 }) }, h.human())
    expect(denied.order?.status).toBe('denied')
    expect(denied.order?.problem?.ruleHits).toContainEqual(expect.objectContaining({ code: 'INTENT_EXPIRED' }))
    expect(h.k.bus.budget('hyperliquid')!.used()).toBe(before + 5)
    expect(h.sim.submitted).toHaveLength(0)

    const passes = await h.k.trading.place({ intent: intent(h.paper.accountId, { size: asDecimal('0.005'), expiresAt: h.clock.now() + 2_001 }) }, h.human())
    expect(passes.order?.status).toBe('filled')
    expect(h.sim.submitted).toHaveLength(1)
  })

  it('requires human PIN for a HALTED direct reduction while trusted system reduction remains available', async () => {
    h = await makeHarness()
    h.sim.positions.set(h.paper.accountId, [longPosition(h.paper.accountId)])
    h.k.tstate.set({ type: 'account', id: h.paper.accountId }, 'HALTED', 'test hold', h.human().origin)
    await expect(h.k.trading.place({ intent: intent(h.paper.accountId, { size: asDecimal('0.005') }) }, h.human()))
      .rejects.toMatchObject({ problem: { name: 'AUTH_FAILED' } })
    expect(h.sim.submitted).toHaveLength(0)

    const system: ActorCtx = { principal: { kind: 'service' }, origin: mkOrigin('system:kernel', 'risk.close', 'internal') }
    const reduced = await h.k.trading.place({ intent: intent(h.paper.accountId, { size: asDecimal('0.005'), reason: 'system reduction' }) }, system)
    expect(reduced.order?.status).toBe('filled')
    expect(h.sim.submitted).toHaveLength(1)
    const withPin = await h.k.trading.place({ intent: intent(h.paper.accountId, { size: asDecimal('0.0025') }) }, { ...h.human(), proof: await h.pinProof() })
    expect(withPin.order?.status).toBe('filled')
    expect(h.sim.submitted).toHaveLength(2)
  })

  it('uses five projected rate units for an expiring reduction and one for an ordinary order', async () => {
    h = await makeHarness()
    h.sim.positions.set(h.paper.accountId, [longPosition(h.paper.accountId)])
    const budget = h.k.bus.budget('hyperliquid')!
    h.k.bus.reportWeight('hyperliquid', budget.limit - 4)
    const ordinary = await h.k.trading.precheckIntent(intent(h.paper.accountId), h.human())
    expect(ordinary.ruleHits).not.toContainEqual(expect.objectContaining({ code: 'RATE_BUDGET', unit: 'weight/min' }))
    const expiring = await h.k.trading.precheckIntent(intent(h.paper.accountId, { expiresAt: h.clock.now() + 5_000 }), h.human())
    expect(expiring.ruleHits).toContainEqual(expect.objectContaining({ code: 'RATE_BUDGET', actual: '1201', unit: 'weight/min' }))
  })

  it('rejects locally if an issued reduction ticket crosses the two-second deadline before connector use', async () => {
    h = await makeHarness()
    const opened = await h.k.trading.place({ intent: intent(h.paper.accountId, { side: 'buy', reduceOnly: false, size: asDecimal('0.001') }) }, h.human())
    expect(opened.order?.status).toBe('filled')
    const second = intent(h.paper.accountId, { size: asDecimal('0.0005'), expiresAt: h.clock.now() + 5_000 })
    const authority = (h.k.trading as unknown as { ticketAuthority: {
      issue(input: GateInput, decision: GateDecision, target: GateTarget): GateTicket
      consume(ticket: GateTicket | undefined, accountId: string, action: 'reduce', target: GateTarget): unknown
    } }).ticketAuthority
    const issue = authority.issue.bind(authority)
    let issuedTicket: GateTicket | undefined
    let issuedTarget: GateTarget | undefined
    authority.issue = (input, decision, target) => {
      const ticket = issue(input, decision, target)
      if (target.kind === 'order' && target.intent.clientOrderId === second.clientOrderId) {
        issuedTicket = ticket
        issuedTarget = target
        h!.clock.advance(3_500)
      }
      return ticket
    }
    const before = h.k.bus.budget('hyperliquid')!.used()
    const rejected = await h.k.trading.place({ intent: second }, h.human())
    expect(rejected.order?.status).toBe('rejected')
    expect(rejected.order?.problem?.name).toBe('GATE_TICKET_EXPIRED')
    expect(h.sim.submitted).toHaveLength(1)
    expect(h.k.bus.budget('hyperliquid')!.used()).toBe(before + 5)
    expect(h.k.ledger.query({ types: ['order.rejected'] }).at(-1)?.payload).toHaveProperty('stage', 'ticket')
    expect(issuedTicket).toBeDefined()
    expect(() => authority.consume(issuedTicket, h!.paper.accountId, 'reduce', issuedTarget!))
      .toThrowError(expect.objectContaining({ problem: expect.objectContaining({ name: 'GATE_TICKET_EXPIRED' }) }))
    const reservations = (h.k.trading as unknown as { reservations: { view(accountId: string, now: number, dayStart: number): { account: { count: number } } } }).reservations
    expect(reservations.view(h.paper.accountId, h.clock.now(), 0).account.count).toBe(0)
  })

  it('turns an agent HALTED reduction into a proposal and requires PIN to approve it', async () => {
    h = await makeHarness()
    const agent = await makeAgent(h, 'auto_limited')
    const agentCtx = agent.ctx()
    const opened = await h.k.trading.place({ intent: intent(h.paper.accountId, { side: 'buy', reduceOnly: false, size: asDecimal('0.001'), reason: 'owner fixture' }) }, agentCtx)
    expect(opened.order?.status).toBe('filled')
    h.k.tstate.set({ type: 'account', id: h.paper.accountId }, 'HALTED', 'test hold', h.human().origin)
    const before = h.sim.submitted.length
    const direct = await h.k.trading.place({ intent: intent(h.paper.accountId, { size: asDecimal('0.0005'), reason: 'HALTED agent proposal' }) }, agentCtx)
    expect(direct.proposal?.status).toBe('pending')
    expect(h.sim.submitted).toHaveLength(before)

    await expect(h.k.trading.approve(direct.proposal!.proposalId, h.sessionProof(), h.human('proposal.approve')))
      .rejects.toMatchObject({ problem: { name: 'ATTESTATION_REQUIRED' } })
    const approved = await h.k.trading.approve(direct.proposal!.proposalId, await h.pinProof(), h.human('proposal.approve'))
    expect(approved.status).toBe('executed')
    expect(h.sim.submitted).toHaveLength(before + 1)
    const entry = [...h.k.ledger.iterate()].reverse().find((row) => row.type === 'order.intent' && (row.payload as { path?: string }).path === 'approved')!
    const payload = entry.payload as { gate: { snapshot: { actorClass: string; originActorType: string }; target: unknown } }
    expect(payload.gate.snapshot).toMatchObject({ actorClass: 'human', originActorType: 'llm-agent' })
    expect(payload.gate.target).toMatchObject({ kind: 'order', intent: { reduceOnly: true, size: '0.0005' } })
  })

  it('does not re-propose an approved reduceOnly mismatch', async () => {
    h = await makeHarness()
    const agent = await makeAgent(h, 'auto_limited')
    const ctx = agent.ctx()
    const opened = await h.k.trading.place({ intent: intent(h.paper.accountId, { side: 'buy', reduceOnly: false, size: asDecimal('0.001'), reason: 'owner fixture' }) }, ctx)
    expect(opened.order?.status).toBe('filled')
    h.k.tstate.set({ type: 'account', id: h.paper.accountId }, 'HALTED', 'test hold', h.human().origin)
    const before = h.sim.submitted.length
    const result = await h.k.trading.place({ intent: intent(h.paper.accountId, { side: 'buy', size: asDecimal('0.0005'), reason: 'mismatched HALTED reduction' }) }, ctx)
    expect(result.proposal?.status).toBe('pending')
    const approved = await h.k.trading.approve(result.proposal!.proposalId, await h.pinProof(), h.human('proposal.approve'))
    expect(approved.status).toBe('failed')
    expect(approved.execution?.problem?.ruleHits).toContainEqual(expect.objectContaining({ code: 'REDUCE_ONLY_MISMATCH' }))
    expect(h.sim.submitted).toHaveLength(before)
    expect(h.k.trading.listProposals({ status: 'pending', limit: 100 })).toHaveLength(0)

    const rawExcess = '0.001009'
    const venueFloor = '0.001'
    const positionSize = '0.001'
    expect(Number(rawExcess)).toBeGreaterThan(Number(positionSize))
    expect(Number(venueFloor)).toBeLessThanOrEqual(Number(positionSize))
    h.live.instrumentsList[0]!.size = { step: asDecimal(venueFloor), decimals: 3, min: asDecimal(venueFloor) }
    const excess = await h.k.trading.place({ intent: intent(h.paper.accountId, { size: asDecimal(rawExcess), reason: 'rounded excess reduction' }) }, ctx)
    expect(excess.proposal?.status).toBe('pending')
    expect(excess.problem?.ruleHits).toContainEqual(expect.objectContaining({ code: 'REDUCE_ONLY_MISMATCH', action: 'review' }))
    const excessApproved = await h.k.trading.approve(excess.proposal!.proposalId, await h.pinProof(), h.human('proposal.approve'))
    expect(excessApproved.status).toBe('failed')
    expect(excessApproved.execution?.problem?.ruleHits).toContainEqual(expect.objectContaining({ code: 'REDUCE_ONLY_MISMATCH' }))
    expect(h.sim.submitted).toHaveLength(before)
    expect(h.k.trading.listProposals({ status: 'pending', limit: 100 })).toHaveLength(0)
  })

  it('requires PIN for HALTED human reduceOnly amendments and keeps agent amendments denied', async () => {
    h = await makeHarness()
    h.sim.positions.set(h.paper.accountId, [longPosition(h.paper.accountId)])
    const opened = await h.k.trading.place({ intent: intent(h.paper.accountId, { type: 'limit', price: asDecimal('79000'), size: asDecimal('0.005') }) }, h.human())
    expect(['open', 'untriggered']).toContain(opened.order?.status)
    h.k.tstate.set({ type: 'account', id: h.paper.accountId }, 'HALTED', 'test hold', h.human().origin)
    await expect(h.k.trading.amend(h.human(), { accountId: h.paper.accountId, clientOrderId: opened.order!.clientOrderId, price: '78000' }))
      .rejects.toMatchObject({ problem: { name: 'AUTH_FAILED' } })
    h.sim.amend = async (_ctx, req) => ({
      acks: [{ intentIndex: 0, clientOrderId: req.clientOrderId!, venueOrderId: 'local-amend-ack', status: 'open', filledSize: asDecimal('0'), avgFillPrice: null, builder: { attached: false } }],
      receiptHash: 'ab'.repeat(32), requestWeight: 1,
    })
    const amended = await h.k.trading.amend({ ...h.human(), proof: await h.pinProof() }, { accountId: h.paper.accountId, clientOrderId: opened.order!.clientOrderId, price: '78000' })
    expect(amended.order.price).toBe('78000')

    h.k.tstate.set({ type: 'account', id: h.paper.accountId }, 'ACTIVE', 'resume fixture', h.human().origin, await h.pinProof())
    const agent = await makeAgent(h, 'auto_limited')
    const agentCtx = agent.ctx()
    const ownOpen = await h.k.trading.place({ intent: intent(h.paper.accountId, { side: 'buy', reduceOnly: false, size: asDecimal('0.001'), reason: 'agent owner fixture' }) }, agentCtx)
    expect(ownOpen.order?.status).toBe('filled')
    const reduce = await h.k.trading.place({ intent: intent(h.paper.accountId, { type: 'limit', price: asDecimal('79000'), size: asDecimal('0.0005'), reason: 'agent resting reduction' }) }, agentCtx)
    expect(['open', 'untriggered']).toContain(reduce.order?.status)
    h.k.tstate.set({ type: 'account', id: h.paper.accountId }, 'HALTED', 'test hold', h.human().origin)
    await expect(h.k.trading.amend(agentCtx, { accountId: h.paper.accountId, clientOrderId: reduce.order!.clientOrderId, price: '78000' }))
      .rejects.toMatchObject({ problem: { name: 'TRADING_STATE' } })
  })

  it('keeps REDUCING agent reduce permission and closes it under kill or expired HALTED state', async () => {
    h = await makeHarness()
    const agent = await makeAgent(h, 'auto_limited')
    const ctx = agent.ctx()
    const opened = await h.k.trading.place({ intent: intent(h.paper.accountId, { side: 'buy', reduceOnly: false, size: asDecimal('0.001'), reason: 'owner fixture' }) }, ctx)
    expect(opened.order?.status).toBe('filled')
    h.k.tstate.set({ type: 'account', id: h.paper.accountId }, 'REDUCING', 'test reducing', h.human().origin)
    const reducing = await h.k.trading.precheckIntent(intent(h.paper.accountId, { size: asDecimal('0.0005'), reason: 'reducing permission' }), ctx)
    expect(reducing.allowedActions.reduce).toBe(true)
    expect(reducing.allowedActions.amend).toBe(true)

    h.k.trading.setKillSwitchState({ tripped: true, source: 'manual' })
    const killed = await h.k.trading.precheckIntent(intent(h.paper.accountId, { size: asDecimal('0.0005'), reason: 'kill review' }), ctx)
    expect(killed.verdict).toBe('review')
    expect(killed.allowedActions.reduce).toBe(false)
    expect(killed.allowedActions.amend).toBe(false)

    h.k.trading.setKillSwitchState({ tripped: false })
    h.k.tstate.set({ type: 'account', id: h.paper.accountId }, 'ACTIVE', 'resume fixture', h.human().origin, await h.pinProof())
    const tstate = h!.k.tstate
    const effective = tstate.effective.bind(tstate)
    tstate.effective = ((...args: Parameters<typeof tstate.effective>) => {
      const current = effective(...args)
      return { ...current, reasons: [...current.reasons, { scope: { type: 'account', id: h!.paper.accountId }, state: 'HALTED' as const, reason: 'expired fixture', until: h!.clock.now() - 1 }] }
    }) as typeof tstate.effective
    const expired = await h.k.trading.precheckIntent(intent(h.paper.accountId, { size: asDecimal('0.0005'), reason: 'expired HALTED' }), ctx)
    expect(expired.allowedActions.reduce).toBe(true)
    expect(expired.verdict).not.toBe('review')
  })
})
