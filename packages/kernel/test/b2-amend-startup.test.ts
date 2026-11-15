// SPDX-License-Identifier: CPAL-1.0
import { afterEach, describe, expect, it, vi } from 'vitest'
import { asDecimal } from '@gitrader/protocol'
import type { SubmitResult, VenueFill } from '@gitrader/protocol/connector'
import { Kernel } from '../src/kernel'
import { fileProvider } from '../src/device-key'
import { mkOrigin } from '../src/util/origin'
import type { Order } from '../src/proto'
import { FAST_SCRYPT, enableLive, makeHarness } from './helpers/harness'
import type { Harness } from './helpers/harness'
import { FakeConnector } from './helpers/fake-connector'

const OLD_ID = 'venue-startup-old-321'
const NEW_ID = 'venue-startup-new-654'
type OrderRecord = { amendPending?: { reservation: { size: string; notional: string } }; replacementVenueOrderId?: string }

let h: Harness | undefined
let restartedKernel: Kernel | undefined

afterEach(async () => {
  await restartedKernel?.stop().catch(() => undefined)
  restartedKernel = undefined
  await h?.cleanup()
  h = undefined
})

function ackFor(order: Order): SubmitResult {
  return {
    acks: [{ intentIndex: 0, clientOrderId: order.clientOrderId, venueOrderId: NEW_ID, status: 'open', filledSize: '0' as never, avgFillPrice: null, builder: { attached: false } }],
    receiptHash: 'cd'.repeat(32) as never, requestWeight: 1,
  }
}

async function createRestartedPendingAmend(pollOrders: boolean, replacement = true): Promise<{ order: Order; connector: FakeConnector }> {
  h = await makeHarness({ registerLive: false })
  await enableLive(h)
  h.k.registerConnector(h.live, pollOrders ? { pollOrders: true } : {})
  const proof = await h.pinProof()
  const placed = await h.k.trading.place({ intent: {
    accountId: h.liveAcct.accountId as never, instrumentId: 'hyperliquid:BTC' as never, side: 'buy', type: 'limit',
    size: asDecimal('0.003'), price: asDecimal('79000'), tif: 'gtc',
  } }, { ...h.human(), proof })
  expect(placed.order?.status).toBe('open')
  const order = placed.order!
  const venueOrder = h.live.orders.find((item) => item.clientOrderId === order.clientOrderId)!
  venueOrder.venueOrderId = OLD_ID
  h.k.trading.onOrderUpdate(order.accountId, { venueOrderId: OLD_ID, clientOrderId: order.clientOrderId, status: 'open' })
  h.clock.advance(6000)

  let releaseAck!: (result: SubmitResult) => void
  let rejectAmend!: (error: Error) => void
  let markAmendStarted!: () => void
  const amendStarted = new Promise<void>((resolve) => { markAmendStarted = resolve })
  vi.spyOn(h!.live, 'amend').mockImplementation(async (ctx, req) => {
    h!.live.amendCalls.push({ ctx, req })
    return new Promise<SubmitResult>((resolve, reject) => { releaseAck = resolve; rejectAmend = reject; markAmendStarted() })
  })
  vi.spyOn(h.live, 'orderStatus').mockResolvedValue(replacement
    ? { found: true, status: 'cancelled', venueOrderId: OLD_ID }
    : { found: false })
  const pending = h.k.trading.amend(h.human(), { accountId: order.accountId, orderId: order.orderId, size: '0.004' })
  await amendStarted
  venueOrder.status = 'filled'
  h.k.trading.onVenueFill(order.accountId, {
    venueOrderId: OLD_ID, clientOrderId: order.clientOrderId, venueFillId: 'fill-before-startup', instrumentId: order.instrumentId,
    side: 'buy', price: '79000' as never, size: '0.003' as never, fee: '0' as never, feeCcy: 'USDC',
    liquidity: 'taker', realizedPnl: '0' as never, ts: h.clock.now() as never,
  } satisfies VenueFill)
  if (replacement) {
    venueOrder.venueOrderId = NEW_ID
    releaseAck(ackFor(order))
  } else rejectAmend(new Error('outcome unavailable'))
  await expect(pending).rejects.toMatchObject({ problem: { name: 'VENUE_OUTCOME_UNKNOWN' } })
  expect(h.k.docs.get<OrderRecord>('order-record', order.orderId)?.amendPending?.reservation.notional).toBe('316')
  expect(h.k.docs.get<OrderRecord>('order-record', order.orderId)?.replacementVenueOrderId).toBe(replacement ? NEW_ID : undefined)

  await h.k.stop()
  restartedKernel = await Kernel.create({ home: h.home, clock: h.clock, scrypt: FAST_SCRYPT, deviceKeyProvider: fileProvider, timers: false, sleep: async () => undefined })
  const connector = new FakeConnector({ id: 'hyperliquid', clock: h.clock })
  restartedKernel.registerConnector(connector, pollOrders ? { pollOrders: true } : {})
  return { order, connector }
}

