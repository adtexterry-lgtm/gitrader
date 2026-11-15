// SPDX-License-Identifier: CPAL-1.0
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Order, OrderIntent } from '../src/proto'
import type { VenueFill } from '@gitrader/protocol/connector'
import type { VenueConnector } from '../src/connector'
import type { Harness } from './helpers/harness'
import { enableLive, makeHarness } from './helpers/harness'
import { BTC, ETH } from './helpers/fake-connector'

let h: Harness | undefined
afterEach(async () => { await h?.cleanup(); h = undefined })

async function liveHarness(pollOrders = true, logs: string[] = []): Promise<Harness> {
  h = await makeHarness({ registerLive: false, kernel: { log: (message) => logs.push(message) } })
  await enableLive(h)
  h.k.registerConnector(h.live, pollOrders ? { pollOrders: true } : {})
  return h
}

async function placeIoc(instrumentId: string, size = '0.001'): Promise<Order> {
  const result = await h!.k.trading.place({ intent: {
    accountId: h!.liveAcct.accountId as never, instrumentId, side: 'buy', type: 'limit',
    price: '79000' as never, size: size as never, leverage: 2, tif: 'ioc',
  } as OrderIntent }, h!.human())
  expect(result.order?.status, JSON.stringify({ problem: result.order?.problem })).toBe('open')
  return result.order!
}

async function liveHarnessWithSecondAccount(): Promise<Harness> {
  h = await makeHarness({
    registerLive: false,
    configure: (config) => {
      const first = config.accounts.find((account) => account.alias === 'live')
      if (!first) throw new Error('fixture live account missing')
      config.accounts.push({ ...first, alias: 'live-b', accountId: 'acct_live_b' as typeof first.accountId })
    },
  })
  await enableLive(h)
  h.k.registerConnector(h.live, { pollOrders: true })
  return h
}

async function placeIocForAccount(accountId: string): Promise<Order> {
  const result = await h!.k.trading.place({ intent: {
    accountId: accountId as never, instrumentId: BTC, side: 'buy', type: 'limit',
    price: '79000' as never, size: '0.001' as never, leverage: 2, tif: 'ioc',
  } as OrderIntent }, h!.human())
  expect(result.order?.status, JSON.stringify({ problem: result.order?.problem })).toBe('open')
  return result.order!
}

async function awaitLivePoll(h: Harness): Promise<void> {
  await (h.k as unknown as { livePollRun?: Promise<void> }).livePollRun
}

async function withinOneSecond<T>(promise: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('tick exceeded one second')), 1000) }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

