// SPDX-License-Identifier: CPAL-1.0
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { VenueFill } from '@gitrader/protocol/connector'
import { BTC } from './helpers/fake-connector'
import { makeHarness } from './helpers/harness'

describe('ConnectorBus polling fills and lookup cancellation', () => {
  let cleanup: (() => Promise<void>) | undefined
  afterEach(async () => { await cleanup?.(); cleanup = undefined })

  it('routes poll fills through the bus with the selected account and instrument', async () => {
    const h = await makeHarness()
    cleanup = h.cleanup
    const fill = {
      venueOrderId: 'venue-order-1', clientOrderId: 'client-order-1', venueFillId: 'fill-1', instrumentId: BTC,
      side: 'buy', price: '80000', size: '0.01', fee: '0.1', feeCcy: 'USDC', liquidity: 'taker', realizedPnl: '0', ts: 500,
    } as VenueFill
    const returned = [fill]
    const fills = vi.spyOn(h.live, 'fills').mockResolvedValue(returned)
    const events: unknown[] = []
    h.k.bus.onEvent((venue, event) => events.push({ venue, event }))

    const result = await h.k.bus.pollFills(h.liveAcct, 123, { instrumentId: BTC })
    expect(fills).toHaveBeenCalledWith(expect.anything(), 123, { instrumentId: BTC })
    expect(result).toBe(returned)
    expect(events).toEqual([{ venue: 'hyperliquid', event: { type: 'fill', accountId: h.liveAcct.accountId, fill } }])
  })

  it('returns no request or event when already aborted, and returns fills without emitting after late abort', async () => {
    const h = await makeHarness()
    cleanup = h.cleanup
    const controller = new AbortController()
    const fills = vi.spyOn(h.live, 'fills')
    const events: unknown[] = []
    h.k.bus.onEvent((_venue, event) => events.push(event))

    controller.abort()
    expect(await h.k.bus.pollFills(h.liveAcct, 100, { instrumentId: BTC, signal: controller.signal })).toEqual([])
    expect(fills).not.toHaveBeenCalled()

    const late = new AbortController()
    let resolveFills!: (value: VenueFill[]) => void
    const returned = [
      { venueOrderId: 'venue-order-2', clientOrderId: 'client-order-2', venueFillId: 'fill-2', instrumentId: BTC, side: 'buy', price: '1', size: '1', fee: '0', feeCcy: 'USDC', liquidity: 'taker', realizedPnl: '0', ts: 600 } as VenueFill,
    ]
    fills.mockImplementation(() => new Promise((resolve) => { resolveFills = resolve }))
    const pending = h.k.bus.pollFills(h.liveAcct, 200, { instrumentId: BTC, signal: late.signal })
    await vi.waitFor(() => expect(fills).toHaveBeenCalledTimes(1))
    late.abort()
    resolveFills(returned)
    expect(await pending).toBe(returned)
    expect(events).toEqual([])
  })

  it('does not request order status when lookup is already aborted', async () => {
    const h = await makeHarness()
    cleanup = h.cleanup
    const controller = new AbortController()
    const orderStatus = vi.spyOn(h.live, 'orderStatus')
    const onUnknown = vi.fn()
    const onQueried = vi.fn()
    h.k.bus.setOrderStatusCallbacks(onUnknown, onQueried)
    controller.abort()

    expect(await h.k.bus.lookup(h.liveAcct, 'client-order', { signal: controller.signal })).toBeNull()
    expect(orderStatus).not.toHaveBeenCalled()
    expect(onUnknown).not.toHaveBeenCalled()
    expect(onQueried).not.toHaveBeenCalled()
  })

  it('discards a late order-status response before status callbacks when aborted', async () => {
    const h = await makeHarness()
    cleanup = h.cleanup
    const controller = new AbortController()
    let resolveStatus!: (value: { found: boolean; status?: string; venueOrderId?: string }) => void
    vi.spyOn(h.live, 'orderStatus').mockImplementation(() => new Promise((resolve) => { resolveStatus = resolve }) as never)
    const onUnknown = vi.fn()
    const onQueried = vi.fn()
    h.k.bus.setOrderStatusCallbacks(onUnknown, onQueried)

    const pending = h.k.bus.lookup(h.liveAcct, 'client-order', { signal: controller.signal })
    await vi.waitFor(() => expect(resolveStatus).toBeTypeOf('function'))
    controller.abort()
    resolveStatus({ found: true, status: 'unknown-status', venueOrderId: 'venue-order' })
    expect(await pending).toBeNull()
    expect(onUnknown).not.toHaveBeenCalled()
    expect(onQueried).not.toHaveBeenCalled()
  })

  it('discards fills returned after lookup aborts and invokes neither order callback', async () => {
    const h = await makeHarness()
    cleanup = h.cleanup
    const controller = new AbortController()
    vi.spyOn(h.live, 'orderStatus').mockResolvedValue({ found: true, status: 'open', venueOrderId: 'venue-order' })
    let resolveFills!: (value: VenueFill[]) => void
    vi.spyOn(h.live, 'fills').mockImplementation(() => new Promise((resolve) => { resolveFills = resolve }))
    const events: unknown[] = []
    h.k.bus.onEvent((_venue, event) => events.push(event))
    const onUnknown = vi.fn()
    const onQueried = vi.fn()
    h.k.bus.setOrderStatusCallbacks(onUnknown, onQueried)

    const pending = h.k.bus.lookup(h.liveAcct, 'client-order', { instrumentId: BTC, venueOrderId: 'venue-order', sinceMs: 10, signal: controller.signal })
    await vi.waitFor(() => expect(resolveFills).toBeTypeOf('function'))
    controller.abort()
    resolveFills([{ venueOrderId: 'venue-order', clientOrderId: 'client-order', venueFillId: 'fill-late', instrumentId: BTC, side: 'buy', price: '1', size: '1', fee: '0', feeCcy: 'USDC', liquidity: 'taker', realizedPnl: '0', ts: 500 } as VenueFill])
    expect(await pending).toBeNull()
    expect(events).toEqual([])
    expect(onUnknown).not.toHaveBeenCalled()
    expect(onQueried).not.toHaveBeenCalled()
  })

  it('stops before the next poll fill event after a subscriber aborts and returns the original list', async () => {
    const h = await makeHarness()
    cleanup = h.cleanup
    const controller = new AbortController()
    const returned = [
      { venueOrderId: 'venue-poll-batch', clientOrderId: 'client-poll-batch', venueFillId: 'poll-first', instrumentId: BTC, side: 'buy', price: '1', size: '1', fee: '0', feeCcy: 'USDC', liquidity: 'taker', realizedPnl: '0', ts: 700 } as VenueFill,
      { venueOrderId: 'venue-poll-batch', clientOrderId: 'client-poll-batch', venueFillId: 'poll-second', instrumentId: BTC, side: 'buy', price: '1', size: '1', fee: '0', feeCcy: 'USDC', liquidity: 'taker', realizedPnl: '0', ts: 701 } as VenueFill,
    ]
    vi.spyOn(h.live, 'fills').mockResolvedValue(returned)
    const eventIds: string[] = []
    h.k.bus.onEvent((_venue, event) => {
      if (event.type === 'fill') {
        eventIds.push(event.fill.venueFillId)
        controller.abort()
      }
    })

    const actual = await h.k.bus.pollFills(h.liveAcct, 100, { instrumentId: BTC, signal: controller.signal })
    expect(actual).toBe(returned)
    expect(eventIds).toEqual(['poll-first'])
  })

  it('stops lookup fill emission after subscriber abort and skips the queried-order callback', async () => {
    const h = await makeHarness()
    cleanup = h.cleanup
    const controller = new AbortController()
    vi.spyOn(h.live, 'orderStatus').mockResolvedValue({ found: true, status: 'open', venueOrderId: 'venue-lookup-batch' })
    vi.spyOn(h.live, 'fills').mockResolvedValue([
      { venueOrderId: 'venue-lookup-batch', clientOrderId: 'client-lookup-batch', venueFillId: 'lookup-first', instrumentId: BTC, side: 'buy', price: '1', size: '1', fee: '0', feeCcy: 'USDC', liquidity: 'taker', realizedPnl: '0', ts: 800 } as VenueFill,
      { venueOrderId: 'venue-lookup-batch', clientOrderId: 'client-lookup-batch', venueFillId: 'lookup-second', instrumentId: BTC, side: 'buy', price: '1', size: '1', fee: '0', feeCcy: 'USDC', liquidity: 'taker', realizedPnl: '0', ts: 801 } as VenueFill,
    ])
    const eventIds: string[] = []
    h.k.bus.onEvent((_venue, event) => {
      if (event.type === 'fill') {
        eventIds.push(event.fill.venueFillId)
        controller.abort()
      }
    })
    const onUnknown = vi.fn()
    const onQueried = vi.fn()
    h.k.bus.setOrderStatusCallbacks(onUnknown, onQueried)

    const actual = await h.k.bus.lookup(h.liveAcct, 'client-lookup-batch', { instrumentId: BTC, venueOrderId: 'venue-lookup-batch', sinceMs: 100, signal: controller.signal })
    expect(actual).toBeNull()
    expect(eventIds).toEqual(['lookup-first'])
    expect(onUnknown).not.toHaveBeenCalled()
    expect(onQueried).not.toHaveBeenCalled()
  })
})
