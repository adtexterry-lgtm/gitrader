// SPDX-License-Identifier: CPAL-1.0
import { describe, expect, it } from 'vitest'
import type { Decimal } from '@gitrader/protocol'
import { ReservationBook, type ReservationObservation, type ReservationRecord, type ReconcileView, type ValuedOpenOrder } from '../src/risk-gate/reservations'

const d = (value: string) => value as Decimal
const reservation = (overrides: Partial<ReservationRecord> = {}): ReservationRecord => ({
  accountId: 'acct-a', clientOrderId: 'cl-1', instrumentId: 'asset-a', side: 'buy',
  size: d('2'), margin: d('100'), notional: d('200'), issuedAt: 1_000, expiresAt: 2_000,
  supportsExpiry: true, reduceOnly: false, ...overrides,
})
type ObservationOverrides = Partial<ReconcileView> & { observationAt?: number; truncated?: boolean }
const reconcile = (overrides: ObservationOverrides = {}): ReconcileView => ({
  accountId: 'acct-a', now: 1_500, fresh: true, availableDeductsOpenOrders: true, openOrders: [], ...overrides,
})
const visible = (overrides: Partial<ValuedOpenOrder> = {}): ValuedOpenOrder => ({
  venueOrderId: 'venue-1', clientOrderId: 'cl-1', instrumentId: 'asset-a', side: 'buy',
  remainingSize: d('2'), reduceOnly: false, notional: d('200'), margin: d('100'), ...overrides,
})

