// SPDX-License-Identifier: CPAL-1.0
// Alpaca 上游报错 → 协议 Problem 的分类表（契约 §2.8）。只按**上游原文 + HTTP 状态**判，不猜。
// Alpaca 的错误体是 `{ code: <number>, message: string }`（Trading API v2 官方错误表），
// 有些错误只有 HTTP 状态没有 code（例如 429、405），所以两条线索都用。
// 分类底线：
//   · 认不出来 → 3001 VENUE_REJECTED（不往 3006 塞；3006 只给「改变状态的请求没拿到结果」）；
//   · 「结果未知」类文本只在非 GET 上成立（见 rest.ts）——本表只给判定函数，不决定重试语义。
import { makeProblem } from '@gitrader/protocol'
import type { Problem } from '@gitrader/protocol'
import { VENUE_ID } from './constants'

/** 上游说「结果未知」的文本（非 GET 上 → 3006，不盲目重发）。 */
export const AMBIGUOUS_TOKENS = [
  'internal server error', 'internal error', 'service unavailable', 'gateway timeout', 'try again',
  'temporarily unavailable', 'unknown error', 'timeout', 'bad gateway', 'please retry',
]

/** 查不到这张单（不是故障）：`GET /v2/orders/{id}` 的 404 / 40410000，文本 "order not found"。 */
export const UNKNOWN_ORDER_TOKENS = ['order not found', 'not found', 'no such order', 'order does not exist']

/** 市场关着 / 该标的已停牌（Alpaca 会回 403「market is closed」之类）。 */
export const MARKET_CLOSED_TOKENS = ['market is closed', 'market closed', 'not open for trading', 'outside of regular trading hours']

/** 买力 / 可卖数量不足（Alpaca 40310000 及 friends）。 */
export const INSUFFICIENT_TOKENS = ['insufficient qty', 'insufficient buying power', 'insufficient balance', 'insufficient position']

/** 做空受限。 */
export const SHORT_BLOCKED_TOKENS = ['short', 'not shortable', 'easy to borrow']

/** 鉴权类文本（HTTP 401 / 403 之外的补充线索）。 */
export const AUTH_TOKENS = ['not authorized', 'unauthorized', 'forbidden', 'invalid api key', 'access key', 'authentication']

export type AlpacaErrorClass =
  | 'rate_limited'
  | 'auth'
  | 'unknown_order'
  | 'market_closed'
  | 'insufficient'
  | 'short_blocked'
  | 'ambiguous'
  | 'rejected'

export interface ClassifyInput {
  /** HTTP 状态（信封可能随 4xx 一起回来）。 */
  status: number
  /** 上游 code（数字或字符串；Alpaca 是数字，例如 40310000）。 */
  code?: string | number
  /** 上游原文（`code + message` 拼起来也接受）。 */
  text: string
  /** 该请求是否改变状态（非 GET）；只有这种请求上的 ambiguous 才是「结果未知」。 */
  mutating?: boolean
}

export interface Classified {
  problem: Problem
  klass: AlpacaErrorClass
  /** true = 改变状态的请求拿到「执行状态未知」→ 3006（不可重试）。 */
  outcomeUnknown: boolean
  /** true = 只是「没有这张单」，按 found=false 处理，不当故障。 */
  unknownOrder: boolean
}

const lower = (s: string): string => s.toLowerCase()
const hasAny = (text: string, tokens: readonly string[]): boolean => tokens.some((t) => text.includes(t))

/** Alpaca 的错误码（官方错误表里与本连接器有关的那几条；没列的一律按文本 + 状态判）。 */
export const ALPACA_ERROR_CODES = {
  /** 请求未授权（key / secret 不对，或 paper 的 key 打 live 基址）。 */
  UNAUTHORIZED: 40110000,
  /** 持仓 / 可卖数量不足。 */
  INSUFFICIENT_QTY: 40310000,
  /** 账户被禁止交易。 */
  ACCOUNT_NOT_TRADEABLE: 40310000,
  /** 订单不存在。 */
  ORDER_NOT_FOUND: 40410000,
  /** 参数校验失败。 */
  VALIDATION: 42210000,
} as const

function venueOf(code: string | number | undefined, text: string): { id: string; code?: string | number; message: string } {
  return code === undefined ? { id: VENUE_ID, message: text } : { id: VENUE_ID, code, message: text }
}

