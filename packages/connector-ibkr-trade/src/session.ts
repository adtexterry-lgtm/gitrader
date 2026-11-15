// SPDX-License-Identifier: CPAL-1.0
// 一条到 TWS / IB Gateway 的 socket 会话：握手 → START_API → 帧收发 → 事件分发 → 断线重连状态。
// 参照 ib_async client.py / decoder.py（BSD-2-Clause）的会话结构；未复制源码。
// 硬规矩：
//   · 只连回环地址（ids.isLoopbackHost）；非回环在构造时拒绝，不走 Client Portal Web API；
//   · 只支持 API 服务器版本 178；握手回的版本不是 178 → 5001，关连接、不重连；
//   · 同一个 clientId 被占用时 TWS 回 326：新连接失败（VENUE_AUTH），不抢连；
//   · 断线：上报 Problem（3003），并按退避重连；重连成功不等于订单没成交；
//   · 信息类 / 警告类消息（isNonError）不让挂起请求失败。
import { connect as netConnect } from 'node:net'
import type { Socket } from 'node:net'
import { makeProblem } from '@gitrader/protocol'
import type { Problem } from '@gitrader/protocol'
import { IbError, isConnectionLost, isNonError, problemForIbError } from './errors'
import type { HintedProblem } from './errors'
import { environmentOf, isLoopbackHost, modeOf, VENUE } from './ids'
import type { IbkrMode } from './ids'
import * as M from './messages'
import type {
  IbAccountSummary,
  IbCommissionReport,
  IbContractDetails,
  IbExecution,
  IbOpenOrder,
  IbOrderStatus,
  IbPosition,
} from './messages'
import { FrameReader, encodeHandshake, negotiateVersion, parseHandshakeReply } from './wire'

export type SessionState = 'idle' | 'connecting' | 'handshaking' | 'connected' | 'reconnecting' | 'closed'

export interface IbErrorEvent {
  reqId: number
  code: number
  message: string
  problem?: Problem
  hint?: string
  /** 信息 / 警告类：只有它才会 problem === undefined。 */
  info: boolean
}

export interface WireHandlers {
  connect?(info: { serverVersion: number; apiVersion: number; serverTime: string }): void
  disconnect?(info: { code: number; message: string; unexpected: boolean; willReconnect: boolean }): void
  nextValidId?(orderId: number): void
  managedAccounts?(accounts: string[]): void
  orderStatus?(s: IbOrderStatus): void
  openOrder?(o: IbOpenOrder): void
  openOrderEnd?(): void
  execDetails?(e: IbExecution): void
  execDetailsEnd?(reqId: number): void
  commissionReport?(r: IbCommissionReport): void
  position?(p: IbPosition): void
  positionEnd?(): void
  accountSummary?(s: IbAccountSummary): void
  accountSummaryEnd?(reqId: number): void
  contractDetails?(cd: IbContractDetails): void
  contractDetailsEnd?(reqId: number): void
  tickPrice?(t: { tickerId: number; tickType: number; price: number; size: number }): void
  tickSize?(t: { tickerId: number; tickType: number; size: number }): void
  tickSnapshotEnd?(tickerId: number): void
  currentTime?(epochMs: number): void
  error?(e: IbErrorEvent): void
  /**
   * 订单状态 / 成交回报帧解码失败：这一帧丢了，状态回执就没有了。
   * 必须点名 orderId / reqId 上报（不能只留一行 warn），内核据此对账而不是等 ack 超时。
   */
  statusFrameLost?(info: { kind: 'order_status' | 'execution'; orderId?: number; reqId?: number; message: string }): void
  /** 帧解析失败 / 无法识别的消息（不让会话死掉）。 */
  warn?(message: string): void
}

export interface IbSessionOptions {
  host?: string
  port: number
  clientId?: number
  mode?: IbkrMode
  connectTimeoutMs?: number
  requestTimeoutMs?: number
  /** 每秒最多发出的消息条数（IB 官方上限 50/s；留余量 45）。 */
  maxMessagesPerSecond?: number
  reconnect?: { enabled?: boolean; maxAttempts?: number; baseDelayMs?: number }
  /** 注入连接工厂（测试 / 诊断用；缺省 net.connect）。 */
  connectImpl?: (host: string, port: number) => Socket
  clock?: () => number
  /** 重连成功后回调（上层据此重同步挂单 / 持仓 / 成交）。 */
  onResync?: () => void
}

