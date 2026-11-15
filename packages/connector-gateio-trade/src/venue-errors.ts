// SPDX-License-Identifier: CPAL-1.0
// Gate.io apiv4 错误 `label` / 报错文本 → 协议 Problem（契约 §2.8）。
// 分类口径照 QD 的跨所分类器（QD: backend_api_python/app/services/pending_orders/error_classification.py:31-188），
// label 白名单取自 Gate apiv4 官方错误码表（错误响应是 `{"label","message"}`，QD gate.py:129-138 只读 message）；
// 协议没有的分类落 VENUE_REJECTED（3001），不编造码；不认识的 label **不当成已知码**，只在文本里参与匹配。
// 追加的 label 取自 Gate apiv4 期货错误码表（文档口径，未经 QD 核）；不认识的仍落 3001。
import { makeProblem } from '@gitrader/protocol'
import type { Problem } from '@gitrader/protocol'
import { VENUE_ID } from './errors'

export type GateErrorClass =
  | 'credentials' | 'clock_skew' | 'rate_limit' | 'invalid_symbol' | 'transport' | 'price_band'
  | 'insufficient_funds' | 'order_size' | 'param_invalid' | 'account_configuration' | 'position_conflict'
  | 'risk_limit' | 'market_unavailable' | 'order_not_found' | 'exchange_rejected'

export interface Classified {
  problem: Problem
  cls: GateErrorClass
}

/** 分类 → 协议 Problem 的骨架。rate_limit 落 3003（与 HL 包一致：429 / 418 都是场所不可用 + retryable）。 */
const CLASS_PROBLEMS: Record<GateErrorClass, { name: Parameters<typeof makeProblem>[0]; retryable: boolean; summary: string }> = {
  credentials: { name: 'VENUE_AUTH', retryable: false, summary: 'venue rejected the credentials' },
  clock_skew: { name: 'VENUE_AUTH', retryable: true, summary: 'request timestamp is outside the venue window; resync the clock and retry' },
  rate_limit: { name: 'VENUE_UNAVAILABLE', retryable: true, summary: 'venue rate limited the request' },
  invalid_symbol: { name: 'INSTRUMENT_UNKNOWN', retryable: false, summary: 'venue does not know this contract' },
  transport: { name: 'VENUE_UNAVAILABLE', retryable: true, summary: 'venue unreachable' },
  price_band: { name: 'PRICE_DRIFT', retryable: true, summary: 'price is outside the venue price band' },
  insufficient_funds: { name: 'VENUE_INSUFFICIENT_MARGIN', retryable: false, summary: 'insufficient margin for this order' },
  order_size: { name: 'PRECISION', retryable: false, summary: 'order size / price violates the contract rules' },
  param_invalid: { name: 'INVALID_PARAMS', retryable: false, summary: 'venue rejected a request parameter' },
  account_configuration: { name: 'VENUE_REJECTED', retryable: false, summary: 'order conflicts with the account position mode or leverage setting' },
  position_conflict: { name: 'VENUE_REJECTED', retryable: false, summary: 'reduce-only order conflicts with the current position' },
  risk_limit: { name: 'VENUE_REJECTED', retryable: false, summary: 'order exceeds the venue risk limit' },
  market_unavailable: { name: 'VENUE_UNAVAILABLE', retryable: true, summary: 'venue market is closed or under maintenance' },
  order_not_found: { name: 'VENUE_REJECTED', retryable: false, summary: 'venue does not know this order' },
  exchange_rejected: { name: 'VENUE_REJECTED', retryable: false, summary: 'venue rejected the order' },
}

