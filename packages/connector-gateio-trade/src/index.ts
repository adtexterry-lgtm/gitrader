// SPDX-License-Identifier: CPAL-1.0
// 出口：Gate.io USDT 永续交易连接器（离线件）。**未注册进内核、未经真网验证。**
export { GateioTradeConnector } from './connector'
export type { GateioTradeConnectorOptions } from './connector'
export {
  CLIENT_ID_SCAN_PAGES, FILLS_MAX_PAGES, FILLS_PAGE_LIMIT, GateAccounts, LIST_MAX_PAGES, LIST_PAGE_LIMIT, MEMO_LIMIT,
} from './account'
export type { AccountsOptions, MultiplierSource, TriggerMemo } from './account'
export { gateioCapabilities } from './capabilities'
export type { CapabilityOptions } from './capabilities'
export {
  DEFAULT_TARGET_RATIO, GATE_ORDER_LIMIT_PER_SEC, GATE_ORDER_WINDOW_MS, GATE_QUERY_LIMIT, GATE_QUERY_WINDOW_MS, GATE_WEIGHTS,
  createWeightBudget, orderWeight,
} from './budget'
export type { AcquireOptions, BudgetKind, GateBudget, GateBudgetUsage, WeightBudgetOptions } from './budget'
export { CLOCK_SKEW_WARN_MS, VenueClock } from './clock'
export {
  ProblemError, GateHttpError, GateNetworkError, asProblem, redactSecret, throwAsProblem, venueProblem, VENUE_ID,
} from './errors'
export type { ErrorContext, GateEndpoint } from './errors'
export { classifyGateError, isTimestampError, isUnknownOrderError } from './venue-errors'
export type { Classified, ClassifyInput, GateErrorClass } from './venue-errors'
export { GateTradeMarket } from './market'
export type { GateMarketOptions, QuoteRef } from './market'
export {
  DEFAULT_WEIGHTS, GATE_ENDPOINTS, GateHttp, UNKNOWN_OUTCOME_LABELS, encodeSortedQuery, labelOf, parseJsonExact, signatureOf,
} from './rest'
export type { Environment, GateHttpOptions, RequestOptions } from './rest'
export {
  OrderBuildError, PRICE_ORDERS_PATH, TRIGGER_EXPIRATION_SEC, buildOrder, decodeClientOrderId, describeBody, encodeClientOrderId,
  newClientOrderId, sanitizeText, tifOf, triggerRule,
} from './orders'
export type { BuildOptions, BuiltOrder, GateTif, PriceRef, TriggerFingerprint } from './orders'
export {
  applyBps, contractsToBase, decimalsOf, fxOf, isMultipleOf, signedContracts, snapToTick, toFx, trimZeros, truncateToStep,
} from './precision'
export { clampLimitPrice } from './limit-safety'
export { GateTrading } from './trading'
export type { TradingDeps } from './trading'
export {
  FINISH_AS_MAP, ORDER_STATUS_MAP, PRICE_ORDER_PREFIX, SUPPORTED_ORDER_TYPES, SUPPORTED_TIF, SUPPORTED_TRIGGER_TYPES, VENUE,
  absDec, decimalOf, fillTsOf, instrumentIdOf, isLiquidationText, mapOpenOrderType, mapOrderStatus, marginOfPositionRow, msOfEither,
  msOfSeconds, multipliersOf, normalizeGateEvent, numOf, orderStatusWord, parseAccount, parseFill, parseFills, parseFundingRows,
  parseInstrumentRecords, parseOpenOrder, parseOpenOrders, parseOrderDetail, parsePosition, parsePositions, parsePriceOrder,
  parsePriceOrders, positiveDecimalOf, priceOrderIdOf, priceOrderStatusWord, problemError, recordFromInstrument,
  requireMultiplier, signedDecimalOf, symbolOf,
} from './parse'
export type {
  FundingRow, GateBalanceEvent, GateExecEvent, GatePositionEvent, InstrumentRecord, MappedStatus, MultiplierOf, ParsedAccount,
  ParseContext, RawAccount, RawFill, RawFundingRow, RawOrder, RawOrderDetail, RawPosition, RawPriceOrder,
} from './parse'
export type * from '@gitrader/protocol/connector'