interface PendingRequest<T> {
  label: string
  initial: T
  /** 收到一帧：返回 true 表示收齐。 */
  onFrame(fields: string[], acc: T): boolean
  /** 这条 ERR_MSG 是否属于本请求。 */
  matchError?(reqId: number, code: number): boolean
  resolve(value: T): void
  reject(e: unknown): void
  timer: ReturnType<typeof setTimeout> | undefined
}

interface ConnectWaiter {
  resolve(value: { serverVersion: number; apiVersion: number }): void
  reject(e: unknown): void
  timer: ReturnType<typeof setTimeout>
}

const DEFAULT_REQUEST_TIMEOUT_MS = 5000
const DEFAULT_CONNECT_TIMEOUT_MS = 8000

function intField(fields: readonly string[], index: number): number {
  const text = fields[index]
  if (text === undefined) throw new RangeError(`wire field ${String(index)} is missing`)
  const value = Number(text)
  if (!Number.isInteger(value)) throw new RangeError(`wire field ${String(index)} is not an integer: ${JSON.stringify(text)}`)
  return value
}

export class IbSession {
  readonly host: string
  readonly port: number
  readonly clientId: number
  readonly mode: IbkrMode
  readonly environment
  #state: SessionState = 'idle'
  #socket: Socket | undefined
  #reader = new FrameReader()
  #handshakeDone = false
  #serverVersion = 0
  #apiVersion = 0
  #serverTime = ''
  #handlers: WireHandlers = {}
  #pending: PendingRequest<unknown>[] = []
  #nextReqId = 1_000_000
  #nextOrderId = 0
  #accounts: string[] = []
  #sendTimes: number[] = []
  #reconnectAttempts = 0
  #closedByUser = false
  #connectWaiter: ConnectWaiter | undefined
  #nextValidWaiters = new Set<() => void>()
  #lastError: Problem | undefined
  /** 解码失败、因而丢失的订单状态 / 成交回报帧数（L2-13 诊断口）。 */
  #lostStatusFrames = 0
  readonly #o: IbSessionOptions
  readonly #clock: () => number

  constructor(o: IbSessionOptions) {
    const host = o.host ?? '127.0.0.1'
    if (!isLoopbackHost(host)) {
      throw IbError.of(
        'VENUE_AUTH',
        `IBKR socket connections must target a loopback address (got ${JSON.stringify(host)})`,
        '本包只连本机 TWS / IB Gateway（127.0.0.1 / localhost）；远程访问请走 SSH 隧道到本机端口，不使用 Client Portal Web API',
      )
    }
    this.#o = o
    this.host = host
    this.port = o.port
    this.clientId = o.clientId ?? 7
    this.mode = o.mode ?? modeOf(environmentOf(o.mode ?? 'paper'))
    this.environment = environmentOf(this.mode)
    this.#clock = o.clock ?? (() => Date.now())
  }

  get state(): SessionState {
    return this.#state
  }

  get connected(): boolean {
    return this.#state === 'connected'
  }

  get serverVersion(): number {
    return this.#serverVersion
  }

  get apiVersion(): number {
    return this.#apiVersion
  }

  get serverTime(): string {
    return this.#serverTime
  }

  get nextOrderId(): number {
    return this.#nextOrderId
  }

  get accounts(): readonly string[] {
    return this.#accounts
  }

  get lastError(): Problem | undefined {
    return this.#lastError
  }

  /** 解码失败而丢失的订单状态 / 成交回报帧数（0 = 本次会话状态回执完整）。 */
  get lostStatusFrames(): number {
    return this.#lostStatusFrames
  }

  /** 注册回调。叠加而不是覆盖（多模块共用一条会话）。 */
  on(handlers: WireHandlers): void {
    const target = this.#handlers as Record<string, ((...args: unknown[]) => void) | undefined>
    const source = handlers as Record<string, ((...args: unknown[]) => void) | undefined>
    for (const key of Object.keys(source)) {
      const next = source[key]
      if (next === undefined) continue
      const prev = target[key]
      target[key] = prev === undefined ? next : (...args: unknown[]) => {
        prev(...args)
        next(...args)
      }
    }
  }

  allocateReqId(): number {
    this.#nextReqId += 1
    return this.#nextReqId
  }

