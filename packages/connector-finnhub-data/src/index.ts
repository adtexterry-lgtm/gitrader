// SPDX-License-Identifier: CPAL-1.0
export { FinnhubDataConnector, finnhubDataCapabilities, READ_ONLY_MESSAGE } from './connector'
export type { FinnhubDataConnectorOptions } from './connector'
export { FinnhubHttp, unlimitedBudget } from './http'
export type { BudgetLike, FinnhubHttpOptions } from './http'
export { FinnhubMarket } from './market'
export type { FinnhubMarketOptions } from './market'
export {
  ProblemError, problemError, VENUE, DEFAULT_BASE_URL, API_KEY_ENV,
  INTERVAL_MS, RESOLUTION_OF, SUPPORTED_INTERVALS, RATE_LIMIT, RATE_WINDOW_MS, REQUEST_WEIGHT, MAX_CANDLES, CANDLE_PAGE,
  MAX_PAGES, DEFAULT_CANDLE_COUNT, NY_TZ,
  instrumentIdOf, symbolOf, resolutionOf, num, secondsToMs, resolveCredentials, authHeaders, buildSessions,
  parseInstrument, parseSymbols, parseCandles, parseQuote, parseBidAsk, parseMarketStatus, parseMarketHolidays,
  clampCount, dedupeCandles,
} from './parse'
export type {
  FinnhubCredentialInput, FinnhubCredentials, SessionBuildOptions, RawSymbolRow, RawCandleSeries, RawQuote, RawBidAsk,
  RawMarketStatus, RawHolidayRow, LastTradeQuote, TopOfBook, MarketState, MarketHoliday,
} from './parse'
export type * from '@gitrader/protocol/connector'
