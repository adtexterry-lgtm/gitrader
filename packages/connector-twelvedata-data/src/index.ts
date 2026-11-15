// SPDX-License-Identifier: CPAL-1.0
export { TwelveDataDataConnector, twelveDataCapabilities, READ_ONLY_MESSAGE } from './connector'
export type { TwelveDataDataConnectorOptions } from './connector'
export { TwelveDataHttp, isErrorEnvelope, unlimitedBudget } from './http'
export type { BudgetLike, TwelveDataHttpOptions } from './http'
export { TwelveDataMarket, utcDateTime } from './market'
export type { TwelveDataMarketOptions } from './market'
export {
  ProblemError, problemError, VENUE, DEFAULT_BASE_URL, API_KEY_ENV, INTERVAL_MS, INTERVAL_OF, SUPPORTED_INTERVALS,
  RATE_LIMIT, RATE_WINDOW_MS, DAILY_CREDIT_LIMIT, DAILY_WINDOW_MS, REQUEST_WEIGHT, MAX_CANDLES, CANDLE_PAGE, MAX_PAGES,
  DEFAULT_CANDLE_COUNT, NY_TZ,
  instrumentIdOf, symbolOf, intervalOf, num, isoMs, resolveCredentials, authHeaders, buildSessions,
  parseInstrument, parseStocks, parseTimeSeries, parseQuote, parseMarketState, clampCount, dedupeCandles,
} from './parse'
export type {
  TwelveDataCredentialInput, TwelveDataCredentials, SessionBuildOptions, RawStockRow, RawTimeSeries, RawTimeSeriesValue,
  RawQuote, RawMarketState, VendorQuote, MarketState,
} from './parse'
export type * from '@gitrader/protocol/connector'
