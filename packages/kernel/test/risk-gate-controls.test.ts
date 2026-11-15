// SPDX-License-Identifier: CPAL-1.0
import { afterEach, describe, expect, it } from 'vitest'
import { makeAgent, makeHarness } from './helpers/harness'
import type { Harness } from './helpers/harness'
import { BTC } from './helpers/fake-connector'
import { mkOrigin } from '../src/util/origin'
import { newClientOrderId } from '../src/util/ids'
import type { GateDecision, GateInput, OrderIntent } from '../src/proto'
import { tx } from '../src/db'
import { vi } from 'vitest'
import type { Order } from '../src/proto'
import type { ActorCtx } from '../src/trading'
import { asDecimal, type AccountId } from '@gitrader/protocol'
import type { StartupSnapshot, VenueOpenOrder } from '@gitrader/protocol/connector'

let h: Harness | undefined
afterEach(async () => { await h?.cleanup() })

const intent = (accountId: AccountId, size: string): OrderIntent => ({ accountId, instrumentId: BTC, side: 'buy', type: 'limit', size: asDecimal(size), price: asDecimal('80000'), tif: 'gtc', clientOrderId: newClientOrderId() })

async function freshStartupView(harness: Harness): Promise<StartupSnapshot> {
  const ref = harness.k.bus.accountRef(harness.paper), account = await harness.sim.accountState(ref)
  return { account: { ...account, stale: false }, openOrders: await harness.sim.openOrders(ref), fills: [], fillsSince: harness.clock.now() - 86_400_000, truncated: false }
}

