// SPDX-License-Identifier: CPAL-1.0
// Alpaca 美股交易连接器：把标的目录 / 账户 / 交易 / 私有流装成一个 VenueConnector。
// **未注册进内核、未接真网**：README 首句写明「未经真网验证，不得接实盘」。
// 它自己不会下单：submit / cancel / amend / cancelAll 只在内核发起的调用里执行；
// 鉴权是请求头密钥对（APCA-API-KEY-ID / APCA-API-SECRET-KEY，不是 HMAC），密钥只从构造参数进、放 `#` 私有字段，
// 因此**不使用** ctx.signer 也不回调 ctx.onSigned。
// 行情：本包只做「参考价」这一件事（市价价带要用），K 线 / 盘口 / 深度属于只读行情包
// （`@gitrader/connector-alpaca-data`）；本包对 book / candles / context / mids / book 订阅回 5002，
// 不在这里假装有行情能力（八条 #8：能力老实）。
import { makeProblem } from '@gitrader/protocol'
import type { Book, Candle, CandleInterval, Instrument, MarketContext, Ms, OrderIntent, VenueCapabilities } from '@gitrader/protocol'
import type {
  AccountRef, AmendRequest, CancelAck, CancelTarget, MarketStatus, StampedQuote, StartupSnapshot, SubmitResult,
  SubscriptionSpec, TradeContext, Unsubscribe, VenueConnector, VenueEvent, VenueFill, VenueOpenOrder, VenueOrderStatus,
} from '@gitrader/protocol/connector'
import { AlpacaAccounts } from './account'
import type { AccountsOptions } from './account'
import { AlpacaAssets } from './catalog'
import { AlpacaCalendar } from './calendar'
import { alpacaCapabilities } from './capabilities'
import { STREAM_URLS, TRADING_BASE_URLS, VENUE } from './constants'
import type { AlpacaMode } from './constants'
import { createAlpacaBudget } from './budget'
import type { AlpacaBudget } from './budget'
import { ProblemError, asProblem } from './errors'
import { orderStatusOf } from './parse'
import { AlpacaQuotes } from './quotes'
import type { QuoteSource } from './quotes'
import type { ProtectionRequest } from './orders'
import { AlpacaHttp } from './rest'
import { AlpacaTradeStream, fillFromUpdate } from './stream'
import type { SocketLike, TradeUpdate } from './stream'
import { AlpacaTrading } from './trading'
import type { ProtectionResult } from './trading'

export interface AlpacaTradeConnectorOptions {
  /** 环境：paper（缺省）/ live。密钥前缀 PK / AK 必须与之一致，否则构造时抛。 */
  mode?: AlpacaMode
  /** 测试 / 镜像用基址；缺省按 mode 取官方基址。 */
  baseUrl?: string
  /** 数据 API 基址（参考价）；缺省 https://data.alpaca.markets。 */
  dataBaseUrl?: string
  /** 私有流地址；缺省按 mode 取官方 wss。 */
  streamUrl?: string
  apiKey: string
  apiSecret: string
  fetchImpl?: typeof fetch
  clock?: () => number
  httpTimeoutMs?: number
  /** 内核注入的预算（交易 + 行情共用一份）；缺省本连接器自己一份。 */
  budget?: AlpacaBudget
  accounts?: AccountsOptions
  /** 标的缓存 TTL（毫秒），缺省 10 分钟。 */
  assetTtlMs?: number
  /** 参考价来源（缺省 AlpacaQuotes，走数据 API snapshot）。 */
  quotes?: QuoteSource
  /** 数据源：免费档 iex（缺省）。 */
  feed?: 'iex' | 'sip' | 'delayed_sip' | 'otc'
  /** 盘前盘后是否允许（显式声明；协议 OrderIntent 无此字段，见 REPORT）。缺省 false。 */
  extendedHours?: boolean
  /** 市价参考价最大年龄（毫秒），缺省 5000。 */
  refPriceMaxAgeMs?: number
  /** 报价轮询间隔（毫秒），缺省 1000。 */
  pollMs?: number
  /** 注入私有流 socket（测试）；缺省用宿主 WebSocket。 */
  streamSocket?: () => SocketLike
  onWarn?: (message: string) => void
}

/**
 * trade_updates 里 `order.qty` / `order.filled_qty` 的原始文本（calculated 判量用）；字段缺失或空串按 '0'。
 */
function streamQtyText(update: TradeUpdate, field: 'qty' | 'filled_qty'): string {
  const order = update.raw['order']
  if (typeof order !== 'object' || order === null) return '0'
  const value = (order as Record<string, unknown>)[field]
  const text = value === undefined || value === null ? '' : String(value).trim()
  return text === '' ? '0' : text
}

