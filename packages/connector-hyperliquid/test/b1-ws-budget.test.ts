// SPDX-License-Identifier: CPAL-1.0
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HlWsClient } from '../src/ws'
import type { HlWsOptions } from '../src/ws'
import { HlWsSendBudget } from '../src/ws-budget'
import { FakeWebSocket, FakeWS } from './helpers/fake-hl'

class TestWindowBudget {
  private readonly sentAt: number[] = []
  constructor(private readonly clock: () => number, private readonly limit: number, private readonly windowMs: number) {}
  tryAcquire(): boolean {
    const now = this.clock()
    while (this.sentAt.length > 0 && this.sentAt[0]! <= now - this.windowMs) this.sentAt.shift()
    if (this.sentAt.length >= this.limit) return false
    this.sentAt.push(now)
    return true
  }
  remainingWaitMs(): number {
    const now = this.clock()
    while (this.sentAt.length > 0 && this.sentAt[0]! <= now - this.windowMs) this.sentAt.shift()
    return this.sentAt.length < this.limit ? 0 : Math.max(0, this.sentAt[0]! + this.windowMs - now)
  }
}

function client(budget: TestWindowBudget, now: { value: number }, overrides: Partial<HlWsOptions> = {}) {
  const options = {
    url: 'wss://unit.test/socket', WebSocketImpl: FakeWS, clock: () => now.value,
    sendBudget: budget, onMessage: () => {}, pingMs: 120_000, staleMs: 180_000,
    backoffBaseMs: 1, backoffMaxMs: 1, ...overrides,
  } as HlWsOptions
  const instance = new HlWsClient(options)
  instance.start()
  const socket = FakeWebSocket.last
  socket.open()
  return { instance, socket }
}

afterEach(() => {
  vi.useRealTimers()
  FakeWebSocket.reset()
})

describe('Hyperliquid websocket send budget', () => {
  it('releases a slot at the exact sliding-window boundary', () => {
    let now = 10
    const budget = new HlWsSendBudget({ clock: () => now, limit: 2, windowMs: 100 })
    expect(budget.tryAcquire()).toBe(true)
    expect(budget.tryAcquire()).toBe(true)
    expect(budget.tryAcquire()).toBe(false)
    expect(budget.remainingWaitMs()).toBe(100)
    now = 109
    expect(budget.remainingWaitMs()).toBe(1)
    now = 110
    expect(budget.tryAcquire()).toBe(true)
  })

  it('shares a sliding window across clients and delays send 2001 until the boundary', () => {
    vi.useFakeTimers()
    const now = { value: 0 }
    const budget = new TestWindowBudget(() => now.value, 2000, 60_000)
    const a = client(budget, now)
    const b = client(budget, now)
    for (let i = 0; i < 1000; i++) a.instance.subscribe({ channel: 'orders', id: `a-${i}` })
    for (let i = 0; i < 1000; i++) b.instance.subscribe({ channel: 'orders', id: `b-${i}` })
    a.instance.subscribe({ channel: 'orders', id: 'delayed' })
    expect(a.socket.sent.length + b.socket.sent.length).toBe(2000)
    now.value = 60_000
    vi.advanceTimersByTime(60_000)
    expect(a.socket.sent.length + b.socket.sent.length).toBe(2001)
    a.instance.stop()
    b.instance.stop()
  })

  it('counts unsubscription sends and drops a queued subscription canceled before flush', () => {
    vi.useFakeTimers()
    const now = { value: 0 }
    const budget = new TestWindowBudget(() => now.value, 1, 1000)
    const { instance, socket } = client(budget, now)
    const sent = { channel: 'orders', id: 'sent' }
    const canceled = { channel: 'orders', id: 'canceled-before-send' }
    instance.subscribe(sent)
    instance.subscribe(canceled)
    instance.unsubscribe(canceled)
    instance.unsubscribe(sent)
    expect(socket.sent).toEqual([{ method: 'subscribe', subscription: sent }])
    now.value = 1000
    vi.advanceTimersByTime(1000)
    expect(socket.sent).toEqual([
      { method: 'subscribe', subscription: sent },
      { method: 'unsubscribe', subscription: sent },
    ])
    instance.stop()
  })

  it('queues ping behind the same send budget', () => {
    vi.useFakeTimers()
    const now = { value: 0 }
    const budget = new TestWindowBudget(() => now.value, 1, 1000)
    const { instance, socket } = client(budget, now, { pingMs: 10, staleMs: 100_000 })
    instance.subscribe({ channel: 'orders', id: 'first' })
    vi.advanceTimersByTime(10)
    expect(socket.sent).toHaveLength(1)
    now.value = 1000
    vi.advanceTimersByTime(1000)
    expect(socket.sent[1]).toEqual({ method: 'ping' })
    instance.stop()
  })

  it('clears queued sends and the flush timer on stop', () => {
    vi.useFakeTimers()
    const now = { value: 0 }
    const budget = new TestWindowBudget(() => now.value, 1, 1000)
    const { instance, socket } = client(budget, now)
    instance.subscribe({ channel: 'orders', id: 'sent' })
    instance.subscribe({ channel: 'orders', id: 'queued' })
    instance.stop()
    now.value = 1000
    vi.advanceTimersByTime(1000)
    expect(socket.sent).toHaveLength(1)
    expect(socket.readyState).toBe(3)
  })

  it('clears the old socket queue on disconnect and resubscribes only the current set', () => {
    vi.useFakeTimers()
    const now = { value: 0 }
    const budget = new TestWindowBudget(() => now.value, 1, 1000)
    const received: unknown[] = []
    const options = {
      url: 'wss://unit.test/socket', WebSocketImpl: FakeWS, clock: () => now.value,
      sendBudget: budget, onMessage: (message: unknown) => received.push(message), pingMs: 120_000, staleMs: 180_000,
      backoffBaseMs: 1000, backoffMaxMs: 1000,
    } as unknown as HlWsOptions
    const instance = new HlWsClient(options)
    instance.start()
    const oldSocket = FakeWebSocket.last
    oldSocket.open()
    const current = { channel: 'orders', id: 'current' }
    instance.subscribe({ channel: 'orders', id: 'removed' })
    instance.subscribe(current)
    instance.unsubscribe({ channel: 'orders', id: 'removed' })
    oldSocket.drop()
    oldSocket.push({ channel: 'orders', data: { stale: true } })
    expect(received).toHaveLength(0)
    now.value = 1000
    vi.advanceTimersByTime(1000)
    const newSocket = FakeWebSocket.last
    expect(newSocket).not.toBe(oldSocket)
    newSocket.open()
    expect(newSocket.subs()).toEqual([current])
    expect(newSocket.sent.some((message) => message.subscription?.id === 'removed')).toBe(false)
    instance.stop()
  })
})

