// SPDX-License-Identifier: CPAL-1.0
export { KrakenDataConnector, krakenDataCapabilities, READ_ONLY_MESSAGE } from './connector'
export type { KrakenDataConnectorOptions } from './connector'
export { KrakenHttp, KrakenMarket, unlimitedBudget } from './market'
export type { KrakenHttpOptions, KrakenMarketOptions, BudgetLike } from './market'
export {
  ProblemError, problemError, VENUE, DEFAULT_BASE_URL, INTERVAL_MS, RESOLUTION_OF, FUNDING_INTERVAL_MS, MAX_CANDLES, CANDLE_PAGE,
  MAX_PAGES, DEFAULT_CANDLE_COUNT, IP_RATE_LIMIT, IP_RATE_WINDOW_MS, MAX_BOOK_DEPTH, INSTRUMENTS_WEIGHT, TICKERS_WEIGHT,
  ORDERBOOK_WEIGHT, CHARTS_WEIGHT,
  instrumentIdOf, symbolOf, resolutionOf, parseTs, stepOfDecimals, parseInstrument, parseInstruments, parseCandles,
  parseTicker, parseBook, parseContext, depthLimitOf,
} from './parse'
export type {
  KrakenEnvelope, RawInstrument, RawTicker, RawOrderBook, RawCandle, ChartsBody,
} from './parse'
export type * from '@gitrader/protocol/connector'
