// SPDX-License-Identifier: CPAL-1.0
// IBKR 交易连接器：把会话 / 合约 / 行情快照 / 账户 / 交易装成一个 VenueConnector。
// **未注册进内核、未接真网**：README 首句写明「未经真网验证，不得接实盘」。
// 形态：只连本机 TWS / IB Gateway 的 socket API（回环地址，非回环拒绝）；不走 Client Portal Web API。
// 它自己不会下单：submit / cancel / cancelAll 只在内核发起的调用里执行。
import type { Book, Candle, CandleInterval, Instrument, MarketContext, Ms, OrderIntent, VenueCapabilities } from '@gitrader/protocol'
import type {
  AccountRef,
  AccountSnapshot,
  AmendRequest,
  CancelAck,
  CancelTarget,
  Environment,
  MarketStatus,
  StartupSnapshot,
  StampedQuote,
  SubmitResult,
  SubscriptionSpec,
  TradeContext,
  Unsubscribe,
  VenueConnector,
  VenueEvent,
  VenueFill,
  VenueOpenOrder,
  VenueOrderStatus,
} from '@gitrader/protocol/connector'
import { IbkrAccounts } from './account'
import type { AccountRestrictions } from './account'
import { ibkrCapabilities } from './capabilities'
import type { CapabilityOptions } from './capabilities'
import { assertPortMode } from './compliance'
import { InstrumentBook } from './contracts'
import type { InstrumentRecord } from './contracts'
import { IbError } from './errors'
import type { IbErrorEvent } from './session'
import { AUTOMATION_CLIENT_ID, DEFAULT_HOST, DEFAULT_MODE, IB_PORTS, MANUAL_CLIENT_ID, VENUE, environmentOf } from './ids'
import type { IbkrMode } from './ids'
import { IbkrMarket } from './market'
import { DEFAULT_EXCHANGE } from './messages'
import * as M from './messages'
import type { IbContractDetails } from './messages'
import { IbSession } from './session'
import { IbkrTrading } from './trading'

export interface IbkrTradeConnectorOptions {
  /** paper（模拟盘，缺省）/ live（实盘）。 */
  mode?: IbkrMode
  /** 缺省 127.0.0.1；非回环地址直接拒绝。 */
  host?: string
  /** 缺省 7497（TWS 模拟盘）；端口必须与 mode 对应，否则拒绝（除非 allowCustomPort）。 */
  port?: number
  /** 缺省 7（自动化）；手动测试用 1。同一个 clientId 只允许一条连接。 */
  clientId?: number
  /** 交易账户（IB 多账户时必须显式给；缺省取 managedAccounts 的第一个）。 */
  account?: string
  /** 老格式成交时间不带时区时按它换算（TWS 设置里的时区，如 America/New_York）。 */
  twsTimeZone?: string
  /** 启动时要拉合约详情的标的（裸 ticker，如 AAPL）。 */
  symbols?: string[]
  /** 显式允许盘前盘后（八条 2：缺省不允许）。 */
  allowExtendedHours?: boolean
  /** 允许非标准端口（假服务器 / SSH 隧道）；缺省 false。 */
  allowCustomPort?: boolean
  clock?: () => number
  requestTimeoutMs?: number
  ackTimeoutMs?: number
  connectTimeoutMs?: number
  reconnect?: { enabled?: boolean; maxAttempts?: number; baseDelayMs?: number }
  capabilities?: CapabilityOptions
  onWarn?: (message: string) => void
  /** 信息类消息（农场状态等）与错误分开送（八条「信息类不当错误」）。 */
  onInfo?: (event: IbErrorEvent) => void
}

export class IbkrTradeConnector implements VenueConnector {
  readonly venue = VENUE
  readonly environment: Environment
  readonly mode: IbkrMode
  readonly session: IbSession
  readonly instruments = new InstrumentBook()
  readonly market: IbkrMarket
  readonly accounts: IbkrAccounts
  readonly trading: IbkrTrading
  readonly #clock: () => number
  readonly #capabilities: CapabilityOptions
  readonly #symbols: string[]
  readonly #onWarn: (m: string) => void
  readonly #onInfo: (e: IbErrorEvent) => void
  readonly #account: string | undefined

