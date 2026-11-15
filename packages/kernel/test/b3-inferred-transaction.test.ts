// SPDX-License-Identifier: CPAL-1.0
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Fill, OrderIntent, Origin, ReconcileConfirmInput, ReconcileConfirmResult } from '../src/proto'
import { tx } from '../src/db'
import { FAST_SCRYPT, makeHarness } from './helpers/harness'
import type { Harness } from './helpers/harness'
import { BTC } from './helpers/fake-connector'
import { Kernel } from '../src/kernel'
import { fileProvider } from '../src/device-key'

let h: Harness
beforeEach(async () => { h = await makeHarness() })
afterEach(async () => { await h.cleanup() })

const openLimitOrder = async (size: string) => {
  const intent: OrderIntent = {
    accountId: h.paper.accountId as never, instrumentId: BTC as never, side: 'buy', type: 'limit',
    tif: 'gtc', size: size as never, price: '80000' as never, leverage: 2, reason: 'transaction boundary test',
  }
  const result = await h.k.trading.place({ intent }, h.human())
  expect(result.order?.status).toBe('open')
  return result.order!
}

const makeFill = (order: { orderId: string; clientOrderId: string }, index: number, price: string): Fill => ({
  fillId: `fill_transaction_${index}` as never,
  orderId: order.orderId as never,
  clientOrderId: order.clientOrderId as never,
  venueFillId: `venue_transaction_${index}`,
  accountId: h.paper.accountId as never,
  instrumentId: BTC as never,
  side: 'buy', price: price as never, size: '0.00001' as never, fee: '0' as never, feeCcy: 'USDC',
  liquidity: 'maker', realizedPnl: '0' as never, ts: index + 1,
})

const makeConfirmation = (order: { orderId: string }, overrides: Partial<ReconcileConfirmInput> = {}): ReconcileConfirmInput => ({
  offerId: `offer_${order.orderId}`,
  accountId: h.paper.accountId as never,
  reportId: `report_${order.orderId}`,
  suggestionId: `suggestion_${order.orderId}`,
  fee: '0.0001' as never,
  feeCcy: 'USDC',
  liquidity: 'taker',
  realizedPnl: '0' as never,
  ...overrides,
} as unknown as ReconcileConfirmInput)

const confirmedFill = (order: { orderId: string; clientOrderId: string }, input: ReconcileConfirmInput): Fill => ({
  ...makeFill(order, 5000, '80000'),
  fee: input.fee,
  feeCcy: input.feeCcy,
  liquidity: input.liquidity,
  realizedPnl: input.realizedPnl,
  inferred: {
    suggestionId: input.suggestionId,
    reportId: input.reportId,
    confirmedAt: h.clock.now(),
    confirmedBy: 'user:usr_local',
    priceSource: 'venue_avg_fill_price',
    basisDigest: `sha256:${'a'.repeat(64)}`,
  },
})

const applyConfirmedFill = (fill: Fill, origin: Origin, input: ReconcileConfirmInput): ReconcileConfirmResult =>
  (h.k.trading as unknown as { applyConfirmedFill(f: Fill, o: Origin, i: ReconcileConfirmInput): ReconcileConfirmResult }).applyConfirmedFill(fill, origin, input)

const receiptId = (input: ReconcileConfirmInput): string => `rcpt_${createHash('sha256').update(JSON.stringify([input.accountId, input.suggestionId])).digest('hex')}`

const reservationAndPendingState = (accountId: string): string => {
  const internal = h.k.trading as unknown as {
    reservations: { view(accountId: string, now: number, dayStart: number): unknown }
    pendingAmends: Map<string, unknown>
  }
  const now = h.clock.now()
  const dayStart = Math.floor(now / 86_400_000) * 86_400_000
  return JSON.stringify({ reservation: internal.reservations.view(accountId, now, dayStart), pendingAmends: [...internal.pendingAmends] })
}

