// SPDX-License-Identifier: CPAL-1.0
import { afterEach, describe, expect, it } from 'vitest'
import { asDecimal } from '@gitrader/protocol'
import type { OrderIntent } from '../src/proto'
import { makeAgent, makeHarness } from './helpers/harness'
import type { Harness } from './helpers/harness'
import { BTC } from './helpers/fake-connector'
import { newClientOrderId } from '../src/util/ids'

let h: Harness | undefined
afterEach(async () => { await h?.cleanup() })

const orderIntent = (accountId: string, overrides: Partial<OrderIntent> = {}): OrderIntent => ({
  accountId: accountId as never, instrumentId: BTC, side: 'buy', type: 'limit',
  size: asDecimal('0.001'), price: asDecimal('80000'), tif: 'gtc', clientOrderId: newClientOrderId(), ...overrides,
})

describe('risk gate attempt audit', () => {
  it('records and publishes a real preview denial without minting a token', async () => {
    h = await makeHarness()
    h.sim.marks.delete(BTC)
    h.live.marks.delete(BTC)
    const denials: unknown[] = []
    const unsubscribe = h.k.events.subscribe('risk.denials', (event) => denials.push(event.data))
    const preview = await h.k.trading.preview(orderIntent(h.paper.accountId), h.human())
    expect(preview.precheck.verdict).toBe('deny')
    expect(preview.confirmToken).toBeUndefined()
    const entry = [...h.k.ledger.iterate()].at(-1)!
    expect(entry.type).toBe('risk.denied')
    const gate = (entry.payload as { gate: { decision: { precheckId: string } } }).gate
    expect(entry.subject.precheckId).toBe(gate.decision.precheckId)
    expect(entry.precheck?.precheckId).toBe(gate.decision.precheckId)
    expect(entry.ruleHits?.length).toBeGreaterThan(0)
    expect(denials).toContainEqual(expect.objectContaining({ accountId: h.paper.accountId, precheckId: gate.decision.precheckId, ruleHits: entry.ruleHits }))
    unsubscribe()
  })

  it('keeps precheckIntent dry and leaves ledger, events, reservations, and tokens unchanged', async () => {
    h = await makeHarness()
    const book = (h.k.trading as unknown as { reservations: { view(id: string, now: number, day: number): unknown } }).reservations
    const beforeHead = h.k.ledger.head().seq
    const beforeBook = structuredClone(book.view(h.paper.accountId, h.clock.now(), 0))
    const tradingInternals = h.k.trading as unknown as { tokens: Map<string, unknown> }
    const beforeTokens = tradingInternals.tokens.size
    const denials: unknown[] = []
    const unsubscribe = h.k.events.subscribe('risk.denials', (event) => denials.push(event.data))
    const decision = await h.k.trading.precheckIntent(orderIntent(h.paper.accountId), h.human())
    expect(decision.dryRun).toBe(true)
    expect(h.k.ledger.head().seq).toBe(beforeHead)
    expect(book.view(h.paper.accountId, h.clock.now(), 0)).toEqual(beforeBook)
    expect(tradingInternals.tokens.size).toBe(beforeTokens)
    expect(denials).toHaveLength(0)
    unsubscribe()
  })

  it('audits a denied proposal leg through risk.denied and the risk.denials event', async () => {
    h = await makeHarness()
    h.sim.marks.delete(BTC)
    h.live.marks.delete(BTC)
    const agent = await makeAgent(h, 'confirm')
    const denials: unknown[] = []
    const unsubscribe = h.k.events.subscribe('risk.denials', (event) => denials.push(event.data))
    const proposal = await h.k.trading.propose({ accountId: h.paper.accountId, reason: 'denied proposal', intents: [orderIntent(h.paper.accountId, { reason: 'denied proposal' })] }, agent.ctx('propose'))
    expect(proposal.status).toBe('denied')
    const entry = [...h.k.ledger.iterate()].reverse().find((row) => row.type === 'risk.denied')!
    expect(entry.ruleHits).toContainEqual(expect.objectContaining({ code: 'STALE_PRICE', action: 'deny' }))
    expect(denials).toContainEqual(expect.objectContaining({ accountId: h.paper.accountId, precheckId: entry.subject.precheckId, ruleHits: entry.ruleHits }))
    expect(h.sim.submitted).toHaveLength(0)
    unsubscribe()
  })

  it('requires approval for another actor paper reduction and then issues a reduce gate ticket', async () => {
    h = await makeHarness()
    const opened = await h.k.trading.place({ intent: orderIntent(h.paper.accountId, { type: 'market', size: asDecimal('0.005'), price: undefined }) }, h.human())
    expect(opened.order?.status).toBe('filled')
    const agent = await makeAgent(h, 'confirm')
    const proposal = await h.k.trading.propose({ accountId: h.paper.accountId, reason: 'reduce position', intents: [orderIntent(h.paper.accountId, { side: 'sell', type: 'market', size: asDecimal('0.002'), price: undefined, reduceOnly: true, reason: 'reduce position' })] }, agent.ctx('propose'))
    expect(proposal.status).toBe('pending')
    expect(h.sim.submitted).toHaveLength(1)
    const approved = await h.k.trading.approve(proposal.ticket, h.sessionProof(), h.human('proposal.approve'))
    expect(approved.status).toBe('executed')
    const closing = h.sim.submitted.at(-1)!
    expect(closing.intent).toMatchObject({ side: 'sell', reduceOnly: true })
    expect(closing.ctx.gate?.ticketId).toBeTruthy()
    expect(h.sim.positions.get(h.paper.accountId)?.[0]?.size).toBe('0.003')
  })
})
