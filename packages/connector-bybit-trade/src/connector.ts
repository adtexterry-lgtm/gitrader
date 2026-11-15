// SPDX-License-Identifier: CPAL-1.0
// Bybit v5 USDT 线性永续交易连接器：把行情（只读，复用 connector-bybit-data）、账户、交易三块装成 VenueConnector。
// **离线件**：package README 第一句写明「未经真网验证，不得接实盘」；本包没注册进 CLI / 内核，也不联网（测试全离线）。
// 内核创建它时注入：环境（mainnet / testnet）、apiKey / apiSecret（只从构造参数进）、权重预算（同机共用一份）、
// 可选的 fetch / 时钟 / WebSocket 工厂。签名是 HMAC（apiKey + apiSecret），没有签名器句柄。
// 它自己不会下单：submit / cancel / amend 只在内核发起的 TradeContext 窗口里执行。
import type {
  Book, Candle, CandleInterval, Instrument, InstrumentId, MarketContext, Ms, OrderIntent, VenueCapabilities,
} from '@gitrader/protocol'
import { makeProblem } from '@gitrader/protocol'
import type { RateBudget } from '@gitrader/protocol/connector'
import type {
  AccountRef, AccountSnapshot, AmendRequest, CancelAck, CancelTarget, DeadmanHandle, MarketStatus, StampedQuote,
  StartupSnapshot, SubmitResult, SubscriptionSpec, TradeContext, Unsubscribe, VenueConnector, VenueEvent, VenueFill,
  VenueOpenOrder, VenueOrderStatus,
} from '@gitrader/protocol/connector'
import { BybitAccounts } from './account'
import type { AccountsOptions } from './account'
import { bybitCapabilities } from './capabilities'
import { createWeightBudget } from './budget'
import type { BybitBudget } from './budget'
import { ProblemError } from './errors'
import { BybitTradeMarket } from './market'
import type { BybitPrivateEvent } from './parse'
import { VENUE } from './parse'
import { BybitHttp } from './rest'
import type { Environment } from './rest'
import { BybitTrading } from './trading'
import type { TradingStopSpec } from './orders'
import { openPrivateStream, PRIVATE_WS_URL } from './ws'
import type { PrivateStreamHandle, SocketFactory } from './ws'

export interface BybitTradeConnectorOptions {
  environment?: Environment
  /** 必填：只从构造参数进，不落盘、不打印。 */
  apiKey: string
  apiSecret: string
  /** 基址（生产 / 测试网 / 测试用假服务器）。缺省按 environment。 */
  baseUrl?: string
  fetchImpl?: typeof fetch
  /** 时钟注入（签名时间戳、行情陈旧判定都用它）。 */
  clock?: () => number
  /** 内核注入的权重预算；缺省本连接器自己一份（≤ 60% × 600 / 5 s）。同机多连接必须共用。 */
  budget?: RateBudget
  /** recvWindow（毫秒），缺省 5000。 */
  recvWindowMs?: number
  httpTimeoutMs?: number
  /** 报价陈旧阈值，缺省 10 s。 */
  staleMs?: number
  /** 报价轮询间隔，缺省 5 s。 */
  pollMs?: number
  /** oneWay（缺省）/ hedge：影响 positionIdx 与 reduceOnly 的发送方式。 */
  positionMode?: 'oneWay' | 'hedge'
  /** orderStatus 这类要 symbol 的接口用的缺省标的。 */
  defaultSymbol?: string
  /** 不指定 instrumentId 时查询挂单 / 持仓 / 成交用的结算币，缺省 USDT。 */
  defaultSettleCoin?: string
  /** 账户读取选项。 */
  accounts?: AccountsOptions
  /** 私有流的连接工厂（缺省没有 → 能装配鉴权 / 订阅消息，但不建连）。 */
  socketFactory?: SocketFactory
  /** 后台诊断出口；消息固定且不含账户或上游响应内容。 */
  onWarn?: (message: string) => void
  /** 私有流事件出口（内核以后再适配到 VenueEvent）。 */
  onUserEvent?: (e: BybitPrivateEvent) => void
}

