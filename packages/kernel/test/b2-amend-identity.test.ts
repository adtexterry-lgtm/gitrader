// SPDX-License-Identifier: CPAL-1.0
import { afterEach, describe, expect, it, vi } from 'vitest'
import { asDecimal } from '@gitrader/protocol'
import type { SubmitResult, VenueFill } from '@gitrader/protocol/connector'
import { Kernel } from '../src/kernel'
import { fileProvider } from '../src/device-key'
import type { Order } from '../src/proto'
import { mkOrigin } from '../src/util/origin'
import { FAST_SCRYPT, makeHarness } from './helpers/harness'
import type { Harness } from './helpers/harness'

const OLD_ID = 'venue-old-321'
const NEW_ID = 'venue-new-654'
type OrderRecord = { reservation?: { notional: string; margin?: string }; amendPending?: { reservation: { notional: string; margin?: string } }; supersededVenueOrderIds?: string[]; replacementVenueOrderId?: string }

let activeHarness: Harness | undefined
let restartedKernel: Kernel | undefined

afterEach(async () => {
  await restartedKernel?.stop().catch(() => undefined)
  restartedKernel = undefined
  await activeHarness?.cleanup()
  activeHarness = undefined
})

async function setup(): Promise<Harness> {
  activeHarness = await makeHarness()
  return activeHarness
}

async function placeOpenOrder(h: Harness): Promise<Order> {
  const placed = await h.k.trading.place({ intent: {
    accountId: h.paper.accountId as never,
    instrumentId: 'hyperliquid:BTC' as never,
    side: 'buy', type: 'limit', size: asDecimal('0.003'), price: asDecimal('79000'), reason: 'amend identity fixture',
  } }, h.human())
  expect(placed.order).toMatchObject({ status: 'open', size: '0.003', price: '79000' })
  const order = placed.order!
  const venueOrder = h.sim.orders.find((item) => item.clientOrderId === order.clientOrderId)!
  venueOrder.venueOrderId = OLD_ID
  h.k.trading.onOrderUpdate(h.paper.accountId, { venueOrderId: OLD_ID, clientOrderId: order.clientOrderId, status: 'open' })
  h.clock.advance(6000)
  return h.k.orders.get(order.orderId)!
}

function ackFor(order: Order, venueOrderId = NEW_ID): SubmitResult {
  return {
    acks: [{ intentIndex: 0, clientOrderId: order.clientOrderId, venueOrderId, status: 'open', filledSize: '0' as never, avgFillPrice: null, builder: { attached: false } }],
    receiptHash: 'ab'.repeat(32) as never,
    requestWeight: 1,
  }
}

function amend(h: Harness, order: Order): Promise<{ order: Order }> {
  return h.k.trading.amend(h.human(), { accountId: h.paper.accountId, orderId: order.orderId, size: '0.004' })
}

function installAck(h: Harness, order: Order): void {
  const venueOrder = h.sim.orders.find((item) => item.clientOrderId === order.clientOrderId)!
  vi.spyOn(h.sim, 'amend').mockImplementation(async (ctx, req) => {
    h.sim.amendCalls.push({ ctx, req })
    venueOrder.venueOrderId = NEW_ID
    return ackFor(order)
  })
}

