// SPDX-License-Identifier: CPAL-1.0
// 私有流 trade_updates（官方 Streaming 文档，ws 基址见 constants.STREAM_URLS）。
//   · 握手：连上后 10 s 内发 `{"action":"auth","key":...,"secret":...}`；
//     收到 `{"stream":"authorization","data":{"status":"authorized"}}` → 发 `{"action":"listen","data":{"streams":["trade_updates"]}}`；
//     收到 `{"stream":"listening","data":{"streams":["trade_updates"]}}` → 就绪（QD alpaca_trading/README.md:125-140 记的坑就在这里）；
//   · trade_updates 每条的 `data.event` 是 new / fill / partial_fill / canceled / expired / replaced / rejected / ...
//   · **成交去重键 = `order.id` + `order.filled_qty`**（与 REST 活动行的 `order_id` + `cum_qty` 同一形状）；
//     fill / partial_fill 缺 filled_qty 就丢弃并告警，execution_id 只作诊断字段保留；
//   · 官方 paper 流会发二进制帧：ArrayBuffer / TypedArray 用 TextDecoder 解，Blob 走 text()；
//   · socket 可注入（测试用假 socket，不联网）；没有注入且宿主没有全局 WebSocket 时 connect() 抛错。
import type { Ms } from '@gitrader/protocol'
import { normalizeDecimal } from '@gitrader/protocol'
import type { VenueFill } from '@gitrader/protocol/connector'
import { VENUE } from './constants'
import { redactSecret } from './errors'
import { msOf } from './parse'

/** 宿主 WebSocket 的最小子集（Node 22 有全局 WebSocket；测试注入假实现）。 */
export interface SocketLike {
  send(data: string): void
  close(): void
  onopen: ((ev?: unknown) => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onclose: ((ev?: unknown) => void) | null
  onerror: ((ev?: unknown) => void) | null
}

export type StreamState = 'idle' | 'connecting' | 'authorizing' | 'subscribing' | 'connected' | 'closed'

/** 一条 trade_updates 的归一结果（保留执行 id / 订单 id / 客户端单号 / 原始状态）。 */
export interface TradeUpdate {
  /** 上游事件名（new / fill / partial_fill / canceled / expired / replaced / rejected / ...）。 */
  event: string
  executionId: string | null
  venueOrderId: string
  clientOrderId: string | null
  symbol: string
  instrumentId: string
  side: 'buy' | 'sell'
  /** 本次事件成交量（fill / partial_fill 才有）。 */
  qty: string | null
  /** 事件后的累计成交量（fill / partial_fill 才有；去重键用）。 */
  filledQty: string | null
  price: string | null
  /** 上游订单状态。 */
  status: string
  /** 事件后的持仓数量（上游 position_qty，可能为负 = 空头）。 */
  positionQty: string | null
  ts: Ms
  raw: Record<string, unknown>
}

const str = (v: unknown): string => (v === undefined || v === null ? '' : String(v).trim())
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * 一条流消息 → 若干 TradeUpdate。控制消息（authorization / listening / 错误）返回空数组；
 * 形状不认识的一律跳过（不断流），但 fill 缺 execution_id 会通过 onWarn 报。
 */
export function normalizeStreamMessage(message: unknown, onWarn?: (message: string) => void): TradeUpdate[] {
  if (!isRecord(message)) return []
  const stream = str(message['stream'])
  if (stream !== 'trade_updates') return []
  const data = message['data']
  if (!isRecord(data)) return []
  const event = str(data['event']).toLowerCase()
  const order = isRecord(data['order']) ? data['order'] : {}
  const symbol = str(order['symbol']).toUpperCase()
  const venueOrderId = str(order['id'])
  if (event === '' || symbol === '' || venueOrderId === '') return []
  const executionId = str(data['execution_id']) === '' ? null : str(data['execution_id'])
  const isFill = event === 'fill' || event === 'partial_fill'
  const filledQty = str(order['filled_qty'])
  if (isFill && filledQty === '') {
    onWarn?.('alpaca trade_updates: fill without order.filled_qty dropped (it is part of the dedupe key)')
    return []
  }
  const sideRaw = str(order['side']).toLowerCase()
  return [{
    event,
    executionId,
    venueOrderId,
    clientOrderId: str(order['client_order_id']) === '' ? null : str(order['client_order_id']),
    symbol,
    instrumentId: `${VENUE}:${symbol}`,
    side: sideRaw === 'sell' ? 'sell' : 'buy',
    qty: isFill ? str(data['qty']) || null : null,
    filledQty: isFill ? filledQty : null,
    price: isFill ? str(data['price']) || null : null,
    status: str(order['status']).toLowerCase(),
    positionQty: str(data['position_qty']) === '' ? null : str(data['position_qty']),
    ts: msOf(str(data['timestamp']) || str(order['updated_at'])),
    raw: data,
  }]
}

/** 流成交 → VenueFill（去重键 = order.id + 累计成交量，与 REST 同一形状）。 */
export function fillFromUpdate(update: TradeUpdate): VenueFill | null {
  if (update.filledQty === null || update.qty === null || update.price === null) return null
  return {
    venueFillId: `${update.venueOrderId}:${normalizeDecimal(update.filledQty)}`,
    venueOrderId: update.venueOrderId,
    clientOrderId: update.clientOrderId,
    instrumentId: update.instrumentId,
    side: update.side,
    price: normalizeDecimal(update.price),
    size: normalizeDecimal(update.qty.trim().startsWith('-') ? update.qty.trim().slice(1) : update.qty.trim()),
    fee: normalizeDecimal('0'),
    feeCcy: 'USD',
    liquidity: 'taker',
    realizedPnl: normalizeDecimal('0'),
    ts: update.ts,
  }
}

export interface AlpacaStreamOptions {
  url: string
  apiKey: string
  apiSecret: string
  /** 注入 socket（测试）；缺省用宿主全局 WebSocket。 */
  socket?: () => SocketLike
  clock?: () => number
  onWarn?: (message: string) => void
  /** 鉴权超时（毫秒），缺省 10 s（官方要求 10 s 内发 auth）。 */
  authTimeoutMs?: number
  /** 断线重连延迟（毫秒），缺省 1000；0 = 不自动重连。 */
  reconnectDelayMs?: number
}

export class AlpacaTradeStream {
  readonly #url: string
  readonly #apiKey: string
  readonly #apiSecret: string
  readonly #socketFactory: (() => SocketLike) | undefined
  readonly #clock: () => number
  readonly #onWarn: (message: string) => void
  readonly #authTimeoutMs: number
  readonly #reconnectDelayMs: number
  readonly #listeners = new Set<(u: TradeUpdate) => void>()
  #socket: SocketLike | null = null
  #state: StreamState = 'idle'
  #lastMessageTs: Ms = 0
  #reconnects = 0
  #authTimer: ReturnType<typeof setTimeout> | null = null