describe('Hyperliquid websocket stale threshold', () => {
  it('keeps the default live through the 30-second ping and marks stale at 45 seconds', () => {
    vi.useFakeTimers()
    let now = 0
    const down: string[] = []
    const instance = new HlWsClient({
      url: 'wss://unit.test/socket', WebSocketImpl: FakeWS, clock: () => now,
      onMessage: () => {}, onDown: (reason) => down.push(reason),
    })
    instance.start()
    const socket = FakeWebSocket.last
    socket.open()
    now = 30_000
    vi.advanceTimersByTime(30_000)
    expect(socket.sent).toContainEqual({ method: 'ping' })
    expect(down).toEqual([])
    now = 44_999
    vi.advanceTimersByTime(14_999)
    expect(down).toEqual([])
    now = 45_000
    vi.advanceTimersByTime(1)
    expect(down).toEqual(['stale'])
    instance.stop()
  })

  it('respects an explicit stale threshold', () => {
    vi.useFakeTimers()
    let now = 0
    const down: string[] = []
    const instance = new HlWsClient({
      url: 'wss://unit.test/socket', WebSocketImpl: FakeWS, clock: () => now,
      onMessage: () => {}, onDown: (reason) => down.push(reason), pingMs: 30_000, staleMs: 10_000,
    })
    instance.start()
    FakeWebSocket.last.open()
    now = 10_000
    vi.advanceTimersByTime(10_000)
    expect(down).toEqual(['stale'])
    instance.stop()
  })

  it('extends the default stale threshold to fifteen seconds beyond a longer ping interval', () => {
    vi.useFakeTimers()
    let now = 0
    const down: string[] = []
    const instance = new HlWsClient({
      url: 'wss://unit.test/socket', WebSocketImpl: FakeWS, clock: () => now,
      onMessage: () => {}, onDown: (reason) => down.push(reason), pingMs: 60_000,
    })
    instance.start()
    FakeWebSocket.last.open()
    now = 74_999
    vi.advanceTimersByTime(74_999)
    expect(down).toEqual([])
    now = 75_000
    vi.advanceTimersByTime(1)
    expect(down).toEqual(['stale'])
    instance.stop()
  })
})
