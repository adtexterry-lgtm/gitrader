// SPDX-License-Identifier: CPAL-1.0
// Bybit v5 retCode / 文案 → 稳定分类 → 协议 Problem（契约 §2.8）。
// 分类表与关键字规则照 QuantDinger 的 pending_orders/error_classification.py:31-188 搬到 TypeScript，
// **顺序、通用码表、关键字一律保持 QD 的先后**（credentials → clock_skew → rate_limit → invalid_symbol →
// transport → price_band → insufficient_funds → order_size → account_configuration → position_conflict →
// risk_limit → market_unavailable → exchange_rejected），只把 QD 里属于别家场所的码剔掉、
// 抽出 Bybit v5 的 retCode 段（110xxx / 100xx / 170xxx）。
// 认不出来的不猜：落 3001 VENUE_REJECTED 且 retryable = false（防止盲目重发下单请求）。
import { makeProblem } from '@gitrader/protocol'
import type { Problem, ProblemName } from '@gitrader/protocol'

export const VENUE_ID = 'bybit'

export type BybitErrorClass =
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
  | 'invalid_params'
  | 'exchange_rejected'

interface Mapping {
  name: ProblemName
  retryable: boolean
  summary: string
}

/** 分类 → 协议 Problem。rate_limit 落 3002（HTTP 429/418 在 errors.ts 里同一口径）。 */
const PROBLEM_FOR_CLASS: Record<BybitErrorClass, Mapping> = {
  credentials: { name: 'VENUE_AUTH', retryable: false, summary: 'venue could not authenticate the API key' },
  clock_skew: {
    name: 'INVALID_PARAMS',
    retryable: false,
    summary: 'request timestamp drifted outside recvWindow; resync the clock before resending',
  },
  rate_limit: { name: 'VENUE_RATE_LIMITED', retryable: true, summary: 'venue rate limited the request' },
  invalid_symbol: { name: 'INSTRUMENT_UNKNOWN', retryable: false, summary: 'venue does not know this symbol' },
  transport: { name: 'VENUE_UNAVAILABLE', retryable: true, summary: 'venue unreachable' },
  price_band: { name: 'PRICE_DRIFT', retryable: false, summary: 'price is outside the venue price band for this symbol' },
  insufficient_funds: { name: 'VENUE_INSUFFICIENT_MARGIN', retryable: false, summary: 'venue reports insufficient margin or balance' },
  order_size: { name: 'PRECISION', retryable: false, summary: 'order size or price violates the venue filters' },
  account_configuration: { name: 'VENUE_REJECTED', retryable: false, summary: 'venue rejected the request for the current account configuration' },
  position_conflict: { name: 'VENUE_REJECTED', retryable: false, summary: 'venue rejected the request because it conflicts with the current position' },
  risk_limit: { name: 'VENUE_REJECTED', retryable: false, summary: 'venue rejected the request because it exceeds a risk limit' },
  market_unavailable: { name: 'VENUE_UNAVAILABLE', retryable: true, summary: 'venue symbol is delisted or under maintenance' },
  invalid_params: { name: 'INVALID_PARAMS', retryable: false, summary: 'venue rejected the request parameters' },
  exchange_rejected: { name: 'VENUE_REJECTED', retryable: false, summary: 'venue rejected the request' },
}

/**
 * Bybit v5 retCode → 分类（只列本连接器会碰到的；码值照官方 v5 错误码表与 QD 的通用段）。
 * 110043（leverage not modified）调用点视为成功；110036（全仓下不允许改杠杆）是失败。
 */
