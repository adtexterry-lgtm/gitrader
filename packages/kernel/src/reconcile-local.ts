// SPDX-License-Identifier: CPAL-1.0
import type { Fill, MarginMode, Order } from './proto'
import type { LocalView } from '../../exec-reconcile/src/types'
import * as d from './util/dec'

const CROSS: MarginMode = 'cross'

function modeFor(orderId: string, modes?: ReadonlyMap<string, MarginMode>): MarginMode {
  return modes?.get(orderId) ?? CROSS
}

export function buildReconcileLocal(
  accountId: Order['accountId'],
  orders: readonly Order[],
  fills: readonly Fill[],
  asOf: number,
  orderMarginModes?: ReadonlyMap<string, MarginMode>,
): LocalView {
  const localOrders = orders.filter((order) => order.accountId === accountId)
  const localFills = fills
    .map((fill, index) => ({ fill, index }))
    .filter(({ fill }) => fill.accountId === accountId)
    .sort((a, b) => a.fill.ts - b.fill.ts || a.index - b.index)
    .map(({ fill }) => fill)

  const fillsByOrder = new Map<string, d.Dec>()
  for (const fill of localFills) {
    fillsByOrder.set(fill.orderId, d.add(fillsByOrder.get(fill.orderId) ?? d.ZERO, d.D(fill.size)))
  }

  const localOrdersById = new Map<string, Order[]>()
  for (const order of localOrders) {
    const matches = localOrdersById.get(order.orderId) ?? []
    matches.push(order)
    localOrdersById.set(order.orderId, matches)
  }

  const mappedOrders = localOrders.map((order) => ({
    orderId: order.orderId,
    clientOrderId: order.clientOrderId,
    ...(order.venueOrderId !== undefined ? { venueOrderId: order.venueOrderId } : {}),
    instrumentId: order.instrumentId,
    side: order.side,
    type: order.type,
    size: order.size,
    filledSize: d.str(fillsByOrder.get(order.orderId) ?? d.ZERO),
    ...(order.price !== undefined ? { price: order.price } : {}),
    ...(order.triggerPrice !== undefined ? { triggerPrice: order.triggerPrice } : {}),
    status: order.status,
    ...(order.reduceOnly !== undefined ? { reduceOnly: order.reduceOnly } : {}),
    marginMode: modeFor(order.orderId, orderMarginModes),
    createdAt: order.createdAt,
    ...(order.updatedAt !== undefined ? { updatedAt: order.updatedAt } : {}),
    ...(order.closedAt !== undefined ? { closedAt: order.closedAt } : {}),
  }))

  const mappedFills = localFills.map((fill) => {
    const matches = localOrdersById.get(fill.orderId) ?? []
    const venueOrderId = matches.length === 1 ? matches[0]?.venueOrderId : undefined
    return {
      venueFillId: fill.venueFillId,
      orderId: fill.orderId,
      clientOrderId: fill.clientOrderId,
      ...(venueOrderId !== undefined ? { venueOrderId } : {}),
      instrumentId: fill.instrumentId,
      side: fill.side,
      price: fill.price,
      size: fill.size,
      fee: fill.fee,
      liquidity: fill.liquidity,
      ts: fill.ts,
    }
  })

  const positions = new Map<string, { instrumentId: string; marginMode: MarginMode; net: d.Dec; entryPrice: d.Dec }>()
  for (const fill of localFills) {
    const marginMode = modeFor(fill.orderId, orderMarginModes)
    const key = `${fill.instrumentId}\u0000${marginMode}`
    const current = positions.get(key) ?? { instrumentId: fill.instrumentId, marginMode, net: d.ZERO, entryPrice: d.ZERO }
    const quantity = d.D(fill.size)
    const signed = fill.side === 'buy' ? quantity : d.neg(quantity)
    const next = d.add(current.net, signed)

    if (d.isZero(next)) {
      positions.delete(key)
      continue
    }

    if (d.isZero(current.net)) {
      current.entryPrice = d.D(fill.price)
    } else if (d.isNeg(current.net) === d.isNeg(signed)) {
      const weightedCost = d.add(d.mul(d.abs(current.net), current.entryPrice), d.mul(quantity, d.D(fill.price)))
      current.entryPrice = d.div(weightedCost, d.abs(next))
    } else if (d.isNeg(current.net) !== d.isNeg(next)) {
      current.entryPrice = d.D(fill.price)
    }

    current.net = next
    positions.set(key, current)
  }

  const mappedPositions = [...positions.values()]
    .sort((a, b) => {
      const byInstrument = a.instrumentId < b.instrumentId ? -1 : a.instrumentId > b.instrumentId ? 1 : 0
      return byInstrument || (a.marginMode < b.marginMode ? -1 : a.marginMode > b.marginMode ? 1 : 0)
    })
    .map((position) => ({
      instrumentId: position.instrumentId,
      side: d.isNeg(position.net) ? 'short' as const : 'long' as const,
      size: d.str(d.abs(position.net)),
      entryPrice: d.str(position.entryPrice),
      marginMode: position.marginMode,
    }))

  return { accountId, orders: mappedOrders, fills: mappedFills, positions: mappedPositions, asOf }
}
