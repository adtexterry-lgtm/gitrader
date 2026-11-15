// SPDX-License-Identifier: CPAL-1.0
// OKX v5 错误码 / 文案 → 稳定分类 → 协议 Problem（契约 §2.8）。
// 分类顺序照 QuantDinger 的 pending_orders/error_classification.py（:31-188）搬到 TypeScript：
// credentials → clock_skew → rate_limit → invalid_instrument → transport → price_band → insufficient_funds →
// order_size → account_configuration → position_conflict → risk_limit → market_unavailable → exchange_rejected，
// 只在最后一步换成协议 Problem 码。OKX 特有的「逐单错误」在信封 data[0].sCode 里（QD okx.py:361-387 读的就是它）。
// 码表是唯一来源：先在 OKX_ERROR_CLASSES 里命中，未命中才走 HTTP 状态 + 关键词链。
// 认不出来的不猜：落 3001 VENUE_REJECTED 且 retryable = false（防止盲目重发下单请求）。
import { makeProblem } from '@gitrader/protocol'
import type { Problem, ProblemName } from '@gitrader/protocol'

export const VENUE_ID = 'okx'

export type OkxErrorClass =
  | 'credentials'
  | 'clock_skew'
  | 'rate_limit'
  | 'invalid_instrument'
  | 'transport'
  | 'price_band'
  | 'insufficient_funds'
  | 'order_size'
  | 'account_configuration'
  | 'position_conflict'
  | 'risk_limit'
  | 'market_unavailable'
  | 'exchange_rejected'

interface Mapping {
  name: ProblemName
  retryable: boolean
  summary: string
}

/** 结果未知码：非 GET 上要落 3006（50004 = 端点超时 / 结果未知，不得盲目重发）。 */
export const UNKNOWN_OUTCOME_CODES = ['50004'] as const
export function isUnknownOutcomeCode(code: unknown): boolean {
  return (UNKNOWN_OUTCOME_CODES as readonly string[]).includes(String(code))
}

/** 是否限流码（唯一来源是 OKX_ERROR_CLASSES）。 */
export function isRateLimitCode(code: unknown): boolean {
  if (code === undefined || code === null) return false
  const numeric = Number(code)
  return Number.isFinite(numeric) && OKX_ERROR_CLASSES[numeric] === 'rate_limit'
}

/** 分类 → 协议 Problem。rate_limit 落 3002（HTTP 429 在 errors.ts 里另按工单口径落 3003）。 */
const PROBLEM_FOR_CLASS: Record<OkxErrorClass, Mapping> = {
  credentials: { name: 'VENUE_AUTH', retryable: false, summary: 'venue could not authenticate the API key' },
  clock_skew: {
    name: 'INVALID_PARAMS',
    retryable: false,
    summary: 'request timestamp drifted outside the venue window; resync the clock before resending',
  },
  rate_limit: { name: 'VENUE_RATE_LIMITED', retryable: true, summary: 'venue rate limited the request' },
  invalid_instrument: { name: 'INSTRUMENT_UNKNOWN', retryable: false, summary: 'venue does not know this instrument' },
  transport: { name: 'VENUE_UNAVAILABLE', retryable: true, summary: 'venue unreachable' },
  price_band: { name: 'PRICE_DRIFT', retryable: false, summary: 'price is outside the venue price band for this instrument' },
  insufficient_funds: { name: 'VENUE_INSUFFICIENT_MARGIN', retryable: false, summary: 'venue reports insufficient margin or balance' },
  order_size: { name: 'PRECISION', retryable: false, summary: 'order size or price violates the venue constraints' },
  account_configuration: { name: 'VENUE_REJECTED', retryable: false, summary: 'venue rejected the request for the current account configuration' },
  position_conflict: { name: 'VENUE_REJECTED', retryable: false, summary: 'venue rejected the request because it conflicts with the current position' },
  risk_limit: { name: 'VENUE_REJECTED', retryable: false, summary: 'venue rejected the request because it exceeds a risk limit' },
  market_unavailable: { name: 'VENUE_UNAVAILABLE', retryable: true, summary: 'venue market is closed, delisted or under maintenance' },
  exchange_rejected: { name: 'VENUE_REJECTED', retryable: false, summary: 'venue rejected the request' },
}

