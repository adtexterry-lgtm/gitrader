// SPDX-License-Identifier: CPAL-1.0
// Binance USDⓈ-M 错误码 / 文案 → 稳定分类 → 协议 Problem（契约 §2.8）。
// 分类表与关键字规则照 QuantDinger 的 pending_orders/error_classification.py（:31-188）搬到 TypeScript：
// 顺序、码表、关键字一律保持 QD 的先后（credentials → clock_skew → rate_limit → invalid_symbol → transport →
// price_band → insufficient_funds → order_size → account_configuration → position_conflict → risk_limit →
// market_unavailable → exchange_rejected），只在最后一步换成协议 Problem 码。
// 认不出来的不猜：落 3001 VENUE_REJECTED 且 retryable = false（防止盲目重发下单请求）。
import { makeProblem } from '@gitrader/protocol'
import type { Problem, ProblemName } from '@gitrader/protocol'

export const VENUE_ID = 'binance'

export type BinanceErrorClass =
  | 'credentials'
  | 'clock_skew'
  | 'rate_limit'
  | 'invalid_symbol'
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

/** 分类 → 协议 Problem。rate_limit 与 HTTP 429 / 418 一律落 3003 VENUE_UNAVAILABLE + retryable（照 HL venue-errors.ts 的 rate_limit）。 */
const PROBLEM_FOR_CLASS: Record<BinanceErrorClass, Mapping> = {
  credentials: { name: 'VENUE_AUTH', retryable: false, summary: 'venue could not authenticate the API key' },
  clock_skew: {
    name: 'INVALID_PARAMS',
    retryable: false,
    summary: 'request timestamp drifted outside recvWindow; resync the clock before resending',
  },
  rate_limit: { name: 'VENUE_UNAVAILABLE', retryable: true, summary: 'venue rate limited the request' },
  invalid_symbol: { name: 'INSTRUMENT_UNKNOWN', retryable: false, summary: 'venue does not know this symbol' },
  transport: { name: 'VENUE_UNAVAILABLE', retryable: true, summary: 'venue unreachable' },
  price_band: { name: 'PRICE_DRIFT', retryable: false, summary: 'price is outside the venue price band for this symbol' },
  insufficient_funds: { name: 'VENUE_INSUFFICIENT_MARGIN', retryable: false, summary: 'venue reports insufficient margin or balance' },
  order_size: { name: 'PRECISION', retryable: false, summary: 'order size or price violates the venue filters' },
  account_configuration: { name: 'VENUE_REJECTED', retryable: false, summary: 'venue rejected the request for the current account configuration' },
  position_conflict: { name: 'VENUE_REJECTED', retryable: false, summary: 'venue rejected the request because it conflicts with the current position' },
  risk_limit: { name: 'VENUE_REJECTED', retryable: false, summary: 'venue rejected the request because it exceeds a risk limit' },
  market_unavailable: { name: 'VENUE_UNAVAILABLE', retryable: true, summary: 'venue market is closed, delisted or under maintenance' },
  exchange_rejected: { name: 'VENUE_REJECTED', retryable: false, summary: 'venue rejected the request' },
}

/** 明确码表（Binance USDⓈ-M 常见错误码，取 QD 用到的那些 + Binance 官方文档口径）。 */
export const BINANCE_ERROR_CLASSES: Record<number, BinanceErrorClass> = {
  // credentials
  '-1002': 'credentials',
  '-1022': 'credentials',
  '-2014': 'credentials',
  '-2015': 'credentials',
  '-1125': 'credentials', // listenKey does not exist（用户流）
  // clock skew
  '-1021': 'clock_skew',
  // rate limits
  '-1003': 'rate_limit',
  '-1008': 'rate_limit',
  '-1015': 'rate_limit',
  // symbol
  '-1121': 'invalid_symbol',
  // transport / server（-1000 / -1006 / -1007 在非 GET 请求上会被 rest.ts 标成「结果未知」3006）
  '-1000': 'transport',
  '-1001': 'transport',
  '-1006': 'transport',
  '-1007': 'transport',
  '-1016': 'market_unavailable',
  // price band / percent price
  '-4016': 'price_band',
  '-4024': 'price_band',
  '-4131': 'price_band',
  // funds
  '-2010': 'insufficient_funds',
  '-2018': 'insufficient_funds',
  '-2019': 'insufficient_funds',
  // size / precision / min notional
  '-1111': 'order_size',
  '-4003': 'order_size',
  '-4004': 'order_size',
  '-4014': 'order_size',
  '-4164': 'order_size',
  // account configuration（保证金模式 / 持仓模式 / positionSide 冲突）
  '-1106': 'account_configuration',
  '-4046': 'account_configuration',
  '-4048': 'account_configuration',
  '-4061': 'account_configuration',
  // 持仓冲突（reduceOnly 打不出去）
  '-2022': 'position_conflict',
  // 风险限额
  '-2027': 'risk_limit',
  '-2028': 'risk_limit',
  // 明确拒单
  '-2011': 'exchange_rejected',
  '-2013': 'exchange_rejected',
  '-1102': 'exchange_rejected',
  '-1130': 'exchange_rejected',
}

