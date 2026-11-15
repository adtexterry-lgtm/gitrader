// SPDX-License-Identifier: CPAL-1.0
// HTX USDT 本位永续交易连接器：把行情（本包自带的最小公共行情）、账户、交易三块装成 VenueConnector。
// **离线件**：package README 第一句写明「未经真网验证，不得接实盘」；本包没注册进 CLI / 内核，也不联网（测试全离线）。
// 内核创建它时注入：环境（只有 mainnet；HTX 没有官方测试网，testnet 构造即抛）、apiKey / apiSecret（只从构造参数进）、权重预算（同机共用一份）、
// 可选的 fetch / 时钟。签名是 HMAC（apiKey + apiSecret），没有签名器句柄。
// 它自己不会下单：submit / cancel / cancelAll / setLeverage 只在内核发起的 TradeContext 窗口里执行。
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
import { HtxAccounts } from './account'
import type { AccountsOptions } from './account'
import { htxCapabilities } from './capabilities'
import { createWeightBudget } from './budget'
import type { HtxBudget } from './budget'
import { ProblemError } from './errors'
import { HtxTradeMarket } from './market'
import type { MarketOptions } from './market'
import type { OrderFamily, TpslSpec } from './orders'
import { VENUE } from './parse'
import { HtxHttp } from './rest'
import type { Environment } from './rest'
import { HtxTrading } from './trading'

export interface HtxTradeConnectorOptions {
  environment?: Environment
  /** 必填：只从构造参数进，不落盘、不打印。 */
  apiKey: string
  apiSecret: string
  /** 基址（生产 / 测试用假服务器）。缺省生产；environment 为 testnet 时必须显式传。 */
  baseUrl?: string
  fetchImpl?: typeof fetch
  /** 时钟注入（签名时间戳、行情陈旧判定都用它）。 */
  clock?: () => number
  /** 内核注入的权重预算；缺省本连接器自己一份。同机多连接必须共用。 */
  budget?: RateBudget
  httpTimeoutMs?: number
  /** 报价陈旧阈值，缺省 10 s。 */
  staleMs?: number
  /** 报价轮询间隔，缺省 1 s。 */
  pollMs?: number
  /** oneWay（缺省）/ hedge：影响 position_side 与 offset 的发送方式。 */
  positionMode?: 'oneWay' | 'hedge'
  /** v5（缺省，联合保证金账户）或 v1（交叉保证金账户）。 */
  family?: OrderFamily
  /** 建单体里的 margin_mode（v5 必填），缺省 cross。 */
  marginMode?: 'cross' | 'isolated'
  /** orderStatus 这类要 contract_code 的接口用的缺省标的（contract_code，如 BTC-USDT）。 */
  defaultSymbol?: string
  /** 账户读取选项。 */
  accounts?: AccountsOptions
  /** 后台诊断出口；消息固定且不含账户或上游响应内容。 */
  onWarn?: (message: string) => void
}

export class HtxTradeConnector implements VenueConnector {
  readonly venue = VENUE
  readonly environment: Environment
  readonly http: HtxHttp
  readonly market: HtxTradeMarket
  readonly accounts: HtxAccounts
  readonly trading: HtxTrading
  private readonly onWarn: (message: string) => void
  // 密钥只交给 http / accounts / trading 的构造参数与 # 私有字段，连接器本身不额外留一份明文。
  readonly #family: OrderFamily

  constructor(o: HtxTradeConnectorOptions) {
    const clock = o.clock ?? (() => Date.now())
    this.environment = o.environment ?? 'mainnet'
    this.onWarn = o.onWarn ?? ((message) => console.warn(message))
    this.#family = o.family ?? 'v5'
    this.http = new HtxHttp({
      environment: this.environment,
      ...(o.baseUrl !== undefined ? { baseUrl: o.baseUrl } : {}),
      apiKey: o.apiKey,
      apiSecret: o.apiSecret,
      ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}),
      clock,
      ...(o.budget ? { budget: o.budget } : {}),
      ...(o.httpTimeoutMs !== undefined ? { timeoutMs: o.httpTimeoutMs } : {}),
      onWarn: this.onWarn,
    })
    const marketOptions: MarketOptions = {
      environment: this.environment,
      ...(o.baseUrl !== undefined ? { baseUrl: o.baseUrl } : {}),
      ...(o.fetchImpl !== undefined ? { fetchImpl: o.fetchImpl } : {}),
      clock,
      ...(o.staleMs !== undefined ? { staleMs: o.staleMs } : {}),
      ...(o.pollMs !== undefined ? { pollMs: o.pollMs } : {}),
      ...(o.httpTimeoutMs !== undefined ? { httpTimeoutMs: o.httpTimeoutMs } : {}),
    }
    this.market = new HtxTradeMarket(marketOptions)
    this.accounts = new HtxAccounts({
      http: this.http,
      clock,
      options: {
        ...o.accounts,
        family: this.#family,
        ...(o.marginMode !== undefined ? { marginMode: o.marginMode } : {}),
        ...(o.defaultSymbol !== undefined ? { defaultSymbol: o.defaultSymbol } : {}),
      },
      contractSizeOf: this.market.contractSizeOf,
    }, [o.apiSecret, o.apiKey])
    this.trading = new HtxTrading({
      http: this.http,
      instrumentOf: (id) => this.market.getInstrument(id),
      quoteOf: (id) => {
        const q = this.market.quote(id)
        return q ? { bid: q.bid, ask: q.ask, ...(q.last !== undefined ? { last: q.last } : {}), stale: q.stale } : undefined
      },
      openOrders: (ref, instrumentId) => this.accounts.openOrders(ref, instrumentId),
      orderStatus: (ref, key, opts) => this.accounts.orderStatus(ref, key, opts ?? {}),
      faceValueOf: (id) => this.market.faceValueOf(id),
      clock,
      family: this.#family,
      hedge: o.positionMode === 'hedge',
      marginMode: o.marginMode ?? 'cross',
      ...(o.defaultSymbol !== undefined ? { defaultSymbol: o.defaultSymbol } : {}),
      accounts: this.accounts,
    }, [o.apiSecret, o.apiKey])
  }

  /** 拉合约信息并建本地标的地图（行情与下单精度的前置）。 */
  start(): Promise<void> {
    return this.market.start()
  }

  async close(): Promise<void> {
    await this.market.close()
  }

  describe(): VenueCapabilities {
    return htxCapabilities({ family: this.#family })
  }

  // ---- 行情（只读；本包自带最小实现）----
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
  /** 场所级死人开关：HTX v5 有 cancel-after（本包未实现），不伪装。 */
  armDeadman(_ctx: TradeContext, _opts?: { delaySec?: number; onError?: (e: Error) => void }): DeadmanHandle {
    throw new ProblemError(makeProblem('CAPABILITY_UNSUPPORTED', 'cancel-after is not implemented by this connector; keep the kernel cancel loop'))
  }

  /** 仓位级止盈止损委托（POST /linear-swap-api/v1/swap_cross_tpsl_order）。 */
  setTpsl(ctx: TradeContext, spec: TpslSpec): Promise<Record<string, unknown>> {
    return this.trading.setTpsl(ctx, spec)
  }

  /** 诊断：预算占用（含下单计数桶）。 */
  budgetUsage(): ReturnType<HtxHttp['usage']> {
    return this.http.usage()
  }
}

/** 缺省预算工厂（同机多连接时由内核注入一份共用）。 */
export function defaultBudget(clock?: () => number): HtxBudget {
  return createWeightBudget(clock ? { clock } : {})
}
