// SPDX-License-Identifier: CPAL-1.0
// Alpaca 只读行情连接器：把美股行情（assets / bars / snapshot / calendar / clock）包装成 VenueConnector。
// 只做行情：11 个交易 / 账户方法一律抛 CAPABILITY_UNSUPPORTED，不发私有请求、不下任何单。
// 密钥（可选，SIP 订阅与更高限额需要）只在构造参数 / 环境变量进，Http 里是私有字段，不打印、不落盘。
import type {
  Book, Candle, CandleInterval, Instrument, InstrumentId, MarketContext, Ms, OrderIntent, TradingSessionWindow, VenueCapabilities,
} from '@gitrader/protocol'
import type {
  AccountRef, AccountSnapshot, AmendRequest, CancelAck, CancelTarget, Environment, MarketStatus, RateBudget, StampedQuote,
  StartupSnapshot, SubmitResult, SubscriptionSpec, TradeContext, Unsubscribe, VenueConnector, VenueEvent, VenueFill,
  VenueOpenOrder, VenueOrderStatus,
} from '@gitrader/protocol/connector'
import { AlpacaMarket, unlimitedBudget } from './market'
import type { AlpacaMarketOptions } from './market'
import type { BudgetLike } from './http'
import {
  CALENDAR_PATH, MAX_CANDLES, CANDLE_PAGE, RATE_LIMIT, RATE_WINDOW_MS, VENUE, problemError,
} from './parse'
import type { AlpacaEnvironment, AlpacaFeed, AssetFlags, CalendarDay, MarketClock } from './parse'

/** 只读连接器对所有写 / 账户调用的统一拒绝原因。 */
export const READ_ONLY_MESSAGE = 'alpaca data connector is read-only'

/** 能力声明：只读美股行情源，交易能力全部 none。 */
export function alpacaDataCapabilities(o: { feed?: string; environment?: string } = {}): VenueCapabilities {
  return {
    venue: VENUE,
    environments: ['mainnet'],
    instrumentKinds: ['spot'],
    orderTypes: {
      market: 'none', limit: 'none', stop_market: 'none', stop_limit: 'none',
      take_market: 'none', take_limit: 'none', trailing_stop: 'none', twap: 'none',
    },
    tif: [],
    triggerPriceTypes: [],
    // Alpaca 按请求数计次（不按权重）：Basic 计划数据 / 交易端点各 200 次 / 分钟
    rateLimits: [{
      scope: 'account', model: 'count', limit: RATE_LIMIT, windowMs: RATE_WINDOW_MS,
      note: 'Alpaca Basic 计划每个端点族 200 次/分钟；以官方 Rate Limits 页为准',
    }],
    history: { maxCandles: MAX_CANDLES, pageLimit: CANDLE_PAGE },
    'x-data-only': true,
    'x-feed': o.feed ?? 'iex',
    'x-environment': o.environment ?? 'paper',
    'x-book': 'top-of-book',
  }
}

export interface AlpacaDataConnectorOptions extends AlpacaMarketOptions {
  budget?: RateBudget | BudgetLike
}

export class AlpacaDataConnector implements VenueConnector {
  readonly venue = VENUE
  readonly environment: Environment = 'mainnet'
  readonly market: AlpacaMarket
  readonly budget: RateBudget | BudgetLike

  constructor(o: AlpacaDataConnectorOptions = {}) {
    this.budget = o.budget ?? unlimitedBudget()
    this.market = new AlpacaMarket({ ...o, budget: this.budget })
  }

  /** 行情源（iex / sip / otc / boats）。 */
  get feed(): AlpacaFeed { return this.market.feed }
  /** 显式声明的环境（paper / live）：只影响交易主机基址与密钥前缀校验。 */
  get alpacaEnvironment(): AlpacaEnvironment { return this.market.environment }

  /** 拉日历（先）、标的清单、时钟并缓存。 */
  start(): Promise<void> {
    return this.market.start()
  }

  describe(): VenueCapabilities {
    return alpacaDataCapabilities({ feed: this.market.feed, environment: this.market.environment })
  }

  // ---- 行情 ----
  listInstruments(opts?: { includeDelisted?: boolean }): Instrument[] {
    return this.market.listInstruments(opts)
  }

