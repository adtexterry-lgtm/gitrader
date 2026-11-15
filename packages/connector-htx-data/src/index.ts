// SPDX-License-Identifier: CPAL-1.0
export { HtxDataConnector, htxDataCapabilities, READ_ONLY_MESSAGE } from './connector'
export type { HtxDataConnectorOptions } from './connector'
export { HtxHttp, HtxMarket, unlimitedBudget, ENDPOINTS } from './market'
export type { HtxHttpOptions, HtxMarketOptions, BudgetLike } from './market'
export {
  ProblemError, problemError, VENUE, DEFAULT_BASE_URL, DOCS_URL, INTERVAL_MS, VENUE_INTERVALS, FUNDING_INTERVAL_MS,
  MAX_CANDLES, CANDLE_PAGE, MAX_PAGES, DEFAULT_CANDLE_COUNT, IP_RATE_LIMIT, IP_RATE_WINDOW_MS,
  BOOK_LEVELS_WIDE, BOOK_LEVELS_NARROW,
  instrumentIdOf, symbolOf, venueIntervalOf, depthStepOf, roundSize, num, toBaseSize,
  parseInstrument, parseInstruments, parseCandles, parseMergedQuote, parseDepth, parseMarkPrice, parseContext,
} from './parse'
export type { HtxEnvelope, HtxMarketContext, RawContract, RawKline, RawMergedTick, RawDepthTick, RawFunding } from './parse'
export type * from '@gitrader/protocol/connector'