export class BybitTradeConnector implements VenueConnector {
  readonly venue = VENUE
  readonly environment: Environment
  readonly http: BybitHttp
  readonly market: BybitTradeMarket
  readonly accounts: BybitAccounts
  readonly trading: BybitTrading
  private readonly onWarn: (message: string) => void
  private readonly socketFactory: SocketFactory | undefined
  private readonly onUserEvent: ((e: BybitPrivateEvent) => void) | undefined
  // 密钥放 # 私有字段：JSON.stringify / util.inspect / 展开运算符都看不到明文。
  readonly #apiKey: string
  readonly #apiSecret: string
  private stream: PrivateStreamHandle | null = null

  constructor(o: BybitTradeConnectorOptions) {
    const clock = o.clock ?? (() => Date.now())
    this.environment = o.environment ?? 'mainnet'
    this.onWarn = o.onWarn ?? ((message) => console.warn(message))
    this.socketFactory = o.socketFactory
    this.onUserEvent = o.onUserEvent
    this.#apiKey = o.apiKey
    this.#apiSecret = o.apiSecret
    this.http = new BybitHttp({
      environment: this.environment,
      ...(o.baseUrl !== undefined ? { baseUrl: o.baseUrl } : {}),
      apiKey: o.apiKey,
      apiSecret: o.apiSecret,
      ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}),
      clock,
      ...(o.budget ? { budget: o.budget } : {}),
      ...(o.recvWindowMs !== undefined ? { recvWindowMs: o.recvWindowMs } : {}),
      ...(o.httpTimeoutMs !== undefined ? { timeoutMs: o.httpTimeoutMs } : {}),
      onWarn: this.onWarn,
    })
    this.market = new BybitTradeMarket({
      ...(o.baseUrl !== undefined ? { baseUrl: o.baseUrl } : {}),
      ...(o.fetchImpl !== undefined ? { fetchImpl: o.fetchImpl } : {}),
      clock,
      ...(o.staleMs !== undefined ? { staleMs: o.staleMs } : {}),
      ...(o.pollMs !== undefined ? { pollMs: o.pollMs } : {}),
      ...(o.httpTimeoutMs !== undefined ? { httpTimeoutMs: o.httpTimeoutMs } : {}),
    })
    this.accounts = new BybitAccounts({
      http: this.http,
      clock,
      options: {
        ...o.accounts,
        ...(o.defaultSymbol !== undefined ? { defaultSymbol: o.defaultSymbol } : {}),
        ...(o.defaultSettleCoin !== undefined ? { defaultSettleCoin: o.defaultSettleCoin } : {}),
      },
      instrumentOf: (id) => this.market.getInstrument(id),
    }, [o.apiSecret, o.apiKey])
    this.trading = new BybitTrading({
      http: this.http,
      instrumentOf: (id) => this.market.getInstrument(id),
      quoteOf: (id) => {
        const q = this.market.quote(id)
        return q ? { bid: q.bid, ask: q.ask, ...(q.last !== undefined ? { last: q.last } : {}), stale: q.stale } : undefined
      },
      openOrders: (ref, instrumentId) => this.accounts.openOrders(ref, instrumentId),
      orderStatus: (ref, key, opts) => this.accounts.orderStatus(ref, key, opts ?? {}),
      clock,
      ...(o.positionMode !== undefined ? { positionMode: o.positionMode } : {}),
      ...(o.defaultSymbol !== undefined ? { defaultSymbol: o.defaultSymbol } : {}),
    }, [o.apiSecret, o.apiKey])
  }

  /** 拉 instruments-info 并建本地标的地图（行情与下单精度的前置）。 */
  start(): Promise<void> {
    return this.market.start()
  }

  async close(): Promise<void> {
    this.stream?.close()
    this.stream = null
    await this.market.close()
  }

  describe(): VenueCapabilities {
    return bybitCapabilities()
  }

  // ---- 行情（只读；解析复用数据包）----
  listInstruments(opts?: { includeDelisted?: boolean }): Instrument[] {
    return this.market.listInstruments(opts ?? {})
  }

  getInstrument(id: string): Instrument | undefined {
    return this.market.getInstrument(id)
  }

  quote(id: string): StampedQuote | undefined {
    return this.market.quote(id)
  }

  book(id: string, depth?: number): Promise<Book> {
    return this.market.book(id, depth)
  }

  candles(id: string, interval: CandleInterval, opts?: { n?: number; from?: Ms; to?: Ms }): Promise<Candle[]> {
    return this.market.candles(id, interval, opts ?? {})
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

  /** 主动刷新一次报价（VenueConnector.quote 是同步缓存视图，这里给 await 版本）。 */
  refreshQuote(id: string): Promise<StampedQuote | undefined> {
    return this.market.refreshQuote(id)
  }

  // ---- 账户（只读）----
  accountState(ref: AccountRef): Promise<AccountSnapshot> {
    return this.accounts.accountState(ref)
  }
  openOrders(ref: AccountRef): Promise<VenueOpenOrder[]> {
    return this.accounts.openOrders(ref)
  }
  fills(ref: AccountRef, sinceMs: Ms, opts?: { instrumentId?: InstrumentId }): Promise<VenueFill[]> {
    return this.accounts.fills(ref, sinceMs, opts)
  }
  orderStatus(ref: AccountRef, key: { clientOrderId?: string; venueOrderId?: string; instrumentId?: InstrumentId }): Promise<VenueOrderStatus> {
    return this.accounts.orderStatus(ref, key, {})
  }
  startupSnapshot(ref: AccountRef, fillsSinceMs: Ms): Promise<StartupSnapshot> {
    return this.accounts.startupSnapshot(ref, fillsSinceMs)
  }

  // ---- 交易（内核发起）----
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
  setLeverage(ctx: TradeContext, instrumentId: string, leverage: number, marginMode: 'cross' | 'isolated'): Promise<void> {
    return this.trading.setLeverage(ctx, instrumentId, leverage, marginMode)
  }
  scheduleCancel(_ctx: TradeContext, _atMs: Ms | null): Promise<void> {
    return this.trading.scheduleCancel(_ctx, _atMs)
  }
  /** 场所级死人开关：Bybit v5 没有定时撤单端点，本包不伪装。 */
  armDeadman(_ctx: TradeContext, _opts?: { delaySec?: number; onError?: (e: Error) => void }): DeadmanHandle {
    throw new ProblemError(makeProblem('CAPABILITY_UNSUPPORTED', 'Bybit v5 has no venue-side scheduled cancel; keep the kernel cancel loop'))
  }

  /** 持仓级 TP / SL / 追踪（POST /v5/position/trading-stop，tpslMode 缺省 Full）。 */
  setTradingStop(ctx: TradeContext, spec: TradingStopSpec): Promise<void> {
    return this.trading.setTradingStop(ctx, spec)
  }

  // ---- 私有流（鉴权 + 订阅装配；socket 工厂由内核注入）----
  /** 建私有流。没有 socketFactory 时只返回装配好的地址与消息，不建连。 */
  openUserStream(): { url: string; stream: PrivateStreamHandle | null } {
    const url = PRIVATE_WS_URL[this.environment]
    if (!this.socketFactory || !this.onUserEvent) return { url, stream: null }
    this.stream?.close()
    this.stream = openPrivateStream({
      factory: this.socketFactory,
      url,
      apiKey: this.#apiKey,
      apiSecret: this.#apiSecret,
      clock: () => this.http.ts.now(),
      onEvent: (e) => this.onUserEvent?.(e),
      onError: (message) => this.onWarn(message),
      onClose: () => {
        this.stream = null
      },
    })
    return { url, stream: this.stream }
  }

  closeUserStream(): void {
    this.stream?.close()
    this.stream = null
  }

  /** 诊断：预算占用（含下单计数桶）。 */
  budgetUsage(): ReturnType<BybitHttp['usage']> {
    return this.http.usage()
  }

  /** 诊断：缺省预算工厂（同机多连接时由内核注入一份共用）。 */
  static defaultBudget(clock?: () => number): BybitBudget {
    return createWeightBudget({ ...(clock ? { clock } : {}) })
  }

}

/** 缺省预算工厂（同机多连接时由内核注入一份共用）。 */
export function defaultBudget(clock?: () => number): BybitBudget {
  return createWeightBudget({ ...(clock ? { clock } : {}) })
}
