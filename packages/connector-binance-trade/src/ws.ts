// SPDX-License-Identifier: CPAL-1.0
// 用户数据流（私有流）：listenKey 生命周期 + 帧解析。**不建连**：
//   · listenKey：POST /fapi/v1/listenKey 创建、PUT 续期、DELETE 关闭；官方 60 分钟内没续期就失效（有效 60 min），
//     QD 与官方建议每 30 分钟续期一次，本类在 25 分钟时就续（留 5 分钟余量），时钟由构造参数注入；
//   · WebSocket 只做消息解析：连接工厂（SocketFactory）由调用方注入，测试里是假 socket，永不真连。
import type { BinanceUserEvent } from './parse'
import { parseUserStreamMessage } from './parse'
import { BINANCE_WEIGHTS } from './budget'
import { asProblem, ProblemError } from './errors'
import type { BinanceHttp } from './rest'

/** listenKey 有效期（官方 60 min）。 */
export const LISTEN_KEY_TTL_MS = 60 * 60 * 1000
/** 续期间隔：官方建议 30 min，本连接器提前到 25 min。 */
export const LISTEN_KEY_RENEW_AFTER_MS = 25 * 60 * 1000

export const USER_STREAM_BASE = {
  mainnet: 'wss://fstream.binance.com',
  testnet: 'wss://stream.binancefuture.com',
} as const

export interface ListenKeyOptions {
  /** 只要 API key 头、不签名（listenKey 不需要签名，照 QD adapters.py:330-357）。 */
  http: Pick<BinanceHttp, 'apiKeyRequest'>
  clock?: () => number
  /** 距上次续期多久后 tick() 真的续期（缺省 25 min）。 */
  renewAfterMs?: number
  /** 有效期（缺省 60 min），只用于 state().expiresAt。 */
  ttlMs?: number
  secrets?: readonly string[]
}

export interface ListenKeyState {
  listenKey: string | null
  createdAt: number
  refreshedAt: number
  renewals: number
  expiresAt: number
}

export class ListenKeyManager {
  private readonly clock: () => number
  private readonly renewAfterMs: number
  private readonly ttlMs: number
  readonly #secrets: readonly string[]
  readonly #http: Pick<BinanceHttp, 'apiKeyRequest'>
  private key: string | null = null
  private createdAt = 0
  private refreshedAt = 0
  private renewals = 0

  /** 不保留构造参数对象（里面可能有 secrets）：JSON.stringify / inspect 看不到密钥。 */
  constructor(o: ListenKeyOptions) {
    this.clock = o.clock ?? (() => Date.now())
    this.renewAfterMs = o.renewAfterMs ?? LISTEN_KEY_RENEW_AFTER_MS
    this.ttlMs = o.ttlMs ?? LISTEN_KEY_TTL_MS
    this.#secrets = o.secrets ?? []
    this.#http = o.http
  }

  /** 创建 listenKey（POST /fapi/v1/listenKey）。已有 key 时先关掉再建，避免泄漏。 */
  async open(): Promise<string> {
    if (this.key !== null) await this.close()
    let body: { listenKey?: string }
    try {
      body = await this.#http.apiKeyRequest<{ listenKey?: string }>('POST', '/fapi/v1/listenKey', { weight: BINANCE_WEIGHTS.listenKey })
    } catch (e) {
      throw new ProblemError(asProblem(e, { secrets: this.#secrets, endpoint: 'signed' }))
    }
    const listenKey = body?.listenKey
    if (typeof listenKey !== 'string' || listenKey === '') {
      throw new ProblemError(asProblem(new Error('listenKey response is missing listenKey'), { secrets: this.#secrets }))
    }
    this.key = listenKey
    this.createdAt = this.clock()
    this.refreshedAt = this.createdAt
    this.renewals = 0
    return listenKey
  }

  /** 强制续期（PUT /fapi/v1/listenKey）。 */
  async keepAlive(): Promise<void> {
    if (this.key === null) throw new ProblemError(asProblem(new Error('listenKey is not open'), { secrets: this.#secrets }))
    try {
      await this.#http.apiKeyRequest<unknown>('PUT', '/fapi/v1/listenKey', { weight: BINANCE_WEIGHTS.listenKey })
    } catch (e) {
      throw new ProblemError(asProblem(e, { secrets: this.#secrets, endpoint: 'signed' }))
    }
    this.refreshedAt = this.clock()
    this.renewals += 1
  }

  /** 到点才续期：距上次续期 < renewAfterMs 时什么都不做（返回 'skipped'）。 */
  async tick(): Promise<'renewed' | 'skipped'> {
    if (this.key === null) return 'skipped'
    if (this.clock() - this.refreshedAt < this.renewAfterMs) return 'skipped'
    await this.keepAlive()
    return 'renewed'
  }

  /** 关闭（DELETE /fapi/v1/listenKey）。无论上游是否报错，本地状态都清掉。 */
  async close(): Promise<void> {
    if (this.key === null) return
    const key = this.key
    this.key = null
    try {
      await this.#http.apiKeyRequest<unknown>('DELETE', '/fapi/v1/listenKey', { weight: BINANCE_WEIGHTS.listenKey })
    } catch (e) {
      throw new ProblemError(asProblem(e, { secrets: this.#secrets, endpoint: 'signed' }))
    }
    void key
  }

  /** 上游推送 listenKeyExpired 后：本地作废，下一次 tick 会抛（必须重新 open）。 */
  invalidate(): void {
    this.key = null
  }

  state(): ListenKeyState {
    return {
      listenKey: this.key,
      createdAt: this.createdAt,
      refreshedAt: this.refreshedAt,
      renewals: this.renewals,
      expiresAt: this.key === null ? 0 : this.refreshedAt + this.ttlMs,
    }
  }
}

// ---- WebSocket（只做解析，连接靠注入）----------------------------------------

export interface SocketMessageEvent { data: unknown }
export interface SocketLike {
  onmessage: ((ev: SocketMessageEvent) => void) | null
  onerror?: ((ev: unknown) => void) | null
  onclose?: ((ev: unknown) => void) | null
  close(): void
}
export type SocketFactory = (url: string) => SocketLike

export function userStreamUrl(environment: 'mainnet' | 'testnet', listenKey: string): string {
  return `${USER_STREAM_BASE[environment]}/ws/${listenKey}`
}

export interface UserStreamOptions {
  factory: SocketFactory
  url: string
  onEvent: (e: BinanceUserEvent) => void
  onError?: (message: string) => void
  onClose?: () => void
}

export interface UserStreamHandle {
  readonly url: string
  close(): void
  state(): 'open' | 'closed'
}

/** 用注入的工厂建连；每条帧走 parseUserStreamMessage（坏 JSON 只回调 onError，不抛）。 */
export function openUserStream(o: UserStreamOptions): UserStreamHandle {
  const socket = o.factory(o.url)
  let state: 'open' | 'closed' = 'open'
  socket.onmessage = (ev) => {
    const data = ev.data
    const text = typeof data === 'string' ? data : String(data)
    const event = parseUserStreamMessage(text)
    if (event === null) {
      o.onError?.('unparseable user stream frame')
      return
    }
    if (event.kind === 'listenKeyExpired') state = 'closed'
    o.onEvent(event)
  }
  socket.onerror = () => o.onError?.('user stream socket error')
  socket.onclose = () => {
    state = 'closed'
    o.onClose?.()
  }
  return {
    url: o.url,
    close() {
      if (state === 'closed') return
      state = 'closed'
      socket.close()
    },
    state: () => state,
  }
}
