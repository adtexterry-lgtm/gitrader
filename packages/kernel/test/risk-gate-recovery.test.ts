// SPDX-License-Identifier: CPAL-1.0
import { afterEach, describe, expect, it } from 'vitest'
import { makeHarness } from './helpers/harness'
import type { Harness } from './helpers/harness'
import { BTC } from './helpers/fake-connector'
import { ConnectorBus } from '../src/connector'
import { TradingService } from '../src/trading'
import { newClientOrderId } from '../src/util/ids'
import * as d from '../src/util/dec'
import type { Order, OrderIntent } from '../src/proto'
import type { VenueFill } from '@gitrader/protocol/connector'
import { ReservationBook } from '../src/risk-gate/reservations'
import type { ReservationRecord } from '../src/risk-gate/reservations'

let h: Harness | undefined
afterEach(async () => { await h?.cleanup() })

const intent = (accountId: string) => ({ accountId, instrumentId: BTC, side: 'buy', type: 'limit', size: '0.001', price: '80000', tif: 'gtc', clientOrderId: newClientOrderId() }) as OrderIntent

function restoredService(harness: Harness): TradingService {
  const bus = new ConnectorBus(harness.clock)
  bus.register(harness.sim)
  const service = new TradingService({ clock: harness.clock, db: harness.k.db, docs: harness.k.docs, ledger: harness.k.ledger, events: harness.k.events, accounts: harness.k.accounts, bus, risk: harness.k.risk, gate: harness.k.gate, tstate: harness.k.tstate, agents: harness.k.agents, orders: harness.k.orders, protectors: harness.k.protectors, installKey: harness.k.installKey })
  return service
}

