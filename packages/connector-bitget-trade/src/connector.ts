// SPDX-License-Identifier: CPAL-1.0
// Bitget USDT 永续交易连接器：把行情 / 账户 / 交易三块装成一个 VenueConnector。
// **未注册进内核、未接真网**：README 首句写明「未经真网验证，不得接实盘」。
// 它自己不会下单：submit / cancel / amend 只在内核发起的调用里执行；签名是 API key 三元组（apiKey / apiSecret /
// passphrase），只从构造参数进、放 `#` 私有字段，因此**不使用** ctx.signer 也不回调 ctx.onSigned。
import type { Book, Candle, CandleInterval, Instrument, InstrumentId, MarketContext, Ms, OrderIntent, VenueCapabilities } from '@gitrader/protocol'
import type {
  AccountRef, AmendRequest, CancelAck, CancelTarget, Environment, MarketStatus, StampedQuote, StartupSnapshot,
  SubmitResult, SubscriptionSpec, TradeContext, Unsubscribe, VenueConnector, VenueEvent, VenueFill, VenueOpenOrder,
  VenueOrderStatus,
} from '@gitrader/protocol/connector'
import { BitgetAccounts } from './account'
import type { AccountsOptions } from './account'
import { createCountBudget } from './budget'
import type { BitgetBudget } from './budget'
import { bitgetCapabilities } from './capabilities'
import { BitgetTradeMarket } from './market'
import type { BitgetMarketOptions } from './market'
import { VENUE } from './parse'
import { BitgetHttp } from './rest'
import { BitgetTrading } from './trading'
import type { ProtectionOrder, ProtectionRequest } from './orders'

export interface BitgetTradeConnectorOptions {
  environment?: Environment
  /** 测试 / 镜像用基址；缺省 https://api.bitget.com。 */
  baseUrl?: string
  apiKey: string
  apiSecret: string
  /** Bitget 的第三件凭据（passphrase）。 */
  passphrase: string
  /** 模拟盘：缺省跟随 environment（testnet = 打开 PAPTRADING: 1）。 */
  simulated?: boolean
  /** 渠道码：QL 自带一个，我们默认不发（不冒用）。 */
  channelApiCode?: string
  fetchImpl?: typeof fetch
  clock?: () => number
  httpTimeoutMs?: number
  /** 内核注入的预算（行情 + 私有端点共用一份）；缺省本连接器自己一份。 */
  budget?: BitgetBudget
  accounts?: AccountsOptions
  market?: Pick<BitgetMarketOptions, 'staleMs' | 'pollMs'>
  defaultMarginMode?: 'cross' | 'isolated'
  /** 市价参考报价最大年龄（毫秒），缺省 5000；超过就拒单（不透传到内核）。 */
  refPriceMaxAgeMs?: number
  onWarn?: (message: string) => void
}

export class BitgetTradeConnector implements VenueConnector {
  readonly venue = VENUE
  readonly environment: Environment
  readonly http: BitgetHttp
  readonly market: BitgetTradeMarket
  readonly accounts: BitgetAccounts
  readonly trading: BitgetTrading
  readonly budget: BitgetBudget
  readonly #secrets: readonly string[]

  constructor(o: BitgetTradeConnectorOptions) {
    this.environment = o.environment ?? 'mainnet'
    const clock = o.clock ?? (() => Date.now())
    this.budget = o.budget ?? createCountBudget({ clock })
    this.#secrets = [o.apiSecret, o.apiKey, o.passphrase]
    this.http = new BitgetHttp({
      environment: this.environment,
      ...(o.baseUrl !== undefined ? { baseUrl: o.baseUrl } : {}),
      apiKey: o.apiKey,
      apiSecret: o.apiSecret,
      passphrase: o.passphrase,
      ...(o.simulated !== undefined ? { simulated: o.simulated } : {}),
      ...(o.channelApiCode !== undefined ? { channelApiCode: o.channelApiCode } : {}),
      ...(o.fetchImpl !== undefined ? { fetchImpl: o.fetchImpl } : {}),
      clock,
      ...(o.httpTimeoutMs !== undefined ? { timeoutMs: o.httpTimeoutMs } : {}),
      budget: this.budget,
      ...(o.onWarn !== undefined ? { onWarn: o.onWarn } : {}),
    })
    this.market = new BitgetTradeMarket({
      clock,
      budget: this.budget,
      environment: this.environment,
      ...(o.baseUrl !== undefined ? { baseUrl: o.baseUrl } : {}),
      ...(o.fetchImpl !== undefined ? { fetchImpl: o.fetchImpl } : {}),
      ...(o.httpTimeoutMs !== undefined ? { httpTimeoutMs: o.httpTimeoutMs } : {}),
      ...(o.market?.staleMs !== undefined ? { staleMs: o.market.staleMs } : {}),
      ...(o.market?.pollMs !== undefined ? { pollMs: o.market.pollMs } : {}),
    })
    this.accounts = new BitgetAccounts(this.http, clock, o.accounts ?? {})
    this.trading = new BitgetTrading(
      {
        http: this.http,
        market: this.market,
        accounts: this.accounts,
        clock,
        ...(o.defaultMarginMode !== undefined ? { defaultMarginMode: o.defaultMarginMode } : {}),
        ...(o.refPriceMaxAgeMs !== undefined ? { refPriceMaxAgeMs: o.refPriceMaxAgeMs } : {}),
        ...(o.onWarn !== undefined ? { onWarn: o.onWarn } : {}),
      },
      this.#secrets,
    )
  }

