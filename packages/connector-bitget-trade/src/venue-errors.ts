// SPDX-License-Identifier: CPAL-1.0
// Bitget v2 mix 错误码 / 报错文本 → 协议 Problem（契约 §2.8）。
// 分类口径照 QD 的跨所分类器（QD: backend_api_python/app/services/pending_orders/error_classification.py:31-188），
// 只保留 Bitget 相关的码与文本；协议没有的分类落 VENUE_REJECTED（3001），不编造码。
// 说明：Bitget 业务错误以 `{code,msg}` 信封返回（HTTP 状态可能是 200 或 4xx），`code` 是字符串（成功 '00000'）。
import { makeProblem } from '@gitrader/protocol'
import type { Problem } from '@gitrader/protocol'
import { VENUE_ID } from './errors'

export type BitgetErrorClass =
  | 'credentials' | 'clock_skew' | 'rate_limit' | 'invalid_symbol' | 'transport' | 'price_band'
  | 'insufficient_funds' | 'order_size' | 'min_notional' | 'param_invalid' | 'account_configuration' | 'position_conflict'
  | 'risk_limit' | 'market_unavailable' | 'exchange_rejected'

export interface Classified {
  problem: Problem
  cls: BitgetErrorClass
}

/** 分类 → 协议 Problem 的骨架。rate_limit 落 3003（与 HL 包一致：429 / 418 都是场所不可用 + retryable）。 */
const CLASS_PROBLEMS: Record<BitgetErrorClass, { name: Parameters<typeof makeProblem>[0]; retryable: boolean; summary: string }> = {
  credentials: { name: 'VENUE_AUTH', retryable: false, summary: 'venue rejected the credentials' },
  clock_skew: { name: 'VENUE_AUTH', retryable: true, summary: 'request timestamp is outside the venue window; resync the clock and retry' },
  rate_limit: { name: 'VENUE_UNAVAILABLE', retryable: true, summary: 'venue rate limited the request' },
  invalid_symbol: { name: 'INSTRUMENT_UNKNOWN', retryable: false, summary: 'venue does not know this symbol' },
  transport: { name: 'VENUE_UNAVAILABLE', retryable: true, summary: 'venue unreachable' },
  price_band: { name: 'PRICE_DRIFT', retryable: true, summary: 'price is outside the venue price band' },
  insufficient_funds: { name: 'VENUE_INSUFFICIENT_MARGIN', retryable: false, summary: 'insufficient margin for this order' },
  order_size: { name: 'PRECISION', retryable: false, summary: 'order size / price violates the venue contract rules' },
  min_notional: { name: 'MIN_NOTIONAL', retryable: false, summary: 'order value is below the venue minimum' },
  param_invalid: { name: 'INVALID_PARAMS', retryable: false, summary: 'venue rejected a request parameter' },
  account_configuration: { name: 'VENUE_REJECTED', retryable: false, summary: 'order conflicts with the account position / margin mode or leverage setting' },
  position_conflict: { name: 'VENUE_REJECTED', retryable: false, summary: 'reduce-only order conflicts with the current position' },
  risk_limit: { name: 'VENUE_REJECTED', retryable: false, summary: 'order exceeds the venue risk limit' },
  market_unavailable: { name: 'VENUE_UNAVAILABLE', retryable: true, summary: 'venue market is closed or under maintenance' },
  exchange_rejected: { name: 'VENUE_REJECTED', retryable: false, summary: 'venue rejected the order' },
}

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/pending_orders/error_classification.py:103; adapted.
/** 凭据 / 签名 / 权限类（Bitget 官方码；QD 的分类器只列了前 5 个）。 */
const CREDENTIAL_CODES = ['40002', '40003', '40005', '40006', '40009', '40012', '40014', '40018', '40037'] as const
const CREDENTIAL_TOKENS = [
  'invalid api-key', 'invalid api key', 'api key is invalid', 'api-key format invalid', 'api key has expired',
  'permission denied', 'invalid signature', 'sign signature error', 'error sign', 'user authentication failed',
  'unmatched ip', 'invalid ip', 'ip whitelist', 'ip not whitelisted', 'not_login', 'unauthorized', 'passphrase',
] as const
/** 时间戳越界（Bitget 40006 / 40008 家族；40006 按凭据处理，40008 单列成时钟）。 */
const CLOCK_CODES = ['40008'] as const
const CLOCK_TOKENS = ['invalid timestamp', 'request time exceeds', 'outside of the recvwindow', 'timestamp request expired', 'timestamp'] as const
// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/pending_orders/error_classification.py:119-125; adapted.
const RATE_LIMIT_CODES = ['429', '10429', '50011'] as const
const RATE_LIMIT_TOKENS = ['rate limit', 'rate_limit', 'too many request', 'too many visits', 'request_frequency', 'operation too frequent'] as const
// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/pending_orders/error_classification.py:127-132; adapted.
const INVALID_SYMBOL_TOKENS = ['invalid symbol', 'bad_symbol', 'contract_not_found', 'trading pair does not exist', 'symbol is invalid', 'symbol not found'] as const
// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/pending_orders/error_classification.py:31-83; adapted.
const PRICE_BAND_CODES = ['51137', '51138'] as const
const PRICE_BAND_TOKENS = [
  'price exceeds the allowable range', 'price is higher than the maximum', 'price is lower than the minimum',
  'order price cannot be smaller than', 'order price cannot be higher than', 'outside the price band',
  'order price deviates too much from mark price', 'price_too_deviated', 'exceeds price limit',
] as const
// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/pending_orders/error_classification.py:142-150; adapted.
const INSUFFICIENT_CODES = ['110004', '110006', '110007', '110012', '40310000', '40762', '43012'] as const
const INSUFFICIENT_TOKENS = [
  'insufficient_available', 'insufficient balance', 'insufficient margin', 'not enough balance',
  'margin insufficient', 'balance_not_enough', 'balance is not enough', 'margin while available',
] as const
// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/pending_orders/error_classification.py:151-155; adapted.
const ORDER_SIZE_CODES = ['-1111', '110017', '110094'] as const
const ORDER_SIZE_TOKENS = [
  'step size', 'minqty', 'min qty', 'minsize', 'min size', 'min_notional', 'minnotional', 'invalid qty',
  'invalid quantity', 'invalid size', 'bad precision', 'too many decimals', 'minimum price variation',
  'size is too small', 'size below', 'minimum size', 'less than the minimum',
] as const
/** 参数缺失 / 非法（Bitget 信封里常用「Parameter does not exist」一类文本）。 */
const PARAM_TOKENS = ['parameter does not exist', 'parameter cannot be null', 'invalid parameter', 'missing parameter', 'param error', 'illegal parameter'] as const
// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/pending_orders/error_classification.py:156-163; adapted.
const ACCOUNT_CONFIG_TOKENS = [
  'position mode', 'margin mode', 'account mode', 'hedge mode', 'one-way mode', 'one way mode',
  'leverage too high', 'leverage too low', 'leverage exceeds', 'position mode does not match',
] as const
/** 40774：QD 实测的「对冲 / 单向持仓不匹配」码（QD bitget.py:294-310 会换字段重试一次）。 */
export const BITGET_POSITION_MODE_MISMATCH_CODES = ['40774'] as const
// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/pending_orders/error_classification.py:164-172; adapted.
const POSITION_CONFLICT_TOKENS = [
  'reduceonly order is rejected', 'reduce-only order', 'position not sufficient', 'position_empty',
  'position not found', 'position does not exist', 'position side does not match',
] as const
// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/pending_orders/error_classification.py:173-180; adapted.
const RISK_LIMIT_TOKENS = ['risk_limit_exceeded', 'liquidate_immediately', 'in liquidation', 'trigger a forced liquidation', 'exceeds the maximum risk limit'] as const
// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/pending_orders/error_classification.py:181-187; adapted.
const MARKET_UNAVAILABLE_TOKENS = [
  'service is restarting', 'settlement in progress', 'temporarily closed for maintenance',
  'contract delisted', 'trading is currently not allowed', 'market is closed',
] as const
const TRANSPORT_TOKENS = [
  'bad gateway', 'gateway timeout', 'service unavailable', 'connection reset', 'connection timed out', 'temporarily unavailable',
  'system error', 'system busy', 'system is abnormal', 'please try again later',
] as const

