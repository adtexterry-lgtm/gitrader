// SPDX-License-Identifier: CPAL-1.0
export { KucoinDataConnector, kucoinDataCapabilities, READ_ONLY_MESSAGE } from './connector'
export type { KucoinDataConnectorOptions } from './connector'
export { KucoinHttp, KucoinMarket, unlimitedBudget } from './market'
export type { KucoinHttpOptions, KucoinMarketOptions, BudgetLike } from './market'
export {
  ProblemError, problemError, VENUE, DEFAULT_BASE_URL, SUCCESS_CODE, FUNDING_INTERVAL_MS, MAX_CANDLES, CANDLE_PAGE, MAX_PAGES,
  DEFAULT_CANDLE_COUNT, IP_RATE_LIMIT, IP_RATE_WINDOW_MS, GRANULARITY_MINUTES, LEVEL2_PAGE, MAX_BOOK_DEPTH,
  CONTRACTS_PATH, TICKER_PATH, DEPTH_20_PATH, DEPTH_100_PATH, KLINE_PATH, markPricePath, fundingRatePath,
  CONTRACTS_WEIGHT, TICKER_WEIGHT, DEPTH_WEIGHT, KLINE_WEIGHT, MARK_PRICE_WEIGHT, FUNDING_RATE_WEIGHT,
  instrumentIdOf, symbolOf, granularityOf, intervalStepMs, depthLimitOf, depthPathOf, msOf,
  parseInstrument, parseInstruments, parseCandles, parseTicker, parseDepth, parseMarkPrice, parseFundingRate, parseContext,
} from './parse'
export type {
  KucoinEnvelope, RawContract, RawTicker, RawDepth, RawMarkPrice, RawFundingRate,
} from './parse'
export type * from '@gitrader/protocol/connector'