export class AlpacaTradeConnector implements VenueConnector {
  readonly venue = VENUE
  readonly mode: AlpacaMode
  readonly http: AlpacaHttp
  readonly accounts: AlpacaAccounts
  readonly assets: AlpacaAssets
  readonly calendar: AlpacaCalendar
  readonly quotes: QuoteSource
  readonly trading: AlpacaTrading
  readonly stream: AlpacaTradeStream
  readonly budget: AlpacaBudget
  readonly #secrets: readonly string[]
  readonly #extendedHours: boolean
  readonly #pollMs: number
  readonly #clock: () => number
  readonly #onWarn: (message: string) => void
  readonly #pollers = new Map<string, ReturnType<typeof setInterval>>()
  readonly #unsubscribers = new Set<Unsubscribe>()

  constructor(o: AlpacaTradeConnectorOptions) {
    this.mode = o.mode ?? 'paper'
    const clock = o.clock ?? (() => Date.now())
    this.#clock = clock
    this.#extendedHours = o.extendedHours === true
    this.#pollMs = o.pollMs ?? 1_000
    this.#onWarn = o.onWarn ?? ((message) => console.warn(message))
    this.#secrets = [o.apiSecret, o.apiKey]
    this.budget = o.budget ?? createAlpacaBudget({ clock })
    this.http = new AlpacaHttp({
      mode: this.mode,
      ...(o.baseUrl !== undefined ? { baseUrl: o.baseUrl } : {}),
      ...(o.dataBaseUrl !== undefined ? { dataBaseUrl: o.dataBaseUrl } : {}),
      apiKey: o.apiKey,
      apiSecret: o.apiSecret,
      ...(o.fetchImpl !== undefined ? { fetchImpl: o.fetchImpl } : {}),
      clock,
      ...(o.httpTimeoutMs !== undefined ? { timeoutMs: o.httpTimeoutMs } : {}),
      budget: this.budget,
      onWarn: this.#onWarn,
    })
    this.calendar = new AlpacaCalendar(this.http, undefined, clock)
    this.assets = new AlpacaAssets(this.http, {
      calendar: () => this.calendar.get(),
      clock,
      ...(o.assetTtlMs !== undefined ? { ttlMs: o.assetTtlMs } : {}),
    })
    this.accounts = new AlpacaAccounts(this.http, clock, o.accounts ?? {})
    this.quotes = o.quotes ?? new AlpacaQuotes(this.http, {
      clock,
      ...(o.feed !== undefined ? { feed: o.feed } : {}),
      ...(o.refPriceMaxAgeMs !== undefined ? { maxAgeMs: o.refPriceMaxAgeMs } : {}),
    })
    this.trading = new AlpacaTrading({
      http: this.http,
      accounts: this.accounts,
      assets: this.assets,
      quotes: this.quotes,
      calendar: () => this.calendar.get(),
      clock,
      ...(this.#extendedHours ? { extendedHours: true } : {}),
      ...(o.refPriceMaxAgeMs !== undefined ? { refPriceMaxAgeMs: o.refPriceMaxAgeMs } : {}),
      onWarn: this.#onWarn,
    }, this.#secrets)
    this.stream = new AlpacaTradeStream({
      url: o.streamUrl ?? STREAM_URLS[this.mode],
      apiKey: o.apiKey,
      apiSecret: o.apiSecret,
      clock,
      onWarn: this.#onWarn,
      ...(o.streamSocket !== undefined ? { socket: o.streamSocket } : {}),
    })
  }

  /** paper = testnet（另一套基址），live = mainnet。 */
  get environment(): 'mainnet' | 'testnet' {
    return this.mode === 'paper' ? 'testnet' : 'mainnet'
  }

  /** 交易基址（诊断 / 测试断言）。 */
  get baseUrl(): string {
    return this.http.baseUrl
  }

  /** 拉一次交易日历（内核启动时调用；失败就保持空日历 = 全休市）。 */
  async start(): Promise<void> {
    await this.calendar.load()
  }

  /** 预热标的目录（`GET /v2/assets`；可选，缺省按需单张取）。 */
  warmAssets(): Promise<unknown[]> {
    return this.assets.loadAll()
  }

  /** 刷新交易日历（跨日 / 长假后由内核排程）。 */
  syncCalendar(): Promise<unknown> {
    return this.calendar.load()
  }

  describe(): VenueCapabilities {
    return alpacaCapabilities({ extendedHours: this.#extendedHours })
  }

  async close(): Promise<void> {
    for (const [, timer] of this.#pollers) clearInterval(timer)
    this.#pollers.clear()
    for (const off of this.#unsubscribers) off()
    this.#unsubscribers.clear()
    this.stream.close()
  }

  // ---- 行情（本包只做参考价；其余 5002）----
  listInstruments(opts?: { includeDelisted?: boolean }): Instrument[] {
    return this.assets.list()
      .filter((record) => opts?.includeDelisted === true || record.instrument.status === 'trading')
      .map((record) => record.instrument)
  }

  getInstrument(id: string): Instrument | undefined {
    return this.assets.instrument(id)
  }

  quote(id: string): StampedQuote | undefined {
    const symbol = id.slice(id.indexOf(':') + 1)
    const ref = (this.quotes as AlpacaQuotes).cached?.(symbol)
    if (ref === undefined) return undefined
    const bid = ref.bid ?? ref.mid ?? ref.ask
    const ask = ref.ask ?? ref.mid ?? ref.bid
    if (bid === undefined || ask === undefined) return undefined
    return {
      instrumentId: id,
      ts: ref.ts ?? this.#clock(),
      bid,
      ask,
      ...(ref.mid !== undefined ? { last: ref.mid } : {}),
      stale: ref.stale === true,
      ageMs: ref.ageMs ?? 0,
    }
  }

  /** 拉一次报价（交易前刷新用）。 */
  async refreshQuote(id: string): Promise<StampedQuote | undefined> {
    const symbol = id.slice(id.indexOf(':') + 1)
    await this.quotes.latest(symbol)
    return this.quote(id)
  }

  book(): Promise<Book> {
    return this.unsupported('book')
  }

  candles(_id: string, _interval: CandleInterval, _opts?: { n?: number; from?: Ms; to?: Ms }): Promise<Candle[]> {
    return this.unsupported('candles')
  }

  context(): Promise<MarketContext> {
    return this.unsupported('context')
  }

  /**
   * 订阅：只做 quote（轮询参考价）与 orderUpdates / userFills（私有流）。
   * mids / book / candle / context / instruments 属于行情包，这里回 5002（不假装）。
   */
  subscribe(spec: SubscriptionSpec, cb: (e: VenueEvent) => void): Unsubscribe {
    if (spec.channel === 'quote') {
      const id = spec.instrumentId
      const symbol = id.slice(id.indexOf(':') + 1)
      const timer = setInterval(() => {
        void this.quotes.latest(symbol).then((ref) => {
          if (ref === undefined) return
          const bid = ref.bid ?? ref.mid ?? ref.ask
          const ask = ref.ask ?? ref.mid ?? ref.bid
          if (bid === undefined || ask === undefined) return
          cb({
            channel: 'quote',
            quote: {
              instrumentId: id,
              ts: ref.ts ?? this.#clock(),
              bid,
              ask,
              ...(ref.mid !== undefined ? { last: ref.mid } : {}),
              stale: ref.stale === true,
              ageMs: ref.ageMs ?? 0,
            },
          })
        })
      }, this.#pollMs)
      const off = (): void => {
        clearInterval(timer)
        this.#pollers.delete(id)
      }
      this.#pollers.set(id, timer)
      return off
    }
    if (spec.channel === 'orderUpdates' || spec.channel === 'userFills') {
      const address = spec.address
      const off = this.stream.onUpdate((update: TradeUpdate) => {
        // replaced 不是逻辑订单的终态（新单会有自己的事件），不外发。
        if (update.event === 'replaced' || update.status === 'replaced') return
        const clientOrderId = this.accounts.originalClientOrderId(update.venueOrderId)
          ?? this.accounts.originalClientOrderId(update.clientOrderId)
          ?? update.clientOrderId
        if (spec.channel === 'userFills') {
          const fill: VenueFill | null = fillFromUpdate(update)
          if (fill === null) return
          cb({ channel: 'userFills', address, fills: [{ ...fill, clientOrderId }], isSnapshot: false })
          return
        }
        cb({
          channel: 'orderUpdates',
          address,
          updates: [{
            venueOrderId: update.venueOrderId,
            clientOrderId,
            instrumentId: update.instrumentId,
            status: orderStatusOf(update.status, streamQtyText(update, 'qty'), streamQtyText(update, 'filled_qty')),
            ts: update.ts,
          }],
        })
      })
      this.#unsubscribers.add(off)
      return () => {
        off()
        this.#unsubscribers.delete(off)
      }
    }
    return this.fail(`alpaca trade connector does not provide the ${spec.channel} channel; use @gitrader/connector-alpaca-data for market data`)
  }

  status(): MarketStatus {
    const usage = this.http.usage()
    const wsState = this.stream.state === 'connected' ? 'connected' : this.stream.state === 'idle' ? 'disconnected' : 'connecting'
    return {
      venue: VENUE,
      environment: this.environment,
      ts: this.#clock(),
      wsState,
      rateBudget: { used: usage.used, limit: usage.limit, windowMs: usage.windowMs },
      stale: this.stream.state !== 'connected',
      source: this.stream.state === 'connected' ? 'ws' : 'rest',
      lastMessageTs: this.stream.lastMessageTs,
    }
  }

  // ---- 账户（只读）----
  accountState(ref: AccountRef) { return this.accounts.accountState(ref) }
  openOrders(ref: AccountRef): Promise<VenueOpenOrder[]> { return this.accounts.openOrders(ref) }
  fills(ref: AccountRef, sinceMs: Ms): Promise<VenueFill[]> { return this.accounts.fills(ref, sinceMs) }
  orderStatus(ref: AccountRef, key: { clientOrderId?: string; venueOrderId?: string }): Promise<VenueOrderStatus> {
    return this.accounts.orderStatus(ref, key)
  }
  startupSnapshot(ref: AccountRef, fillsSinceMs: Ms): Promise<StartupSnapshot> { return this.accounts.startupSnapshot(ref, fillsSinceMs) }
  /** 持仓专用端点（教训 5）。 */
  positions(ref: AccountRef) { return this.accounts.positions(ref) }
  /** 账户限制标志（八条 #6；协议 AccountSnapshot 没有这些字段，见 REPORT）。 */
  restrictions(ref: AccountRef) { return this.accounts.restrictions(ref) }
  /** 当前时段（诊断；下单的判断在 trading 内部用同一函数）。 */
  session() { return this.trading.session() }

  // ---- 交易 ----
  submit(ctx: TradeContext, intents: OrderIntent[]): Promise<SubmitResult> { return this.trading.submit(ctx, intents) }
  cancel(ctx: TradeContext, targets: CancelTarget[]): Promise<CancelAck[]> { return this.trading.cancel(ctx, targets) }
  cancelAll(ctx: TradeContext, instrumentId?: string): Promise<CancelAck[]> { return this.trading.cancelAll(ctx, instrumentId) }
  amend(ctx: TradeContext, req: AmendRequest): Promise<SubmitResult> { return this.trading.amend(ctx, req) }
  /** 3006 之后按 client_order_id 对账（不重发）。 */
  reconcile(ctx: TradeContext, clientOrderId: string): Promise<VenueOrderStatus> { return this.trading.reconcile(ctx, clientOrderId) }
  /** 成交后挂位置级 OCO 保护单。 */
  placeProtection(ctx: TradeContext, req: ProtectionRequest): Promise<ProtectionResult[]> { return this.trading.placeProtection(ctx, req) }
  /** Alpaca 没有定时全撤端点：5002。 */
  scheduleCancel(ctx: TradeContext, atMs: Ms | null): Promise<void> { return this.trading.scheduleCancel(ctx, atMs) }

  /**
   * 杠杆：Alpaca 的保证金倍数是**账户级**（Reg T 2 倍 / PDT 4 倍），由券商设定，没有逐标的端点。
   * 请求值等于账户现值就算成功；不等就 5002（不假装能改）。
   */
  async setLeverage(ctx: TradeContext, instrumentId: string, leverage: number, marginMode: 'cross' | 'isolated'): Promise<void> {
    void instrumentId
    if (marginMode !== 'cross') {
      throw new ProblemError(makeProblem('CAPABILITY_UNSUPPORTED', 'Alpaca has no isolated margin for equities; only cross (account-level) margin exists'))
    }
    if (!Number.isInteger(leverage) || leverage < 1) {
      throw new ProblemError(makeProblem('INVALID_PARAMS', 'leverage must be a positive integer'))
    }
    const restrictions = await this.accounts.restrictions(ctx.account)
    if (leverage !== restrictions.multiplier) {
      throw new ProblemError(makeProblem('CAPABILITY_UNSUPPORTED', `Alpaca sets the margin multiplier at the account level (current ${restrictions.multiplier}x); this connector cannot change it to ${leverage}x`))
    }
  }

  private fail(message: string): never {
    throw new ProblemError(makeProblem('CAPABILITY_UNSUPPORTED', message))
  }

  private async unsupported<T>(what: string): Promise<T> {
    return this.fail(`alpaca trade connector does not implement ${what}(); use @gitrader/connector-alpaca-data for market data`)
  }

  /** 脱敏后的错误文本（诊断用；错误对象本身不含密钥）。 */
  safeText(e: unknown): string {
    return this.http.safeText(e)
  }

  /** 任意错误 → Problem（脱敏后）。 */
  problemOf(e: unknown) {
    return asProblem(e, { secrets: this.#secrets, endpoint: 'signed' })
  }

  /** 交易基址表（诊断）。 */
  static baseUrls = TRADING_BASE_URLS
}