  constructor(o: AlpacaStreamOptions) {
    this.#url = o.url
    this.#apiKey = o.apiKey
    this.#apiSecret = o.apiSecret
    this.#socketFactory = o.socket
    this.#clock = o.clock ?? (() => Date.now())
    this.#onWarn = o.onWarn ?? ((message) => console.warn(message))
    this.#authTimeoutMs = o.authTimeoutMs ?? 10_000
    this.#reconnectDelayMs = o.reconnectDelayMs ?? 1_000
  }

  get state(): StreamState {
    return this.#state
  }

  get lastMessageTs(): Ms {
    return this.#lastMessageTs
  }

  get reconnects(): number {
    return this.#reconnects
  }

  /** 脱敏后的诊断文本（socket 错误只走这里）。 */
  safeText(e: unknown): string {
    const text = e instanceof Error ? e.message : String(e)
    return redactSecret(text, [this.#apiSecret, this.#apiKey])
  }

  /** 订阅归一后的 trade_updates（返回退订函数）。 */
  onUpdate(cb: (u: TradeUpdate) => void): () => void {
    this.#listeners.add(cb)
    return () => this.#listeners.delete(cb)
  }

  /** 建连 + 鉴权 + 订阅 trade_updates；返回就绪时 resolve 的 Promise。 */
  async connect(): Promise<void> {
    if (this.#state === 'connected') return
    const factory = this.#socketFactory ?? defaultSocketFactory(this.#url)
    if (factory === undefined) throw new Error('no WebSocket implementation available: inject options.socket')
    this.#state = 'connecting'
    const socket = factory()
    this.#socket = socket
    const ready = new Promise<void>((resolve, reject) => {
      let settled = false
      const settle = (fn: () => void): void => {
        if (settled) return
        settled = true
        fn()
      }
      socket.onopen = () => {
        this.#state = 'authorizing'
        this.#authTimer = setTimeout(() => {
          settle(() => reject(new Error(`alpaca stream did not authorize within ${this.#authTimeoutMs} ms`)))
        }, this.#authTimeoutMs)
        this.send({ action: 'auth', key: this.#apiKey, secret: this.#apiSecret })
      }
      const handleFrame = (text: string): void => {
        this.#lastMessageTs = this.#clock()
        let parsed: unknown
        try {
          parsed = JSON.parse(text)
        } catch {
          this.#onWarn('alpaca stream: non-JSON frame ignored')
          return
        }
        if (isRecord(parsed)) {
          const stream = String(parsed['stream'] ?? '')
          if (stream === 'authorization') {
            const data = isRecord(parsed['data']) ? parsed['data'] : {}
            if (String(data['status'] ?? '') !== 'authorized') {
              settle(() => reject(new Error('alpaca stream refused the credentials (authorization status is not "authorized")')))
              return
            }
            this.#state = 'subscribing'
            this.send({ action: 'listen', data: { streams: ['trade_updates'] } })
            return
          }
          if (stream === 'listening') {
            this.#state = 'connected'
            if (this.#authTimer !== null) clearTimeout(this.#authTimer)
            this.#authTimer = null
            settle(resolve)
            return
          }
          if (stream === 'error') {
            const data = isRecord(parsed['data']) ? parsed['data'] : {}
            settle(() => reject(new Error(`alpaca stream error: ${String(data['msg'] ?? data['code'] ?? 'unknown')}`)))
            return
          }
        }
        for (const update of normalizeStreamMessage(parsed, this.#onWarn)) {
          for (const listener of this.#listeners) listener(update)
        }
      }
      socket.onmessage = (ev) => {
        const data = ev.data
        if (typeof data === 'string') {
          handleFrame(data)
          return
        }
        if (data instanceof ArrayBuffer) {
          handleFrame(new TextDecoder().decode(data))
          return
        }
        if (ArrayBuffer.isView(data)) {
          handleFrame(new TextDecoder().decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)))
          return
        }
        if (data !== null && typeof data === 'object' && typeof (data as { text?: unknown }).text === 'function') {
          void (data as { text(): Promise<string> }).text().then(handleFrame, () => {
            this.#onWarn('alpaca stream: could not read a blob frame')
          })
          return
        }
        this.#onWarn('alpaca stream: unsupported frame type ignored')
      }
      socket.onerror = (ev) => {
        this.#onWarn(`alpaca stream socket error: ${this.safeText(ev)}`)
        settle(() => reject(new Error(this.safeText(ev))))
      }
      socket.onclose = () => {
        this.#state = 'closed'
        if (this.#authTimer !== null) clearTimeout(this.#authTimer)
        this.#authTimer = null
        settle(() => reject(new Error('alpaca stream closed before it was ready')))
      }
    })
    return ready
  }

  /** 有序关闭（幂等）。 */
  close(): void {
    if (this.#authTimer !== null) clearTimeout(this.#authTimer)
    this.#authTimer = null
    const socket = this.#socket
    this.#socket = null
    this.#state = 'closed'
    try {
      socket?.close()
    } catch {
      // 关闭失败不影响状态：连接已经不在了。
    }
  }

  /** 统计：重连次数（诊断）。 */
  noteReconnect(): number {
    this.#reconnects += 1
    return this.#reconnects
  }

  /** 重连延迟（毫秒，供调用方自己排程；本类不自动重连，避免后台定时器）。 */
  get reconnectDelayMs(): number {
    return this.#reconnectDelayMs
  }

  private send(payload: unknown): void {
    const socket = this.#socket
    if (socket === null) throw new Error('alpaca stream socket is not open')
    socket.send(JSON.stringify(payload))
  }
}

/** 宿主有全局 WebSocket 就用它（Node 22+）；没有返回 undefined（调用方必须注入 socket）。 */
function defaultSocketFactory(url: string): (() => SocketLike) | undefined {
  const ctor = (globalThis as { WebSocket?: new (u: string) => unknown }).WebSocket
  if (ctor === undefined) return undefined
  return () => {
    const socket = new ctor(url) as SocketLike & { binaryType?: string }
    // 官方 paper 流用二进制帧：要求 arraybuffer，onmessage 用 TextDecoder 解。
    if ('binaryType' in socket) socket.binaryType = 'arraybuffer'
    return socket
  }
}
