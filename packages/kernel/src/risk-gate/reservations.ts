// SPDX-License-Identifier: CPAL-1.0
import { canonicalize, makeProblem } from '@gitrader/protocol'
import type { Decimal, ReservedView } from '@gitrader/protocol'
import { KernelError } from '../util/errors'
import * as d from '../util/dec'

export interface ReservationRecord {
  accountId: string
  clientOrderId: string
  mandateId?: string
  instrumentId: string
  side: 'buy' | 'sell'
  size: Decimal
  margin: Decimal
  notional: Decimal
  issuedAt: number
  expiresAt: number
  supportsExpiry: boolean
  reduceOnly: boolean
}

export interface ValuedOpenOrder {
  venueOrderId: string
  clientOrderId?: string | null
  instrumentId: string
  side: 'buy' | 'sell'
  remainingSize: Decimal
  reduceOnly: boolean
  notional?: Decimal
  margin?: Decimal
}

export interface ReconcileView {
  accountId: string
  now: number
  fresh: boolean
  observationAt?: number
  truncated?: boolean
  availableDeductsOpenOrders: boolean
  openOrders: ValuedOpenOrder[]
  terminalClientOrderIds?: string[]
}

export interface ReservationOutcome {
  status: 'submitted' | 'unknown' | 'open' | 'untriggered' | 'partially_filled' | 'filled' | 'cancelled' | 'rejected' | 'expired'
  filledSize?: Decimal
  venueOrderId?: string
}

export interface PendingCounts { ordersToday: number; ordersLastMinute: number }
export interface ReservationObservation {
  everObserved: boolean
  lastObservationAt?: number
  missingSince?: number
  missingCount: number
}
export interface ReconcileResult {
  released: string[]
  retainedUnknown: string[]
  changed: boolean
  complete: boolean
  observations: Array<{ clientOrderId: string; state: ReservationObservation }>
  unknownReleases: Array<{ clientOrderId: string; reason: 'outcome-unknown'; evidence: 'two-fresh-misses' | 'ttl'; missingSince: number; lastObservationAt: number }>
}

interface StoredReservation {
  record: ReservationRecord
  recorded: boolean
  sent: boolean
  acknowledged: boolean
  everObserved: boolean
  lastObservationAt?: number
  missingSince?: number
  missingCount: number
  visible: boolean
  filledSize: Decimal
  venueOrderId?: string
}
interface AccountState {
  visible: ValuedOpenOrder[]
  availableDeductsOpenOrders: boolean
  complete: boolean
}

const keyOf = (accountId: string, clientOrderId: string): string => `${accountId}\u0000${clientOrderId}`
const emptyState = (): AccountState => ({ visible: [], availableDeductsOpenOrders: false, complete: true })
const copyRecord = (record: ReservationRecord): ReservationRecord => ({
  accountId: record.accountId, clientOrderId: record.clientOrderId, ...(record.mandateId === undefined ? {} : { mandateId: record.mandateId }),
  instrumentId: record.instrumentId, side: record.side, size: record.size, margin: record.margin, notional: record.notional,
  issuedAt: record.issuedAt, expiresAt: record.expiresAt, supportsExpiry: record.supportsExpiry, reduceOnly: record.reduceOnly,
})
const copyOrder = (order: ValuedOpenOrder): ValuedOpenOrder => ({
  venueOrderId: order.venueOrderId, ...(order.clientOrderId === undefined ? {} : { clientOrderId: order.clientOrderId }),
  instrumentId: order.instrumentId, side: order.side, remainingSize: order.remainingSize, reduceOnly: order.reduceOnly,
  ...(order.notional === undefined ? {} : { notional: order.notional }), ...(order.margin === undefined ? {} : { margin: order.margin }),
})
const invalidParams = (): never => { throw new KernelError(makeProblem('INVALID_PARAMS', 'reservation payload conflicts with an existing client order id')) }
const validTimestamp = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= 0
const observationOf = (item: StoredReservation): ReservationObservation => ({
  everObserved: item.everObserved,
  ...(item.lastObservationAt === undefined ? {} : { lastObservationAt: item.lastObservationAt }),
  ...(item.missingSince === undefined ? {} : { missingSince: item.missingSince }),
  missingCount: item.missingCount,
})
const remainingSize = (item: StoredReservation): d.Dec => d.max(d.ZERO, d.sub(d.D(item.record.size), d.D(item.filledSize)))
/** Internal worst-case budget quantization only; public estimates and rule actuals remain 18-place toward-zero. */
export function budgetMargin(numerator: d.Dec, denominator: d.Dec): Decimal {
  let quotient = d.div(numerator, denominator, 18)
  if (d.lt(d.mul(quotient, denominator), numerator)) quotient = d.add(quotient, d.D('0.000000000000000001'))
  return d.str(quotient)
}
const remainingNotional = (value: Decimal, item: StoredReservation): d.Dec => {
  const remaining = remainingSize(item), size = d.D(item.record.size)
  return d.isZero(size) ? d.ZERO : d.div(d.mul(d.D(value), remaining), size, 18)
}
const remainingMargin = (value: Decimal, item: StoredReservation): d.Dec => {
  const remaining = remainingSize(item), size = d.D(item.record.size)
  return d.isZero(size) ? d.ZERO : d.D(budgetMargin(d.mul(d.D(value), remaining), size))
}