export const BYBIT_ERROR_CLASSES: Record<number, BybitErrorClass> = {
  // credentials / 权限
  10003: 'credentials', // API key is invalid
  10004: 'credentials', // error sign
  10005: 'credentials', // permission denied（key 没开这个权限）
  10007: 'credentials', // user not found / uid 不匹配
  10010: 'credentials', // ip not in whitelist
  33004: 'credentials', // api key has expired（旧版 spot 码，保留兼容）
  // 时钟
  10002: 'clock_skew', // timestamp outside recvWindow
  // 限流
  10006: 'rate_limit', // too many visits
  10018: 'rate_limit', // access too frequent
  10429: 'rate_limit',
  20003: 'rate_limit',
  50011: 'rate_limit',
  // 标的
  10029: 'invalid_symbol',
  // 服务端 / 传输
  10000: 'transport', // server error（结果未知，rest.ts 会按 3006 处理）
  10016: 'market_unavailable', // service is restarting
  10019: 'market_unavailable', // settlement in progress
  110063: 'market_unavailable', // settlement in progress / 结算中暂停交易
  110066: 'market_unavailable', // contract delisted
  110074: 'market_unavailable', // contract not online yet（合约未上线）
  // 价格带
  110003: 'price_band',
  110120: 'price_band',
  110121: 'price_band',
  170193: 'price_band',
  // 资金
  110004: 'insufficient_funds',
  110006: 'insufficient_funds',
  110007: 'insufficient_funds',
  110012: 'insufficient_funds',
  110044: 'insufficient_funds',
  110045: 'insufficient_funds',
  110051: 'insufficient_funds',
  110052: 'insufficient_funds',
  110053: 'insufficient_funds',
  170131: 'insufficient_funds',
  // 数量 / 精度
  110017: 'order_size',
  110094: 'order_size', // qty 小于 minOrderQty
  // 账户配置（持仓模式 / 保证金模式 / 杠杆）
  110015: 'account_configuration', // position mode 不匹配
  110024: 'account_configuration', // 有持仓不能切持仓模式
  110025: 'account_configuration', // 持仓模式未变
  110026: 'account_configuration', // 保证金模式未变（调用点视为成功）
  110028: 'account_configuration',
  110029: 'account_configuration',
  110036: 'account_configuration', // 全仓下不允许改杠杆
  110043: 'account_configuration', // leverage not modified（调用点视为成功）
  110073: 'account_configuration',
  // 持仓冲突（reduce-only / closeOnTrigger 打不出去）
  110005: 'position_conflict',
  110008: 'position_conflict',
  110010: 'position_conflict',
  110034: 'position_conflict',
  // 风险限额
  110011: 'risk_limit',
  110013: 'risk_limit',
  110039: 'risk_limit',
  110040: 'risk_limit',
  110046: 'risk_limit',
  110089: 'risk_limit',
  110090: 'risk_limit',
  // 同号订单已在场上（多半是上次 3006 的那次落地了；调用点按 clientOrderId 对账）
  110072: 'exchange_rejected',
}

const AUTH_CODES = ['10003', '10004', '10005', '10007', '10010', '33004'] as const
const AUTH_TOKENS = [
  'invalid api-key', 'invalid api key', 'api key is invalid', 'api-key format invalid', 'api key has expired',
  'permission denied', 'invalid signature', 'error sign', 'user authentication failed', 'unmatched ip',
  'invalid ip', 'ip whitelist', 'ip not whitelisted', 'unauthorized',
] as const

const CLOCK_SKEW_CODES = ['10002'] as const
const CLOCK_SKEW_TOKENS = [
  'invalid timestamp', 'timestamp for this request', 'request time exceeds', 'outside of the recvwindow',
  'timestamp request expired', 'time window',
] as const

const RATE_LIMIT_CODES = ['10006', '10018', '10429', '20003', '50011'] as const
const RATE_LIMIT_TOKENS = [
  'too many visits', 'too many requests', 'too many request', 'rate limit', 'rate_limit',
  'request_frequency', 'operation too frequent', 'max rate of messages', 'access too frequent',
] as const

const INVALID_SYMBOL_CODES = ['10029'] as const
const INVALID_SYMBOL_TOKENS = [
  'invalid symbol', 'bad_symbol', 'symbol is invalid', 'symbol not found', 'contract_not_found',
  'trading pair does not exist', 'symbol has been delisted',
] as const

const TRANSPORT_TOKENS = [
  'connection reset', 'econnreset', 'econnrefused', 'etimedout', 'eai_again', 'enotfound', 'epipe',
  'socket hang up', 'network error', 'fetch failed', 'connection aborted', 'connection closed',
  'connection timed out', 'timeout waiting for response', 'timed out', 'bad gateway', 'gateway timeout',
  'service unavailable', 'temporarily unavailable', 'server error',
] as const

const PRICE_BAND_CODES = ['110003', '110120', '110121', '170193'] as const
const PRICE_BAND_TOKENS = [
  'highest price limit for the buy leg', 'lowest price limit for the sell leg',
  'price exceeds the allowable range', 'price is higher than the maximum', 'price is lower than the minimum',
  'trading price cannot be below', 'trading price cannot exceed', 'order price exceeds the maximum price limit',
  'order price is higher than the maximum buying price', 'order price is lower than the minimum selling price',
  'price_too_deviated', 'order price deviates too much from mark price', 'outside the price band',
  'outside price band', 'exceeds price limit',
] as const

