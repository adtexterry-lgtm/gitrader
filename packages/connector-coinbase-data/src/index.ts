// SPDX-License-Identifier: CPAL-1.0
export { CoinbaseDataConnector, coinbaseDataCapabilities, READ_ONLY_MESSAGE } from './connector'
export type { CoinbaseDataConnectorOptions } from './connector'
export { CoinbaseHttp, CoinbaseMarket, unlimitedBudget } from './market'
export type { CoinbaseHttpOptions, CoinbaseMarketOptions, BudgetLike } from './market'
export {
  ProblemError, problemError, VENUE, DEFAULT_BASE_URL, INTERVAL_MS, GRANULARITY_OF, MAX_CANDLES, CANDLE_PAGE,
  MAX_PAGES, DEFAULT_CANDLE_COUNT, IP_RATE_LIMIT, IP_RATE_WINDOW_MS, REQUEST_WEIGHT, MAX_BOOK_DEPTH,
  instrumentIdOf, symbolOf, granularityOf, isoMs, parseInstrument, parseProducts, parseCandles,
  parseTicker, parseBook, parseContext, depthLimitOf, clampCount,
} from './parse'
export type { RawProduct, RawProducts, RawCandle, RawCandles, RawTicker, RawPricebook } from './parse'
export type * from '@gitrader/protocol/connector'
