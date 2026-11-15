// SPDX-License-Identifier: CPAL-1.0
// 出口：Alpaca 美股交易连接器（离线件）。**未注册进内核、未经真网验证。**
export { AlpacaTradeConnector } from './connector'
export type { AlpacaTradeConnectorOptions } from './connector'
export { AlpacaAccounts } from './account'
export type { AccountsOptions, KnownOrder } from './account'
export { AlpacaAssets } from './catalog'
export type { AlpacaAssetsOptions } from './catalog'
export { AlpacaCalendar } from './calendar'
export type { MarketClockSnapshot } from './calendar'
export { alpacaCapabilities } from './capabilities'
export type { CapabilityOptions } from './capabilities'
export {
  ACCOUNT_RESTRICTION_FIELDS, ACTIVITIES_MAX_PAGES, ACTIVITIES_PAGE_SIZE, ALPACA_MODES, AUTH_HEADERS, DATA_BASE_URL,
  DEFAULT_REF_PRICE_MAX_AGE_MS, FILL_DEDUPE_NOTE, KEY_PREFIX_MODES, MARKET_TZ, POST_MARKET_CLOSE, PRE_MARKET_OPEN,
  PREFLIGHT_TTL_MS, REGULAR_CLOSE, REGULAR_OPEN, REQUESTS_PER_MINUTE, SETTLEMENT_NOTE, STREAM_URLS, SUPPORTED_ORDER_TYPES,
  SUPPORTED_TIF, TARGET_RATIO, TRADING_BASE_URLS, VENUE, VENUE_ID,
} from './constants'
export type { AccountRestrictionField, AlpacaMode } from './constants'
export { ALPACA_WEIGHTS, createAlpacaBudget, orderWeight } from './budget'
export type { AcquireOptions, AlpacaBudget, AlpacaBudgetUsage, BudgetKind, CountBudgetOptions } from './budget'
export { CLOCK_SKEW_WARN_MS, VenueClock } from './clock'
export {
  asProblem, AlpacaApiError, AlpacaHttpError, AlpacaNetworkError, ProblemError, redactSecret, throwAsProblem, venueProblem,
} from './errors'
export type { AlpacaEndpoint, ErrorContext } from './errors'
export {
  ALPACA_ERROR_CODES, classifyAlpacaError, isInsufficientError, isMarketClosedError, isRateLimited, isUnknownOrderError,
} from './venue-errors'
export type { AlpacaErrorClass, Classified, ClassifyInput } from './venue-errors'
export { AlpacaQuotes } from './quotes'
export type { AlpacaQuoteOptions, QuoteSource } from './quotes'
export {
  AlpacaHttp, DEFAULT_WEIGHTS, ModeMismatchError, assertModeMatchesKey, encodeQuery, keyMode,
} from './rest'
export type { AlpacaHttpOptions, Environment, RequestOptions } from './rest'
export {
  OrderBuildError, buildAmendBody, buildOrder, buildProtectionOrder, describeBody, mapTif, sessionHint,
} from './orders'
export type {
  AlpacaOrderClass, AlpacaTif, AmendContext, BuildContext, BuiltAmend, BuiltOrder, PriceRef, ProtectionOrder, ProtectionRequest,
} from './orders'
export { DEFAULT_TICK, FRACTIONAL_STEP, WHOLE_SHARE_STEP, applyBps, decimalsOf, isMultipleOf, isWholeQty, normalizeFractionalQty, snapToTick, toFx, truncateToStep } from './precision'
export { clampLimitPrice } from './limit-safety'
export { AlpacaTrading } from './trading'
export type { ProtectionResult, TradingDeps } from './trading'
export {
  SUPPORTED_ASSET_CLASSES, assetNotes, normalizeSymbol, parseAsset, parseAssetList, sessionWindows, symbolOf,
} from './assets'
export type { AssetRecord, ParseAssetContext } from './assets'
export {
  ORDER_STATUS_MAP, ackStatusOf, availableLongQty, fillDedupeKey, heldLongQty, isoOf, mapOpenOrderType, mapOrderStatus, msOf, parseAccount,
  parseActivityFill, parseActivityFills, parseCancelAllResults, parseOpenOrder, parseOpenOrders, parseOrder, parseOrderStatus,
  parsePosition, parsePositions,
} from './parse'
export type {
  AccountRestrictions, CancelResultRow, OrderRow, ParsedAccount, ParsedFill, ParseContext,
} from './parse'
export {
  buildSessions, describeSession, emptyCalendar, formatClock, isExtendedSession, isRegularSession, parseCalendar, parseClock,
  sessionStateAt, wallClock, zonedToUtc,
} from './sessions'
export type { CalendarDay, SessionOptions, SessionPhase, SessionState, TradingCalendar, WallClock } from './sessions'
export { AlpacaTradeStream, fillFromUpdate, normalizeStreamMessage } from './stream'
export type { AlpacaStreamOptions, SocketLike, StreamState, TradeUpdate } from './stream'
export type * from '@gitrader/protocol/connector'