const INSUFFICIENT_CODES = ['110004', '110006', '110007', '110012', '110044', '110045', '110051', '110052', '110053', '170131'] as const
const INSUFFICIENT_TOKENS = [
  'insufficient_available', 'insufficient balance', 'insufficient margin', 'insufficient buying power',
  'not enough balance', 'margin insufficient', 'balance_not_enough', 'balance is not enough',
  'margin while available', 'ab not enough for new order',
] as const

const ORDER_SIZE_CODES = ['110017', '110094'] as const
const ORDER_SIZE_TOKENS = [
  'step size', 'minqty', 'min qty', 'minsize', 'min size', 'min_notional', 'minnotional',
  'invalid qty', 'invalid quantity', 'invalid size', 'invalid amount', 'bad precision', 'too many decimals',
  'minimum price variation', 'order size', 'qty is too small', 'qty invalid',
] as const

const ACCOUNT_CONFIG_CODES = ['110015', '110024', '110025', '110026', '110028', '110029', '110036', '110043', '110073'] as const
const ACCOUNT_CONFIG_TOKENS = [
  'position mode', 'margin mode', 'account mode', 'hedge mode', 'one-way mode',
  'leverage too high', 'leverage too low', 'leverage not modified', 'position idx not match',
] as const

const POSITION_CONFLICT_CODES = ['110005', '110008', '110010', '110034'] as const
const POSITION_CONFLICT_TOKENS = [
  'reduceonly order is rejected', 'reduce-only order', 'reduce only', 'position not sufficient',
  'position_empty', 'position not found', 'position does not exist', 'position side does not match',
  'position is zero', 'no position',
] as const

const RISK_LIMIT_CODES = ['110011', '110013', '110039', '110040', '110046', '110089', '110090'] as const
const RISK_LIMIT_TOKENS = [
  'risk_limit_exceeded', 'liquidate_immediately', 'in liquidation', 'trigger a forced liquidation',
  'exceeds the maximum risk limit', 'risk limit',
] as const

const MARKET_UNAVAILABLE_CODES = ['10016', '10019', '110063', '110066', '110074'] as const
const MARKET_UNAVAILABLE_TOKENS = [
  'service is restarting', 'settlement in progress', 'temporarily closed for maintenance',
  'contract delisted', 'trading is currently not allowed', 'market is closed', 'service is shutting down',
] as const

const INVALID_PARAMS_CODES = ['10001'] as const
const INVALID_PARAMS_TOKENS = ['params error', 'params is invalid', 'param error', 'invalid param', 'illegal param'] as const

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
  /** 上游信封里的 retCode（已解析时直接用，省一次文本匹配）。 */
  retCode?: number | undefined
  /** HTTP 状态码。 */
  httpStatus?: number | undefined
}

export interface Classified {
  class: BybitErrorClass
  problem: Problem
  httpStatus: number
}

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/pending_orders/error_classification.py:85-188; adapted.
/** 按 QD 的顺序分类，并映射成协议 Problem（venue.message = 原文）。 */
export function classifyBybitError(input: ClassifyInput): Classified {
  const raw = input.text
  const lower = raw.toLowerCase()
  const httpStatus = input.httpStatus ?? 0
  const code = input.retCode !== undefined ? String(input.retCode) : undefined
  const codeClass = input.retCode !== undefined ? BYBIT_ERROR_CLASSES[input.retCode] : undefined

  let klass: BybitErrorClass
  if (
    httpStatus === 401 ||
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
  } else if (httpStatus >= 500 || codeClass === 'transport' || hasToken(lower, TRANSPORT_TOKENS)) {
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
  } else if (
    code === '10001' || hasCode(lower, INVALID_PARAMS_CODES) || hasToken(lower, INVALID_PARAMS_TOKENS)
  ) {
    // Bybit 的 10001「params error」：参数形状问题，不是场所拒单；落在 1001（INVALID_PARAMS）更准确。
    klass = 'invalid_params'
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
        ...(input.retCode !== undefined ? { code: input.retCode } : httpStatus ? { code: httpStatus } : {}),
        message: raw,
      },
    }),
  }
}