  constructor(o: IbkrTradeConnectorOptions = {}) {
    const mode = o.mode ?? DEFAULT_MODE
    const port = o.port ?? IB_PORTS.tws[mode]
    const host = o.host ?? DEFAULT_HOST
    const clientId = o.clientId ?? AUTOMATION_CLIENT_ID
    // 八条 7：模拟 / 实盘不许混——先看端口是否属于**相反**模式（单独说清），再校验未知端口。
    const otherMode: IbkrMode = mode === 'paper' ? 'live' : 'paper'
    if (port === IB_PORTS.tws[otherMode] || port === IB_PORTS.gateway[otherMode]) {
      throw IbError.of(
        'INVALID_PARAMS',
        `port ${String(port)} belongs to the ${otherMode} environment but mode=${mode}`,
        `模拟 / 实盘不许混：${mode} 用 ${String(IB_PORTS.tws[mode])}（TWS）或 ${String(IB_PORTS.gateway[mode])}（Gateway）；确认端口与 TWS 里的 API 设置一致`,
      )
    }
    if (o.allowCustomPort !== true) {
      assertPortMode(port, mode, [IB_PORTS.tws[mode], IB_PORTS.gateway[mode]])
    }
    if (!Number.isInteger(clientId) || clientId < 1 || clientId > 9999) {
      throw IbError.of('INVALID_PARAMS', `clientId must be an integer in 1..9999 (got ${String(clientId)})`, '自动化固定 7、手动固定 1；同一个 id 只允许一条连接')
    }
    this.#clock = o.clock ?? (() => Date.now())
    this.#symbols = (o.symbols ?? []).map((s) => s.trim().toUpperCase()).filter((s) => s !== '')
    this.#account = o.account
    this.#capabilities = { ...o.capabilities, ...(o.allowExtendedHours === true ? { extendedHours: true } : {}) }
    const warn = o.onWarn ?? (() => {})
    this.#onWarn = warn
    this.#onInfo = o.onInfo ?? (() => {})
    this.mode = mode
    this.environment = environmentOf(mode)
    if (clientId === MANUAL_CLIENT_ID) {
      warn(`clientId ${String(MANUAL_CLIENT_ID)} is reserved for manual / admin checks; automation should use ${String(AUTOMATION_CLIENT_ID)}`)
    }
    this.session = new IbSession({
      host,
      port,
      clientId,
      mode,
      clock: this.#clock,
      ...(o.requestTimeoutMs !== undefined ? { requestTimeoutMs: o.requestTimeoutMs } : {}),
      ...(o.connectTimeoutMs !== undefined ? { connectTimeoutMs: o.connectTimeoutMs } : {}),
      ...(o.reconnect !== undefined ? { reconnect: o.reconnect } : {}),
      onResync: () => {
        this.#onWarn('IBKR connection restored; re-qualifying instruments and re-reading account state')
        void this.#resync()
      },
    })
    this.session.on({
      error: (ev) => {
        if (ev.info) {
          this.#onInfo(ev)
          return
        }
        // 202 是本进程正在撤的这张单的撤单确认，不是告警。
        if (ev.code === 202 && this.trading.isCancelling(ev.reqId)) return
        // 连接类错误交给会话状态机；这里只把拒单 / 权限类留痕。
        if (ev.problem !== undefined) this.#onWarn(`${ev.problem.name} (IB ${String(ev.code)}): ${ev.message}`)
      },
      disconnect: (info) => this.#onWarn(`IBKR disconnected (${String(info.code)}): ${info.message}${info.willReconnect ? '; reconnecting' : ''}`),
    })
    this.market = new IbkrMarket({ session: this.session, book: this.instruments, clock: this.#clock, onWarn: warn })
    this.accounts = new IbkrAccounts({
      session: this.session,
      book: this.instruments,
      market: this.market,
      clock: this.#clock,
      ...(o.account !== undefined ? { account: o.account } : {}),
      ...(o.twsTimeZone !== undefined ? { twsTimeZone: o.twsTimeZone } : {}),
      onWarn: warn,
    })
    this.trading = new IbkrTrading({
      session: this.session,
      book: this.instruments,
      accounts: this.accounts,
      clock: this.#clock,
      ...(o.ackTimeoutMs !== undefined ? { ackTimeoutMs: o.ackTimeoutMs } : {}),
      referencePrice: (id) => this.market.referencePrice(id),
      marketErrorCode: () => this.market.lastMarketErrorCode,
      allowExtendedHours: o.allowExtendedHours === true,
      onWarn: warn,
    })
  }

  /** 连接 + 拉合约详情（内核启动时调用）。连接失败抛 Problem（3003 / 3005）。 */
  async start(): Promise<void> {
    await this.session.connect()
    if (this.#account === undefined && this.session.accounts.length > 1) {
      throw IbError.of(
        'INVALID_PARAMS',
        `IBKR session manages ${String(this.session.accounts.length)} accounts (${this.session.accounts.join(', ')}); set the account option explicitly`,
        '多账户必须显式给 account：本包只读写该账户的摘要 / 持仓 / 挂单 / 成交，不猜第一个',
      )
    }
    for (const symbol of this.#symbols) {
      try {
        await this.qualify(symbol)
      } catch (e) {
        this.#onWarn(`contract qualification failed for ${symbol}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  }

  async #resync(): Promise<void> {
    for (const symbol of this.#symbols) {
      try {
        await this.qualify(symbol)
      } catch (e) {
        this.#onWarn(`re-qualify failed for ${symbol}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  }

  /** 拉一个标的的合约详情并入册（REQ_CONTRACT_DATA → CONTRACT_DATA → CONTRACT_DATA_END）。 */
  async qualify(symbol: string): Promise<InstrumentRecord> {
    const reqId = this.session.allocateReqId()
    const rows: IbContractDetails[] = []
    await this.session.request<IbContractDetails[]>({
      label: `contractDetails(${symbol.toUpperCase()})`,
      build: M.reqContractDetails(reqId, M.stockContract(symbol, DEFAULT_EXCHANGE)),
      initial: rows,
      matchError: (id) => id === reqId,
      onFrame: (fields, acc) => {
        const msgId = Number(fields[0])
        if (msgId === M.IN.CONTRACT_DATA) {
          const cd = M.decodeContractDetails(fields)
          if (cd.reqId !== reqId) return false
          acc.push(cd)
          return false
        }
        if (msgId === M.IN.CONTRACT_DATA_END) return Number(fields[2] ?? '') === reqId
        return false
      },
    })
    const first = rows[0]
    if (first === undefined) {
      throw IbError.of(
        'INSTRUMENT_UNKNOWN',
        `IBKR returned no contract details for ${JSON.stringify(symbol)}`,
        '美股用裸 ticker（AAPL / MSFT），交易所 SMART、币种 USD；确认 TWS 已登录且该标的存在',
      )
    }
    return this.instruments.upsert(first, this.#clock())
  }

  describe(): VenueCapabilities {
    return ibkrCapabilities(this.#capabilities)
  }

  async close(): Promise<void> {
    this.market.close()
    this.session.close()
  }

  /** 账户限制标志（协议 AccountSnapshot 缺这些字段：见 account.ts 文件头与 REPORT）。 */
  accountRestrictions(): AccountRestrictions {
    return this.accounts.accountRestrictions()
  }

  // ---- 行情（最小子集：只快照） ----
  listInstruments(opts?: { includeDelisted?: boolean }): Instrument[] {
    return this.instruments.list(opts?.includeDelisted ?? false)
  }

  getInstrument(id: string): Instrument | undefined {
    return this.instruments.get(id)?.instrument
  }

  quote(id: string): StampedQuote | undefined {
    return this.market.quote(id)
  }

  /** 协议方法名是 book：这里指 L2 盘口（本包不支持，回 5002）；标的簿在 instruments 字段。 */
  book(id: string, depth?: number): Promise<Book> {
    void depth
    return this.market.book(id)
  }

  candles(id: string, interval: CandleInterval): Promise<Candle[]> {
    return this.market.candles(id, interval)
  }

  context(id: string): Promise<MarketContext> {
    return this.market.context(id)
  }

  subscribe(spec: SubscriptionSpec, cb: (e: VenueEvent) => void): Unsubscribe {
    return this.market.subscribe(spec, cb)
  }

  status(): MarketStatus {
    return this.market.status()
  }

  refreshQuote(id: string): Promise<StampedQuote | undefined> {
    return this.market.refreshQuote(id)
  }

  // ---- 账户（只读） ----
  accountState(ref: AccountRef): Promise<AccountSnapshot> {
    return this.accounts.accountState(ref)
  }

  openOrders(ref: AccountRef): Promise<VenueOpenOrder[]> {
    return this.accounts.openOrders(ref)
  }

  fills(ref: AccountRef, sinceMs: Ms): Promise<VenueFill[]> {
    return this.accounts.fills(ref, sinceMs)
  }

  orderStatus(ref: AccountRef, key: { clientOrderId?: string; venueOrderId?: string }): Promise<VenueOrderStatus> {
    return this.accounts.orderStatus(ref, key)
  }

  startupSnapshot(ref: AccountRef, fillsSinceMs: Ms): Promise<StartupSnapshot> {
    return this.accounts.startupSnapshot(ref, fillsSinceMs)
  }

  positions(): Promise<import('@gitrader/protocol').Position[]> {
    return this.accounts.positions()
  }

  // ---- 交易 ----
  submit(ctx: TradeContext, intents: OrderIntent[]): Promise<SubmitResult> {
    return this.trading.submit(ctx, intents)
  }

  cancel(ctx: TradeContext, targets: CancelTarget[]): Promise<CancelAck[]> {
    return this.trading.cancel(ctx, targets)
  }

  cancelAll(ctx: TradeContext, instrumentId?: string): Promise<CancelAck[]> {
    return this.trading.cancelAll(ctx, instrumentId)
  }

  amend(ctx: TradeContext, req: AmendRequest): Promise<SubmitResult> {
    return this.trading.amend(ctx, req)
  }

  /** IB 现金股票账户没有按单杠杆：5002（不假装设置成功）。 */
  setLeverage(_ctx: TradeContext, instrumentId: string, leverage: number): Promise<void> {
    return Promise.reject(
      IbError.of(
        'CAPABILITY_UNSUPPORTED',
        `IBKR cash equities have no per-order leverage (${instrumentId} @ ${String(leverage)}x)`,
        'IB 的融资倍数由账户（保证金账户 / 组合保证金）决定，不能按单设置；本包不改账户设置',
      ),
    )
  }

  /** IB 没有定时全撤（reqGlobalCancel 是立即全撤，不是死人开关）：5002。 */
  scheduleCancel(_ctx: TradeContext, atMs: Ms | null): Promise<void> {
    return Promise.reject(
      IbError.of(
        'CAPABILITY_UNSUPPORTED',
        `IBKR has no scheduled cancel (requested ${atMs === null ? 'clear' : String(atMs)})`,
        'IB 只有立即全撤（reqGlobalCancel）；定时撤单请在内核侧实现，本包不假装支持',
      ),
    )
  }

  /** 3006 对账：按 orderRef 查挂单 + 成交。 */
  reconcile(clientOrderId: string, ref: AccountRef) {
    return this.trading.reconcile(clientOrderId, ref)
  }

  reconcileUnknown(ref: AccountRef) {
    return this.trading.reconcileUnknown(ref)
  }
}

export { IbError } from './errors'
export { IbSession } from './session'
export { IbkrAccounts, OrderLedger } from './account'
export { IbkrMarket } from './market'
export { IbkrTrading, ackStatusOf, unknownProblem } from './trading'
export { buildOrders, orderRefOf, clientOrderIdFromOrderRef, orderTypeOf, tifOf, resolveSize } from './orders'
export { InstrumentBook, buildInstrument, SUPPORTED_ORDER_TYPES, SUPPORTED_TIF, SHARE_STEP } from './contracts'
export { buildSessions, parseHours, sessionStatus, localClock, weekdayOf } from './calendar'
export { IB_ERRORS, problemForIbError, isInformational, IbError as IbkrError } from './errors'
export { IB_PORTS, MANUAL_CLIENT_ID, AUTOMATION_CLIENT_ID, DEFAULT_HOST, DEFAULT_MODE, isLoopbackHost, portMatchesMode, gatewayOfPort, instrumentIdOf, symbolOf, environmentOf, modeOf } from './ids'
export { encodeHandshake, encodeMessage, FrameReader, parseHandshakeReply, negotiateVersion, API_VERSION } from './wire'
export type { IbkrTradeConnectorOptions as IbkrConnectorOptions } from './index'