const AUTH_CODES = ['-1002', '-1022', '-2014', '-2015'] as const
const AUTH_TOKENS = [
  'invalid api-key', 'invalid api key', 'api key is invalid', 'api-key format invalid',
  'invalid signature', 'signature for this request is not valid', 'bad api key', 'unauthorized',
] as const

const CLOCK_SKEW_CODES = ['-1021'] as const
const CLOCK_SKEW_TOKENS = [
  'invalid timestamp', 'timestamp for this request is outside', 'recvwindow', 'request time exceeds',
  'timestamp request expired',
] as const

const RATE_LIMIT_CODES = ['-1003', '-1008', '-1015'] as const
const RATE_LIMIT_TOKENS = ['too many requests', 'too many request', 'rate limit', 'rate_limit', 'way too many requests'] as const

const INVALID_SYMBOL_CODES = ['-1121'] as const
const INVALID_SYMBOL_TOKENS = ['invalid symbol', 'bad_symbol', 'symbol is invalid', 'contract not found'] as const

const TRANSPORT_TOKENS = [
  'connection reset', 'econnreset', 'econnrefused', 'etimedout', 'eai_again', 'enotfound', 'epipe',
  'socket hang up', 'network error', 'fetch failed', 'connection aborted', 'connection closed',
  'connection timed out', 'timeout waiting for response', 'timed out', 'bad gateway', 'gateway timeout',
  'service unavailable', 'temporarily unavailable',
] as const

const PRICE_BAND_CODES = ['-4016', '-4024', '-4131'] as const
const PRICE_BAND_TOKENS = [
  'outside the price band', 'price is higher than the maximum', 'price is lower than the minimum',
  'percent price', 'filter failure: percent_price', 'price_too_deviated', 'exceeds price limit',
] as const

const INSUFFICIENT_CODES = ['-2010', '-2018', '-2019'] as const
const INSUFFICIENT_TOKENS = [
  'insufficient balance', 'insufficient margin', 'margin is insufficient', 'insufficient_available',
  'not enough balance', 'balance is insufficient',
] as const

const ORDER_SIZE_CODES = ['-1111', '-4003', '-4004', '-4014', '-4164'] as const
const ORDER_SIZE_TOKENS = [
  'step size', 'min qty', 'minqty', 'min size', 'minsize', 'min_notional', 'minnotional',
  'notional must be no smaller', 'invalid quantity', 'invalid qty', 'bad precision', 'too many decimals',
  'price not increased by tick size', 'quantity is less than', 'quantity greater than max quantity',
] as const

const ACCOUNT_CONFIG_CODES = ['-1106', '-4046', '-4048', '-4061'] as const
const ACCOUNT_CONFIG_TOKENS = [
  'position side does not match', 'position mode', 'margin mode', 'margin type', 'hedge mode',
  'one-way mode', 'reduceonly is not allowed in hedge mode', 'leverage too high', 'leverage too low',
] as const

const POSITION_CONFLICT_CODES = ['-2022'] as const
const POSITION_CONFLICT_TOKENS = [
  'reduceonly order is rejected', 'reduce-only order', 'position is not sufficient', 'position not found',
  'position does not exist',
] as const

const RISK_LIMIT_CODES = ['-2027', '-2028'] as const
const RISK_LIMIT_TOKENS = ['exceeded the maximum allowable position', 'risk limit', 'liquidate_immediately', 'in liquidation'] as const

const MARKET_UNAVAILABLE_CODES = ['-1016'] as const
const MARKET_UNAVAILABLE_TOKENS = [
  'service is shutting down', 'market is closed', 'temporarily closed for maintenance', 'contract delisted',
  'trading is currently not allowed',
] as const

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/pending_orders/error_classification.py:12-25; adapted.
/** 在常见错误字段（code / retcode / error code）里匹配码，不会命中价格与数量里的数字。 */
function hasCode(lower: string, codes: readonly string[]): boolean {
  return codes.some((code) =>
    new RegExp(`(?:s?code|retcode|error(?:\\s+code)?)\\s*['" :=-]*${escapeRegExp(code)}(?!\\d)`).test(lower),
  )
}

const hasToken = (lower: string, tokens: readonly string[]): boolean => tokens.some((token) => lower.includes(token))

export interface ClassifyInput {
  /** 原始错误文本（HTTP body 或 Error.message）。 */
  text: string
  /** 上游 JSON 里的 `code`（已解析时直接用，省一次文本匹配）。 */
  code?: number | undefined
  /** HTTP 状态码。 */
  status?: number | undefined
}

export interface Classified {
  class: BinanceErrorClass
  problem: Problem
  httpStatus: number
}

