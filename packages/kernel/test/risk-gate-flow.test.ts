// SPDX-License-Identifier: CPAL-1.0
import { afterEach, describe, expect, it } from 'vitest'
import { BTC } from './helpers/fake-connector'
import { enableLive, makeAgent, makeHarness } from './helpers/harness'
import type { Harness } from './helpers/harness'
import type { RiskPolicy, Position, OrderIntent } from '../src/proto'
import { mkOrigin } from '../src/util/origin'
import { newClientOrderId } from '../src/util/ids'
import { ReservationBook } from '../src/risk-gate/reservations'
import * as dec from '../src/util/dec'
import { InstallKey } from '../src/install-key'
import { asDecimal, type AccountId } from '@gitrader/protocol'
import type { Proposal } from '../src/proto'
import { digestOf } from '../src/util/hash'
import { gateTargetDigest } from '../src/risk-gate/assemble'
import type { ActorCtx } from '../src/trading'
import type { PolicyPatch } from '../src/risk'

let h: Harness | undefined
afterEach(async () => { await h?.cleanup() })

async function policyLimits(harness: Harness, patch: NonNullable<PolicyPatch['limits']>): Promise<void> {
  await harness.k.risk.relax({ limits: { ...patch, duplicateIntentWindowSec: 0 }, protectors: [] }, await harness.pinProof(), harness.human('risk.relax').origin)
}

function installSignedSizeLimit(harness: Harness, maxOrderNotional = '500'): void {
  const current = harness.k.risk.current()!
  const { attestation: _attestation, ...currentBody } = current
  const body = { ...currentBody, limits: { ...current.limits, maxOrderNotional: asDecimal(maxOrderNotional), duplicateIntentWindowSec: 0 }, limitMode: { size: true } }
  const digest = digestOf(body)
  harness.k.docs.put('policy', current.policyId, { ...body, attestation: { ...current.attestation, digest, sig: harness.k.installKey.sign(digest) } }, current.version)
  expect(harness.k.risk.verify().ok).toBe(true)
}

function pos(accountId: string, size: string): Position {
  return { accountId: accountId as AccountId, instrumentId: BTC, side: 'long', size: asDecimal(size), entryPrice: asDecimal('100'), markPrice: asDecimal('100'), notional: asDecimal(String(Number(size) * 100)), unrealizedPnl: asDecimal('0'), realizedPnl: asDecimal('0'), leverage: 1, marginMode: 'cross', liquidationPrice: null, fundingSinceOpen: asDecimal('0'), openedAt: 0, updatedAt: 0 }
}

const orderIntent = (accountId: AccountId, size: string, extra: Partial<OrderIntent> = {}): OrderIntent => ({
  accountId, instrumentId: BTC, side: 'buy', type: 'limit', size: asDecimal(size), price: asDecimal('80000'), tif: 'gtc', clientOrderId: newClientOrderId(), ...extra,
})

