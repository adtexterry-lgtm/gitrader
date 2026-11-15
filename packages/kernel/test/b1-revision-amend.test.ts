// SPDX-License-Identifier: CPAL-1.0
import { afterEach, describe, expect, it, vi } from 'vitest'
import { asDecimal } from '@gitrader/protocol'
import { FakeHl } from '../../connector-hyperliquid/test/helpers/fake-hl'
import { makeTestSigner } from '../../connector-hyperliquid/test/helpers/test-signer'
import { HyperliquidConnector } from '../../connector-hyperliquid/src/connector'
import { makeHarness } from './helpers/harness'
import type { Harness } from './helpers/harness'

let active: { harness: Harness; connector: HyperliquidConnector } | undefined

afterEach(async () => {
  await active?.connector.close().catch(() => undefined)
  await active?.harness.cleanup()
  active = undefined
})

async function setup(response: unknown) {
  const harness = await makeHarness()
  const fakeHl = new FakeHl()
  fakeHl.exchange = () => response
  const signer = makeTestSigner()
  const connector = new HyperliquidConnector({
    environment: 'testnet',
    useWs: false,
    discoveryIntervalMs: 0,
    clock: () => harness.clock.now(),
    fetchImpl: fakeHl.fetch,
  })
  await connector.market.refreshInstruments()
  const signerContext = {
    account: { accountId: 'acct_01TEST', address: signer.address, accountModel: 'standard' },
    signer,
    onSigned: () => {},
  }
  let delegatedAmends = 0
  harness.sim.amend = async (_ctx, request) => {
    delegatedAmends++
    return connector.amend(signerContext as never, request as never)
  }
  active = { harness, connector }
  return { harness, fakeHl, delegatedAmends: () => delegatedAmends }
}

async function placeOpenOrder(harness: Harness) {
  const placed = await harness.k.trading.place({ intent: {
    accountId: harness.paper.accountId as never,
    instrumentId: 'hyperliquid:BTC' as never,
    side: 'buy', type: 'limit', size: asDecimal('0.003'), price: asDecimal('79000'), reason: 'revision amend fixture',
  } }, harness.human())
  expect(placed.order).toMatchObject({ status: 'open', size: '0.003', price: '79000' })
  const fakeVenueOrder = harness.sim.orders.find((item) => item.clientOrderId === placed.order!.clientOrderId)!
  fakeVenueOrder.venueOrderId = '321'
  harness.k.trading.onOrderUpdate(harness.paper.accountId, { venueOrderId: '321', clientOrderId: placed.order!.clientOrderId, status: 'open' })
  harness.clock.advance(6000)
  return harness.k.orders.get(placed.order!.orderId)!
}

const amendment = (harness: Harness, orderId: string) => harness.k.trading.amend(harness.human(), {
  accountId: harness.paper.accountId, orderId, size: '0.004',
})

describe('public amend recovery after a real HL SDK default response', () => {
  it.each([
    ['not-found lookup', async (harness: Harness) => vi.spyOn(harness.sim, 'orderStatus').mockResolvedValue({ found: false })],
    ['lookup throws', async (harness: Harness) => vi.spyOn(harness.sim, 'orderStatus').mockRejectedValue(new Error('fixture lookup failure'))],
    ['lookup finds the old open order', async (harness: Harness, order: Awaited<ReturnType<typeof placeOpenOrder>>) => vi.spyOn(harness.sim, 'orderStatus').mockResolvedValue({ found: true, status: 'open', venueOrderId: order.venueOrderId! })],
  ])('%s leaves the public amendment pending and never resends it', async (_name, installLookup) => {
    const { harness, fakeHl } = await setup({ status: 'ok', response: { type: 'default' } })
    const order = await placeOpenOrder(harness)
    const orderStatus = await installLookup(harness, order)

    await expect(amendment(harness, order.orderId)).rejects.toMatchObject({ problem: { code: 3006, name: 'VENUE_OUTCOME_UNKNOWN', retryable: false } })

    expect(orderStatus).toHaveBeenCalledTimes(1)
    expect(orderStatus.mock.calls[0]?.[1]).toMatchObject({ clientOrderId: order.clientOrderId, venueOrderId: order.venueOrderId, instrumentId: order.instrumentId })
    expect(fakeHl.exchangeCalls()).toHaveLength(1)
    expect(fakeHl.exchangeCalls()[0]?.body.action).toMatchObject({ type: 'modify', oid: Number(order.venueOrderId) })
    expect(harness.sim.submitted).toHaveLength(1)
    expect(harness.sim.cancelCalls).toHaveLength(0)
    expect(harness.sim.amendCalls).toHaveLength(0)

    const current = harness.k.orders.get(order.orderId)!
    expect(current).toMatchObject({ status: 'open', size: '0.003', price: '79000' })
    const record = harness.k.docs.get<{ reservation?: { notional: string }; amendPending?: { reservation: { notional: string } } }>('order-record', order.orderId)!
    expect(record.reservation?.notional).toBe('237')
    expect(record.amendPending?.reservation.notional).toBe('316')
    const trace = harness.k.ledger.trace({ orderId: order.orderId })
    expect(trace).toContainEqual(expect.objectContaining({ type: 'annotation', payload: expect.objectContaining({ kind: 'amend.unknown', reservation: expect.objectContaining({ notional: '316' }) }) }))
    expect(trace.some((entry) => entry.type === 'order.rejected' && (entry.payload as { kind?: string }).kind === 'amend')).toBe(false)

    await expect(amendment(harness, order.orderId)).rejects.toMatchObject({ problem: { name: 'INVALID_PARAMS' } })
    expect(fakeHl.exchangeCalls()).toHaveLength(1)
    expect(orderStatus).toHaveBeenCalledTimes(1)
  })

  it('keeps an explicit HL status error as a definite rejection without an unknown lookup', async () => {
    const { harness, fakeHl } = await setup({ status: 'ok', response: { type: 'modify', data: { statuses: [{ error: 'insufficient margin' }] } } })
    const order = await placeOpenOrder(harness)
    const orderStatus = vi.spyOn(harness.sim, 'orderStatus')

    await expect(amendment(harness, order.orderId)).rejects.toMatchObject({ problem: { code: 3004, name: 'VENUE_INSUFFICIENT_MARGIN' } })

    expect(fakeHl.exchangeCalls()).toHaveLength(1)
    expect(orderStatus).not.toHaveBeenCalled()
    expect(harness.sim.submitted).toHaveLength(1)
    expect(harness.sim.cancelCalls).toHaveLength(0)
    expect(harness.k.orders.get(order.orderId)).toMatchObject({ status: 'open', size: '0.003', price: '79000' })
    const record = harness.k.docs.get<{ reservation?: { notional: string }; amendPending?: unknown }>('order-record', order.orderId)!
    expect(record.amendPending).toBeUndefined()
    expect(record.reservation?.notional).toBe('237')
    expect(harness.k.ledger.trace({ orderId: order.orderId })).toContainEqual(expect.objectContaining({ type: 'order.rejected', payload: expect.objectContaining({ kind: 'amend' }) }))
  })
})
