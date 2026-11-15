// SPDX-License-Identifier: CPAL-1.0
// 出口：Bybit v5 USDT 线性永续交易连接器（离线件）。**未注册进内核 / CLI，未经真网验证。**
export { BybitTradeConnector, defaultBudget } from './connector'
export type { BybitTradeConnectorOptions } from './connector'
export { ACCOUNT_TYPE, BybitAccounts, EXECUTION_PAGE_LIMIT, MAX_EXECUTION_PAGES } from './account'
export type { AccountsOptions, ReaderDeps } from './account'
export { bybitCapabilities, FALLBACK_MIN_NOTIONAL, MAX_CANDLES } from './capabilities'
export {
  BYBIT_RATE_LIMIT, BYBIT_RATE_WINDOW_MS, BYBIT_WEIGHTS, DEFAULT_TARGET_RATIO, ORDER_LIMIT_PER_SEC, createWeightBudget,
  orderWeight,
} from './budget'
export type { BudgetKind, BybitBudget, BybitBudgetUsage, WeightBudgetOptions } from './budget'
export { asProblem, BybitHttpError, BybitNetworkError, ProblemError, redactSecret, throwAsProblem, venueProblem, VENUE_ID } from './errors'
export type { BybitEndpoint, ErrorContext } from './errors'
export { BYBIT_ERROR_CLASSES, classifyBybitError } from './venue-errors'
export type { BybitErrorClass, Classified, ClassifyInput } from './venue-errors'
export { BybitTradeMarket } from './market'
export type { MarketOptions } from './market'
export { serverTimeMsOf, TimestampSource } from './nonce'
export {
  AMBIGUOUS_RET_CODES, BYBIT_ENDPOINTS, BybitHttp, encodeQuery, prehashOf, retCodeOf, retMsgOf, signatureOf,
} from './rest'
export type { BybitEnvelope, BybitHttpOptions, Environment, RequestOptions, SignedPayload } from './rest'
export {
  buildOrderParams, buildProtectionOrders, buildTradingStop, CLIENT_ORDER_ID_MAX, inferPositionIdx, newClientOrderId,
  ORDER_TYPE_MAP, OrderBuildError, STOP_ORDER_FILTER, TIF_MAP, TRIGGER_BY, triggerDirectionOf, sanitizeClientOrderId,
} from './orders'
export type { BuildOptions, BuiltOrder, PriceRef, ProtectionOrder, ProtectionOrders, TradingStopSpec } from './orders'
export { decimalsOf, isMultipleOf, snapToTick, toFx, truncateToStep } from './precision'
export { clampLimitPrice } from './limit-safety'
export { BybitTrading } from './trading'
export type { LeverageState, TradingDeps } from './trading'
export {
  absDecimal, decimalOf, fillDedupeKey, instrumentIdOf, isTradeExecution, mapOpenOrderType, num, ORDER_STATUS_MAP,
  parseAccountSnapshot, parseExecution, parseExecutions, parseOpenOrder, parseOrderStatusResult, parsePosition,
  parsePositions, parsePrivateMessage, remainingOf, SUPPORTED_ORDER_TYPES, SUPPORTED_TIF, SUPPORTED_TRIGGER_TYPES,
  symbolOf, upper, vwapOf, VENUE,
} from './parse'
export type {
  BybitPrivateEvent, BybitPrivateFill, RawCoin, RawExecution, RawExecutionPage, RawOrder, RawOrderPage, RawPosition,
  RawPositionPage, RawWallet, RawWalletPage,
} from './parse'
export {
  AUTH_EXPIRES_AHEAD_MS, authSignature, buildAuthMessage, buildPingMessage, buildSubscribeMessage, DEFAULT_TOPICS,
  openPrivateStream, parseFrame, PRIVATE_WS_URL,
} from './ws'
export type { PrivateStreamHandle, PrivateStreamOptions, SocketFactory, SocketLike, SocketMessageEvent } from './ws'
export type * from '@gitrader/protocol/connector'
