// SPDX-License-Identifier: CPAL-1.0
import { mkdirSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import type { Position, ReconcileConfirmInput } from '../src/proto'
import { asDecimal } from '../src/proto'
import type { StartupSnapshot, VenueOpenOrder, VenueOrderStatus } from '@gitrader/protocol/connector'
import { startHttp } from '../src/http/server'
import { makeAgent, makeHarness, TEST_PIN } from './helpers/harness'
import type { Harness } from './helpers/harness'
import { newClientOrderId } from '../src/util/ids'

async function startHumanHttp(h: Harness): Promise<{ close: () => Promise<void>; endpoint: (path: string) => string; auth: Record<string, string> }> {
  const server = await startHttp(h.k, { port: 0 })
  const address = server.server.address() as AddressInfo
  const host = address.family === 'IPv6' ? `[${address.address}]` : address.address
  const endpoint = (path: string): string => `http://${host}:${address.port}${path}`
  const bootstrap = h.k.auth.mintBootToken()
  const sessionResponse = await fetch(endpoint('/api/session'), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ bootstrap }),
  })
  const session = await sessionResponse.json() as { sessionToken?: string }
  expect(sessionResponse.status).toBe(200)
  expect(typeof session.sessionToken).toBe('string')
  const auth = { authorization: `Bearer ${session.sessionToken}`, 'content-type': 'application/json' }
  const pinSetup = await fetch(endpoint('/api/op/pin.set'), { method: 'POST', headers: auth, body: JSON.stringify({ params: { pin: TEST_PIN } }) })
  expect(pinSetup.status).toBe(200)
  return { close: () => server.close(), endpoint, auth }
}

const confirmFields = (input: ReconcileConfirmInput) => ({
  accountId: input.accountId, offerId: input.offerId, reportId: input.reportId, suggestionId: input.suggestionId,
  fee: input.fee, feeCcy: input.feeCcy, liquidity: input.liquidity, realizedPnl: input.realizedPnl,
})

type PlacedOrder = { orderId: string; clientOrderId: string; venueOrderId: string; accountId: string; instrumentId: string }
let placementCallOrdinal = 0

function writeResult(h: Harness, envName: string, label: string, value: unknown): void {
  writeFileSync(uniqueResultPath(h, envName, label), JSON.stringify(value), { flag: 'wx' })
}

function uniqueResultPath(h: Harness, _envName: string, label: string): string {
  const directory = join(h.home, 'b3-evidence')
  mkdirSync(directory, { recursive: true })
  return join(directory, `${label}-${randomUUID()}.json`)
}

async function placePartialOrder(h: Harness, http: Awaited<ReturnType<typeof startHumanHttp>>, side: 'buy' | 'sell' = 'buy', orderSize = '0.012'): Promise<PlacedOrder> {
  const placedResponse = await fetch(http.endpoint('/api/op/order.place'), {
    method: 'POST', headers: http.auth,
    body: JSON.stringify({ params: { intent: {
      accountId: h.paper.accountId, instrumentId: 'hyperliquid:BTC', side, type: 'limit',
      size: orderSize, price: '80000', tif: 'gtc', clientOrderId: newClientOrderId(),
    } } }),
  })
  const placed = await placedResponse.json() as { result?: { order?: PlacedOrder }; error?: { name?: string; message?: string } }
  placementCallOrdinal++
  const diagnosticBase = join(h.home, 'b3-evidence', 'placement')
  mkdirSync(join(h.home, 'b3-evidence'), { recursive: true })
  writeFileSync(`${diagnosticBase}-${placementCallOrdinal}.json`, JSON.stringify({ status: placedResponse.status, body: placed }), { flag: 'wx' })
  expect(placedResponse.status).toBe(200)
  const order = placed.result?.order
  if (!order?.venueOrderId) {
    writeResult(h, 'B3_08C2_PLACEMENT_FAILURE_RESULT', 'placement-failure', { status: placedResponse.status, error: placed.error })
    throw new Error(`real order placement lacked venue identity (${placed.error?.name ?? 'unknown'}: ${placed.error?.message ?? 'no detail'})`)
  }
  h.k.trading.onVenueFill(h.paper.accountId, {
    venueOrderId: order.venueOrderId, clientOrderId: order.clientOrderId, venueFillId: `confirm-existing-${order.orderId}`,
    instrumentId: order.instrumentId as never, side, price: asDecimal('80000'), size: asDecimal('0.001'),
    fee: asDecimal('0.0001'), feeCcy: 'USDC', liquidity: 'maker', realizedPnl: asDecimal('0'), ts: h.clock.now(),
  })
  return order
}

function remoteOpen(order: PlacedOrder, originalSize = '0.012', remainingSize = '0.01'): VenueOpenOrder {
  return {
    instrumentId: order.instrumentId as VenueOpenOrder['instrumentId'], venueOrderId: order.venueOrderId,
    clientOrderId: order.clientOrderId as VenueOpenOrder['clientOrderId'], side: 'buy', type: 'limit',
    price: asDecimal('80000'), triggerPrice: null, size: asDecimal(remainingSize), origSize: asDecimal(originalSize),
    reduceOnly: false, isTrigger: false, createdAt: 0,
  }
}

function remotePosition(h: Harness, side: Position['side'], size: string): Position {
  return {
    accountId: h.paper.accountId, instrumentId: 'hyperliquid:BTC' as Position['instrumentId'], side,
    size: asDecimal(size), entryPrice: asDecimal('80000'), markPrice: asDecimal('80000'), notional: asDecimal(String(Number(size) * 80_000)),
    unrealizedPnl: asDecimal('0'), realizedPnl: asDecimal('0'), leverage: 2, marginMode: 'cross', liquidationPrice: null,
    fundingSinceOpen: asDecimal('0'), openedAt: h.clock.now(), updatedAt: h.clock.now(),
  }
}

type ObservedOffer = { order: PlacedOrder; input: ReconcileConfirmInput; result: { findings?: Array<{ code: string; severity: string }>; suggestions?: Array<{ id: string; price?: string; priceSource?: string }>; offerId?: string; reportId?: string }; previewPrice?: string; previewPriceSource?: string; historyAvgFillPrice?: string }

async function observeOneGap(h: Harness, http: Awaited<ReturnType<typeof startHumanHttp>>, venueSide: Position['side'] = 'long', venueSize = '0.002'): Promise<ObservedOffer> {
  const order = await placePartialOrder(h, http)
  h.sim.openOrdersOverride = [remoteOpen(order)]
  h.sim.positions.set(h.paper.accountId, [remotePosition(h, venueSide, venueSize)])
  const response = await fetch(http.endpoint('/api/op/reconcile.refresh'), {
    method: 'POST', headers: http.auth, body: JSON.stringify({ params: { accountId: h.paper.accountId } }),
  })
  const body = await response.json() as { result?: ObservedOffer['result'] }
  expect(response.status).toBe(200)
  const result = body.result
  const suggestion = result?.suggestions?.find((candidate) => candidate.id)
  if (!result?.offerId || !result.reportId || !suggestion?.id) throw new Error('fresh reconciliation did not offer an observed gap')
  return {
    order, result,
    input: { accountId: h.paper.accountId, offerId: result.offerId, reportId: result.reportId,
      suggestionId: suggestion.id, fee: asDecimal('0'), feeCcy: 'USDC', liquidity: 'maker', realizedPnl: asDecimal('0') },
  }
}

