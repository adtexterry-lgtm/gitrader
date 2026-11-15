// SPDX-License-Identifier: CPAL-1.0
// 出口：Binance USDⓈ-M 永续交易连接器（离线件）。**未注册进内核、未经真网验证。**
export { BinanceTradeConnector, defaultBudget } from './connector'
export type { BinanceTradeConnectorOptions } from './connector'
export { BinanceAccounts, USER_TRADES_LIMIT, parseAccountSnapshot, parseAlgoOpenOrder, parsePositionRisk, parseUserTrade, parseOpenOrder } from './account'
export type { AccountsOptions, RawAccount, RawAlgoOrder, RawOrder, RawPositionRisk, RawUserTrade } from './account'
export { binanceCapabilities } from './capabilities'
export {
  BINANCE_WEIGHT_LIMIT_PER_MIN, BINANCE_WEIGHTS, DEFAULT_TARGET_RATIO, ORDER_LIMIT_PER_10S, ORDER_LIMIT_PER_MIN, createWeightBudget,
  orderWeight,
} from './budget'
export type { BinanceBudget, BinanceBudgetUsage, BudgetKind, WeightBudgetOptions } from './budget'
export { asProblem, BinanceHttpError, BinanceNetworkError, ProblemError, redactSecret, throwAsProblem, venueProblem, VENUE_ID } from './errors'
export type { BinanceEndpoint, ErrorContext } from './errors'
export { BINANCE_ERROR_CLASSES, classifyBinanceError, refineOrderSizeProblem } from './venue-errors'
export type { BinanceErrorClass, Classified, ClassifyInput } from './venue-errors'
export { BinanceMarket, CANDLE_PAGE, INTERVAL_MS, MAX_CANDLES, depthLimitOf, depthWeight, klineWeight } from './market'
export type { MarketOptions } from './market'
export { TimestampSource } from './nonce'
export { BINANCE_ENDPOINTS, BinanceHttp, encodeQuery, signatureOf } from './rest'
export type { BinanceHttpOptions, Environment, RequestOptions } from './rest'
export {
  ALGO_ORDER_TYPES, DEFAULT_REF_PRICE_MAX_AGE_MS, OrderBuildError, ORDER_TYPE_MAP, TIF_MAP, buildOrderParams, buildProtectionOrders, inferPositionSide, newClientOrderId,
  sanitizeClientOrderId,
} from './orders'
export type { BuildOptions, BuiltOrderParams, PriceRef, ProtectionOrder, ProtectionOrders } from './orders'
export { decimalsOf, isMultipleOf, snapToTick, toFx, truncateToStep } from './precision'
export { clampLimitPrice } from './limit-safety'
export { BinanceTrading } from './trading'
export type { LeverageState, TradingDeps } from './trading'
export { LISTEN_KEY_RENEW_AFTER_MS, LISTEN_KEY_TTL_MS, ListenKeyManager, USER_STREAM_BASE, openUserStream, userStreamUrl } from './ws'
export type { ListenKeyOptions, ListenKeyState, SocketFactory, SocketLike, UserStreamHandle, UserStreamOptions } from './ws'
export {
  DEFAULT_BASE_URL, FALLBACK_MIN_NOTIONAL, FUNDING_INTERVAL_MS, ORDER_STATUS_MAP, SUPPORTED_ORDER_TYPES, SUPPORTED_TIF,
  SUPPORTED_TRIGGER_TYPES, VENUE, absDecimal, decimalOf, holdOf, instrumentIdOf, mapOpenOrderType, mapOrderStatus, normalizeUserEvent, num,
  parseBookTicker, parseDepth, parseInstrument, parseInstrumentRecords, parseInstruments, parseKlines, parsePremiumIndex,
  parseUserStreamMessage, symbolOf,
} from './parse'
export type {
  BinanceUserEvent, InstrumentRecord, ListenKeyExpiredEvent, RawBookTicker, RawDepth, RawExchangeInfo, RawFilter, RawPremiumIndex,
  RawSymbol, UnknownUserEvent, UserAccountEvent, UserOrderEvent,
} from './parse'
export type * from '@gitrader/protocol/connector'
