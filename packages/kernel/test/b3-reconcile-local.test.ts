// SPDX-License-Identifier: CPAL-1.0
import { describe, expect, it } from 'vitest'
import type { Fill, MarginMode, Order } from '../src/proto'
import { asDecimal } from '../src/proto'
import { mkOrigin } from '../src/util/origin'
import { buildReconcileLocal } from '../src/reconcile-local'
import { reconcile } from '../../exec-reconcile/src/reconcile'
import type { VenueView } from '../../exec-reconcile/src/types'

const ACCOUNT = 'acct_local_test' as Order['accountId']
const OTHER_ACCOUNT = 'acct_other_test' as Order['accountId']
const BTC = 'venue:BTC' as Order['instrumentId']
const ETH = 'venue:ETH' as Order['instrumentId']

function order(id: string, over: Partial<Order> = {}): Order {
  return {
    orderId: id as Order['orderId'],
    clientOrderId: `client-${id}` as Order['clientOrderId'],
    venueOrderId: `venue-${id}`,
    accountId: ACCOUNT,
    instrumentId: BTC,
    side: 'buy',
    type: 'limit',
    tif: 'gtc',
    size: asDecimal('1'),
    filledSize: asDecimal('0'),
    price: asDecimal('100'),
    triggerPrice: null,
    avgFillPrice: null,
    reduceOnly: false,
    postOnly: false,
    status: 'filled',
    fee: asDecimal('0'),
    origin: mkOrigin('user:usr_local', 'reconcile-test', 'cli'),
    createdAt: 100,
    updatedAt: 200,
    submittedAt: 110,
    closedAt: 200,
    ...over,
  }
}

function fill(id: string, over: Partial<Fill> = {}): Fill {
  return {
    fillId: `fill-${id}` as Fill['fillId'],
    orderId: `order-${id}` as Fill['orderId'],
    clientOrderId: `client-order-${id}` as Fill['clientOrderId'],
    venueFillId: `venue-fill-${id}`,
    accountId: ACCOUNT,
    instrumentId: BTC,
    side: 'buy',
    price: asDecimal('100'),
    size: asDecimal('1'),
    fee: asDecimal('0'),
    feeCcy: 'USD',
    liquidity: 'maker',
    realizedPnl: asDecimal('0'),
    ts: 100,
    ...over,
  }
}

