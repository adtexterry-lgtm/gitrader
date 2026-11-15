// SPDX-License-Identifier: CPAL-1.0
import { describe, expect, it } from 'vitest'
import { OkxTradeConnector } from '../src/connector'
import { openPrivateStream } from '../src/ws'
import type { SocketLike, SocketMessageEvent } from '../src/ws'
import { API_KEY, API_SECRET, BASE_URL, FakeOkxTrade, NOW, PASSPHRASE } from './helpers/fake-okx-trade'

class EdgeSocket implements SocketLike {
  sent: string[] = []
  closed = false
  onmessage: ((event: SocketMessageEvent) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  onclose: ((event: unknown) => void) | null = null
  constructor(readonly url: string, private readonly sendError?: Error) {}
  send(data: string): void {
    if (this.sendError) throw this.sendError
    this.sent.push(data)
  }
  close(): void { this.closed = true; this.onclose?.({}) }
  remoteClose(): void { this.closed = true; this.onclose?.({}) }
  push(frame: unknown): void { this.onmessage?.({ data: JSON.stringify(frame) }) }
}

function connector(factory: (url: string) => SocketLike, events: unknown[]) {
  const fake = new FakeOkxTrade()
  return new OkxTradeConnector({
    apiKey: API_KEY, apiSecret: API_SECRET, passphrase: PASSPHRASE,
    baseUrl: BASE_URL, fetchImpl: fake.fetch, clock: () => NOW,
    onWarn: () => {}, socketFactory: factory, onUserEvent: event => events.push(event),
  })
}

describe('B1 OK-F1 stream lifecycle', () => {
  it('closes aggregate handles on a child close during construction and notifies once', () => {
    const sockets: EdgeSocket[] = []
    const events: unknown[] = []
    let closeCount = 0
    const handle = openPrivateStream({
      factory: (url) => {
        if (sockets.length === 1) sockets[0]!.remoteClose()
        const socket = new EdgeSocket(url)
        sockets.push(socket)
        return socket
      },
      channels: ['orders', 'orders-algo'], apiKey: API_KEY, apiSecret: API_SECRET, passphrase: PASSPHRASE,
      clock: () => NOW, onEvent: event => events.push(event), onClose: () => { closeCount++ },
    })
    expect(handle.state()).toBe('closed')
    expect(sockets.every(socket => socket.closed)).toBe(true)
    const sentBeforePing = sockets.map(socket => socket.sent.length)
    handle.ping()
    expect(sockets.map(socket => socket.sent.length)).toEqual(sentBeforePing)
    expect(closeCount).toBe(1)
    expect(events).toHaveLength(0)
  })

  it('ignores login queued before public close and skips later keepalive', () => {
    const sockets: EdgeSocket[] = []
    const events: unknown[] = []
    const c = connector(url => { const socket = new EdgeSocket(url); sockets.push(socket); return socket }, events)
    c.openUserStream()
    c.closeUserStream()
    expect(sockets.every(socket => socket.closed)).toBe(true)
    sockets[1]!.push({ event: 'login', code: '0' })
    expect(sockets.map(socket => socket.sent.length)).toEqual([1, 1])
    expect(events).toHaveLength(0)
    expect(c.keepAliveUserStream()).toBe('skipped')
  })

  it('closes both sockets and propagates the original second login send error', () => {
    const sockets: EdgeSocket[] = []
    const events: unknown[] = []
    const sendError = new Error('second login send failed')
    const c = connector(url => {
      const socket = new EdgeSocket(url, sockets.length === 1 ? sendError : undefined)
      sockets.push(socket)
      return socket
    }, events)
    expect(() => c.openUserStream()).toThrow(sendError)
    expect(sockets).toHaveLength(2)
    expect(sockets.every(socket => socket.closed)).toBe(true)
    expect(events).toHaveLength(0)
  })

  it('stops dispatching remaining frame events when a callback closes the aggregate', () => {
    const sockets: EdgeSocket[] = []
    const events: unknown[] = []
    const handle = openPrivateStream({
      factory: (url) => { const socket = new EdgeSocket(url); sockets.push(socket); return socket },
      channels: ['orders'], apiKey: API_KEY, apiSecret: API_SECRET, passphrase: PASSPHRASE,
      clock: () => NOW, onEvent: event => { events.push(event); handle.close() },
    })
    sockets[0]!.push({ arg: { channel: 'orders' }, data: [
      { instId: 'BTC-USDT-SWAP', ordId: '1', state: 'live' },
      { instId: 'BTC-USDT-SWAP', ordId: '2', state: 'live' },
    ] })
    expect(events).toHaveLength(1)
    expect(handle.state()).toBe('closed')
  })
})