export class ReservationBook {
  private readonly records = new Map<string, StoredReservation>()
  private readonly accounts = new Map<string, AccountState>()
  private readonly missingOutcomeTtlMs: number

  constructor(options: { missingOutcomeTtlMs?: number } = {}) {
    const ttl = options.missingOutcomeTtlMs ?? 600_000
    if (!Number.isFinite(ttl) || !Number.isInteger(ttl) || ttl <= 0) {
      throw new KernelError(makeProblem('INVALID_PARAMS', 'missing outcome TTL must be a finite positive integer'))
    }
    this.missingOutcomeTtlMs = ttl
  }

  private state(accountId: string): AccountState {
    let state = this.accounts.get(accountId)
    if (!state) { state = emptyState(); this.accounts.set(accountId, state) }
    return state
  }

  private reservation(accountId: string, clientOrderId: string): StoredReservation | undefined {
    return this.records.get(keyOf(accountId, clientOrderId))
  }

  private remove(accountId: string, clientOrderId: string): boolean {
    const key = keyOf(accountId, clientOrderId)
    const item = this.records.get(key)
    const state = this.state(accountId)
    if (item) this.records.delete(key)
    const before = state.visible.length
    state.visible = state.visible.filter((row) => row.clientOrderId !== clientOrderId && (!item?.venueOrderId || row.venueOrderId !== item.venueOrderId))
    return !!item || state.visible.length !== before
  }

  reserve(record: ReservationRecord): void {
    const copy = copyRecord(record)
    const key = keyOf(copy.accountId, copy.clientOrderId)
    const prior = this.records.get(key)
    if (prior) {
      if (canonicalize(prior.record) !== canonicalize(copy)) invalidParams()
      return
    }
    this.records.set(key, { record: copy, recorded: false, sent: false, acknowledged: false, everObserved: false, missingCount: 0, visible: false, filledSize: d.str(d.ZERO) })
  }

  restoreObservation(accountId: string, clientOrderId: string, state: ReservationObservation): void {
    const item = this.reservation(accountId, clientOrderId)
    if (!item || !state || typeof state.everObserved !== 'boolean' ||
      (state.missingCount !== 0 && state.missingCount !== 1) ||
      state.lastObservationAt !== undefined && !validTimestamp(state.lastObservationAt) ||
      state.missingCount === 0 && state.missingSince !== undefined ||
      state.missingCount === 1 && (!(state.everObserved || item.acknowledged) || !validTimestamp(state.missingSince) || !validTimestamp(state.lastObservationAt))) return

    item.everObserved = item.everObserved || state.everObserved
    if (state.lastObservationAt === undefined) delete item.lastObservationAt
    else item.lastObservationAt = state.lastObservationAt
    item.missingCount = state.missingCount
    if (state.missingCount === 1) item.missingSince = state.missingSince
    else delete item.missingSince
    if (state.everObserved) {
      item.sent = true
      item.acknowledged = true
    }
  }

