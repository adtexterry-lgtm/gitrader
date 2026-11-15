// SPDX-License-Identifier: CPAL-1.0
// 包入口：只导出连接器、能力声明、解析纯函数与常量。
export { PolygonDataConnector, polygonDataCapabilities, READ_ONLY_MESSAGE } from './connector'
export type { PolygonDataConnectorOptions } from './connector'
export { PolygonMarket, POLYGON_LIMITS, resolveApiKey, unlimitedBudget } from './market'
export type { PolygonMarketOptions } from './market'
export { PolygonHttp } from './http'
export type { PolygonHttpOptions, BudgetLike } from './http'
export {
  API_KEY_ENV, CANDLE_PAGE, DEFAULT_BASE_URL, DEFAULT_INSTRUMENT_PAGES, INTERVAL_OF, MAX_CANDLES, MAX_PAGES,
  RATE_LIMIT, RATE_WINDOW_MS, TICKERS_PATH, VENUE, aggsPath, barMsOf, clampCount, cursorOf, epochMsOf, instrumentIdOf,
  intervalSpecOf, mayHaveMore, nsToMs, parseAggs, parseSnapshot, parseTickerPage, polygonFailureOf, problemError,
  snapshotPath, symbolOf, ProblemError,
} from './parse'
export type { PolygonFailure, SnapshotQuote, TickerPage } from './parse'
