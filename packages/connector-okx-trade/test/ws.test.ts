// SPDX-License-Identifier: CPAL-1.0
// 私有数据流（假 socket，全离线）：login 帧签名、login 成功后自动订阅、orders 事件、错误事件、心跳。
import { describe, expect, it } from 'vitest'
import { buildLoginFrame, buildSubscribeFrame, openPrivateStream, WS_PRIVATE_BASE } from '../src/ws'
import type { SocketMessageEvent, SocketLike } from '../src/ws'
import type { OkxUserEvent } from '../src/parse'
import { API_KEY, API_SECRET, NOW, PASSPHRASE } from './helpers/fake-okx-trade'

class FakeSocket implements SocketLike {
  sent: string[] = []
  closed = false
  onmessage: ((ev: SocketMessageEvent) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  onclose: ((ev: unknown) => void) | null = null
  constructor(readonly url: string) {}
  send(data: string): void {
    this.sent.push(data)
  }
  close(): void {
    this.closed = true
    this.onclose?.({})
  }
  push(frame: unknown): void {
    this.onmessage?.({ data: typeof frame === 'string' ? frame : JSON.stringify(frame) })
  }
}

function open(): { socket: FakeSocket; events: OkxUserEvent[]; errors: string[]; handle: ReturnType<typeof openPrivateStream> } {
  const sockets: FakeSocket[] = []
  const events: OkxUserEvent[] = []
  const errors: string[] = []
  const handle = openPrivateStream({
    factory: (url) => {
      const socket = new FakeSocket(url)
      sockets.push(socket)
      return socket
    },
    apiKey: API_KEY,
    apiSecret: API_SECRET,
    passphrase: PASSPHRASE,
    clock: () => NOW,
    ctValOf: (instId) => (instId === 'BTC-USDT-SWAP' ? '0.01' : undefined),
    onEvent: (e) => events.push(e),
    onError: (m) => errors.push(m),
  })
  return { socket: sockets[0]!, events, errors, handle }
}

describe('frames', () => {
  it('builds the login frame with a seconds timestamp and the WS signature', () => {
    const frame = buildLoginFrame({ apiKey: API_KEY, apiSecret: API_SECRET, passphrase: PASSPHRASE, clock: () => NOW })
    expect(frame.op).toBe('login')
    expect(frame.args[0]!.timestamp).toBe(String(Math.floor(NOW / 1000)))
    expect(frame.args[0]!.apiKey).toBe(API_KEY)
    expect(frame.args[0]!.passphrase).toBe(PASSPHRASE)
    expect(frame.args[0]!.sign).toMatch(/^[A-Za-z0-9+/]{43}=$/)
  })

  it('subscribes with instType=SWAP for each channel', () => {
    expect(buildSubscribeFrame(['orders', 'positions'])).toEqual({
      op: 'subscribe',
      args: [{ channel: 'orders', instType: 'SWAP' }, { channel: 'positions', instType: 'SWAP' }],
    })
  })

  it('uses the official private endpoint and the demo host on testnet, port 443 only (8443 retired 2026-10-31)', () => {
    expect(WS_PRIVATE_BASE.mainnet).toBe('wss://ws.okx.com/ws/v5/private')
    expect(WS_PRIVATE_BASE.testnet).toBe('wss://wspap.okx.com/ws/v5/private')
    for (const url of Object.values(WS_PRIVATE_BASE)) expect(new URL(url).port).toBe('')
  })

  it('dials the 443 URL for each environment when no url is injected', () => {
    for (const environment of ['mainnet', 'testnet'] as const) {
      const urls: string[] = []
      const handle = openPrivateStream({
        factory: (url) => { urls.push(url); return new FakeSocket(url) },
        apiKey: API_KEY, apiSecret: API_SECRET, passphrase: PASSPHRASE, clock: () => NOW,
        environment, onEvent: () => {},
      })
      expect(urls).toEqual([WS_PRIVATE_BASE[environment]])
      expect(handle.url).not.toContain(':8443')
    }
  })
})

describe('stream lifecycle', () => {
  it('sends login first and subscribes only after a successful login', () => {
    const { socket, handle } = open()
    expect(socket.sent).toHaveLength(1)
    expect(JSON.parse(socket.sent[0]!).op).toBe('login')
    socket.push({ event: 'login', success: true })
    expect(socket.sent).toHaveLength(2)
    expect(JSON.parse(socket.sent[1]!)).toMatchObject({ op: 'subscribe' })
    expect(handle.loggedIn()).toBe(true)
  })

  it('does not subscribe when login fails, and reports it', () => {
    const { socket, errors, handle } = open()
    socket.push({ event: 'login', success: false })
    expect(socket.sent).toHaveLength(1)
    expect(handle.loggedIn()).toBe(false)
    expect(errors).toContain('okx private stream login rejected')
  })

  it('redacts credentials in sent() while the real socket frame keeps them', () => {
    const { socket, handle } = open()
    const diagnostic = handle.sent().join('\n')
    expect(diagnostic).not.toContain(PASSPHRASE)
    expect(diagnostic).not.toContain(API_KEY)
    expect(diagnostic).toContain('"apiKey":"<redacted>"')
    expect(socket.sent[0]).toContain(PASSPHRASE)
    expect(socket.sent[0]).toContain(API_KEY)
  })

  it('forwards order frames as neutral events with base-unit sizes', () => {
    const { socket, events } = open()
    socket.push({
      arg: { channel: 'orders', instType: 'SWAP' },
      data: [{ instId: 'BTC-USDT-SWAP', ordId: '1', clOrdId: 'gtx', state: 'filled', side: 'buy', accFillSz: '3', avgPx: '100000', uTime: String(NOW) }],
    })
    expect(events[0]).toMatchObject({ kind: 'order', status: 'filled', filledBase: '0.03' })
  })

  it('turns an error frame into an error callback plus an event', () => {
    const { socket, events, errors } = open()
    socket.push({ event: 'error', code: '60009', msg: 'Login failed' })
    expect(errors[0]).toContain('60009')
    expect(events[0]).toMatchObject({ kind: 'error', code: '60009' })
  })

  it('ignores pong frames and reports unparseable ones', () => {
    const { socket, events, errors } = open()
    socket.push('pong')
    socket.push('not json at all')
    expect(events).toHaveLength(0)
    expect(errors).toContain('unparseable private stream frame')
  })

  it('pings on demand and stops after close', () => {
    const { socket, handle } = open()
    handle.ping()
    expect(socket.sent).toContain('ping')
    handle.close()
    expect(handle.state()).toBe('closed')
    expect(socket.closed).toBe(true)
    handle.ping()
    expect(socket.sent.filter((f) => f === 'ping')).toHaveLength(1)
  })
})