/** 明确码表（OKX v5 常见错误码，取 QD okx.py 用到的那些 + 官方文档口径）。 */
export const OKX_ERROR_CLASSES: Record<number, OkxErrorClass> = {
  // credentials（apiKey / 签名 / passphrase / 白名单）
  50101: 'credentials',
  50103: 'credentials',
  50104: 'credentials',
  50105: 'credentials',
  50106: 'credentials',
  50110: 'credentials',
  50111: 'credentials',
  50113: 'credentials',
  50114: 'credentials',
  50120: 'credentials', // 该 API key 没有交易权限（QD okx.py:344-353 / 373-378 专门解释这一条）
  // clock skew
  50102: 'clock_skew',
  50107: 'clock_skew',
  50112: 'clock_skew',
  // rate limit
  50011: 'rate_limit',
  50013: 'rate_limit',
  50121: 'credentials',
  // instrument
  51001: 'invalid_instrument',
  51002: 'invalid_instrument',
  // transport / server
  50000: 'exchange_rejected',
  50001: 'transport',
  50004: 'transport',
  50026: 'transport',
  50061: 'transport',
  // price band（限价超出涨跌幅带 / 触发价无效）
  51006: 'price_band',
  51024: 'exchange_rejected',
  51025: 'risk_limit',
  51203: 'risk_limit',
  // funds
  51008: 'insufficient_funds',
  51009: 'exchange_rejected',
  51117: 'risk_limit',
  51119: 'insufficient_funds',
  51150: 'order_size',
  // size / precision / min size
  51020: 'order_size',
  51200: 'order_size',
  51201: 'order_size',
  51202: 'order_size',
  51000: 'order_size',
  // account configuration（持仓模式 / 保证金模式 / posSide 组合）
  51004: 'account_configuration',
  51121: 'order_size',
  51169: 'position_conflict',
  59000: 'account_configuration',
  59001: 'account_configuration',
  59006: 'account_configuration',
  // 持仓冲突（reduceOnly 打不出去 / 没有可平仓位）
  51023: 'position_conflict',
  51010: 'position_conflict',
  51176: 'position_conflict',
  // 风险限额
  51005: 'risk_limit',
  51011: 'risk_limit',
  51147: 'risk_limit',
  // 市场不可用
  51012: 'market_unavailable',
  51014: 'market_unavailable',
  // 明确拒单
  51003: 'exchange_rejected',
  51007: 'exchange_rejected',
  51015: 'exchange_rejected',
  51016: 'exchange_rejected',
  51400: 'exchange_rejected',
  51503: 'exchange_rejected',
  51603: 'exchange_rejected',
}

const AUTH_TOKENS = [
  'invalid api key', 'api key is invalid', 'apikey does not exist', 'invalid signature', 'signature mismatch',
  'invalid passphrase', 'passphrase incorrect', 'no permission', 'permission denied', 'unauthorized',
  'does not have permission', 'api key expired',
] as const

const CLOCK_SKEW_TOKENS = ['timestamp request expired', 'invalid timestamp', 'timestamp expired', 'current time', 'not within the valid window'] as const

const RATE_LIMIT_TOKENS = ['too many requests', 'rate limit', 'requests too frequent', 'system busy', 'please try again later'] as const

const INSTRUMENT_TOKENS = ['instrument id does not exist', 'instrument does not exist', 'invalid instrument', 'instid'] as const

const TRANSPORT_TOKENS = [
  'connection reset', 'econnreset', 'econnrefused', 'etimedout', 'eai_again', 'enotfound', 'epipe',
  'socket hang up', 'network error', 'fetch failed', 'connection aborted', 'connection closed',
  'connection timed out', 'timeout waiting for response', 'timed out', 'bad gateway', 'gateway timeout',
  'service unavailable', 'service temporarily unavailable', 'system error',
] as const

const PRICE_BAND_TOKENS = [
  'price is higher than the maximum', 'price is lower than the minimum', 'exceeds the price limit',
  'price band', 'trigger price', 'order price is invalid', 'price should be higher', 'price should be lower',
] as const

const INSUFFICIENT_TOKENS = ['insufficient balance', 'insufficient margin', 'margin is insufficient', 'not enough balance', 'balance is insufficient'] as const

const ORDER_SIZE_TOKENS = [
  'order amount is too small', 'order quantity is too small', 'size is too small', 'lot size',
  'multiple of the lot size', 'parameter error', 'invalid size', 'minimum order size', 'too many decimals',
] as const

