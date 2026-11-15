// SPDX-License-Identifier: CPAL-1.0
// 私有流（WebSocket）：Bybit v5 的鉴权与订阅消息构造 + 帧归一。**不建连**：
//   · 连接工厂（SocketFactory）由调用方注入，测试里是假 socket，永不真连、不联网；
//   · 鉴权：`op: 'auth'`，args = [apiKey, expires, sign]，sign = HMAC_SHA256(secret, 'GET/realtime' + expires)，
//     expires 是毫秒时间戳（官方示例取 now + 10 s）；
//   · 订阅：`op: 'subscribe'`，args = ['execution', 'order', 'position', 'wallet']；
//   · 心跳：`op: 'ping'` → 对端回 `op: 'pong'`（归一成 {kind:'pong'}）。
// 归一的三条硬要求（教训 10）：保留 execId（去重键）、execType（执行类型）、closedSize > 0 的平仓行。
import { createHmac } from 'node:crypto'
import { redactSecret } from './errors'
import type { BybitPrivateEvent } from './parse'
import { parsePrivateMessage } from './parse'

/** Bybit v5 私有流地址。 */
export const PRIVATE_WS_URL = {
  mainnet: 'wss://stream.bybit.com/v5/private',
  testnet: 'wss://stream-testnet.bybit.com/v5/private',
} as const

/** expires 的提前量（官方示例 now + 10 s；本包同口径）。 */
export const AUTH_EXPIRES_AHEAD_MS = 10_000

/** 默认订阅的私有主题。 */
export const DEFAULT_TOPICS = ['execution', 'order', 'position', 'wallet'] as const

/** 鉴名：HMAC-SHA256(apiSecret, `GET/realtime${expires}`) 的 hex。 */
export function authSignature(apiSecret: string, expires: number): string {
  return createHmac('sha256', apiSecret).update(`GET/realtime${expires}`).digest('hex')
}

/** `op: auth` 消息（含密钥；只交给注入的 socket，不打印、不进 JSON 日志）。 */
export function buildAuthMessage(apiKey: string, apiSecret: string, expires: number): string {
  return JSON.stringify({ op: 'auth', args: [apiKey, expires, authSignature(apiSecret, expires)] })
}

/** `op: subscribe` 消息。 */
export function buildSubscribeMessage(topics: readonly string[]): string {
  return JSON.stringify({ op: 'subscribe', args: [...topics] })
}

/** `op: ping` 消息。 */
export function buildPingMessage(): string {
  return JSON.stringify({ op: 'ping' })
}

export interface SocketMessageEvent {
  data: unknown
}

export interface SocketLike {
  onmessage: ((ev: SocketMessageEvent) => void) | null
  onerror?: ((ev: unknown) => void) | null
  onclose?: ((ev: unknown) => void) | null
  send?(data: string): void
  close(): void
}

export type SocketFactory = (url: string) => SocketLike

export interface PrivateStreamOptions {
  factory: SocketFactory
  url: string
  apiKey: string
  apiSecret: string
  topics?: readonly string[]
  clock?: () => number
  onEvent: (e: BybitPrivateEvent) => void
  onError?: (message: string) => void
  onClose?: () => void
}

export interface PrivateStreamHandle {
  /** 已发出的消息（诊断用）：密钥已替换成 `<redacted>`，明文只在 socket 里出现。 */
  readonly sent: string[]
  /** 主动发一次 ping。 */
  ping(): void
  close(): void
}

/** 帧文本 → 事件（导出便于单测；不建连）。 */
export function parseFrame(text: string, now: number): BybitPrivateEvent[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return []
  }
  return parsePrivateMessage(parsed, now)
}

/**
 * 建一条私有流：连上就发 auth，auth 成功（success:true）再发 subscribe。
 * 连接、重连、心跳节奏由内核控制；本函数只做「消息装配 + 帧归一」，从不打印密钥。
 */
export function openPrivateStream(o: PrivateStreamOptions): PrivateStreamHandle {
  const clock = o.clock ?? (() => Date.now())
  const topics = o.topics ?? DEFAULT_TOPICS
  const sent: string[] = []
  const socket = o.factory(o.url)
  let authed = false
  let closed = false

  const send = (message: string): void => {
    if (closed) return
    // 诊断留痕只留脱敏版；明文只交给注入的 socket。
    sent.push(redactSecret(message, [o.apiSecret, o.apiKey]))
    socket.send?.(message)
  }

  socket.onmessage = (ev) => {
    const text = typeof ev.data === 'string' ? ev.data : ev.data instanceof Uint8Array ? Buffer.from(ev.data).toString('utf8') : ''
    if (text === '') return
    const events = parseFrame(text, clock())
    for (const event of events) {
      // auth 的 ack：成功才订阅；失败就把 ack 交给上层（要能看到失败原因）。
      if (event.kind === 'subscribed' && event.topic === 'auth' && !authed) {
        if (!event.success) {
          o.onEvent(event)
          continue
        }
        authed = true
        send(buildSubscribeMessage(topics))
        continue
      }
      o.onEvent(event)
    }
  }
  socket.onerror = (ev) => {
    const message = ev instanceof Error ? ev.message : 'bybit private stream error'
    o.onError?.(message)
  }
  socket.onclose = () => {
    closed = true
    o.onClose?.()
  }

  // 先鉴权（expires 在 now 之后 10 s）；订阅等 auth 的 ack。
  send(buildAuthMessage(o.apiKey, o.apiSecret, clock() + AUTH_EXPIRES_AHEAD_MS))

  return {
    sent,
    ping() {
      send(buildPingMessage())
    },
    close() {
      if (closed) return
      closed = true
      socket.close()
    },
  }
}