describe('B2 startup recovery for terminal pending amendments', () => {
  it.each([true, false])('queries the acknowledged replacement ID and records its confirmed cancellation during startup (pollOrders=%s)', async (pollOrders) => {
    const { order, connector } = await createRestartedPendingAmend(pollOrders)
    const status = vi.spyOn(connector, 'orderStatus').mockResolvedValue({ found: true, status: 'cancelled', venueOrderId: NEW_ID })
    const result = await restartedKernel!.startupReconcile(1_000, 'hyperliquid')
    expect(status).toHaveBeenCalledTimes(1)
    expect(status.mock.calls[0]?.[1]).toMatchObject({ clientOrderId: order.clientOrderId, instrumentId: order.instrumentId, venueOrderId: NEW_ID })
    expect(result).toEqual([{ account: order.accountId, ok: true }])
    expect(restartedKernel!.orders.get(order.orderId)).toMatchObject({ venueOrderId: NEW_ID, status: 'cancelled', filledSize: '0.003' })
    expect(restartedKernel!.ledger.trace({ orderId: order.orderId }).filter((entry) => entry.type === 'order.cancelled')).toHaveLength(1)
    expect(restartedKernel!.docs.get<OrderRecord>('order-record', order.orderId)?.amendPending).toBeUndefined()

    const token = restartedKernel!.auth.exchangeBoot(restartedKernel!.auth.mintBootToken())
    const principal = restartedKernel!.auth.authenticateToken(token.sessionToken)!
    const decide = vi.spyOn(restartedKernel!.gate, 'decide')
    await restartedKernel!.trading.preview({
      accountId: order.accountId as never, instrumentId: order.instrumentId, side: 'buy', type: 'limit',
      size: asDecimal('0.001'), price: asDecimal('79000'), reason: 'startup recovery risk probe',
    }, { principal, origin: mkOrigin('user:usr_startup', 'order.preview', 'ui') }).catch(() => undefined)
    expect(decide.mock.calls.at(-1)![0].reserved.account.margin).toBe('0')
  })

  it.each([
    { label: 'no replacement ID', replacement: false, response: { found: true, status: 'cancelled', venueOrderId: OLD_ID } },
    { label: 'unknown result', replacement: true, response: { found: false } },
    { label: 'contradictory ID', replacement: true, response: { found: true, status: 'cancelled', venueOrderId: OLD_ID } },
    { label: 'replacement still open', replacement: true, response: { found: true, status: 'open', venueOrderId: NEW_ID } },
    { label: 'replacement filled below reserved size', replacement: true, response: { found: true, status: 'filled', venueOrderId: NEW_ID, filledSize: '0.003' } },
  ])('keeps unresolved terminal amendments halted for $label in both startup branches', async ({ replacement, response }) => {
    for (const pollOrders of [true, false]) {
      const { order, connector } = await createRestartedPendingAmend(pollOrders, replacement)
      const status = vi.spyOn(connector, 'orderStatus').mockResolvedValue(response as never)
      const result = await restartedKernel!.startupReconcile(1_000, 'hyperliquid')
      expect(status).toHaveBeenCalledTimes(1)
      expect(status.mock.calls[0]?.[1]).toMatchObject({
        clientOrderId: order.clientOrderId, instrumentId: order.instrumentId,
        venueOrderId: replacement ? NEW_ID : OLD_ID,
      })
      expect(result).toHaveLength(1)
      expect(result[0]?.ok).toBe(false)
      expect(restartedKernel!.orders.get(order.orderId)).toMatchObject({ status: 'filled', filledSize: '0.003' })
      expect(restartedKernel!.docs.get<OrderRecord>('order-record', order.orderId)?.amendPending?.reservation.notional).toBe('316')
      expect(restartedKernel!.ledger.trace({ orderId: order.orderId }).filter((entry) => entry.type === 'order.cancelled')).toHaveLength(0)
      expect(connector.amendCalls).toHaveLength(0)
      expect(restartedKernel!.tstate.get({ type: 'account', id: order.accountId })).toBe('HALTED')
      const token = restartedKernel!.auth.exchangeBoot(restartedKernel!.auth.mintBootToken())
      const principal = restartedKernel!.auth.authenticateToken(token.sessionToken)!
      const decide = vi.spyOn(restartedKernel!.gate, 'decide')
      await restartedKernel!.trading.preview({
        accountId: order.accountId as never, instrumentId: order.instrumentId, side: 'buy', type: 'limit',
        size: asDecimal('0.001'), price: asDecimal('79000'), reason: 'unresolved startup risk probe',
      }, { principal, origin: mkOrigin('user:usr_startup', 'order.preview', 'ui') }).catch(() => undefined)
      expect(decide.mock.calls.at(-1)![0].reserved.account.margin).toBe('79')
      await restartedKernel!.stop()
      restartedKernel = undefined
      await h!.cleanup()
      h = undefined
    }
  })
})