  getInstrument(id: InstrumentId): Instrument | undefined {
    return this.market.getInstrument(id)
  }

  /** 协议没有的标的属性（fractionable / shortable / easy_to_borrow / marginable）。 */
  assetFlags(id: InstrumentId): AssetFlags | undefined {
    return this.market.assetFlags(id)
  }

  quote(id: InstrumentId): StampedQuote | undefined {
    return this.market.quote(id)
  }

  refreshQuote(id: InstrumentId): Promise<StampedQuote | undefined> {
    return this.market.refreshQuote(id)
  }

  book(id: InstrumentId, depth?: number): Promise<Book> {
    return this.market.book(id, depth)
  }

  candles(id: InstrumentId, interval: CandleInterval, opts?: { n?: number; from?: Ms; to?: Ms }): Promise<Candle[]> {
    return this.market.candles(id, interval, opts)
  }

  context(id: InstrumentId): Promise<MarketContext> {
    return this.market.context(id)
  }

  subscribe(spec: SubscriptionSpec, cb: (e: VenueEvent) => void): Unsubscribe {
    return this.market.subscribe(spec, cb)
  }

  status(): MarketStatus {
    return this.market.status()
  }

  // ---- 日历 / 时钟（sessions 的来源）----
  /** 协议 sessions 周模板（来自日历的常规时段 + 盘前盘后窗口）。 */
  sessionsTemplate(): { tz: string; windows: TradingSessionWindow[] } {
    return this.market.sessionsTemplate()
  }

  refreshCalendar(range?: { start?: string; end?: string }): Promise<CalendarDay[]> {
    return this.market.refreshCalendar(range)
  }

  tradingCalendar(): CalendarDay[] {
    return this.market.tradingCalendar()
  }

  refreshMarketClock(): Promise<MarketClock> {
    return this.market.refreshMarketClock()
  }

  marketClock(): MarketClock {
    return this.market.marketClock()
  }

  /** 是否在常规交易时段内（按日历当天的 open / close；节假日与提前收盘以接口为准）。 */
  isOpenAt(ms?: Ms): boolean {
    return this.market.isOpenAt(ms)
  }

  close(): Promise<void> {
    return this.market.close()
  }

  // ---- 账户（只读连接器不提供；同步抛，不联网） ----
  accountState(_ref: AccountRef): Promise<AccountSnapshot> { throw readOnly() }
  openOrders(_ref: AccountRef): Promise<VenueOpenOrder[]> { throw readOnly() }
  fills(_ref: AccountRef, _sinceMs: Ms): Promise<VenueFill[]> { throw readOnly() }
  orderStatus(_ref: AccountRef, _key: { clientOrderId?: string; venueOrderId?: string }): Promise<VenueOrderStatus> { throw readOnly() }
  startupSnapshot(_ref: AccountRef, _fillsSinceMs: Ms): Promise<StartupSnapshot> { throw readOnly() }

  // ---- 交易（只读连接器不提供；同步抛，不联网） ----
  submit(_ctx: TradeContext, _intents: OrderIntent[]): Promise<SubmitResult> { throw readOnly() }
  cancel(_ctx: TradeContext, _targets: CancelTarget[]): Promise<CancelAck[]> { throw readOnly() }
  cancelAll(_ctx: TradeContext, _instrumentId?: InstrumentId): Promise<CancelAck[]> { throw readOnly() }
  amend(_ctx: TradeContext, _req: AmendRequest): Promise<SubmitResult> { throw readOnly() }
  setLeverage(_ctx: TradeContext, _instrumentId: InstrumentId, _leverage: number, _marginMode: 'cross' | 'isolated'): Promise<void> { throw readOnly() }
  scheduleCancel(_ctx: TradeContext, _atMs: Ms | null): Promise<void> { throw readOnly() }

  /** 路径常量（供调用方诊断日志拼提示，不含密钥）。 */
  static readonly paths = { assets: '/v2/assets', calendar: CALENDAR_PATH, clock: '/v2/clock' }
}

function readOnly() {
  return problemError('CAPABILITY_UNSUPPORTED', READ_ONLY_MESSAGE)
}