/** Bitget 官方「订单不存在」码（撤单 / 查单要据此改打计划委托端点或按 found=false 处理）。 */
export const BITGET_ORDER_NOT_FOUND_CODES = ['40109', '40768', '43001', '43025'] as const

const hasToken = (lower: string, tokens: readonly string[]): boolean => tokens.some((t) => lower.includes(t))

export interface ClassifyInput {
  /** HTTP 状态；信封错误传实际 HTTP 状态（200 或 4xx）。 */
  status?: number
  /** 上游 code 原值（字符串 / 数字）。 */
  code?: string | number
  text: string
}

/** 报错 → 分类 + Problem。不脱敏（脱敏在 errors.ts 的 asProblem 里做）。 */
export function classifyBitgetError(input: ClassifyInput): Classified {
  const lower = input.text.toLowerCase()
  const status = input.status ?? 0
  const codeText = input.code === undefined ? '' : String(input.code)
  const code = codeText === '' ? undefined : codeText
  const cls = decide(lower, code, status)
  const info = CLASS_PROBLEMS[cls]
  const problem: Problem = {
    ...makeProblem(info.name, info.summary, { retryable: info.retryable }),
    venue: { id: VENUE_ID, ...(code !== undefined ? { code } : {}), message: input.text },
  }
  return { problem, cls }
}

