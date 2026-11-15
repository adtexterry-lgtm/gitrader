// SPDX-License-Identifier: CPAL-1.0
import { afterEach, describe, expect, it } from 'vitest'
import { BTC } from './helpers/fake-connector'
import { enableLive, makeAgent, makeHarness } from './helpers/harness'
import type { Harness } from './helpers/harness'
import { ORG_SCOPE } from '../src/trading-state'
import { ReservationBook } from '../src/risk-gate/reservations'
import * as dec from '../src/util/dec'
import type { RiskPolicy } from '../src/proto'
import { asDecimal } from '@gitrader/protocol'

let h: Harness | undefined
afterEach(async () => { await h?.cleanup() })

describe('fresh gate-authorized execution', () => {
  it('distinguishes invalid mandate integrity from a valid L0 mandate', async () => {
    h = await makeHarness()
    const agent = await makeAgent(h, 'paper')
    h.k.docs.put('mandate', agent.mandate.mandateId, { ...agent.mandate, level: 'L0' }, agent.mandate.version)
    expect(h.k.agents.verifyMandate(agent.mandate.mandateId)).toBe(false)
    const invalid = await h.k.trading.place({ intent: {
      accountId: h.paper.accountId as never, instrumentId: BTC, side: 'buy', type: 'market', size: '0.001' as never, reason: 'integrity regression',
    } }, agent.ctx())
    expect(invalid.order?.status).toBe('denied')
    expect(invalid.order?.problem).toMatchObject({ name: 'MANDATE_EXPIRED', code: 2005 })

    const l0 = await makeAgent(h, 'read_only')
    const validLow = await h.k.trading.place({ intent: {
      accountId: h.paper.accountId as never, instrumentId: BTC, side: 'buy', type: 'market', size: '0.001' as never, reason: 'level regression',
    } }, l0.ctx())
    expect(validLow.order?.status).toBe('denied')
    expect(validLow.order?.problem).toMatchObject({ name: 'MANDATE_LEVEL', code: 2003 })
  })

  it('submits through an installed ticket and persists the matching gate evidence', async () => {
    h = await makeHarness()
    await enableLive(h)
    const result = await h.k.trading.place({ intent: {
      accountId: h.liveAcct.accountId as never, instrumentId: BTC, side: 'buy', type: 'market', size: '0.01' as never,
    } }, h.human())
    expect(result.order).toBeDefined()
    expect(result.order?.status).toBe('filled')
    expect(h.live.submitted).toHaveLength(1)
    expect(h.live.submitted[0]!.ctx.gate).toMatchObject({
      precheckId: result.order!.precheckId,
      ticketId: expect.stringMatching(/^tk_/),
    })
    const intentEntry = h.k.ledger.query({ types: ['order.intent'], limit: 1 })[0]!
    expect(intentEntry.payload).toHaveProperty('gate.decision.attestation.sig')
    expect(intentEntry.payload).toHaveProperty('gate.snapshot')
    expect(intentEntry.payload).toHaveProperty('reservation', expect.objectContaining({ accountId: h.liveAcct.accountId, size: '0.01', reduceOnly: false }))
    expect(intentEntry.payload).toHaveProperty('timing.assembleUs')
  })

  it('persists and submits the freshly limited size', async () => {
    h = await makeHarness()
    await enableLive(h)
    await h.k.risk.tighten({ limits: { maxOrderNotional: '500' as never } }, h.sessionProof(), h.human('risk').origin)
    const current = h.k.risk.current.bind(h.k.risk)
    h.k.risk.current = (() => {
      const policy = current()
      return policy ? { ...policy, limitMode: { size: true } } as RiskPolicy : undefined
    })
    const result = await h.k.trading.place({ intent: {
      accountId: h.liveAcct.accountId as never, instrumentId: BTC, side: 'buy', type: 'market', size: '0.01' as never, allowAdjust: ['size'],
    } }, h.human())
    expect(result.order?.status).toBe('filled')
    expect(result.order?.size).toBe('0.00625')
    expect(h.live.submitted[0]?.intent.size).toBe('0.00625')
    const entry = h.k.ledger.query({ types: ['order.intent'], limit: 1 })[0]!
    expect(entry.payload).toHaveProperty('intent.size', '0.00625')
    expect(entry.payload).toHaveProperty('gate.decision.decision', 'LIMIT')
  })

  it('persists a final gate denial without invoking a connector', async () => {
    h = await makeHarness()
    h.k.tstate.set(ORG_SCOPE, 'HALTED', 'execution test', h.human().origin)
    const result = await h.k.trading.place({ intent: {
      accountId: h.paper.accountId as never, instrumentId: BTC, side: 'buy', type: 'market', size: '0.01' as never,
    } }, h.human())
    expect(result.order?.status).toBe('denied')
    expect(h.sim.submitted).toHaveLength(0)
    expect(h.k.ledger.query({ types: ['risk.denied'], limit: 1 })[0]?.payload).toHaveProperty('gate.decision.verdict', 'deny')
  })

  it('releases pre-send margin when signer acquisition fails', async () => {
    h = await makeHarness()
    const result = await h.k.trading.place({ intent: {
      accountId: h.liveAcct.accountId as never, instrumentId: BTC, side: 'buy', type: 'market', size: '0.003' as never,
    } }, h.human())
    expect(result.order?.status).toBe('rejected')
    expect(h.live.submitted).toHaveLength(0)
    const book = (h.k.trading as unknown as { reservations: ReservationBook }).reservations
    expect(book.view(h.liveAcct.accountId, h.clock.now(), 0).account.margin).toBe('0')
  })

  it('releases an expired ticket before invoking the connector', async () => {
    h = await makeHarness()
    await enableLive(h)
    const clock = h.clock
    const append = h.k.ledger.append.bind(h.k.ledger)
    h.k.ledger.append = ((entry: Parameters<typeof append>[0]) => {
      const result = append(entry)
      if (entry.type === 'order.submitted') clock.advance(30_001)
      return result
    }) as typeof append
    const result = await h.k.trading.place({ intent: {
      accountId: h.liveAcct.accountId as never, instrumentId: BTC, side: 'buy', type: 'market', size: '0.003' as never,
    } }, h.human())
    expect(result.order?.status).toBe('rejected')
    expect(result.order?.problem?.name).toBe('GATE_TICKET_EXPIRED')
    expect(h.live.submitted).toHaveLength(0)
    const book = (h.k.trading as unknown as { reservations: ReservationBook }).reservations
    expect(book.view(h.liveAcct.accountId, h.clock.now(), 0).account.margin).toBe('0')
  })

  it('retains the reservation when a connector throws after invocation', async () => {
    h = await makeHarness()
    await enableLive(h)
    const clock = h.clock
    let calls = 0
    h.live.submit = async () => {
      calls++
      clock.advance(30_001)
      throw new Error('late connector failure')
    }
    const result = await h.k.trading.place({ intent: {
      accountId: h.liveAcct.accountId as never, instrumentId: BTC, side: 'buy', type: 'market', size: '0.003' as never,
    } }, h.human())
    expect(calls).toBe(1)
    expect(result.order?.status).toBe('submitted')
    const book = (h.k.trading as unknown as { reservations: ReservationBook }).reservations
    expect(dec.cmp(dec.D(book.view(h.liveAcct.accountId, h.clock.now(), 0).account.margin), dec.ZERO)).toBeGreaterThan(0)
  })

  it('keeps an unknown submission reserved so the next order cannot spend its margin', async () => {
    h = await makeHarness()
    await h.k.risk.relax({ limits: { maxPositionNotionalRatio: null, maxTotalNotionalRatio: null } as never }, await h.pinProof(), h.human('risk').origin)
    h.sim.equity = dec.D('100')
    h.sim.script = ['unknown']
    const first = await h.k.trading.place({ intent: {
      accountId: h.paper.accountId as never, instrumentId: BTC, side: 'buy', type: 'market', size: '0.00125' as never,
    } }, h.human())
    expect(first.order?.status).toBe('submitted')
    const book = (h.k.trading as unknown as { reservations: ReservationBook }).reservations
    expect(dec.cmp(dec.D(book.view(h.paper.accountId, h.clock.now(), 0).account.margin), dec.D('99'))).toBeGreaterThan(0)
    const second = await h.k.trading.place({ intent: {
      accountId: h.paper.accountId as never, instrumentId: BTC, side: 'buy', type: 'market', size: '0.0002' as never,
    } }, h.human())
    expect(second.order?.status).toBe('denied')
    expect(second.order?.problem?.ruleHits).toContainEqual(expect.objectContaining({ code: 'INSUFFICIENT_MARGIN' }))
    expect(h.sim.submitted).toHaveLength(1)
  })

  it('releases the account FIFO before connector acknowledgement and isolates other accounts', async () => {
    h = await makeHarness()
    await enableLive(h)
    await h.k.risk.relax({ limits: { duplicateIntentWindowSec: 0, maxPositionNotionalRatio: null, maxTotalNotionalRatio: null } as never }, await h.pinProof(), h.human('risk').origin)
    h.live.equity = dec.D('100')
    const original = h.live.submit.bind(h.live)
    let finish!: (result: never) => void
    let liveCalls = 0
    h.live.submit = async (ctx, intents) => {
      liveCalls++
      if (liveCalls === 1) return new Promise((resolve) => { finish = resolve })
      return original(ctx, intents)
    }
    const first = h.k.trading.place({ intent: {
      accountId: h.liveAcct.accountId as never, instrumentId: BTC, side: 'buy', type: 'market', size: '0.00075' as never,
    } }, h.human())
    for (let i = 0; i < 100 && liveCalls === 0; i++) await new Promise((resolve) => setTimeout(resolve, 1))
    expect(liveCalls).toBe(1)

    const competingOpen = await h.k.trading.place({ intent: {
      accountId: h.liveAcct.accountId as never, instrumentId: BTC, side: 'buy', type: 'market', size: '0.00075' as never,
    } }, h.human())
    expect(competingOpen.order?.status).toBe('denied')
    expect(competingOpen.order?.problem?.ruleHits).toContainEqual(expect.objectContaining({ code: 'INSUFFICIENT_MARGIN' }))
    expect(liveCalls).toBe(1)

    const otherAccount = await h.k.trading.place({ intent: {
      accountId: h.paper.accountId as never, instrumentId: BTC, side: 'buy', type: 'market', size: '0.01' as never,
    } }, h.human())
    expect(otherAccount.order).toBeDefined()
    const existingLivePosition = { accountId: h.liveAcct.accountId, instrumentId: BTC, side: 'long' as const, size: asDecimal('0.001'), entryPrice: asDecimal('80000'), markPrice: asDecimal('80000'), notional: asDecimal('80'), unrealizedPnl: asDecimal('0'), realizedPnl: asDecimal('0'), leverage: 2, marginMode: 'cross' as const, liquidationPrice: null, fundingSinceOpen: asDecimal('0'), openedAt: 0, updatedAt: 0 }
    h.live.positions.set(h.liveAcct.accountId, [existingLivePosition])
    expect(h.live.positions.get(h.liveAcct.accountId)?.[0]).toMatchObject({ side: 'long', size: '0.001', markPrice: '80000', notional: '80' })
    const reduction = h.k.trading.place({ intent: {
      accountId: h.liveAcct.accountId as never, instrumentId: BTC, side: 'sell', type: 'market', size: '0.0001' as never, reduceOnly: true,
    } }, h.human())
    for (let i = 0; i < 100 && liveCalls < 2; i++) await new Promise((resolve) => setTimeout(resolve, 1))
    expect(liveCalls).toBe(2)
    finish({ acks: [{ intentIndex: 0, clientOrderId: 'ignored', venueOrderId: 'vo-first', status: 'open', filledSize: '0', avgFillPrice: null, builder: { attached: false } }], receiptHash: 'ab'.repeat(32), requestWeight: 1 } as never)
    await first
    await reduction
  })

  it('does not let a late accepted acknowledgement downgrade a terminal event', async () => {
    h = await makeHarness()
    await enableLive(h)
    let finish!: (result: never) => void
    let clientOrderId = ''
    h.live.submit = async (_ctx, intents) => {
      clientOrderId = intents[0]!.clientOrderId!
      return new Promise((resolve) => { finish = resolve })
    }
    const pending = h.k.trading.place({ intent: {
      accountId: h.liveAcct.accountId as never, instrumentId: BTC, side: 'buy', type: 'limit', size: '0.01' as never, price: '70000' as never,
    } }, h.human())
    for (let i = 0; i < 100 && !clientOrderId; i++) await new Promise((resolve) => setTimeout(resolve, 1))
    expect(clientOrderId).toMatch(/^[0-9a-f]{32}$/)
    h.k.trading.onOrderUpdate(h.liveAcct.accountId, { venueOrderId: 'venue-order-01', clientOrderId, status: 'cancelled' })
    finish({ acks: [{ intentIndex: 0, clientOrderId, venueOrderId: 'venue-order-01', status: 'open', filledSize: '0', avgFillPrice: null, builder: { attached: false } }], receiptHash: 'ab'.repeat(32), requestWeight: 1 } as never)
    expect((await pending).order?.status).toBe('cancelled')
  })
})
