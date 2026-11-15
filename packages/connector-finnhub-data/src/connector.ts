// SPDX-License-Identifier: CPAL-1.0
// Finnhub 只读数据连接器：把公开行情包装成 VenueConnector。
// 只做行情：所有交易 / 账户方法一律抛 CAPABILITY_UNSUPPORTED，且不持有任何交易凭据（只持有一个行情 API key）。
import type {
  Book, Candle, CandleInterval, Instrument, InstrumentId, MarketContext, Ms, OrderIntent, VenueCapabilities,
} from '@gitrader/protocol'
import type {
  AccountRef, AccountSnapshot, AmendRequest, CancelAck, CancelTarget, Environment, MarketStatus, RateBudget, StampedQuote,
  StartupSnapshot, SubmitResult, SubscriptionSpec, TradeContext, Unsubscribe, VenueConnector, VenueEvent, VenueFill, VenueOpenOrder,
  VenueOrderStatus,
} from '@gitrader/protocol/connector'
import { FinnhubMarket, unlimitedBudget } from './market'
import type { FinnhubMarketOptions } from './market'
import type { BudgetLike } from './http'
import { CANDLE_PAGE, MAX_CANDLES, RATE_LIMIT, RATE_WINDOW_MS, VENUE, problemError } from './parse'
import type { MarketHoliday, MarketState } from './parse'

/** 只读连接器对所有写 / 账户调用的统一拒绝原因。 */
export const READ_ONLY_MESSAGE = 'finnhub data connector is read-only'

/** 能力声明：只读数据源，交易能力全部 none；限流按免费档 60 次 / 分钟。 */
export function finnhubDataCapabilities(): VenueCapabilities {
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
    rateLimits: [{ scope: 'ip', model: 'count', limit: RATE_LIMIT, windowMs: RATE_WINDOW_MS }],
    history: { maxCandles: MAX_CANDLES, pageLimit: CANDLE_PAGE },
    'x-data-only': true,
    // 官方 /quote 只给最新成交价，不给买卖盘：quote() 的 bid = ask = last（价差未知）
    'x-quote-basis': 'last-price',
    // 盘口只有 NBBO 一档，且该端点属于付费档
    'x-book': 'top-of-book',
  }
}

export interface FinnhubDataConnectorOptions extends FinnhubMarketOptions {
  budget?: RateBudget | BudgetLike
}

export class FinnhubDataConnector implements VenueConnector {
  readonly venue = VENUE
  readonly environment: Environment = 'mainnet'
  readonly market: FinnhubMarket
  readonly budget: RateBudget | BudgetLike

  constructor(o: FinnhubDataConnectorOptions = {}) {
    this.budget = o.budget ?? unlimitedBudget()
    this.market = new FinnhubMarket({ ...o, budget: this.budget })
  }

  /** 拉一次标的清单并缓存（内核在启动时调用）。 */
  start(): Promise<void> {
    return this.market.start()
  }

  describe(): VenueCapabilities {
    return finnhubDataCapabilities()
  }

  // ---- 行情 ----
  listInstruments(opts?: { includeDelisted?: boolean }): Instrument[] {
    return this.market.listInstruments(opts)
  }

  getInstrument(id: InstrumentId): Instrument | undefined {
    return this.market.getInstrument(id)
  }

  quote(id: InstrumentId): StampedQuote | undefined {
    return this.market.quote(id)
  }

  /** 主动拉一次 /quote 并写入缓存（quote() 只读缓存）。 */
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

  /** 官方 /stock/market-status：开市判断以它为准（含盘前 / 盘后）。 */
  marketStatus(): Promise<MarketState> {
    return this.market.marketStatus()
  }

  /** 官方 /stock/market-holiday：休市与提前收盘（协议 sessions 装不下的日期级例外）。 */
  marketHolidays(): Promise<MarketHoliday[]> {
    return this.market.marketHolidays()
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
  orderStatus(_ref: AccountRef, _key: { clientOrderId?: string; venueOrderId?: string }): Promise<VenueOrderStatus> { throw readOnly() }
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
