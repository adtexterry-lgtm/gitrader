// SPDX-License-Identifier: CPAL-1.0
// 假 TWS / IB Gateway：真 socket、真 v178 线协议（uint32BE 长度 + '\0' 分隔字段）。
// 测试全部打它；不留后台进程（每个测试 afterEach 关闭）。
// 它复算 / 校验：客户端握手范围、clientId 占用（新连接被 326 拒）、账号、整数股、tick 倍数、
// 跟踪止损百分比、超持仓卖出、未知 orderId 撤单、止损 / 子单状态、成交时间与账户。
import { createServer } from 'node:net'
import type { Server, Socket } from 'node:net'
import { asDecimal } from '@gitrader/protocol'
import { normalizeDecimal } from '@gitrader/protocol'
import type { Decimal } from '@gitrader/protocol'
import * as M from '../../src/messages'
import type { IbContract, IbContractDetails, IbExecution, IbOpenOrder, IbOrder, IbOrderStatus } from '../../src/messages'
import { API_VERSION, FrameReader } from '../../src/wire'

export interface FakeQuote {
  bid: number
  ask: number
  last: number
}

export interface FakeTwsOptions {
  /** 服务器 API 版本（握手回包里的版本）。 */
  serverVersion?: number
  serverTime?: string
  accounts?: string[]
  startOrderId?: number
  /** 合约目录：symbol → 合约详情字段（缺省字段由 buildContractDetails 补）。 */
  catalogue?: Record<string, Partial<IbContractDetails>>
  /** null = 无行情权限（回 354）。 */
  quote?: FakeQuote | null
  /** 下单行为。 */
  orderBehaviour?: 'accept' | 'fill' | 'reject' | 'inactive' | 'drop-after-order' | 'silent' | 'partial-cancel' | 'ioc-partial'
  rejectReason?: string
  rejectCode?: number
  /** 子单（parentId≠0）收下但不回任何消息。 */
  silentChildren?: boolean
  /** 第 1 次 reqAllOpenOrders 先发第一张，其余与结束帧延迟；之后整表延迟。 */
  openOrdersDelayMs?: number
  /** 账户摘要（原样回给客户端）。 */
  summary?: Record<string, string>
  positions?: Array<{ symbol: string; position: number; avgCost: number; account?: string }>
  /** 成交（REQ_EXECUTIONS 返回）。 */
  executions?: Array<{
    symbol: string
    orderId: number
    permId: number
    side: 'BOT' | 'SLD'
    shares: number
    price: number
    commission?: number
    time?: string
    execId?: string
    account?: string
    orderRef?: string
    cumQty?: number
  }>
  account?: string
  /** 连接后先推信息类消息（农场状态）。 */
  infoOnConnect?: number[]
  /** 覆盖成交时间串（缺省 '20261021 10:00:00 US/Eastern'）。 */
  execTime?: string
  /** 撤单时回固定错误（测试 135 / 161 / 10148 路径）。 */
  cancelError?: { code: number; message: string }
  /** 撤单请求完全不回（测试超时）。 */
  cancelSilent?: boolean
  /** 下单回执前先推这些警告类错误（测试警告不判拒）。 */
  warningsBeforeAck?: number[]
}

export interface ReceivedFrame {
  msgId: number
  fields: string[]
}

const DEFAULT_SUMMARY: Record<string, string> = {
  AccountType: 'INDIVIDUAL',
  NetLiquidation: '100000.00',
  TotalCashValue: '100000.00',
  AvailableFunds: '50000.00',
  BuyingPower: '100000.00',
  GrossPositionValue: '0.00',
  InitMarginReq: '0.00',
  MaintMarginReq: '0.00',
  ExcessLiquidity: '50000.00',
  Cushion: '0.50',
  DayTradesRemaining: '3',
  Leverage: '1.00',
  Currency: 'USD',
}