describe('reservation recovery', () => {
  it('records fresh missing observations and releases only after a distinct confirmation without expiring the order', async () => {
    h = await makeHarness()
    const placed = await h.k.trading.place({ intent: intent(h.paper.accountId) }, h.human())
    const order = placed.order!
    const book = (h.k.trading as unknown as { reservations: ReservationBook }).reservations

    h.clock.advance(1)
    await h.k.trading.reconcileReservations(await h.k.bus.snapshot(h.paper))
    h.sim.openOrdersOverride = []
    h.clock.advance(1)
    const missing = await h.k.bus.snapshot(h.paper)
    const first = await h.k.trading.reconcileReservations(missing)
    expect(first.released).toEqual([])
    const firstMiss = [...h.k.ledger.iterate()].reverse().find((entry) => entry.type === 'annotation' && (entry.payload as { kind?: string }).kind === 'reservation.observation' && (entry.payload as { state?: { missingCount?: number } }).state?.missingCount === 1)
    expect(firstMiss).toMatchObject({ type: 'annotation', subject: { accountId: h.paper.accountId, clientOrderId: order.clientOrderId }, payload: { kind: 'reservation.observation', state: { everObserved: true, missingCount: 1, lastObservationAt: missing.confirmedAt } } })

    const beforeRepeat = [...h.k.ledger.iterate()].length
    const repeated = await h.k.trading.reconcileReservations(missing)
    expect(repeated.released).toEqual([])
    expect([...h.k.ledger.iterate()].length).toBe(beforeRepeat)
    expect(d.gt(d.D(book.view(h.paper.accountId, h.clock.now(), 0).account.margin), d.ZERO)).toBe(true)

    h.clock.advance(1)
    const nextSnapshot = await h.k.bus.snapshot(h.paper)
    const second = await h.k.trading.reconcileReservations(nextSnapshot)
    expect(second.released).toEqual([order.clientOrderId])
    expect(second.unknownReleases).toEqual([{ clientOrderId: order.clientOrderId, reason: 'outcome-unknown', evidence: 'two-fresh-misses', missingSince: missing.confirmedAt, lastObservationAt: nextSnapshot.confirmedAt }])
    expect(h.k.orders.get(order.orderId)?.status).toBe('open')
    expect(book.view(h.paper.accountId, h.clock.now(), 0).account).toMatchObject({ margin: '0', notional: '0', count: 0 })
    const release = [...h.k.ledger.iterate()].reverse().find((entry) => entry.type === 'annotation' && (entry.payload as { kind?: string }).kind === 'reservation.released' && entry.subject.clientOrderId === order.clientOrderId)
    expect(release).toMatchObject({ payload: { reason: 'outcome-unknown', evidence: 'two-fresh-misses', missingSince: missing.confirmedAt, lastObservationAt: nextSnapshot.confirmedAt } })
  })

  it('restores a first miss and release tombstone, then accepts a late fill once without recreating budget', async () => {
    h = await makeHarness()
    const placed = await h.k.trading.place({ intent: intent(h.paper.accountId) }, h.human())
    const order = placed.order!
    h.clock.advance(1)
    await h.k.trading.reconcileReservations(await h.k.bus.snapshot(h.paper))
    h.sim.openOrdersOverride = []
    h.clock.advance(1)
    const firstMissing = await h.k.bus.snapshot(h.paper)
    await h.k.trading.reconcileReservations(firstMissing)

    const restoredAfterMiss = restoredService(h)
    const restoredBook = (restoredAfterMiss as unknown as { reservations: ReservationBook }).reservations
    expect(d.gt(d.D(restoredBook.view(h.paper.accountId, h.clock.now(), 0).account.margin), d.ZERO)).toBe(true)
    expect((await restoredAfterMiss.reconcileReservations(firstMissing)).released).toEqual([])

    h.clock.advance(1)
    const secondMissing = await h.k.bus.snapshot(h.paper)
    expect((await restoredAfterMiss.reconcileReservations(secondMissing)).released).toEqual([order.clientOrderId])
    const restoredAfterRelease = restoredService(h)
    const releasedBook = (restoredAfterRelease as unknown as { reservations: ReservationBook }).reservations
    expect(releasedBook.view(h.paper.accountId, h.clock.now(), 0).account).toMatchObject({ margin: '0', notional: '0', count: 0 })

    const lateFill: VenueFill = { venueOrderId: order.venueOrderId ?? 'venue-late', clientOrderId: order.clientOrderId as never, venueFillId: 'fill-late-once', instrumentId: BTC, side: order.side, price: order.price!, size: order.size, fee: '0' as never, feeCcy: 'USDC', liquidity: 'taker', realizedPnl: '0' as never, ts: h.clock.now() }
    releasedBook.outcome(h.paper.accountId, order.clientOrderId, { status: 'filled', filledSize: order.size })
    restoredAfterRelease.onVenueFill(h.paper.accountId, lateFill)
    restoredAfterRelease.onVenueFill(h.paper.accountId, lateFill)
    expect(h.k.orders.get(order.orderId)?.status).toBe('filled')
    expect(h.k.orders.fills({ orderId: order.orderId, limit: 10 }).filter((fill) => fill.venueFillId === lateFill.venueFillId)).toHaveLength(1)
    expect(releasedBook.view(h.paper.accountId, h.clock.now(), 0).account.count).toBe(0)
  })

  it('uses the default evidence TTL boundary and never expires stale unknowns without missing evidence', async () => {
    h = await makeHarness()
    const placed = await h.k.trading.place({ intent: intent(h.paper.accountId) }, h.human())
    const order = placed.order!
    h.clock.advance(1)
    await h.k.trading.reconcileReservations(await h.k.bus.snapshot(h.paper))
    h.sim.openOrdersOverride = []
    h.clock.advance(1)
    const firstMissing = await h.k.bus.snapshot(h.paper)
    await h.k.trading.reconcileReservations(firstMissing)
    const book = (h.k.trading as unknown as { reservations: ReservationBook }).reservations

    h.clock.advance(599_999)
    const beforeTtl = await h.k.trading.reconcileReservations({ ...firstMissing, stale: true })
    expect(beforeTtl.released).toEqual([])
    expect(book.view(h.paper.accountId, h.clock.now(), 0).account.count).toBe(1)
    h.clock.advance(1)
    const atTtl = await h.k.trading.reconcileReservations({ ...firstMissing, stale: true })
    expect(atTtl.released).toEqual([order.clientOrderId])
    expect(atTtl.unknownReleases).toEqual([{ clientOrderId: order.clientOrderId, reason: 'outcome-unknown', evidence: 'ttl', missingSince: firstMissing.confirmedAt, lastObservationAt: firstMissing.confirmedAt }])
    expect(h.k.orders.get(order.orderId)?.status).toBe('open')

    const noEvidenceId = 'cl-stale-no-evidence'
    book.reserve({ accountId: h.paper.accountId, clientOrderId: noEvidenceId, instrumentId: BTC, side: 'buy', size: '0.001' as never, margin: '80' as never, notional: '80' as never, issuedAt: h.clock.now(), expiresAt: h.clock.now() + 30_000, supportsExpiry: false, reduceOnly: false })
    book.outcome(h.paper.accountId, noEvidenceId, { status: 'unknown' })
    h.clock.advance(600_001)
    const noEvidence = book.reconcileReservations({ accountId: h.paper.accountId, now: h.clock.now(), fresh: false, availableDeductsOpenOrders: false, openOrders: [] })
    expect(noEvidence.released).not.toContain(noEvidenceId)
    expect(book.view(h.paper.accountId, h.clock.now(), 0).account.count).toBeGreaterThan(0)
  })

  it('keeps forked second-miss evaluation out of the real book and ledger', async () => {
    h = await makeHarness()
    const placed = await h.k.trading.place({ intent: intent(h.paper.accountId) }, h.human())
    const order = placed.order!
    h.clock.advance(1)
    await h.k.trading.reconcileReservations(await h.k.bus.snapshot(h.paper))
    h.sim.openOrdersOverride = []
    h.clock.advance(1)
    await h.k.trading.reconcileReservations(await h.k.bus.snapshot(h.paper))
    const book = (h.k.trading as unknown as { reservations: ReservationBook }).reservations
    const before = [...h.k.ledger.iterate()].length
    h.clock.advance(11_000)
    const preview = await h.k.trading.precheckIntent(intent(h.paper.accountId), h.human())
    expect(preview.verdict, JSON.stringify(preview.ruleHits.map(({ code, action, limit, actual }) => ({ code, action, limit, actual })))).toBe('allow')
    expect(book.view(h.paper.accountId, h.clock.now(), 0).account.count).toBe(1)
    expect([...h.k.ledger.iterate()].length).toBe(before)
    expect([...h.k.ledger.iterate()].some((entry) => entry.type === 'annotation' && entry.subject.clientOrderId === order.clientOrderId && (entry.payload as { kind?: string }).kind === 'reservation.released')).toBe(false)
  })

  it('rebuilds durable reservations from order-intent ledger evidence', async () => {
    h = await makeHarness()
    const result = await h.k.trading.place({ intent: intent(h.paper.accountId) }, h.human())
    const entry = [...h.k.ledger.iterate()].find((x) => x.type === 'order.intent')!
    expect(entry.payload).toHaveProperty('reservation.margin')
    const book = (restoredService(h) as unknown as { reservations: ReservationBook }).reservations
    expect(d.gt(d.D(book.view(h.paper.accountId, h.clock.now(), 0).account.margin), d.ZERO)).toBe(true)
    expect(result.order?.status).toBe('open')
  })

  it('restores more than one thousand active orders without list truncation', async () => {
    h = await makeHarness()
    for (let i = 0; i < 1001; i++) {
      const id = `ord_restore_${i}`
      const cloid = `cl_restore_${i}`
      const order = { orderId: id, clientOrderId: cloid, accountId: h.paper.accountId, instrumentId: BTC, side: 'buy', type: 'limit', tif: 'gtc', size: '0.001', filledSize: '0', price: '1', status: 'open', fee: '0', origin: h.human().origin, createdAt: h.clock.now() + i, updatedAt: h.clock.now() + i } as unknown as Order
      h.k.orders.upsert(order, '1', true)
    }
    const book = (restoredService(h) as unknown as { reservations: ReservationBook }).reservations
    expect(book.view(h.paper.accountId, h.clock.now() + 2000, 0).account.count).toBe(1001)
  })

  it('keeps a zero-valued legacy open order uncertain and fails the next open closed', async () => {
    h = await makeHarness()
    const old = { orderId: 'ord_legacy_zero', clientOrderId: 'cl_legacy_zero', accountId: h.paper.accountId, instrumentId: BTC, side: 'buy', type: 'limit', tif: 'gtc', size: '0.001', filledSize: '0', price: '80000', status: 'open', fee: '0', origin: h.human().origin, createdAt: h.clock.now(), updatedAt: h.clock.now() } as unknown as Order
    h.k.orders.upsert(old, '0', true)
    const service = restoredService(h)
    const decision = await service.precheckIntent(intent(h.paper.accountId), h.human())
    expect(decision.decision).toBe('BLOCK')
    expect(decision.ruleHits.map((hit) => hit.code)).toContain('ACCOUNT_UNKNOWN')
  })

  it('does not clear legacy uncertainty through a forked precheck but clears it on public fresh reconciliation', async () => {
    h = await makeHarness()
    const cloid = 'cl_legacy_match'
    const old = { orderId: 'ord_legacy_match', clientOrderId: cloid, accountId: h.paper.accountId, instrumentId: BTC, side: 'buy', type: 'limit', tif: 'gtc', size: '0.001', filledSize: '0', price: '80000', status: 'open', fee: '0', origin: h.human().origin, createdAt: h.clock.now() - 120_000, updatedAt: h.clock.now() - 120_000 } as unknown as Order
    h.k.orders.upsert(old, '0', true)
    h.sim.orders.push({ venueOrderId: 'venue_legacy_match', clientOrderId: cloid, accountId: h.paper.accountId, instrumentId: BTC, side: 'buy', type: 'limit', size: '0.001', price: '80000', reduceOnly: false, isTrigger: false, status: 'open', createdAt: h.clock.now() })
    const service = restoredService(h), uncertainty = (service as unknown as { uncertainOrders: Map<string, Set<string>> }).uncertainOrders
    expect(uncertainty.get(h.paper.accountId)?.has(cloid)).toBe(true)
    const preview = await service.precheckIntent({ ...intent(h.paper.accountId), size: '0.002' as never }, h.human())
    expect(preview.verdict, JSON.stringify(preview.ruleHits.map(({ code, action }) => ({ code, action })))).toBe('allow')
    expect(preview.ruleHits.map((hit) => hit.code)).not.toContain('ACCOUNT_UNKNOWN')
    expect(uncertainty.get(h.paper.accountId)?.has(cloid)).toBe(true)
    const result = await service.reconcileReservations(await h.k.bus.snapshot(h.paper))
    expect(result.complete).toBe(true)
    expect(uncertainty.get(h.paper.accountId)?.has(cloid) ?? false).toBe(false)
  })

  it('expires a supported unseen unknown through public reconciliation and retains unsupported unknowns', async () => {
    h = await makeHarness()
    const book = (h.k.trading as unknown as { reservations: ReservationBook }).reservations
    const makeRecord = (cloid: string, supportsExpiry: boolean): ReservationRecord => ({ accountId: h!.paper.accountId, clientOrderId: cloid, instrumentId: BTC, side: 'buy', size: '0.001' as never, margin: '10' as never, notional: '10' as never, issuedAt: h!.clock.now(), expiresAt: h!.clock.now() + 1000, supportsExpiry, reduceOnly: false })
    for (const supportsExpiry of [true, false]) {
      const cloid = supportsExpiry ? 'cl_expiry_supported' : 'cl_expiry_unsupported'
      const order = { orderId: `ord_${cloid}`, clientOrderId: cloid, accountId: h.paper.accountId, instrumentId: BTC, side: 'buy', type: 'limit', tif: 'gtc', size: '0.001', filledSize: '0', price: '80000', status: 'open', fee: '0', origin: h.human().origin, createdAt: h.clock.now(), updatedAt: h.clock.now() } as unknown as Order
      h.k.orders.upsert(order, '10', true)
      book.reserve(makeRecord(cloid, supportsExpiry)); book.markRecorded(h.paper.accountId, cloid); book.outcome(h.paper.accountId, cloid, { status: 'unknown' })
    }
    h.clock.advance(2000)
    const snapshot = await h.k.bus.snapshot(h.paper)
    const result = await h.k.trading.reconcileReservations(snapshot)
    expect(result.released).toContain('cl_expiry_supported')
    expect(result.retainedUnknown).toContain('cl_expiry_unsupported')
    expect(h.k.orders.byClientOrderId('cl_expiry_supported')?.status).toBe('expired')
    const expired = [...h.k.ledger.iterate()].find((entry) => entry.type === 'order.expired' && entry.subject.clientOrderId === 'cl_expiry_supported')
    expect(expired?.origin).toMatchObject({ actor: 'system:kernel', actorType: 'system', via: 'internal' })
    expect([...h.k.ledger.iterate()].some((entry) => entry.type === 'annotation' && (entry.payload as { kind?: string }).kind === 'reservation_reconcile')).toBe(true)
  })

  it('expires and audits a supported unknown during real control assembly', async () => {
    h = await makeHarness()
    const cloid = 'cl_control_expiry'
    const order = { orderId: 'ord_control_expiry', clientOrderId: cloid, accountId: h.paper.accountId, instrumentId: BTC, side: 'buy', type: 'limit', tif: 'gtc', size: '0.001', filledSize: '0', price: '80000', status: 'submitted', fee: '0', origin: h.human().origin, createdAt: h.clock.now(), updatedAt: h.clock.now() } as unknown as Order
    h.k.orders.upsert(order, '80', true)
    const book = (h.k.trading as unknown as { reservations: ReservationBook }).reservations
    book.reserve({ accountId: h.paper.accountId, clientOrderId: cloid, instrumentId: BTC, side: 'buy', size: '0.001' as never, margin: '80' as never, notional: '80' as never, issuedAt: h.clock.now(), expiresAt: h.clock.now() + 1000, supportsExpiry: true, reduceOnly: false })
    book.markRecorded(h.paper.accountId, cloid); book.outcome(h.paper.accountId, cloid, { status: 'unknown' })
    h.clock.advance(2000)
    await h.k.trading.systemCancelAll(h.paper)
    expect(h.k.orders.byClientOrderId(cloid)?.status).toBe('expired')
    expect([...h.k.ledger.iterate()].some((entry) => entry.type === 'annotation' && (entry.payload as { released?: string[] }).released?.includes(cloid))).toBe(true)
  })
})