describe('ReservationBook', () => {
  it.each(['open', 'untriggered', 'partially_filled'] as const)('releases ACKed but never-visible %s reservations only on distinct complete misses', (status) => {
    const book = new ReservationBook()
    book.reserve(reservation({ expiresAt: 2_000_000 }))
    book.outcome('acct-a', 'cl-1', { status, ...(status === 'partially_filled' ? { filledSize: d('1') } : {}) })
    expect(book.view('acct-a', 200, 0).account.margin).toBe(status === 'partially_filled' ? '50' : '100')

    const first = book.reconcileReservations(reconcile({ now: 200, observationAt: 200 }))
    expect(first).toMatchObject({ released: [], retainedUnknown: ['cl-1'], observations: [{ state: { everObserved: false, lastObservationAt: 200, missingSince: 200, missingCount: 1 } }] })
    const duplicate = book.reconcileReservations(reconcile({ now: 250, observationAt: 200 }))
    expect(duplicate).toMatchObject({ released: [], retainedUnknown: ['cl-1'], observations: [] })
    const second = book.reconcileReservations(reconcile({ now: 300, observationAt: 300 }))
    expect(second).toMatchObject({ released: ['cl-1'], unknownReleases: [{ clientOrderId: 'cl-1', evidence: 'two-fresh-misses' }] })
    expect(book.view('acct-a', 300, 0).account.margin).toBe('0')
  })

  it('applies the missing-evidence TTL to ACKed never-visible reservations only after a first complete miss', () => {
    const expired = new ReservationBook()
    expired.reserve(reservation())
    expired.outcome('acct-a', 'cl-1', { status: 'open' })
    expired.reconcileReservations(reconcile({ now: 200, observationAt: 200 }))
    expect(expired.reconcileReservations(reconcile({ now: 600_199, fresh: false })).released).toEqual([])
    expect(expired.reconcileReservations(reconcile({ now: 600_200, fresh: false }))).toMatchObject({ released: ['cl-1'], unknownReleases: [{ evidence: 'ttl', missingSince: 200, lastObservationAt: 200 }] })

    const noEvidence = new ReservationBook()
    noEvidence.reserve(reservation())
    noEvidence.outcome('acct-a', 'cl-1', { status: 'open' })
    expect(noEvidence.reconcileReservations(reconcile({ now: 9_999_999, fresh: false })).released).toEqual([])
    expect(noEvidence.reconcileReservations(reconcile({ now: 10_000_000, fresh: false, truncated: true })).released).toEqual([])
  })

  it('restores missing evidence for ACKed orders and keeps forks independent', () => {
    const restored = new ReservationBook()
    restored.reserve(reservation({ expiresAt: 2_000_000 }))
    restored.outcome('acct-a', 'cl-1', { status: 'open' })
    restored.restoreObservation('acct-a', 'cl-1', { everObserved: false, lastObservationAt: 200, missingSince: 200, missingCount: 1 })
    expect(restored.reconcileReservations(reconcile({ now: 201, observationAt: 200 })).released).toEqual([])
    expect(restored.reconcileReservations(reconcile({ now: 300, observationAt: 300 }))).toMatchObject({ released: ['cl-1'], unknownReleases: [{ evidence: 'two-fresh-misses' }] })

    const original = new ReservationBook()
    original.reserve(reservation({ expiresAt: 2_000_000 }))
    original.outcome('acct-a', 'cl-1', { status: 'open' })
    original.reconcileReservations(reconcile({ now: 200, observationAt: 200 }))
    const fork = original.fork()
    expect(fork.reconcileReservations(reconcile({ now: 300, observationAt: 300 })).released).toEqual(['cl-1'])
    expect(original.reconcileReservations(reconcile({ now: 250, observationAt: 200 })).released).toEqual([])
    expect(original.view('acct-a', 250, 0).account.margin).toBe('100')

    const noAck = new ReservationBook()
    noAck.reserve(reservation({ expiresAt: 2_000_000 }))
    noAck.outcome('acct-a', 'cl-1', { status: 'unknown' })
    noAck.restoreObservation('acct-a', 'cl-1', { everObserved: false, lastObservationAt: 200, missingSince: 200, missingCount: 1 })
    noAck.outcome('acct-a', 'cl-1', { status: 'open' })
    expect(noAck.reconcileReservations(reconcile({ now: 600_200, fresh: false })).released).toEqual([])
  })

  it('releases an ever-observed order only after two distinct complete fresh misses', () => {
    const book = new ReservationBook()
    book.reserve(reservation())
    book.reconcileReservations(reconcile({ now: 100, observationAt: 100, openOrders: [visible()] }))

    const first = book.reconcileReservations(reconcile({ now: 200, observationAt: 200 }))
    expect(first.released).toEqual([])
    expect(first).toMatchObject({ observations: [{ clientOrderId: 'cl-1', state: { everObserved: true, lastObservationAt: 200, missingSince: 200, missingCount: 1 } }] })
    expect(book.reconcileReservations(reconcile({ now: 250, observationAt: 200 })).released).toEqual([])
    const second = book.reconcileReservations(reconcile({ now: 300, observationAt: 300 }))
    expect(second.released).toEqual(['cl-1'])
    expect(second).toMatchObject({ unknownReleases: [{ clientOrderId: 'cl-1', reason: 'outcome-unknown', evidence: 'two-fresh-misses', missingSince: 200, lastObservationAt: 300 }] })
    expect(second.observations).toEqual([])
  })

  it('filters a matched observation when that same client order is terminal in the view', () => {
    const book = new ReservationBook()
    book.reserve(reservation())
    const result = book.reconcileReservations(reconcile({ now: 100, observationAt: 100, openOrders: [visible()], terminalClientOrderIds: ['cl-1'] }))
    expect(result.released).toEqual(['cl-1'])
    expect(result.observations.map((item) => item.clientOrderId)).not.toContain('cl-1')
  })

  it('does not count stale, truncated, or incomplete misses and clears evidence on reappearance', () => {
    const book = new ReservationBook()
    book.reserve(reservation())
    book.reconcileReservations(reconcile({ now: 100, observationAt: 100, openOrders: [visible()] }))
    book.reconcileReservations(reconcile({ now: 200, observationAt: 200 }))

    for (const overrides of [
      { now: 300, observationAt: 300, fresh: false },
      { now: 300, observationAt: 300, truncated: true },
      { now: 300, observationAt: 300, openOrders: [visible({ notional: undefined, margin: undefined })] },
    ]) {
      const result = book.reconcileReservations(reconcile(overrides))
      expect(result.released).toEqual([])
      expect(result.complete).toBe(false)
    }
    const restored = book.reconcileReservations(reconcile({ now: 400, observationAt: 400, openOrders: [visible()] }))
    expect(restored).toMatchObject({ observations: [{ state: { everObserved: true, missingCount: 0, lastObservationAt: 400 } }] })
    expect(restored.observations[0]?.state).not.toHaveProperty('missingSince')
  })

  it('releases only after TTL from fresh missing evidence and supports restored evidence', () => {
    const book = new ReservationBook({ missingOutcomeTtlMs: 50 })
    book.reserve(reservation())
    book.reconcileReservations(reconcile({ now: 100, observationAt: 100, openOrders: [visible()] }))
    book.reconcileReservations(reconcile({ now: 200, observationAt: 200 }))
    expect(book.reconcileReservations(reconcile({ now: 249, fresh: false })).released).toEqual([])
    expect(book.reconcileReservations(reconcile({ now: 250, fresh: false }))).toMatchObject({ released: ['cl-1'], unknownReleases: [{ evidence: 'ttl', missingSince: 200, lastObservationAt: 200 }] })

    const neverMissing = new ReservationBook({ missingOutcomeTtlMs: 50 })
    neverMissing.reserve(reservation({ clientOrderId: 'cl-never-missing' }))
    neverMissing.outcome('acct-a', 'cl-never-missing', { status: 'unknown' })
    expect(neverMissing.reconcileReservations(reconcile({ now: 9_999_999, fresh: false })).released).toEqual([])

    const restored = new ReservationBook({ missingOutcomeTtlMs: 50 })
    restored.reserve(reservation())
    restored.restoreObservation('acct-a', 'cl-1', { everObserved: true, lastObservationAt: 200, missingSince: 200, missingCount: 1 })
    expect(restored.reconcileReservations(reconcile({ now: 201, observationAt: 200 })).released).toEqual([])
    expect(restored.reconcileReservations(reconcile({ now: 202, observationAt: 202 })).released).toEqual(['cl-1'])
  })

  it('validates observation TTL options and ignores malformed restored evidence', () => {
    for (const missingOutcomeTtlMs of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new ReservationBook({ missingOutcomeTtlMs })).toThrow(/INVALID_PARAMS/)
    }
    const book = new ReservationBook()
    book.reserve(reservation({ expiresAt: 20_000_000 }))
    book.restoreObservation('acct-a', 'cl-1', { everObserved: true, lastObservationAt: -1, missingSince: -1, missingCount: 2 })
    expect(book.reconcileReservations(reconcile({ now: 9_999_999, fresh: false })).released).toEqual([])

    const malformed: ReservationObservation[] = [
      { everObserved: true, lastObservationAt: 200, missingSince: 100, missingCount: 0 },
      { everObserved: true, lastObservationAt: 200, missingCount: 1 },
      { everObserved: false, lastObservationAt: 200, missingSince: 100, missingCount: 1 },
    ]
    for (const state of malformed) {
      const candidate = new ReservationBook()
      const id = `cl-invalid-${malformed.indexOf(state)}`
      candidate.reserve(reservation({ clientOrderId: id, expiresAt: 20_000_000 }))
      if (state.everObserved) candidate.reconcileReservations(reconcile({ now: 100, observationAt: 100, openOrders: [visible({ clientOrderId: id })] }))
      else candidate.outcome('acct-a', id, { status: 'unknown' })
      candidate.restoreObservation('acct-a', id, state)
      const result = candidate.reconcileReservations(reconcile({ now: 9_999_999, fresh: false }))
      expect(result.released).toEqual([])
      const observed = candidate.reconcileReservations(reconcile({ now: 10_000_000, observationAt: 10_000_000 }))
      if (state.everObserved) expect(observed).toMatchObject({ observations: [{ state: { missingCount: 1, missingSince: 10_000_000 } }] })
      else expect(observed.observations).toEqual([])
    }
  })

  it('treats a released order reappearance as external and late outcomes or forks as isolated', () => {
    const book = new ReservationBook()
    book.reserve(reservation())
    book.reconcileReservations(reconcile({ now: 100, observationAt: 100, openOrders: [visible()] }))
    book.reconcileReservations(reconcile({ now: 200, observationAt: 200 }))
    book.reconcileReservations(reconcile({ now: 300, observationAt: 300 }))
    book.outcome('acct-a', 'cl-1', { status: 'filled', filledSize: d('2') })
    const fork = book.fork()
    const reappeared = book.reconcileReservations(reconcile({ now: 400, observationAt: 400, availableDeductsOpenOrders: false, openOrders: [visible()] }))
    expect(reappeared.released).toEqual([])
    expect(book.view('acct-a', 400, 0).account).toMatchObject({ margin: '100', count: 0 })
    expect(fork.view('acct-a', 400, 0).account.count).toBe(0)
  })

  it('keeps an issued reservation invisible until reconciliation and is idempotent by payload', () => {
    const book = new ReservationBook()
    const record = reservation()
    book.reserve(record)
    book.reserve({ ...record })
    record.notional = d('999')
    expect(book.complete('acct-a')).toBe(true)
    expect(book.view('acct-a', 1_500, 0)).toMatchObject({
      account: { margin: '100', notional: '200', count: 1 },
      byInstrument: { 'asset-a': { long: { notional: '200', count: 1 }, short: { notional: '0', count: 0 } } },
    })
    expect(() => book.reserve({ ...record, notional: d('201') })).toThrow(/INVALID_PARAMS/)
  })

  it('moves local values to visible orders without double counting and scales partial fills', () => {
    const deducted = new ReservationBook()
    deducted.reserve(reservation())
    const result = deducted.reconcileReservations(reconcile({ openOrders: [visible()] }))
    expect(result).toMatchObject({ complete: true, changed: true })
    expect(deducted.view('acct-a', 1_500, 0).account).toEqual({ margin: '0', notional: '0', count: 0 })

    const nondeducted = new ReservationBook()
    nondeducted.reserve(reservation())
    nondeducted.reconcileReservations(reconcile({ availableDeductsOpenOrders: false, openOrders: [visible()] }))
    expect(nondeducted.view('acct-a', 1_500, 0).account.margin).toBe('100')
    nondeducted.outcome('acct-a', 'cl-1', { status: 'partially_filled', filledSize: d('1') })
    expect(nondeducted.view('acct-a', 1_500, 0).account.margin).toBe('50')
    nondeducted.outcome('acct-a', 'cl-1', { status: 'filled', filledSize: d('2') })
    expect(nondeducted.view('acct-a', 1_500, 0).account).toEqual({ margin: '0', notional: '0', count: 0 })

    const alreadyPartFilled = new ReservationBook()
    alreadyPartFilled.reserve(reservation({ clientOrderId: 'cl-smaller-visible' }))
    alreadyPartFilled.reconcileReservations(reconcile({ availableDeductsOpenOrders: false, openOrders: [visible({ clientOrderId: 'cl-smaller-visible', remainingSize: d('0.5'), margin: d('20'), notional: d('40') })] }))
    alreadyPartFilled.outcome('acct-a', 'cl-smaller-visible', { status: 'partially_filled', filledSize: d('1') })
    expect(alreadyPartFilled.view('acct-a', 1_500, 0).account.margin).toBe('20')
  })

  it('counts external visible margin in non-deducted mode and marks unknown valuations incomplete', () => {
    const book = new ReservationBook()
    const external = visible({ venueOrderId: 'venue-external', clientOrderId: null, instrumentId: 'asset-b', margin: d('60'), notional: d('300') })
    expect(book.reconcileReservations(reconcile({ availableDeductsOpenOrders: false, openOrders: [external] })).complete).toBe(true)
    expect(book.view('acct-a', 1_500, 0).account.margin).toBe('60')
    const missing = visible({ venueOrderId: 'venue-unknown', clientOrderId: null, instrumentId: 'asset-c', margin: undefined, notional: undefined })
    expect(book.reconcileReservations(reconcile({ availableDeductsOpenOrders: false, openOrders: [missing] })).complete).toBe(false)
    expect(book.complete('acct-a')).toBe(false)
  })

  it('retains a fresh-observed local order past its request TTL', () => {
    const book = new ReservationBook()
    book.reserve(reservation({ expiresAt: 2_000 }))
    const result = book.reconcileReservations(reconcile({ now: 5_000, availableDeductsOpenOrders: false, openOrders: [visible()] }))
    expect(result.released).not.toContain('cl-1')
    expect(book.view('acct-a', 5_000, 0).account).toMatchObject({ margin: '100', count: 0 })
  })

  it('retains known cached valuations conservatively while reporting incomplete fresh data', () => {
    const book = new ReservationBook()
    book.reconcileReservations(reconcile({ availableDeductsOpenOrders: false, openOrders: [
      visible({ venueOrderId: 'venue-external', clientOrderId: null, remainingSize: d('2'), margin: d('60'), notional: d('120') }),
    ] }))
    const incomplete = book.reconcileReservations(reconcile({ availableDeductsOpenOrders: false, openOrders: [
      visible({ venueOrderId: 'venue-external', clientOrderId: null, remainingSize: d('1'), margin: undefined, notional: undefined }),
    ] }))
    expect(incomplete.complete).toBe(false)
    expect(book.view('acct-a', 1_500, 0).account.margin).toBe('30')
    const refreshed = book.reconcileReservations(reconcile({ availableDeductsOpenOrders: false, openOrders: [
      visible({ venueOrderId: 'venue-external', clientOrderId: null, remainingSize: d('1'), margin: d('25'), notional: d('100') }),
    ] }))
    expect(refreshed.complete).toBe(true)
    expect(book.view('acct-a', 1_500, 0).account.margin).toBe('25')
  })

  it('retains cached visible rows on a stale view and never times out acknowledged orders', () => {
    const book = new ReservationBook()
    book.reconcileReservations(reconcile({ availableDeductsOpenOrders: false, openOrders: [visible({ clientOrderId: null })] }))
    const stale = book.reconcileReservations(reconcile({ now: 99_000, fresh: false, availableDeductsOpenOrders: true, openOrders: [] }))
    expect(stale.complete).toBe(false)
    expect(book.view('acct-a', 99_000, 0).account.margin).toBe('100')
    const truncated = book.reconcileReservations(reconcile({ now: 100_000, observationAt: 100_000, truncated: true, availableDeductsOpenOrders: true, openOrders: [] }))
    expect(truncated.complete).toBe(false)
    expect(book.view('acct-a', 100_000, 0).account.margin).toBe('100')

    book.reserve(reservation({ clientOrderId: 'cl-ack', issuedAt: 1_000, expiresAt: 2_000 }))
    book.outcome('acct-a', 'cl-ack', { status: 'open', venueOrderId: 'venue-ack' })
    expect(book.view('acct-a', 5_000, 0).account.count).toBe(1)
    book.reconcileReservations(reconcile({ now: 5_000, openOrders: [] }))
    expect(book.view('acct-a', 5_000, 0).account.count).toBe(1)
  })

  it('expires supported unknown requests only after grace and retains unsupported ones', () => {
    const book = new ReservationBook()
    book.reserve(reservation({ clientOrderId: 'cl-known-expiry', expiresAt: 2_000 }))
    book.outcome('acct-a', 'cl-known-expiry', { status: 'unknown' })
    expect(book.reconcileReservations(reconcile({ now: 2_999 })).released).toEqual([])
    expect(book.reconcileReservations(reconcile({ now: 3_000 })).released).toContain('cl-known-expiry')
    book.reserve(reservation({ clientOrderId: 'cl-unsupported', expiresAt: 2_000, supportsExpiry: false }))
    book.outcome('acct-a', 'cl-unsupported', { status: 'unknown' })
    expect(book.reconcileReservations(reconcile({ now: 50_000 })).retainedUnknown).toContain('cl-unsupported')
  })

  it('does not expire unknown requests on stale input, expires unsent requests, and retains previously visible unknowns', () => {
    const book = new ReservationBook()
    book.reserve(reservation({ clientOrderId: 'cl-unsent', expiresAt: 2_000 }))
    expect(book.reconcileReservations(reconcile({ now: 2_000 })).released).toContain('cl-unsent')

    book.reserve(reservation({ clientOrderId: 'cl-stale-unknown', expiresAt: 2_000 }))
    book.outcome('acct-a', 'cl-stale-unknown', { status: 'unknown' })
    expect(book.reconcileReservations(reconcile({ now: 20_000, fresh: false })).released).not.toContain('cl-stale-unknown')
    expect(book.reconcileReservations(reconcile({ now: 3_000 })).released).toContain('cl-stale-unknown')

    book.reserve(reservation({ clientOrderId: 'cl-ever-visible', expiresAt: 2_000 }))
    book.outcome('acct-a', 'cl-ever-visible', { status: 'unknown', venueOrderId: 'venue-ever-visible' })
    book.reconcileReservations(reconcile({ now: 2_500, openOrders: [visible({ clientOrderId: 'cl-ever-visible', venueOrderId: 'venue-ever-visible' })] }))
    expect(book.reconcileReservations(reconcile({ now: 50_000, openOrders: [] })).released).not.toContain('cl-ever-visible')
    expect(book.view('acct-a', 50_000, 0).account.count).toBe(1)
  })

  it('markRecorded clears only daily and minute buckets and filters by mandate', () => {
    const book = new ReservationBook()
    book.reserve(reservation({ clientOrderId: 'cl-mandate', mandateId: 'mandate-a' }))
    expect(book.pendingCounts('acct-a', 1_500, 500, 'mandate-a')).toEqual({ ordersToday: 1, ordersLastMinute: 1 })
    book.markRecorded('acct-a', 'cl-mandate')
    expect(book.pendingCounts('acct-a', 1_500, 500)).toEqual({ ordersToday: 0, ordersLastMinute: 0 })
    expect(book.view('acct-a', 1_500, 500).account).toMatchObject({ margin: '100', notional: '200', count: 1 })
  })

  it('deduplicates local and visible reduce orders by client order id', () => {
    const book = new ReservationBook()
    book.reserve(reservation({ clientOrderId: 'cl-reduce', side: 'sell', size: d('3'), margin: d('0'), notional: d('300'), reduceOnly: true }))
    book.outcome('acct-a', 'cl-reduce', { status: 'partially_filled', filledSize: d('1') })
    book.reconcileReservations(reconcile({ openOrders: [
      visible({ clientOrderId: 'cl-reduce', side: 'sell', remainingSize: d('2'), reduceOnly: true }),
      visible({ venueOrderId: 'venue-external-reduce', clientOrderId: null, side: 'sell', remainingSize: d('2'), reduceOnly: true }),
    ] }))
    expect(book.reductionSize('acct-a', 'asset-a', 'sell')).toBe('4')
  })

  it('isolates accounts and forks visibility state independently', () => {
    const book = new ReservationBook()
    book.reserve(reservation())
    const fork = book.fork()
    fork.reconcileReservations(reconcile({ openOrders: [visible()] }))
    expect(fork.view('acct-a', 1_500, 0).account.count).toBe(0)
    expect(book.view('acct-a', 1_500, 0).account.count).toBe(1)
    expect(book.view('acct-b', 1_500, 0).account.count).toBe(0)
  })
})
