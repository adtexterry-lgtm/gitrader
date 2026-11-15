// SPDX-License-Identifier: CPAL-1.0
// 出口：Bitget USDT 永续交易连接器（离线件）。**未注册进内核、未经真网验证。**
export { BitgetTradeConnector } from './connector'
export type { BitgetTradeConnectorOptions } from './connector'
export { BitgetAccounts, FILLS_MAX_PAGES, FILLS_PAGE_LIMIT } from './account'
export type { AccountsOptions } from './account'
export { bitgetCapabilities } from './capabilities'
export type { CapabilityOptions } from './capabilities'
export {
  BITGET_ORDER_LIMIT_PER_SEC, BITGET_QUERY_LIMIT_PER_SEC, BITGET_WEIGHTS, DEFAULT_TARGET_RATIO, createCountBudget, orderWeight,
} from './budget'
export type { AcquireOptions, BitgetBudget, BitgetBudgetUsage, BudgetKind, CountBudgetOptions } from './budget'
export { CLOCK_SKEW_WARN_MS, VenueClock } from './clock'
export {
  asProblem, BitgetApiError, BitgetHttpError, BitgetNetworkError, ProblemError, redactSecret, throwAsProblem, venueProblem, VENUE_ID,
} from './errors'
export type { BitgetEndpoint, ErrorContext } from './errors'
export {
  BITGET_POSITION_MODE_MISMATCH_CODES, classifyBitgetError, isPositionModeMismatch, isUnknownOrderError,
} from './venue-errors'
export type { BitgetErrorClass, Classified, ClassifyInput } from './venue-errors'
export { feeBreakdown, feeOfFill, feeStorage } from './fees'
export { BitgetTradeMarket } from './market'
export type { BitgetMarketOptions, QuoteRef } from './market'
export { CHANNEL_API_CODE_PATHS, BITGET_ENDPOINTS, BitgetHttp, DEFAULT_WEIGHTS, encodeSortedQuery, signatureOf } from './rest'
export type { BitgetHttpOptions, Environment, RequestOptions } from './rest'
export {
  OrderBuildError, buildOrder, buildProtectionOrders, describeBody, forceOf, newClientOrderId, normalizeMarginMode, positionFields,
  sanitizeClientOid,
} from './orders'
export type { BitgetForce, BuildOptions, BuiltOrder, PositionMode, PriceRef, ProtectionOrder, ProtectionRequest } from './orders'
export { applyBps, decimalsOf, isMultipleOf, snapToTick, toFx, truncateToStep } from './precision'
export { clampLimitPrice } from './limit-safety'
export { BitgetTrading } from './trading'
export type { LeverageState, TradingDeps } from './trading'
export {
  MARGIN_COIN, ORDER_STATUS_MAP, PLAN_ORDER_TYPES, PRODUCT_TYPE, SUPPORTED_ORDER_TYPES, SUPPORTED_TIF, SUPPORTED_TRIGGER_TYPES,
  VENUE, absDec, decimalOf, instrumentIdOf, mapOpenOrderType, mapOrderStatus, normalizeBitgetEvent, numOf, parseAccount,
  parseEntrustedPage, parseFill, parseFills, parseInstrumentRecord, parseInstrumentRecords, parseOpenOrder, parseOrderDetail,
  parsePosition, parsePositions, problemError, recordFromInstrument, signedDecimalOf, symbolOf,
} from './parse'
export type {
  BitgetEnvelope, BitgetExecEvent, InstrumentRecord, MappedStatus, ParsedAccount, ParseContext, RawAccountRow, RawEntrusted,
  RawFill, RawOrderDetail, RawPosition,
} from './parse'
export type * from '@gitrader/protocol/connector'