  /** 用掉一个由 nextValidId 发下来的订单号（IB 要求客户端不重号、单调递增）。 */
  reserveOrderId(orderId: number): void {
    if (orderId >= this.#nextOrderId) this.#nextOrderId = orderId + 1
  }

  /** 会话层：建连 + 握手 + START_API + 等 nextValidId。 */
  async connect(): Promise<{ serverVersion: number; apiVersion: number }> {
    if (this.#state === 'connected') return { serverVersion: this.#serverVersion, apiVersion: this.#apiVersion }
    this.#closedByUser = false
    this.#state = 'connecting'
    const factory = this.#o.connectImpl ?? ((h: string, p: number) => netConnect({ host: h, port: p }))
    const socket = factory(this.host, this.port)
    this.#socket = socket
    this.#reader = new FrameReader()
    this.#handshakeDone = false
    socket.setNoDelay(true)

    const connected = new Promise<{ serverVersion: number; apiVersion: number }>((resolve, reject) => {
      const timeoutMs = this.#o.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
      const timer = setTimeout(() => {
        this.#connectWaiter = undefined
        reject(
          IbError.of(
            'VENUE_UNAVAILABLE',
            `IBKR connect timed out after ${String(timeoutMs)} ms (${this.host}:${String(this.port)}, clientId ${String(this.clientId)})`,
            '确认 TWS / IB Gateway 已启动并登录、API 端口已启用（模拟 TWS 7497 / Gateway 4002），且端口与模式对应',
          ),
        )
      }, timeoutMs)
      this.#connectWaiter = { resolve, reject, timer }
    })

    socket.on('connect', () => this.#onSocketConnect(socket))
    socket.on('data', (chunk: Buffer) => this.#onData(chunk))
    socket.on('error', (e: Error) => this.#onSocketError(e))
    socket.on('close', () => this.#onSocketClose())

    return connected
  }

  /** 等 nextValidId（有界 800 ms；等不到也让连接成功，只是暂时没有可用的 orderId）。 */
  #waitNextValidId(timeoutMs = 800): Promise<void> {
    if (this.#nextOrderId > 0) return Promise.resolve()
    return new Promise<void>((resolve) => {
      let done = false
      const finish = (): void => {
        if (done) return
        done = true
        clearTimeout(timer)
        this.#nextValidWaiters.delete(finish)
        resolve()
      }
      const timer = setTimeout(() => {
        this.#handlers.warn?.('nextValidId did not arrive within 800 ms; order submission will wait for it')
        finish()
      }, timeoutMs)
      timer.unref?.()
      this.#nextValidWaiters.add(finish)
    })
  }

  #clearConnectWaiter(): ConnectWaiter | undefined {
    const waiter = this.#connectWaiter
    this.#connectWaiter = undefined
    if (waiter !== undefined) clearTimeout(waiter.timer)
    return waiter
  }

  #failConnect(e: unknown, fatal: boolean): void {
    if (fatal) {
      this.#state = 'closed'
      this.#closedByUser = true
    }
    const waiter = this.#clearConnectWaiter()
    waiter?.reject(e)
  }

  #onSocketConnect(socket: Socket): void {
    if (socket !== this.#socket) return
    this.#state = 'handshaking'
    socket.write(encodeHandshake())
  }

  #onSocketError(e: Error): void {
    this.#lastError = makeProblem('VENUE_UNAVAILABLE', `IBKR socket error: ${e.message}`, {
      venue: { id: VENUE, message: e.message },
    })
    this.#failAllPending(new IbError(this.#lastError, '连接出错：等重连后按 orderRef 对账；不要重发订单'))
    this.#handlers.warn?.(`socket error: ${e.message}`)
  }

  #onData(chunk: Buffer): void {
    try {
      const frames = this.#reader.push(chunk)
      if (!this.#handshakeDone) {
        const first = frames.shift()
        if (first === undefined) return
        this.#handshakeDone = true
        this.#onHandshake(first)
      }
      for (const fields of frames) this.#dispatch(fields)
    } catch (e) {
      this.#handlers.warn?.(`frame decode failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  #onHandshake(fields: string[]): void {
    const reply = parseHandshakeReply(fields)
    if (reply === undefined) {
      const problem = makeProblem('VERSION_UNSUPPORTED', 'IBKR handshake reply is not a 2-field version message', {
        venue: { id: VENUE, message: fields.join('|') },
      })
      this.#failConnect(new IbError(problem, '服务器版本无法识别：升级 TWS / IB Gateway（本包只支持服务器版本 178）'), true)
      this.#socket?.destroy()
      return
    }
    this.#serverVersion = reply.serverVersion
    this.#serverTime = reply.connectionTime
    const negotiated = negotiateVersion(reply.serverVersion)
    if (!negotiated.ok) {
      const problem = makeProblem('VERSION_UNSUPPORTED', `IBKR server version rejected: ${negotiated.reason ?? ''}`, {
        venue: { id: VENUE, message: reply.connectionTime },
      })
      this.#failConnect(new IbError(problem, '服务器版本不匹配：升级 TWS / IB Gateway（本包只支持服务器版本 178）'), true)
      this.#socket?.destroy()
      return
    }
    this.#apiVersion = negotiated.apiVersion
    this.#state = 'connected'
    this.#socket?.write(M.startApi(this.clientId))
    this.#handlers.connect?.({ serverVersion: this.#serverVersion, apiVersion: this.#apiVersion, serverTime: this.#serverTime })
    const waiter = this.#connectWaiter
    if (waiter === undefined) return
    void this.#waitNextValidId().then(() => {
      if (this.#connectWaiter !== waiter) return
      this.#clearConnectWaiter()
      waiter.resolve({ serverVersion: this.#serverVersion, apiVersion: this.#apiVersion })
    })
  }

  #dispatch(fields: string[]): void {
    for (const req of [...this.#pending]) {
      let done = false
      try {
        done = req.onFrame(fields, req.initial)
      } catch (e) {
        this.#settle(req)
        req.reject(e)
        continue
      }
      if (done) {
        const value = req.initial
        this.#settle(req)
        req.resolve(value)
      }
    }
    try {
      this.#route(fields)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      const msgId = Number(fields[0])
      // L2-13：订单状态 / 成交回报帧解码失败不能只留一行 warn —— 这一帧丢了，状态回执就没有了。
      // 点名 orderId / reqId 上报，并计入「状态回执缺失」计数（诊断口 #lostStatusFrames）。
      if (msgId === M.IN.ORDER_STATUS || msgId === M.IN.EXECUTION_DATA) {
        this.#lostStatusFrames += 1
        const kind = msgId === M.IN.ORDER_STATUS ? 'order_status' : 'execution'
        const ref = Number(fields[1] ?? '')
        const refText = Number.isFinite(ref) ? `${kind === 'order_status' ? 'orderId' : 'reqId'}=${String(ref)}` : 'ref unknown'
        const detail = `message ${String(msgId)} (${kind} ${refText}) handler failed: ${message}; the status receipt is lost — reconcile this order at the venue`
        this.#handlers.statusFrameLost?.({
          kind,
          ...(Number.isFinite(ref) ? (kind === 'order_status' ? { orderId: ref } : { reqId: ref }) : {}),
          message: detail,
        })
        this.#handlers.warn?.(detail)
        return
      }
      this.#handlers.warn?.(`message ${String(fields[0])} handler failed: ${message}`)
    }
  }

