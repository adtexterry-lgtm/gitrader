// SPDX-License-Identifier: CPAL-1.0
// OKX USDT/USDC 永续交易连接器：把行情（复用只读数据包）、账户、交易三块装成一个 VenueConnector。
// **离线件**：本包只做可离线测试的连接器，没有注册进内核、也没有跑过真网；README 第一句写明「未经真网验证，不得接实盘」。
// 内核创建它时注入：环境（mainnet / testnet）、apiKey / apiSecret / passphrase（只从构造参数进）、预算（同机共用一份）、
// 可选的 fetch / 时钟 / WebSocket 工厂。签名是 HMAC，没有签名器句柄。
// 它自己不会下单：submit / cancel / amend 只在内核发起的 TradeContext 窗口里执行。
// 行情解析**不复制**：直接用 @gitrader/connector-okx-data 的 OkxMarket（合约目录、K 线、盘口、报价、标记价、资金费）。
import type { Book, Candle, CandleInterval, Instrument, MarketContext, Ms, OrderIntent, VenueCapabilities } from '@gitrader/protocol'
import { asDecimal, makeProblem } from '@gitrader/protocol'
import type { RateBudget } from '@gitrader/protocol/connector'
import type {
  AccountRef, AmendRequest, CancelAck, CancelTarget, DeadmanHandle, MarketStatus, StampedQuote, StartupSnapshot, SubmitResult,
  SubscriptionSpec, TradeContext, Unsubscribe, VenueConnector, VenueEvent, VenueFill, VenueOpenOrder, VenueOrderStatus,
} from '@gitrader/protocol/connector'
import { OkxMarket } from '@gitrader/connector-okx-data'
import { OkxAccounts } from './account'
import type { AccountsOptions } from './account'
import { createCountBudget } from './budget'
import type { OkxBudget } from './budget'
import { okxCapabilities } from './capabilities'
import { ProblemError } from './errors'
import { recordOf, SUPPORTED_ORDER_TYPES, SUPPORTED_TIF, SUPPORTED_TRIGGER_TYPES, symbolOf, VENUE } from './parse'
import type { InstrumentRecord, OkxUserEvent } from './parse'
import { OkxHttp } from './rest'
import { validateEnvironment } from './rest'
import type { Environment } from './rest'
import { OkxTrading } from './trading'
import { openPrivateStream, PING_INTERVAL_MS } from './ws'
import type { PrivateStreamHandle, SocketFactory } from './ws'

/** 死人开关每次刷新的最大间隔（OKX cancel-all-after timeOut 上限 120 s）。 */
export const DEADMAN_MAX_DELAY_SEC = 120

export interface OkxTradeConnectorOptions {
  environment?: Environment
  /** 必填：只从构造参数进，不落盘、不打印。 */
  apiKey: string
  apiSecret: string
  /** OKX 的第三把钥匙（passphrase）；同样只从构造参数进。 */
  passphrase: string
  /** 基址（生产 / 演示 / 测试用假服务器）。缺省按 environment。 */
  baseUrl?: string
  fetchImpl?: typeof fetch
  /** 时钟注入（时间戳、成交回补窗口、死人开关都用它）。 */
  clock?: () => number
  /** 内核注入的预算；缺省本连接器自己一份（≤ 60% × 60 次 / 2 s）。同机多连接必须共用。 */
  budget?: RateBudget
  httpTimeoutMs?: number
  /** 报价陈旧阈值，缺省 10 s（透传给数据包）。 */
  staleMs?: number
  /** 轮询订阅间隔，缺省 5 s（透传给数据包）。 */
  pollMs?: number
  /** oneWay（缺省，= net_mode）/ hedge（= long_short_mode）：影响 posSide 与 reduceOnly 的发送方式。 */
  positionMode?: 'oneWay' | 'hedge'
  /** 账户读取选项。 */
  accounts?: AccountsOptions
  /** 私有数据流的连接工厂（缺省没有 → 不建连，只解析）。 */
  socketFactory?: SocketFactory
  /** 后台诊断出口；消息固定且不含账户或上游响应内容。 */
  onWarn?: (message: string) => void
  /** 私有流事件出口（内核以后再适配到 VenueEvent）。 */
  onUserEvent?: (e: OkxUserEvent) => void
}

export class OkxTradeConnector implements VenueConnector {
  readonly venue = VENUE
  readonly environment: Environment
  readonly http: OkxHttp
  readonly market: OkxMarket
  readonly accounts: OkxAccounts
  readonly trading: OkxTrading
  #apiKey: string
  #apiSecret: string
  #passphrase: string
  private readonly onWarn: (message: string) => void
  private readonly socketFactory: SocketFactory | undefined
  private readonly onUserEvent: ((e: OkxUserEvent) => void) | undefined
  private readonly clock: () => number
  private stream: PrivateStreamHandle | null = null
  private deadmanTimer: ReturnType<typeof setInterval> | null = null

