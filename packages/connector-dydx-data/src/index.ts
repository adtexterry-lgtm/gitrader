// SPDX-License-Identifier: CPAL-1.0
export { DydxDataConnector, dydxDataCapabilities, READ_ONLY_MESSAGE } from './connector'
export type { DydxDataConnectorOptions } from './connector'
export { DydxHttp, DydxMarket, unlimitedBudget } from './market'
export type { BudgetLike, DydxHttpOptions, DydxMarketOptions } from './market'
export {
  ProblemError, problemError, VENUE, DEFAULT_BASE_URL, INTERVAL_MS, RESOLUTION_OF, FUNDING_INTERVAL_MS, MAX_CANDLES, CANDLE_PAGE,
  MAX_PAGES, DEFAULT_CANDLE_COUNT, IP_RATE_LIMIT, IP_RATE_WINDOW_MS, MAX_BOOK_DEPTH, MARKETS_WEIGHT, CANDLES_WEIGHT, ORDERBOOK_WEIGHT,
  TRADES_WEIGHT, instrumentIdOf, symbolOf, resolutionOf, isoOf, num, candleTime, depthLimitOf, parseInstrument, parseMarkets,
  parseInstruments, parseCandles, parseOrderbook, parseTopOfBook, parseLastTradePrice, parseContext,
} from './parse'
export type {
  RawCandle, RawCandlesResponse, RawErrors, RawLevel, RawMarketsResponse, RawOrderbook, RawPerpetualMarket, RawTrade, RawTradesResponse,
} from './parse'
export type * from '@gitrader/protocol/connector'