function buildContractDetails(symbol: string, over: Partial<IbContractDetails> = {}): IbContractDetails {
  const contract: IbContract = { ...M.stockContract(symbol), conId: 1000 + symbol.length }
  const today = '20261021'
  const tomorrow = '20261022'
  return {
    reqId: 0,
    contract,
    marketName: symbol,
    minTick: asDecimal('0.01'),
    orderTypes: 'ACTIVETIM,ADJUST,ALERT,ALGO,ALTPLUS,COND,CONDBAT,MKT,STP,STPLMT,TRAIL',
    validExchanges: 'SMART,NYSE,NASDAQ,ARCA,ISLAND',
    longName: `${symbol} Inc.`,
    industry: 'Technology',
    category: 'Computers',
    timeZoneId: 'America/New_York',
    stockType: 'COMMON',
    // 04:00-20:00 可交易，09:30-16:00 液体；20261024 休市。
    tradingHours: `${today}:0400-${today}:2000;${tomorrow}:0400-${tomorrow}:2000;20261023:0400-20261023:2000;20261024:CLOSED;`,
    liquidHours: `${today}:0930-${today}:1600;${tomorrow}:0930-${tomorrow}:1600;20261023:0930-20261023:1600;`,
    ...over,
  }
}

function parseContract(fields: readonly string[], start: number): IbContract {
  const at = (i: number): string => fields[start + i] ?? ''
  return {
    conId: Number(at(0)) || 0,
    symbol: at(1),
    secType: at(2),
    lastTradeDate: at(3),
    strike: at(4) === '' ? '0' : at(4),
    right: at(5),
    multiplier: at(6),
    exchange: at(7),
    primaryExchange: at(8),
    currency: at(9),
    localSymbol: at(10),
    tradingClass: at(11),
  }
}

function decAt(fields: readonly string[], index: number): Decimal | undefined {
  const text = fields[index]
  if (text === undefined || text === '' || Number(text) >= 1e300) return undefined
  return normalizeDecimal(text)
}

const intAt = (fields: readonly string[], index: number): number => Number(fields[index] ?? '0')

// placeOrder @ v178 的关键下标（与 src/messages.placeOrder 的字段表对齐）。
const P_ORDER_ID = 1
const P_CONTRACT = 2
const P_ACTION = 16
const P_TOTAL_QTY = 17
const P_ORDER_TYPE = 18
const P_LMT = 19
const P_AUX = 20
const P_TIF = 21
const P_ACCOUNT = 23
const P_OPEN_CLOSE = 24
const P_ORDER_REF = 26
const P_TRANSMIT = 27
const P_PARENT_ID = 28
const P_OUTSIDE_RTH = 33
const P_GOOD_TILL_DATE = 38
const P_TRAIL_STOP = 68
const P_TRAIL_PCT = 69
const PLACE_ORDER_FIELDS = 114

/** 按出站 placeOrder 字段表按下标读；字段数不对由调用方先拒。 */
export function parsePlaceOrder(fields: readonly string[]): { contract: IbContract; order: IbOrder } {
  const contract = parseContract(fields, P_CONTRACT)
  const orderId = intAt(fields, P_ORDER_ID)
  const order: IbOrder = {
    orderId,
    action: fields[P_ACTION] === 'SELL' ? 'SELL' : 'BUY',
    totalQuantity: decAt(fields, P_TOTAL_QTY) ?? asDecimal('0'),
    orderType: fields[P_ORDER_TYPE] ?? 'LMT',
    ...(decAt(fields, P_LMT) !== undefined ? { lmtPrice: decAt(fields, P_LMT)! } : {}),
    ...(decAt(fields, P_AUX) !== undefined ? { auxPrice: decAt(fields, P_AUX)! } : {}),
    tif: fields[P_TIF] ?? 'DAY',
    ocaGroup: fields[22] ?? '',
    account: fields[P_ACCOUNT] ?? '',
    orderRef: fields[P_ORDER_REF] ?? '',
    transmit: fields[P_TRANSMIT] !== '0',
    parentId: intAt(fields, P_PARENT_ID),
    outsideRth: fields[P_OUTSIDE_RTH] === '1',
    goodTillDate: fields[P_GOOD_TILL_DATE] ?? '',
    ...(decAt(fields, P_TRAIL_STOP) !== undefined ? { trailStopPrice: decAt(fields, P_TRAIL_STOP)! } : {}),
    ...(decAt(fields, P_TRAIL_PCT) !== undefined ? { trailingPercent: decAt(fields, P_TRAIL_PCT)! } : {}),
  }
  void P_OPEN_CLOSE
  return { contract, order }
}