/** 状态 + 原文 → 分类与 Problem。 */
export function classifyAlpacaError(input: ClassifyInput): Classified {
  const text = lower(input.text)
  const status = input.status
  const mutating = input.mutating === true
  const numeric = typeof input.code === 'number' ? input.code : Number(input.code)

  const rejected = (message: string, extra: Partial<Problem> = {}): Classified => ({
    problem: makeProblem('VENUE_REJECTED', message, { venue: venueOf(input.code, input.text), ...extra }),
    klass: 'rejected',
    outcomeUnknown: false,
    unknownOrder: false,
  })

  if (status === 429 || hasAny(text, ['too many requests', 'rate limit exceeded'])) {
    return {
      problem: makeProblem('VENUE_UNAVAILABLE', 'venue rate limited the request', {
        retryable: true,
        venue: venueOf(input.code ?? status, input.text),
      }),
      klass: 'rate_limited',
      outcomeUnknown: false,
      unknownOrder: false,
    }
  }

  if (status === 404 || numeric === ALPACA_ERROR_CODES.ORDER_NOT_FOUND || hasAny(text, UNKNOWN_ORDER_TOKENS)) {
    return {
      problem: makeProblem('VENUE_REJECTED', 'order not found at the venue', { venue: venueOf(input.code ?? status, input.text) }),
      klass: 'unknown_order',
      outcomeUnknown: false,
      unknownOrder: true,
    }
  }

  if (hasAny(text, MARKET_CLOSED_TOKENS)) {
    return {
      problem: makeProblem('VENUE_REJECTED', 'venue refused the order because the market is closed for that order type', {
        venue: venueOf(input.code, input.text),
      }),
      klass: 'market_closed',
      outcomeUnknown: false,
      unknownOrder: false,
    }
  }

  if (hasAny(text, INSUFFICIENT_TOKENS)) {
    return {
      problem: makeProblem('VENUE_INSUFFICIENT_MARGIN', 'venue reports insufficient buying power or available quantity', {
        venue: venueOf(input.code, input.text),
      }),
      klass: 'insufficient',
      outcomeUnknown: false,
      unknownOrder: false,
    }
  }

  if (status === 401 || status === 403) {
    // 403 也可能是「账户被冻结」而不是凭据问题：文本里带 auth 线索才归 VENUE_AUTH。
    if (status === 401 || hasAny(text, AUTH_TOKENS)) {
      return {
        problem: makeProblem('VENUE_AUTH', 'venue rejected the API key / secret pair', {
          venue: venueOf(input.code ?? status, input.text),
        }),
        klass: 'auth',
        outcomeUnknown: false,
        unknownOrder: false,
      }
    }
  }

  if (mutating && (status === 408 || status >= 500 || hasAny(text, AMBIGUOUS_TOKENS))) {
    return {
      problem: makeProblem('VENUE_OUTCOME_UNKNOWN', 'venue error after the request was sent; query by client_order_id before retrying', {
        venue: venueOf(input.code ?? status, input.text),
      }),
      klass: 'ambiguous',
      outcomeUnknown: true,
      unknownOrder: false,
    }
  }

  return rejected('venue rejected the request')
}

/** 只读判定：查单时的「没有这张单」。 */
export function isUnknownOrderError(problem: Problem): boolean {
  const message = lower(problem.venue?.message ?? problem.message)
  const code = problem.venue?.code
  return code === 404 || code === '404' || code === ALPACA_ERROR_CODES.ORDER_NOT_FOUND
    || (lower(problem.message).includes('not found') || hasAny(message, UNKNOWN_ORDER_TOKENS))
}

/** 429 的退避判定（rest.ts 用）。 */
export function isRateLimited(problem: Problem): boolean {
  return problem.code === 3002 || problem.code === 3003
}

/** 市场关闭（供 trading 把 VENUE_REJECTED 换成带 hint 的 INVALID_PARAMS 不再重试）。 */
export function isMarketClosedError(problem: Problem): boolean {
  return hasAny(lower(problem.venue?.message ?? problem.message), MARKET_CLOSED_TOKENS)
}

/** 买力不足。 */
export function isInsufficientError(problem: Problem): boolean {
  return problem.code === 3004
}