describe('public order-flow gate and reservations', () => {
  it('serializes two live orders against the same available margin', async () => {
    h = await makeHarness(); h.live.equity = dec.D('100')
    await enableLive(h)
    await policyLimits(h, { maxPositionNotionalRatio: null, maxTotalNotionalRatio: null, maxDailyNotional: null, maxDailyOrders: null, maxOrdersPerMinute: null, maxOpenPositions: null, maxOrderNotional: '1000000' as never })
    const results = await Promise.all([
      h.k.trading.place({ intent: orderIntent(h.liveAcct.accountId, '0.00075') }, h.human()),
      h.k.trading.place({ intent: orderIntent(h.liveAcct.accountId, '0.00075') }, h.human()),
    ])
    expect(results.filter((r) => r.order?.status === 'open' || r.order?.status === 'untriggered' || r.order?.status === 'submitted')).toHaveLength(1)
    expect(results.filter((r) => r.order?.status === 'denied')).toHaveLength(1)
    expect(results.find((r) => r.order?.status === 'denied')?.order?.problem?.ruleHits).toContainEqual(expect.objectContaining({ code: 'INSUFFICIENT_MARGIN' }))
    expect(h.live.submitted).toHaveLength(1)
  })

  it('serializes two opens against the single-position exposure cap', async () => {
    h = await makeHarness(); h.sim.equity = dec.D('1000')
    await policyLimits(h, { maxOrderNotional: '1000' as never, maxPositionNotionalRatio: '0.1' as never, maxTotalNotionalRatio: null, maxDailyNotional: null, maxDailyOrders: null, maxOrdersPerMinute: null, maxOpenPositions: null })
    const results = await Promise.all([
      h.k.trading.place({ intent: orderIntent(h.paper.accountId, '0.00075') }, h.human()),
      h.k.trading.place({ intent: orderIntent(h.paper.accountId, '0.00075') }, h.human()),
    ])
    expect(results.filter((r) => r.order?.status === 'open' || r.order?.status === 'untriggered' || r.order?.status === 'submitted')).toHaveLength(1)
    expect(results.filter((r) => r.order?.status === 'denied')).toHaveLength(1)
    expect(results.find((r) => r.order?.status === 'denied')?.order?.problem?.ruleHits).toContainEqual(expect.objectContaining({ code: 'POSITION_NOTIONAL' }))
    expect(h.sim.submitted).toHaveLength(1)
  })

  it('reclassifies an ordinary reverse order after a resting reduction consumes reserved size', async () => {
    h = await makeHarness(); h.sim.marks.set(BTC, '100'); h.sim.equity = dec.D('1000')
    h.sim.positions.set(h.paper.accountId, [pos(h.paper.accountId, '3')])
    await policyLimits(h, { maxOrderNotional: '1000' as never, maxPositionNotionalRatio: '0.4' as never, maxTotalNotionalRatio: null, maxDailyNotional: null, maxDailyOrders: null, maxOrdersPerMinute: null, maxOpenPositions: null })
    const first = await h.k.trading.place({ intent: orderIntent(h.paper.accountId, '2', { side: 'sell', price: asDecimal('100') }) }, h.human())
    expect(first.order?.reduceOnly).toBe(true)
    expect(['open', 'untriggered']).toContain(first.order?.status)
    const second = await h.k.trading.place({ intent: orderIntent(h.paper.accountId, '2', { side: 'sell', price: asDecimal('100') }) }, h.human())
    expect(second.order?.status).toBe('denied')
    expect(second.order?.problem?.ruleHits).toContainEqual(expect.objectContaining({ code: 'POSITION_NOTIONAL' }))
    expect(second.order?.reduceOnly).not.toBe(true)
    expect(h.k.ledger.query({ types: ['risk.denied'] }).at(-1)?.payload).toHaveProperty('gate.decision.action', 'open')
    expect(h.k.ledger.query({ types: ['risk.denied'] }).at(-1)?.payload).not.toHaveProperty('gate.target.intent.reduceOnly', true)
    expect(h.sim.submitted).toHaveLength(1)
  })

  it('reclassifies concurrent ordinary reverse orders under the same reservation queue', async () => {
    h = await makeHarness(); h.sim.marks.set(BTC, '100'); h.sim.equity = dec.D('1000')
    h.sim.positions.set(h.paper.accountId, [pos(h.paper.accountId, '3')])
    await policyLimits(h, { maxOrderNotional: '1000' as never, maxPositionNotionalRatio: '0.4' as never, maxTotalNotionalRatio: null, maxDailyNotional: null, maxDailyOrders: null, maxOrdersPerMinute: null, maxOpenPositions: null })
    const results = await Promise.all([
      h.k.trading.place({ intent: orderIntent(h.paper.accountId, '2', { side: 'sell', price: asDecimal('100') }) }, h.human()),
      h.k.trading.place({ intent: orderIntent(h.paper.accountId, '2', { side: 'sell', price: asDecimal('100') }) }, h.human()),
    ])
    expect(results.filter((r) => r.order?.status === 'open' || r.order?.status === 'untriggered' || r.order?.status === 'submitted')).toHaveLength(1)
    expect(results.filter((r) => r.order?.status === 'denied')).toHaveLength(1)
    expect(results.find((r) => r.order?.status === 'open' || r.order?.status === 'untriggered' || r.order?.status === 'submitted')?.order?.reduceOnly).toBe(true)
    expect(results.find((r) => r.order?.status === 'denied')?.order?.problem?.ruleHits).toContainEqual(expect.objectContaining({ code: 'POSITION_NOTIONAL' }))
    expect(h.k.ledger.query({ types: ['risk.denied'] }).at(-1)?.payload).toHaveProperty('gate.decision.action', 'open')
    expect(h.sim.submitted).toHaveLength(1)
  })

  it('allows exactly five of ten $20 orders under a $100 position cap', async () => {
    h = await makeHarness(); h.sim.equity = dec.D('1000')
    await policyLimits(h, { maxOrderNotional: '1000' as never, maxPositionNotionalRatio: '0.1' as never, maxTotalNotionalRatio: null, maxDailyNotional: null, maxDailyOrders: null, maxOrdersPerMinute: null, maxOpenPositions: null })
    const results = await Promise.all(Array.from({ length: 10 }, () => h!.k.trading.place({ intent: orderIntent(h!.paper.accountId, '0.00025') }, h!.human())))
    for (const result of results.filter((r) => r.order?.status === 'denied')) expect(result.order?.problem?.ruleHits).toContainEqual(expect.objectContaining({ code: 'POSITION_NOTIONAL' }))
    expect(results.filter((r) => r.order?.status === 'open' || r.order?.status === 'untriggered' || r.order?.status === 'submitted'), JSON.stringify(results.map((r) => ({ status: r.order?.status, codes: r.order?.problem?.ruleHits?.map((hit) => hit.code) })))).toHaveLength(5)
    expect(results.filter((r) => r.order?.status === 'denied')).toHaveLength(5)
    expect(h.sim.submitted).toHaveLength(5)
    expect(h.k.ledger.query({ types: ['risk.denied'] }).filter((entry) => entry.ruleHits?.some((hit) => hit.code === 'POSITION_NOTIONAL'))).toHaveLength(5)
  })

  it('keeps a LIMIT preview capped and lets the original raw intent retry idempotently', async () => {
    h = await makeHarness()
    const current = h.k.risk.current.bind(h.k.risk)
    h.k.risk.current = (() => { const p = current(); return p ? { ...p, limits: { ...p.limits, maxOrderNotional: '500' as never }, limitMode: { size: true } } : null }) as typeof h.k.risk.current
    const raw = orderIntent(h.paper.accountId, '0.01', { allowAdjust: ['size'], reason: 'limit retry' })
    const preview = await h.k.trading.preview(raw, h.human())
    expect(preview.precheck.decision).toBe('LIMIT')
    const placed = await h.k.trading.place({ confirmToken: preview.confirmToken! }, h.human())
    const retry = await h.k.trading.place({ intent: raw }, h.human())
    expect(placed.order?.size).toBe('0.00625')
    expect(retry.order?.orderId).toBe(placed.order?.orderId)
    expect(h.sim.submitted).toHaveLength(1)
  })

  it('reclassifies a preview-inferred reduction using the fresh position', async () => {
    h = await makeHarness(); h.sim.marks.set(BTC, '100'); h.sim.positions.set(h.paper.accountId, [pos(h.paper.accountId, '1')])
    await policyLimits(h, { maxPositionNotionalRatio: null, maxTotalNotionalRatio: null })
    const raw = orderIntent(h.paper.accountId, '0.5', { side: 'sell', price: asDecimal('100'), reason: 'fresh classification' })
    const preview = await h.k.trading.preview(raw, h.human())
    expect(preview.normalizedIntent.reduceOnly).toBe(true)
    h.sim.positions.set(h.paper.accountId, [])
    const result = await h.k.trading.place({ confirmToken: preview.confirmToken! }, h.human())
    expect(result.order?.status).toBe('open')
    expect(result.order?.reduceOnly).not.toBe(true)
  })

  it('rejects a capped preview after policy changes instead of growing its size', async () => {
    h = await makeHarness()
    await h.k.risk.tighten({ limits: { maxOrderNotional: '500' as never } }, h.sessionProof(), h.human('risk.tighten').origin)
    const original = h.k.risk.current.bind(h.k.risk)
    h.k.risk.current = (() => { const p = original(); return p ? { ...p, limitMode: { size: true } } as RiskPolicy : null }) as typeof h.k.risk.current
    const raw = orderIntent(h.paper.accountId, '0.01', { allowAdjust: ['size'], reason: 'policy version check' })
    const preview = await h.k.trading.preview(raw, h.human())
    await h.k.risk.relax({ limits: { maxOrderNotional: '1000' as never } }, await h.pinProof(), h.human('risk.relax').origin)
    await expect(h.k.trading.place({ confirmToken: preview.confirmToken! }, h.human())).rejects.toMatchObject({ problem: { name: 'CONFIRM_TOKEN_INVALID' } })
    expect(h.sim.submitted).toHaveLength(0)
  })

  it('routes a final live L2 review into a pending proposal without reserving', async () => {
    h = await makeHarness(); await enableLive(h)
    const mandate = h.k.agents.issueMandate({ subject: { type: 'engine', id: 'engine-test' }, level: 'L2', accounts: [h.liveAcct.accountId], venueAllowlist: ['hyperliquid'], instrumentAllowlist: [BTC], limits: { maxOrderNotional: '1500', maxDailyNotional: '5000' } } as never, await h.pinProof(), h.human('mandate.issue').origin)
    const ctx: ActorCtx = { principal: { kind: 'engine', engineId: 'engine-test', mandateId: mandate.mandateId }, origin: mkOrigin('engine:engine-test', 'engine.order', 'gep') }
    const result = await h.k.trading.place({ intent: orderIntent(h.liveAcct.accountId, '0.01', { reason: 'L2 review' }) }, ctx)
    expect(result.proposal?.status).toBe('pending')
    expect(h.live.submitted).toHaveLength(0)
    const book = (h.k.trading as unknown as { reservations: ReservationBook }).reservations
    expect(book.view(h.liveAcct.accountId, h.clock.now(), 0).account.margin).toBe('0')
    const entries = h.k.ledger.query({ types: ['risk.precheck'] })
    expect(entries).toHaveLength(1)
    expect(entries.at(-1)?.payload).toHaveProperty('path', 'proposal')
    expect(entries.at(-1)?.payload).toHaveProperty('gate.decision.attestation.sig')
  })

  it('stores the capped size in a live L2 review and does not grow it when approved', async () => {
    h = await makeHarness(); await enableLive(h); installSignedSizeLimit(h)
    const mandate = h.k.agents.issueMandate({ subject: { type: 'engine', id: 'engine-limit-review' }, level: 'L2', accounts: [h.liveAcct.accountId], venueAllowlist: ['hyperliquid'], instrumentAllowlist: [BTC], limits: { maxOrderNotional: '1500', maxDailyNotional: '5000' } } as never, await h.pinProof(), h.human('mandate.issue').origin)
    const ctx: ActorCtx = { principal: { kind: 'engine', engineId: 'engine-limit-review', mandateId: mandate.mandateId }, origin: mkOrigin('engine:engine-limit-review', 'engine.order', 'gep') }
    const result = await h.k.trading.place({ intent: orderIntent(h.liveAcct.accountId, '0.01', { allowAdjust: ['size'], reason: 'L2 size cap' }) }, ctx)
    const proposal = result.proposal!
    const intents = proposal.intents as OrderIntent[]
    const entry = h.k.ledger.query({ types: ['risk.precheck'] }).at(-1)!
    const gate = (entry.payload as { gate: { decision: { decision: string; verdict: string; applied: unknown[] }; target: { kind: 'order'; intent: OrderIntent } } }).gate
    expect(proposal.status).toBe('pending')
    expect(gate.decision).toMatchObject({ decision: 'BLOCK', verdict: 'review' })
    expect(gate.decision.applied.length).toBeGreaterThan(0)
    expect(intents[0]?.size).toBe('0.00625')
    expect(proposal.intentsDigest).toBe(digestOf(intents))
    expect(gate.target.intent.size).toBe('0.01')
    const adjustedIntent = intents[0]
    if (!adjustedIntent || adjustedIntent.size === undefined || adjustedIntent.tif === undefined || adjustedIntent.clientOrderId === undefined) throw Error('proposal intent is not normalized')
    const normalizedAdjusted = { ...adjustedIntent, size: adjustedIntent.size, tif: adjustedIntent.tif, clientOrderId: adjustedIntent.clientOrderId }
    expect(gate.decision).toHaveProperty('adjustedTargetDigest', gateTargetDigest({ kind: 'order', intent: normalizedAdjusted }))
    expect(h.live.submitted).toHaveLength(0)
    const book = (h.k.trading as unknown as { reservations: ReservationBook }).reservations
    expect(book.view(h.liveAcct.accountId, h.clock.now(), 0).account.margin).toBe('0')
    await h.k.risk.relax({ limits: { maxOrderNotional: '1500' as never } }, await h.pinProof(), h.human('risk.relax').origin)
    const approved = await h.k.trading.approve(proposal.ticket, h.sessionProof(), h.human('proposal.approve'))
    expect(approved.status).toBe('executed')
    expect(h.live.submitted[0]?.intent.size).toBe('0.00625')
  })

  it('stores each capped live confirm-agent proposal leg while preserving each raw gate target', async () => {
    h = await makeHarness(); installSignedSizeLimit(h)
    const agent = await makeAgent(h, 'confirm', { limits: { maxOrderNotional: '1500' as never, maxDailyNotional: '5000' as never, maxDailyLoss: '100' as never } })
    const proposal = await h.k.trading.propose({ accountId: h.liveAcct.accountId, forcePending: true, reason: 'two capped legs', intents: [
      orderIntent(h.liveAcct.accountId, '0.01', { allowAdjust: ['size'], reason: 'first capped leg' }),
      orderIntent(h.liveAcct.accountId, '0.01', { allowAdjust: ['size'], reason: 'second capped leg' }),
    ] }, agent.ctx('propose'))
    const intents = proposal.intents as OrderIntent[]
    const entries = h.k.ledger.query({ types: ['risk.precheck'] })
    expect(proposal.status).toBe('pending')
    expect(intents.map((i) => i.size)).toEqual(['0.00625', '0.00625'])
    expect(proposal.intentsDigest).toBe(digestOf(intents))
    expect(entries).toHaveLength(2)
    for (const entry of entries) {
      const gate = (entry.payload as { gate: { decision: { decision: string; verdict: string; applied: unknown[] }; target: { kind: 'order'; intent: OrderIntent } } }).gate
      expect(gate.decision).toMatchObject({ decision: 'BLOCK', verdict: 'review' })
      expect(gate.decision.applied.length).toBeGreaterThan(0)
      expect(gate.target.intent.size).toBe('0.01')
    }
    expect(h.live.submitted).toHaveLength(0)
    const book = (h.k.trading as unknown as { reservations: ReservationBook }).reservations
    expect(book.view(h.liveAcct.accountId, h.clock.now(), 0).account.margin).toBe('0')
  })

  it('tracks a live L3 LIMITED execution with the applied size and original signed target', async () => {
    h = await makeHarness(); await enableLive(h); installSignedSizeLimit(h)
    const mandate = h.k.agents.issueMandate({ subject: { type: 'engine', id: 'engine-limit-direct' }, level: 'L3', accounts: [h.liveAcct.accountId], venueAllowlist: ['hyperliquid'], instrumentAllowlist: [BTC], limits: { maxOrderNotional: '1500', maxDailyNotional: '5000', autoMaxOrderNotional: '1000', maxDailyLoss: '100' } } as never, await h.pinProof(), h.human('mandate.issue').origin)
    const ctx: ActorCtx = { principal: { kind: 'engine', engineId: 'engine-limit-direct', mandateId: mandate.mandateId }, origin: mkOrigin('engine:engine-limit-direct', 'engine.order', 'gep') }
    const result = await h.k.trading.place({ intent: orderIntent(h.liveAcct.accountId, '0.01', { allowAdjust: ['size'], reason: 'L3 size cap' }) }, ctx)
    const proposal = result.proposal as Proposal
    const intentEntry = h.k.ledger.query({ types: ['order.intent'] }).at(-1)!
    const gate = (intentEntry.payload as { intent: OrderIntent; gate: { decision: { decision: string }; target: { kind: 'order'; intent: OrderIntent } } }).gate
    expect(result.order?.size).toBe('0.00625')
    expect(h.live.submitted[0]?.intent.size).toBe('0.00625')
    expect(proposal.intents).toMatchObject([{ size: '0.00625' }])
    expect(proposal.status).toBe('executed')
    expect(gate.decision.decision).toBe('LIMIT')
    expect(gate.target.intent.size).toBe('0.01')
    expect((intentEntry.payload as { intent: OrderIntent }).intent.size).toBe('0.00625')
  })

  it('keeps original notional for L3 auto approval when a lower risk cap applies LIMIT', async () => {
    h = await makeHarness(); await enableLive(h); installSignedSizeLimit(h, '200')
    const mandate = h.k.agents.issueMandate({ subject: { type: 'engine', id: 'engine-original-auto-review' }, level: 'L3', accounts: [h.liveAcct.accountId], venueAllowlist: ['hyperliquid'], instrumentAllowlist: [BTC], limits: { maxOrderNotional: '1500', maxDailyNotional: '5000', autoMaxOrderNotional: '300', maxDailyLoss: '100' } } as never, await h.pinProof(), h.human('mandate.issue').origin)
    const ctx: ActorCtx = { principal: { kind: 'engine', engineId: 'engine-original-auto-review', mandateId: mandate.mandateId }, origin: mkOrigin('engine:engine-original-auto-review', 'engine.order', 'gep') }
    const raw = orderIntent(h.liveAcct.accountId, '0.0125', { allowAdjust: ['size'], reason: 'original notional approval' })
    const result = await h.k.trading.place({ intent: raw }, ctx)
    expect(result.problem?.name).toBe('NEEDS_APPROVAL')
    const proposal = result.proposal as Proposal
    expect(proposal.status).toBe('pending')
    expect(proposal.intents).toMatchObject([{ size: '0.0025' }])
    const entry = h.k.ledger.query({ types: ['risk.precheck'] }).at(-1)!
    const gate = (entry.payload as { gate: { decision: { decision: string; verdict: string; applied: unknown[]; ruleHits: Array<{ code: string; actual: string; limit: string }> }; target: { kind: 'order'; intent: OrderIntent } } }).gate
    expect(gate.decision).toMatchObject({ decision: 'BLOCK', verdict: 'review' })
    expect(gate.decision.applied).toContainEqual(expect.objectContaining({ code: 'ORDER_NOTIONAL', from: '0.0125', to: '0.0025' }))
    expect(gate.decision.ruleHits).toContainEqual(expect.objectContaining({ code: 'NEEDS_APPROVAL', actual: '1000', limit: '300' }))
    expect(gate.target.intent.size).toBe('0.0125')
    expect(h.live.submitted).toHaveLength(0)
    const book = (h.k.trading as unknown as { reservations: ReservationBook }).reservations
    expect(book.view(h.liveAcct.accountId, h.clock.now(), 0).account.margin).toBe('0')
  })

  it('does not mutate an order from an event naming a different account', async () => {
    h = await makeHarness()
    const result = await h.k.trading.place({ intent: orderIntent(h.paper.accountId, '0.01') }, h.human())
    const order = result.order!
    const before = h.k.ledger.head().seq
    h.k.trading.onVenueFill('acct_OTHER', { venueOrderId: 'venue-mismatch', clientOrderId: order.clientOrderId, venueFillId: 'fill-mismatch', instrumentId: BTC, side: 'buy', price: '80000', size: '0.001', fee: '0', feeCcy: 'USDC', liquidity: 'taker', realizedPnl: '0', ts: h.clock.now() } as never)
    h.k.trading.onOrderUpdate('acct_OTHER', { venueOrderId: 'venue-mismatch', clientOrderId: order.clientOrderId, status: 'cancelled' })
    expect(h.k.orders.get(order.orderId)?.status).toBe(order.status)
    expect(h.k.ledger.head().seq).toBe(before)
  })

  it('stores independently signed gate decisions for proposal legs and a plain aggregate result', async () => {
    h = await makeHarness()
    const agent = await makeAgent(h, 'confirm')
    const decisions: Array<{ dryRun: boolean }> = []
    const decide = h.k.gate.decide.bind(h.k.gate)
    h.k.gate.decide = ((input) => { decisions.push({ dryRun: input.dryRun }); return decide(input) }) as typeof h.k.gate.decide
    const proposal = await h.k.trading.propose({ accountId: h.paper.accountId, forcePending: true, reason: 'two legs', intents: [
      orderIntent(h.paper.accountId, '0.001', { reason: 'first leg' }), orderIntent(h.paper.accountId, '0.002', { reason: 'second leg' }),
    ] }, agent.ctx('propose'))
    expect(proposal.intents).toHaveLength(2)
    expect(proposal.status).toBe('pending')
    expect(decisions).toHaveLength(2)
    expect(decisions.every((input) => input.dryRun === false)).toBe(true)
    expect(proposal.precheck).not.toHaveProperty('decision')
    const entries = h.k.ledger.query({ types: ['risk.precheck'] })
    expect(entries).toHaveLength(2)
    for (const entry of entries) {
      const gate = (entry.payload as { gate?: { decision?: { attestation?: { digest: string; sig: string } } } }).gate
      expect(gate?.decision?.attestation?.sig).toBeDefined()
      expect(InstallKey.verify(h.k.installKey.publicKey, gate!.decision!.attestation!.digest, gate!.decision!.attestation!.sig)).toBe(true)
    }
    const book = (h.k.trading as unknown as { reservations: ReservationBook }).reservations
    expect(book.view(h.paper.accountId, h.clock.now(), 0).account.margin).toBe('0')
  })

  it('waits for human approval before executing both confirm-tier paper legs exactly once', async () => {
    h = await makeHarness()
    await policyLimits(h, { maxOrderNotional: '1000000' as never, maxPositionNotionalRatio: null, maxTotalNotionalRatio: null, maxDailyNotional: null, maxDailyOrders: null, maxOrdersPerMinute: null, maxOpenPositions: null })
    const agent = await makeAgent(h, 'confirm')
    const proposal = await h.k.trading.propose({ accountId: h.paper.accountId, reason: 'paper auto', intents: [
      orderIntent(h.paper.accountId, '0.001', { reason: 'leg one' }), orderIntent(h.paper.accountId, '0.002', { reason: 'leg two' }),
    ] }, agent.ctx('propose'))
    expect(proposal.status).toBe('pending')
    expect(h.sim.submitted).toHaveLength(0)
    const approved = await h.k.trading.approve(proposal.ticket, h.sessionProof(), h.human('proposal.approve'))
    expect(approved.status).toBe('executed')
    expect(approved.execution?.orderIds).toHaveLength(2)
    expect(h.sim.submitted).toHaveLength(2)
  })

  it('executes both legs of a human-approved proposal exactly once', async () => {
    h = await makeHarness()
    await policyLimits(h, { maxOrderNotional: '1000000' as never, maxPositionNotionalRatio: null, maxTotalNotionalRatio: null, maxDailyNotional: null, maxDailyOrders: null, maxOrdersPerMinute: null, maxOpenPositions: null })
    const agent = await makeAgent(h, 'confirm')
    const pending = await h.k.trading.propose({ accountId: h.paper.accountId, forcePending: true, reason: 'manual approval', intents: [
      orderIntent(h.paper.accountId, '0.001', { reason: 'leg one' }), orderIntent(h.paper.accountId, '0.002', { reason: 'leg two' }),
    ] }, agent.ctx('propose'))
    expect(pending.status).toBe('pending')
    const approved = await h.k.trading.approve(pending.ticket, h.sessionProof(), h.human('proposal.approve'))
    expect(approved.status).toBe('executed')
    expect(approved.execution?.orderIds).toHaveLength(2)
    expect(h.sim.submitted).toHaveLength(2)
  })

  it('fails approval cleanly when the fresh venue mark exceeds proposal bounds', async () => {
    h = await makeHarness(); h.live.marks.set(BTC, '100')
    const agent = await makeAgent(h, 'confirm')
    const pending = await h.k.trading.propose({ accountId: h.paper.accountId, forcePending: true, reason: 'bounded approval', intents: [
      orderIntent(h.paper.accountId, '0.001', { reason: 'bounded leg' }),
    ] }, agent.ctx('propose'))
    expect(pending.status).toBe('pending')
    expect(pending.priceBounds).toMatchObject({ referencePrice: '100', maxDriftBps: 30 })
    h.live.marks.set(BTC, '101')
    expect((await h.k.bus.gateMark(BTC))?.price).toBe('101')
    const proposalEvents: string[] = []
    const unsubscribe = h.k.events.subscribe('proposal.*', (event) => proposalEvents.push(event.topic))
    const failed = await h.k.trading.approve(pending.ticket, h.sessionProof(), h.human('proposal.approve'))
    expect(failed.status).toBe('failed')
    expect(failed.execution?.problem?.name).toBe('PRICE_DRIFT')
    expect(h.k.ledger.query({ types: ['proposal.failed'] })).toHaveLength(1)
    expect(h.k.ledger.query({ types: ['proposal.executed'] })).toHaveLength(0)
    expect(proposalEvents).toContain('proposal.failed')
    expect(proposalEvents).not.toContain('proposal.executed')
    unsubscribe()
    expect(failed.execution?.orderIds).toHaveLength(0)
    expect(h.sim.submitted).toHaveLength(0)
    const book = (h.k.trading as unknown as { reservations: ReservationBook }).reservations
    expect(book.view(h.paper.accountId, h.clock.now(), 0).account.margin).toBe('0')
  })

  it('uses contract size in approval presence totals for normalized notional orders', async () => {
    h = await makeHarness()
    h.live.instrumentsList[0] = { ...h.live.instrumentsList[0]!, contractSize: '10' as never, venueSizeUnit: 'contract' }
    h.sim.marks.set(BTC, '100')
    await policyLimits(h, { maxOrderNotional: '2000' as never, maxPositionNotionalRatio: null, maxTotalNotionalRatio: null, maxDailyNotional: null, maxDailyOrders: null })
    const agent = await makeAgent(h, 'confirm', { limits: { maxOrderNotional: '2000' as never, maxDailyNotional: '5000' as never, maxDailyLoss: '100' as never }, approval: { presenceAboveNotional: '500' as never } })
    const proposal = await h.k.trading.propose({ accountId: h.paper.accountId, forcePending: true, reason: 'contract multiplier', intents: [
      { accountId: h.paper.accountId, instrumentId: BTC, side: 'buy', type: 'limit', notional: asDecimal('1000'), price: asDecimal('100'), tif: 'gtc', clientOrderId: newClientOrderId(), reason: 'contract multiplier' },
    ] }, agent.ctx('propose'))
    expect(proposal.status, JSON.stringify(proposal.precheck.ruleHits.map(({ code, action }) => ({ code, action })))).toBe('pending')
    expect((proposal.intents as Array<{ size: string }>)[0]?.size).toBe('1')
    expect(h.k.trading.approvalNeedsPin(proposal.ticket)).toBe(true)
    await expect(h.k.trading.approve(proposal.ticket, h.sessionProof(), h.human('proposal.approve'))).rejects.toMatchObject({ problem: { name: 'ATTESTATION_REQUIRED' } })
    expect(h.sim.submitted).toHaveLength(0)
    const approved = await h.k.trading.approve(proposal.ticket, await h.pinProof(), h.human('proposal.approve'))
    expect(approved.status).toBe('executed')
    expect(h.k.ledger.query({ types: ['proposal.decided'] }).at(-1)?.payload).toHaveProperty('notional', '1000')
    expect(h.sim.submitted).toHaveLength(1)
  })

  it('releases reserved margin when the durable intent transaction fails before submit', async () => {
    h = await makeHarness(); h.sim.equity = dec.D('100')
    await policyLimits(h, { maxOrderNotional: '1000000' as never, maxPositionNotionalRatio: null, maxTotalNotionalRatio: null, maxDailyNotional: null, maxDailyOrders: null, maxOrdersPerMinute: null, maxOpenPositions: null })
    const book = (h.k.trading as unknown as { reservations: ReservationBook }).reservations
    const docs = h.k.docs
    const put = docs.put.bind(docs)
    let failed = false
    docs.put = ((collection: string, id: string, value: unknown) => {
      if (!failed && collection === 'cloid') { failed = true; throw new Error('injected transaction failure') }
      return put(collection, id, value)
    }) as typeof docs.put
    await expect(h.k.trading.place({ intent: orderIntent(h.paper.accountId, '0.00075') }, h.human())).rejects.toThrow('injected transaction failure')
    docs.put = put as typeof docs.put
    expect(h.sim.submitted).toHaveLength(0)
    expect(book.view(h.paper.accountId, h.clock.now(), 0).account.margin).toBe('0')
    const next = await h.k.trading.place({ intent: orderIntent(h.paper.accountId, '0.00075') }, h.human())
    expect(next.order?.status).toBe('open')
    expect(h.sim.submitted).toHaveLength(1)
  })

  it('forces internal reduction orders to a system origin and binds the supplied cause', async () => {
    h = await makeHarness(); h.sim.marks.set(BTC, '100'); h.sim.positions.set(h.paper.accountId, [pos(h.paper.accountId, '1')])
    const supplied = mkOrigin('engine:external', 'engine.reduce', 'gep')
    const order = await h.k.trading.systemReduceOnly(h.paper, BTC, 'sell', '0.5', supplied)
    expect(order.origin).toMatchObject({ actor: 'system:kernel', actorType: 'system', requestId: supplied.requestId })
    expect(order.origin).not.toHaveProperty('causation')
    const entry = h.k.ledger.query({ types: ['order.intent'] }).at(-1)!
    expect(entry.origin).toMatchObject({ actor: 'system:kernel', actorType: 'system', requestId: supplied.requestId })
    expect(entry.origin).not.toHaveProperty('causation')
  })
})