  release(accountId: string, clientOrderId: string): boolean { return this.remove(accountId, clientOrderId) }

  markRecorded(accountId: string, clientOrderId: string): void {
    const item = this.reservation(accountId, clientOrderId)
    if (item) item.recorded = true
  }

  outcome(accountId: string, clientOrderId: string, outcome: ReservationOutcome): void {
    const item = this.reservation(accountId, clientOrderId)
    if (!item) return
    if (outcome.filledSize !== undefined) item.filledSize = d.str(d.max(d.D(item.filledSize), d.D(outcome.filledSize)))
    if (outcome.venueOrderId !== undefined) item.venueOrderId = outcome.venueOrderId
    if (outcome.status === 'submitted' || outcome.status === 'unknown') item.sent = true
    if (outcome.status === 'open' || outcome.status === 'untriggered' || outcome.status === 'partially_filled') {
      item.sent = true
      item.acknowledged = true
    }
    if (outcome.status === 'partially_filled' && outcome.filledSize !== undefined) {
      const localRemaining = remainingSize(item)
      const state = this.accounts.get(accountId)
      if (state) state.visible = state.visible.map((row) => {
        if (!this.rowMatches(item, row)) return row
        const priorRemaining = d.D(row.remainingSize)
        const nextRemaining = d.min(priorRemaining, localRemaining)
        return {
          ...row, remainingSize: d.str(nextRemaining),
          ...(row.margin === undefined ? {} : { margin: budgetMargin(d.mul(d.D(row.margin), nextRemaining), priorRemaining) }),
          ...(row.notional === undefined ? {} : { notional: d.str(d.div(d.mul(d.D(row.notional), nextRemaining), priorRemaining, 18)) }),
        }
      })
    }
    if (outcome.status === 'filled' || outcome.status === 'cancelled' || outcome.status === 'rejected' || outcome.status === 'expired') this.remove(accountId, clientOrderId)
  }

  private matchingLocal(accountId: string, row: ValuedOpenOrder): StoredReservation | undefined {
    if (row.clientOrderId) return this.reservation(accountId, row.clientOrderId)
    return [...this.records.values()].find((item) => item.record.accountId === accountId && item.venueOrderId !== undefined && item.venueOrderId === row.venueOrderId)
  }

  private rowMatches(item: StoredReservation, row: ValuedOpenOrder): boolean {
    return row.clientOrderId ? row.clientOrderId === item.record.clientOrderId : item.venueOrderId !== undefined && item.venueOrderId === row.venueOrderId
  }

  private stateSnapshot(accountId: string): string {
    const state = this.accounts.get(accountId) ?? emptyState()
    const records = [...this.records.entries()].filter(([, item]) => item.record.accountId === accountId)
    return canonicalize({ state, records })
  }

