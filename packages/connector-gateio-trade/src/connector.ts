// SPDX-License-Identifier: CPAL-1.0
// Gate.io USDT 永续交易连接器：把行情 / 账户 / 交易三块装成一个 VenueConnector。
// **未注册进内核、未接真网**：README 首句写明「未经真网验证，不得接实盘」。
// 它自己不会下单：submit / cancel / amend 只在内核发起的调用里执行；签名是 API key 二元组（apiKey / apiSecret），
// 只从构造参数进、放 `#` 私有字段，因此**不使用** ctx.signer 也不回调 ctx.onSigned。
import type { Book, Candle, CandleInterval, Instrument, InstrumentId, MarketContext, Ms, OrderIntent, VenueCapabilities } from '@gitrader/protocol'
import type {
  AccountRef, AmendRequest, CancelAck, CancelTarget, Environment, MarketStatus, StampedQuote, StartupSnapshot,
  SubmitResult, SubscriptionSpec, TradeContext, Unsubscribe, VenueConnector, VenueEvent, VenueFill, VenueOpenOrder,
  VenueOrderStatus,
} from '@gitrader/protocol/connector'
import { GateAccounts } from './account'
import type { AccountsOptions } from './account'
import { createWeightBudget } from './budget'
import type { GateBudget } from './budget'
import { gateioCapabilities } from './capabilities'
import type { CapabilityOptions } from './capabilities'
import { GateTradeMarket } from './market'
import type { GateMarketOptions } from './market'
import { VENUE } from './parse'
import { GATE_ENDPOINTS, GateHttp } from './rest'
import { GateTrading } from './trading'

export interface GateioTradeConnectorOptions {
  environment?: Environment
  /** 测试 / 镜像用基址；缺省 https://api.gateio.ws。 */
  baseUrl?: string
  apiKey: string
  apiSecret: string
  fetchImpl?: typeof fetch
  clock?: () => number
  httpTimeoutMs?: number
  /** 内核注入的预算（行情 + 私有端点共用一份）；缺省本连接器自己一份。 */
  budget?: GateBudget
  accounts?: AccountsOptions
  market?: Pick<GateMarketOptions, 'staleMs' | 'pollMs'>
  capabilities?: CapabilityOptions
  onWarn?: (message: string) => void
}

export class GateioTradeConnector implements VenueConnector {
  readonly venue = VENUE
  readonly environment: Environment
  readonly http: GateHttp
  readonly market: GateTradeMarket
  readonly accounts: GateAccounts
  readonly trading: GateTrading
  readonly budget: GateBudget
  readonly #secrets: readonly string[]
  readonly #capabilities: CapabilityOptions

  constructor(o: GateioTradeConnectorOptions) {
    this.environment = o.environment ?? 'mainnet'
    const clock = o.clock ?? (() => Date.now())
    this.budget = o.budget ?? createWeightBudget({ clock })
    this.#secrets = [o.apiSecret, o.apiKey]
    this.#capabilities = o.capabilities ?? {}
    const baseUrl = o.baseUrl ?? GATE_ENDPOINTS[this.environment]
    this.http = new GateHttp({
      environment: this.environment,
      baseUrl,
      apiKey: o.apiKey,
      apiSecret: o.apiSecret,
      ...(o.fetchImpl !== undefined ? { fetchImpl: o.fetchImpl } : {}),
      clock,
      ...(o.httpTimeoutMs !== undefined ? { timeoutMs: o.httpTimeoutMs } : {}),
      budget: this.budget,
      ...(o.onWarn !== undefined ? { onWarn: o.onWarn } : {}),
    })
    this.market = new GateTradeMarket({
      http: this.http,
      baseUrl,
      clock,
      budget: this.budget,
      environment: this.environment,
      ...(o.fetchImpl !== undefined ? { fetchImpl: o.fetchImpl } : {}),
      ...(o.httpTimeoutMs !== undefined ? { httpTimeoutMs: o.httpTimeoutMs } : {}),
      ...(o.market?.staleMs !== undefined ? { staleMs: o.market.staleMs } : {}),
      ...(o.market?.pollMs !== undefined ? { pollMs: o.market.pollMs } : {}),
    })
    this.accounts = new GateAccounts(this.http, clock, o.accounts ?? {}, this.market)
    this.trading = new GateTrading(
      {
        http: this.http,
        market: this.market,
        accounts: this.accounts,
        clock,
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
    return gateioCapabilities(this.#capabilities)
  }

  async close(): Promise<void> {
    await this.market.close()
  }

  // ---- 行情（复用 packages/connector-gateio-data） ----
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
  positions(ref: AccountRef, contract?: string) { return this.accounts.positions(ref, contract) }
  /** 资金费流水（account_book?type=fund）。 */
  fundingPayments(fromMs: Ms, toMs: Ms, contract?: string) { return this.accounts.fundingPayments(fromMs, toMs, contract) }
  /** 账户持仓模式（single / dual / dual_plus；取不到为空串）。 */
  positionMode(): Promise<string> { return this.accounts.positionMode() }

  // ---- 交易 ----
  submit(ctx: TradeContext, intents: OrderIntent[]): Promise<SubmitResult> { return this.trading.submit(ctx, intents) }
  cancel(ctx: TradeContext, targets: CancelTarget[]): Promise<CancelAck[]> { return this.trading.cancel(ctx, targets) }
  cancelAll(ctx: TradeContext, instrumentId?: string): Promise<CancelAck[]> { return this.trading.cancelAll(ctx, instrumentId) }
  amend(ctx: TradeContext, req: AmendRequest): Promise<SubmitResult> { return this.trading.amend(ctx, req) }
  setLeverage(ctx: TradeContext, instrumentId: string, leverage: number, marginMode: 'cross' | 'isolated'): Promise<void> {
    return this.trading.setLeverage(ctx, instrumentId, leverage, marginMode)
  }
  /** Gate.io 无定时全撤端点：一律 5002（不在能力里假装支持）。 */
  scheduleCancel(ctx: TradeContext, atMs: Ms | null): Promise<void> { return this.trading.scheduleCancel(ctx, atMs) }

  /** 密钥脱敏入口（诊断 / 上层组 Problem 时可用；不返回密钥本身）。 */
  redact(text: string): string {
    let out = text
    for (const secret of this.#secrets) out = out.split(secret).join('<redacted>')
    return out
  }
}