describe('B2 amended venue identity survives updates and restart', () => {
  it('uses the acknowledged ID for lookup/cancel/restart and links old-ID fills without clientOrderId', async () => {
    const h = await setup()
    const order = await placeOpenOrder(h)
    installAck(h, order)
    const status = vi.spyOn(h.sim, 'orderStatus').mockImplementation(async (_ref, key) => ({
      found: true, status: 'open', venueOrderId: key.venueOrderId, filledSize: '0' as never,
    }))

    const amended = await amend(h, order)
    expect(status).toHaveBeenCalledTimes(1)
    expect(status.mock.calls[0]?.[1]).toMatchObject({ venueOrderId: NEW_ID, clientOrderId: order.clientOrderId, instrumentId: order.instrumentId })
    expect(amended.order).toMatchObject({ venueOrderId: NEW_ID, status: 'open', size: '0.004' })
    expect(h.k.docs.get<OrderRecord>('order-record', order.orderId)?.supersededVenueOrderIds).toEqual([OLD_ID])

    await h.k.trading.cancel({ accountId: h.paper.accountId, orderId: order.orderId }, h.human())
    expect(h.sim.cancelCalls[0]?.[0]).toMatchObject({ venueOrderId: NEW_ID, clientOrderId: order.clientOrderId })
    expect(status.mock.calls[1]?.[1]).toMatchObject({ venueOrderId: NEW_ID })
    expect(h.k.orders.get(order.orderId)).toMatchObject({ venueOrderId: NEW_ID, status: 'open' })

    await h.k.stop()
    restartedKernel = await Kernel.create({ home: h.home, clock: h.clock, scrypt: FAST_SCRYPT, deviceKeyProvider: fileProvider, timers: false, sleep: async () => undefined })
    const restartedSim = new (await import('./helpers/fake-connector')).FakeConnector({ id: 'kernel-sim', clock: h.clock })
    restartedKernel.registerConnector(restartedSim)
    const restartStatus = vi.spyOn(restartedSim, 'orderStatus').mockResolvedValue({ found: true, status: 'open', venueOrderId: NEW_ID, filledSize: '0' as never })
    const token = restartedKernel.auth.exchangeBoot(restartedKernel.auth.mintBootToken())
    const principal = restartedKernel.auth.authenticateToken(token.sessionToken)!
    const restartedCtx = { principal, origin: mkOrigin('user:usr_restart', 'order.lookup', 'ui') }
    const restored = await restartedKernel.trading.lookup({ orderId: order.orderId }, restartedCtx)
    expect(restartStatus).toHaveBeenCalledTimes(1)
    expect(restartStatus.mock.calls[0]?.[1]).toMatchObject({ venueOrderId: NEW_ID, clientOrderId: order.clientOrderId })
    expect(restored.order).toMatchObject({ venueOrderId: NEW_ID, status: 'open' })

    restartedKernel.trading.onOrderUpdate(order.accountId, { venueOrderId: OLD_ID, clientOrderId: order.clientOrderId, status: 'expired' })
    expect(restartedKernel.orders.get(order.orderId)).toMatchObject({ venueOrderId: NEW_ID, status: 'open' })
    const oldFill: VenueFill = {
      venueOrderId: OLD_ID, clientOrderId: null, venueFillId: 'fill-old-01', instrumentId: order.instrumentId,
      side: 'buy', price: '79000' as never, size: '0.001' as never, fee: '0' as never, feeCcy: 'USDC',
      liquidity: 'taker', realizedPnl: '0' as never, ts: h.clock.now() as never,
    }
    restartedKernel.trading.onVenueFill(order.accountId, oldFill)
    restartedKernel.trading.onVenueFill(order.accountId, oldFill)
    expect(restartedKernel.orders.fills({ orderId: order.orderId, limit: 10 })).toHaveLength(1)
    expect(restartedKernel.orders.get(order.orderId)).toMatchObject({ venueOrderId: NEW_ID, filledSize: '0.001', status: 'partially_filled' })
  })

  it('keeps the new identity and held reservation when lookup contradicts the acknowledgement', async () => {
    const h = await setup()
    const order = await placeOpenOrder(h)
    installAck(h, order)
    const status = vi.spyOn(h.sim, 'orderStatus').mockResolvedValue({ found: true, status: 'cancelled', venueOrderId: OLD_ID })

    await expect(amend(h, order)).rejects.toMatchObject({ problem: { name: 'VENUE_OUTCOME_UNKNOWN' } })
    expect(status).toHaveBeenCalledTimes(1)
    expect(status.mock.calls[0]?.[1]).toMatchObject({ venueOrderId: NEW_ID })
    expect(h.k.orders.get(order.orderId)).toMatchObject({ venueOrderId: NEW_ID, status: 'open' })
    const record = h.k.docs.get<OrderRecord>('order-record', order.orderId)!
    expect(record.supersededVenueOrderIds).toEqual([OLD_ID])
    expect(record.amendPending?.reservation.notional).toBe('316')
    expect(h.k.ledger.trace({ orderId: order.orderId })).toContainEqual(expect.objectContaining({ type: 'annotation', payload: expect.objectContaining({ kind: 'amend.unknown', reservation: expect.objectContaining({ notional: '316' }) }) }))
    expect(h.k.ledger.trace({ orderId: order.orderId }).some((entry) => entry.type === 'order.cancelled')).toBe(false)
  })

  it('defers an old-ID terminal update that arrives before the replacement acknowledgement', async () => {
    const h = await setup()
    const order = await placeOpenOrder(h)
    const venueOrder = h.sim.orders.find((item) => item.clientOrderId === order.clientOrderId)!
    let releaseAck!: (result: SubmitResult) => void
    let markAmendStarted!: () => void
    const amendStarted = new Promise<void>((resolve) => { markAmendStarted = resolve })
    vi.spyOn(h.sim, 'amend').mockImplementation(async (ctx, req) => {
      h.sim.amendCalls.push({ ctx, req })
      markAmendStarted()
      return new Promise<SubmitResult>((resolve) => { releaseAck = resolve })
    })
    const status = vi.spyOn(h.sim, 'orderStatus').mockImplementation(async (_ref, key) => ({ found: true, status: 'open', venueOrderId: key.venueOrderId }))
    const pending = amend(h, order)
    try {
      await amendStarted
      const fillDuringAck: VenueFill = {
        venueOrderId: OLD_ID, clientOrderId: order.clientOrderId, venueFillId: 'fill-during-amend-01', instrumentId: order.instrumentId,
        side: 'buy', price: '79000' as never, size: '0.003' as never, fee: '0' as never, feeCcy: 'USDC',
        liquidity: 'taker', realizedPnl: '0' as never, ts: h.clock.now() as never,
      }
      venueOrder.status = 'filled'
      h.k.trading.onVenueFill(order.accountId, fillDuringAck)
      expect(h.k.orders.get(order.orderId)).toMatchObject({ venueOrderId: OLD_ID, status: 'filled', filledSize: '0.003' })
      expect(h.k.docs.get<OrderRecord>('order-record', order.orderId)?.amendPending?.reservation.notional).toBe('316')
      const decide = vi.spyOn(h.k.gate, 'decide')
      await h.k.trading.preview({
        accountId: order.accountId as never, instrumentId: order.instrumentId, side: 'buy', type: 'limit',
        size: asDecimal('0.001'), price: asDecimal('79000'), reason: 'pending amendment risk probe',
      }, h.human()).catch(() => undefined)
      expect(decide).toHaveBeenCalled()
      expect(decide.mock.calls.at(-1)![0].reserved.account.margin).toBe('79')
      h.k.trading.onOrderUpdate(order.accountId, { venueOrderId: OLD_ID, clientOrderId: order.clientOrderId, status: 'expired' })
      expect(h.k.orders.get(order.orderId)).toMatchObject({ venueOrderId: OLD_ID, status: 'filled' })
      expect(h.k.docs.get<OrderRecord>('order-record', order.orderId)?.amendPending?.reservation.notional).toBe('316')
      expect(h.k.ledger.trace({ orderId: order.orderId }).some((entry) => entry.type === 'order.expired')).toBe(false)
      venueOrder.venueOrderId = NEW_ID
      releaseAck(ackFor(order))
      const result = await pending
      expect(status.mock.calls[0]?.[1]).toMatchObject({ venueOrderId: NEW_ID })
      expect(result.order).toMatchObject({ venueOrderId: NEW_ID, size: '0.004', filledSize: '0.003', status: 'partially_filled' })
      expect(h.k.orders.fills({ orderId: order.orderId, limit: 10 })).toHaveLength(1)
      expect(h.k.ledger.trace({ orderId: order.orderId }).some((entry) => entry.type === 'order.expired')).toBe(false)
    } finally {
      if (releaseAck) { venueOrder.venueOrderId = NEW_ID; releaseAck(ackFor(order)) }
      await pending.catch(() => undefined)
    }
  })

  it('keeps a real new-ID cancellation received during lookup after an old-ID full fill', async () => {
    const h = await setup()
    const order = await placeOpenOrder(h)
    const venueOrder = h.sim.orders.find((item) => item.clientOrderId === order.clientOrderId)!
    let releaseAck!: (result: SubmitResult) => void
    let markAmendStarted!: () => void
    const amendStarted = new Promise<void>((resolve) => { markAmendStarted = resolve })
    vi.spyOn(h.sim, 'amend').mockImplementation(async (ctx, req) => {
      h.sim.amendCalls.push({ ctx, req })
      markAmendStarted()
      return new Promise<SubmitResult>((resolve) => { releaseAck = resolve })
    })
    let completeLookup!: (result: { found: boolean; status?: string; venueOrderId?: string }) => void
    let markLookupStarted!: () => void
    const lookupStarted = new Promise<void>((resolve) => { markLookupStarted = resolve })
    vi.spyOn(h.sim, 'orderStatus').mockImplementation(async () => new Promise((resolve) => {
      completeLookup = resolve
      markLookupStarted()
    }))
    const pending = amend(h, order)
    try {
      await amendStarted
      venueOrder.status = 'filled'
      venueOrder.venueOrderId = NEW_ID
      const oldFill: VenueFill = {
        venueOrderId: OLD_ID, clientOrderId: order.clientOrderId, venueFillId: 'fill-before-new-cancel', instrumentId: order.instrumentId,
        side: 'buy', price: '79000' as never, size: '0.003' as never, fee: '0' as never, feeCcy: 'USDC',
        liquidity: 'taker', realizedPnl: '0' as never, ts: h.clock.now() as never,
      }
      h.k.trading.onVenueFill(order.accountId, oldFill)
      releaseAck(ackFor(order))
      await lookupStarted
      h.k.trading.onVenueFill(order.accountId, oldFill)
      const decide = vi.spyOn(h.k.gate, 'decide')
      await h.k.trading.preview({
        accountId: order.accountId as never, instrumentId: order.instrumentId, side: 'buy', type: 'limit',
        size: asDecimal('0.001'), price: asDecimal('79000'), reason: 'lookup-window reservation probe',
      }, h.human()).catch(() => undefined)
      expect(decide.mock.calls.at(-1)![0].reserved.account.margin).toBe('79')
      h.k.trading.onOrderUpdate(order.accountId, { venueOrderId: NEW_ID, clientOrderId: order.clientOrderId, status: 'cancelled' })
      completeLookup({ found: true, status: 'cancelled', venueOrderId: NEW_ID })
      const result = await pending
      expect(result.order).toMatchObject({ venueOrderId: NEW_ID, status: 'cancelled', filledSize: '0.003' })
      expect(h.k.ledger.trace({ orderId: order.orderId }).some((entry) => entry.type === 'order.cancelled')).toBe(true)
      const afterCancel = vi.spyOn(h.k.gate, 'decide')
      await h.k.trading.preview({
        accountId: order.accountId as never, instrumentId: order.instrumentId, side: 'buy', type: 'limit',
        size: asDecimal('0.001'), price: asDecimal('79000'), reason: 'cancelled amendment reservation probe',
      }, h.human()).catch(() => undefined)
      expect(afterCancel.mock.calls.at(-1)![0].reserved.account.margin).toBe('0')
    } finally {
      if (releaseAck) releaseAck(ackFor(order))
      if (completeLookup) completeLookup({ found: true, status: 'cancelled', venueOrderId: NEW_ID })
      await pending.catch(() => undefined)
    }
  })

  it('restores a terminal order pending reservation into the real gate after restart', async () => {
    const h = await setup()
    const order = await placeOpenOrder(h)
    const venueOrder = h.sim.orders.find((item) => item.clientOrderId === order.clientOrderId)!
    let releaseAck!: (result: SubmitResult) => void
    let markAmendStarted!: () => void
    const amendStarted = new Promise<void>((resolve) => { markAmendStarted = resolve })
    vi.spyOn(h.sim, 'amend').mockImplementation(async (ctx, req) => {
      h.sim.amendCalls.push({ ctx, req })
      markAmendStarted()
      return new Promise<SubmitResult>((resolve) => { releaseAck = resolve })
    })
    vi.spyOn(h.sim, 'orderStatus').mockResolvedValue({ found: true, status: 'cancelled', venueOrderId: OLD_ID })
    const pending = amend(h, order)
    await amendStarted
    venueOrder.status = 'filled'
    h.k.trading.onVenueFill(order.accountId, {
      venueOrderId: OLD_ID, clientOrderId: order.clientOrderId, venueFillId: 'fill-before-restart', instrumentId: order.instrumentId,
      side: 'buy', price: '79000' as never, size: '0.003' as never, fee: '0' as never, feeCcy: 'USDC',
      liquidity: 'taker', realizedPnl: '0' as never, ts: h.clock.now() as never,
    })
    venueOrder.venueOrderId = NEW_ID
    releaseAck(ackFor(order))
    await expect(pending).rejects.toMatchObject({ problem: { name: 'VENUE_OUTCOME_UNKNOWN' } })
    expect(h.k.orders.get(order.orderId)).toMatchObject({ status: 'filled', filledSize: '0.003' })
    expect(h.k.docs.get<OrderRecord>('order-record', order.orderId)?.amendPending?.reservation.notional).toBe('316')
    expect(h.k.docs.get<OrderRecord>('order-record', order.orderId)?.replacementVenueOrderId).toBe(NEW_ID)

    await h.k.stop()
    restartedKernel = await Kernel.create({ home: h.home, clock: h.clock, scrypt: FAST_SCRYPT, deviceKeyProvider: fileProvider, timers: false, sleep: async () => undefined })
    const { FakeConnector } = await import('./helpers/fake-connector')
    restartedKernel.registerConnector(new FakeConnector({ id: 'kernel-sim', clock: h.clock }))
    const token = restartedKernel.auth.exchangeBoot(restartedKernel.auth.mintBootToken())
    const principal = restartedKernel.auth.authenticateToken(token.sessionToken)!
    const ctx = { principal, origin: mkOrigin('user:usr_restart-risk', 'order.preview', 'ui') }
    const decide = vi.spyOn(restartedKernel.gate, 'decide')
    await restartedKernel.trading.preview({
      accountId: order.accountId as never, instrumentId: order.instrumentId, side: 'buy', type: 'limit',
      size: asDecimal('0.001'), price: asDecimal('79000'), reason: 'restarted pending risk probe',
    }, ctx).catch(() => undefined)
    expect(decide).toHaveBeenCalled()
    expect(decide.mock.calls.at(-1)![0].reserved.account.margin).toBe('79')
    restartedKernel.trading.onOrderUpdate(order.accountId, { venueOrderId: NEW_ID, clientOrderId: order.clientOrderId, status: 'cancelled' })
    expect(restartedKernel.orders.get(order.orderId)).toMatchObject({ venueOrderId: NEW_ID, status: 'cancelled', filledSize: '0.003' })
    expect(restartedKernel.ledger.trace({ orderId: order.orderId }).some((entry) => entry.type === 'order.cancelled')).toBe(true)
    const afterCancel = vi.spyOn(restartedKernel.gate, 'decide')
    await restartedKernel.trading.preview({
      accountId: order.accountId as never, instrumentId: order.instrumentId, side: 'buy', type: 'limit',
      size: asDecimal('0.001'), price: asDecimal('79000'), reason: 'restarted cancel reservation probe',
    }, ctx).catch(() => undefined)
    expect(afterCancel.mock.calls.at(-1)![0].reserved.account.margin).toBe('0')
  })

  it('ignores old-ID terminal updates during and after the replacement lookup window', async () => {
    const h = await setup()
    const order = await placeOpenOrder(h)
    installAck(h, order)
    let completeLookup!: (result: { found: boolean; status?: string; venueOrderId?: string }) => void
    let markLookupStarted!: () => void
    const lookupStarted = new Promise<void>((resolve) => { markLookupStarted = resolve })
    const status = vi.spyOn(h.sim, 'orderStatus').mockImplementation(async () => {
      return new Promise((resolve) => { completeLookup = resolve; markLookupStarted() })
    })
    const pending = amend(h, order)
    try {
      await lookupStarted
      h.k.trading.onOrderUpdate(order.accountId, { venueOrderId: OLD_ID, clientOrderId: order.clientOrderId, status: 'cancelled' })
      const during = h.k.docs.get<OrderRecord>('order-record', order.orderId)!
      expect(h.k.orders.get(order.orderId)).toMatchObject({ venueOrderId: NEW_ID, status: 'open' })
      expect(during.supersededVenueOrderIds).toEqual([OLD_ID])
      expect(during.amendPending?.reservation.notional).toBe('316')
      expect(h.k.ledger.trace({ orderId: order.orderId }).some((entry) => entry.type === 'order.cancelled')).toBe(false)
      completeLookup({ found: true, status: 'open', venueOrderId: NEW_ID })
      await pending
      expect(status.mock.calls[0]?.[1]).toMatchObject({ venueOrderId: NEW_ID })
      h.k.trading.onOrderUpdate(order.accountId, { venueOrderId: OLD_ID, clientOrderId: order.clientOrderId, status: 'expired' })
      expect(h.k.orders.get(order.orderId)).toMatchObject({ venueOrderId: NEW_ID, status: 'open' })
      expect(h.k.ledger.trace({ orderId: order.orderId }).some((entry) => entry.type === 'order.expired')).toBe(false)
    } finally {
      if (completeLookup) completeLookup({ found: true, status: 'open', venueOrderId: NEW_ID })
      await pending.catch(() => undefined)
    }
  })

  it('adopts a replacement discovered by lookup when ACK keeps the old ID', async () => {
    const h = await setup()
    const order = await placeOpenOrder(h)
    const venueOrder = h.sim.orders.find((item) => item.clientOrderId === order.clientOrderId)!
    vi.spyOn(h.sim, 'amend').mockImplementation(async (ctx, req) => {
      h.sim.amendCalls.push({ ctx, req })
      return ackFor(order, OLD_ID)
    })
    const status = vi.spyOn(h.sim, 'orderStatus').mockImplementation(async (_ref, _key) => {
      venueOrder.venueOrderId = NEW_ID
      return { found: true, status: 'open', venueOrderId: NEW_ID, filledSize: '0' as never }
    })

    const amended = await amend(h, order)
    expect(status).toHaveBeenCalledTimes(1)
    expect(status.mock.calls[0]?.[1]).toMatchObject({ venueOrderId: OLD_ID, clientOrderId: order.clientOrderId })
    expect(amended.order).toMatchObject({ venueOrderId: NEW_ID, status: 'open', size: '0.004' })
    expect(h.k.docs.get<OrderRecord>('order-record', order.orderId)?.supersededVenueOrderIds).toEqual([OLD_ID])

    h.k.trading.onOrderUpdate(order.accountId, { venueOrderId: OLD_ID, clientOrderId: order.clientOrderId, status: 'cancelled' })
    expect(h.k.orders.get(order.orderId)).toMatchObject({ venueOrderId: NEW_ID, status: 'open' })
    await h.k.trading.cancel({ accountId: h.paper.accountId, orderId: order.orderId }, h.human())
    expect(h.sim.cancelCalls[0]?.[0]).toMatchObject({ venueOrderId: NEW_ID, clientOrderId: order.clientOrderId })
  })

  it('keeps the current identity and pending budget when lookup returns a historical ID', async () => {
    const h = await setup()
    const order = await placeOpenOrder(h)
    const venueOrder = h.sim.orders.find((item) => item.clientOrderId === order.clientOrderId)!
    vi.spyOn(h.sim, 'amend').mockImplementation(async (ctx, req) => {
      h.sim.amendCalls.push({ ctx, req })
      venueOrder.venueOrderId = NEW_ID
      return ackFor(order, NEW_ID)
    })
    const status = vi.spyOn(h.sim, 'orderStatus')
      .mockResolvedValueOnce({ found: true, status: 'open', venueOrderId: NEW_ID, filledSize: '0' as never })
      .mockResolvedValueOnce({ found: true, status: 'open', venueOrderId: OLD_ID, filledSize: '0' as never })

    await amend(h, order)
    const current = h.k.orders.get(order.orderId)!
    h.clock.advance(6000)
    const second = h.k.trading.amend(h.human(), { accountId: h.paper.accountId, orderId: order.orderId, size: '0.005' })
    await expect(second).rejects.toMatchObject({ problem: { name: 'VENUE_OUTCOME_UNKNOWN' } })

    expect(h.sim.amendCalls[1]?.req.order.size).toBe('0.005')
    expect(status).toHaveBeenCalledTimes(2)
    expect(status.mock.calls[1]?.[1]).toMatchObject({ venueOrderId: NEW_ID, clientOrderId: order.clientOrderId })
    expect(h.k.orders.get(order.orderId)).toMatchObject({ venueOrderId: NEW_ID, status: 'open' })
    const record = h.k.docs.get<OrderRecord>('order-record', order.orderId)!
    expect(record.supersededVenueOrderIds).toEqual([OLD_ID])
    expect(record.amendPending?.reservation.notional).toBe('395')
    expect(current.venueOrderId).toBe(NEW_ID)
  })

  it('confirms cancellation during ACK wait without releasing replacement budget', async () => {
    const h = await setup()
    const order = await placeOpenOrder(h)
    const venueOrder = h.sim.orders.find((item) => item.clientOrderId === order.clientOrderId)!
    let releaseAck!: (result: SubmitResult) => void
    let markAmendStarted!: () => void
    const amendStarted = new Promise<void>((resolve) => { markAmendStarted = resolve })
    vi.spyOn(h.sim, 'amend').mockImplementation(async (ctx, req) => {
      h.sim.amendCalls.push({ ctx, req })
      markAmendStarted()
      return new Promise<SubmitResult>((resolve) => { releaseAck = resolve })
    })
    vi.spyOn(h.sim, 'orderStatus').mockImplementation(async (_ref, key) => {
      const live = h.sim.orders.find((item) => item.venueOrderId === key.venueOrderId || item.clientOrderId === key.clientOrderId)
      return live ? { found: true, status: live.status, venueOrderId: live.venueOrderId } : { found: false }
    })
    const pending = amend(h, order)
    try {
      await amendStarted
      const cancelled = await h.k.trading.cancel({ accountId: h.paper.accountId, orderId: order.orderId }, h.human())
      expect(cancelled.ok).toBe(true)
      expect(h.sim.cancelCalls[0]?.[0]).toMatchObject({ venueOrderId: OLD_ID, clientOrderId: order.clientOrderId })
      expect(h.k.orders.get(order.orderId)).toMatchObject({ venueOrderId: OLD_ID, status: 'cancelled' })
      const confirmedCancels = h.k.ledger.trace({ orderId: order.orderId }).filter((entry) => entry.type === 'order.cancelled' && (entry.payload as { kind?: string }).kind === 'cancel.confirmed')
      expect(confirmedCancels).toHaveLength(1)
      expect(h.k.docs.get<OrderRecord>('order-record', order.orderId)?.amendPending?.reservation.notional).toBe('316')
      expect(order.leverage ?? 1).toBe(1)
      expect(h.k.docs.get<OrderRecord>('order-record', order.orderId)?.amendPending?.reservation.margin).toBe('316')
      const decide = vi.spyOn(h.k.gate, 'decide')
      await h.k.trading.preview({
        accountId: order.accountId as never, instrumentId: order.instrumentId, side: 'buy', type: 'limit',
        size: asDecimal('0.001'), price: asDecimal('79000'), reason: 'cancel confirmed during amend budget probe',
      }, h.human()).catch(() => undefined)
      expect(decide.mock.calls.at(-1)![0].reserved.account.margin).toBe('316')

      venueOrder.venueOrderId = NEW_ID
      venueOrder.size = '0.004'
      venueOrder.status = 'open'
      releaseAck(ackFor(order, NEW_ID))
      const result = await pending
      expect(result.order).toMatchObject({ venueOrderId: NEW_ID, status: 'open', size: '0.004' })
      expect(h.k.docs.get<OrderRecord>('order-record', order.orderId)?.supersededVenueOrderIds).toEqual([OLD_ID])
      const afterAck = vi.spyOn(h.k.gate, 'decide')
      await h.k.trading.preview({
        accountId: order.accountId as never, instrumentId: order.instrumentId, side: 'buy', type: 'limit',
        size: asDecimal('0.001'), price: asDecimal('79000'), reason: 'replacement order budget probe',
      }, h.human()).catch(() => undefined)
      expect(afterAck.mock.calls.at(-1)![0].reserved.account.margin).toBe('316')
    } finally {
      if (releaseAck) releaseAck(ackFor(order, NEW_ID))
      await pending.catch(() => undefined)
    }
  })

  it('defers an old-ID terminal update while ACK is known but replacement identity lookup is pending', async () => {
    const h = await setup()
    const order = await placeOpenOrder(h)
    let markLookupStarted!: () => void
    let completeLookup!: (result: { found: boolean; status?: string; venueOrderId?: string }) => void
    const lookupStarted = new Promise<void>((resolve) => { markLookupStarted = resolve })
    vi.spyOn(h.sim, 'amend').mockImplementation(async (ctx, req) => {
      h.sim.amendCalls.push({ ctx, req })
      return ackFor(order, OLD_ID)
    })
    vi.spyOn(h.sim, 'orderStatus').mockImplementation(async () => new Promise((resolve) => {
      completeLookup = resolve
      markLookupStarted()
    }))
    const pending = amend(h, order)
    try {
      await lookupStarted
      h.k.trading.onOrderUpdate(order.accountId, { venueOrderId: OLD_ID, clientOrderId: order.clientOrderId, status: 'cancelled' })
      expect(h.k.orders.get(order.orderId)).toMatchObject({ venueOrderId: OLD_ID, status: 'open' })
      expect(h.k.ledger.trace({ orderId: order.orderId }).some((entry) => entry.type === 'order.cancelled')).toBe(false)
      expect(h.k.docs.get<OrderRecord>('order-record', order.orderId)?.amendPending?.reservation.notional).toBe('316')
      expect(order.leverage ?? 1).toBe(1)
      expect(h.k.docs.get<OrderRecord>('order-record', order.orderId)?.amendPending?.reservation.margin).toBe('316')
      const decide = vi.spyOn(h.k.gate, 'decide')
      await h.k.trading.preview({
        accountId: order.accountId as never, instrumentId: order.instrumentId, side: 'buy', type: 'limit',
        size: asDecimal('0.001'), price: asDecimal('79000'), reason: 'identity lookup window budget probe',
      }, h.human()).catch(() => undefined)
      expect(decide.mock.calls.at(-1)![0].reserved.account.margin).toBe('316')

      completeLookup({ found: true, status: 'open', venueOrderId: NEW_ID })
      const result = await pending
      expect(result.order).toMatchObject({ venueOrderId: NEW_ID, status: 'open', size: '0.004' })
      expect(h.k.docs.get<OrderRecord>('order-record', order.orderId)?.supersededVenueOrderIds).toEqual([OLD_ID])
      expect(h.k.ledger.trace({ orderId: order.orderId }).some((entry) => entry.type === 'order.cancelled')).toBe(false)
    } finally {
      if (completeLookup) completeLookup({ found: true, status: 'open', venueOrderId: NEW_ID })
      await pending.catch(() => undefined)
    }
  })

  it('does not adopt an acknowledged historical ID on a later amendment', async () => {
    const h = await setup()
    const order = await placeOpenOrder(h)
    const venueOrder = h.sim.orders.find((item) => item.clientOrderId === order.clientOrderId)!
    let amendmentCount = 0
    vi.spyOn(h.sim, 'amend').mockImplementation(async (ctx, req) => {
      h.sim.amendCalls.push({ ctx, req })
      amendmentCount++
      if (amendmentCount === 1) venueOrder.venueOrderId = NEW_ID
      return ackFor(order, amendmentCount === 1 ? NEW_ID : OLD_ID)
    })
    const status = vi.spyOn(h.sim, 'orderStatus').mockImplementation(async (_ref, key) => ({
      found: true, status: 'open', venueOrderId: key.venueOrderId,
    }))

    await amend(h, order)
    h.clock.advance(6000)
    await expect(h.k.trading.amend(h.human(), { accountId: h.paper.accountId, orderId: order.orderId, size: '0.005' }))
      .rejects.toMatchObject({ problem: { name: 'VENUE_OUTCOME_UNKNOWN' } })

    expect(status).toHaveBeenCalledTimes(1)
    expect(status.mock.calls[0]?.[1]).toMatchObject({ venueOrderId: NEW_ID })
    expect(h.k.orders.get(order.orderId)).toMatchObject({ venueOrderId: NEW_ID, size: '0.004', status: 'open' })
    const record = h.k.docs.get<OrderRecord>('order-record', order.orderId)!
    expect(record.supersededVenueOrderIds).toEqual([OLD_ID])
    expect(record.amendPending?.reservation.notional).toBe('395')
  })

  it('keeps an old-ID fill received while replacement identity lookup is pending', async () => {
    const h = await setup()
    const order = await placeOpenOrder(h)
    let markLookupStarted!: () => void
    let completeLookup!: (result: { found: boolean; status?: string; venueOrderId?: string }) => void
    const lookupStarted = new Promise<void>((resolve) => { markLookupStarted = resolve })
    vi.spyOn(h.sim, 'amend').mockImplementation(async (ctx, req) => {
      h.sim.amendCalls.push({ ctx, req })
      return ackFor(order, OLD_ID)
    })
    vi.spyOn(h.sim, 'orderStatus').mockImplementation(async () => new Promise((resolve) => {
      completeLookup = resolve
      markLookupStarted()
    }))
    const pending = amend(h, order)
    try {
      await lookupStarted
      h.k.trading.onVenueFill(order.accountId, {
        venueOrderId: OLD_ID, clientOrderId: order.clientOrderId, venueFillId: 'fill-during-identity-lookup', instrumentId: order.instrumentId,
        side: 'buy', price: '79000' as never, size: '0.001' as never, fee: '0' as never, feeCcy: 'USDC',
        liquidity: 'taker', realizedPnl: '0' as never, ts: h.clock.now() as never,
      })
      expect(h.k.orders.get(order.orderId)).toMatchObject({ venueOrderId: OLD_ID, status: 'partially_filled', filledSize: '0.001' })
      completeLookup({ found: true, status: 'open', venueOrderId: NEW_ID })
      const result = await pending
      expect(result.order).toMatchObject({ venueOrderId: NEW_ID, status: 'partially_filled', filledSize: '0.001' })
      expect(h.k.orders.fills({ orderId: order.orderId, limit: 10 })).toHaveLength(1)
      expect(h.k.ledger.trace({ orderId: order.orderId }).filter((entry) => entry.type === 'fill')).toHaveLength(1)
    } finally {
      if (completeLookup) completeLookup({ found: true, status: 'open', venueOrderId: NEW_ID })
      await pending.catch(() => undefined)
    }
  })
})
