// SPDX-License-Identifier: CPAL-1.0
export { GateioDataConnector, gateioDataCapabilities, READ_ONLY_MESSAGE } from './connector'
export type { GateioDataConnectorOptions } from './connector'
export { GateHttp, GateioMarket, unlimitedBudget, sizeInBase } from './market'
export type { GateHttpOptions, GateioMarketOptions, BudgetLike } from './market'
export {
  ProblemError, problemError, VENUE, DEFAULT_BASE_URL, API_PREFIX, INTERVAL_MS, VENUE_INTERVALS, FUNDING_INTERVAL_MS,
  MAX_CANDLES, CANDLE_PAGE, MAX_PAGES, DEFAULT_CANDLE_COUNT, IP_RATE_LIMIT, IP_RATE_WINDOW_MS, MAX_BOOK_DEPTH,
  INSTRUMENTS_WEIGHT, TICKER_WEIGHT, BOOK_WEIGHT, CANDLES_WEIGHT,
  instrumentIdOf, symbolOf, venueIntervalOf, depthLimitOf, roundSize, num, toBaseSize, fundingNextApplyMs,
  parseInstrument, parseInstruments, parseCandles, parseTicker, parseBook, parseContext,
} from './parse'
export type { GateErrorBody, GateioMarketContext, RawContract, RawTicker, RawBook, RawCandle } from './parse'
export type * from '@gitrader/protocol/connector'