  constructor(o: OkxTradeConnectorOptions) {
    const environment = validateEnvironment(o.environment)
    const clock = o.clock ?? (() => Date.now())
    this.clock = clock
    this.environment = environment
    this.onWarn = o.onWarn ?? ((message) => console.warn(message))
    this.socketFactory = o.socketFactory
    this.onUserEvent = o.onUserEvent
    this.#apiKey = o.apiKey
    this.#apiSecret = o.apiSecret
    this.#passphrase = o.passphrase
    this.http = new OkxHttp({
      environment,
      ...(o.baseUrl !== undefined ? { baseUrl: o.baseUrl } : {}),
      apiKey: o.apiKey,
      apiSecret: o.apiSecret,
      passphrase: o.passphrase,
      ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}),
      clock,
      ...(o.budget ? { budget: o.budget } : {}),
      ...(o.httpTimeoutMs !== undefined ? { timeoutMs: o.httpTimeoutMs } : {}),
      onWarn: this.onWarn,
    })
    this.market = new OkxMarket({
      ...(o.baseUrl !== undefined ? { baseUrl: o.baseUrl } : {}),
      ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}),
      clock,
      ...(o.staleMs !== undefined ? { staleMs: o.staleMs } : {}),
      ...(o.pollMs !== undefined ? { pollMs: o.pollMs } : {}),
      ...(o.httpTimeoutMs !== undefined ? { httpTimeoutMs: o.httpTimeoutMs } : {}),
    })
    this.accounts = new OkxAccounts({
      http: this.http,
      clock,
      secrets: [o.apiSecret, o.apiKey, o.passphrase],
      ...(o.accounts !== undefined ? { options: o.accounts } : {}),
      records: () => this.records(),
    })
    this.trading = new OkxTrading({
      http: this.http,
      recordOf: (instrumentId) => this.recordOf(instrumentId),
      clock,
      ...(o.positionMode !== undefined ? { positionMode: o.positionMode } : {}),
      secrets: [o.apiSecret, o.apiKey, o.passphrase],
      openOrders: (ref, instrumentId) => this.accounts.openOrders(ref, instrumentId),
      pendingRefs: (instrumentId) => this.accounts.pendingRefs(instrumentId),
      orderStatus: (ref, key, opts) => this.accounts.orderStatus(ref, key, opts),
      quoteOf: (instrumentId) => this.market.quote(instrumentId),
    })
  }

  /** 拉 SWAP 合约清单并建本地标的记录（行情与下单的前置）。 */
  start(): Promise<void> {
    return this.market.start()
  }

  async close(): Promise<void> {
    this.stream?.close()
    this.stream = null
    if (this.deadmanTimer !== null) {
      clearInterval(this.deadmanTimer)
      this.deadmanTimer = null
    }
    await this.market.close()
  }

  describe(): VenueCapabilities {
    return okxCapabilities()
  }

  // ---- 行情（只读；解析复用数据包，本包不复制）----
  listInstruments(opts?: { includeDelisted?: boolean }): Instrument[] {
    return this.market.listInstruments(opts ?? {}).map((instrument) => this.tradingView(instrument))
  }

  getInstrument(id: string): Instrument | undefined {
    const instrument = this.market.getInstrument(id)
    return instrument === undefined ? undefined : this.tradingView(instrument)
  }

  /** 内核按 `size × price × contractSize` 算名义额；本包数量是币，所以对外 contractSize = 1。
   *  ctVal 只留在内部 recordOf()。 */
  private tradingView(instrument: Instrument): Instrument {
    return {
      ...instrument,
      contractSize: asDecimal('1'),
      orderTypes: [...SUPPORTED_ORDER_TYPES],
      tif: [...SUPPORTED_TIF],
      triggerPriceTypes: [...SUPPORTED_TRIGGER_TYPES],
    }
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
  accountState(ref: AccountRef) {
    return this.accounts.accountState(ref)
  }
  openOrders(ref: AccountRef): Promise<VenueOpenOrder[]> {
    return this.accounts.openOrders(ref)
  }
  fills(ref: AccountRef, sinceMs: Ms, opts?: { instrumentId?: import('@gitrader/protocol').InstrumentId }): Promise<VenueFill[]> {
    return this.accounts.fills(ref, sinceMs, opts)
  }
  async orderStatus(ref: AccountRef, key: { clientOrderId?: string; venueOrderId?: string; instrumentId?: import('@gitrader/protocol').InstrumentId }): Promise<VenueOrderStatus> {
    if (key.instrumentId !== undefined) {
      const symbol = symbolOf(key.instrumentId)
      const regular = await this.accounts.orderStatus(ref, key, { symbol, channel: 'order' })
      if (regular.found) return regular
      return this.accounts.orderStatus(ref, key, { symbol, channel: 'algo' })
    }
    return this.trading.status(ref, key)
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
  scheduleCancel(ctx: TradeContext, atMs: Ms | null): Promise<void> {
    return this.trading.scheduleCancel(ctx, atMs)
  }

  /**
   * 场所级死人开关：OKX 的 /trade/cancel-all-after timeOut 是原生的「到点全撤」。
   * 定时器每 delaySec/2 刷新一次（每次都重新计时），进程死掉后最多 delaySec 秒场所自动撤单。
   * delaySec 会被夹到 10..120（OKX 允许范围）。
   */
  armDeadman(ctx: TradeContext, opts?: { delaySec?: number; onError?: (e: Error) => void }): DeadmanHandle {
    const delaySec = Math.min(DEADMAN_MAX_DELAY_SEC, Math.max(10, Math.round(opts?.delaySec ?? 60)))
    const armedAt = this.clock()
    let refreshes = 0
    let lastError: string | null = null
    let lastScheduledAt: Ms | null = null
    const refresh = (): void => {
      const at = this.clock() + delaySec * 1000
      void this.trading.scheduleCancel(ctx, at).then(() => {
        refreshes += 1
        lastScheduledAt = at
      }).catch((e: unknown) => {
        lastError = e instanceof Error ? e.message : String(e)
        opts?.onError?.(e instanceof Error ? e : new Error(lastError ?? 'deadman refresh failed'))
      })
    }
    refresh()
    const interval = Math.max(1_000, Math.floor((delaySec * 1000) / 2))
    this.deadmanTimer = setInterval(refresh, interval)
    // 不阻止进程退出（内核自己管理生命周期）
    const timer = this.deadmanTimer as unknown as { unref?: () => void }
    timer.unref?.()
    return {
      stop: async () => {
        if (this.deadmanTimer !== null) {
          clearInterval(this.deadmanTimer)
          this.deadmanTimer = null
        }
        await this.trading.scheduleCancel(ctx, null)
      },
      stats: () => ({ armedAt, refreshes, lastError, lastScheduledAt }),
    }
  }

  // ---- 私有数据流（login + 订阅；连接工厂由调用方注入）----
  /** 建私有流并登录（没有注入工厂时抛 CAPABILITY_UNSUPPORTED，不做假连接）。 */
  openUserStream(opts: { channels?: Parameters<typeof openPrivateStream>[0]['channels'] } = {}): PrivateStreamHandle {
    if (!this.socketFactory) {
      throw new ProblemError(makeProblem('CAPABILITY_UNSUPPORTED', 'no socketFactory injected; this connector never opens sockets on its own'))
    }
    if (!this.onUserEvent) {
      throw new ProblemError(makeProblem('INVALID_PARAMS', 'onUserEvent callback is required to open the private stream'))
    }
    this.stream?.close()
    this.stream = null
    const handle = openPrivateStream({
      factory: this.socketFactory,
      environment: this.environment,
      apiKey: this.#apiKey,
      apiSecret: this.#apiSecret,
      passphrase: this.#passphrase,
      clock: this.clock,
      channels: opts.channels ?? ['orders', 'positions', 'account', 'orders-algo', 'algo-advance'],
      ctValOf: (instId) => this.recordOf(`okx:${instId}`)?.ctVal,
      onEvent: (e) => this.onUserEvent?.(e),
      onError: (message) => this.onWarn(message),
      onClose: () => { this.stream = null },
    })
    if (handle.state() === 'open') this.stream = handle
    return handle
  }

  /** 心跳（内核定时调；OKX 要求 30 s 内有数据往来，本包给 25 s 的常量）。 */
  keepAliveUserStream(): 'pinged' | 'skipped' {
    if (this.stream === null) return 'skipped'
    this.stream.ping()
    return 'pinged'
  }

  /** 关流。 */
  closeUserStream(): void {
    this.stream?.close()
    this.stream = null
  }

  /** 私有流的心跳间隔（诊断用）。 */
  static pingIntervalMs(): number {
    return PING_INTERVAL_MS
  }

  /** 诊断：本地标的记录（只读）。 */
  records(): InstrumentRecord[] {
    const out: InstrumentRecord[] = []
    for (const instrument of this.market.listInstruments({ includeDelisted: true })) {
      const record = recordOf(instrument)
      if (record) out.push(record)
    }
    return out
  }

  /** 单张标的记录（下单要用；不在目录里返回 undefined）。 */
  recordOf(instrumentId: string): InstrumentRecord | undefined {
    const instrument = this.market.getInstrument(instrumentId)
    return instrument === undefined ? undefined : recordOf(instrument)
  }

  /** 诊断：预算占用（含下单计数）。 */
  budgetUsage(): ReturnType<OkxHttp['usage']> {
    return this.http.usage()
  }
}

/** 缺省预算工厂（同机多连接时由内核注入一份共用）。 */
export function defaultBudget(clock?: () => number): OkxBudget {
  return createCountBudget({ ...(clock ? { clock } : {}) })
}