/** 凭据 / 签名 / IP 白名单 / 只读 key（Gate apiv4 label）。 */
const CREDENTIAL_LABELS = [
  'INVALID_KEY', 'INVALID_SIGNATURE', 'IP_FORBIDDEN', 'READ_ONLY', 'UNAUTHORIZED', 'INVALID_CREDENTIALS',
  'MISSING_REQUIRED_HEADER', 'ACCOUNT_LOCKED', 'FORBIDDEN', 'USER_NOT_FOUND',
] as const
const CREDENTIAL_TOKENS = [
  'invalid key', 'invalid signature', 'signature mismatch', 'request signature', 'ip forbidden', 'forbidden',
  'read-only', 'read only', 'api key', 'unauthorized',
] as const
/** 时间戳越界（Gate: `REQUEST_EXPIRED` / 「Timestamp ... expired」）。 */
const CLOCK_LABELS = ['REQUEST_EXPIRED', 'INVALID_TIMESTAMP'] as const
const CLOCK_TOKENS = ['invalid timestamp', 'timestamp expired', 'time deviation', 'request time deviation', 'expired timestamp'] as const
/** 限流 label 与文本。 */
const RATE_LIMIT_LABELS = ['TOO_MANY_REQUESTS', 'TOO_MANY_REQUESTS_IN_A_MINUTE', 'RATE_LIMIT_EXCEEDED'] as const
const RATE_LIMIT_TOKENS = ['too many requests', 'rate limit', 'request frequency', 'too frequent'] as const
// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/pending_orders/error_classification.py:127-132; adapted.
const INVALID_SYMBOL_LABELS = ['CONTRACT_NOT_FOUND', 'INVALID_CONTRACT', 'CURRENCY_PAIR_NOT_FOUND'] as const
const INVALID_SYMBOL_TOKENS = ['contract not found', 'invalid contract', 'unknown contract', 'trading pair does not exist', 'symbol not found'] as const
// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/pending_orders/error_classification.py:31-83; adapted.
const PRICE_BAND_LABELS = ['PRICE_TOO_DEVIATED', 'PRICE_TOO_HIGH', 'PRICE_TOO_LOW', 'ORDER_PRICE_OUT_OF_RANGE'] as const
const PRICE_BAND_TOKENS = [
  'price too deviated', 'price is higher than the maximum', 'price is lower than the minimum', 'price too high',
  'price too low', 'outside the price band', 'order price out of range', 'exceeds price limit',
] as const
// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/pending_orders/error_classification.py:142-150; adapted.
const INSUFFICIENT_LABELS = [
  'BALANCE_NOT_ENOUGH', 'INSUFFICIENT_AVAILABLE', 'FUTURES_BALANCE_NOT_ENOUGH', 'MARGIN_NOT_ENOUGH', 'INSUFFICIENT_BALANCE',
] as const
const INSUFFICIENT_TOKENS = [
  'balance not enough', 'insufficient balance', 'insufficient margin', 'insufficient_available', 'not enough margin',
  'no enough money', 'margin not enough',
] as const
// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/pending_orders/error_classification.py:151-155; adapted.
const ORDER_SIZE_LABELS = [
  'ORDER_SIZE_TOO_SMALL', 'ORDER_SIZE_TOO_LARGE', 'ORDER_SIZE_MIN', 'ORDER_SIZE_MAX', 'INVALID_ORDER_SIZE', 'ORDER_PRICE_ROUND',
  'SIZE_TOO_SMALL', 'SIZE_TOO_LARGE', 'INVALID_PRECISION',
] as const
const ORDER_SIZE_TOKENS = [
  'size too small', 'size too large', 'too many decimals', 'order size', 'minimum size', 'order_price_round',
  'price round', 'invalid size', 'invalid quantity', 'less than the minimum',
] as const
const PARAM_LABELS = ['INVALID_PARAM_VALUE', 'MISSING_REQUIRED_PARAM', 'INVALID_REQUEST_BODY', 'INVALID_REQUEST', 'INVALID_PARAM'] as const
const PARAM_TOKENS = ['invalid parameter', 'missing required', 'parameter error', 'invalid request body', 'invalid param'] as const
// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/pending_orders/error_classification.py:156-163; adapted.
const ACCOUNT_CONFIG_LABELS = [
  'POSITION_MODE_MISMATCH', 'INVALID_LEVERAGE', 'LEVERAGE_TOO_HIGH', 'LEVERAGE_TOO_LOW', 'POSITION_DUAL_MODE', 'POSITION_CROSS_MARGIN',
] as const
const ACCOUNT_CONFIG_TOKENS = [
  'position mode', 'dual mode', 'hedge mode', 'one-way mode', 'leverage too high', 'leverage too low',
  'leverage exceeds', 'inconsistent position mode',
] as const
// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/pending_orders/error_classification.py:164-172; adapted.
const POSITION_CONFLICT_LABELS = [
  'REDUCE_ONLY', 'INVALID_REDUCE_ONLY', 'POSITION_NOT_ENOUGH', 'POSITION_NOT_FOUND',
  'POSITION_EMPTY', 'REDUCE_EXCEEDED', 'INCREASE_POSITION', 'POSITION_IN_CLOSE',
] as const
const POSITION_CONFLICT_TOKENS = [
  'reduce only', 'reduce-only', 'position not enough', 'position not found', 'position is empty',
  'close position', 'no position',
] as const
// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/pending_orders/error_classification.py:173-180; adapted.
const RISK_LIMIT_LABELS = [
  'RISK_LIMIT_EXCEEDED', 'LIQUIDATION',
  'LIQUIDATE_IMMEDIATELY', 'PRICE_OVER_LIQUIDATION', 'PRICE_OVER_BANKRUPT', 'TOO_MANY_ORDERS', 'POSITION_IN_LIQUIDATION',
  'RISK_LIMIT_TOO_HIGH', 'RISK_LIMIT_NOT_MULTIPLE',
] as const
const RISK_LIMIT_TOKENS = ['risk limit', 'liquidat', 'forced liquidation'] as const
// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/pending_orders/error_classification.py:181-187; adapted.
const MARKET_UNAVAILABLE_LABELS = ['MARKET_NOT_AVAILABLE', 'CONTRACT_DELISTED', 'TRADING_DISABLED', 'CONTRACT_IN_DELISTING'] as const
const MARKET_UNAVAILABLE_TOKENS = [
  'market not available', 'maintenance', 'delisted', 'trading is currently not allowed', 'market is closed',
  'service is restarting', 'settlement in progress',
] as const
const ORDER_NOT_FOUND_LABELS = ['ORDER_NOT_FOUND', 'ORDER_CLOSED', 'ORDER_CANCELLED', 'ORDER_FINISHED'] as const
const ORDER_NOT_FOUND_TOKENS = ['order not found', 'order does not exist', 'unknown order', 'order closed', 'order finished', 'order cancelled'] as const
const TRANSPORT_TOKENS = ['bad gateway', 'gateway timeout', 'service unavailable', 'connection reset', 'connection timed out', 'temporarily unavailable'] as const
/** Gate apiv4 服务端错误 label（与 rest.ts 的 UNKNOWN_OUTCOME_LABELS 同一组）。 */
const TRANSPORT_LABELS = ['INTERNAL', 'SERVER_ERROR', 'TOO_BUSY'] as const

