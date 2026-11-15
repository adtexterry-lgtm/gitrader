// SPDX-License-Identifier: CPAL-1.0
export { BitgetDataConnector, bitgetDataCapabilities, READ_ONLY_MESSAGE } from './connector'
export type { BitgetDataConnectorOptions } from './connector'
export { BitgetHttp, BitgetMarket, unlimitedBudget } from './market'
export type { BitgetHttpOptions, BitgetMarketOptions, BudgetLike } from './market'
export {
  ProblemError, problemError, VENUE, DEFAULT_BASE_URL, PRODUCT_TYPE, INTERVAL_MS, GRANULARITY_OF, FUNDING_INTERVAL_MS,
  MAX_CANDLES, CANDLE_PAGE, HISTORY_PAGE, MAX_PAGES, DEFAULT_CANDLE_COUNT, IP_RATE_LIMIT, IP_RATE_WINDOW_MS,
  CONTRACTS_WEIGHT, TICKER_WEIGHT, DEPTH_WEIGHT, FUNDING_WEIGHT, CANDLES_WEIGHT, HISTORY_CANDLES_WEIGHT,
  DEPTH_LIMITS, instrumentIdOf, symbolOf, granularityOf, depthLimitOf, parseInstrument, parseInstruments, parseCandles,
  parseTicker, parseDepth, parseFundingRate, parseContext, num,
} from './parse'
export type { BitgetEnvelope, DepthLimit, RawContract, RawTicker, RawDepth, RawFundingRate } from './parse'
export type * from '@gitrader/protocol/connector'
