// SPDX-License-Identifier: CPAL-1.0
// Kraken Futures 只读数据连接器：把公共行情包装成 VenueConnector。
// 只做行情：所有交易 / 账户方法一律抛 CAPABILITY_UNSUPPORTED，且不持有任何密钥、不发私有请求。
import type {
  Book, Candle, CandleInterval, Instrument, InstrumentId, MarketContext, Ms, OrderIntent, VenueCapabilities,
} from '@gitrader/protocol'
import type {
  AccountRef, AccountSnapshot, AmendRequest, CancelAck, CancelTarget, Environment, MarketStatus, RateBudget, StampedQuote,
  StartupSnapshot, SubmitResult, SubscriptionSpec, TradeContext, Unsubscribe, VenueConnector, VenueEvent, VenueFill, VenueOpenOrder,
  VenueOrderStatus,
} from '@gitrader/protocol/connector'
import { KrakenMarket, unlimitedBudget } from './market'
import type { KrakenMarketOptions, BudgetLike } from './market'
import { CANDLE_PAGE, IP_RATE_LIMIT, IP_RATE_WINDOW_MS, MAX_CANDLES, VENUE, problemError } from './parse'

/** 只读连接器对所有写 / 账户调用的统一拒绝原因。 */
export const READ_ONLY_MESSAGE = 'kraken data connector is read-only'

/** 能力声明：只读数据源，交易能力全部 none。 */
export function krakenDataCapabilities(): VenueCapabilities {
  return {
    venue: VENUE,
    environments: ['mainnet'],
    instrumentKinds: ['perp'],
    orderTypes: {
      market: 'none', limit: 'none', stop_market: 'none', stop_limit: 'none',
      take_market: 'none', take_limit: 'none', trailing_stop: 'none', twap: 'none',
    },
    tif: [],
    triggerPriceTypes: [],
    // Kraken 公共端点按 IP、按次计（不是权重）：约 500 次 / 10 s
    rateLimits: [{ scope: 'ip', model: 'count', limit: IP_RATE_LIMIT, windowMs: IP_RATE_WINDOW_MS }],
    history: { maxCandles: MAX_CANDLES, pageLimit: CANDLE_PAGE },
    'x-data-only': true,
  }
}

export interface KrakenDataConnectorOptions extends KrakenMarketOptions {
  budget?: RateBudget | BudgetLike
}

export class KrakenDataConnector implements VenueConnector {
  readonly venue = VENUE
  readonly environment: Environment = 'mainnet'
  readonly market: KrakenMarket
  readonly budget: RateBudget | BudgetLike

  constructor(o: KrakenDataConnectorOptions = {}) {
    this.budget = o.budget ?? unlimitedBudget()
    this.market = new KrakenMarket({ ...o, budget: this.budget })
  }

  /** 拉一次合约清单并缓存（内核在启动时调用）。 */
  start(): Promise<void> {
    return this.market.start()
  }

  describe(): VenueCapabilities {
    return krakenDataCapabilities()
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

  /** 主动拉一次 tickers 并写入缓存（quote() 只读缓存）。 */
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
