// SPDX-License-Identifier: CPAL-1.0
import { writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Fill, OrderIntent, Origin, ReconcileConfirmInput } from '../src/proto'
import type { VenueFill } from '@gitrader/protocol/connector'
import { FAST_SCRYPT, makeHarness } from './helpers/harness'
import type { Harness } from './helpers/harness'
import { BTC } from './helpers/fake-connector'
import { Kernel } from '../src/kernel'
import { fileProvider } from '../src/device-key'

let h: Harness
beforeEach(async () => { h = await makeHarness() })
afterEach(async () => { await h.cleanup() })

const openOrder = async () => {
  const intent: OrderIntent = {
    accountId: h.paper.accountId as never, instrumentId: BTC as never, side: 'buy', type: 'limit',
    tif: 'gtc', size: '0.012' as never, price: '80000' as never, leverage: 2, reason: 'late fill test',
  }
  const result = await h.k.trading.place({ intent }, h.human())
  if (!result.order) throw new Error('test order was not created')
  return result.order
}

const confirmationInput = (order: { orderId: string }): ReconcileConfirmInput => ({
  offerId: `offer_${order.orderId}`, accountId: h.paper.accountId as never,
  reportId: `report_${order.orderId}`, suggestionId: `suggestion_${order.orderId}`,
  fee: '0.0001' as never, feeCcy: 'USDC', liquidity: 'taker', realizedPnl: '0' as never,
} as ReconcileConfirmInput)

const inferredFill = (order: { orderId: string; clientOrderId: string }, input: ReconcileConfirmInput): Fill => ({
  fillId: 'fill_late_probe_inferred' as never, orderId: order.orderId as never, clientOrderId: order.clientOrderId as never,
  venueFillId: `inferred_${input.suggestionId}`, accountId: input.accountId, instrumentId: BTC as never,
  side: 'buy', price: '80000' as never, size: '0.00001' as never, fee: input.fee,
  feeCcy: input.feeCcy, liquidity: input.liquidity, realizedPnl: input.realizedPnl, ts: h.clock.now(),
  inferred: { suggestionId: input.suggestionId, reportId: input.reportId, confirmedAt: h.clock.now(),
    confirmedBy: 'user:usr_local', priceSource: 'venue_avg_fill_price', basisDigest: `sha256:${'a'.repeat(64)}` },
})

const origin = (): Origin => h.human('reconcile.confirm').origin
const errorName = (error: unknown): string | undefined => (error as { problem?: { name?: string } } | undefined)?.problem?.name

const writeRedResult = (file: string, data: unknown) => {
  const uniqueFile = file.replace(/\.json$/, `-${randomUUID()}.json`)
  writeFileSync(join(h.home, uniqueFile), `${JSON.stringify(data, null, 2)}\n`, { flag: 'wx' })
}

