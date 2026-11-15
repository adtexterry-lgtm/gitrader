// SPDX-License-Identifier: CPAL-1.0
// 私有数据流（WS）：login 帧 + 订阅帧 + 帧解析。**不建连**：连接工厂（SocketFactory）由调用方注入，
// 测试里是假 socket，永不真连。
//   · 握手：`{op:'login', args:[{apiKey, passphrase, timestamp, sign}]}`，其中
//     `sign = base64(HMAC-SHA256(secret, timestamp + 'GET' + '/users/self/verify'))`，
//     timestamp 是**秒**（与 REST 的 RFC3339 毫秒不同，OKX 两套口径）——QD okx.py 只做 REST，这一条按 OKX 官方文档；
//   · 订阅：orders / positions / account 三个通道，`instType: 'SWAP'`；
//   · 心跳：25 s 发一次字符串 `ping`（服务端回 `pong`），由注入的时钟决定何时发；
//   · 解析只走 parse.parseUserStreamMessage / normalizeUserEvents，逐条回调；坏帧只回调 onError，不抛。
//   · sent() 里的 login 帧已脱敏（apiKey / passphrase / sign），真正发给 socket 的帧不变。
import type { Decimal } from '@gitrader/protocol'
import { signWsLogin } from './rest'
import type { OkxUserEvent } from './parse'
import { normalizeUserEvents } from './parse'

/**
 * 私有 WS 地址（演示盘是 wspap 主机，登录后用同一套通道）。只走默认 443 端口：
 * OKX 官方变更日志（2026-10-16 更新）宣布 8443 端口公网 2026-10-31、Colo 2026-11-16 停服，
 * 主机与路径不变、只去掉 `:8443`。
 */
export const WS_PRIVATE_BASE = {
  mainnet: 'wss://ws.okx.com/ws/v5/private',
  testnet: 'wss://wspap.okx.com/ws/v5/private',
} as const
/** Business 地址由既有私有地址派生，主机与路径前缀保持一致。 */
export const WS_BUSINESS_BASE = {
  mainnet: WS_PRIVATE_BASE.mainnet.replace(/\/private$/, '/business'),
  testnet: WS_PRIVATE_BASE.testnet.replace(/\/private$/, '/business'),
} as const

/** 心跳间隔：OKX 要求 30 s 内有数据往来，25 s 发一次 ping 留余量。 */
export const PING_INTERVAL_MS = 25_000

export type OkxChannel = 'orders' | 'positions' | 'account' | 'orders-algo' | 'algo-advance' | 'advance-algo-orders'
type PrivateChannel = 'orders' | 'positions' | 'account'
type BusinessChannel = 'orders-algo' | 'algo-advance'

export interface SocketMessageEvent { data: unknown }
export interface SocketLike {
  send(data: string): void
  onmessage: ((ev: SocketMessageEvent) => void) | null
  onerror?: ((ev: unknown) => void) | null
  onclose?: ((ev: unknown) => void) | null
  close(): void
}
export type SocketFactory = (url: string) => SocketLike

export interface LoginArgs {
  apiKey: string
  passphrase: string
  /** 秒（字符串），不是毫秒。 */
  timestamp: string
  sign: string
}

/** login 帧：timestamp 取整到秒；签名只在这里用到 secret，不落日志。 */
export function buildLoginFrame(o: { apiKey: string; apiSecret: string; passphrase: string; clock?: () => number }): { op: 'login'; args: LoginArgs[] } {
  const nowMs = (o.clock ?? (() => Date.now()))()
  const timestamp = String(Math.floor(nowMs / 1000))
  return {
    op: 'login',
    args: [{
      apiKey: o.apiKey,
      passphrase: o.passphrase,
      timestamp,
      sign: signWsLogin(o.apiSecret, timestamp),
    }],
  }
}

/** 订阅帧：一个通道一条 arg（OKX 允许一条 subscribe 带多个 arg）。 */
export function buildSubscribeFrame(channels: readonly OkxChannel[]): { op: 'subscribe'; args: Array<{ channel: string; instType: string }> } {
  return {
    op: 'subscribe',
    args: channels.map((channel) => ({ channel: channel === 'advance-algo-orders' ? 'algo-advance' : channel, instType: 'SWAP' })),
  }
}

export interface PrivateStreamOptions {
  factory: SocketFactory
  url?: string
  environment?: 'mainnet' | 'testnet'
  apiKey: string
  apiSecret: string
  passphrase: string
  channels?: readonly OkxChannel[]
  clock?: () => number
  /** 标的 → ctVal（把事件里的张数折成币）。 */
  ctValOf?: (instId: string) => string | undefined
  onEvent: (e: OkxUserEvent) => void
  onError?: (message: string) => void
  onClose?: () => void
}

export interface PrivateStreamHandle {
  readonly url: string
  /** 已发出的帧（诊断 / 测试用）：login、subscribe、subscribe-ack、ping。 */
  sent(): string[]
  /** 最近一次 login 的结果（true / false / null = 还没回）。 */
  loggedIn(): boolean | null
  ping(): void
  close(): void
  state(): 'open' | 'closed'
}

/**
 * 用注入的工厂建连：连上先发 login；login 成功后自动订阅 channels；之后每帧交给解析器。
 * 25 s 的心跳由调用方的定时器驱动（`handle.ping()`），本类不自己起 timer（测试里不用假时钟）。
 */