const ACCOUNT_CONFIG_TOKENS = [
  'position mode', 'posmode', 'margin mode', 'mgntype', 'tdmode', 'posside', 'leverage', 'not supported under',
  'account mode', 'isolated margin',
] as const

const POSITION_CONFLICT_TOKENS = ['no position to close', 'reduceonly', 'reduce-only', 'position does not exist', 'position is empty'] as const

const RISK_LIMIT_TOKENS = ['exceeds the maximum', 'risk limit', 'number of orders exceeds', 'order count exceeds', 'max open orders'] as const

const MARKET_UNAVAILABLE_TOKENS = ['trading is not open', 'market is closed', 'under maintenance', 'instrument is suspended', 'delisted', 'order type is not supported'] as const

const hasToken = (lower: string, tokens: readonly string[]): boolean => tokens.some((token) => lower.includes(token))
export interface ClassifyInput {
  /** 原始错误文本（msg / sMsg / HTTP body）。 */
  text: string
  /** OKX 信封码（已解析时直接用）。 */
  code?: number | undefined
  /** HTTP 状态码。 */
  status?: number | undefined
}

export interface Classified {
  class: OkxErrorClass
  problem: Problem
  httpStatus: number
}

/** 按 QD 的顺序分类，并映射成协议 Problem（venue.message = 原文）。 */
export function classifyOkxError(input: ClassifyInput): Classified {
  const raw = input.text
  const lower = raw.toLowerCase()
  const httpStatus = input.status ?? 0
  const code = input.code
  const codeClass = code !== undefined ? OKX_ERROR_CLASSES[code] : undefined

  let klass: OkxErrorClass
  if (codeClass !== undefined) {
    klass = codeClass
  } else if (httpStatus === 401 || httpStatus === 403 || hasToken(lower, AUTH_TOKENS)) {
    klass = 'credentials'
  } else if (hasToken(lower, CLOCK_SKEW_TOKENS)) {
    klass = 'clock_skew'
  } else if (httpStatus === 429 || hasToken(lower, RATE_LIMIT_TOKENS)) {
    klass = 'rate_limit'
  } else if (hasToken(lower, INSTRUMENT_TOKENS)) {
    klass = 'invalid_instrument'
  } else if (httpStatus >= 500 || hasToken(lower, TRANSPORT_TOKENS)) {
    klass = 'transport'
  } else if (hasToken(lower, PRICE_BAND_TOKENS)) {
    klass = 'price_band'
  } else if (hasToken(lower, INSUFFICIENT_TOKENS)) {
    klass = 'insufficient_funds'
  } else if (hasToken(lower, ORDER_SIZE_TOKENS)) {
    klass = 'order_size'
  } else if (hasToken(lower, ACCOUNT_CONFIG_TOKENS)) {
    klass = 'account_configuration'
  } else if (hasToken(lower, POSITION_CONFLICT_TOKENS)) {
    klass = 'position_conflict'
  } else if (hasToken(lower, RISK_LIMIT_TOKENS)) {
    klass = 'risk_limit'
  } else if (hasToken(lower, MARKET_UNAVAILABLE_TOKENS)) {
    klass = 'market_unavailable'
  } else {
    klass = 'exchange_rejected'
  }

  const mapped = PROBLEM_FOR_CLASS[klass]
  return {
    class: klass,
    httpStatus,
    problem: makeProblem(mapped.name, mapped.summary, {
      retryable: mapped.retryable,
      venue: {
        id: VENUE_ID,
        ...(code !== undefined ? { code } : httpStatus ? { code: httpStatus } : {}),
        message: raw,
      },
    }),
  }
}

/** order_size 细分：命中最小数量 / 最小名义额时返回 PRECISION 之外的 MIN_NOTIONAL。 */
export function refineOrderSizeProblem(problem: Problem, input: ClassifyInput): Problem {
  if (problem.code !== 1002) return problem
  const lower = input.text.toLowerCase()
  const notional = hasToken(lower, ['minimum order amount', 'min notional', 'notional', 'amount is too small'])
  if (!notional) return problem
  return makeProblem('MIN_NOTIONAL', 'order notional is below the venue minimum', {
    retryable: false,
    venue: { id: VENUE_ID, message: input.text },
  })
}
