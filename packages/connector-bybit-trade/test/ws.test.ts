// SPDX-License-Identifier: CPAL-1.0
// 私有流：鉴权 / 订阅消息装配、帧归一、假 socket（永不真连）。
// 硬要求：venueFillId 含标的命名空间并用于去重、execType 保留、平仓行不丢；诊断留痕里的密钥已脱敏。
import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  AUTH_EXPIRES_AHEAD_MS, authSignature, buildAuthMessage, buildPingMessage, buildSubscribeMessage, DEFAULT_TOPICS,
  openPrivateStream, parseFrame, PRIVATE_WS_URL,
} from '../src/ws'
import type { SocketLike } from '../src/ws'
import { fillDedupeKey } from '../src/parse'
import type { BybitPrivateEvent } from '../src/parse'
import { API_KEY, API_SECRET, NOW } from './helpers/fake-bybit-trade'

class FakeSocket implements SocketLike {
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  onclose: ((ev: unknown) => void) | null = null
  received: string[] = []
  closed = false

  send(data: string): void {
    this.received.push(data)
  }

  close(): void {
    this.closed = true
  }

  /** 把一帧推给客户端。 */
  push(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) })
  }
}

const executions = (data: unknown[]): unknown => ({ topic: 'execution', data })

describe('鉴权与订阅消息', () => {
  it('authSignature = HMAC-SHA256(secret, "GET/realtime" + expires) 的 hex', () => {
    const expires = NOW + 10_000
    const expected = createHmac('sha256', API_SECRET).update(`GET/realtime${expires}`).digest('hex')
    expect(authSignature(API_SECRET, expires)).toBe(expected)
    expect(authSignature(API_SECRET, expires)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('buildAuthMessage 的形状 {op:auth, args:[apiKey, expires, sign]}', () => {
    const expires = NOW + 10_000
    const msg = JSON.parse(buildAuthMessage(API_KEY, API_SECRET, expires)) as { op: string; args: unknown[] }
    expect(msg.op).toBe('auth')
    expect(msg.args[0]).toBe(API_KEY)
    expect(msg.args[1]).toBe(expires)
    expect(msg.args[2]).toBe(authSignature(API_SECRET, expires))
  })

  it('buildSubscribeMessage 是 {op:subscribe, args:[...]}', () => {
    expect(JSON.parse(buildSubscribeMessage(['execution', 'order']))).toEqual({ op: 'subscribe', args: ['execution', 'order'] })
  })

  it('buildPingMessage 是 {op:ping}', () => {
    expect(JSON.parse(buildPingMessage())).toEqual({ op: 'ping' })
  })

  it('默认订阅执行 / 订单 / 持仓 / 钱包四类', () => {
    expect([...DEFAULT_TOPICS]).toEqual(['execution', 'order', 'position', 'wallet'])
  })

  it('私有流地址按环境区分（mainnet / testnet）', () => {
    expect(PRIVATE_WS_URL.mainnet).toBe('wss://stream.bybit.com/v5/private')
    expect(PRIVATE_WS_URL.testnet).toBe('wss://stream-testnet.bybit.com/v5/private')
  })

  it('expires 的提前量是 10 s（官方示例同口径）', () => {
    expect(AUTH_EXPIRES_AHEAD_MS).toBe(10_000)
  })
})

describe('帧解析', () => {
  it('坏 JSON → 空数组（不抛）', () => {
    expect(parseFrame('{oops', NOW)).toEqual([])
  })

  it('执行帧 → 成交事件', () => {
    const events = parseFrame(JSON.stringify(executions([
      { symbol: 'BTCUSDT', execId: 'e-1', orderId: 'o-1', side: 'Buy', execPrice: '100', execQty: '0.1', execType: 'Trade', execTime: String(NOW) },
    ])), NOW)
    expect(events[0]).toMatchObject({ kind: 'fill', fill: { venueFillId: 'BTCUSDT:e-1', instrumentId: 'bybit:BTCUSDT' } })
  })

  it('私有帧区分不同标的上的相同 execId', () => {
    const events = parseFrame(JSON.stringify(executions([
      { symbol: 'btcusdt', execId: 'exec-shared', side: 'Buy', execQty: '0.1', execType: 'Trade' },
      { symbol: 'ethusdt', execId: 'exec-shared', side: 'Buy', execQty: '0.1', execType: 'Trade' },
    ])), NOW)
    const fillIds = events.filter((event) => event.kind === 'fill').map((event) => (event as Extract<BybitPrivateEvent, { kind: 'fill' }>).fill.venueFillId)
    expect(fillIds).toEqual(['BTCUSDT:exec-shared', 'ETHUSDT:exec-shared'])
  })
})

describe('openPrivateStream（假 socket，不建连）', () => {
  const stream = (socket: FakeSocket, events: BybitPrivateEvent[] = []) =>
    openPrivateStream({
      factory: () => socket,
      url: PRIVATE_WS_URL.mainnet,
      apiKey: API_KEY,
      apiSecret: API_SECRET,
      clock: () => NOW,
      onEvent: (e) => events.push(e),
    })

  it('连上先发 auth（带 expires = now + 10 s）', () => {
    const socket = new FakeSocket()
    stream(socket)
    expect(socket.received).toHaveLength(1)
    const auth = JSON.parse(socket.received[0]!) as { op: string; args: [string, number, string] }
    expect(auth.op).toBe('auth')
    expect(auth.args[1]).toBe(NOW + AUTH_EXPIRES_AHEAD_MS)
  })

  it('收到 auth 的 ack 之后才发 subscribe（不抢跑）', () => {
    const socket = new FakeSocket()
    stream(socket)
    socket.push({ op: 'auth', success: true })
    expect(socket.received).toHaveLength(2)
    expect(JSON.parse(socket.received[1]!)).toEqual({ op: 'subscribe', args: [...DEFAULT_TOPICS] })
  })

  it('auth 失败也要把 ack 交给上层（success:false），且不发 subscribe', () => {
    const socket = new FakeSocket()
    const events: BybitPrivateEvent[] = []
    stream(socket, events)
    socket.push({ op: 'auth', success: false, ret_msg: 'invalid signature' })
    expect(events[0]).toMatchObject({ kind: 'subscribed', topic: 'auth', success: false })
    expect(socket.received).toHaveLength(1)
  })

  it('成交帧推到 onEvent（含 execType 与 closing）', () => {
    const socket = new FakeSocket()
    const events: BybitPrivateEvent[] = []
    stream(socket, events)
    socket.push(executions([
      { symbol: 'BTCUSDT', execId: 'e-2', orderId: 'o-2', side: 'Sell', execPrice: '101', execQty: '0.1', execType: 'Trade', execTime: String(NOW), closedSize: '0.1', leavesQty: '0' },
    ]))
    const fill = events.find((e) => e.kind === 'fill') as Extract<BybitPrivateEvent, { kind: 'fill' }>
    expect(fill.fill.execType).toBe('Trade')
    expect(fill.fill.closing).toBe(true)
    expect(fillDedupeKey(fill.fill)).toBe('bybit|BTCUSDT:e-2')
  })

  it('资金费帧不进成交（归 unknown），不会被当成 fill 记账', () => {
    const socket = new FakeSocket()
    const events: BybitPrivateEvent[] = []
    stream(socket, events)
    socket.push(executions([{ symbol: 'BTCUSDT', execId: 'f-1', execType: 'Funding', execFee: '-0.02', execTime: String(NOW) }]))
    expect(events.some((e) => e.kind === 'fill')).toBe(false)
    expect(events.some((e) => e.kind === 'unknown')).toBe(true)
  })

  it('ping() 发 {op:ping}，pong 帧归 pong', () => {
    const socket = new FakeSocket()
    const events: BybitPrivateEvent[] = []
    const handle = stream(socket, events)
    handle.ping()
    expect(JSON.parse(socket.received.at(-1)!)).toEqual({ op: 'ping' })
    socket.push({ op: 'pong' })
    expect(events.at(-1)).toEqual({ kind: 'pong' })
  })

  it('诊断留痕不含密钥（只留 <redacted>），但 socket 收到的是明文', () => {
    const socket = new FakeSocket()
    const handle = stream(socket)
    expect(handle.sent[0]).not.toContain(API_KEY)
    expect(handle.sent[0]).not.toContain(API_SECRET)
    expect(handle.sent[0]).toContain('<redacted>')
    expect(socket.received[0]).toContain(API_KEY)
  })

  it('close() 关 socket，之后的 ping 不再发', () => {
    const socket = new FakeSocket()
    const handle = stream(socket)
    handle.close()
    expect(socket.closed).toBe(true)
    handle.ping()
    expect(socket.received).toHaveLength(1)
  })

  it('socket 的 close 事件会回调 onClose', () => {
    const socket = new FakeSocket()
    let closed = false
    openPrivateStream({
      factory: () => socket,
      url: PRIVATE_WS_URL.mainnet,
      apiKey: API_KEY,
      apiSecret: API_SECRET,
      clock: () => NOW,
      onEvent: () => {},
      onClose: () => {
        closed = true
      },
    })
    socket.onclose?.({})
    expect(closed).toBe(true)
  })

  it('socket 的 error 事件转成 onError 文案', () => {
    const messages: string[] = []
    const socket = new FakeSocket()
    openPrivateStream({
      factory: () => socket,
      url: PRIVATE_WS_URL.mainnet,
      apiKey: API_KEY,
      apiSecret: API_SECRET,
      clock: () => NOW,
      onEvent: () => {},
      onError: (m) => messages.push(m),
    })
    socket.onerror?.(new Error('socket hang up'))
    expect(messages).toEqual(['socket hang up'])
  })
})