/** 按 QD 的顺序分类，并映射成协议 Problem（venue.message = 原文）。 */
export function classifyBinanceError(input: ClassifyInput): Classified {
  const raw = input.text
  const lower = raw.toLowerCase()
  const httpStatus = input.status ?? 0
  const code = input.code !== undefined ? String(input.code) : undefined
  const codeClass = input.code !== undefined ? BINANCE_ERROR_CLASSES[String(input.code) as `${number}`] : undefined

  let klass: BinanceErrorClass
  if (
    httpStatus === 401 || httpStatus === 403 ||
    codeClass === 'credentials' || (code !== undefined && AUTH_CODES.includes(code as (typeof AUTH_CODES)[number])) ||
    hasCode(lower, AUTH_CODES) || hasToken(lower, AUTH_TOKENS)
  ) {
    klass = 'credentials'
  } else if (
    codeClass === 'clock_skew' || (code !== undefined && CLOCK_SKEW_CODES.includes(code as (typeof CLOCK_SKEW_CODES)[number])) ||
    hasCode(lower, CLOCK_SKEW_CODES) || hasToken(lower, CLOCK_SKEW_TOKENS)
  ) {
    klass = 'clock_skew'
  } else if (
    httpStatus === 429 || httpStatus === 418 ||
    codeClass === 'rate_limit' || (code !== undefined && RATE_LIMIT_CODES.includes(code as (typeof RATE_LIMIT_CODES)[number])) ||
    hasCode(lower, RATE_LIMIT_CODES) || hasToken(lower, RATE_LIMIT_TOKENS)
  ) {
    klass = 'rate_limit'
  } else if (
    codeClass === 'invalid_symbol' ||
    (code !== undefined && INVALID_SYMBOL_CODES.includes(code as (typeof INVALID_SYMBOL_CODES)[number])) ||
    hasCode(lower, INVALID_SYMBOL_CODES) || hasToken(lower, INVALID_SYMBOL_TOKENS)
  ) {
    klass = 'invalid_symbol'
  } else if (httpStatus === 408 || httpStatus >= 500 || codeClass === 'transport' || hasToken(lower, TRANSPORT_TOKENS)) {
    klass = 'transport'
  } else if (
    codeClass === 'price_band' ||
    (code !== undefined && PRICE_BAND_CODES.includes(code as (typeof PRICE_BAND_CODES)[number])) ||
    hasCode(lower, PRICE_BAND_CODES) || hasToken(lower, PRICE_BAND_TOKENS)
  ) {
    klass = 'price_band'
  } else if (
    codeClass === 'insufficient_funds' ||
    (code !== undefined && INSUFFICIENT_CODES.includes(code as (typeof INSUFFICIENT_CODES)[number])) ||
    hasCode(lower, INSUFFICIENT_CODES) || hasToken(lower, INSUFFICIENT_TOKENS)
  ) {
    klass = 'insufficient_funds'
  } else if (
    codeClass === 'order_size' ||
    (code !== undefined && ORDER_SIZE_CODES.includes(code as (typeof ORDER_SIZE_CODES)[number])) ||
    hasCode(lower, ORDER_SIZE_CODES) || hasToken(lower, ORDER_SIZE_TOKENS)
  ) {
    klass = 'order_size'
  } else if (
    codeClass === 'account_configuration' ||
    (code !== undefined && ACCOUNT_CONFIG_CODES.includes(code as (typeof ACCOUNT_CONFIG_CODES)[number])) ||
    hasCode(lower, ACCOUNT_CONFIG_CODES) || hasToken(lower, ACCOUNT_CONFIG_TOKENS)
  ) {
    klass = 'account_configuration'
  } else if (
    codeClass === 'position_conflict' ||
    (code !== undefined && POSITION_CONFLICT_CODES.includes(code as (typeof POSITION_CONFLICT_CODES)[number])) ||
    hasCode(lower, POSITION_CONFLICT_CODES) || hasToken(lower, POSITION_CONFLICT_TOKENS)
  ) {
    klass = 'position_conflict'
  } else if (
    codeClass === 'risk_limit' ||
    (code !== undefined && RISK_LIMIT_CODES.includes(code as (typeof RISK_LIMIT_CODES)[number])) ||
    hasCode(lower, RISK_LIMIT_CODES) || hasToken(lower, RISK_LIMIT_TOKENS)
  ) {
    klass = 'risk_limit'
  } else if (
    codeClass === 'market_unavailable' ||
    (code !== undefined && MARKET_UNAVAILABLE_CODES.includes(code as (typeof MARKET_UNAVAILABLE_CODES)[number])) ||
    hasCode(lower, MARKET_UNAVAILABLE_CODES) || hasToken(lower, MARKET_UNAVAILABLE_TOKENS)
  ) {
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
      venue: { id: VENUE_ID, ...(input.code !== undefined ? { code: input.code } : httpStatus ? { code: httpStatus } : {}), message: raw },
    }),
  }
}

/**
 * order_size 细分：-4164 落 1003 MIN_NOTIONAL（与本包 orders.ts 下单前自检、内核 normalize 同码）；
 * 其余 order_size 原样 1002。不夹取数量，不猜最小名义额。
 */
export function refineOrderSizeProblem(problem: Problem, input: ClassifyInput): Problem {
  if (problem.code !== 1002 || input.code !== -4164) return problem
  return makeProblem('MIN_NOTIONAL', 'order notional is below the venue minimum (hint: increase size / price, or mark the order reduceOnly)', {
    retryable: false,
    venue: { id: VENUE_ID, code: input.code, message: input.text },
  })
}
