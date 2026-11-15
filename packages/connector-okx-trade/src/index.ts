// SPDX-License-Identifier: CPAL-1.0
// 出口：OKX USDT/USDC 永续交易连接器（离线件）。**未注册进内核、未经真网验证。**
export { OkxTradeConnector, DEADMAN_MAX_DELAY_SEC, defaultBudget } from './connector'
export type { OkxTradeConnectorOptions } from './connector'
export {
  OkxAccounts, ALGO_TYPES, FILLS_LIMIT, parseAlgoOrder, parseBalance, parseFill, parseOpenOrder, parsePosition,
} from './account'
export type { AccountsOptions, RawBalance, RawFill, RawPendingOrder, RawPosition } from './account'
export { okxCapabilities } from './capabilities'
export {
  OKX_ACCOUNT_READ_LIMIT, OKX_ENDPOINT_COSTS, OKX_ORDER_LIMIT_PER_INSTRUMENT, OKX_TRADE_LIMIT, OKX_TRADE_WINDOW_MS, DEFAULT_TARGET_RATIO,
  createCountBudget, orderCost,
} from './budget'
export type { BudgetKind, CountBudgetOptions, OkxBudget, OkxBudgetUsage } from './budget'
export { asProblem, OkxHttpError, OkxNetworkError, ProblemError, redactSecret, throwAsProblem, venueProblem, VENUE_ID } from './errors'
export type { ErrorContext, OkxEndpoint } from './errors'
export {
  OKX_ERROR_CLASSES, UNKNOWN_OUTCOME_CODES, classifyOkxError, isRateLimitCode, isUnknownOutcomeCode, refineOrderSizeProblem,
} from './venue-errors'
export type { Classified, ClassifyInput, OkxErrorClass } from './venue-errors'
export { baseOf, contractsOf, decimalsOf, divFloor, isMultipleOf, snapToTick, toFx, truncateToStep } from './precision'
export {
  ALGO_PATH, ORDER_PATH, ORDER_TYPE_MAP, OrderBuildError, bad, buildOrderParams, buildProtectionOrders, newClientOrderId,
  resolvePosSide, sanitizeClientOrderId,
} from './orders'
export type { BuildOptions, BuiltOrderParams, PriceRef, ProtectionOrder, ProtectionOrders } from './orders'
export { IsoTimestampSource, isoOf } from './nonce'
export {
  ALGO_STATE_MAP, DEFAULT_BASE_URL, ORDER_STATE_MAP, SUPPORTED_ORDER_TYPES, SUPPORTED_TIF, SUPPORTED_TRIGGER_TYPES,
  TRADING_ORDER_TYPES, VENUE, decimalOf, instrumentIdOf, isWorkingState, mapOpenOrderType, mapOrderState, normalizeUserEvents, num,
  parseInstrumentRecords, parseUserStreamMessage, recordOf, symbolOf,
} from './parse'
export type {
  InstrumentRecord, OkxAccountEvent, OkxErrorEvent, OkxLoginEvent, OkxOrderEvent, OkxSubscribedEvent, OkxUnknownEvent, OkxUserEvent,
  PendingRef,
} from './parse'
export {
  CANCEL_AFTER_MAX_SEC, CANCEL_AFTER_MIN_SEC, CANCEL_ALGO_BATCH_MAX, CANCEL_BATCH_MAX, OkxTrading, rowOutcomes,
} from './trading'
export type { LeverageState, RawOrderRow, TradingDeps } from './trading'
export {
  OKX_ENDPOINTS, OkxHttp, assertHeaderSafe, encodeQuery, signOkx, signWsLogin, signedPathOf,
} from './rest'
export type { Environment, OkxEnvelope, OkxHttpOptions, RequestOptions } from './rest'
export {
  PING_INTERVAL_MS, WS_BUSINESS_BASE, WS_PRIVATE_BASE, buildLoginFrame, buildSubscribeFrame, openPrivateStream,
} from './ws'
export type {
  LoginArgs, OkxChannel, PrivateStreamHandle, PrivateStreamOptions, SocketFactory, SocketLike, SocketMessageEvent,
} from './ws'
export type * from '@gitrader/protocol/connector'