describe('B3 late evidence and trusted inferred fills', () => {
  it('looks up a matching durable receipt read-only after its original time window and restart', async () => {
    const order = await openOrder()
    const input = confirmationInput(order)
    const fill = inferredFill(order, input)
    const applyConfirmed = (h.k.trading as unknown as { applyConfirmedFill(f: Fill, o: Origin, i: ReconcileConfirmInput): unknown }).applyConfirmedFill
    applyConfirmed.call(h.k.trading, fill, origin(), input)
    const fillCountBefore = h.k.orders.fills({ accountId: input.accountId, orderId: order.orderId, limit: 1000 }).length
    const ledgerHeadBefore = h.k.ledger.head()
    h.clock.advance(60_000)
    await h.k.stop()
    h.k = await Kernel.create({ home: h.home, clock: h.clock, scrypt: FAST_SCRYPT, deviceKeyProvider: fileProvider, timers: false, sleep: async () => undefined })
    try {
      const result = h.k.trading.lookupConfirmedFill(input)
      expect(result).toEqual({ fillId: fill.fillId, alreadyRecorded: true })
      expect(h.k.orders.fills({ accountId: input.accountId, orderId: order.orderId, limit: 1000 })).toHaveLength(fillCountBefore)
      expect(h.k.ledger.head()).toEqual(ledgerHeadBefore)
      expect(h.k.trading.confirmationPending(input.accountId)).toBe(false)
    } finally { await h.k.stop() }
  })

  it('returns a matching receipt while post-commit effects are pending without replaying them', async () => {
    const order = await openOrder()
    const input = confirmationInput(order)
    const fill = inferredFill(order, input)
    const applyConfirmed = (h.k.trading as unknown as { applyConfirmedFill(f: Fill, o: Origin, i: ReconcileConfirmInput): unknown }).applyConfirmedFill
    const original = h.k.protectors.onFill.bind(h.k.protectors)
    h.k.protectors.onFill = () => { throw new Error('injected pending effect') }
    try { applyConfirmed.call(h.k.trading, fill, origin(), input) }
    finally { h.k.protectors.onFill = original }
    const ledgerHeadBefore = h.k.ledger.head()
    let orderEvents = 0, fillEvents = 0, ledgerEvents = 0
    const offOrder = h.k.events.subscribe('account.orders', () => { orderEvents++ })
    const offFill = h.k.events.subscribe('account.fills', () => { fillEvents++ })
    const offLedger = h.k.events.subscribe('ledger.entry', () => { ledgerEvents++ })
    try {
      expect(h.k.trading.lookupConfirmedFill(input)).toEqual({ fillId: fill.fillId, alreadyRecorded: true })
      expect(h.k.trading.confirmationPending(input.accountId)).toBe(true)
      expect(h.k.ledger.head()).toEqual(ledgerHeadBefore)
      expect([orderEvents, fillEvents, ledgerEvents]).toEqual([0, 0, 0])
    } finally { offOrder(); offFill(); offLedger() }
  })

  it('deduplicates repeated late venue evidence with a newly generated local fill id', async () => {
    const order = await openOrder()
    if (!order.venueOrderId) throw new Error('test order lacks its venue order identity')
    const input = confirmationInput(order)
    const applyConfirmed = (h.k.trading as unknown as { applyConfirmedFill(f: Fill, o: Origin, i: ReconcileConfirmInput): unknown }).applyConfirmedFill
    applyConfirmed.call(h.k.trading, inferredFill(order, input), origin(), input)
    const real: VenueFill = {
      venueFillId: 'venue_late_duplicate_01', venueOrderId: order.venueOrderId, clientOrderId: order.clientOrderId,
      instrumentId: BTC as never, side: 'buy', price: '80000' as never, size: '0.00001' as never,
      fee: '0' as never, feeCcy: 'USDC', liquidity: 'maker', realizedPnl: '0' as never, ts: h.clock.now() + 1,
    }
    h.k.trading.onVenueFill(input.accountId, real)
    const ledgerAfterFirst = h.k.ledger.head()
    const rowsAfterFirst = h.k.db.prepare("SELECT COUNT(*) c FROM docs WHERE coll='reconcile-late-evidence'").get() as { c: number }
    let duplicateError: string | undefined
    try { h.k.trading.onVenueFill(input.accountId, real) } catch (error) { duplicateError = errorName(error) }
    const rowsAfterDuplicate = h.k.db.prepare("SELECT COUNT(*) c FROM docs WHERE coll='reconcile-late-evidence'").get() as { c: number }
    const ledgerAfterDuplicate = h.k.ledger.head()
    const result = { rowsAfterFirst: rowsAfterFirst.c, rowsAfterDuplicate: rowsAfterDuplicate.c, duplicateError,
      ledgerUnchanged: JSON.stringify(ledgerAfterFirst) === JSON.stringify(ledgerAfterDuplicate) }
    writeRedResult('B3-08C1-luna-red-duplicate-evidence-result.json', result)

    expect(result.duplicateError).toBeUndefined()
    expect(result.rowsAfterDuplicate).toBe(result.rowsAfterFirst)
    expect(result.ledgerUnchanged).toBe(true)
  })

  it('reports a corrupt durable receipt before comparing conflicting caller input', async () => {
    const order = await openOrder()
    const input = confirmationInput(order)
    const fill = inferredFill(order, input)
    const applyConfirmed = (h.k.trading as unknown as { applyConfirmedFill(f: Fill, o: Origin, i: ReconcileConfirmInput): unknown }).applyConfirmedFill
    applyConfirmed.call(h.k.trading, fill, origin(), input)
    const conflictingInput = { ...input, fee: '0.0002' as never }
    let validConflict: string | undefined
    try { h.k.trading.lookupConfirmedFill(conflictingInput) } catch (error) { validConflict = errorName(error) }
    const stored = h.k.db.prepare("SELECT id, doc FROM docs WHERE coll='reconcile-confirm-receipt' ORDER BY ver DESC LIMIT 1").get() as { id: string; doc: string }
    const receipt = JSON.parse(stored.doc) as { input: ReconcileConfirmInput; [key: string]: unknown }
    receipt.input = { ...receipt.input, fee: 'corrupt-decimal' as never }
    h.k.docs.put('reconcile-confirm-receipt', stored.id, receipt)
    let corruptConflict: string | undefined
    try { h.k.trading.lookupConfirmedFill(conflictingInput) } catch (error) { corruptConflict = errorName(error) }
    receipt.input = input
    receipt.fillId = 'fill_missing_receipt_target'
    h.k.docs.put('reconcile-confirm-receipt', stored.id, receipt)
    let missingFill: string | undefined
    try { h.k.trading.lookupConfirmedFill(input) } catch (error) { missingFill = errorName(error) }
    const result = { validConflict, corruptConflict, missingFill }
    writeRedResult('B3-08C1-luna-red-corrupt-receipt-result.json', result)

    expect(result.validConflict).toBe('INVALID_PARAMS')
    expect(result.corruptConflict).toBe('STATE_FILE_CORRUPT')
    expect(result.missingFill).toBe('STATE_FILE_CORRUPT')
  })

  it('rejects an explicit false inferred provenance value through ordinary applyFill', async () => {
    const order = await openOrder()
    const input = confirmationInput(order)
    const candidate = { ...inferredFill(order, input), inferred: false } as unknown as Fill
    let error: string | undefined
    let accepted = false
    try { accepted = h.k.trading.applyFill(candidate, origin()) } catch (caught) { error = errorName(caught) }
    const result = { accepted, error, fillStored: !!h.k.orders.fillWithId(candidate), ledgerFillCount: h.k.ledger.query({ types: ['fill'], accountId: input.accountId }).length }
    writeRedResult('B3-08C1-luna-red-false-proof-result.json', result)

    expect(result.accepted).toBe(false)
    expect(result.error).toBe('INVALID_PARAMS')
    expect(result.fillStored).toBe(false)
    expect(result.ledgerFillCount).toBe(0)
  })

  it('records direct applyFill late evidence without inserting a second economic fill', async () => {
    const order = await openOrder()
    const input = confirmationInput(order)
    const inferred = inferredFill(order, input)
    const applyConfirmed = (h.k.trading as unknown as { applyConfirmedFill(f: Fill, o: Origin, i: ReconcileConfirmInput): unknown }).applyConfirmedFill
    applyConfirmed.call(h.k.trading, inferred, origin(), input)
    const { inferred: _proof, ...real } = inferredFill(order, { ...input, suggestionId: `${input.suggestionId}_real` })
    const accepted = h.k.trading.applyFill({ ...real, fillId: 'fill_direct_late_probe' as never, venueFillId: 'venue_direct_late_probe' }, origin())
    const result = { accepted, fillCount: h.k.orders.fills({ accountId: input.accountId, orderId: order.orderId, limit: 1000 }).length,
      pending: h.k.trading.lateRealEvidencePending(input.accountId), ledgerFillCount: h.k.ledger.query({ types: ['fill'], accountId: input.accountId }).length }
    writeRedResult('B3-08C1-luna-red-direct-apply-result.json', result)

    expect(result.accepted).toBe(false)
    expect(result.fillCount).toBe(1)
    expect(result.pending).toBe(true)
    expect(result.ledgerFillCount).toBe(1)
  })

  it('records cached late evidence in the public submit prepare path before its receipt', async () => {
    let localOrderId: string | undefined
    const fake = h.sim as unknown as { o: { onSubmit?: (intents: OrderIntent[]) => void } }
    fake.o.onSubmit = (intents) => {
      const clientOrderId = intents[0]?.clientOrderId
      if (!clientOrderId) throw new Error('submit intent lacks its client order identity')
      const order = h.k.orders.byClientOrderId(clientOrderId)
      if (!order) throw new Error('submit order was not persisted before connector invocation')
      localOrderId = order.orderId
      const input = confirmationInput(order)
      const applyConfirmed = (h.k.trading as unknown as { applyConfirmedFill(f: Fill, o: Origin, i: ReconcileConfirmInput): unknown }).applyConfirmedFill
      applyConfirmed.call(h.k.trading, inferredFill(order, input), origin(), input)
      h.k.trading.onVenueFill(input.accountId, {
        venueFillId: 'venue_submit_prepare_late_01', venueOrderId: 'vo-1', clientOrderId,
        instrumentId: BTC as never, side: 'buy', price: '80000' as never, size: '0.00001' as never,
        fee: '0' as never, feeCcy: 'USDC', liquidity: 'maker', realizedPnl: '0' as never, ts: h.clock.now() + 1,
      })
    }
    const result = await h.k.trading.place({ intent: { accountId: h.paper.accountId as never, instrumentId: BTC as never, side: 'buy', type: 'limit',
      tif: 'gtc', size: '0.012' as never, price: '80000' as never, leverage: 2, reason: 'submit prepare late test' } }, h.human())
    const order = result.order
    if (!order || order.orderId !== localOrderId) throw new Error('submit order identity was not retained')
    const outcome = { filledSize: order.filledSize, fillCount: h.k.orders.fills({ accountId: order.accountId, orderId: order.orderId, limit: 1000 }).length,
      pending: h.k.trading.lateRealEvidencePending(order.accountId), state: h.k.tstate.get({ type: 'account', id: order.accountId }) }
    writeRedResult('B3-08C1-luna-red-submit-prepare-result.json', outcome)

    expect(outcome.filledSize).toBe('0.00001')
    expect(outcome.fillCount).toBe(1)
    expect(outcome.pending).toBe(true)
    expect(outcome.state).toBe('HALTED')
  })

  it('records child pending fills through recordChildren and rejects venue inferred injection', async () => {
    const childClientOrderId = '11111111111111111111111111111111'
    const childVenueOrderId = 'child-venue-test-01'
    const submit = h.sim.submit.bind(h.sim)
    let injectionError: string | undefined
    h.sim.submit = async (ctx, intents) => {
      const result = await submit(ctx, intents)
      try {
        h.k.trading.onVenueFill(h.paper.accountId, { venueFillId: 'venue_child_injected_01', venueOrderId: childVenueOrderId,
          clientOrderId: childClientOrderId, instrumentId: BTC as never, side: 'sell', price: '81900' as never,
          size: '0.00001' as never, fee: '0' as never, feeCcy: 'USDC', liquidity: 'maker', realizedPnl: '0' as never,
          ts: h.clock.now(), inferred: false } as unknown as VenueFill)
      } catch (error) { injectionError = errorName(error) }
      const childFill: VenueFill = { venueFillId: 'venue_child_pending_01', venueOrderId: childVenueOrderId,
        clientOrderId: childClientOrderId, instrumentId: BTC as never, side: 'sell', price: '81900' as never,
        size: '0.00001' as never, fee: '0' as never, feeCcy: 'USDC', liquidity: 'maker', realizedPnl: '0' as never, ts: h.clock.now() }
      h.k.trading.onVenueFill(h.paper.accountId, childFill)
      const childAck = { intentIndex: 0, clientOrderId: childClientOrderId, venueOrderId: childVenueOrderId, status: 'open' as const,
        filledSize: '0' as never, avgFillPrice: null, builder: { attached: false }, role: 'tp' as const }
      return { ...result, acks: [...result.acks, childAck] }
    }
    const placed = await h.k.trading.place({ intent: { accountId: h.paper.accountId as never, instrumentId: BTC as never, side: 'buy', type: 'limit',
      tif: 'gtc', size: '0.012' as never, price: '80000' as never, leverage: 2,
      tpsl: { grouping: 'order', takeProfit: { triggerPrice: '82000' as never, price: '81900' as never } }, reason: 'child pending fill test' } }, h.human())
    const child = h.k.orders.list().find((candidate) => candidate.parentOrderId === placed.order?.orderId && candidate.tpslRole === 'tp')
    const childFills = child ? h.k.orders.fills({ accountId: child.accountId, orderId: child.orderId, limit: 1000 }) : []
    const outcome = { childCreated: !!child, childFillCount: childFills.length, childFillIdMatches: childFills[0]?.venueFillId === 'venue_child_pending_01', injectionError }
    writeRedResult('B3-08C1-luna-red-child-prepare-result.json', outcome)

    expect(outcome.childCreated).toBe(true)
    expect(outcome.childFillCount).toBe(1)
    expect(outcome.childFillIdMatches).toBe(true)
    expect(outcome.injectionError).toBe('INVALID_PARAMS')
  })

  it('records a cached late fill when an order update invokes the pending-fill prepare path', async () => {
    h.sim.script = ['unknown']
    const result = await h.k.trading.place({ intent: { accountId: h.paper.accountId as never, instrumentId: BTC as never, side: 'buy', type: 'limit',
      tif: 'gtc', size: '0.012' as never, price: '80000' as never, leverage: 2, reason: 'order update pending fill test' } }, h.human())
    const order = result.order
    if (!order) throw new Error('unknown order was not returned')
    const input = confirmationInput(order)
    const applyConfirmed = (h.k.trading as unknown as { applyConfirmedFill(f: Fill, o: Origin, i: ReconcileConfirmInput): unknown }).applyConfirmedFill
    applyConfirmed.call(h.k.trading, inferredFill(order, input), origin(), input)
    h.k.trading.onVenueFill(input.accountId, { venueFillId: 'venue_order_update_late_01', venueOrderId: 'venue-order-update-01',
      clientOrderId: null, instrumentId: BTC as never, side: 'buy', price: '80000' as never, size: '0.00001' as never,
      fee: '0' as never, feeCcy: 'USDC', liquidity: 'maker', realizedPnl: '0' as never, ts: h.clock.now() + 1 })
    h.k.trading.onOrderUpdate(input.accountId, { venueOrderId: 'venue-order-update-01', clientOrderId: order.clientOrderId, status: 'open' })
    const outcome = { fillCount: h.k.orders.fills({ accountId: input.accountId, orderId: order.orderId, limit: 1000 }).length,
      pending: h.k.trading.lateRealEvidencePending(input.accountId), state: h.k.tstate.get({ type: 'account', id: input.accountId }) }
    writeRedResult('B3-08C1-luna-red-order-update-prepare-result.json', outcome)

    expect(outcome.fillCount).toBe(1)
    expect(outcome.pending).toBe(true)
    expect(outcome.state).toBe('HALTED')
  })

  it('persists late evidence before a later submit receipt transaction rolls back', async () => {
    let orderId: string | undefined
    const fake = h.sim as unknown as { o: { onSubmit?: (intents: OrderIntent[]) => void } }
    fake.o.onSubmit = (intents) => {
      const clientOrderId = intents[0]?.clientOrderId
      if (!clientOrderId) throw new Error('submit intent lacks its client order identity')
      const order = h.k.orders.byClientOrderId(clientOrderId)
      if (!order) throw new Error('submit order was not persisted before connector invocation')
      orderId = order.orderId
      const input = confirmationInput(order)
      const applyConfirmed = (h.k.trading as unknown as { applyConfirmedFill(f: Fill, o: Origin, i: ReconcileConfirmInput): unknown }).applyConfirmedFill
      applyConfirmed.call(h.k.trading, inferredFill(order, input), origin(), input)
      h.k.trading.onVenueFill(input.accountId, {
        venueFillId: 'venue_late_submit_receipt_rollback', venueOrderId: 'vo-1', clientOrderId,
        instrumentId: BTC as never, side: 'buy', price: '80000' as never, size: '0.00001' as never,
        fee: '0' as never, feeCcy: 'USDC', liquidity: 'maker', realizedPnl: '0' as never, ts: h.clock.now() + 1,
      })
    }
    h.k.db.exec("CREATE TRIGGER fail_submit_receipt BEFORE INSERT ON ledger WHEN NEW.type='order.accepted' BEGIN SELECT RAISE(ABORT, 'injected receipt failure'); END")
    let submitError: string | undefined
    try {
      await h.k.trading.place({ intent: { accountId: h.paper.accountId as never, instrumentId: BTC as never, side: 'buy', type: 'limit',
        tif: 'gtc', size: '0.012' as never, price: '80000' as never, leverage: 2, reason: 'late receipt rollback test' } }, h.human())
    } catch { submitError = 'rejected' }
    finally { h.k.db.exec('DROP TRIGGER fail_submit_receipt') }
    const evidenceCount = h.k.db.prepare("SELECT COUNT(*) c FROM docs WHERE coll='reconcile-late-evidence'").get() as { c: number }
    const pending = h.k.docs.get<unknown>('reconcile-late-pending', h.paper.accountId)
    const result = { submitError, orderIdPresent: !!orderId, evidenceCount: evidenceCount.c, pending: pending === true,
      fillCount: orderId ? h.k.orders.fills({ accountId: h.paper.accountId, orderId, limit: 1000 }).length : -1 }
    writeRedResult('B3-08C1-luna-red-preflight-rollback-result.json', result)

    expect(result.submitError).toBe('rejected')
    expect(result.orderIdPresent).toBe(true)
    expect(result.evidenceCount).toBe(1)
    expect(result.pending).toBe(true)
    expect(result.fillCount).toBe(1)
  })

  it('does not let an in-flight submit acknowledgement raise an inferred order quantity', async () => {
    let beforeAck: string | undefined
    const fake = h.sim as unknown as { o: { onSubmit?: (intents: OrderIntent[]) => void } }
    fake.o.onSubmit = (intents) => {
      const clientOrderId = intents[0]?.clientOrderId
      if (!clientOrderId) throw new Error('submit intent lacks its client order identity')
      const order = h.k.orders.byClientOrderId(clientOrderId)
      if (!order) throw new Error('submit order was not persisted before connector invocation')
      const input = confirmationInput(order)
      const fill = inferredFill(order, input)
      const applyConfirmed = (h.k.trading as unknown as { applyConfirmedFill(f: Fill, o: Origin, i: ReconcileConfirmInput): unknown }).applyConfirmedFill
      applyConfirmed.call(h.k.trading, fill, origin(), input)
      beforeAck = h.k.orders.get(order.orderId)?.filledSize
    }
    const result = await h.k.trading.place({ intent: {
      accountId: h.paper.accountId as never, instrumentId: BTC as never, side: 'buy', type: 'market',
      tif: 'gtc', size: '0.012' as never, leverage: 2, reason: 'submit receipt cumulative guard',
    } }, h.human())
    const order = result.order
    if (!order) throw new Error('market order was not returned')
    const outcome = { beforeAck, filledSizeAfter: order.filledSize, statusAfter: order.status }
    writeRedResult('B3-08C1-luna-red-submit-ack-result.json', outcome)

    expect(outcome.beforeAck).toBe('0.00001')
    expect(outcome.filledSizeAfter).toBe(outcome.beforeAck)
    expect(outcome.statusAfter).toBe('partially_filled')
    expect(h.k.trading.lateRealEvidencePending(h.paper.accountId)).toBe(true)
  })

  it('keeps normal submit acknowledgement behavior without an inferred fill', async () => {
    const result = await h.k.trading.place({ intent: {
      accountId: h.paper.accountId as never, instrumentId: BTC as never, side: 'buy', type: 'market',
      tif: 'gtc', size: '0.012' as never, leverage: 2, reason: 'normal submit receipt control',
    } }, h.human())
    expect(result.order?.filledSize).toBe('0.012')
    expect(h.k.orders.fills({ accountId: h.paper.accountId, orderId: result.order!.orderId, limit: 1000 })).toHaveLength(1)
  })

  it('does not let an in-flight amend acknowledgement raise an inferred order quantity after a late fill', async () => {
    const order = await openOrder()
    if (!order.venueOrderId) throw new Error('test order lacks its venue order identity')
    const input = confirmationInput(order)
    const fill = inferredFill(order, input)
    const applyConfirmed = (h.k.trading as unknown as { applyConfirmedFill(f: Fill, o: Origin, i: ReconcileConfirmInput): unknown }).applyConfirmedFill
    applyConfirmed.call(h.k.trading, fill, origin(), input)
    h.clock.advance(6_000)
    let beforeAck: string | undefined
    h.sim.amend = async (ctx, req) => {
      h.sim.amendCalls.push({ ctx, req })
      const real: VenueFill = {
        venueFillId: 'venue_late_amend_real_01', venueOrderId: order.venueOrderId!, clientOrderId: order.clientOrderId,
        instrumentId: BTC as never, side: 'buy', price: '80000' as never, size: '0.00001' as never,
        fee: '0' as never, feeCcy: 'USDC', liquidity: 'maker', realizedPnl: '0' as never, ts: h.clock.now() + 1,
      }
      h.k.trading.onVenueFill(input.accountId, real)
      beforeAck = h.k.orders.get(order.orderId)?.filledSize
      return { acks: [{ intentIndex: 0, clientOrderId: order.clientOrderId, venueOrderId: order.venueOrderId ?? null,
        status: 'open', filledSize: '0.002' as never, avgFillPrice: null, builder: { attached: false } }],
        receiptHash: 'ab'.repeat(32), requestWeight: 1 }
    }
    const amended = await h.k.trading.amend(h.human(), { accountId: input.accountId, orderId: order.orderId, price: '79000' })
    const outcome = { beforeAck, filledSizeAfter: amended.order.filledSize, statusAfter: amended.order.status }
    writeRedResult('B3-08C1-luna-red-amend-ack-result.json', outcome)

    expect(outcome.beforeAck).toBe('0.00001')
    expect(outcome.filledSizeAfter).toBe(outcome.beforeAck)
    expect(outcome.statusAfter).toBe('partially_filled')
    expect(h.k.trading.lateRealEvidencePending(input.accountId)).toBe(true)
  })

  it('keeps normal amend acknowledgement max behavior without an inferred fill', async () => {
    const order = await openOrder()
    h.clock.advance(6_000)
    h.sim.amend = async (ctx, req) => {
      h.sim.amendCalls.push({ ctx, req })
      return { acks: [{ intentIndex: 0, clientOrderId: order.clientOrderId, venueOrderId: order.venueOrderId ?? null,
        status: 'open', filledSize: '0.002' as never, avgFillPrice: null, builder: { attached: false } }],
        receiptHash: 'ab'.repeat(32), requestWeight: 1 }
    }
    const amended = await h.k.trading.amend(h.human(), { accountId: order.accountId, orderId: order.orderId, price: '79000' })
    expect(amended.order.filledSize).toBe('0.002')
    expect(amended.order.status).toBe('partially_filled')
  })

  it('writes the human assertion into the actual inferred-fill ledger entry', async () => {
    const order = await openOrder()
    const input = confirmationInput(order)
    const fill = inferredFill(order, input)
    const applyConfirmed = (h.k.trading as unknown as { applyConfirmedFill(f: Fill, o: Origin, i: ReconcileConfirmInput): unknown }).applyConfirmedFill
    applyConfirmed.call(h.k.trading, fill, origin(), input)
    const entry = h.k.ledger.query({ types: ['fill'], accountId: input.accountId }).find((row) => row.subject.fillId === fill.fillId)
    const result = {
      entryFound: !!entry,
      attestation: entry?.attestation,
      inferredProof: (entry?.payload as { inferred?: unknown } | undefined)?.inferred,
      expectedProof: fill.inferred,
    }
    writeRedResult('B3-08C1-luna-red-ledger-result.json', result)

    expect(entry?.attestation).toBe('user-asserted')
    expect((entry?.payload as { inferred?: unknown } | undefined)?.inferred).toEqual(fill.inferred)
  })

  it('refuses a late real venue fill after an inferred fill without double-booking', async () => {
    const order = await openOrder()
    if (!order.venueOrderId) throw new Error('test order lacks its venue order identity')
    const input = confirmationInput(order)
    const inferred = inferredFill(order, input)
    const applyConfirmed = (h.k.trading as unknown as { applyConfirmedFill(f: Fill, o: Origin, i: ReconcileConfirmInput): unknown }).applyConfirmedFill
    applyConfirmed.call(h.k.trading, inferred, origin(), input)
    const ledgerBefore = h.k.ledger.query({ types: ['fill'], accountId: input.accountId }).length
    const orderBefore = h.k.orders.get(order.orderId)
    const real: VenueFill = {
      venueFillId: 'venue_late_real_01', venueOrderId: order.venueOrderId, clientOrderId: order.clientOrderId,
      instrumentId: BTC as never, side: 'buy', price: '80000' as never, size: '0.00001' as never,
      fee: '0' as never, feeCcy: 'USDC', liquidity: 'maker', realizedPnl: '0' as never, ts: h.clock.now() + 1,
    }
    h.k.trading.onVenueFill(input.accountId, real)
    const orderAfter = h.k.orders.get(order.orderId)
    const result = {
      fillCount: h.k.orders.fills({ accountId: input.accountId, orderId: order.orderId, limit: 1000 }).length,
      fillLedgerCount: h.k.ledger.query({ types: ['fill'], accountId: input.accountId }).length,
      filledSizeBefore: orderBefore?.filledSize,
      filledSizeAfter: orderAfter?.filledSize,
      feeBefore: orderBefore?.fee,
      feeAfter: orderAfter?.fee,
      haltReason: h.k.tstate.get({ type: 'account', id: input.accountId }),
      lateEvidencePending: (h.k.trading as unknown as { lateRealEvidencePending?: (accountId: string) => boolean }).lateRealEvidencePending?.(input.accountId),
      unrelatedAccountState: h.k.tstate.get({ type: 'account', id: h.liveAcct.accountId }),
      unrelatedAccountPending: h.k.trading.lateRealEvidencePending(h.liveAcct.accountId),
    }
    writeRedResult('B3-08C1-luna-red-late-fill-result.json', result)

    expect(result.fillCount).toBe(1)
    expect(result.fillLedgerCount).toBe(ledgerBefore)
    expect(result.filledSizeAfter).toBe(result.filledSizeBefore)
    expect(result.feeAfter).toBe(result.feeBefore)
    expect(result.lateEvidencePending).toBe(true)
    expect(result.haltReason).toBe('HALTED')
    expect(result.unrelatedAccountState).not.toBe('HALTED')
    expect(result.unrelatedAccountPending).toBe(false)
  })
})