  #route(fields: string[]): void {
    const msgId = Number(fields[0])
    switch (msgId) {
      case M.IN.ERR_MSG: {
        const e = M.decodeError(fields)
        this.#onError({ reqId: e.reqId, code: e.code, message: e.advanced === '' ? e.message : `${e.message} [${e.advanced}]` })
        return
      }
      case M.IN.NEXT_VALID_ID: {
        const orderId = intField(fields, 2)
        this.#nextOrderId = orderId
        for (const finish of [...this.#nextValidWaiters]) finish()
        this.#handlers.nextValidId?.(orderId)
        return
      }
      case M.IN.MANAGED_ACCTS: {
        const text = fields[2] ?? ''
        this.#accounts = text.split(',').map((s) => s.trim()).filter((s) => s !== '')
        this.#handlers.managedAccounts?.([...this.#accounts])
        return
      }
      case M.IN.ORDER_STATUS: {
        const decoded = M.decodeOrderStatus(fields)
        this.#handlers.orderStatus?.(decoded)
        return
      }
      case M.IN.OPEN_ORDER: {
        const decoded = M.decodeOpenOrder(fields)
        this.#handlers.openOrder?.(decoded)
        return
      }
      case M.IN.OPEN_ORDER_END:
        this.#handlers.openOrderEnd?.()
        return
      case M.IN.EXECUTION_DATA: {
        const decoded = M.decodeExecDetails(fields)
        this.#handlers.execDetails?.(decoded)
        return
      }
      case M.IN.EXECUTION_DATA_END:
        this.#handlers.execDetailsEnd?.(intField(fields, 2))
        return
      case M.IN.COMMISSION_REPORT: {
        const decoded = M.decodeCommissionReport(fields)
        this.#handlers.commissionReport?.(decoded)
        return
      }
      case M.IN.POSITION: {
        const decoded = M.decodePosition(fields)
        this.#handlers.position?.(decoded)
        return
      }
      case M.IN.POSITION_END:
        this.#handlers.positionEnd?.()
        return
      case M.IN.ACCOUNT_SUMMARY: {
        const decoded = M.decodeAccountSummary(fields)
        this.#handlers.accountSummary?.(decoded)
        return
      }
      case M.IN.ACCOUNT_SUMMARY_END:
        this.#handlers.accountSummaryEnd?.(intField(fields, 2))
        return
      case M.IN.CONTRACT_DATA: {
        const decoded = M.decodeContractDetails(fields)
        this.#handlers.contractDetails?.(decoded)
        return
      }
      case M.IN.CONTRACT_DATA_END:
        this.#handlers.contractDetailsEnd?.(intField(fields, 2))
        return
      case M.IN.TICK_PRICE: {
        const tick = M.decodeTickPrice(fields)
        if (tick.price !== undefined) {
          this.#handlers.tickPrice?.({ tickerId: tick.tickerId, tickType: tick.tickType, price: Number(tick.price), size: Number(fields[5] ?? '0') })
        }
        return
      }
      case M.IN.TICK_SIZE:
        this.#handlers.tickSize?.({ tickerId: intField(fields, 2), tickType: intField(fields, 3), size: Number(fields[4] ?? '0') })
        return
      case M.IN.TICK_SNAPSHOT_END:
        this.#handlers.tickSnapshotEnd?.(intField(fields, 2))
        return
      case M.IN.CURRENT_TIME:
        this.#handlers.currentTime?.(intField(fields, 2) * 1000)
        return
      default:
        return
    }
  }

  #onError(ev: { reqId: number; code: number; message: string }): void {
    const info = isNonError(ev.code)
    if (!info) {
      for (const req of [...this.#pending]) {
        if (req.matchError?.(ev.reqId, ev.code) === true) {
          const hinted: HintedProblem = problemForIbError(ev.code, ev.message, ev.reqId)
          this.#settle(req)
          this.#lastError = hinted.problem
          req.reject(new IbError(hinted.problem, hinted.hint, ev.code))
        }
      }
    }
    if (ev.code === 326 || isConnectionLost(ev.code)) {
      const hinted = problemForIbError(ev.code, ev.message, ev.reqId)
      this.#lastError = hinted.problem
      this.#failConnect(new IbError(hinted.problem, hinted.hint, ev.code), ev.code === 326)
      if (ev.code === 326) this.#socket?.destroy()
    }
    const hinted = problemForIbError(ev.code, ev.message, ev.reqId)
    const event: IbErrorEvent = info
      ? { reqId: ev.reqId, code: ev.code, message: ev.message, info: true }
      : { reqId: ev.reqId, code: ev.code, message: ev.message, problem: hinted.problem, hint: hinted.hint, info: false }
    this.#handlers.error?.(event)
  }

  #onSocketClose(): void {
    const unexpected = !this.#closedByUser
    const wasConnected = this.#state === 'connected'
    this.#state = unexpected ? 'reconnecting' : 'closed'
    const problem = makeProblem('VENUE_UNAVAILABLE', `IBKR connection closed${unexpected ? ' unexpectedly' : ''}`, {
      venue: { id: VENUE, message: this.#serverTime },
    })
    this.#lastError = problem
    this.#failAllPending(new IbError(problem, '连接已断开：恢复后按 orderRef 查挂单与成交对账，不要重发订单', 1100))
    if (!wasConnected) {
      this.#failConnect(new IbError(problem, '连接在握手完成前关闭：确认 TWS / IB Gateway 的 API 设置与版本', 1100), false)
    }
    const willReconnect = unexpected && wasConnected && (this.#o.reconnect?.enabled ?? true)
    if (unexpected) this.#handlers.disconnect?.({ code: 1100, message: problem.message, unexpected, willReconnect })
    if (willReconnect) this.#scheduleReconnect()
  }

  #scheduleReconnect(): void {
    const max = this.#o.reconnect?.maxAttempts ?? 3
    if (this.#reconnectAttempts >= max) {
      this.#state = 'closed'
      this.#handlers.warn?.(`giving up after ${String(max)} reconnect attempts`)
      return
    }
    this.#reconnectAttempts += 1
    const base = this.#o.reconnect?.baseDelayMs ?? 250
    const delay = base * this.#reconnectAttempts
    const timer = setTimeout(() => {
      this.connect()
        .then(() => {
          this.#reconnectAttempts = 0
          this.#o.onResync?.()
        })
        .catch((e: unknown) => {
          this.#handlers.warn?.(`reconnect failed: ${e instanceof Error ? e.message : String(e)}`)
        })
    }, delay)
    timer.unref?.()
  }

  #failAllPending(e: unknown): void {
    for (const req of [...this.#pending]) {
      this.#settle(req)
      req.reject(e)
    }
  }

  #settle(req: PendingRequest<unknown>): void {
    const i = this.#pending.indexOf(req)
    if (i >= 0) this.#pending.splice(i, 1)
    if (req.timer !== undefined) clearTimeout(req.timer)
  }

