// SPDX-License-Identifier: CPAL-1.0
// Hyperliquid 连接器：把行情 / 账户 / 交易三块装成一个 VenueConnector。
// 内核创建它时注入：权重预算（同一机器共用一个）、环境（主网 / 测试网）、可选的 builder 收费地址。
// 它自己不会下单：submit / cancel / amend 只在内核发起的调用里执行，签名一律走内核给的 signer 句柄。
import type { Book, Candle, CandleInterval, Instrument, InstrumentId, MarketContext, Ms, OrderIntent, VenueCapabilities } from '@gitrader/protocol'
import type { FundingRatePoint } from './market'
import { makeProblem, normalizeDecimal } from '@gitrader/protocol'
import { fx } from '@gitrader/protocol/decimal'
import { buildApproveBuilderFee } from './approvals'
import type { UserSignedRequest } from './approvals'
import { ProblemError } from './errors'
import { createWeightBudget, withKindCaps } from './budget'
import type { RateBudget } from './budget'
import { hyperliquidCapabilities } from './capabilities'
import { HlAccounts, mapFill } from './account'
import type { AccountsOptions, CachedAccountSnapshot } from './account'
import { HlMarket } from './market'
import type { BookSnapshot } from './market'
import { NonceManager } from './nonce'
import { MARKET_PRICE_BAND_BPS, VENUE, instrumentIdOf } from './parse'
import { HlHttp } from './rest'
import type { Environment } from './rest'
import { HlTrading } from './trading'
import type { VenueExpiryDiagnostic } from './trading'
import type {
  AccountRef, AmendRequest, CancelAck, CancelTarget, CandleRecorder, DeadmanHandle, Hex, MarkPrice, MarketStatus, StampedQuote,
  StartupSnapshot, SubmitResult, SubscriptionSpec, TradeContext, Unsubscribe, VenueConnector, VenueEvent, VenueFill, VenueOpenOrder, VenueOrderStatus,
} from '@gitrader/protocol/connector'

export interface HyperliquidConnectorOptions {
  environment: Environment
  /** 内核注入的权重预算；缺省 = 本连接器自己一份（默认 ≤60% × 1200 / 分钟）。同机多连接时必须共用一份。 */
  budget?: RateBudget
  /** 「支持开发者」：默认 false（产品纯免费，订单不带 builder 字段）。用户在设置里打开才为 true。 */
  supportDeveloper?: boolean
  /** Gitrader 的 builder 收费地址；只有 supportDeveloper 打开且账户已授权时才会附加。 */
  builderAddress?: Hex
  /** 市价单滑点限制（bps），默认 800，范围 0..10000。 */
  marketPriceBandBps?: number
  fetchImpl?: typeof fetch
  WebSocketImpl?: typeof WebSocket
  clock?: () => number
  useWs?: boolean
  staleMs?: number
  markStaleMs?: number
  pollMs?: number
  discoveryIntervalMs?: number
  offlineRecheckMs?: number
  /** 账户读取：stream（默认 true）= WS 用户流增量维护本地快照；false = 禁用 WS 用户流，由后台 REST 维护缓存。其余见 AccountsOptions。 */
  accounts?: AccountsOptions
  /** WS 订阅数上限（官方 1000），默认 900。 */
  maxSubscriptions?: number
  httpTimeoutMs?: number
  /** 后台诊断信息出口；消息固定且不含账户或上游响应内容。 */
  onWarn?: (message: string) => void
  /** 本地期限准备诊断；只携带本地期限、时钟偏差与换算后的期限。 */
  onDiagnostic?: (event: VenueExpiryDiagnostic) => void
  /** L2 快照陈旧阈值（默认 15 s）与 REST 盘口兜底的最小间隔（默认 2 s）。 */
  bookStaleMs?: number
  bookRefreshMinMs?: number
  recorder?: CandleRecorder
  /** 行情 REST（info 类）熔断器：缺省 5 次连续失败 / 30 s 冷却 / half_open 放行 1 次。 */
  circuit?: { failureThreshold?: number; cooldownMs?: number; halfOpenMaxCalls?: number }
}