describe('risk-gated controls', () => {
  it('system cancel-all remains available under kill state and uses a ticketed cancel call', async () => {
    h = await makeHarness()
    const placed = await h.k.trading.place({ intent: intent(h.paper.accountId, '0.001') }, h.human())
    expect(placed.order?.status).toBe('open')
    await h.k.risk.relax({ limits: { maxCancelsPerMinute: 0, maxDailyOrders: 0 } as never }, await h.pinProof(), h.human('risk.relax').origin)
    h.sim.accountSnapshotOverrides = { stale: true }
    h.sim.startupResponseSequence = [await freshStartupView(h)]
    h.k.trading.setKillSwitchState({ tripped: true, source: 'file' })
    const result = await h.k.trading.systemCancelAll(h.paper, { keepProtective: false })
    expect(result.cancelled).toBe(1)
    expect(h.sim.cancelContexts.at(-1)?.gate?.ticketId).toBeTruthy()
    expect(h.k.orders.get(placed.order!.orderId)?.status).toBe('cancelled')
    expect([...h.k.ledger.iterate()].filter((entry) => entry.type === 'order.cancelled' && entry.subject.clientOrderId === placed.order!.clientOrderId)).toHaveLength(0)
    const cancelEntry = [...h.k.ledger.iterate()].reverse().find((entry) => entry.type === 'order.cancelled')!
    const cancelGate = (cancelEntry.payload as { gate: { decision: { precheckId: string } } }).gate
    expect(cancelEntry.subject.precheckId).toBe(cancelGate.decision.precheckId)
    expect(cancelEntry.precheck?.precheckId).toBe(cancelGate.decision.precheckId)
    expect(h.k.risk.replay(cancelGate.decision.precheckId).status).toBe('identical')
    const beforeStaleReduction = h.sim.submitted.length
    const staleReduction = await h.k.trading.systemReduceOnly(h.paper, BTC, 'sell', '0.001', mkOrigin('system:kernel', 'test.reduce', 'internal'))
    expect(staleReduction.status).toBe('denied')
    expect(staleReduction.problem?.ruleHits).toContainEqual(expect.objectContaining({ code: 'ACCOUNT_UNKNOWN', action: 'deny' }))
    expect(h.sim.submitted).toHaveLength(beforeStaleReduction)
    h.sim.accountSnapshotOverrides = { stale: false }
    h.sim.positions.set(h.paper.accountId, [{ accountId: h.paper.accountId, instrumentId: BTC, side: 'long', size: asDecimal('0.001'), entryPrice: asDecimal('80000'), markPrice: asDecimal('80000'), notional: asDecimal('80'), unrealizedPnl: asDecimal('0'), realizedPnl: asDecimal('0'), leverage: 2, marginMode: 'cross', liquidationPrice: null, fundingSinceOpen: asDecimal('0'), openedAt: 0, updatedAt: 0 }])
    const reduced = await h.k.trading.systemReduceOnly(h.paper, BTC, 'sell', '0.001', mkOrigin('system:kernel', 'test.reduce', 'internal'))
    expect(reduced.status).toBe('filled')
    expect(h.sim.submitted.at(-1)?.intent.reduceOnly).toBe(true)
    expect(h.sim.submitted.at(-1)?.ctx.gate?.ticketId).toBeTruthy()
  })

  it('system schedule writes immediately with replayable gate tickets and aggregates renewal counts', async () => {
    h = await makeHarness()
    const read = h.k.bus.snapshot.bind(h.k.bus)
    h.k.bus.snapshot = async () => { throw new Error('schedule assembly must use its neutral snapshot') }
    const before = h.k.ledger.head().seq
    await h.k.trading.systemScheduleCancel(h.paper, h.clock.now() + 60_000)
    await h.k.trading.systemScheduleCancel(h.paper, h.clock.now() + 120_000)
    const entries = [...h.k.ledger.iterate()].filter((entry) => entry.seq > before)
    expect(entries).toHaveLength(2)
    for (const entry of entries) {
      expect(entry.type).toBe('annotation')
      const gate = (entry.payload as { gate: { decision: { precheckId: string }; ticketId: string } }).gate
      expect(gate.ticketId).toBeTruthy()
      expect(entry.subject.precheckId).toBe(gate.decision.precheckId)
      expect(entry.precheck?.precheckId).toBe(gate.decision.precheckId)
      expect(h.k.risk.replay(gate.decision.precheckId).status).toBe('identical')
    }
    expect(entries.reduce((sum, entry) => sum + ((entry.payload as { gateRenewals?: { count: number } }).gateRenewals?.count ?? 0), 0)).toBe(2)
    expect(read).toBeDefined()
  })

  it('restores a renewal after its enclosing account annotation rolls back', async () => {
    h = await makeHarness()
    h.k.ledger.recordGateRenewal(h.paper.accountId, { assembleUs: 1, decideUs: 2, protectorUs: 0 })
    expect(() => tx(h!.k.db, () => {
      h!.k.ledger.append({ type: 'annotation', origin: mkOrigin('system:kernel', 'test.rollback', 'internal'), subject: { accountId: h!.paper.accountId }, payload: {} })
      throw new Error('rollback')
    })).toThrow('rollback')
    h.k.ledger.append({ type: 'annotation', origin: mkOrigin('system:kernel', 'test.afterRollback', 'internal'), subject: { accountId: h.paper.accountId }, payload: {} })
    expect([...h.k.ledger.iterate()].at(-1)?.payload).toMatchObject({ gateRenewals: { count: 1 } })
  })

  it('ordinary cancellation still enforces the independent cancel-rate guard', async () => {
    h = await makeHarness()
    const placed = await h.k.trading.place({ intent: intent(h.paper.accountId, '0.001') }, h.human())
    await h.k.risk.relax({ limits: { maxCancelsPerMinute: 0 } as never }, await h.pinProof(), h.human('risk.relax').origin)
    await expect(h.k.trading.cancel({ accountId: h.paper.accountId, orderId: placed.order!.orderId }, h.human())).rejects.toMatchObject({ problem: { name: 'RATE_BUDGET', code: 2008 } })
    expect(h.sim.cancelCalls).toHaveLength(0)
    const entries = [...h.k.ledger.iterate()]
    const reject = entries.at(-1)!
    const compatibility = entries.slice(0, -1).reverse().find((entry) => entry.type === 'risk.denied')!
    const gate = (reject.payload as { gate: { decision: { precheckId: string; decision: string; ruleHits: Array<{ code: string }> } } }).gate
    const problem = (compatibility.payload as { problem: { ruleHits: Array<{ code: string; limit: string; actual: string }> } }).problem
    expect(reject.type).toBe('order.rejected')
    expect(reject.subject.precheckId).toBe(gate.decision.precheckId)
    expect(reject.precheck?.precheckId).toBe(gate.decision.precheckId)
    expect(gate.decision.decision).toBe('ALLOW')
    expect(gate.decision.ruleHits).not.toContainEqual(expect.objectContaining({ code: 'RATE_BUDGET' }))
    expect(reject.ruleHits).toBeUndefined()
    expect(reject.payload).toMatchObject({ cancelRateGuard: { ruleHits: [expect.objectContaining({ code: 'RATE_BUDGET', limit: '0', actual: '1' })] } })
    expect(compatibility.subject.precheckId).toBe(gate.decision.precheckId)
    expect(compatibility.precheck?.precheckId).toBe(gate.decision.precheckId)
    expect(compatibility.ruleHits).toEqual(problem.ruleHits)
    expect(problem.ruleHits).toContainEqual(expect.objectContaining({ code: 'RATE_BUDGET', limit: '0', actual: '1' }))
    expect(compatibility.payload).toMatchObject({ kind: 'cancelRateGuard', cancelRateGuard: { ruleHits: problem.ruleHits } })
    expect(compatibility.payload).not.toHaveProperty('gate')
    expect(h.k.risk.replay(gate.decision.precheckId).status).toBe('identical')
  })

  it('traces gross exposure after the cancel-count window resets and visible orders replace reservations', async () => {
    h = await makeHarness()
    await h.k.risk.relax({ limits: { maxCancelsPerMinute: 2 }, protectors: [] }, await h.pinProof(), h.human('risk.relax').origin)
    const orderIntent = (size: string): OrderIntent => ({
      accountId: h!.paper.accountId, instrumentId: BTC, side: 'buy', type: 'limit', size: asDecimal(size), price: asDecimal('70000'),
      tif: 'gtc', leverage: 2, clientOrderId: newClientOrderId(),
    })
    const placed = []
    for (const size of ['0.01', '0.011', '0.012', '0.013']) placed.push(await h.k.trading.place({ intent: orderIntent(size) }, h.human()))
    const orders = placed.map((result) => result.order!)
    await h.k.trading.cancel({ accountId: h.paper.accountId, orderId: orders[0]!.orderId }, h.human())
    await h.k.trading.cancel({ accountId: h.paper.accountId, orderId: orders[1]!.orderId }, h.human())
    await expect(h.k.trading.cancel({ accountId: h.paper.accountId, orderId: orders[2]!.orderId }, h.human()))
      .rejects.toMatchObject({ problem: { code: 2008 } })
    h.clock.advance(61_000)
    await h.k.trading.cancel({ accountId: h.paper.accountId, orderId: orders[2]!.orderId }, h.human())
    await h.k.trading.cancel({ accountId: h.paper.accountId, orderId: orders[3]!.orderId }, h.human())

    const samples: Array<{ input: GateInput; decision: GateDecision }> = []
    const decide = h.k.gate.decide.bind(h.k.gate)
    h.k.gate.decide = ((input: GateInput) => {
      const decision = decide(input)
      samples.push({ input: structuredClone(input), decision })
      return decision
    }) as typeof h.k.gate.decide
    const first = await h.k.trading.place({ intent: orderIntent('0.021') }, h.human())
    const second = await h.k.trading.place({ intent: orderIntent('0.022') }, h.human())
    expect(first.order?.status).toBe('open')
    expect(second.order?.status).toBe('denied')
    const trace = samples.at(-1)!
    expect(trace.input.snapshot.equity).toBe('10000')
    expect(trace.input.policy?.limits.maxPositionNotionalRatio).toBe('0.3')
    expect(trace.input.snapshot.positions).toEqual([])
    expect(trace.input.snapshot.openOrders).toEqual([{ instrumentId: BTC, side: 'buy', notional: '1470', count: 1 }])
    expect(trace.input.reserved.account.notional).toBe('0')
    expect(trace.input.reserved.byInstrument[BTC]?.long.notional ?? '0').toBe('0')
    expect(trace.decision.ruleHits).toContainEqual(expect.objectContaining({ code: 'POSITION_NOTIONAL', action: 'deny', limit: '0.3', actual: '0.301' }))
  })

  it.each(['ordinary', 'explicit-tp'] as const)('%s single cancel binds the same optional role into ticket and venue call', async (kind) => {
    h = await makeHarness()
    const placed = await h.k.trading.place({ intent: intent(h.paper.accountId, '0.001') }, h.human())
    const order = placed.order!
    if (kind === 'explicit-tp') {
      const tp = { ...order, tpslRole: 'tp' } as Order
      h.k.orders.upsert(tp, '80', true)
      const venue = h.sim.orders.find((x) => x.clientOrderId === tp.clientOrderId)!
      venue.type = 'take_limit'; venue.isTrigger = true
    }
    const before = (h.k.trading as unknown as { reservations: { view(id: string, now: number, day: number): { account: { margin: string } } } }).reservations.view(h.paper.accountId, h.clock.now(), 0).account.margin
    const result = await h.k.trading.cancel({ accountId: h.paper.accountId, orderId: order.orderId }, h.human())
    expect(result.ok).toBe(true)
    expect(h.sim.cancelCalls).toHaveLength(1)
    expect(h.sim.cancelContexts[0]?.gate?.ticketId).toBeTruthy()
    expect(h.k.orders.get(order.orderId)?.status).toBe('cancelled')
    const orderCancelEntries = [...h.k.ledger.iterate()].filter((entry) => entry.type === 'order.cancelled' && entry.subject.clientOrderId === order.clientOrderId)
    expect(orderCancelEntries).toHaveLength(1)
    expect(orderCancelEntries[0]?.origin.actorType).toBe('human')
    expect((h.k.trading as unknown as { reservations: { view(id: string, now: number, day: number): { account: { margin: string } } } }).reservations.view(h.paper.accountId, h.clock.now(), 0).account.margin).not.toBe(before)
    const entry = [...h.k.ledger.iterate()].reverse().find((x) => x.type === 'order.cancelled')!
    const gateDecision = (entry.payload as { gate: { decision: { precheckId: string } } }).gate.decision
    const gatePayload = (entry.payload as { gate: { ticketId: string; target: { kind: string; targets: Array<{ orderId: string; clientOrderId: string; tpslRole?: string }> } } }).gate
    expect(entry.subject.precheckId).toBe(gateDecision.precheckId)
    expect(entry.precheck?.precheckId).toBe(gateDecision.precheckId)
    expect(gatePayload.ticketId).toBe(h.sim.cancelContexts[0]?.gate?.ticketId)
    expect(gatePayload.target).toMatchObject({ kind: 'cancel', targets: [{ orderId: order.orderId, clientOrderId: order.clientOrderId, ...(kind === 'explicit-tp' ? { tpslRole: 'tp' } : {}) }] })
    expect(h.k.risk.replay(gateDecision.precheckId).status).toBe('identical')
    const payload = entry.payload as { gate: { snapshot: { stats: { dailyNotional: string }; snapshot: { openOrders: Array<{ count: number }> } } } }
    expect(Number(payload.gate.snapshot.stats.dailyNotional)).toBeGreaterThan(0)
    expect(payload.gate.snapshot.snapshot.openOrders.some((row) => row.count > 0)).toBe(true)
  })

  it('does not let a session spoof a system origin bypass the cancel cap', async () => {
    h = await makeHarness()
    const placed = await h.k.trading.place({ intent: intent(h.paper.accountId, '0.001') }, h.human())
    await h.k.risk.relax({ limits: { maxCancelsPerMinute: 0 } as never }, await h.pinProof(), h.human('risk.relax').origin)
    const ctx = { ...h.human(), origin: mkOrigin('system:spoof', 'cancel', 'internal') }
    await expect(h.k.trading.cancel({ accountId: h.paper.accountId, orderId: placed.order!.orderId }, ctx)).rejects.toMatchObject({ problem: { name: 'RATE_BUDGET', code: 2008 } })
    expect(h.sim.cancelCalls).toHaveLength(0)
  })

  it('does not let an agent with a spoofed system origin bypass the cancel cap', async () => {
    h = await makeHarness()
    const placed = await h.k.trading.place({ intent: intent(h.paper.accountId, '0.001') }, h.human())
    const agent = await makeAgent(h, 'paper')
    await h.k.risk.relax({ limits: { maxCancelsPerMinute: 0 } as never }, await h.pinProof(), h.human('risk.relax').origin)
    const ctx = { ...agent.ctx(), origin: mkOrigin('system:spoof', 'cancel', 'internal') }
    await expect(h.k.trading.cancel({ accountId: h.paper.accountId, orderId: placed.order!.orderId }, ctx)).rejects.toMatchObject({ problem: { name: 'RATE_BUDGET', code: 2008 } })
    expect(h.sim.cancelCalls).toHaveLength(0)
  })

  it('only exempts a complete trusted service system origin from the cancel cap', async () => {
    h = await makeHarness()
    const first = await h.k.trading.place({ intent: intent(h.paper.accountId, '0.001') }, h.human())
    await h.k.risk.relax({ limits: { maxCancelsPerMinute: 0 } as never }, await h.pinProof(), h.human('risk.relax').origin)
    const service: ActorCtx = { principal: { kind: 'service' }, origin: mkOrigin('system:kernel', 'cancel', 'internal') }
    await expect(h.k.trading.cancel({ accountId: h.paper.accountId, orderId: first.order!.orderId }, { ...service, origin: mkOrigin('system:kernel', 'cancel', 'cli') })).rejects.toMatchObject({ problem: { name: 'RATE_BUDGET', code: 2008 } })
    expect(h.sim.cancelCalls).toHaveLength(0)
    const result = await h.k.trading.cancel({ accountId: h.paper.accountId, orderId: first.order!.orderId }, service)
    expect(result.ok).toBe(true)
    expect(h.sim.cancelCalls).toHaveLength(1)
    const entry = [...h.k.ledger.iterate()].reverse().find((x) => x.type === 'order.cancelled')!
    expect(entry.origin.actor).toBe('system:kernel')
    expect((entry.payload as { gate: { ticketId: string } }).gate.ticketId).toBe(h.sim.cancelContexts.at(-1)?.gate?.ticketId)
  })

  it('keeps real venue order updates attributed to the venue', async () => {
    h = await makeHarness()
    const placed = await h.k.trading.place({ intent: intent(h.paper.accountId, '0.001') }, h.human())
    h.k.trading.onOrderUpdate(h.paper.accountId, { venueOrderId: placed.order!.venueOrderId ?? '', clientOrderId: placed.order!.clientOrderId, status: 'cancelled' })
    const update = [...h.k.ledger.iterate()].reverse().find((entry) => entry.type === 'order.cancelled' && entry.subject.clientOrderId === placed.order!.clientOrderId)!
    expect(update.origin.actor).toBe('venue:hyperliquid')
  })

  it('records and replays the complete gate for system deadman disarm', async () => {
    h = await makeHarness()
    const result = await h.k.trading.systemScheduleCancel(h.paper, null)
    expect(result.ok).toBe(true)
    const entry = [...h.k.ledger.iterate()].reverse().find((x) => x.type === 'annotation')!
    const gateDecision = (entry.payload as { gate: { decision: { precheckId: string } } }).gate.decision
    expect(entry.subject.precheckId).toBe(gateDecision.precheckId)
    expect(entry.precheck?.precheckId).toBe(gateDecision.precheckId)
    expect(h.k.risk.replay(gateDecision.precheckId).status).toBe('identical')
  })

  it('maps mandate cancel caps to MANDATE_LIMIT for cancel and cancel-all', async () => {
    h = await makeHarness()
    const placed = await h.k.trading.place({ intent: intent(h.paper.accountId, '0.001') }, h.human())
    const agent = await makeAgent(h, 'paper', { limits: { maxCancelsPerMinute: 0 } })
    await expect(h.k.trading.cancel({ accountId: h.paper.accountId, orderId: placed.order!.orderId }, agent.ctx())).rejects.toMatchObject({ problem: { name: 'MANDATE_LIMIT', code: 2004 } })
    await expect(h.k.trading.cancelAll({ accountId: h.paper.accountId }, agent.ctx())).rejects.toMatchObject({ problem: { name: 'MANDATE_LIMIT', code: 2004 } })
    expect(h.sim.cancelCalls).toHaveLength(0)
    expect(h.sim.cancelAllContexts).toHaveLength(0)
  })

  it('writes replayable non-ALLOW control evidence with its real rule hits', async () => {
    h = await makeHarness()
    const placed = await h.k.trading.place({ intent: intent(h.paper.accountId, '0.001') }, h.human())
    const agent = await makeAgent(h, 'paper')
    h.k.docs.put('mandate', agent.mandate.mandateId, { ...agent.mandate, level: 'L0' }, agent.mandate.version)
    expect(h.k.agents.verifyMandate(agent.mandate.mandateId)).toBe(false)
    await expect(h.k.trading.cancel({ accountId: h.paper.accountId, orderId: placed.order!.orderId }, agent.ctx()))
      .rejects.toMatchObject({ problem: { name: 'MANDATE_EXPIRED', ruleHits: [expect.objectContaining({ code: 'MANDATE_EXPIRED' })] } })
    const entry = [...h.k.ledger.iterate()].at(-1)!
    const gate = (entry.payload as { gate: { decision: { precheckId: string; decision: string } } }).gate
    expect(entry.type).toBe('order.rejected')
    expect(gate.decision.decision).toBe('BLOCK')
    expect(entry.subject.precheckId).toBe(gate.decision.precheckId)
    expect(entry.precheck?.precheckId).toBe(gate.decision.precheckId)
    expect(entry.ruleHits).toContainEqual(expect.objectContaining({ code: 'MANDATE_EXPIRED' }))
    expect(h.k.risk.replay(gate.decision.precheckId).status).toBe('identical')
  })

  it('counts a guarded cancel attempt before its pending ACK and exempts trusted system cancellation', async () => {
    h = await makeHarness()
    const first = await h.k.trading.place({ intent: intent(h.paper.accountId, '0.001') }, h.human())
    const secondOrder = { ...first.order!, orderId: 'ord_pending_cancel', clientOrderId: newClientOrderId() } as Order
    h.k.orders.upsert(secondOrder, '160', true)
    h.sim.orders.push({ venueOrderId: 'venue_pending_cancel', clientOrderId: secondOrder.clientOrderId, accountId: h.paper.accountId, instrumentId: BTC, side: 'buy', type: 'limit', size: '0.002', price: '80000', reduceOnly: false, isTrigger: false, status: 'open', createdAt: h.clock.now() })
    await h.k.risk.relax({ limits: { maxCancelsPerMinute: 1 } as never }, await h.pinProof(), h.human('risk.relax').origin)
    const finishes: (() => void)[] = []
    const original = h.sim.cancel.bind(h.sim)
    h.sim.cancel = (ctx, targets) => new Promise((resolve) => { finishes.push(() => { void original(ctx, targets).then(resolve) }) })
    const firstPending = h.k.trading.cancel({ accountId: h.paper.accountId, orderId: first.order!.orderId }, h.human())
    await vi.waitFor(() => expect(finishes).toHaveLength(1))
    await expect(h.k.trading.cancel({ accountId: h.paper.accountId, orderId: secondOrder.orderId }, h.human())).rejects.toMatchObject({ problem: { name: 'RATE_BUDGET' } })
    expect(h.sim.cancelCalls).toHaveLength(0)
    const system = h.k.trading.systemCancelAll(h.paper, { keepProtective: false })
    finishes[0]!()
    await vi.waitFor(() => expect(finishes).toHaveLength(2))
    finishes[1]!()
    await Promise.all([firstPending, system])
    expect(h.sim.cancelContexts.at(-1)?.gate?.ticketId).toBeTruthy()
  })

  it.each(['policy verification failure', 'stale account', 'kill latch', 'daily order limit', 'cancel count limit'])(
    'system cancellation and reduction stay ticketed under %s', async (condition) => {
      h = await makeHarness()
      const placed = await h.k.trading.place({ intent: intent(h.paper.accountId, '0.001') }, h.human())
      h.sim.positions.set(h.paper.accountId, [{ accountId: h.paper.accountId, instrumentId: BTC, side: 'long', size: asDecimal('1'), entryPrice: asDecimal('80000'), markPrice: asDecimal('80000'), notional: asDecimal('80000'), unrealizedPnl: asDecimal('0'), realizedPnl: asDecimal('0'), leverage: 2, marginMode: 'cross', liquidationPrice: null, fundingSinceOpen: asDecimal('0'), openedAt: 0, updatedAt: 0 }])
      if (condition === 'policy verification failure') {
        const current = h.k.risk.current()!
        h.k.docs.put('policy', current.policyId, { ...current, limits: { ...current.limits, maxLeverage: 1 } }, current.version)
        expect(h.k.risk.verify().ok).toBe(false)
      } else if (condition === 'stale account') { h.sim.accountSnapshotOverrides = { stale: true }; h.sim.startupResponseSequence = [await freshStartupView(h)] }
      else if (condition === 'kill latch') h.k.trading.setKillSwitchState({ tripped: true, source: 'file' })
      else if (condition === 'daily order limit') await h.k.risk.relax({ limits: { maxDailyOrders: 0 } as never }, await h.pinProof(), h.human('risk.relax').origin)
      else await h.k.risk.relax({ limits: { maxCancelsPerMinute: 0 } as never }, await h.pinProof(), h.human('risk.relax').origin)
      const cancelled = await h.k.trading.systemCancelAll(h.paper)
      expect(cancelled.cancelled).toBe(1)
      expect(h.k.orders.get(placed.order!.orderId)?.status).toBe('cancelled')
      if (condition === 'stale account') {
        const beforeStaleReduction = h.sim.submitted.length
        const staleReduction = await h.k.trading.systemReduceOnly(h.paper, BTC, 'sell', '0.001', mkOrigin('system:kernel', 'test.reduce', 'internal'))
        expect(staleReduction.status).toBe('denied')
        expect(staleReduction.problem?.ruleHits).toContainEqual(expect.objectContaining({ code: 'ACCOUNT_UNKNOWN', action: 'deny' }))
        expect(h.sim.submitted).toHaveLength(beforeStaleReduction)
        h.sim.accountSnapshotOverrides = { stale: false }
      }
      const reduced = await h.k.trading.systemReduceOnly(h.paper, BTC, 'sell', '0.001', mkOrigin('system:kernel', 'test.reduce', 'internal'))
      expect(reduced.status).toBe('filled')
      expect(h.sim.submitted.at(-1)?.ctx.gate?.ticketId).toBeTruthy()
      const accountId = h.paper.accountId
      expect(h.sim.orders.filter((o) => o.accountId === accountId && o.status === 'open')).toHaveLength(0)
    },
  )

  it('keepProtective retains stop-loss and unknown triggers while cancelling known take-profit and ordinary orders', async () => {
    h = await makeHarness()
    h.sim.orders.push(
      { venueOrderId: 'venue_sl', clientOrderId: 'cl_sl', accountId: h.paper.accountId, instrumentId: BTC, side: 'sell', type: 'stop_market', size: '0.001', price: null, reduceOnly: true, isTrigger: true, status: 'open', createdAt: h.clock.now() },
      { venueOrderId: 'venue_unknown_trigger', clientOrderId: 'cl_unknown_trigger', accountId: h.paper.accountId, instrumentId: BTC, side: 'sell', type: 'trailing_stop', size: '0.001', price: null, reduceOnly: true, isTrigger: true, status: 'open', createdAt: h.clock.now() },
      { venueOrderId: 'venue_tp', clientOrderId: 'cl_tp', accountId: h.paper.accountId, instrumentId: BTC, side: 'sell', type: 'take_limit', size: '0.001', price: '90000', reduceOnly: true, isTrigger: true, status: 'open', createdAt: h.clock.now() },
      { venueOrderId: 'venue_normal', clientOrderId: 'cl_normal', accountId: h.paper.accountId, instrumentId: BTC, side: 'buy', type: 'limit', size: '0.001', price: '70000', reduceOnly: false, isTrigger: false, status: 'open', createdAt: h.clock.now() },
    )
    const result = await h.k.trading.systemCancelAll(h.paper)
    expect(result.cancelled).toBe(2)
    expect(h.sim.orders.map((o) => [o.clientOrderId, o.status])).toEqual([
      ['cl_sl', 'open'], ['cl_unknown_trigger', 'open'], ['cl_tp', 'cancelled'], ['cl_normal', 'cancelled'],
    ])
  })

  it.each([true, false])('system cancel-all preserves protectives on a stale view (caller requested keepProtective=%s)', async (keepProtective) => {
    h = await makeHarness()
    const rows: VenueOpenOrder[] = [
      { instrumentId: BTC, venueOrderId: 'venue_ordinary', clientOrderId: 'cl_ordinary', side: 'buy', type: 'limit', price: asDecimal('70000'), triggerPrice: null, size: asDecimal('0.001'), origSize: asDecimal('0.001'), reduceOnly: false, isTrigger: false, createdAt: h.clock.now() },
      { instrumentId: BTC, venueOrderId: 'venue_sl_remote', clientOrderId: 'cl_sl_remote', side: 'sell', type: 'stop_market', price: null, triggerPrice: null, size: asDecimal('0.001'), origSize: asDecimal('0.001'), reduceOnly: true, isTrigger: true, createdAt: h.clock.now() },
      { instrumentId: BTC, venueOrderId: 'venue_tp_remote', clientOrderId: 'cl_tp_remote', side: 'sell', type: 'take_limit', price: asDecimal('90000'), triggerPrice: asDecimal('90000'), size: asDecimal('0.001'), origSize: asDecimal('0.001'), reduceOnly: true, isTrigger: true, createdAt: h.clock.now() },
      { instrumentId: BTC, venueOrderId: 'venue_unknown_remote', clientOrderId: 'cl_unknown_remote', side: 'sell', type: 'unknown', price: null, triggerPrice: null, size: asDecimal('0.001'), origSize: asDecimal('0.001'), reduceOnly: true, isTrigger: true, createdAt: h.clock.now() },
    ]
    const isFakeOrderType = (type: string): type is 'limit' | 'stop_market' | 'take_limit' | 'unknown' => type === 'limit' || type === 'stop_market' || type === 'take_limit' || type === 'unknown'
    for (const row of rows) {
      if (typeof row.type !== 'string' || row.clientOrderId === null || !isFakeOrderType(row.type)) throw new Error('cancel fixture requires a supported fake order type and client ID')
      h.sim.orders.push({ ...row, accountId: h.paper.accountId, type: row.type, clientOrderId: row.clientOrderId, price: row.price ?? null, status: 'open' })
    }
    h.sim.accountSnapshotOverrides = { stale: true }
    h.sim.openOrdersOverride = []
    const ref = h.k.bus.accountRef(h.paper)
    const cached = await h.sim.accountState(ref)
    const remote: StartupSnapshot = { account: { ...cached, stale: false }, openOrders: rows, fills: [], fillsSince: h.clock.now() - 86_400_000, truncated: false }
    h.sim.startupResponseSequence = [remote]
    const result = await h.k.trading.systemCancelAll(h.paper, { keepProtective })
    expect(h.sim.startupSnapshotCalls).toBe(1)
    expect(result.cancelled).toBe(2)
    expect(h.sim.cancelAllCalls).toHaveLength(0)
    expect(h.sim.cancelCalls).toHaveLength(1)
    expect(h.sim.cancelCalls[0]?.map((target) => target.clientOrderId)).toEqual(['cl_ordinary', 'cl_tp_remote'])
    expect(h.sim.cancelContexts[0]?.gate?.ticketId).toBeTruthy()
    expect(h.sim.orders.map((order) => [order.clientOrderId, order.status])).toEqual([['cl_ordinary', 'cancelled'], ['cl_sl_remote', 'open'], ['cl_tp_remote', 'cancelled'], ['cl_unknown_remote', 'open']])
  })

  it('uses per-order cancellation for a fresh system snapshot to preserve protectives', async () => {
    h = await makeHarness()
    await h.k.trading.place({ intent: intent(h.paper.accountId, '0.001') }, h.human())
    const result = await h.k.trading.systemCancelAll(h.paper, { keepProtective: false })
    expect(result.cancelled).toBe(1)
    expect(h.sim.cancelAllCalls).toHaveLength(0)
    expect(h.sim.cancelCalls).toHaveLength(1)
    expect(h.sim.cancelContexts.at(-1)?.gate?.ticketId).toBeTruthy()
  })

  it('audits stale cancel-all lookup failures and does not claim success', async () => {
    h = await makeHarness()
    await h.k.trading.place({ intent: intent(h.paper.accountId, '0.001') }, h.human())
    h.sim.accountSnapshotOverrides = { stale: true }
    h.sim.openOrdersOverride = []
    h.sim.startupResponseSequence = [new Error('remote query failed')]
    await expect(h.k.trading.systemCancelAll(h.paper, { keepProtective: false })).rejects.toMatchObject({ problem: { name: 'VENUE_UNAVAILABLE', retryable: true } })
    expect(h.sim.cancelCalls).toHaveLength(0)
    expect(h.sim.cancelAllCalls).toHaveLength(0)
    const entries = [...h.k.ledger.iterate()]
    expect(entries.some((entry) => entry.type === 'order.cancelled')).toBe(false)
    const rejected = entries.at(-1)!
    expect(rejected.type).toBe('order.rejected')
    expect(rejected.payload).toMatchObject({ kind: 'cancel.failed', gate: { ticketId: expect.any(String), decision: expect.any(Object), snapshot: expect.any(Object) }, problem: { name: 'VENUE_UNAVAILABLE', retryable: true } })
  })
})