function decide(lower: string, code: string | undefined, status: number): BitgetErrorClass {
  if (status === 401 || status === 403) return 'credentials'
  if (status === 429 || status === 418) return 'rate_limit'
  if (code !== undefined && (CREDENTIAL_CODES as readonly string[]).includes(code)) return 'credentials'
  // 40008 = 请求时间戳越界：重校时钟后可再试（3005 retryable）。
  if (code !== undefined && (CLOCK_CODES as readonly string[]).includes(code)) return 'clock_skew'
  if ((code !== undefined && RATE_LIMIT_CODES.includes(code as (typeof RATE_LIMIT_CODES)[number])) || hasToken(lower, RATE_LIMIT_TOKENS)) return 'rate_limit'
  if (hasToken(lower, CREDENTIAL_TOKENS)) return 'credentials'
  if (hasToken(lower, CLOCK_TOKENS)) return 'clock_skew'
  if (status >= 500 || hasToken(lower, TRANSPORT_TOKENS)) return 'transport'
  if (code !== undefined && (BITGET_POSITION_MODE_MISMATCH_CODES as readonly string[]).includes(code)) return 'account_configuration'
  if (code !== undefined && (PRICE_BAND_CODES as readonly string[]).includes(code)) return 'price_band'
  if (hasToken(lower, PRICE_BAND_TOKENS)) return 'price_band'
  if (hasToken(lower, INVALID_SYMBOL_TOKENS)) return 'invalid_symbol'
  if (code !== undefined && (INSUFFICIENT_CODES as readonly string[]).includes(code)) return 'insufficient_funds'
  if (hasToken(lower, INSUFFICIENT_TOKENS)) return 'insufficient_funds'
  // 名义额不足在 order_size 之前判：'less than the minimum' 也被 ORDER_SIZE_TOKENS 覆盖。
  if (code === '45110' || lower.includes('less than the minimum amount')) return 'min_notional'
  if (code !== undefined && (ORDER_SIZE_CODES as readonly string[]).includes(code)) return 'order_size'
  if (hasToken(lower, ORDER_SIZE_TOKENS)) return 'order_size'
  if (hasToken(lower, PARAM_TOKENS)) return 'param_invalid'
  if (hasToken(lower, ACCOUNT_CONFIG_TOKENS)) return 'account_configuration'
  if (hasToken(lower, POSITION_CONFLICT_TOKENS)) return 'position_conflict'
  if (hasToken(lower, RISK_LIMIT_TOKENS)) return 'risk_limit'
  if (hasToken(lower, MARKET_UNAVAILABLE_TOKENS)) return 'market_unavailable'
  return 'exchange_rejected'
}

/** 上游说「这个订单不存在」（撤单要据此改打计划委托端点；查单据此回 found=false）。 */
export function isUnknownOrderError(problem: Problem): boolean {
  const code = problem.venue?.code === undefined ? '' : String(problem.venue.code)
  if ((BITGET_ORDER_NOT_FOUND_CODES as readonly string[]).includes(code)) return true
  const text = `${code} ${problem.venue?.message ?? problem.message}`
  // 不放宽成裸 `does not exist`：假服务器缺参文本是 `Parameter does not exist`。
  return /order (does not|did not|not) exist|order not found|unknown order|order.{0,30}cannot be found|40701|40702/i.test(text)
}

/** 上游说「这个 code 需要换持仓字段重试」（QD bitget.py:294-310）。 */
export function isPositionModeMismatch(problem: Problem): boolean {
  const text = `${problem.venue?.code ?? ''} ${problem.venue?.message ?? problem.message}`
  return /40774/.test(text) || /position mode|hedge mode|one-way mode/i.test(text)
}
