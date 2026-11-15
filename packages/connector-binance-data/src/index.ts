// SPDX-License-Identifier: CPAL-1.0
export { BinanceDataConnector, binanceDataCapabilities, READ_ONLY_MESSAGE } from './connector'
export type { BinanceDataConnectorOptions } from './connector'
export { BinanceHttp, BinanceMarket, unlimitedBudget } from './market'
export type { BinanceHttpOptions, BinanceMarketOptions, BudgetLike } from './market'
export {
  ProblemError, problemError, VENUE, DEFAULT_BASE_URL, INTERVAL_MS, FUNDING_INTERVAL_MS, MAX_CANDLES, CANDLE_PAGE, MAX_PAGES,
  DEFAULT_CANDLE_COUNT, IP_WEIGHT_LIMIT, IP_WEIGHT_WINDOW_MS, EXCHANGE_INFO_WEIGHT, BOOK_TICKER_WEIGHT, PREMIUM_INDEX_WEIGHT,
  FUNDING_RATE_WEIGHT, FUNDING_PAGE, FUNDING_PAGE_GAP_MS,
  instrumentIdOf, symbolOf, klineWeight, depthWeight, depthLimitOf, parseInstrument, parseInstruments, parseKlines,
  parseBookTicker, parseDepth, parsePremiumIndex, parseFundingRates,
} from './parse'
export type { RawBookTicker, RawDepth, RawExchangeInfo, RawFundingRate, RawPremiumIndex, RawSymbol } from './parse'
export type * from '@gitrader/protocol/connector'