async function sendConfirmation(http: Awaited<ReturnType<typeof startHumanHttp>>, input: ReconcileConfirmInput): Promise<Response> {
  return fetch(http.endpoint('/api/op/reconcile.confirm'), {
    method: 'POST', headers: { ...http.auth, 'x-gitrader-pin': TEST_PIN }, body: JSON.stringify({ params: confirmFields(input) }),
  })
}

describe('B3-08C2 public confirmation HTTP entry', () => {
  let h: Harness | undefined

  afterEach(async () => {
    await h?.cleanup()
    h = undefined
  })

  it('routes a session and PIN authenticated confirmation request to a public operation', async () => {
    h = await makeHarness()
    const http = await startHumanHttp(h)
    try {
      const response = await fetch(http.endpoint('/api/op/reconcile.confirm'), {
        method: 'POST',
        headers: { ...http.auth, 'x-gitrader-pin': TEST_PIN },
        body: JSON.stringify({ params: {
          accountId: h.paper.accountId,
          offerId: 'offer-red-probe',
          reportId: 'report-red-probe',
          suggestionId: 'suggestion-red-probe',
          fee: '0',
          feeCcy: 'USD',
          liquidity: 'taker',
          realizedPnl: '0',
        } }),
      })
      const result = { status: response.status, body: await response.json() as unknown }
      const resultPath = uniqueResultPath(h, 'B3_08C2_HTTP_RED_RESULT', 'B3_08C2_HTTP_RED_RESULT')
      writeFileSync(resultPath, JSON.stringify(result), { flag: 'wx' })
      expect(result).not.toMatchObject({ status: 404, body: { error: { name: 'METHOD_NOT_FOUND' } } })
    } finally {
      await http.close()
    }
  })

  it('keeps transport PIN separate and rejects malformed, noncanonical, or extra request fields', async () => {
    h = await makeHarness()
    const http = await startHumanHttp(h)
    try {
      const base = {
        accountId: h.paper.accountId, offerId: 'offer-validation', reportId: 'report-validation', suggestionId: 'suggestion-validation',
        fee: '0', feeCcy: 'USDC', liquidity: 'maker', realizedPnl: '0',
      }
      const cases: Array<{ params: Record<string, unknown>; expected: string }> = [
        { params: { ...base, pin: TEST_PIN }, expected: 'SECRET_FIELD_REJECTED' },
        { params: { ...base, fee: 1 }, expected: 'INVALID_PARAMS' },
        { params: { ...base, fee: '1e3' }, expected: 'INVALID_PARAMS' },
        { params: { ...base, actor: 'user:usr_local' }, expected: 'INVALID_PARAMS' },
        { params: { ...base, realizedPnl: undefined }, expected: 'INVALID_PARAMS' },
      ]
      const results: Array<{ status: number; error?: { name?: string } }> = []
      for (const item of cases) {
        const response = await fetch(http.endpoint('/api/op/reconcile.confirm'), {
          method: 'POST', headers: { ...http.auth, 'x-gitrader-pin': TEST_PIN }, body: JSON.stringify({ params: item.params }),
        })
        const body = await response.json() as { error?: { name?: string } }
        results.push({ status: response.status, error: body.error })
      }
      const resultPath = uniqueResultPath(h, 'B3_08C2_HTTP_VALIDATION_RESULT', 'B3_08C2_HTTP_VALIDATION_RESULT')
      writeFileSync(resultPath, JSON.stringify(results), { flag: 'wx' })
      expect(results.map((result) => result.error?.name)).toEqual(cases.map((item) => item.expected))
      expect(results.every((result) => result.status === 400)).toBe(true)
    } finally {
      await http.close()
    }
  })

  it('requires a correct transport PIN and preserves the candidate after the rejected attempt', async () => {
    h = await makeHarness()
    const http = await startHumanHttp(h)
    try {
      const observed = await observeOneGap(h, http)
      const response = await fetch(http.endpoint('/api/op/reconcile.confirm'), {
        method: 'POST', headers: { ...http.auth, 'x-gitrader-pin': '000000' }, body: JSON.stringify({ params: confirmFields(observed.input) }),
      })
      const body = await response.json() as { error?: { name?: string } }
      const resultPath = uniqueResultPath(h, 'B3_08C2_WRONG_PIN_RESULT', 'B3_08C2_WRONG_PIN_RESULT')
      writeFileSync(resultPath, JSON.stringify({ status: response.status, error: body.error,
        localFills: h.k.orders.fillsForOrder(h.paper.accountId, observed.order.orderId).length,
        visibleOfferId: h.k.reconcileService.get(h.paper.accountId)[0]?.offerId }), { flag: 'wx' })
      expect(response.status).toBe(401)
      expect(body.error?.name).toBe('AUTH_FAILED')
      expect(h.k.orders.fillsForOrder(h.paper.accountId, observed.order.orderId)).toHaveLength(1)
      expect(h.k.reconcileService.get(h.paper.accountId)[0]?.offerId).toBe(observed.input.offerId)
    } finally {
      await http.close()
    }
  })

  it('rejects agent confirmation at both the public route and the service boundary', async () => {
    h = await makeHarness()
    const http = await startHumanHttp(h)
    try {
      const observed = await observeOneGap(h, http)
      const agent = await makeAgent(h, 'paper')
      const response = await fetch(http.endpoint('/api/op/reconcile.confirm'), {
        method: 'POST', headers: { authorization: `Bearer ${agent.token}`, 'content-type': 'application/json', 'x-gitrader-pin': TEST_PIN },
        body: JSON.stringify({ params: confirmFields(observed.input) }),
      })
      const body = await response.json() as { error?: { name?: string } }
      let serviceError: string | undefined
      try { await h.k.reconcileService.confirm(observed.input, agent.ctx()) }
      catch (error) { serviceError = error instanceof Error && 'problem' in error ? String((error as { problem: { name: string } }).problem.name) : 'unexpected' }
      const resultPath = uniqueResultPath(h, 'B3_08C2_AGENT_RESULT', 'B3_08C2_AGENT_RESULT')
      writeFileSync(resultPath, JSON.stringify({ status: response.status, error: body.error, serviceError,
        localFills: h.k.orders.fillsForOrder(h.paper.accountId, observed.order.orderId).length }), { flag: 'wx' })
      expect(response.status).toBeGreaterThanOrEqual(400)
      expect(body.error?.name).toBe('AUTH_FAILED')
      expect(serviceError).toBe('AUTH_FAILED')
      expect(h.k.orders.fillsForOrder(h.paper.accountId, observed.order.orderId)).toHaveLength(1)
    } finally {
      await http.close()
    }
  })

  it('enforces the ten-second per-account interval and then accepts the same still-live offer', async () => {
    h = await makeHarness()
    const http = await startHumanHttp(h)
    try {
      const observed = await observeOneGap(h, http)
      const immediate = await sendConfirmation(http, observed.input)
      const immediateBody = await immediate.json() as { error?: { name?: string; message?: string } }
      const resultPath = uniqueResultPath(h, 'B3_08C2_INTERVAL_RESULT', 'B3_08C2_INTERVAL_RESULT')
      writeFileSync(resultPath, JSON.stringify({ immediateStatus: immediate.status, immediateError: immediateBody.error }), { flag: 'wx' })
      expect(immediate.status).toBeGreaterThanOrEqual(400)
      expect(immediateBody.error).toMatchObject({ name: 'BUSY', message: 'reconciliation refresh is available after the per-account interval' })
      expect(h.k.orders.fillsForOrder(h.paper.accountId, observed.order.orderId)).toHaveLength(1)
      h.clock.advance(10_000)
      const accepted = await sendConfirmation(http, observed.input)
      const acceptedBody = await accepted.json() as { result?: { fillId?: string }; error?: { name?: string } }
      expect(accepted.status).toBe(200)
      expect(acceptedBody.result?.fillId).toBeTruthy()
      expect(h.k.orders.fillsForOrder(h.paper.accountId, observed.order.orderId)).toHaveLength(2)
    } finally {
      await http.close()
    }
  })

  it('returns BUSY during a genuine in-flight capture, then records and replays the same committed receipt', async () => {
    h = await makeHarness()
    const http = await startHumanHttp(h)
      let releaseCapture: () => void = () => { throw new Error('capture release was not initialized') }
    try {
      const observed = await observeOneGap(h, http)
      let enterCapture: (() => void) | undefined
      const entered = new Promise<void>((resolve) => { enterCapture = resolve })
      const hold = new Promise<void>((resolve) => { releaseCapture = resolve })
      const originalSnapshot = h.sim.startupSnapshot.bind(h.sim)
      h.sim.startupSnapshot = async (ref, since) => {
        const snapshot = await originalSnapshot(ref, since)
        enterCapture?.()
        await hold
        return snapshot
      }
      h.clock.advance(10_000)
      const firstPending = sendConfirmation(http, observed.input)
      await entered
      const concurrent = await sendConfirmation(http, observed.input)
      const concurrentBody = await concurrent.json() as { error?: { name?: string; message?: string } }
      releaseCapture()
      const first = await firstPending
      const firstBody = await first.json() as { result?: { fillId?: string; alreadyRecorded?: boolean }; error?: { name?: string } }
      const snapshotsAfterCommit = h.sim.startupSnapshotCalls
      const replay = await sendConfirmation(http, observed.input)
      const replayBody = await replay.json() as { result?: { fillId?: string; alreadyRecorded?: boolean }; error?: { name?: string } }
      const resultPath = uniqueResultPath(h, 'B3_08C2_CONCURRENT_RESULT', 'B3_08C2_CONCURRENT_RESULT')
      writeFileSync(resultPath, JSON.stringify({ concurrentStatus: concurrent.status, concurrentError: concurrentBody.error,
        firstStatus: first.status, first: firstBody, replayStatus: replay.status, replay: replayBody,
        startupSnapshotCallsAfterCommit: snapshotsAfterCommit, startupSnapshotCallsAfterReplay: h.sim.startupSnapshotCalls,
        localFillCount: h.k.orders.fillsForOrder(h.paper.accountId, observed.order.orderId).length,
        ledgerFillCount: h.k.ledger.trace({ orderId: observed.order.orderId }).filter((entry) => entry.type === 'fill').length }), { flag: 'wx' })
      expect(concurrent.status).toBeGreaterThanOrEqual(400)
      expect(concurrentBody.error).toMatchObject({ name: 'BUSY', message: 'reconciliation capture is already running for this account' })
      expect(first.status).toBe(200)
      expect(firstBody.result?.alreadyRecorded).toBe(false)
      expect(replay.status).toBe(200)
      expect(replayBody.result).toMatchObject({ fillId: firstBody.result?.fillId, alreadyRecorded: true })
      expect(h.sim.startupSnapshotCalls).toBe(snapshotsAfterCommit)
      expect(h.k.orders.fillsForOrder(h.paper.accountId, observed.order.orderId)).toHaveLength(2)
      expect(h.k.ledger.trace({ orderId: observed.order.orderId }).filter((entry) => entry.type === 'fill')).toHaveLength(2)
    } finally {
      releaseCapture?.()
      await http.close()
    }
  })

  it('expires the original offer after thirty seconds and does not renew it through confirmation', async () => {
    h = await makeHarness()
    const http = await startHumanHttp(h)
    try {
      const observed = await observeOneGap(h, http)
      h.clock.advance(30_001)
      const response = await sendConfirmation(http, observed.input)
      const body = await response.json() as { error?: { name?: string; message?: string } }
      const resultPath = uniqueResultPath(h, 'B3_08C2_EXPIRY_RESULT', 'B3_08C2_EXPIRY_RESULT')
      writeFileSync(resultPath, JSON.stringify({ status: response.status, error: body.error,
        localFills: h.k.orders.fillsForOrder(h.paper.accountId, observed.order.orderId).length }), { flag: 'wx' })
      expect(response.status).toBe(400)
      expect(body.error).toMatchObject({ name: 'INVALID_PARAMS', message: 'the reconciliation offer changed or expired; refresh the account and review it again' })
      expect(h.k.orders.fillsForOrder(h.paper.accountId, observed.order.orderId)).toHaveLength(1)
    } finally {
      await http.close()
    }
  })

  it('does not accept a valid but shortened venue fills window as 24-hour coverage', async () => {
    h = await makeHarness()
    const http = await startHumanHttp(h)
    try {
      const observed = await observeOneGap(h, http)
      const originalSnapshot = h.sim.startupSnapshot.bind(h.sim)
      const clock = h.clock
      h.sim.startupSnapshot = async (ref, since) => ({ ...(await originalSnapshot(ref, since)), fillsSince: clock.now() })
      h.clock.advance(10_000)
      const response = await sendConfirmation(http, observed.input)
      const body = await response.json() as { error?: { name?: string; message?: string } }
      const resultPath = uniqueResultPath(h, 'B3_08C2_SHORT_WINDOW_RESULT', 'B3_08C2_SHORT_WINDOW_RESULT')
      writeFileSync(resultPath, JSON.stringify({ status: response.status, error: body.error,
        queryWindowStart: h.clock.now(), localFillCount: h.k.orders.fillsForOrder(h.paper.accountId, observed.order.orderId).length }), { flag: 'wx' })
      expect(response.status).toBe(400)
      expect(body.error).toMatchObject({ name: 'INVALID_PARAMS', message: 'the reconciliation offer changed or expired; refresh the account and review it again' })
      expect(h.k.orders.fillsForOrder(h.paper.accountId, observed.order.orderId)).toHaveLength(1)
    } finally {
      await http.close()
    }
  })

  it('preserves an unchanged offer without extending its original expiry and rejects its superseded id', async () => {
    h = await makeHarness()
    const http = await startHumanHttp(h)
    try {
      const observed = await observeOneGap(h, http)
      h.clock.advance(10_000)
      const sameResponse = await fetch(http.endpoint('/api/op/reconcile.refresh'), {
        method: 'POST', headers: http.auth, body: JSON.stringify({ params: { accountId: h.paper.accountId } }),
      })
      const same = await sameResponse.json() as { result?: { offerId?: string; reportId?: string } }
      expect(sameResponse.status).toBe(200)
      expect(same.result?.offerId).toBe(observed.input.offerId)
      h.clock.advance(20_001)
      const renewedResponse = await fetch(http.endpoint('/api/op/reconcile.refresh'), {
        method: 'POST', headers: http.auth, body: JSON.stringify({ params: { accountId: h.paper.accountId } }),
      })
      const renewed = await renewedResponse.json() as { result?: { offerId?: string } }
      expect(renewedResponse.status).toBe(200)
      expect(renewed.result?.offerId).toBeTruthy()
      expect(renewed.result?.offerId).not.toBe(observed.input.offerId)
      const staleResponse = await sendConfirmation(http, observed.input)
      const stale = await staleResponse.json() as { error?: { name?: string; message?: string } }
      const resultPath = uniqueResultPath(h, 'B3_08C2_SUPERSEDED_OFFER_RESULT', 'B3_08C2_SUPERSEDED_OFFER_RESULT')
      writeFileSync(resultPath, JSON.stringify({ sameOfferId: same.result?.offerId, renewedOfferId: renewed.result?.offerId,
        staleStatus: staleResponse.status, staleError: stale.error, localFills: h.k.orders.fillsForOrder(h.paper.accountId, observed.order.orderId).length }), { flag: 'wx' })
      expect(staleResponse.status).toBe(400)
      expect(stale.error).toMatchObject({ name: 'INVALID_PARAMS', message: 'the reconciliation offer changed or expired; refresh the account and review it again' })
      expect(h.k.orders.fillsForOrder(h.paper.accountId, observed.order.orderId)).toHaveLength(1)
    } finally {
      await http.close()
    }
  })

  it('lets a real Kernel tick sample other accounts without consuming a ready account human review window', async () => {
    h = await makeHarness()
    const http = await startHumanHttp(h)
    try {
      const observed = await observeOneGap(h, http)
      const initialPaperCalls = h.sim.startupSnapshotCalls
      const initialOtherCalls = h.live.startupSnapshotCalls
      const initialView = h.k.reconcileService.get(h.paper.accountId)[0]
      const initialAttempt = initialView?.lastAttemptAt
      h.clock.advance(10_100)
      const tickAt = h.clock.now()
      await h.k.tickOnce()
      const waitUntil = Date.now() + 2_000
      while (Date.now() < waitUntil && h.k.reconcileService.get(h.liveAcct.accountId)[0]?.lastAttemptAt !== tickAt) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      await new Promise((resolve) => setTimeout(resolve, 10))
      const afterTick = h.k.reconcileService.get(h.paper.accountId)[0]
      const otherAfterTick = h.k.reconcileService.get(h.liveAcct.accountId)[0]
      const paperCallsAfterTick = h.sim.startupSnapshotCalls
      const otherCallsAfterTick = h.live.startupSnapshotCalls
      const response = await sendConfirmation(http, observed.input)
      const body = await response.json() as { result?: { fillId?: string; alreadyRecorded?: boolean }; error?: { name?: string; message?: string } }
      const resultPath = uniqueResultPath(h, 'B3_08C2_TIMER_RESULT', 'B3_08C2_TIMER_RESULT')
      writeFileSync(resultPath, JSON.stringify({ tickAt, initialPaperCalls, paperCallsAfterTick,
        paperCallsAfterConfirmation: h.sim.startupSnapshotCalls, initialOtherCalls, otherCallsAfterTick,
        initialAttempt, paperAttemptAfterTick: afterTick?.lastAttemptAt,
        originalOfferId: observed.input.offerId, offerAfterTick: afterTick?.offerId,
        otherAttemptAfterTick: otherAfterTick?.lastAttemptAt, confirmationStatus: response.status, confirmation: body,
        orderFillCount: h.k.orders.fillsForOrder(h.paper.accountId, observed.order.orderId).length }), { flag: 'wx' })
      expect(afterTick?.lastAttemptAt).toBe(initialAttempt)
      expect(afterTick?.offerId).toBe(observed.input.offerId)
      expect(paperCallsAfterTick).toBe(initialPaperCalls)
      expect(h.sim.startupSnapshotCalls).toBe(initialPaperCalls + 1)
      expect(h.live.startupSnapshotCalls).toBeGreaterThan(initialOtherCalls)
      expect(otherAfterTick?.lastAttemptAt).toBe(tickAt)
      expect(response.status).toBe(200)
      expect(body.result?.fillId).toBeTruthy()
      expect(h.k.orders.fillsForOrder(h.paper.accountId, observed.order.orderId)).toHaveLength(2)
    } finally {
      await http.close()
    }
  })

  it('resumes automatic sampling after the original review expiry and refuses the old offer', async () => {
    h = await makeHarness()
    const http = await startHumanHttp(h)
    try {
      const observed = await observeOneGap(h, http)
      const callsBefore = h.sim.startupSnapshotCalls
      const originalAttempt = h.k.reconcileService.get(h.paper.accountId)[0]?.lastAttemptAt
      h.clock.advance(30_001)
      const tickAt = h.clock.now()
      await h.k.tickOnce()
      const deadline = Date.now() + 2_000
      while (Date.now() < deadline && h.k.reconcileService.get(h.paper.accountId)[0]?.lastAttemptAt !== tickAt) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      const afterTick = h.k.reconcileService.get(h.paper.accountId)[0]
      const callsAfterTick = h.sim.startupSnapshotCalls
      const response = await sendConfirmation(http, observed.input)
      const body = await response.json() as { error?: { name?: string; message?: string } }
      const resultPath = uniqueResultPath(h, 'B3_08C2_TIMER_EXPIRY_RESULT', 'timer-expiry')
      writeFileSync(resultPath, JSON.stringify({ callsBefore, callsAfterTick, originalAttempt,
        attemptAfterTick: afterTick?.lastAttemptAt, oldOfferId: observed.input.offerId, offerAfterTick: afterTick?.offerId,
        staleStatus: response.status, staleError: body.error,
        orderFillCount: h.k.orders.fillsForOrder(h.paper.accountId, observed.order.orderId).length }), { flag: 'wx' })
      expect(callsAfterTick).toBeGreaterThan(callsBefore)
      expect(afterTick?.lastAttemptAt).toBe(tickAt)
      expect(afterTick?.offerId).toBeTruthy()
      expect(afterTick?.offerId).not.toBe(observed.input.offerId)
      expect(response.status).toBe(400)
      expect(body.error).toMatchObject({ name: 'INVALID_PARAMS', message: 'the reconciliation offer changed or expired; refresh the account and review it again' })
      expect(h.k.orders.fillsForOrder(h.paper.accountId, observed.order.orderId)).toHaveLength(1)
    } finally {
      await http.close()
    }
  })

  it('does not hold automatic safety handling for damaged security state', async () => {
    h = await makeHarness()
    const http = await startHumanHttp(h)
    try {
      const observed = await observeOneGap(h, http)
      const callsBefore = h.sim.startupSnapshotCalls
      h.clock.advance(10_100)
      writeFileSync(join(h.home, 'keys', 'pin.json'), '{}')
      const tickAt = h.clock.now()
      await h.k.tickOnce()
      const deadline = Date.now() + 2_000
      while (Date.now() < deadline && h.k.reconcileService.get(h.paper.accountId)[0]?.lastAttemptAt !== tickAt) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      const view = h.k.reconcileService.get(h.paper.accountId)[0]
      const resultPath = uniqueResultPath(h, 'B3_08C2_TIMER_HEALTH_RESULT', 'timer-health')
      writeFileSync(resultPath, JSON.stringify({ callsBefore, callsAfter: h.sim.startupSnapshotCalls,
        state: view?.state, verdict: view?.verdict, offerIdPresent: Boolean(view?.offerId),
        attemptAfterTick: view?.lastAttemptAt,
        orderFillCount: h.k.orders.fillsForOrder(h.paper.accountId, observed.order.orderId).length }), { flag: 'wx' })
      expect(view?.state).toBe('unavailable')
      expect(view?.verdict).not.toBe('clean')
      expect(view?.offerId).toBeUndefined()
      expect(h.sim.startupSnapshotCalls).toBe(callsBefore)
      expect(h.k.orders.fillsForOrder(h.paper.accountId, observed.order.orderId)).toHaveLength(1)
    } finally {
      await http.close()
    }
  })

  it.each([
    { name: 'confirmation pending', collection: 'reconcile-confirm-pending', marker: 'receipt-fixture' },
    { name: 'late real evidence', collection: 'reconcile-late-pending', marker: true },
  ])('bypasses the review hold for a durable $name marker', async ({ collection, marker }) => {
    h = await makeHarness()
    const http = await startHumanHttp(h)
    try {
      const observed = await observeOneGap(h, http)
      const callsBefore = h.sim.startupSnapshotCalls
      h.clock.advance(10_100)
      h.k.docs.put(collection, h.paper.accountId, marker)
      const tickAt = h.clock.now()
      await h.k.tickOnce()
      const deadline = Date.now() + 2_000
      while (Date.now() < deadline && h.k.reconcileService.get(h.paper.accountId)[0]?.state !== 'unavailable') {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      const view = h.k.reconcileService.get(h.paper.accountId)[0]
      const markerResultEnv = collection === 'reconcile-confirm-pending'
        ? 'B3_08C2_TIMER_CONFIRM_PENDING_RESULT' : 'B3_08C2_TIMER_LATE_PENDING_RESULT'
      const resultPath = uniqueResultPath(h, markerResultEnv, `timer-marker-${collection}`)
      writeFileSync(resultPath, JSON.stringify({ collection, tickAt, callsBefore, callsAfter: h.sim.startupSnapshotCalls,
        state: view?.state, verdict: view?.verdict, findingCodes: view?.findings.map((finding) => finding.code),
        offerIdPresent: Boolean(view?.offerId), orderFillCount: h.k.orders.fillsForOrder(h.paper.accountId, observed.order.orderId).length }), { flag: 'wx' })
      expect(view?.state).toBe('unavailable')
      expect(view?.verdict).toBe('blocked')
      expect(view?.suggestions).toHaveLength(0)
      expect(view?.offerId).toBeUndefined()
      expect(h.sim.startupSnapshotCalls).toBe(callsBefore)
      expect(h.k.orders.fillsForOrder(h.paper.accountId, observed.order.orderId)).toHaveLength(1)
    } finally {
      await http.close()
    }
  })

  it.each(['gap', 'price', 'full local fills'] as const)('refuses %s changes during the awaited venue capture without adding an inferred fill', async (change) => {
    h = await makeHarness()
    const http = await startHumanHttp(h)
    let releaseCapture: () => void = () => { throw new Error('capture release was not initialized') }
    let enteredCapture: (() => void) | undefined
    try {
      let observed: ObservedOffer
      let historyAvgFillPrice = '80000'
      if (change === 'price') {
        const order = await placePartialOrder(h, http)
        h.sim.openOrdersOverride = []
        h.sim.positions.set(h.paper.accountId, [remotePosition(h, 'long', '0.002')])
        h.sim.orderStatus = async (_ref, key): Promise<VenueOrderStatus> => key.clientOrderId === order.clientOrderId || key.venueOrderId === order.venueOrderId
          ? { found: true, status: 'filled', venueOrderId: order.venueOrderId, filledSize: asDecimal('0.002'), avgFillPrice: asDecimal(historyAvgFillPrice) }
          : { found: false }
        const refreshResponse = await fetch(http.endpoint('/api/op/reconcile.refresh'), {
          method: 'POST', headers: http.auth, body: JSON.stringify({ params: { accountId: h.paper.accountId } }),
        })
        const refreshed = await refreshResponse.json() as { result?: ObservedOffer['result'] }
        const suggestion = refreshed.result?.suggestions?.[0]
        expect(refreshResponse.status).toBe(200)
        expect(suggestion?.price).toBe('80000')
        expect(suggestion?.priceSource).toBe('venue_avg_fill_price')
        if (!refreshed.result?.offerId || !refreshed.result.reportId || !suggestion?.id) throw new Error('history reconciliation did not offer its measured cumulative gap')
        observed = {
          order,
          result: refreshed.result,
          input: { accountId: h.paper.accountId, offerId: refreshed.result.offerId, reportId: refreshed.result.reportId,
            suggestionId: suggestion.id, fee: asDecimal('0'), feeCcy: 'USDC', liquidity: 'maker', realizedPnl: asDecimal('0') },
          previewPrice: suggestion.price,
          previewPriceSource: suggestion.priceSource,
          historyAvgFillPrice,
        }
      } else {
        observed = await observeOneGap(h, http)
      }
      const entered = new Promise<void>((resolve) => { enteredCapture = resolve })
      const hold = new Promise<void>((resolve) => { releaseCapture = resolve })
      const originalSnapshot = h.sim.startupSnapshot.bind(h.sim)
      let captured: StartupSnapshot | undefined
      h.sim.startupSnapshot = async (ref, since) => {
        captured = await originalSnapshot(ref, since)
        enteredCapture?.()
        await hold
        return captured
      }
      h.clock.advance(10_000)
      const pendingResponse = sendConfirmation(http, observed.input)
      await entered
      if (!captured) throw new Error('confirmation did not enter its real connector snapshot request')
      if (change === 'gap') captured.openOrders[0]!.size = asDecimal('0.009')
      else if (change === 'price') historyAvgFillPrice = '81000'
      else h.k.trading.onVenueFill(h.paper.accountId, {
        venueOrderId: observed.order.venueOrderId, clientOrderId: observed.order.clientOrderId, venueFillId: `confirm-during-capture-${observed.order.orderId}`,
        instrumentId: observed.order.instrumentId as never, side: 'buy', price: asDecimal('80000'), size: asDecimal('0.0001'),
        fee: asDecimal('0'), feeCcy: 'USDC', liquidity: 'maker', realizedPnl: asDecimal('0'), ts: h.clock.now(),
      })
      const beforeRefusal = h.k.orders.fillsForOrder(h.paper.accountId, observed.order.orderId).length
      releaseCapture()
      const response = await pendingResponse
      const body = await response.json() as { error?: { name?: string; message?: string } }
      const resultBase = uniqueResultPath(h, 'B3_08C2_CHANGED_EVIDENCE_RESULT_BASE', 'changed-evidence')
      writeFileSync(`${resultBase}-${change.replaceAll(' ', '-')}.json`, JSON.stringify({ change, status: response.status, error: body.error,
        baselineLocalFillsAfterChange: beforeRefusal, finalLocalFills: h.k.orders.fillsForOrder(h.paper.accountId, observed.order.orderId).length,
        inferredFills: h.k.orders.fillsForOrder(h.paper.accountId, observed.order.orderId).filter((fill) => !!fill.inferred).length,
        ...(change === 'price' ? { previewPrice: observed.previewPrice, previewPriceSource: observed.previewPriceSource,
          observedHistoryAvgFillPrice: historyAvgFillPrice } : {}) }), { flag: 'wx' })
      if (change === 'price') {
        expect(observed.previewPrice).toBe('80000')
        expect(observed.previewPriceSource).toBe('venue_avg_fill_price')
        expect(historyAvgFillPrice).toBe('81000')
      }
      expect(response.status).toBe(400)
      expect(body.error).toMatchObject({ name: 'INVALID_PARAMS', message: 'the reconciliation offer changed or expired; refresh the account and review it again' })
      expect(h.k.orders.fillsForOrder(h.paper.accountId, observed.order.orderId)).toHaveLength(beforeRefusal)
      expect(h.k.orders.fillsForOrder(h.paper.accountId, observed.order.orderId).filter((fill) => !!fill.inferred)).toHaveLength(0)
    } finally {
      releaseCapture?.()
      await http.close()
    }
  })

  it('confirms one real observed gap over HTTP with explicit human amounts and durable readback', async () => {
    h = await makeHarness()
    const http = await startHumanHttp(h)
    try {
      const placedResponse = await fetch(http.endpoint('/api/op/order.place'), {
        method: 'POST', headers: http.auth,
        body: JSON.stringify({ params: { intent: {
          accountId: h.paper.accountId, instrumentId: 'hyperliquid:BTC', side: 'buy', type: 'limit',
          size: '0.012', price: '80000', tif: 'gtc', clientOrderId: newClientOrderId(),
        } } }),
      })
      const placed = await placedResponse.json() as { result?: { order?: { orderId: string; clientOrderId: string; venueOrderId?: string; accountId: string; instrumentId: string } } }
      expect(placedResponse.status).toBe(200)
      const order = placed.result?.order
      expect(order?.venueOrderId).toBeTruthy()
      if (!order?.venueOrderId) throw new Error('real order placement did not return its venue identity')

      h.k.trading.onVenueFill(h.paper.accountId, {
        venueOrderId: order.venueOrderId, clientOrderId: order.clientOrderId, venueFillId: 'confirm-existing-partial',
        instrumentId: order.instrumentId, side: 'buy', price: asDecimal('80000'), size: asDecimal('0.001'),
        fee: asDecimal('0.0001'), feeCcy: 'USDC', liquidity: 'maker', realizedPnl: asDecimal('0'), ts: h.clock.now(),
      })
      h.sim.openOrdersOverride = [{
        instrumentId: 'hyperliquid:BTC' as VenueOpenOrder['instrumentId'], venueOrderId: order.venueOrderId,
        clientOrderId: order.clientOrderId as VenueOpenOrder['clientOrderId'], side: 'buy', type: 'limit',
        price: asDecimal('80000'), triggerPrice: null, size: asDecimal('0.01'), origSize: asDecimal('0.012'),
        reduceOnly: false, isTrigger: false, createdAt: h.clock.now(),
      }]
      h.sim.positions.set(h.paper.accountId, [{
        accountId: h.paper.accountId, instrumentId: 'hyperliquid:BTC' as Position['instrumentId'], side: 'long',
        size: asDecimal('0.002'), entryPrice: asDecimal('80000'), markPrice: asDecimal('80000'), notional: asDecimal('160'),
        unrealizedPnl: asDecimal('0'), realizedPnl: asDecimal('0'), leverage: 2, marginMode: 'cross', liquidationPrice: null,
        fundingSinceOpen: asDecimal('0'), openedAt: h.clock.now(), updatedAt: h.clock.now(),
      }])
      const refreshResponse = await fetch(http.endpoint('/api/op/reconcile.refresh'), {
        method: 'POST', headers: http.auth, body: JSON.stringify({ params: { accountId: h.paper.accountId } }),
      })
      const refreshed = await refreshResponse.json() as { result?: { offerId?: string; reportId?: string; state?: string; verdict?: string; findings?: Array<{ code: string; severity: string }>; coverage?: unknown; suggestions?: Array<{ id: string }> } }
      expect(refreshResponse.status).toBe(200)
      const suggestion = refreshed.result?.suggestions?.[0]
      expect(suggestion?.id).toBeTruthy()
      if (!refreshed.result?.offerId || !refreshed.result.reportId || !suggestion?.id) throw new Error('fresh reconciliation did not offer an observed gap')

      const input: ReconcileConfirmInput = {
        accountId: h.paper.accountId, offerId: refreshed.result.offerId, reportId: refreshed.result.reportId,
        suggestionId: suggestion.id, fee: asDecimal('0'), feeCcy: 'USDC', liquidity: 'maker', realizedPnl: asDecimal('0'),
      }
      h.clock.advance(10_000)
      const confirmationResponse = await fetch(http.endpoint('/api/op/reconcile.confirm'), {
        method: 'POST', headers: { ...http.auth, 'x-gitrader-pin': TEST_PIN },
        body: JSON.stringify({ params: confirmFields(input) }),
      })
      const confirmation = await confirmationResponse.json() as { result?: { fillId: string; alreadyRecorded: boolean }; error?: { name?: string; message?: string } }
      const resultPath = uniqueResultPath(h, 'B3_08C2_HTTP_POSITIVE_RESULT', 'B3_08C2_HTTP_POSITIVE_RESULT')
      writeFileSync(resultPath, JSON.stringify({ status: confirmationResponse.status, body: confirmation, refresh: {
        state: refreshed.result?.state, verdict: refreshed.result?.verdict, findings: refreshed.result?.findings,
        coverage: refreshed.result?.coverage, offerId: refreshed.result?.offerId, suggestionCount: refreshed.result?.suggestions?.length,
      } }), { flag: 'wx' })
      expect(confirmationResponse.status, JSON.stringify(confirmation.error)).toBe(200)
      expect(confirmation.result).toMatchObject({ alreadyRecorded: false })

      const orderAfter = h.k.orders.get(order.orderId)
      const fills = h.k.orders.fillsForOrder(h.paper.accountId, order.orderId)
      expect(orderAfter?.filledSize).toBe('0.002')
      expect(fills).toHaveLength(2)
      const inferred = fills.find((fill) => fill.fillId === confirmation.result?.fillId)
      expect(inferred).toMatchObject({ size: '0.001', price: '80000', fee: '0', feeCcy: 'USDC', liquidity: 'maker', realizedPnl: '0', inferred: { suggestionId: suggestion.id, reportId: refreshed.result?.reportId, confirmedBy: 'user:usr_local' } })
      expect(h.k.ledger.trace({ orderId: order.orderId }).filter((entry) => entry.type === 'fill')).toHaveLength(2)
      const receipt = h.k.docs.get<{ effectsState: string; fillId: string }>('reconcile-confirm-receipt', `rcpt_${(await import('../src/util/hash')).digestOf([h.paper.accountId, suggestion.id]).slice('sha256:'.length)}`)
      expect(receipt).toMatchObject({ effectsState: 'complete', fillId: confirmation.result?.fillId })
    } finally {
      await http.close()
    }
  })

  it('refuses an unexplained extra position delta without writing a fill or ledger entry', async () => {
    h = await makeHarness()
    const http = await startHumanHttp(h)
    try {
      const observed = await observeOneGap(h, http, 'long', '0.003')
      h.clock.advance(10_000)
      const response = await sendConfirmation(http, observed.input)
      const body = await response.json() as { error?: { name?: string; message?: string } }
      const resultPath = uniqueResultPath(h, 'B3_08C2_EXTRA_POSITION_RESULT', 'B3_08C2_EXTRA_POSITION_RESULT')
      writeFileSync(resultPath, JSON.stringify({ status: response.status, body, suggestionId: observed.input.suggestionId,
        orderFilledSize: h.k.orders.get(observed.order.orderId)?.filledSize, orderFillCount: h.k.orders.fillsForOrder(h.paper.accountId, observed.order.orderId).length,
        ledgerFillCount: h.k.ledger.trace({ orderId: observed.order.orderId }).filter((entry) => entry.type === 'fill').length }), { flag: 'wx' })
      expect(response.status).toBe(400)
      expect(body.error).toMatchObject({ name: 'INVALID_PARAMS', message: 'reconciliation requires human review before a new confirmation' })
      expect(h.k.orders.get(observed.order.orderId)?.filledSize).toBe('0.001')
      expect(h.k.orders.fillsForOrder(h.paper.accountId, observed.order.orderId)).toHaveLength(1)
      expect(h.k.ledger.trace({ orderId: observed.order.orderId }).filter((entry) => entry.type === 'fill')).toHaveLength(1)
    } finally {
      await http.close()
    }
  })

  it('refuses a position whose direction opposes the inferred buy candidate', async () => {
    h = await makeHarness()
    const http = await startHumanHttp(h)
    try {
      const observed = await observeOneGap(h, http, 'short', '0.002')
      h.clock.advance(10_000)
      const response = await sendConfirmation(http, observed.input)
      const body = await response.json() as { error?: { name?: string; message?: string } }
      const resultPath = uniqueResultPath(h, 'B3_08C2_OPPOSITE_POSITION_RESULT', 'B3_08C2_OPPOSITE_POSITION_RESULT')
      writeFileSync(resultPath, JSON.stringify({ status: response.status, body, orderFilledSize: h.k.orders.get(observed.order.orderId)?.filledSize }), { flag: 'wx' })
      expect(response.status).toBe(400)
      expect(body.error).toMatchObject({ name: 'INVALID_PARAMS', message: 'reconciliation requires human review before a new confirmation' })
      expect(h.k.orders.get(observed.order.orderId)?.filledSize).toBe('0.001')
      expect(h.k.orders.fillsForOrder(h.paper.accountId, observed.order.orderId)).toHaveLength(1)
    } finally {
      await http.close()
    }
  })

  it('confirms one of two exactly explained candidates and leaves the other visible and unbooked', async () => {
    h = await makeHarness()
    const http = await startHumanHttp(h)
    try {
      const first = await placePartialOrder(h, http, 'buy', '0.006')
      h.clock.advance(10_001)
      const second = await placePartialOrder(h, http, 'buy', '0.006')
      h.sim.openOrdersOverride = [remoteOpen(first, '0.006', '0.004'), remoteOpen(second, '0.006', '0.004')]
      h.sim.positions.set(h.paper.accountId, [remotePosition(h, 'long', '0.004')])
      const refresh = await fetch(http.endpoint('/api/op/reconcile.refresh'), {
        method: 'POST', headers: http.auth, body: JSON.stringify({ params: { accountId: h.paper.accountId } }),
      })
      const refreshed = await refresh.json() as { result?: { offerId?: string; reportId?: string; suggestions?: Array<{ id: string; orderId: string }> } }
      expect(refresh.status).toBe(200)
      const suggestions = refreshed.result?.suggestions ?? []
      expect(suggestions).toHaveLength(2)
      const selected = suggestions.find((candidate) => candidate.orderId === first.orderId)
      const remaining = suggestions.find((candidate) => candidate.orderId === second.orderId)
      if (!refreshed.result?.offerId || !refreshed.result.reportId || !selected || !remaining) throw new Error('two independently linked candidates were not offered')
      h.clock.advance(10_000)
      const input: ReconcileConfirmInput = { accountId: h.paper.accountId, offerId: refreshed.result.offerId,
        reportId: refreshed.result.reportId, suggestionId: selected.id, fee: asDecimal('0'), feeCcy: 'USDC', liquidity: 'maker', realizedPnl: asDecimal('0') }
      const response = await sendConfirmation(http, input)
      const body = await response.json() as { result?: { fillId?: string }; error?: { name?: string; message?: string } }
      const resultPath = uniqueResultPath(h, 'B3_08C2_TWO_CANDIDATES_RESULT', 'B3_08C2_TWO_CANDIDATES_RESULT')
      const view = h.k.reconcileService.get(h.paper.accountId).find((candidate) => candidate.accountId === h?.paper.accountId)
      if (!view) throw new Error('confirmation status view missing for the paper account')
      writeFileSync(resultPath, JSON.stringify({ status: response.status, body, selected: selected.id, remaining: remaining.id,
        selectedFillCount: h.k.orders.fillsForOrder(h.paper.accountId, first.orderId).length,
        remainingFillCount: h.k.orders.fillsForOrder(h.paper.accountId, second.orderId).length,
        visibleSuggestions: view.suggestions.map((candidate) => candidate.id) }), { flag: 'wx' })
      expect(response.status, JSON.stringify(body.error)).toBe(200)
      expect(body.result?.fillId).toBeTruthy()
      expect(h.k.orders.fillsForOrder(h.paper.accountId, first.orderId)).toHaveLength(2)
      expect(h.k.orders.fillsForOrder(h.paper.accountId, second.orderId)).toHaveLength(1)
      expect(view.suggestions.map((candidate) => candidate.id)).toContain(remaining.id)
    } finally {
      await http.close()
    }
  })

  it('uses the selected order history cumulative quantity as confirmation coverage', async () => {
    h = await makeHarness()
    const http = await startHumanHttp(h)
    try {
      const order = await placePartialOrder(h, http)
      h.sim.openOrdersOverride = []
      h.sim.positions.set(h.paper.accountId, [remotePosition(h, 'long', '0.002')])
      h.sim.orderStatus = async (_ref, key): Promise<VenueOrderStatus> => key.clientOrderId === order.clientOrderId || key.venueOrderId === order.venueOrderId
        ? { found: true, status: 'filled', venueOrderId: order.venueOrderId, filledSize: asDecimal('0.002'), avgFillPrice: asDecimal('80000') }
        : { found: false }
      const refreshResponse = await fetch(http.endpoint('/api/op/reconcile.refresh'), {
        method: 'POST', headers: http.auth, body: JSON.stringify({ params: { accountId: h.paper.accountId } }),
      })
      const refreshed = await refreshResponse.json() as { result?: ObservedOffer['result'] }
      const suggestion = refreshed.result?.suggestions?.[0]
      expect(refreshResponse.status).toBe(200)
      expect(refreshed.result?.findings).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'local_open_venue_filled', severity: 'blocker' })]))
      if (!refreshed.result?.offerId || !refreshed.result.reportId || !suggestion?.id) throw new Error('history reconciliation did not offer its measured cumulative gap')
      h.clock.advance(10_000)
      const input: ReconcileConfirmInput = { accountId: h.paper.accountId, offerId: refreshed.result.offerId,
        reportId: refreshed.result.reportId, suggestionId: suggestion.id, fee: asDecimal('0'), feeCcy: 'USDC', liquidity: 'maker', realizedPnl: asDecimal('0') }
      const response = await sendConfirmation(http, input)
      const body = await response.json() as { result?: { fillId?: string }; error?: { name?: string; message?: string } }
      const resultPath = uniqueResultPath(h, 'B3_08C2_HISTORY_RESULT', 'B3_08C2_HISTORY_RESULT')
      writeFileSync(resultPath, JSON.stringify({ status: response.status, body, historyFinding: refreshed.result?.findings?.find((finding) => finding.code === 'local_open_venue_filled'),
        localFillCount: h.k.orders.fillsForOrder(h.paper.accountId, order.orderId).length }), { flag: 'wx' })
      expect(response.status).toBe(200)
      expect(body.result?.fillId).toBeTruthy()
      expect(h.k.orders.fillsForOrder(h.paper.accountId, order.orderId)).toHaveLength(2)
    } finally {
      await http.close()
    }
  })

  it('rejects malformed venue fillsSince windows even when ordinary 24-hour coverage is required', async () => {
    const invalidWindows: Array<{ name: string; value: unknown }> = [
      { name: 'undefined', value: undefined }, { name: 'nan', value: Number.NaN },
      { name: 'negative', value: -1 }, { name: 'fractional', value: 0.5 },
    ]
    for (const invalid of invalidWindows) {
      h = await makeHarness()
      const http = await startHumanHttp(h)
      try {
        const observed = await observeOneGap(h, http)
        const originalSnapshot = h.sim.startupSnapshot.bind(h.sim)
        h.sim.startupSnapshot = async (ref, since) => ({ ...(await originalSnapshot(ref, since)), fillsSince: invalid.value as number })
        h.clock.advance(10_000)
        const response = await sendConfirmation(http, observed.input)
        const body = await response.json() as { error?: { name?: string; message?: string } }
        const resultPath = uniqueResultPath(h, 'B3_08C2_INVALID_WINDOW_RESULT_BASE', `invalid-window-${invalid.name}`)
        writeFileSync(resultPath, JSON.stringify({ status: response.status, error: body.error,
          orderFilledSize: h.k.orders.get(observed.order.orderId)?.filledSize,
          orderFillCount: h.k.orders.fillsForOrder(h.paper.accountId, observed.order.orderId).length }), { flag: 'wx' })
        expect(response.status).toBe(400)
        expect(body.error).toMatchObject({ name: 'INVALID_PARAMS', message: 'the reconciliation offer changed or expired; refresh the account and review it again' })
        expect(h.k.orders.get(observed.order.orderId)?.filledSize).toBe('0.001')
        expect(h.k.orders.fillsForOrder(h.paper.accountId, observed.order.orderId)).toHaveLength(1)
      } finally {
        await http.close()
        await h.cleanup()
        h = undefined
      }
    }
  })

  it('returns the committed fill after an injected projection failure and makes the identical retry read-only', async () => {
    h = await makeHarness()
    const http = await startHumanHttp(h)
    try {
      const observed = await observeOneGap(h, http)
      const originalForPolling = h.k.orders.forPolling.bind(h.k.orders)
      let injected = false
      h.k.orders.forPolling = ((accountId: string, sinceMs: number) => {
        const orders = originalForPolling(accountId, sinceMs)
        if (!injected && accountId === h?.paper.accountId && orders.some((order) => order.orderId === observed.order.orderId && order.filledSize === '0.002')) {
          injected = true
          throw new Error('injected postcommit projection read failure')
        }
        return orders
      }) as typeof h.k.orders.forPolling
      h.clock.advance(10_000)
      const firstResponse = await sendConfirmation(http, observed.input)
      const first = await firstResponse.json() as { result?: { fillId?: string; alreadyRecorded?: boolean }; error?: { name?: string } }
      h.k.orders.forPolling = originalForPolling
      const fillCountAfterCommit = h.k.orders.fillsForOrder(h.paper.accountId, observed.order.orderId).length
      const ledgerFillCountAfterCommit = h.k.ledger.trace({ orderId: observed.order.orderId }).filter((entry) => entry.type === 'fill').length
      const retryResponse = await sendConfirmation(http, observed.input)
      const retry = await retryResponse.json() as { result?: { fillId?: string; alreadyRecorded?: boolean }; error?: { name?: string } }
      const resultPath = uniqueResultPath(h, 'B3_08C2_POSTCOMMIT_RESULT', 'B3_08C2_POSTCOMMIT_RESULT')
      writeFileSync(resultPath, JSON.stringify({ injected, firstStatus: firstResponse.status, first, retryStatus: retryResponse.status, retry,
        fillCountAfterCommit, finalFillCount: h.k.orders.fillsForOrder(h.paper.accountId, observed.order.orderId).length,
        ledgerFillCountAfterCommit, finalLedgerFillCount: h.k.ledger.trace({ orderId: observed.order.orderId }).filter((entry) => entry.type === 'fill').length }), { flag: 'wx' })
      expect(injected).toBe(true)
      expect(firstResponse.status).toBe(200)
      expect(first.result?.fillId).toBeTruthy()
      expect(first.result?.alreadyRecorded).toBe(false)
      expect(retryResponse.status).toBe(200)
      expect(retry.result).toMatchObject({ fillId: first.result?.fillId, alreadyRecorded: true })
      expect(fillCountAfterCommit).toBe(2)
      expect(h.k.orders.fillsForOrder(h.paper.accountId, observed.order.orderId)).toHaveLength(2)
      expect(ledgerFillCountAfterCommit).toBe(2)
      expect(h.k.ledger.trace({ orderId: observed.order.orderId }).filter((entry) => entry.type === 'fill')).toHaveLength(2)
    } finally {
      await http.close()
    }
  })

  it('keeps a late-real safety overlay while an exact committed receipt retry remains read-only', async () => {
    h = await makeHarness()
    const http = await startHumanHttp(h)
    try {
      const observed = await observeOneGap(h, http)
      h.clock.advance(10_000)
      const firstResponse = await sendConfirmation(http, observed.input)
      const first = await firstResponse.json() as { result?: { fillId?: string; alreadyRecorded?: boolean }; error?: { name?: string } }
      expect(firstResponse.status).toBe(200)
      expect(first.result?.fillId).toBeTruthy()
      h.k.trading.onVenueFill(h.paper.accountId, {
        venueOrderId: observed.order.venueOrderId, clientOrderId: observed.order.clientOrderId, venueFillId: `late-after-confirm-${observed.order.orderId}`,
        instrumentId: observed.order.instrumentId as never, side: 'buy', price: asDecimal('80000'), size: asDecimal('0.001'),
        fee: asDecimal('0'), feeCcy: 'USDC', liquidity: 'maker', realizedPnl: asDecimal('0'), ts: h.clock.now(),
      })
      expect(h.k.trading.lateRealEvidencePending(h.paper.accountId)).toBe(true)
      const snapshotCalls = h.sim.startupSnapshotCalls
      const retryResponse = await sendConfirmation(http, observed.input)
      const retry = await retryResponse.json() as { result?: { fillId?: string; alreadyRecorded?: boolean }; error?: { name?: string } }
      const view = h.k.reconcileService.get(h.paper.accountId)[0]
      const resultPath = uniqueResultPath(h, 'B3_08C2_LATE_RECEIPT_RESULT', 'B3_08C2_LATE_RECEIPT_RESULT')
      writeFileSync(resultPath, JSON.stringify({ firstStatus: firstResponse.status, first, retryStatus: retryResponse.status, retry,
        latePending: h.k.trading.lateRealEvidencePending(h.paper.accountId), startupSnapshotCallsBeforeRetry: snapshotCalls,
        startupSnapshotCallsAfterRetry: h.sim.startupSnapshotCalls, viewState: view?.state, viewVerdict: view?.verdict,
        lateFinding: view?.findings.some((finding) => finding.code === 'LATE_REAL_FILL_REVIEW_REQUIRED'),
        totalFillCount: h.k.orders.fillsForOrder(h.paper.accountId, observed.order.orderId).length,
        inferredFillCount: h.k.orders.fillsForOrder(h.paper.accountId, observed.order.orderId).filter((fill) => !!fill.inferred).length }), { flag: 'wx' })
      expect(retryResponse.status).toBe(200)
      expect(retry.result).toMatchObject({ fillId: first.result?.fillId, alreadyRecorded: true })
      expect(h.sim.startupSnapshotCalls).toBe(snapshotCalls)
      expect(view?.findings.some((finding) => finding.code === 'LATE_REAL_FILL_REVIEW_REQUIRED')).toBe(true)
      expect(view?.offerId).toBeUndefined()
      expect(h.k.orders.fillsForOrder(h.paper.accountId, observed.order.orderId).filter((fill) => !!fill.inferred)).toHaveLength(1)
    } finally {
      await http.close()
    }
  })
})
