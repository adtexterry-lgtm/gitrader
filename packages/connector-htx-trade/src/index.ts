// SPDX-License-Identifier: CPAL-1.0
// 出口：HTX USDT 本位永续交易连接器（离线件）。**未注册进内核 / CLI，未经真网验证。**
export { defaultBudget, HtxTradeConnector } from './connector'
export type { HtxTradeConnectorOptions } from './connector'
export { FALLBACK_MIN_NOTIONAL, htxCapabilities } from './capabilities'
export { HtxAccounts, FILL_WINDOW_MS, MAX_FILL_WINDOWS, MAX_PAGES, PAGE_SIZE, V5_FILL_WINDOW_MS, V5_MAX_FILL_LOOKBACK_MS, V5_PAGE_LIMIT } from './account'
export type { AccountsOptions, ReaderDeps } from './account'
export {
  DEFAULT_TARGET_RATIO, HTX_ORDER_LIMIT_PER_SEC, HTX_QUERY_LIMIT_PER_SEC, HTX_RATE_WINDOW_MS, HTX_WEIGHTS,
  createWeightBudget, orderWeight,
} from './budget'
export type { BudgetKind, HtxBudget, HtxBudgetUsage, WeightBudgetOptions } from './budget'
export { asProblem, HtxHttpError, HtxNetworkError, ProblemError, redactSecret, throwAsProblem, venueProblem, VENUE_ID } from './errors'
export type { ErrorContext, HtxEndpoint } from './errors'
export { AMBIGUOUS_VENUE_CODES, classifyHtxError, classifyOnly, HTX_ERROR_CLASSES, isAmbiguousVenueCode } from './venue-errors'
export type { Classified, ClassifyInput, HtxErrorClass } from './venue-errors'
export { clampLimitPrice } from './limit-safety'
export { HtxTradeMarket, MAX_CANDLES, PERIOD_MAP, faceValueOfContractRow, parseContract } from './market'
export type { MarketDeps, MarketOptions, RawContract } from './market'
export {
  buildCancelAllBody, buildCancelBody, buildLeverBody, buildOrderBody, buildOrderQueryParams, buildTpslBody,
  CLIENT_ORDER_ID_MAX_DIGITS, directionOf, newClientOrderId, numericClientOrderId, ORDER_PRICE_TYPE,
  ORDER_TYPE_SUPPORT, OrderBuildError, positionSideOf, SUPPORTED_ORDER_TYPES, SUPPORTED_TIF, SUPPORTED_TRIGGER_TYPES,
  tpslSideOk,
} from './orders'
export type { BuildOptions, BuiltOrder, OrderFamily, PriceRef, TpslLeg, TpslSpec } from './orders'
export type { RawOrder } from './parse'
export {
  absDecimal, baseSizeOf, decimalOf, fillDedupeKey, firstOrderRow, instrumentIdOf, isClosingTrade, num, ORDER_STATUS_MAP,
  orderStatusOf, parseAccountSnapshot, parseOpenOrder, parseOrderStatusResult, parsePosition, parsePositions, parseTrade,
  parseTrades, symbolOf, upper, VENUE, ZERO,
} from './parse'
export type {
  ContractSizeOf, RawBalanceEnvelope, RawBalanceRow, RawPosition, RawTrade, RawTradesEnvelope,
} from './parse'
export { baseToContracts, contractsToBase, decimalsOf, isMultipleOf, snapToTick, toFx, truncateToStep } from './precision'
export {
  codeOf, encodeParams, ENDPOINTS, envelopeOk, envelopeTsOf, hostOf, HTX_ENDPOINTS, HtxHttp, prehashOf, quoteBigIds, retryAfterOf,
  signatureOf,
} from './rest'
export type { EndpointName, Environment, HtxEnvelope, HtxHttpOptions, RequestOptions, SignedPayload } from './rest'
export { formatHtxTimestamp, HtxClock, serverTimeMsOf } from './time'
export { flipPositionMode, HtxTrading } from './trading'
export type { LeverageState, TradingDeps } from './trading'
export type * from '@gitrader/protocol/connector'
