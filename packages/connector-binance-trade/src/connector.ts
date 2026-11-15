// SPDX-License-Identifier: CPAL-1.0
// Binance USDⓈ-M 永续交易连接器：把行情（只读 REST）、账户、交易三块装成一个 VenueConnector。
// **离线件**：本包只做可离线测试的连接器，没有注册进内核、也没有跑过真网；README 第一句写明「未经真网验证，不得接实盘」。
// 内核创建它时注入：环境（mainnet / testnet）、apiKey / apiSecret（只从构造参数进）、权重预算（同机共用一份）、
// 可选的 fetch / 时钟 / WebSocket 工厂。签名是 HMAC（apiKey + apiSecret），没有签名器句柄。
// 它自己不会下单：submit / cancel / amend 只在内核发起的 TradeContext 窗口里执行。
import type { Book, Candle, CandleInterval, Instrument, InstrumentId, MarketContext, Ms, OrderIntent, VenueCapabilities } from '@gitrader/protocol'
import { makeProblem } from '@gitrader/protocol'
import type { RateBudget } from '@gitrader/protocol/connector'
import type {
  AccountRef, AmendRequest, CancelAck, CancelTarget, DeadmanHandle, MarketStatus, StampedQuote, StartupSnapshot, SubmitResult,
  SubscriptionSpec, TradeContext, Unsubscribe, VenueConnector, VenueEvent, VenueFill, VenueOpenOrder, VenueOrderStatus,
} from '@gitrader/protocol/connector'
import type { BinanceBudget } from './budget'
import { createWeightBudget } from './budget'
import { binanceCapabilities } from './capabilities'
import { BinanceAccounts } from './account'
import type { AccountsOptions } from './account'
import { ProblemError } from './errors'
import { BinanceMarket } from './market'
import type { InstrumentRecord } from './parse'
import { VENUE } from './parse'
import { BinanceHttp } from './rest'
import type { Environment } from './rest'
import { BinanceTrading } from './trading'
import type { SocketFactory } from './ws'
import { ListenKeyManager, openUserStream, userStreamUrl } from './ws'
import type { UserStreamHandle } from './ws'
import type { BinanceUserEvent } from './parse'

export interface BinanceTradeConnectorOptions {
  environment?: Environment
  /** 必填：只从构造参数进，不落盘、不打印。 */
  apiKey: string
  apiSecret: string
  /** 基址（生产 / 测试网 / 测试用假服务器）。缺省按 environment。 */
  baseUrl?: string
  fetchImpl?: typeof fetch
  /** 时钟注入（时间戳、保证金、陈旧判定都用它）。 */
  clock?: () => number
  /** 内核注入的权重预算；缺省本连接器自己一份（≤ 60% × 2400 / 分钟）。同机多连接必须共用。 */
  budget?: RateBudget
  /** recvWindow（毫秒），缺省 5000。 */
  recvWindowMs?: number
  httpTimeoutMs?: number
  /** 报价陈旧阈值，缺省 10 s。 */
  staleMs?: number
  /** 轮询订阅间隔，缺省 5 s。 */
  pollMs?: number
  /** oneWay（缺省）/ hedge：影响 positionSide 与 reduceOnly 的发送方式。 */
  positionMode?: 'oneWay' | 'hedge'
  /** userTrades / orderStatus 这类强制要 symbol 的接口用的缺省标的。 */
  defaultSymbol?: string
  /** 市价参考报价最大年龄，缺省 5000 ms。 */
  refPriceMaxAgeMs?: number
  /** 账户读取选项。 */
  accounts?: AccountsOptions
  /** 用户数据流的连接工厂（缺省没有 → listenKey 能管，但不建连）。 */
  socketFactory?: SocketFactory
  /** 后台诊断出口；消息固定且不含账户或上游响应内容。 */
  onWarn?: (message: string) => void
  /** 用户数据流事件出口（内核以后再适配到 VenueEvent）。 */
  onUserEvent?: (e: BinanceUserEvent) => void
}

export class BinanceTradeConnector implements VenueConnector {
  readonly venue = VENUE
  readonly environment: Environment
  readonly http: BinanceHttp
  readonly market: BinanceMarket
  readonly accounts: BinanceAccounts
  readonly trading: BinanceTrading
  readonly listenKeys: ListenKeyManager
  private readonly onWarn: (message: string) => void
  private readonly socketFactory: SocketFactory | undefined
  private readonly onUserEvent: ((e: BinanceUserEvent) => void) | undefined
  private stream: UserStreamHandle | null = null