const hasToken = (lower: string, tokens: readonly string[]): boolean => tokens.some((t) => lower.includes(t))
const hasLabel = (label: string | undefined, labels: readonly string[]): boolean =>
  label !== undefined && label !== '' && labels.includes(label.toUpperCase())

export interface ClassifyInput {
  /** HTTP 状态。 */
  status?: number
  /** Gate 的错误 label（原值，大小写不敏感匹配）。 */
  label?: string
  text: string
}

/** 报错 → 分类 + Problem。不脱敏（脱敏在 errors.ts 的 asProblem 里做）。 */
export function classifyGateError(input: ClassifyInput): Classified {
  const lower = `${input.label ?? ''} ${input.text}`.toLowerCase()
  const status = input.status ?? 0
  const label = input.label === undefined || input.label === '' ? undefined : input.label
  const cls = decide(lower, label, status)
  const info = CLASS_PROBLEMS[cls]
  const problem: Problem = {
    ...makeProblem(info.name, info.summary, { retryable: info.retryable }),
    venue: { id: VENUE_ID, ...(label !== undefined ? { code: label } : {}), message: input.text },
  }
  return { problem, cls }
}

function decide(lower: string, label: string | undefined, status: number): GateErrorClass {
  if (status === 401 || status === 403) return 'credentials'
  if (status === 429 || status === 418) return 'rate_limit'
  if (hasLabel(label, CREDENTIAL_LABELS)) return 'credentials'
  if (hasLabel(label, RATE_LIMIT_LABELS) || hasToken(lower, RATE_LIMIT_TOKENS)) return 'rate_limit'
  if (hasLabel(label, CLOCK_LABELS)) return 'clock_skew'
  if (hasToken(lower, CREDENTIAL_TOKENS)) return 'credentials'
  if (hasToken(lower, CLOCK_TOKENS)) return 'clock_skew'
  if (status >= 500 || hasLabel(label, TRANSPORT_LABELS) || hasToken(lower, TRANSPORT_TOKENS)) return 'transport'
  if (hasLabel(label, ORDER_NOT_FOUND_LABELS) || hasToken(lower, ORDER_NOT_FOUND_TOKENS)) return 'order_not_found'
  if (hasLabel(label, INVALID_SYMBOL_LABELS) || hasToken(lower, INVALID_SYMBOL_TOKENS)) return 'invalid_symbol'
  if (hasLabel(label, PRICE_BAND_LABELS) || hasToken(lower, PRICE_BAND_TOKENS)) return 'price_band'
  if (hasLabel(label, INSUFFICIENT_LABELS) || hasToken(lower, INSUFFICIENT_TOKENS)) return 'insufficient_funds'
  if (hasLabel(label, ORDER_SIZE_LABELS) || hasToken(lower, ORDER_SIZE_TOKENS)) return 'order_size'
  if (hasLabel(label, RISK_LIMIT_LABELS) || hasToken(lower, RISK_LIMIT_TOKENS)) return 'risk_limit'
  if (hasLabel(label, POSITION_CONFLICT_LABELS) || hasToken(lower, POSITION_CONFLICT_TOKENS)) return 'position_conflict'
  if (hasLabel(label, ACCOUNT_CONFIG_LABELS) || hasToken(lower, ACCOUNT_CONFIG_TOKENS)) return 'account_configuration'
  if (hasLabel(label, MARKET_UNAVAILABLE_LABELS) || hasToken(lower, MARKET_UNAVAILABLE_TOKENS)) return 'market_unavailable'
  if (hasLabel(label, PARAM_LABELS) || hasToken(lower, PARAM_TOKENS)) return 'param_invalid'
  return 'exchange_rejected'
}

/** 上游说「这个订单不存在」（撤单 / 对账据此改判，不当成故障）。 */
export function isUnknownOrderError(problem: Problem): boolean {
  const text = `${problem.venue?.code ?? ''} ${problem.venue?.message ?? problem.message}`.toLowerCase()
  return /order not found|order does not exist|unknown order|order_closed|order_cancelled|order_finished|order_not_found/.test(text)
}

/** 时间戳越界（收到它就重校时钟，不当成凭据错误）。 */
export function isTimestampError(problem: Problem): boolean {
  const text = `${problem.venue?.code ?? ''} ${problem.venue?.message ?? problem.message}`.toLowerCase()
  return /request_expired|invalid_timestamp|timestamp/.test(text)
}