describe('buildReconcileLocal', () => {
  it('returns an empty account snapshot and preserves asOf', () => {
    expect(buildReconcileLocal(ACCOUNT, [], [], 123)).toEqual({ accountId: ACCOUNT, orders: [], fills: [], positions: [], asOf: 123 })
  })

  it('filters orders and fills by account without changing frozen inputs', () => {
    const selectedOrder = order('selected')
    const unrelatedOrder = order('other', { accountId: OTHER_ACCOUNT })
    const selectedFill = fill('selected')
    const unrelatedFill = fill('other', { accountId: OTHER_ACCOUNT })
    const orders = Object.freeze([Object.freeze(selectedOrder), Object.freeze(unrelatedOrder)])
    const fills = Object.freeze([Object.freeze(selectedFill), Object.freeze(unrelatedFill)])
    const before = JSON.stringify({ orders, fills })

    const local = buildReconcileLocal(ACCOUNT, orders, fills, 500)

    expect(local.orders.map((item) => item.orderId)).toEqual(['selected'])
    expect(local.fills.map((item) => item.venueFillId)).toEqual(['venue-fill-selected'])
    expect(local.asOf).toBe(500)
    expect(JSON.stringify({ orders, fills })).toBe(before)
  })

  it('maps order identities and fields while deriving filledSize from recorded fills', () => {
    const source = order('main', {
      side: 'sell', status: 'partially_filled', size: asDecimal('2.5'), filledSize: asDecimal('2.4'),
      price: asDecimal('123.45'), triggerPrice: asDecimal('120'), reduceOnly: true, updatedAt: 250,
    })
    const actual = fill('first', { orderId: source.orderId, clientOrderId: source.clientOrderId, size: asDecimal('0.2') })
    const extra = fill('second', { orderId: source.orderId, clientOrderId: source.clientOrderId, size: asDecimal('0.3'), ts: 101 })

    const mapped = buildReconcileLocal(ACCOUNT, [source], [actual, extra], 300).orders[0]

    expect(mapped).toBeDefined()
    if (!mapped) throw new Error('expected one mapped order')
    expect(mapped).toMatchObject({
      orderId: 'main', clientOrderId: 'client-main', venueOrderId: 'venue-main', instrumentId: BTC,
      side: 'sell', type: 'limit', size: '2.5', filledSize: '0.5', price: '123.45', triggerPrice: '120',
      status: 'partially_filled', reduceOnly: true, createdAt: 100, updatedAt: 250, closedAt: 200,
    })
    expect(mapped.filledSize).not.toBe(source.filledSize)
  })

  it('keeps account orphan fills, orders them by time stably, and omits an unmapped venue order id', () => {
    const firstAtTie = fill('tie-first', { orderId: 'orphan-a' as Fill['orderId'], ts: 10 })
    const secondAtTie = fill('tie-second', { orderId: 'orphan-b' as Fill['orderId'], ts: 10 })
    const earlier = fill('earlier', { orderId: 'orphan-c' as Fill['orderId'], ts: 5 })

    const local = buildReconcileLocal(ACCOUNT, [], [firstAtTie, secondAtTie, earlier], 20)

    expect(local.fills.map((item) => item.venueFillId)).toEqual(['venue-fill-earlier', 'venue-fill-tie-first', 'venue-fill-tie-second'])
    expect(local.fills.map((item) => item.orderId)).toEqual(['orphan-c', 'orphan-a', 'orphan-b'])
    expect(local.fills.every((item) => item.venueOrderId === undefined)).toBe(true)
  })

  it('uses an order venue id only when exactly one local order matches the fill identity', () => {
    const unique = order('unique')
    const duplicateA = order('duplicate', { venueOrderId: 'venue-a' })
    const duplicateB = order('duplicate', { venueOrderId: 'venue-b' })
    const uniqueFill = fill('unique', { orderId: unique.orderId, clientOrderId: unique.clientOrderId })
    const ambiguousFill = fill('duplicate', { orderId: duplicateA.orderId, clientOrderId: duplicateA.clientOrderId })

    const local = buildReconcileLocal(ACCOUNT, [unique, duplicateA, duplicateB], [uniqueFill, ambiguousFill], 20)

    expect(local.fills.find((item) => item.venueFillId === uniqueFill.venueFillId)?.venueOrderId).toBe('venue-unique')
    expect(local.fills.find((item) => item.venueFillId === ambiguousFill.venueFillId)?.venueOrderId).toBeUndefined()
  })

  it('reconstructs opening, add, and reduction while retaining the weighted entry', () => {
    const local = buildReconcileLocal(ACCOUNT, [], [
      fill('open', { side: 'buy', size: asDecimal('2'), price: asDecimal('100'), ts: 1 }),
      fill('add', { side: 'buy', size: asDecimal('2'), price: asDecimal('120'), ts: 2 }),
      fill('reduce', { side: 'sell', size: asDecimal('1'), price: asDecimal('130'), ts: 3 }),
    ], 10)

    expect(local.positions).toEqual([{ instrumentId: BTC, side: 'long', size: '3', entryPrice: '110', marginMode: 'cross' }])
  })

  it('removes a position at exact flatten without emitting zero-size inventory', () => {
    const local = buildReconcileLocal(ACCOUNT, [], [
      fill('open', { side: 'buy', size: asDecimal('2'), price: asDecimal('100'), ts: 1 }),
      fill('close', { side: 'sell', size: asDecimal('2'), price: asDecimal('120'), ts: 2 }),
    ], 10)

    expect(local.positions).toEqual([])
  })

  it('uses the reversing fill price for the remaining opposite-side position', () => {
    const local = buildReconcileLocal(ACCOUNT, [], [
      fill('open', { side: 'buy', size: asDecimal('2'), price: asDecimal('100'), ts: 1 }),
      fill('reverse', { side: 'sell', size: asDecimal('3'), price: asDecimal('130'), ts: 2 }),
    ], 10)

    expect(local.positions).toEqual([{ instrumentId: BTC, side: 'short', size: '1', entryPrice: '130', marginMode: 'cross' }])
  })

  it('uses exact decimal weighted entry and stable instrument order', () => {
    const local = buildReconcileLocal(ACCOUNT, [], [
      fill('btc-a', { instrumentId: BTC, side: 'buy', size: asDecimal('0.1'), price: asDecimal('0.1'), ts: 1 }),
      fill('btc-b', { instrumentId: BTC, side: 'buy', size: asDecimal('0.2'), price: asDecimal('0.2'), ts: 2 }),
      fill('eth', { instrumentId: ETH, side: 'sell', size: asDecimal('0.25'), price: asDecimal('10'), ts: 3 }),
    ], 10)

    expect(local.positions).toEqual([
      { instrumentId: BTC, side: 'long', size: '0.3', entryPrice: '0.166666666666666666', marginMode: 'cross' },
      { instrumentId: ETH, side: 'short', size: '0.25', entryPrice: '10', marginMode: 'cross' },
    ])
  })

  it('keeps explicit isolated inventory separate from the cross default for the same instrument', () => {
    const crossOrder = order('cross')
    const isolatedOrder = order('isolated', { side: 'sell' })
    const orders = [crossOrder, isolatedOrder]
    const fills = [
      fill('cross', { orderId: crossOrder.orderId, clientOrderId: crossOrder.clientOrderId, size: asDecimal('0.2'), price: asDecimal('100'), ts: 1 }),
      fill('isolated', { orderId: isolatedOrder.orderId, clientOrderId: isolatedOrder.clientOrderId, side: 'sell', size: asDecimal('0.4'), price: asDecimal('120'), ts: 2 }),
    ]
    const modes = new Map<string, MarginMode>([['isolated', 'isolated']])

    const local = buildReconcileLocal(ACCOUNT, orders, fills, 10, modes)

    expect(local.orders.map((item) => item.marginMode)).toEqual(['cross', 'isolated'])
    expect(local.positions).toEqual([
      { instrumentId: BTC, side: 'long', size: '0.2', entryPrice: '100', marginMode: 'cross' },
      { instrumentId: BTC, side: 'short', size: '0.4', entryPrice: '120', marginMode: 'isolated' },
    ])
  })

  it('applies original input order to equal-timestamp position fills', () => {
    const local = buildReconcileLocal(ACCOUNT, [], [
      fill('tie-open', { side: 'buy', size: asDecimal('1'), price: asDecimal('100'), ts: 5 }),
      fill('tie-add', { side: 'buy', size: asDecimal('1'), price: asDecimal('300'), ts: 5 }),
      fill('tie-reduce', { side: 'sell', size: asDecimal('1'), price: asDecimal('200'), ts: 5 }),
    ], 10)

    expect(local.positions).toEqual([{ instrumentId: BTC, side: 'long', size: '1', entryPrice: '200', marginMode: 'cross' }])
  })

  it('feeds the real reconciler a local fill-derived position and exposes a different venue position', () => {
    const local = buildReconcileLocal(ACCOUNT, [order('position')], [
      fill('position', { orderId: 'position' as Fill['orderId'], clientOrderId: 'client-position' as Fill['clientOrderId'], side: 'buy', size: asDecimal('2'), price: asDecimal('100'), ts: 100 }),
    ], 100)
    const venue: VenueView = {
      openOrders: [], historyOrders: [], fills: [],
      positions: [{ instrumentId: BTC, side: 'short', size: '1', entryPrice: '100', marginMode: 'cross' }],
      asOf: 100,
    }

    const report = reconcile({ local, venue }, { now: 100, staleAfterMs: 10_000 })

    expect(report.findings.some((finding) => finding.code === 'position_side_mismatch')).toBe(true)
    expect(report.coverage.localPositions).toBe(1)
    expect(local.positions[0]?.side).toBe('long')
  })
})