  reconcileReservations(view: ReconcileView): ReconcileResult {
    const before = this.stateSnapshot(view.accountId)
    const state = this.state(view.accountId)
    const released: string[] = []
    const retainedUnknown: string[] = []
    const freshMatches = new Set<string>()
    const observations: ReconcileResult['observations'] = []
    const unknownReleases: ReconcileResult['unknownReleases'] = []
    const rawComplete = view.openOrders.every((row) => row.reduceOnly || (row.notional !== undefined && row.margin !== undefined))
    const usableObservation = view.fresh && !view.truncated && rawComplete
    const hasNewObservationId = validTimestamp(view.observationAt) && validTimestamp(view.now) && view.observationAt <= view.now

    if (view.fresh && !view.truncated) {
      const previous = state.visible
      state.visible = view.openOrders.map((inputRow) => {
        const row = copyOrder(inputRow)
        const prior = row.clientOrderId
          ? previous.find((candidate) => candidate.clientOrderId === row.clientOrderId)
          : previous.find((candidate) => candidate.venueOrderId === row.venueOrderId)
        if (!prior || d.lte(d.D(prior.remainingSize), d.ZERO)) return row
        return {
          ...row,
          ...(row.margin === undefined && prior.margin !== undefined ? { margin: budgetMargin(d.mul(d.D(prior.margin), d.D(row.remainingSize)), d.D(prior.remainingSize)) } : {}),
          ...(row.notional === undefined && prior.notional !== undefined ? { notional: d.str(d.div(d.mul(d.D(prior.notional), d.D(row.remainingSize)), d.D(prior.remainingSize), 18)) } : {}),
        }
      })
      state.availableDeductsOpenOrders = view.availableDeductsOpenOrders
      for (const row of state.visible) {
        const item = this.matchingLocal(view.accountId, row)
        if (!item) continue
        const beforeObservation = canonicalize(observationOf(item))
        item.visible = true
        item.sent = true
        item.everObserved = true
        item.acknowledged = true
        delete item.missingSince
        item.missingCount = 0
        if (usableObservation && hasNewObservationId && view.observationAt! > (item.lastObservationAt ?? -1)) item.lastObservationAt = view.observationAt
        if (row.venueOrderId) item.venueOrderId = row.venueOrderId
        freshMatches.add(item.record.clientOrderId)
        if (beforeObservation !== canonicalize(observationOf(item))) observations.push({ clientOrderId: item.record.clientOrderId, state: observationOf(item) })
      }
      for (const item of this.records.values()) if (item.record.accountId === view.accountId && !freshMatches.has(item.record.clientOrderId)) item.visible = false
      state.complete = rawComplete
    } else {
      state.complete = false
    }

    for (const clientOrderId of view.terminalClientOrderIds ?? []) {
      if (this.remove(view.accountId, clientOrderId)) released.push(clientOrderId)
    }

    for (const [key, item] of this.records) {
      if (item.record.accountId !== view.accountId) continue
      const id = item.record.clientOrderId
      const matchedFresh = view.fresh && freshMatches.has(id)
      if (matchedFresh) {
        void key
        continue
      }
      if (!item.sent && !item.acknowledged && !item.everObserved && view.now >= item.record.expiresAt) {
        this.remove(view.accountId, id)
        released.push(id)
        continue
      }
      if (item.sent && !item.acknowledged && !item.everObserved && !matchedFresh && view.fresh && !view.truncated && item.record.supportsExpiry && view.now >= item.record.expiresAt + 1_000) {
        this.remove(view.accountId, id)
        released.push(id)
        continue
      }
      const hasDistinctMissingObservation = usableObservation && hasNewObservationId && view.observationAt! > (item.lastObservationAt ?? -1) && (item.everObserved || item.acknowledged)
      if (hasDistinctMissingObservation) {
        const beforeObservation = canonicalize(observationOf(item))
        item.lastObservationAt = view.observationAt
        item.missingCount = Math.min(2, item.missingCount + 1)
        if (item.missingSince === undefined) item.missingSince = view.now
        if (item.missingCount >= 2) {
          const missingSince = item.missingSince
          this.remove(view.accountId, id)
          released.push(id)
          if (missingSince !== undefined) unknownReleases.push({ clientOrderId: id, reason: 'outcome-unknown', evidence: 'two-fresh-misses', missingSince, lastObservationAt: view.observationAt! })
          continue
        }
        if (beforeObservation !== canonicalize(observationOf(item))) observations.push({ clientOrderId: id, state: observationOf(item) })
      }
      if ((item.everObserved || item.acknowledged) && item.missingCount === 1 && item.missingSince !== undefined && item.lastObservationAt !== undefined && view.now >= item.missingSince + this.missingOutcomeTtlMs) {
        this.remove(view.accountId, id)
        released.push(id)
        unknownReleases.push({ clientOrderId: id, reason: 'outcome-unknown', evidence: 'ttl', missingSince: item.missingSince, lastObservationAt: item.lastObservationAt })
        continue
      }
      if (item.sent && !item.everObserved) retainedUnknown.push(id)
    }

    const after = this.stateSnapshot(view.accountId)
    const releasedIds = new Set(released)
    return { released, retainedUnknown, changed: before !== after, complete: state.complete, observations: observations.filter((item) => !releasedIds.has(item.clientOrderId)), unknownReleases }
  }