  /** 发一条消息（本地限速：IB 每秒消息上限 50，缺省 45）。未连接 → 3003 + hint。 */
  async send(buffer: Buffer): Promise<void> {
    if (this.#socket === undefined || this.#state !== 'connected') {
      throw IbError.of(
        'VENUE_UNAVAILABLE',
        'IBKR session is not connected',
        '先 connect()；断线时不要重发订单，恢复后按 orderRef 对账',
      )
    }
    await this.#pace()
    this.#socket.write(buffer)
  }

  async #pace(): Promise<void> {
    const limit = this.#o.maxMessagesPerSecond ?? 45
    const now = this.#clock()
    this.#sendTimes = this.#sendTimes.filter((t) => now - t < 1000)
    if (this.#sendTimes.length < limit) {
      this.#sendTimes.push(now)
      return
    }
    const waitMs = 1000 - (now - (this.#sendTimes[0] ?? now)) + 1
    await new Promise((r) => setTimeout(r, Math.max(waitMs, 1)))
    this.#sendTimes.push(this.#clock())
  }

  /** 发一条请求并收集直到收齐（收齐判定由 onFrame 负责）。 */
  async request<T>(spec: {
    label: string
    /** 省略 = 只等对端推消息（例：等某张单的状态），不发任何东西。 */
    build?: Buffer | (() => Buffer)
    initial: T
    onFrame(fields: string[], acc: T): boolean
    matchError?(reqId: number, code: number): boolean
    timeoutMs?: number
  }): Promise<T> {
    const buf = spec.build === undefined ? undefined : typeof spec.build === 'function' ? spec.build() : spec.build
    const timeoutMs = spec.timeoutMs ?? this.#o.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    return new Promise<T>((resolve, reject) => {
      const req: PendingRequest<T> = {
        label: spec.label,
        initial: spec.initial,
        onFrame: spec.onFrame,
        ...(spec.matchError !== undefined ? { matchError: spec.matchError } : {}),
        resolve,
        reject,
        timer: setTimeout(() => {
          this.#settle(req as PendingRequest<unknown>)
          reject(
            IbError.of(
              'VENUE_UNAVAILABLE',
              `IBKR request ${spec.label} timed out after ${String(timeoutMs)} ms`,
              '只读请求可重试；下单类请求超时按 3006 处理，先按 orderRef 查挂单与成交再决定',
            ),
          )
        }, timeoutMs),
      }
      this.#pending.push(req as PendingRequest<unknown>)
      if (buf === undefined || buf.length === 0) return
      void this.send(buf).catch((e: unknown) => {
        this.#settle(req as PendingRequest<unknown>)
        reject(e)
      })
    })
  }

  /** 用户主动断开：不发重连。 */
  close(): void {
    this.#closedByUser = true
    this.#state = 'closed'
    this.#failConnect(IbError.of('VENUE_UNAVAILABLE', 'IBKR session closed by caller', '需要时重新 connect()'), false)
    this.#failAllPending(
      IbError.of('VENUE_UNAVAILABLE', 'IBKR session closed by caller', '需要时重新 connect()'),
    )
    this.#socket?.end()
    this.#socket?.destroy()
    this.#socket = undefined
  }
}