  /** 拉一次合约清单（内核启动时调用）。 */
  start(): Promise<void> {
    return this.market.start()
  }

  describe(): VenueCapabilities {
    return bitgetCapabilities()
  }

  async close(): Promise<void> {
    await this.market.close()
  }

  // ---- 行情（复用 packages/connector-bitget-data） ----
  listInstruments(opts?: { includeDelisted?: boolean }): Instrument[] { return this.market.listInstruments(opts) }
  getInstrument(id: string): Instrument | undefined { return this.market.getInstrument(id) }
  quote(id: string): StampedQuote | undefined { return this.market.quote(id) }
  book(id: string, depth?: number): Promise<Book> { return this.market.book(id, depth) }
  candles(id: string, interval: CandleInterval, opts?: { n?: number; from?: Ms; to?: Ms }): Promise<Candle[]> { return this.market.candles(id, interval, opts) }
  context(id: string): Promise<MarketContext> { return this.market.context(id) }
  subscribe(spec: SubscriptionSpec, cb: (e: VenueEvent) => void): Unsubscribe { return this.market.subscribe(spec, cb) }
  status(): MarketStatus { return this.market.status() }
  /** 拉一次报价（交易前刷新用；`quote()` 是同步缓存）。 */
  refreshQuote(id: string): Promise<StampedQuote | undefined> { return this.market.refreshQuote(id) }

  // ---- 账户（只读） ----
  accountState(ref: AccountRef) { return this.accounts.accountState(ref) }
  openOrders(ref: AccountRef): Promise<VenueOpenOrder[]> { return this.accounts.openOrders(ref) }
  fills(ref: AccountRef, sinceMs: Ms, opts?: { instrumentId?: InstrumentId }): Promise<VenueFill[]> { return this.accounts.fills(ref, sinceMs, opts) }
  orderStatus(ref: AccountRef, key: { clientOrderId?: string; venueOrderId?: string; instrumentId?: InstrumentId }): Promise<VenueOrderStatus> {
    return this.accounts.orderStatus(ref, key)
  }
  startupSnapshot(ref: AccountRef, fillsSinceMs: Ms): Promise<StartupSnapshot> { return this.accounts.startupSnapshot(ref, fillsSinceMs) }
  /** 持仓专用端点（教训 5：不从账户汇总里取残缺字段）。 */
  positions(ref: AccountRef) { return this.accounts.positions(ref) }

  // ---- 交易 ----
  submit(ctx: TradeContext, intents: OrderIntent[]): Promise<SubmitResult> { return this.trading.submit(ctx, intents) }
  cancel(ctx: TradeContext, targets: CancelTarget[]): Promise<CancelAck[]> { return this.trading.cancel(ctx, targets) }
  cancelAll(ctx: TradeContext, instrumentId?: string): Promise<CancelAck[]> { return this.trading.cancelAll(ctx, instrumentId) }
  amend(ctx: TradeContext, req: AmendRequest): Promise<SubmitResult> { return this.trading.amend(ctx, req) }
  setLeverage(ctx: TradeContext, instrumentId: string, leverage: number, marginMode: 'cross' | 'isolated'): Promise<void> {
    return this.trading.setLeverage(ctx, instrumentId, leverage, marginMode)
  }
  /** Bitget 无定时全撤端点：一律 5002（不在能力里假装支持）。 */
  scheduleCancel(ctx: TradeContext, atMs: Ms | null): Promise<void> { return this.trading.scheduleCancel(ctx, atMs) }
  /** 成交后补挂位置级保护单（内核调用；连接器不会自己挂）。 */
  placeProtection(ctx: TradeContext, req: ProtectionRequest): Promise<ProtectionOrder[]> { return this.trading.placeProtection(ctx, req) }
}