export class HyperliquidConnector implements VenueConnector {
  readonly venue = VENUE
  readonly environment: Environment
  readonly budget: RateBudget
  readonly market: HlMarket
  readonly accounts: HlAccounts
  readonly trading: HlTrading
  readonly http: HlHttp
  readonly nonce: NonceManager
  /** 「支持开发者」开关当前值（默认 false）。 */
  readonly supportDeveloper: boolean
  readonly marketPriceBandBps: number
  private readonly builderAddress: Hex | undefined

  constructor(o: HyperliquidConnectorOptions) {
    const marketPriceBandBps = o.marketPriceBandBps ?? MARKET_PRICE_BAND_BPS
    if (!Number.isInteger(marketPriceBandBps) || marketPriceBandBps < 0 || marketPriceBandBps > 10_000) {
      throw new RangeError('marketPriceBandBps must be a finite integer from 0 to 10000')
    }
    this.environment = o.environment
    this.supportDeveloper = o.supportDeveloper === true
    this.marketPriceBandBps = marketPriceBandBps
    this.builderAddress = o.builderAddress
    const clock = o.clock ?? (() => Date.now())
    this.budget = o.budget ? withKindCaps(o.budget, clock) : createWeightBudget({ clock })
    this.http = new HlHttp({
      environment: o.environment,
      budget: this.budget,
      clock,
      ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}),
      ...(o.httpTimeoutMs ? { timeoutMs: o.httpTimeoutMs } : {}),
      ...(o.onWarn ? { onWarn: o.onWarn } : {}),
    })
    this.market = new HlMarket({
      environment: o.environment,
      http: this.http,
      budget: this.budget,
      clock,
      ...(o.WebSocketImpl ? { WebSocketImpl: o.WebSocketImpl } : {}),
      ...(o.useWs !== undefined ? { useWs: o.useWs } : {}),
      ...(o.staleMs !== undefined ? { staleMs: o.staleMs } : {}),
      ...(o.markStaleMs !== undefined ? { markStaleMs: o.markStaleMs } : {}),
      ...(o.pollMs !== undefined ? { pollMs: o.pollMs } : {}),
      ...(o.discoveryIntervalMs !== undefined ? { discoveryIntervalMs: o.discoveryIntervalMs } : {}),
      ...(o.offlineRecheckMs !== undefined ? { offlineRecheckMs: o.offlineRecheckMs } : {}),
      ...(o.maxSubscriptions !== undefined ? { maxSubscriptions: o.maxSubscriptions } : {}),
      ...(o.bookStaleMs !== undefined ? { bookStaleMs: o.bookStaleMs } : {}),
      ...(o.bookRefreshMinMs !== undefined ? { bookRefreshMinMs: o.bookRefreshMinMs } : {}),
      ...(o.circuit ? { circuit: o.circuit } : {}),
      ...(o.recorder ? { recorder: o.recorder } : {}),
    })
    this.accounts = new HlAccounts(this.http, this.market, clock, { ...o.accounts, marketPriceBandBps })
    this.nonce = new NonceManager(clock)
    this.trading = new HlTrading({
      http: this.http,
      market: this.market,
      nonce: this.nonce,
      clock,
      supportDeveloper: o.supportDeveloper === true,
      ...(o.onDiagnostic ? { onDiagnostic: o.onDiagnostic } : {}),
      ...(o.builderAddress ? { builderAddress: o.builderAddress } : {}),
      openOrders: (a) => this.accounts.openOrdersFresh(a),
    })
    this.market.onUserMessage = (msg) => this.onUser(msg.channel, msg.data)
  }

  /** 发现标的并连上行情。 */
  start(): Promise<void> {
    return this.market.start()
  }
  async close(): Promise<void> {
    this.accounts.close()
    await this.market.close()
  }

  describe(): VenueCapabilities {
    // protocol v0.1.8：本连接器实现了 bookSnapshot（WS l2Book 维护的本地快照）与 refreshBook（限频兜底），在能力位里声明（集成修补 H v3）
    return { ...hyperliquidCapabilities({ supportDeveloper: this.supportDeveloper, marketPriceBandBps: this.marketPriceBandBps }), bookSnapshot: { snapshot: true, refresh: true, staleAfterMs: this.market.bookStaleAfterMs } }
  }

  /**
   * 授权 builder 费的待签载荷（主钱包在系统浏览器签）。**只有「支持开发者」打开时才会生成**；默认关闭时抛错，
   * 界面不应出现这一步。
   */
  buildApproveBuilderFee(nonce: number): UserSignedRequest {
    if (!this.supportDeveloper) throw new ProblemError(makeProblem('CAPABILITY_UNSUPPORTED', 'supportDeveloper is off; no builder fee approval is requested'))
    if (!this.builderAddress) throw new ProblemError(makeProblem('INVALID_PARAMS', 'no builder address configured'))
    return buildApproveBuilderFee({ environment: this.environment, builderAddress: this.builderAddress, nonce, supportDeveloper: true })
  }

  // ---- 行情 ----
  discoverDexNames(): Promise<void> { return this.market.discoverDexNames() }
  listInstruments(opts?: { includeDelisted?: boolean }): Instrument[] { return this.market.listInstruments(opts) }
  getInstrument(id: InstrumentId): Instrument | undefined { return this.market.getInstrument(id) }
  quote(id: InstrumentId): StampedQuote | undefined { return this.market.quote(id) }
  mark(id: InstrumentId, options: { allowStale?: boolean } = {}): MarkPrice | undefined { return this.market.mark(id, options) }
  book(id: InstrumentId, depth?: number): Promise<Book> { return this.market.book(id, depth) }
  candles(id: InstrumentId, interval: CandleInterval, opts?: { n?: number; from?: Ms; to?: Ms }): Promise<Candle[]> { return this.market.candles(id, interval, opts) }
  fundingHistory(id: InstrumentId, opts: { from: Ms; to?: Ms }): Promise<FundingRatePoint[]> { return this.market.fundingHistory(id, opts) }
  context(id: InstrumentId): Promise<MarketContext> { return this.market.context(id) }
  /** TODO(protocol): 本地 L2 快照 + 限频有界的 REST 兜底，模拟场所用。 */
  bookSnapshot(id: InstrumentId): BookSnapshot | undefined { return this.market.bookSnapshot(id) }
  refreshBook(id: InstrumentId, o?: { maxWaitMs?: number }): Promise<BookSnapshot | undefined> { return this.market.refreshBook(id, o) }
  status(): MarketStatus { return this.market.status() }
  /** 就绪度：主 dex 标的已知 / 全部目录完成（只读；内核据此细化连接状态，不改 status() 的返回形状）。 */
  readiness(): { primaryInstruments: boolean; catalogComplete: boolean } { return this.market.readiness() }
  /** 诊断：info 类 REST 熔断器状态（只读；不改 status() 的返回形状）。 */
  circuit(): { state: 'closed' | 'open' | 'half_open'; failures: number; opens: number; openedAt: number | null } { return this.market.circuit() }

  subscribe(spec: SubscriptionSpec, cb: (e: VenueEvent) => void): Unsubscribe {
    // 用户流的地址统一小写，和场所推送的 user 字段对得上
    const s: SubscriptionSpec = spec.channel === 'userFills' || spec.channel === 'orderUpdates' ? { ...spec, address: spec.address.toLowerCase() as Hex } : spec
    return this.market.subscribe(s, cb)
  }

  private onUser(channel: string, data: unknown): void {
    if (channel === 'userFills') {
      const d = data as { user?: string; isSnapshot?: boolean; fills?: Parameters<typeof mapFill>[0][] } | undefined
      if (!d?.user || !Array.isArray(d.fills)) return
      const address = d.user.toLowerCase() as Hex
      const fills = d.fills.map(mapFill)
      this.http.addressBudget.recordFills(address, fills)
      this.market.emitUser({ channel: 'userFills', address }, { channel: 'userFills', address, fills, isSnapshot: !!d.isSnapshot })
    } else if (channel === 'orderUpdates') {
      // orderUpdates 的数据里没有 user 字段：按已订阅的地址逐个转发
      const arr = Array.isArray(data) ? (data as Array<{ order?: {
        coin?: string; side?: string; limitPx?: string; sz?: string; origSz?: string; triggerPx?: string
        reduceOnly?: unknown; isTrigger?: unknown; oid?: number; cloid?: string; timestamp?: number
      }; status?: string; statusTimestamp?: number }>) : []
      const updates = arr.filter((u) => u.order?.coin).map((u) => {
        const order = u.order!
        const decimal = (value: unknown, positive = false) => {
          if (typeof value !== 'string') return undefined
          try {
            const normalized = normalizeDecimal(value)
            if (positive && fx(normalized) <= 0n) return undefined
            return normalized
          } catch { return undefined }
        }
        return {
          venueOrderId: String(order.oid),
          clientOrderId: order.cloid ? order.cloid.replace(/^0x/, '').toLowerCase() : null,
          instrumentId: instrumentIdOf(order.coin!),
          status: String(u.status),
          ts: u.statusTimestamp ?? order.timestamp ?? Date.now(),
          ...(order.side === 'B' ? { side: 'buy' as const } : order.side === 'A' ? { side: 'sell' as const } : {}),
          ...(decimal(order.sz, true) !== undefined ? { size: decimal(order.sz, true)! } : {}),
          ...(decimal(order.origSz, true) !== undefined ? { origSize: decimal(order.origSz, true)! } : {}),
          ...(decimal(order.limitPx, true) !== undefined ? { price: decimal(order.limitPx, true)! } : {}),
          ...(decimal(order.triggerPx, true) !== undefined ? { triggerPrice: decimal(order.triggerPx, true)! } : {}),
          ...(typeof order.reduceOnly === 'boolean' ? { reduceOnly: order.reduceOnly } : {}),
          ...(typeof order.isTrigger === 'boolean' ? { isTrigger: order.isTrigger } : {}),
          ...(Number.isSafeInteger(order.timestamp) ? { createdAt: order.timestamp } : {}),
        }
      })
      if (updates.length === 0) return
      for (const address of this.market.userAddresses('orderUpdates')) {
        this.market.emitUser({ channel: 'orderUpdates', address }, { channel: 'orderUpdates', address, updates })
      }
    }
  }

  // ---- 账户 ----
  /** 读本地快照（WS 用户流增量维护），带 asOf / stale / source；不打 REST。 */
  accountState(ref: AccountRef): Promise<CachedAccountSnapshot> { return this.accounts.snapshot(ref) }
  /** 快照 + 挂单 + 成交一次拿全，同一个 asOf / stale。 */
  accountView(ref: AccountRef) { return this.accounts.view(ref) }
  untrackAccount(address: Hex): void { this.accounts.untrack(address) }
  openOrders(ref: AccountRef): Promise<VenueOpenOrder[]> { return this.accounts.openOrders(ref) }
  fills(ref: AccountRef, sinceMs: Ms): Promise<VenueFill[]> { return this.accounts.fills(ref, sinceMs) }
  orderStatus(ref: AccountRef, key: { clientOrderId?: string; venueOrderId?: string }): Promise<VenueOrderStatus> { return this.accounts.orderStatus(ref, key) }
  startupSnapshot(ref: AccountRef, fillsSinceMs: Ms): Promise<StartupSnapshot> { return this.accounts.startupSnapshot(ref, fillsSinceMs) }
  builderStatus(address: Hex, builder: Hex) { return this.accounts.builderStatus(address, builder) }

  // ---- 交易 ----
  submit(ctx: TradeContext, intents: OrderIntent[]): Promise<SubmitResult> { return this.trading.submit(ctx, intents) }
  cancel(ctx: TradeContext, targets: CancelTarget[]): Promise<CancelAck[]> { return this.trading.cancel(ctx, targets) }
  cancelAll(ctx: TradeContext, instrumentId?: InstrumentId): Promise<CancelAck[]> { return this.trading.cancelAll(ctx, instrumentId) }
  amend(ctx: TradeContext, req: AmendRequest): Promise<SubmitResult> { return this.trading.amend(ctx, req) }
  setLeverage(ctx: TradeContext, instrumentId: InstrumentId, leverage: number, marginMode: 'cross' | 'isolated'): Promise<void> { return this.trading.setLeverage(ctx, instrumentId, leverage, marginMode) }
  scheduleCancel(ctx: TradeContext, atMs: Ms | null): Promise<void> { return this.trading.scheduleCancel(ctx, atMs) }
  armDeadman(ctx: TradeContext, opts?: { delaySec?: number; onError?: (e: Error) => void }): DeadmanHandle { return this.trading.armDeadman(ctx, opts) }
}