function fill(order: Order, venueFillId: string, ts = h!.clock.now(), size: string | VenueFill['size'] = order.size): VenueFill {
  return {
    venueOrderId: order.venueOrderId!, clientOrderId: order.clientOrderId, venueFillId,
    instrumentId: order.instrumentId, side: order.side, price: order.price ?? '79000', size: size as VenueFill['size'],
    fee: '0', feeCcy: 'USDC', liquidity: 'taker', realizedPnl: '0', ts,
  } as VenueFill
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

describe('Kernel continuous live order polling', () => {
  it('accounts for an IOC fill only after the normal acknowledgement and a live poll', async () => {
    const h = await liveHarness()
    const order = await placeIoc(BTC)
    expect(h.k.orders.get(order.orderId)?.filledSize).toBe('0')
    const duplicateFill = fill(order, 'poll-ioc-fill')
    const returned = [duplicateFill, duplicateFill]
    const fills = vi.spyOn(h.live, 'fills').mockResolvedValue(returned)

    await h.k.tickOnce()
    await awaitLivePoll(h)

    expect(fills).toHaveBeenCalledTimes(1)
    expect(fills).toHaveBeenCalledWith(expect.anything(), h.clock.now() - 24 * 60 * 60 * 1000, { instrumentId: BTC })
    expect(h.k.orders.get(order.orderId)).toMatchObject({ status: 'filled', filledSize: order.size })
    expect(h.k.ledger.query({ types: ['fill'] })).toHaveLength(1)
  })

  it('polls a shared instrument once and keeps cursors separate across instruments', async () => {
    const h = await liveHarness()
    const btcOne = await placeIoc(BTC)
    h.clock.advance(11_000)
    await placeIoc(BTC)
    h.clock.advance(11_000)
    const eth = await placeIoc(ETH)
    const btcFills = [fill(btcOne, 'btc-cursor-fill', h.clock.now() - 100)]
    const ethFills = [fill(eth, 'eth-cursor-fill', h.clock.now() - 50)]
    const fills = vi.spyOn(h.live as VenueConnector, 'fills').mockImplementation(async (_ref, _since, options) => options?.instrumentId === BTC ? btcFills : ethFills)

    await h.k.tickOnce()
    await awaitLivePoll(h)

    expect(fills).toHaveBeenCalledTimes(2)
    expect(fills.mock.calls.map((call) => call[2]?.instrumentId)).toEqual([BTC, ETH])
    expect(fills.mock.calls[0]?.[1]).toBe(h.clock.now() - 24 * 60 * 60 * 1000)
    expect(fills.mock.calls[1]?.[1]).toBe(h.clock.now() - 24 * 60 * 60 * 1000)
  })

  it('keeps successful fill cursors independent for different instruments', async () => {
    const h = await liveHarness()
    const btc = await placeIoc(BTC)
    h.clock.advance(11_000)
    const eth = await placeIoc(ETH)
    const highTs = h.clock.now() - 100
    const sinceValues: { instrumentId?: string; since: number }[] = []
    vi.spyOn(h.live as VenueConnector, 'fills').mockImplementation(async (_ref, since, options) => {
      sinceValues.push({ instrumentId: options?.instrumentId, since })
      return options?.instrumentId === BTC ? [fill(btc, 'btc-cursor-high', highTs, '0.0001')] : []
    })

    await h.k.tickOnce()
    await awaitLivePoll(h)
    h.clock.advance(5_000)
    await h.k.tickOnce()
    await awaitLivePoll(h)

    expect(sinceValues).toHaveLength(4)
    expect(sinceValues[0]?.since).toBe(h.clock.now() - 5_000 - 24 * 60 * 60 * 1000)
    expect(sinceValues[1]?.since).toBe(h.clock.now() - 5_000 - 24 * 60 * 60 * 1000)
    expect(sinceValues[2]).toEqual({ instrumentId: BTC, since: highTs - 1_000 })
    expect(sinceValues[3]).toEqual({ instrumentId: ETH, since: h.clock.now() - 24 * 60 * 60 * 1000 })
    expect(eth.instrumentId).toBe(ETH)
  })

  it('updates a local open order when lookup reports cancelled and still polls its instrument', async () => {
    const h = await liveHarness()
    const order = await placeIoc(BTC)
    const orderStatus = vi.spyOn(h.live, 'orderStatus').mockResolvedValue({ found: true, status: 'cancelled', venueOrderId: order.venueOrderId! })
    const fills = vi.spyOn(h.live, 'fills').mockResolvedValue([])
    const orderEvents: { data: unknown }[] = []
    h.k.events.subscribe('account.orders', (event) => orderEvents.push(event))

    await h.k.tickOnce()
    await awaitLivePoll(h)
    expect(h.k.orders.get(order.orderId)?.status).toBe('cancelled')
    expect(orderEvents.some((event) => (event.data as Order).status === 'cancelled')).toBe(true)
    expect(fills).toHaveBeenCalledTimes(1)

    h.clock.advance(5_000)
    await h.k.tickOnce()
    await awaitLivePoll(h)
    expect(orderStatus).toHaveBeenCalledTimes(1)
    expect(fills).toHaveBeenCalledTimes(2)
  })

  it('continues to later orders after one order lookup fails', async () => {
    const logs: string[] = []
    const h = await liveHarness(true, logs)
    await placeIoc(BTC)
    h.clock.advance(11_000)
    await placeIoc(ETH)
    const orderStatus = vi.spyOn(h.live, 'orderStatus')
      .mockRejectedValueOnce(new Error('synthetic lookup failure'))
      .mockResolvedValue({ found: false })
    const fills = vi.spyOn(h.live, 'fills').mockResolvedValue([])

    await h.k.tickOnce()
    await awaitLivePoll(h)

    expect(orderStatus).toHaveBeenCalledTimes(2)
    expect(fills).toHaveBeenCalledTimes(2)
    expect(logs.join('')).not.toContain('synthetic lookup failure')
  })

  it('keeps scheduled steps moving while an order lookup never settles', async () => {
    const h = await liveHarness()
    await placeIoc(BTC)
    const pending = deferred<{ found: boolean; status?: string; venueOrderId?: string }>()
    const orderStatus = vi.spyOn(h.live, 'orderStatus').mockImplementation(() => pending.promise)
    const agentsTick = vi.spyOn(h.k.agents, 'tick')
    const deadmanTick = vi.spyOn(h.k.deadman, 'tick')
    const firstTick = h.k.tickOnce()
    await vi.waitFor(() => expect(orderStatus).toHaveBeenCalledTimes(1))

    const nextTick = h.k.tickOnce()
    await withinOneSecond(nextTick)
    await withinOneSecond(firstTick)

    expect(agentsTick).toHaveBeenCalledTimes(2)
    expect(deadmanTick).toHaveBeenCalledTimes(2)
    expect(orderStatus).toHaveBeenCalledTimes(1)
    await withinOneSecond(h.k.stop())
  })

  it('waits five seconds per account and does not overlap an in-flight poll', async () => {
    const h = await liveHarness()
    await placeIoc(BTC)
    const pending = deferred<VenueFill[]>()
    const fills = vi.spyOn(h.live, 'fills').mockImplementation(() => pending.promise)
    const firstTick = h.k.tickOnce()
    await vi.waitFor(() => expect(fills).toHaveBeenCalledTimes(1))

    await h.k.tickOnce()
    expect(fills).toHaveBeenCalledTimes(1)
    pending.resolve([])
    await firstTick
    await awaitLivePoll(h)
    h.clock.advance(4_999)
    await h.k.tickOnce()
    await awaitLivePoll(h)
    expect(fills).toHaveBeenCalledTimes(1)
    h.clock.advance(1)
    await h.k.tickOnce()
    await awaitLivePoll(h)
    expect(fills).toHaveBeenCalledTimes(2)
  })

  it('does not poll accounts without pollOrders registration', async () => {
    const h = await liveHarness(false)
    await placeIoc(BTC)
    const fills = vi.spyOn(h.live, 'fills')
    const orderStatus = vi.spyOn(h.live, 'orderStatus')
    const paperFills = vi.spyOn(h.sim, 'fills')

    await h.k.tickOnce()

    expect(fills).not.toHaveBeenCalled()
    expect(orderStatus).not.toHaveBeenCalled()
    expect(paperFills).not.toHaveBeenCalled()
  })

  it('does not request venue orders or fills when the polling order list is empty', async () => {
    const h = await liveHarness()
    const fills = vi.spyOn(h.live, 'fills')
    const orderStatus = vi.spyOn(h.live, 'orderStatus')
    await h.k.tickOnce()
    expect(fills).not.toHaveBeenCalled()
    expect(orderStatus).not.toHaveBeenCalled()
  })

  it('uses the five-second snapshot age only for registered live polling accounts', async () => {
    const h = await liveHarness()
    await placeIoc(BTC)
    const snapshot = vi.spyOn(h.k.bus, 'snapshot')
    await h.k.tickOnce()
    expect(snapshot).toHaveBeenCalledWith(h.liveAcct, { maxAgeMs: 5_000 })
    expect(snapshot).toHaveBeenCalledWith(h.paper, { maxAgeMs: 1_000 })
  })

  it('does not advance a cursor after failure or empty results, then resumes without moving it backward', async () => {
    const logs: string[] = []
    const h = await liveHarness(true, logs)
    const order = await placeIoc(BTC)
    const sinceValues: number[] = []
    let response: VenueFill[] | Error = new Error('synthetic upstream failure')
    const fills = vi.spyOn(h.live as VenueConnector, 'fills').mockImplementation(async (_ref, since) => {
      sinceValues.push(since)
      if (response instanceof Error) throw response
      return response
    })
    const firstBase = h.clock.now() - 24 * 60 * 60 * 1000

    await h.k.tickOnce()
    await awaitLivePoll(h)
    expect(logs.join('')).not.toContain('synthetic upstream failure')
    h.clock.advance(5_000)
    response = []
    const secondBase = h.clock.now() - 24 * 60 * 60 * 1000
    await h.k.tickOnce()
    await awaitLivePoll(h)
    expect(sinceValues).toEqual([firstBase, secondBase])

    h.clock.advance(5_000)
    const highTs = h.clock.now() - 100
    response = [fill(order, 'cursor-high', highTs, '0.0001')]
    const thirdBase = h.clock.now() - 24 * 60 * 60 * 1000
    await h.k.tickOnce()
    await awaitLivePoll(h)
    expect(sinceValues[2]).toBe(thirdBase)

    h.clock.advance(5_000)
    response = [fill(order, 'cursor-lower', highTs - 5_000, '0.0001')]
    const cursorSince = highTs - 1_000
    await h.k.tickOnce()
    await awaitLivePoll(h)
    expect(sinceValues[3]).toBe(cursorSince)

    h.clock.advance(5_000)
    response = []
    await h.k.tickOnce()
    await awaitLivePoll(h)
    expect(sinceValues[4]).toBe(cursorSince)
    expect(fills).toHaveBeenCalledTimes(5)
  })

  it('aborts a pending fill poll during stop without applying its late result', async () => {
    const h = await liveHarness()
    const order = await placeIoc(BTC)
    h.clock.advance(11_000)
    await placeIoc(ETH)
    const pending = deferred<VenueFill[]>()
    const fills = vi.spyOn(h.live, 'fills').mockImplementation(() => pending.promise)
    const pollFills = vi.spyOn(h.k.bus, 'pollFills')
    const events: string[] = []
    h.k.events.subscribe('account.fills', () => events.push('fill'))
    const tick = h.k.tickOnce()
    await vi.waitFor(() => expect(fills).toHaveBeenCalledTimes(1))

    expect(h.k.orders.get(order.orderId)?.status).toBe('open')
    await h.k.stop()
    pending.resolve([fill(order, 'late-after-stop')])
    await tick
    await awaitLivePoll(h)

    expect(events).toEqual([])
    expect(fills).toHaveBeenCalledTimes(1)
    expect(pollFills.mock.calls[0]?.[2]?.signal?.aborted).toBe(true)
  })

  it('aborts a pending order lookup during stop before requesting fills', async () => {
    const h = await liveHarness()
    const order = await placeIoc(BTC)
    h.clock.advance(11_000)
    await placeIoc(BTC)
    const pending = deferred<{ found: boolean; status?: string; venueOrderId?: string }>()
    const orderStatus = vi.spyOn(h.live, 'orderStatus').mockImplementation(() => pending.promise)
    const fills = vi.spyOn(h.live, 'fills')
    const tick = h.k.tickOnce()
    await vi.waitFor(() => expect(orderStatus).toHaveBeenCalledTimes(1))

    expect(h.k.orders.get(order.orderId)?.status).toBe('open')
    await h.k.stop()
    pending.resolve({ found: true, status: 'cancelled', venueOrderId: order.venueOrderId! })
    await tick
    await awaitLivePoll(h)

    expect(fills).not.toHaveBeenCalled()
    expect(orderStatus).toHaveBeenCalledTimes(1)
  })

  it('paces each account from its actual request start after a preceding account stalls', async () => {
    const h = await liveHarnessWithSecondAccount()
    const second = h.k.accounts.find('live-b')
    expect(second).toBeDefined()
    for (const accountId of [h.liveAcct.accountId, second!.accountId]) {
      await placeIocForAccount(accountId)
      h.clock.advance(11_000)
    }

    const pending = deferred<VenueFill[]>()
    const calls: { accountId: string; at: number }[] = []
    vi.spyOn(h.live as VenueConnector, 'fills').mockImplementation((ref) => {
      calls.push({ accountId: ref.accountId, at: h.clock.now() })
      return calls.length === 1 ? pending.promise : Promise.resolve([])
    })

    const firstTick = h.k.tickOnce()
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    const initialTime = calls[0]!.at
    h.clock.advance(6_000)
    pending.resolve([])
    await firstTick
    await awaitLivePoll(h)
    expect(calls).toHaveLength(2)
    expect(calls[0]!.accountId).not.toBe(calls[1]!.accountId)
    expect(calls.map((call) => call.at - initialTime)).toEqual([0, 6_000])

    await h.k.tickOnce()
    await awaitLivePoll(h)
    expect(calls.filter((call) => call.accountId === calls[1]!.accountId)).toHaveLength(1)
  })

  it('advances the late-starting account cursor for its actual fill timestamp', async () => {
    const h = await liveHarnessWithSecondAccount()
    const second = h.k.accounts.find('live-b')
    expect(second).toBeDefined()
    let secondOrder: Order | undefined
    for (const accountId of [h.liveAcct.accountId, second!.accountId]) {
      const order = await placeIocForAccount(accountId)
      if (accountId === second!.accountId) secondOrder = order
      h.clock.advance(11_000)
    }
    expect(secondOrder).toBeDefined()

    const pending = deferred<VenueFill[]>()
    let firstStarted = false
    let fillTs: number | undefined
    const secondSince: number[] = []
    const lateFill = fill(secondOrder!, 'late-account-fill', 0, '0.0001')
    vi.spyOn(h.live as VenueConnector, 'fills').mockImplementation((ref, sinceMs) => {
      if (ref.accountId === h.liveAcct.accountId && fillTs === undefined) {
        firstStarted = true
        return pending.promise
      }
      if (ref.accountId === second!.accountId) {
        secondSince.push(sinceMs)
        if (fillTs === undefined) {
          fillTs = h.clock.now()
          return Promise.resolve([{ ...lateFill, ts: fillTs } as VenueFill])
        }
      }
      return Promise.resolve([])
    })
    const accountFillEvents: unknown[] = []
    h.k.events.subscribe('account.fills', (event) => accountFillEvents.push(event))

    const firstTick = h.k.tickOnce()
    await vi.waitFor(() => expect(firstStarted).toBe(true))
    h.clock.advance(6_000)
    pending.resolve([])
    await firstTick
    await awaitLivePoll(h)
    expect(fillTs).toBe(h.clock.now())
    expect(accountFillEvents).toHaveLength(1)

    h.clock.advance(5_000)
    await h.k.tickOnce()
    await awaitLivePoll(h)
    expect(secondSince).toHaveLength(2)
    expect(secondSince[1]).toBe(fillTs! - 1_000)
  })

  it('uses response time when a single account fill arrives during a pending request', async () => {
    const h = await liveHarness()
    const order = await placeIoc(BTC)
    const pending = deferred<VenueFill[]>()
    const sinceValues: number[] = []
    vi.spyOn(h.live as VenueConnector, 'fills').mockImplementation(async (_ref, sinceMs) => {
      sinceValues.push(sinceMs)
      if (sinceValues.length === 1) return pending.promise
      return []
    })

    const firstTick = h.k.tickOnce()
    await vi.waitFor(() => expect(sinceValues).toHaveLength(1))
    h.clock.advance(6_000)
    const fillTs = h.clock.now()
    pending.resolve([fill(order, 'during-poll-fill', fillTs, '0.0001')])
    await firstTick
    await awaitLivePoll(h)

    h.clock.advance(5_000)
    await h.k.tickOnce()
    await awaitLivePoll(h)
    expect(sinceValues).toHaveLength(2)
    expect(sinceValues[1]).toBe(fillTs - 1_000)
  })
})