  pendingCounts(accountId: string, now: number, dayStart: number, mandateId?: string): PendingCounts {
    let ordersToday = 0
    let ordersLastMinute = 0
    for (const item of this.records.values()) {
      const record = item.record
      if (record.accountId !== accountId || item.recorded || mandateId !== undefined && record.mandateId !== mandateId) continue
      if (record.issuedAt >= dayStart && record.issuedAt <= now) ordersToday++
      if (record.issuedAt >= now - 60_000 && record.issuedAt <= now) ordersLastMinute++
    }
    return { ordersToday, ordersLastMinute }
  }

  view(accountId: string, now: number, dayStart: number): ReservedView {
    const state = this.state(accountId)
    let margin = d.ZERO
    let notional = d.ZERO
    let count = 0
    const byInstrument: ReservedView['byInstrument'] = {}
    let todayNotional = d.ZERO
    let todayCount = 0
    let minuteCount = 0

    for (const item of this.records.values()) {
      const record = item.record
      if (record.accountId !== accountId) continue
      const remaining = remainingSize(item)
      if (!item.visible && !record.reduceOnly && d.gt(remaining, d.ZERO)) {
        const itemMargin = remainingMargin(record.margin, item)
        const itemNotional = remainingNotional(record.notional, item)
        margin = d.add(margin, itemMargin)
        notional = d.add(notional, itemNotional)
        count++
        const side = record.side === 'buy' ? 'long' : 'short'
        const current = byInstrument[record.instrumentId] ?? { long: { notional: d.str(d.ZERO), count: 0 }, short: { notional: d.str(d.ZERO), count: 0 } }
        current[side].notional = d.str(d.add(d.D(current[side].notional), itemNotional))
        current[side].count++
        byInstrument[record.instrumentId] = current
      }
      if (!item.recorded && record.issuedAt >= dayStart && record.issuedAt <= now) {
        todayCount++
        if (!record.reduceOnly) todayNotional = d.add(todayNotional, d.D(record.notional))
      }
      if (!item.recorded && record.issuedAt >= now - 60_000 && record.issuedAt <= now) minuteCount++
    }

    if (!state.availableDeductsOpenOrders) {
      for (const row of state.visible) if (!row.reduceOnly && row.margin !== undefined) margin = d.add(margin, d.D(row.margin))
    }
    return {
      account: { margin: d.str(margin), notional: d.str(notional), count }, byInstrument,
      today: { notional: d.str(todayNotional), count: todayCount }, lastMinute: { count: minuteCount },
    }
  }

  reductionSize(accountId: string, instrumentId: string, side: 'buy' | 'sell'): Decimal {
    let total = d.ZERO
    const state = this.accounts.get(accountId) ?? emptyState()
    for (const item of this.records.values()) {
      if (item.record.accountId !== accountId || !item.record.reduceOnly || item.record.instrumentId !== instrumentId || item.record.side !== side || item.visible) continue
      total = d.add(total, remainingSize(item))
    }
    for (const row of state.visible) if (row.instrumentId === instrumentId && row.side === side && row.reduceOnly) total = d.add(total, d.D(row.remainingSize))
    return d.str(total)
  }

  complete(accountId: string): boolean { return this.accounts.get(accountId)?.complete ?? true }

  fork(): ReservationBook {
    const fork = new ReservationBook({ missingOutcomeTtlMs: this.missingOutcomeTtlMs })
    for (const [key, item] of this.records) fork.records.set(key, structuredClone(item))
    for (const [accountId, state] of this.accounts) fork.accounts.set(accountId, structuredClone(state))
    return fork
  }
}