  constructor(o: BinanceTradeConnectorOptions) {
    const clock = o.clock ?? (() => Date.now())
    this.environment = o.environment ?? 'mainnet'
    this.onWarn = o.onWarn ?? ((message) => console.warn(message))
    this.socketFactory = o.socketFactory
    this.onUserEvent = o.onUserEvent
    this.http = new BinanceHttp({
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
    this.market = new BinanceMarket({
      http: this.http,
      clock,
      ...(o.staleMs !== undefined ? { staleMs: o.staleMs } : {}),
      ...(o.pollMs !== undefined ? { pollMs: o.pollMs } : {}),
      secrets: [o.apiSecret, o.apiKey],
    })
    this.accounts = new BinanceAccounts({
      http: this.http,
      clock,
      options: { ...o.accounts, ...(o.defaultSymbol !== undefined ? { defaultSymbol: o.defaultSymbol } : {}) },
      records: () => this.records(),
    }, [o.apiSecret, o.apiKey])
    this.trading = new BinanceTrading({
      http: this.http,
      market: this.market,
      clock,
      ...(o.positionMode !== undefined ? { positionMode: o.positionMode } : {}),
      marginMode: (ref, instrumentId) => this.accounts.marginMode(ref, instrumentId),
      openOrders: (ref, instrumentId) => this.accounts.openOrders(ref, instrumentId),
      orderStatus: (ref, key, opts) => this.accounts.orderStatus(ref, key, opts ?? {}),
      ...(o.defaultSymbol !== undefined ? { defaultSymbol: o.defaultSymbol } : {}),
      ...(o.refPriceMaxAgeMs !== undefined ? { refPriceMaxAgeMs: o.refPriceMaxAgeMs } : {}),
    }, [o.apiSecret, o.apiKey])
    this.listenKeys = new ListenKeyManager({ http: this.http, clock, secrets: [o.apiSecret, o.apiKey] })
  }

  /** 拉 exchangeInfo 并建本地标的地图（行情只读方法的前置）。 */
  start(): Promise<void> {
    return this.market.refresh()
  }

  async close(): Promise<void> {
    this.stream?.close()
    this.stream = null
    await this.market.close()
  }

  describe(): VenueCapabilities {
    return binanceCapabilities()
  }

  // ---- 行情（只读；解析复用数据包逻辑）----
  listInstruments(opts?: { includeDelisted?: boolean }): Instrument[] {
    return this.market.listInstruments(opts ?? {})
  }

  getInstrument(id: string): Instrument | undefined {
    return this.market.getInstrument(id)
  }

  quote(id: string): StampedQuote | undefined {
    return this.market.quoteCached(id)
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
  refreshQuote(id: string): Promise<StampedQuote> {
    return this.market.quote(id)
  }

  // ---- 账户（只读）----
  accountState(ref: AccountRef) {
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
  /** algo 单（触发 / 保护单）状态：GET /fapi/v1/algoOrder（algoId / clientAlgoId）。 */
  algoOrderStatus(ref: AccountRef, key: { clientOrderId?: string; venueOrderId?: string }, opts: { symbol?: string } = {}): Promise<VenueOrderStatus> {
    return this.accounts.orderStatus(ref, key, { ...opts, algo: true })
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
  /** 场所级死人开关：Binance 有 countdownCancelAll（按 symbol），本包未接入内核死人开关。 */
  armDeadman(_ctx: TradeContext, _opts?: { delaySec?: number; onError?: (e: Error) => void }): DeadmanHandle {
    throw new ProblemError(makeProblem('CAPABILITY_UNSUPPORTED', 'Binance exposes countdownCancelAll per symbol, but this connector does not wire it into the kernel deadman; keep the kernel cancel loop'))
  }

  // ---- 用户数据流（listenKey + 注入的 socket 工厂）----
  /** 建 listenKey 并（有工厂时）连上用户流；事件回调 onUserEvent。 */
  async openUserStream(): Promise<{ listenKey: string; url: string }> {
    const listenKey = await this.listenKeys.open()
    const url = userStreamUrl(this.environment, listenKey)
    if (this.socketFactory && this.onUserEvent) {
      this.stream?.close()
      this.stream = openUserStream({
        factory: this.socketFactory,
        url,
        onEvent: (e) => {
          if (e.kind === 'listenKeyExpired') this.listenKeys.invalidate()
          this.onUserEvent?.(e)
        },
        onError: (message) => this.onWarn(message),
        onClose: () => { this.stream = null },
      })
    }
    return { listenKey, url }
  }

  /** 续期检查（内核定时调）：只走 listenKey，不碰 socket。 */
  keepAliveUserStream(): Promise<'renewed' | 'skipped'> {
    return this.listenKeys.tick()
  }

  /** 关流 + 关 listenKey。 */
  async closeUserStream(): Promise<void> {
    this.stream?.close()
    this.stream = null
    await this.listenKeys.close()
  }

  /** 诊断：本地标的记录（只读）。 */
  records(): InstrumentRecord[] {
    return collectRecords(this.market)
  }
}

function collectRecords(market: BinanceMarket): InstrumentRecord[] {
  const out: InstrumentRecord[] = []
  for (const instrument of market.listInstruments({ includeDelisted: true })) {
    const rec = market.getRecord(instrument.instrumentId)
    if (rec) out.push(rec)
  }
  return out
}

/** 缺省预算工厂（同机多连接时由内核注入一份共用）。 */
export function defaultBudget(clock?: () => number): BinanceBudget {
  return createWeightBudget({ ...(clock ? { clock } : {}) })
}
