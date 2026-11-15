// SPDX-License-Identifier: CPAL-1.0
import { describe, expect, it } from 'vitest'
import { asDecimal } from '@gitrader/protocol'
import { OkxTradeConnector } from '../src/connector'
import { normalizeUserEvents } from '../src/parse'
import { openPrivateStream, WS_PRIVATE_BASE } from '../src/ws'
import type { OkxUserEvent } from '../src/parse'
import type { SocketLike, SocketMessageEvent } from '../src/ws'
import { API_KEY, API_SECRET, BASE_URL, FakeOkxTrade, NOW, PASSPHRASE } from './helpers/fake-okx-trade'

class FakeSocket implements SocketLike {
  sent: string[] = []
  closed = false
  closeCount = 0
  onmessage: ((ev: SocketMessageEvent) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  onclose: ((ev: unknown) => void) | null = null

  constructor(readonly url: string) {}
  send(data: string): void { this.sent.push(data) }
  close(): void {
    this.closeCount++
    this.closed = true
    this.onclose?.({})
  }
  push(frame: unknown): void {
    this.onmessage?.({ data: typeof frame === 'string' ? frame : JSON.stringify(frame) })
  }
  remoteClose(): void {
    this.closed = true
    this.onclose?.({})
  }
}

function makeConnector(factory: (url: string) => SocketLike, events: OkxUserEvent[] = []) {
  const fake = new FakeOkxTrade()
  return new OkxTradeConnector({
    apiKey: API_KEY,
    apiSecret: API_SECRET,
    passphrase: PASSPHRASE,
    baseUrl: BASE_URL,
    fetchImpl: fake.fetch,
    clock: () => NOW,
    onWarn: () => {},
    socketFactory: factory,
    onUserEvent: (event) => events.push(event),
  })
}

describe('OKX business private stream wiring', () => {
  it('opens the product default on private and business, and subscribes each after code-zero login', () => {
    const sockets: FakeSocket[] = []
    const events: OkxUserEvent[] = []
    const connector = makeConnector((url) => {
      const socket = new FakeSocket(url)
      sockets.push(socket)
      return socket
    }, events)
    const handle = connector.openUserStream()
    expect(sockets.map((socket) => socket.url)).toEqual([
      WS_PRIVATE_BASE.mainnet,
      WS_PRIVATE_BASE.mainnet.replace(/\/private$/, '/business'),
    ])
    expect(sockets.map((socket) => JSON.parse(socket.sent[0]!).op)).toEqual(['login', 'login'])
    expect(handle.loggedIn()).toBeNull()
    sockets[0]!.push({ event: 'login', code: '0' })
    expect(handle.loggedIn()).toBeNull()
    sockets[1]!.push({ event: 'login', code: '0' })
    expect(handle.loggedIn()).toBe(true)
    expect(JSON.parse(sockets[0]!.sent[1]!)).toEqual({ op: 'subscribe', args: [
      { channel: 'orders', instType: 'SWAP' }, { channel: 'positions', instType: 'SWAP' }, { channel: 'account', instType: 'SWAP' },
    ] })
    expect(JSON.parse(sockets[1]!.sent[1]!)).toEqual({ op: 'subscribe', args: [
      { channel: 'orders-algo', instType: 'SWAP' }, { channel: 'algo-advance', instType: 'SWAP' },
    ] })
    sockets[1]!.push({ arg: { channel: 'algo-advance' }, data: [{ instId: 'BTC-USDT-SWAP', algoId: '7001', state: 'effective', actualSz: '2', actualPx: '100.5' }] })
    expect(events).toContainEqual(expect.objectContaining({
      kind: 'order', channel: 'orders-algo', venueOrderId: '7001', status: 'open', filledContracts: '0', fillContracts: '0',
    }))
    expect(events.filter((event) => event.kind === 'login')).toHaveLength(2)
    expect(handle.sent()).toHaveLength(4)
    expect(handle.sent().join('\n')).not.toContain(API_KEY)
    expect(handle.sent().join('\n')).not.toContain(API_SECRET)
  })

  it('keeps explicit private-only subscriptions on one private socket', () => {
    const sockets: FakeSocket[] = []
    const connector = makeConnector((url) => {
      const socket = new FakeSocket(url)
      sockets.push(socket)
      return socket
    })
    const handle = connector.openUserStream({ channels: ['orders', 'account'] })
    expect(sockets).toHaveLength(1)
    expect(handle.url).toBe(WS_PRIVATE_BASE.mainnet)
    sockets[0]!.push({ event: 'login', success: true })
    expect(JSON.parse(sockets[0]!.sent[1]!)).toEqual({ op: 'subscribe', args: [
      { channel: 'orders', instType: 'SWAP' }, { channel: 'account', instType: 'SWAP' },
    ] })
  })

  it('keeps the low-level default at three private channels and deduplicates the advanced alias', () => {
    const sockets: FakeSocket[] = []
    openPrivateStream({
      factory: (url) => { const socket = new FakeSocket(url); sockets.push(socket); return socket },
      apiKey: API_KEY, apiSecret: API_SECRET, passphrase: PASSPHRASE, clock: () => NOW, onEvent: () => {},
    })
    expect(sockets).toHaveLength(1)
    sockets[0]!.push({ event: 'login', success: true })
    expect(JSON.parse(sockets[0]!.sent[1]!)).toEqual({ op: 'subscribe', args: [
      { channel: 'orders', instType: 'SWAP' }, { channel: 'positions', instType: 'SWAP' }, { channel: 'account', instType: 'SWAP' },
    ] })

    const businessSockets: FakeSocket[] = []
    const business = openPrivateStream({
      factory: (url) => { const socket = new FakeSocket(url); businessSockets.push(socket); return socket },
      channels: ['advance-algo-orders', 'algo-advance'], apiKey: API_KEY, apiSecret: API_SECRET,
      passphrase: PASSPHRASE, clock: () => NOW, onEvent: () => {},
    })
    expect(business.url).toBe(WS_PRIVATE_BASE.mainnet.replace(/\/private$/, '/business'))
    expect(businessSockets).toHaveLength(1)
    businessSockets[0]!.push({ event: 'login', code: '0' })
    expect(JSON.parse(businessSockets[0]!.sent[1]!)).toEqual({ op: 'subscribe', args: [
      { channel: 'algo-advance', instType: 'SWAP' },
    ] })
  })

  it('does not subscribe on a failed business login even when another socket logged in', () => {
    const sockets: FakeSocket[] = []
    const connector = makeConnector((url) => {
      const socket = new FakeSocket(url)
      sockets.push(socket)
      return socket
    })
    const handle = connector.openUserStream()
    sockets[0]!.push({ event: 'login', code: '0' })
    sockets[1]!.push({ event: 'login', code: '60009', success: true })
    expect(handle.loggedIn()).toBe(false)
    expect(sockets[0]!.sent).toHaveLength(2)
    expect(sockets[1]!.sent).toHaveLength(1)
  })

  it('aggregates ping, close, and remote closure across both sockets exactly once', () => {
    const sockets: FakeSocket[] = []
    let onCloseCount = 0
    const handle = openPrivateStream({
      factory: (url) => { const socket = new FakeSocket(url); sockets.push(socket); return socket },
      channels: ['orders', 'positions', 'account', 'orders-algo', 'algo-advance'],
      apiKey: API_KEY, apiSecret: API_SECRET, passphrase: PASSPHRASE, clock: () => NOW,
      onEvent: () => {}, onClose: () => { onCloseCount++ },
    })
    handle.ping()
    expect(sockets.map((socket) => socket.sent.includes('ping'))).toEqual([true, true])
    handle.close()
    handle.close()
    expect(sockets.map((socket) => socket.closeCount)).toEqual([1, 1])
    expect(handle.state()).toBe('closed')
    expect(onCloseCount).toBe(1)

    const remoteSockets: FakeSocket[] = []
    let remoteOnCloseCount = 0
    const remote = openPrivateStream({
      factory: (url) => { const socket = new FakeSocket(url); remoteSockets.push(socket); return socket },
      channels: ['orders', 'orders-algo'], apiKey: API_KEY, apiSecret: API_SECRET, passphrase: PASSPHRASE,
      clock: () => NOW, onEvent: () => {}, onClose: () => { remoteOnCloseCount++ },
    })
    remoteSockets[1]!.remoteClose()
    expect(remoteSockets.every((socket) => socket.closed)).toBe(true)
    expect(remote.state()).toBe('closed')
    expect(remoteOnCloseCount).toBe(1)
  })

  it('closes an already-created socket if opening the second stream throws', () => {
    const first = new FakeSocket(WS_PRIVATE_BASE.mainnet)
    let calls = 0
    expect(() => openPrivateStream({
      factory: () => {
        calls++
        if (calls === 2) throw new Error('socket setup failed')
        return first
      },
      channels: ['orders', 'orders-algo'], apiKey: API_KEY, apiSecret: API_SECRET, passphrase: PASSPHRASE,
      clock: () => NOW, onEvent: () => {},
    })).toThrow('socket setup failed')
    expect(first.closed).toBe(true)
  })
})

describe('OKX advanced algo event normalization', () => {
  it('maps the official channel and states without treating actual child size or price as a fill', () => {
    const frame = {
      arg: { channel: 'algo-advance', instType: 'SWAP' },
      data: [{ instId: 'BTC-USDT-SWAP', algoId: '7001', algoClOrdId: 'algo-client', state: 'effective',
        actualSz: '2', actualPx: '100.5', uTime: '300', pTime: '200', cTime: '100' }],
    }
    const [event] = normalizeUserEvents(frame, () => asDecimal('0.01'), NOW)!
    expect(event).toMatchObject({
      kind: 'order', channel: 'orders-algo', venueOrderId: '7001', clientOrderId: 'algo-client',
      state: 'effective', status: 'open', filledContracts: '0', fillContracts: '0',
      filledBase: '0', fillBase: '0', avgPrice: null, fillPrice: null, ts: 300,
    })
    if (event?.kind !== 'order') throw new Error('expected order event')
    expect(event.raw).toMatchObject({ actualSz: '2', actualPx: '100.5' })
  })

  it('uses pTime before cTime when uTime is absent on an advanced order event', () => {
    const [event] = normalizeUserEvents({
      arg: { channel: 'algo-advance' },
      data: [{ instId: 'BTC-USDT-SWAP', algoId: '7001', state: 'live', pTime: '200', cTime: '100' }],
    }, undefined, NOW)!
    expect(event).toMatchObject({ kind: 'order', channel: 'orders-algo', ts: 200 })
  })

  it('accepts the legacy input alias but normalizes advanced states consistently', () => {
    const states = [
      ['partially_effective', 'open'], ['live', 'untriggered'], ['pause', 'untriggered'],
      ['canceled', 'cancelled'], ['order_failed', 'rejected'], ['partially_failed', 'rejected'], ['other', null],
    ] as const
    for (const [state, status] of states) {
      const [event] = normalizeUserEvents({
        arg: { channel: 'advance-algo-orders' },
        data: [{ instId: 'BTC-USDT-SWAP', algoId: '7001', state, accFillSz: '1', fillSz: '1', uTime: '300', pTime: '200', cTime: '100' }],
      }, undefined, NOW)!
      expect(event).toMatchObject({ kind: 'order', channel: 'orders-algo', state, status, filledContracts: '1', fillContracts: '1', ts: 300 })
    }
  })

  it('login code zero succeeds and a nonzero code overrides legacy success', () => {
    expect(normalizeUserEvents({ event: 'login', code: '0' })?.[0]).toMatchObject({ kind: 'login', ok: true })
    expect(normalizeUserEvents({ event: 'login', code: '60009', success: true })?.[0]).toMatchObject({ kind: 'login', ok: false })
    expect(normalizeUserEvents({ event: 'login', success: true })?.[0]).toMatchObject({ kind: 'login', ok: true })
  })
})