describe('B3 confirmed inferred-fill transaction', () => {
  it('uses every stored order fill when recomputing totals beyond the public 1000-row page cap', async () => {
    const order = await openLimitOrder('0.012')
    for (let index = 0; index < 1001; index++) {
      expect(h.k.orders.insertFill(makeFill(order, index, index === 0 ? '79999' : '80000'))).toBe(true)
    }

    expect(h.k.trading.applyFill(makeFill(order, 1001, '80000'), h.human().origin)).toBe(true)

    expect(h.k.orders.get(order.orderId)).toMatchObject({
      filledSize: '0.01002',
      avgFillPrice: '79999.999001996007',
      status: 'partially_filled',
    })
  })

  it('persists the receipt, financial fill and ledger row once, then returns the same fill on an identical retry', async () => {
    const order = await openLimitOrder('0.012')
    const input = makeConfirmation(order)
    const fill = confirmedFill(order, input)
    let ledgerEvents = 0, orderEvents = 0, fillEvents = 0
    const offLedger = h.k.events.subscribe('ledger.entry', (event) => { if ((event.data as { type?: string }).type === 'fill') ledgerEvents++ })
    const offOrder = h.k.events.subscribe('account.orders', (event) => { if ((event.data as { orderId?: string }).orderId === order.orderId) orderEvents++ })
    const offFill = h.k.events.subscribe('account.fills', (event) => { if ((event.data as { fillId?: string }).fillId === fill.fillId) fillEvents++ })
    try {
      const first = applyConfirmedFill(fill, h.human('reconcile.confirm').origin, input)
      const receipt = h.k.db.prepare("SELECT doc FROM docs WHERE coll='reconcile-confirm-receipt' AND id=? ORDER BY ver DESC LIMIT 1").get(receiptId(input)) as { doc: string } | undefined
      expect(first).toEqual({ fillId: fill.fillId, alreadyRecorded: false })
      expect(receipt && JSON.parse(receipt.doc)).toMatchObject({ input, fillId: fill.fillId, effectsState: 'complete' })
      expect(h.k.orders.fillWithId(fill)).toMatchObject({ ...fill, inferred: fill.inferred })
      expect(h.k.ledger.query({ types: ['fill'], accountId: input.accountId }).length).toBe(1)
      expect([ledgerEvents, orderEvents, fillEvents]).toEqual([1, 1, 1])

      expect(applyConfirmedFill(fill, h.human('reconcile.confirm').origin, input)).toEqual({ fillId: fill.fillId, alreadyRecorded: true })
      expect(() => applyConfirmedFill({ ...fill, size: '0.002' as never }, h.human('reconcile.confirm').origin, input)).toThrow()
      expect(h.k.orders.fills({ orderId: order.orderId, limit: 1000 }).filter((row) => row.fillId === fill.fillId)).toHaveLength(1)
      expect(h.k.ledger.query({ types: ['fill'], accountId: input.accountId }).length).toBe(1)
      expect([ledgerEvents, orderEvents, fillEvents]).toEqual([1, 1, 1])
    } finally { offLedger(); offOrder(); offFill() }
  })

  it('keeps a completed receipt retry clear of pending and permits the next confirmation', async () => {
    const order = await openLimitOrder('0.012')
    const input = makeConfirmation(order)
    const fill = confirmedFill(order, input)
    expect(applyConfirmedFill(fill, h.human('reconcile.confirm').origin, input)).toEqual({ fillId: fill.fillId, alreadyRecorded: false })
    expect(h.k.trading.confirmationPending(input.accountId)).toBe(false)

    expect(applyConfirmedFill(fill, h.human('reconcile.confirm').origin, input)).toEqual({ fillId: fill.fillId, alreadyRecorded: true })
    expect(h.k.trading.confirmationPending(input.accountId)).toBe(false)

    const nextInput = makeConfirmation(order, { offerId: `${input.offerId}_next`, suggestionId: `${input.suggestionId}_next` })
    const nextFill = { ...confirmedFill(order, nextInput), fillId: 'fill_transaction_next' as never, venueFillId: 'venue_transaction_next' }
    expect(applyConfirmedFill(nextFill, h.human('reconcile.confirm').origin, nextInput)).toEqual({ fillId: nextFill.fillId, alreadyRecorded: false })
    expect(h.k.trading.confirmationPending(input.accountId)).toBe(false)
    expect(h.k.ledger.query({ types: ['fill'], accountId: input.accountId })).toHaveLength(2)
  })

  it('refuses to own a nested transaction before changing any confirmation state', async () => {
    const order = await openLimitOrder('0.012')
    const input = makeConfirmation(order)
    const fill = confirmedFill(order, input)
    const head = h.k.ledger.head()
    expect(() => tx(h.k.db, () => applyConfirmedFill(fill, h.human('reconcile.confirm').origin, input))).toThrow()
    expect(h.k.orders.fillWithId(fill)).toBeUndefined()
    expect(h.k.docs.get('reconcile-confirm-receipt', receiptId(input))).toBeUndefined()
    expect(h.k.ledger.head()).toEqual(head)
  })

  it.each(['receipt', 'ledger', 'commit'] as const)('rolls back a %s failure without effects and permits one valid retry', async (fault) => {
    const order = await openLimitOrder('0.012')
    const input = makeConfirmation(order)
    const fill = confirmedFill(order, input)
    const beforeOrder = h.k.orders.get(order.orderId)
    const beforeHead = h.k.ledger.head()
    const beforeMemory = reservationAndPendingState(input.accountId)
    let accountEvents = 0, ledgerEvents = 0
    const offAccount = h.k.events.subscribe('account.*', () => { accountEvents++ })
    const offLedger = h.k.events.subscribe('ledger.entry', () => { ledgerEvents++ })
    if (fault === 'receipt') h.k.db.exec("CREATE TRIGGER fail_reconcile_receipt BEFORE INSERT ON docs WHEN NEW.coll='reconcile-confirm-receipt' BEGIN SELECT RAISE(ABORT, 'injected receipt failure'); END")
    if (fault === 'ledger') h.k.db.exec("CREATE TRIGGER fail_reconcile_fill BEFORE INSERT ON ledger WHEN NEW.type='fill' BEGIN SELECT RAISE(ABORT, 'injected ledger failure'); END")
    if (fault === 'commit') {
      h.k.db.exec("PRAGMA foreign_keys=ON; CREATE TABLE tx_fault_parent(id TEXT PRIMARY KEY); CREATE TABLE tx_fault_child(parent_id TEXT REFERENCES tx_fault_parent(id) DEFERRABLE INITIALLY DEFERRED); CREATE TRIGGER fail_reconcile_commit AFTER INSERT ON docs WHEN NEW.coll='reconcile-confirm-receipt' BEGIN INSERT INTO tx_fault_child(parent_id) VALUES('missing'); END")
    }
    try {
      expect(() => applyConfirmedFill(fill, h.human('reconcile.confirm').origin, input)).toThrow()
      expect(h.k.db.prepare("SELECT COUNT(*) c FROM docs WHERE coll='reconcile-confirm-receipt'").get()).toMatchObject({ c: 0 })
      expect(h.k.orders.fillWithId(fill)).toBeUndefined()
      expect(h.k.ledger.head()).toEqual(beforeHead)
      expect(h.k.orders.get(order.orderId)).toEqual(beforeOrder)
      expect(reservationAndPendingState(input.accountId)).toBe(beforeMemory)
      expect([accountEvents, ledgerEvents]).toEqual([0, 0])
    } finally {
      if (fault === 'receipt') h.k.db.exec('DROP TRIGGER fail_reconcile_receipt')
      if (fault === 'ledger') h.k.db.exec('DROP TRIGGER fail_reconcile_fill')
      if (fault === 'commit') h.k.db.exec('DROP TRIGGER fail_reconcile_commit; DROP TABLE tx_fault_child; DROP TABLE tx_fault_parent; PRAGMA foreign_keys=OFF')
      offAccount(); offLedger()
    }
    expect(applyConfirmedFill(fill, h.human('reconcile.confirm').origin, input)).toEqual({ fillId: fill.fillId, alreadyRecorded: false })
    expect(h.k.orders.fillWithId(fill)).toMatchObject({ fillId: fill.fillId })
    expect(h.k.ledger.query({ types: ['fill'], accountId: input.accountId })).toHaveLength(1)
  })

  it('restores checkpoint and pending gate-renewal state after an outer rollback', async () => {
    const order = await openLimitOrder('0.012')
    const input = makeConfirmation(order)
    const fill = confirmedFill(order, input)
    h.clock.advance(3_600_001)
    h.k.ledger.recordGateRenewal(input.accountId, { assembleUs: 3, decideUs: 5, protectorUs: 7 })
    const beforeHead = h.k.ledger.head()
    h.k.db.exec("CREATE TRIGGER fail_reconcile_checkpoint BEFORE INSERT ON ledger WHEN NEW.type='checkpoint' BEGIN SELECT RAISE(ABORT, 'injected checkpoint failure'); END")
    try {
      expect(() => applyConfirmedFill(fill, h.human('reconcile.confirm').origin, input)).toThrow()
      expect(h.k.ledger.head()).toEqual(beforeHead)
      expect(h.k.orders.fillWithId(fill)).toBeUndefined()
      expect(h.k.docs.get('reconcile-confirm-receipt', receiptId(input))).toBeUndefined()
    } finally { h.k.db.exec('DROP TRIGGER fail_reconcile_checkpoint') }

    expect(applyConfirmedFill(fill, h.human('reconcile.confirm').origin, input)).toEqual({ fillId: fill.fillId, alreadyRecorded: false })
    const entry = h.k.ledger.query({ types: ['fill'], accountId: input.accountId, limit: 1000 }).find((row) => row.subject.fillId === fill.fillId)
    expect(entry?.payload).toMatchObject({ gateRenewals: { count: 1, timing: { assembleUs: 3, decideUs: 5, protectorUs: 7 } } })
    expect(h.k.ledger.query({ types: ['checkpoint'] }).length).toBeGreaterThan(0)
  })

  it('keeps a post-commit protector fault visible and does not repeat a committed fill on retry', async () => {
    const order = await openLimitOrder('0.012')
    const input = makeConfirmation(order)
    const fill = confirmedFill(order, input)
    let orderEvents = 0, fillEvents = 0
    const offOrder = h.k.events.subscribe('account.orders', () => { orderEvents++ })
    const offFill = h.k.events.subscribe('account.fills', () => { fillEvents++ })
    const original = h.k.protectors.onFill.bind(h.k.protectors)
    h.k.protectors.onFill = () => { throw new Error('injected protector follow-up failure') }
    try {
      expect(applyConfirmedFill(fill, h.human('reconcile.confirm').origin, input)).toEqual({ fillId: fill.fillId, alreadyRecorded: false })
      expect(h.k.orders.fillWithId(fill)).toMatchObject({ fillId: fill.fillId })
      expect(h.k.tstate.get({ type: 'account', id: input.accountId })).toBe('HALTED')
      expect(h.k.docs.get<string>('reconcile-confirm-pending', input.accountId)).toBe(receiptId(input))
      const anotherInput = makeConfirmation(order, { suggestionId: `${input.suggestionId}_other` })
      expect(() => applyConfirmedFill(confirmedFill(order, anotherInput), h.human('reconcile.confirm').origin, anotherInput)).toThrow()
      expect(applyConfirmedFill(fill, h.human('reconcile.confirm').origin, input)).toEqual({ fillId: fill.fillId, alreadyRecorded: true })
      expect(h.k.orders.fills({ orderId: order.orderId, limit: 1000 }).filter((row) => row.fillId === fill.fillId)).toHaveLength(1)
      expect([orderEvents, fillEvents]).toEqual([1, 1])
    } finally { h.k.protectors.onFill = original; offOrder(); offFill() }
  })

  it('restores pending status after restart and returns the committed fill without replaying effects', async () => {
    const order = await openLimitOrder('0.012')
    const input = makeConfirmation(order)
    const fill = confirmedFill(order, input)
    h.k.protectors.onFill = () => { throw new Error('injected protector follow-up failure') }
    expect(applyConfirmedFill(fill, h.human('reconcile.confirm').origin, input)).toEqual({ fillId: fill.fillId, alreadyRecorded: false })
    await h.k.stop()
    h.k = await Kernel.create({ home: h.home, clock: h.clock, scrypt: FAST_SCRYPT, deviceKeyProvider: fileProvider, timers: false, sleep: async () => undefined })
    try {
      expect(h.k.trading.confirmationPending(input.accountId)).toBe(true)
      let accountEvents = 0, ledgerEvents = 0
      const offAccount = h.k.events.subscribe('account.*', () => { accountEvents++ })
      const offLedger = h.k.events.subscribe('ledger.entry', () => { ledgerEvents++ })
      try {
        expect(applyConfirmedFill(fill, h.human('reconcile.confirm').origin, input)).toEqual({ fillId: fill.fillId, alreadyRecorded: true })
        expect(h.k.orders.fillWithId(fill)).toMatchObject({ fillId: fill.fillId })
        expect(h.k.ledger.query({ types: ['fill'], accountId: input.accountId })).toHaveLength(1)
        expect([accountEvents, ledgerEvents]).toEqual([0, 0])
      } finally { offAccount(); offLedger() }
    } finally {
      await h.k.stop()
    }
  })
})