export class FakeTws {
  readonly options: FakeTwsOptions
  readonly received: ReceivedFrame[] = []
  readonly orders: IbOrder[] = []
  readonly cancelled: number[] = []
  readonly startApiClientIds: number[] = []
  readonly #server: Server
  readonly #sockets = new Set<Socket>()
  readonly #clientIdBySocket = new Map<Socket, number>()
  readonly #openOrders = new Map<number, IbOpenOrder>()
  readonly #statuses = new Map<number, IbOrderStatus>()
  readonly #permByOrderId = new Map<number, number>()
  readonly #pendingTransmit = new Map<number, number[]>()
  readonly #positions: Array<{ symbol: string; position: number; avgCost: number; account?: string }>
  #nextOrderId: number
  #permSeq = 5000
  #execSeq = 0
  #openOrdersReqCount = 0
  #dropped = 0
  #globalCancelCount = 0
  #lastErrorReqId = -1

  private constructor(server: Server, o: FakeTwsOptions) {
    this.#server = server
    this.options = o
    this.#nextOrderId = o.startOrderId ?? 100
    this.#positions = [...(o.positions ?? [])]
    server.on('connection', (socket) => this.#onConnection(socket))
  }

  static async start(o: FakeTwsOptions = {}): Promise<FakeTws> {
    const server = createServer()
    const tws = new FakeTws(server, o)
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
    return tws
  }

  get port(): number {
    const addr = this.#server.address()
    if (addr === null || typeof addr === 'string') return 0
    return addr.port
  }

  get connections(): number {
    return this.#sockets.size
  }

  get droppedConnections(): number {
    return this.#dropped
  }

  get globalCancelCount(): number {
    return this.#globalCancelCount
  }

  get lastErrorReqId(): number {
    return this.#lastErrorReqId
  }

  get liveClientIds(): number[] {
    return [...this.#sockets].map((s) => this.#clientIdBySocket.get(s)).filter((v): v is number => v !== undefined)
  }

  /** 找某个消息号收到的帧（测试断言客户端发了什么）。 */
  frames(msgId: number): ReceivedFrame[] {
    return this.received.filter((f) => f.msgId === msgId)
  }

  ordersReceived(): IbOrder[] {
    return [...this.orders]
  }

  /** 往簿里塞一张 clientId 0 的手动单。 */
  addForeignOrder(o: IbOpenOrder): void {
    const oo: IbOpenOrder = { ...o, clientId: 0, status: o.status === '' ? 'Submitted' : o.status }
    this.#openOrders.set(oo.orderId, oo)
    if (oo.permId !== 0) this.#permByOrderId.set(oo.orderId, oo.permId)
  }

  /** 服务端强行断开（模拟 TWS 掉线）。 */
  dropAll(): void {
    for (const s of this.#sockets) {
      this.#dropped += 1
      s.destroy()
    }
    this.#sockets.clear()
    this.#clientIdBySocket.clear()
  }

  /** 直接往第一个连接写原始字节（测客户端的容错）。 */
  sendRaw(buf: Buffer): void {
    this.#send(this.#anySocket(), buf)
  }

  /** 主动推一条错误（测试信息 / 警告类不当错误）。 */
  emitError(code: number, message: string, reqId = -1): void {
    this.#send(this.#anySocket(), M.errMsg(reqId, code, message))
  }

  async stop(): Promise<void> {
    this.dropAll()
    await new Promise<void>((resolve) => this.#server.close(() => resolve()))
  }

  // ---- 连接处理 ----

  #onConnection(socket: Socket): void {
    this.#sockets.add(socket)
    let greeted = false
    let handshakeBuf = Buffer.alloc(0)
    const reader = new FrameReader()

    socket.on('data', (chunk: Buffer) => {
      try {
        if (!greeted) {
          handshakeBuf = Buffer.concat([handshakeBuf, chunk])
          if (handshakeBuf.length < 8) return
          if (handshakeBuf.subarray(0, 4).toString('latin1') !== 'API\0') {
            socket.destroy()
            return
          }
          const versionLen = handshakeBuf.readUInt32BE(4)
          if (handshakeBuf.length < 8 + versionLen) return
          const versions = handshakeBuf.subarray(8, 8 + versionLen).toString('latin1')
          this.received.push({ msgId: -1, fields: [versions] })
          const rest = handshakeBuf.subarray(8 + versionLen)
          handshakeBuf = Buffer.alloc(0)
          greeted = true
          socket.write(M.handshakeReply(this.options.serverVersion ?? API_VERSION, this.options.serverTime ?? '20261021 09:30:00 EST'))
          const range = /^v(\d+)\.\.(\d+)$/.exec(versions)
          const supports = range !== null && Number(range[1]) <= API_VERSION && Number(range[2]) >= API_VERSION
          if (!supports) {
            socket.destroy()
            return
          }
          if (rest.length > 0) this.#handleFrames(socket, reader.push(rest))
          return
        }
        this.#handleFrames(socket, reader.push(chunk))
      } catch {
        socket.destroy()
      }
    })

    socket.on('close', () => {
      this.#sockets.delete(socket)
      this.#clientIdBySocket.delete(socket)
    })
    socket.on('error', () => {
      this.#sockets.delete(socket)
      this.#clientIdBySocket.delete(socket)
    })
  }

  #handleFrames(socket: Socket, frames: string[][]): void {
    for (const fields of frames) {
      const msgId = Number(fields[0])
      this.received.push({ msgId, fields })
      switch (msgId) {
        case M.OUT.START_API: {
          const clientId = intAt(fields, 2)
          const duplicate = [...this.#clientIdBySocket.entries()].some(([other, id]) => other !== socket && id === clientId)
          if (duplicate) {
            this.#send(socket, M.errMsg(-1, 326, 'Unable to connect as the client id is already in use. Retry with a unique client id.'))
            socket.destroy()
            return
          }
          this.startApiClientIds.push(clientId)
          this.#clientIdBySocket.set(socket, clientId)
          for (const code of this.options.infoOnConnect ?? []) {
            const text = code === 2104 ? 'Market data farm connection is OK:usfarm' : code === 2158 ? 'Sec-def data farm connection is OK:secdefnj' : `info ${String(code)}`
            this.#send(socket, M.errMsg(-1, code, text))
          }
          this.#send(socket, M.managedAccounts((this.options.accounts ?? ['DU1234567']).join(',')))
          this.#send(socket, M.nextValidId(this.#nextOrderId))
          return
        }
        case M.OUT.REQ_CURRENT_TIME:
          this.#send(socket, M.currentTime(Math.floor(Date.now() / 1000)))
          return
        case M.OUT.REQ_GLOBAL_CANCEL: {
          this.#globalCancelCount += 1
          for (const [orderId, oo] of [...this.#openOrders.entries()]) {
            this.#send(socket, M.orderStatusMessage(this.#statusOf(oo, 'Cancelled')))
            this.#openOrders.delete(orderId)
            this.cancelled.push(orderId)
          }
          return
        }
        case M.OUT.CANCEL_ORDER: {
          const orderId = intAt(fields, 2)
          if (this.options.cancelSilent === true) return
          if (this.options.cancelError !== undefined) {
            this.#lastErrorReqId = orderId
            this.#send(socket, M.errMsg(orderId, this.options.cancelError.code, this.options.cancelError.message))
            return
          }
          const oo = this.#openOrders.get(orderId)
          if (oo === undefined) {
            this.#lastErrorReqId = orderId
            this.#send(socket, M.errMsg(orderId, 135, `Can't find order with ID =${String(orderId)}`))
            return
          }
          this.#openOrders.delete(orderId)
          this.cancelled.push(orderId)
          this.#send(socket, M.orderStatusMessage(this.#statusOf(oo, 'Cancelled')))
          this.#send(socket, M.errMsg(orderId, 202, 'Order Canceled - reason:'))
          return
        }
        default:
          break
      }
      this.#handleRest(socket, fields)
    }
  }

  /** 处理需要逐消息解析的请求（合约 / 下单 / 查询）。 */
  #handleRest(socket: Socket, fields: string[]): void {
    const msgId = Number(fields[0])
    switch (msgId) {
      case M.OUT.REQ_CONTRACT_DATA: {
        const reqId = intAt(fields, 2)
        const contract = parseContract(fields, 3)
        const symbol = contract.symbol.toUpperCase()
        const over = this.options.catalogue?.[symbol]
        if (over === undefined && this.options.catalogue !== undefined) {
          this.#lastErrorReqId = reqId
          this.#send(socket, M.errMsg(reqId, 200, `No security definition has been found for the request (${symbol})`))
          this.#send(socket, M.contractDataEnd(reqId))
          return
        }
        const cd = buildContractDetails(symbol, { ...over, reqId })
        this.#send(socket, M.contractDataMessage(cd))
        this.#send(socket, M.contractDataEnd(reqId))
        return
      }
      case M.OUT.PLACE_ORDER: {
        if (fields.length !== PLACE_ORDER_FIELDS) {
          const orderId = intAt(fields, P_ORDER_ID)
          this.#lastErrorReqId = orderId
          this.#send(socket, M.errMsg(orderId, 321, 'Error validating request: field count'))
          return
        }
        const { contract, order } = parsePlaceOrder(fields)
        this.#placeOrder(socket, contract, order)
        return
      }
      case M.OUT.REQ_ALL_OPEN_ORDERS:
      case M.OUT.REQ_OPEN_ORDERS: {
        const rows = [...this.#openOrders.values()]
        const sendOne = (oo: IbOpenOrder): void => {
          this.#send(socket, M.openOrderMessage(oo))
          this.#send(socket, M.orderStatusMessage(this.#statusOf(oo, oo.status)))
        }
        const sendEnd = (): void => this.#send(socket, M.openOrderEnd())
        const delay = this.options.openOrdersDelayMs
        if (msgId !== M.OUT.REQ_ALL_OPEN_ORDERS || delay === undefined || delay <= 0) {
          rows.forEach(sendOne)
          sendEnd()
          return
        }
        this.#openOrdersReqCount += 1
        const first = this.#openOrdersReqCount === 1 ? rows[0] : undefined
        const rest = this.#openOrdersReqCount === 1 ? rows.slice(1) : rows
        if (first !== undefined) sendOne(first)
        const timer = setTimeout(() => {
          rest.forEach(sendOne)
          sendEnd()
        }, delay)
        timer.unref()
        return
      }
      case M.OUT.REQ_POSITIONS: {
        for (const p of this.#positions) {
          this.#send(
            socket,
            M.positionMessage({
              account: p.account ?? this.#account(),
              contract: M.stockContract(p.symbol),
              position: asDecimal(String(p.position)),
              avgCost: asDecimal(String(p.avgCost)),
            }),
          )
        }
        this.#send(socket, M.positionEnd())
        return
      }
      case M.OUT.CANCEL_POSITIONS:
        return
      case M.OUT.REQ_ACCOUNT_SUMMARY: {
        const reqId = intAt(fields, 2)
        const summary = this.options.summary ?? DEFAULT_SUMMARY
        for (const account of this.options.accounts ?? [this.#account()]) {
          for (const [tag, value] of Object.entries(summary)) {
            this.#send(socket, M.accountSummaryMessage({ reqId, account, tag, value, currency: 'USD' }))
          }
        }
        this.#send(socket, M.accountSummaryEnd(reqId))
        return
      }
      case M.OUT.CANCEL_ACCOUNT_SUMMARY:
        return
      case M.OUT.REQ_EXECUTIONS: {
        const reqId = intAt(fields, 2)
        for (const x of this.options.executions ?? []) {
          this.#execSeq += 1
          const execution: IbExecution = {
            reqId,
            orderId: x.orderId,
            contract: M.stockContract(x.symbol),
            execId: x.execId ?? `0000e${String(this.#execSeq).padStart(3, '0')}`,
            time: x.time ?? this.options.execTime ?? '20261021 10:00:00 US/Eastern',
            acctNumber: x.account ?? this.#account(),
            exchange: 'ISLAND',
            side: x.side,
            shares: asDecimal(String(x.shares)),
            price: asDecimal(String(x.price)),
            permId: x.permId,
            clientId: 7,
            liquidation: 0,
            cumQty: asDecimal(String(x.cumQty ?? x.shares)),
            avgPrice: asDecimal(String(x.price)),
            orderRef: x.orderRef ?? '',
            lastLiquidity: 1,
          }
          this.#send(socket, M.executionDataMessage(execution))
          this.#send(socket, M.commissionReportMessage({ execId: execution.execId, ...(x.commission !== undefined ? { commission: asDecimal(String(x.commission)) } : {}), currency: 'USD' }))
        }
        this.#send(socket, M.executionDataEnd(reqId))
        return
      }
      case M.OUT.REQ_MKT_DATA: {
        const tickerId = intAt(fields, 2)
        const contract = parseContract(fields, 3)
        const q = this.options.quote
        if (q === null) {
          this.#lastErrorReqId = tickerId
          this.#send(socket, M.errMsg(tickerId, 354, `Requested market data is not subscribed. ${contract.symbol}`))
          return
        }
        const quote = q ?? { bid: 100, ask: 100.02, last: 100.01 }
        this.#send(socket, M.tickPrice(tickerId, M.TICK.BID, String(quote.bid), '100'))
        this.#send(socket, M.tickPrice(tickerId, M.TICK.ASK, String(quote.ask), '100'))
        this.#send(socket, M.tickPrice(tickerId, M.TICK.LAST, String(quote.last), '100'))
        this.#send(socket, M.tickSize(tickerId, M.TICK.BID_SIZE, '100'))
        this.#send(socket, M.tickSize(tickerId, M.TICK.ASK_SIZE, '100'))
        this.#send(socket, M.tickSnapshotEnd(tickerId))
        return
      }
      default:
        return
    }
  }

  #placeOrder(socket: Socket, contract: IbContract, order: IbOrder): void {
    this.orders.push(order)
    const behaviour = this.options.orderBehaviour ?? 'accept'
    const account = this.#account()
    if (order.account !== '' && order.account !== account) {
      this.#reject(socket, order.orderId, 201, `Order rejected - reason:account ${order.account} is not allowed for this session`)
      return
    }
    const quantity = Number(order.totalQuantity)
    if (!Number.isInteger(quantity) || quantity <= 0) {
      this.#reject(socket, order.orderId, 111, 'The TIF and the order type are incompatible')
      return
    }
    const lmt = order.lmtPrice !== undefined ? Number(order.lmtPrice) : 0
    if (order.orderType === 'LMT' && lmt > 0 && Math.abs(lmt * 100 - Math.round(lmt * 100)) > 1e-6) {
      this.#reject(socket, order.orderId, 110, 'The price does not conform to the minimum price variation for this contract')
      return
    }
    const trailPct = order.trailingPercent !== undefined ? Number(order.trailingPercent) : 0
    if (order.orderType === 'TRAIL' && !(trailPct > 0)) {
      this.#reject(socket, order.orderId, 321, 'Error validating request:-trailingPercent is missing')
      return
    }
    const aux = order.auxPrice !== undefined ? Number(order.auxPrice) : 0
    if (order.orderType.startsWith('STP') && !(aux > 0)) {
      this.#reject(socket, order.orderId, 321, 'Error validating request:-auxPrice (trigger) is missing')
      return
    }
    // 场所侧卖空规则：父单卖出数量超过该账户现有多头持仓 → 拒。
    const held = this.#heldFor(contract.symbol, order.account !== '' ? order.account : account)
    if (order.parentId === 0 && order.action === 'SELL' && quantity > Math.max(0, held)) {
      this.#reject(socket, order.orderId, 201, `Order rejected - reason:short sale of ${contract.symbol} is not permitted (position ${String(held)})`)
      return
    }
    if (behaviour === 'reject') {
      this.#reject(socket, order.orderId, this.options.rejectCode ?? 201, this.options.rejectReason ?? 'Order rejected - reason:risk check failed')
      return
    }
    if (behaviour === 'drop-after-order') {
      socket.destroy()
      return
    }
    const clientId = this.#clientIdBySocket.get(socket) ?? 0
    if (behaviour === 'silent') {
      this.#permSeq += 1
      this.#permByOrderId.set(order.orderId, this.#permSeq)
      this.#openOrders.set(order.orderId, this.#toOpenOrder(order, contract, clientId, 'Submitted'))
      return
    }
    if (behaviour === 'inactive') {
      const st: IbOrderStatus = {
        orderId: order.orderId,
        status: 'Inactive',
        filled: asDecimal('0'),
        remaining: order.totalQuantity,
        permId: 0,
        parentId: order.parentId,
        clientId,
        whyHeld: '',
      }
      this.#send(socket, M.orderStatusMessage(st))
      this.#send(socket, M.errMsg(order.orderId, 202, 'Order cancelled - reason:order is not active'))
      return
    }
    const key = order.parentId === 0 ? order.orderId : order.parentId
    if (!order.transmit) {
      const list = this.#pendingTransmit.get(key) ?? []
      list.push(order.orderId)
      this.#pendingTransmit.set(key, list)
      return
    }
    const group = order.parentId === 0 ? [order.orderId] : [...(this.#pendingTransmit.get(key) ?? []), order.orderId]
    this.#pendingTransmit.delete(key)
    for (const orderId of group) {
      const o = this.orders.find((x) => x.orderId === orderId)
      if (o === undefined) continue
      const isChild = o.parentId !== 0
      const stopLike = o.orderType === 'STP' || o.orderType === 'STP LMT' || o.orderType === 'TRAIL'
      const fill = behaviour === 'fill' && !isChild
      const partial = behaviour === 'partial-cancel' && !isChild
      const status = partial ? 'Cancelled' : fill ? 'Filled' : isChild || stopLike ? 'PreSubmitted' : 'Submitted'
      this.#permSeq += 1
      this.#permByOrderId.set(orderId, this.#permSeq)
      const oo = this.#toOpenOrder(o, contract, clientId, status)
      if (behaviour === 'ioc-partial' && !isChild && o.tif.toUpperCase() === 'IOC') {
        const quantity = Number(o.totalQuantity)
        const half = Math.max(1, Math.floor(quantity / 2))
        const iocStatus: IbOrderStatus = {
          orderId,
          status: 'Cancelled',
          filled: asDecimal(String(half)),
          remaining: asDecimal(String(Math.max(0, quantity - half))),
          avgFillPrice: o.lmtPrice ?? asDecimal('100'),
          lastFillPrice: o.lmtPrice ?? asDecimal('100'),
          permId: this.#permByOrderId.get(orderId) ?? this.#permSeq,
          parentId: o.parentId,
          clientId,
          whyHeld: '',
        }
        this.#statuses.set(orderId, iocStatus)
        socket.write(Buffer.concat([M.openOrderMessage(oo), M.orderStatusMessage(iocStatus), M.errMsg(orderId, 202, 'Order cancelled - reason:IOC partial fill')]))
        continue
      }
      if (this.options.silentChildren === true && isChild) {
        this.#openOrders.set(orderId, oo)
        continue
      }
      const partialFilled = partial ? (Number(o.totalQuantity) > 1 ? asDecimal('1') : o.totalQuantity) : asDecimal('0')
      const st: IbOrderStatus = {
        orderId,
        status,
        filled: fill ? o.totalQuantity : partialFilled,
        remaining: fill ? asDecimal('0') : partial ? (Number(o.totalQuantity) > 1 ? asDecimal(String(Number(o.totalQuantity) - 1)) : asDecimal('0')) : o.totalQuantity,
        ...(fill || partial ? { avgFillPrice: o.lmtPrice ?? asDecimal('100'), lastFillPrice: o.lmtPrice ?? asDecimal('100') } : {}),
        permId: this.#permByOrderId.get(orderId) ?? this.#permSeq,
        parentId: o.parentId,
        clientId,
        whyHeld: '',
      }
      this.#statuses.set(orderId, st)
      for (const code of this.options.warningsBeforeAck ?? []) {
        this.#send(socket, M.errMsg(orderId, code, `warning ${String(code)}`))
      }
      this.#send(socket, M.openOrderMessage(oo))
      this.#send(socket, M.orderStatusMessage(st))
      if (!fill && status !== 'Cancelled') this.#openOrders.set(orderId, oo)
    }
    this.#send(socket, M.openOrderEnd())
  }

  #toOpenOrder(order: IbOrder, contract: IbContract, clientId: number, status: string): IbOpenOrder {
    return {
      orderId: order.orderId,
      contract,
      action: order.action,
      totalQuantity: order.totalQuantity,
      orderType: order.orderType,
      ...(order.lmtPrice !== undefined ? { lmtPrice: order.lmtPrice } : {}),
      ...(order.auxPrice !== undefined ? { auxPrice: order.auxPrice } : {}),
      tif: order.tif,
      ocaGroup: order.ocaGroup,
      account: order.account !== '' ? order.account : this.#account(),
      orderRef: order.orderRef,
      clientId,
      permId: this.#permByOrderId.get(order.orderId) ?? 0,
      outsideRth: order.outsideRth,
      goodTillDate: order.goodTillDate,
      parentId: order.parentId,
      ...(order.trailStopPrice !== undefined ? { trailStopPrice: order.trailStopPrice } : {}),
      ...(order.trailingPercent !== undefined ? { trailingPercent: order.trailingPercent } : {}),
      status,
      warningText: '',
    }
  }

  #reject(socket: Socket, orderId: number, code: number, message: string): void {
    this.#lastErrorReqId = orderId
    this.#send(socket, M.errMsg(orderId, code, message))
    const st: IbOrderStatus = {
      orderId,
      status: 'Inactive',
      filled: asDecimal('0'),
      remaining: asDecimal('0'),
      permId: 0,
      parentId: 0,
      clientId: 7,
      whyHeld: '',
    }
    this.#send(socket, M.orderStatusMessage(st))
  }

  #statusOf(oo: IbOpenOrder, status: string): IbOrderStatus {
    return {
      orderId: oo.orderId,
      status,
      filled: asDecimal('0'),
      remaining: oo.totalQuantity,
      permId: oo.permId,
      parentId: oo.parentId,
      clientId: oo.clientId,
      whyHeld: '',
    }
  }

  #heldFor(symbol: string, account: string): number {
    return this.#positions
      .filter((p) => p.symbol === symbol && (p.account === undefined || p.account === account))
      .reduce((sum, p) => sum + p.position, 0)
  }

  #account(): string {
    return this.options.account ?? (this.options.accounts ?? ['DU1234567'])[0]!
  }

  #anySocket(): Socket | undefined {
    return [...this.#sockets][0]
  }

  #send(socket: Socket | undefined, buf: Buffer): void {
    if (socket === undefined) return
    if (socket.destroyed) return
    socket.write(buf)
  }
}
