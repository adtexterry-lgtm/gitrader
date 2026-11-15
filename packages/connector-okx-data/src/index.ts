// SPDX-License-Identifier: CPAL-1.0
export { OkxDataConnector, okxDataCapabilities, READ_ONLY_MESSAGE } from './connector'
export type { OkxDataConnectorOptions } from './connector'
export { OkxHttp, OkxMarket, unlimitedBudget } from './market'
export type { OkxHttpOptions, OkxMarketOptions, BudgetLike } from './market'
export {
  ProblemError, problemError, VENUE, DEFAULT_BASE_URL, INTERVAL_MS, BAR_OF, FUNDING_INTERVAL_MS, MAX_CANDLES, CANDLE_PAGE,
  MAX_PAGES, DEFAULT_CANDLE_COUNT, IP_RATE_LIMIT, IP_RATE_WINDOW_MS, MAX_BOOK_DEPTH, INSTRUMENTS_WEIGHT, TICKER_WEIGHT,
  MARK_PRICE_WEIGHT, FUNDING_RATE_WEIGHT, HISTORY_CANDLES_WEIGHT,
  instrumentIdOf, symbolOf, barOf, candlesWeight, booksWeight, depthLimitOf, parseInstrument, parseInstruments, parseCandles,
  parseTicker, parseBooks, parseMarkPrice, parseFundingRate, parseContext,
} from './parse'
export type {
  OkxEnvelope, RawFundingRate, RawInstrument, RawMarkPrice, RawTicker, RawBook,
} from './parse'
export type * from '@gitrader/protocol/connector'
