// SPDX-License-Identifier: CPAL-1.0
// 包入口：只导出连接器、能力声明、解析纯函数与常量（不导出 Http 私有细节以外的状态）。
export { AlphaVantageDataConnector, alphaVantageDataCapabilities, READ_ONLY_MESSAGE } from './connector'
export type { AlphaVantageDataConnectorOptions } from './connector'
export { AlphaVantageMarket, ALPHAVANTAGE_LIMITS, resolveApiKey, unlimitedBudget } from './market'
export type { AlphaVantageMarketOptions } from './market'
export { AlphaVantageHttp } from './http'
export type { AlphaVantageHttpOptions, BudgetLike } from './http'
export {
  API_KEY_ENV, DEFAULT_BASE_URL, INTRADAY_INTERVAL, MAX_CANDLES, MAX_PAGES, QUERY_PATH, RATE_LIMIT, RATE_WINDOW_MS,
  SERIES_OF, SUPPORTED_INTERVALS, VENUE, avFailureOf, clampCount, dedupeCandles, etDayOf, etMonthOf, etMsOf,
  instrumentIdOf, nextDay, nextMonth, parseCsv, parseGlobalQuote, parseListingCsv, parseSeries, problemError,
  seriesSpecOf, symbolOf, ProblemError,
} from './parse'
export type { AvFailure, GlobalQuote, SeriesSpec } from './parse'
