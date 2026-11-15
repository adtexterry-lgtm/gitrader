// SPDX-License-Identifier: CPAL-1.0
// Alpha Vantage 只读行情连接器：把美股行情（标的清单 / K 线 / 最新价）包装成 VenueConnector。
// 只做行情：11 个交易 / 账户方法一律抛 CAPABILITY_UNSUPPORTED，不发私有请求、不下任何单。
// API Key 只在构造参数 / 环境变量进，Http 里是私有字段，不打印、不落盘。
// 免费档限制（25 次/天）写在 describe().rateLimits 与 README；超限时上游仍回 200，见 src/http.ts 的判定。
import type {
  Book, Candle, CandleInterval, Instrument, InstrumentId, MarketContext, Ms, OrderIntent, VenueCapabilities,
} from '@gitrader/protocol'
import type {
  AccountRef, AccountSnapshot, AmendRequest, CancelAck, CancelTarget, Environment, MarketStatus, RateBudget, StampedQuote,
  StartupSnapshot, SubmitResult, SubscriptionSpec, TradeContext, Unsubscribe, VenueConnector, VenueEvent, VenueFill,
  VenueOpenOrder, VenueOrderStatus,
} from '@gitrader/protocol/connector'
import { AlphaVantageMarket, unlimitedBudget } from './market'
import type { AlphaVantageMarketOptions } from './market'
import type { BudgetLike } from './http'
import {
  CANDLE_PAGE, DEFAULT_BASE_URL, MAX_CANDLES, MAX_PAGES, RATE_LIMIT, RATE_WINDOW_MS, SUPPORTED_INTERVALS, VENUE, problemError,
} from './parse'
import type { GlobalQuote } from './parse'

/** 只读连接器对所有写 / 账户调用的统一拒绝原因。 */
export const READ_ONLY_MESSAGE = 'alphavantage data connector is read-only'

/** 能力声明：只读美股行情源，交易能力全部 none。 */
export function alphaVantageDataCapabilities(): VenueCapabilities {
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
    // 免费档 25 次/天（官方 Support 页；施工时离线，待真网核对）
    rateLimits: [{
      scope: 'ip', model: 'count', limit: RATE_LIMIT, windowMs: RATE_WINDOW_MS,
      note: 'Alpha Vantage 免费档 25 次/天（官方 Support 页）；付费档更高，以官方页面为准',
    }],
    history: { maxCandles: MAX_CANDLES, pageLimit: CANDLE_PAGE },
    'x-data-only': true,
    'x-book': 'none',
    'x-quote': 'last-only',
    'x-intervals': [...SUPPORTED_INTERVALS],
    'x-base-url': DEFAULT_BASE_URL,
    'x-max-pages': MAX_PAGES,
  }
}

export interface AlphaVantageDataConnectorOptions extends AlphaVantageMarketOptions {
  budget?: RateBudget | BudgetLike
}

export class AlphaVantageDataConnector implements VenueConnector {
  readonly venue = VENUE
  readonly environment: Environment = 'mainnet'
  readonly market: AlphaVantageMarket
  readonly budget: RateBudget | BudgetLike

  constructor(o: AlphaVantageDataConnectorOptions = {}) {
    this.budget = o.budget ?? unlimitedBudget()
    this.market = new AlphaVantageMarket({ ...o, budget: this.budget })
  }

  /** 拉标的清单并缓存。 */
  start(): Promise<void> {
    return this.market.start()
  }

  describe(): VenueCapabilities {
    return alphaVantageDataCapabilities()
  }

  // ---- 行情 ----
  listInstruments(opts?: { includeDelisted?: boolean }): Instrument[] {
    return this.market.listInstruments(opts)
  }

  getInstrument(id: InstrumentId): Instrument | undefined {
    return this.market.getInstrument(id)
  }

  /** 协议没有的报价属性（昨收 / 成交量 / 交易日）。 */
  quoteDetail(id: InstrumentId): GlobalQuote | undefined {
    return this.market.quoteDetail(id)
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

  close(): Promise<void> {
    return this.market.close()
  }

  // ---- 账户（只读连接器不提供；同步抛，不联网） ----
  accountState(_ref: AccountRef): Promise<AccountSnapshot> { throw readOnly() }
  openOrders(_ref: AccountRef): Promise<VenueOpenOrder[]> { throw readOnly() }
  fills(_ref: AccountRef, _sinceMs: Ms): Promise<VenueFill[]> { throw readOnly() }
  orderStatus(_ref: AccountRef, _key: { clientOrderId?: string; venueOrderId?: string; instrumentId?: InstrumentId }): Promise<VenueOrderStatus> { throw readOnly() }
  startupSnapshot(_ref: AccountRef, _fillsSinceMs: Ms): Promise<StartupSnapshot> { throw readOnly() }

  // ---- 交易（只读连接器不提供；同步抛，不联网） ----
  submit(_ctx: TradeContext, _intents: OrderIntent[]): Promise<SubmitResult> { throw readOnly() }
  cancel(_ctx: TradeContext, _targets: CancelTarget[]): Promise<CancelAck[]> { throw readOnly() }
  cancelAll(_ctx: TradeContext, _instrumentId?: InstrumentId): Promise<CancelAck[]> { throw readOnly() }
  amend(_ctx: TradeContext, _req: AmendRequest): Promise<SubmitResult> { throw readOnly() }
  setLeverage(_ctx: TradeContext, _instrumentId: InstrumentId, _leverage: number, _marginMode: 'cross' | 'isolated'): Promise<void> { throw readOnly() }
  scheduleCancel(_ctx: TradeContext, _atMs: Ms | null): Promise<void> { throw readOnly() }
}

function readOnly() {
  return problemError('CAPABILITY_UNSUPPORTED', READ_ONLY_MESSAGE)
}