export function openPrivateStream(o: PrivateStreamOptions): PrivateStreamHandle {
  const requested = o.channels ?? (['orders', 'positions', 'account'] as const)
  const privateChannels: PrivateChannel[] = []
  const businessChannels: BusinessChannel[] = []
  for (const channel of requested) {
    const canonical = channel === 'advance-algo-orders' ? 'algo-advance' : channel
    if (canonical === 'orders-algo' || canonical === 'algo-advance') {
      if (!businessChannels.includes(canonical)) businessChannels.push(canonical)
    } else if (!privateChannels.includes(canonical)) {
      privateChannels.push(canonical)
    }
  }
  const environment = o.environment ?? 'mainnet'
  const privateUrl = o.url ?? WS_PRIVATE_BASE[environment]
  const businessUrl = privateUrl.replace(/\/private$/, '/business')
  const groups: Array<{ url: string; channels: readonly OkxChannel[] }> = []
  if (privateChannels.length > 0 || (requested.length === 0 && businessChannels.length === 0)) {
    groups.push({ url: privateUrl, channels: privateChannels })
  }
  if (businessChannels.length > 0) groups.push({ url: businessUrl, channels: businessChannels })
  const handles: PrivateStreamHandle[] = []
  let closed = false
  let initializing = true
  let closeNotified = false
  let childClosed = false
  const notifyClose = (): void => {
    if (closeNotified) return
    closeNotified = true
    o.onClose?.()
  }
  const onChildClose = (): void => {
    if (closed) return
    closed = true
    childClosed = true
    for (const handle of handles) handle.close()
    if (!initializing) notifyClose()
  }
  try {
    for (const group of groups) {
      if (closed) break
      const handle = openSinglePrivateStream({ ...o, url: group.url, channels: group.channels, onClose: onChildClose })
      handles.push(handle)
      if (closed) handle.close()
    }
    initializing = false
  } catch (error) {
    closed = true
    for (const handle of handles) handle.close()
    initializing = false
    if (childClosed) notifyClose()
    throw error
  }
  if (closed) notifyClose()
  const url = groups.find((group) => group.url === privateUrl)?.url ?? groups[0]?.url ?? privateUrl
  return {
    url,
    sent: () => handles.flatMap((handle) => handle.sent()),
    loggedIn: () => {
      if (handles.length === 0) return null
      const states = handles.map((handle) => handle.loggedIn())
      if (states.some((state) => state === false)) return false
      return states.every((state) => state === true) ? true : null
    },
    ping: () => { if (!closed) for (const handle of handles) handle.ping() },
    close: () => {
      if (closed) return
      closed = true
      for (const handle of handles) handle.close()
      notifyClose()
    },
    state: () => closed ? 'closed' : 'open',
  }
}

function openSinglePrivateStream(o: PrivateStreamOptions): PrivateStreamHandle {
  const url = o.url ?? WS_PRIVATE_BASE[o.environment ?? 'mainnet']
  const channels = o.channels ?? (['orders', 'positions', 'account'] as const)
  const clock = o.clock ?? (() => Date.now())
  const socket = o.factory(url)
  const frames: string[] = []
  let state: 'open' | 'closed' = 'open'
  let loginResult: boolean | null = null
  const isClosed = (): boolean => state === 'closed'

  const send = (frame: unknown, recorded?: string): void => {
    if (isClosed()) return
    const text = typeof frame === 'string' ? frame : JSON.stringify(frame)
    frames.push(recorded ?? text)
    socket.send(text)
  }

  socket.onmessage = (ev) => {
    if (isClosed()) return
    const data = ev.data
    const text = typeof data === 'string' ? data : String(data)
    // 心跳回包是裸字符串，不是 JSON
    if (text === 'pong') return
    const events = normalizeUserEvents(parseJson(text), (instId: string) => {
      const raw = o.ctValOf?.(instId)
      return raw === undefined ? undefined : (raw as Decimal)
    }, clock())
    if (events === null) {
      if (!isClosed()) o.onError?.('unparseable private stream frame')
      return
    }
    for (const event of events) {
      if (isClosed()) return
      if (event.kind === 'login') {
        loginResult = event.ok
        if (event.ok) send(buildSubscribeFrame(channels))
        else o.onError?.('okx private stream login rejected')
        o.onEvent(event)
        if (isClosed()) return
        continue
      }
      if (event.kind === 'error') {
        o.onError?.(`okx private stream error ${event.code}: ${event.msg}`)
        o.onEvent(event)
        if (isClosed()) return
        continue
      }
      o.onEvent(event)
      if (isClosed()) return
    }
  }
  socket.onerror = () => { if (!isClosed()) o.onError?.('private stream socket error') }
  socket.onclose = () => {
    if (isClosed()) return
    state = 'closed'
    o.onClose?.()
  }

  const loginFrame = buildLoginFrame({ apiKey: o.apiKey, apiSecret: o.apiSecret, passphrase: o.passphrase, clock })
  const loginForLog = JSON.stringify({
    op: 'login',
    args: [{
      apiKey: '<redacted>',
      passphrase: '<redacted>',
      timestamp: loginFrame.args[0]!.timestamp,
      sign: '<redacted>',
    }],
  })
  try {
    send(loginFrame, loginForLog)
  } catch (error) {
    state = 'closed'
    try { socket.close() } catch { /* keep the original send error */ }
    throw error
  }

  return {
    url,
    sent: () => [...frames],
    loggedIn: () => loginResult,
    ping: () => {
      if (state === 'open') send('ping')
    },
    close() {
      if (state === 'closed') return
      state = 'closed'
      socket.close()
    },
    state: () => state,
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}
