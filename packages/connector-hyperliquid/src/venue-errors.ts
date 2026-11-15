// SPDX-License-Identifier: CPAL-1.0
// 上游报错分类（从 classify.ts 抽出，classify.ts 只留标的分类）：
// QD 的关键字 / 状态码规则表，补上 Hyperliquid 常见文案。
import { makeProblem } from '@gitrader/protocol'
import type { Problem, ProblemName } from '@gitrader/protocol'

const VENUE_ID = 'hyperliquid'

export type VenueErrorClass =
  | 'transport'
  | 'rate_limit'
  | 'price_band'
  | 'rejected'
  | 'auth'
  | 'clock_skew'
  | 'market_unavailable'
  | 'unknown'

const PROBLEM_FOR_CLASS: Record<VenueErrorClass, { name: ProblemName; retryable: boolean; summary: string }> = {
  transport: { name: 'VENUE_UNAVAILABLE', retryable: true, summary: 'venue unreachable' },
  rate_limit: { name: 'VENUE_UNAVAILABLE', retryable: true, summary: 'venue rate limited the request' },
  price_band: { name: 'INVALID_PARAMS', retryable: false, summary: 'limit price is outside the venue price band' },
  rejected: { name: 'VENUE_REJECTED', retryable: false, summary: 'venue rejected the request' },
  auth: { name: 'VENUE_AUTH', retryable: false, summary: 'venue could not authenticate the request' },
  clock_skew: {
    name: 'INVALID_PARAMS',
    retryable: false,
    summary: 'request timestamp drifted outside the venue window; sync the clock before resending',
  },
  market_unavailable: { name: 'VENUE_UNAVAILABLE', retryable: true, summary: 'venue market is closed or under maintenance' },
  // 3003 表默认 retryable=true，这里覆写为 false：无法归类的拒单不重试（WI-9）。
  unknown: { name: 'VENUE_UNAVAILABLE', retryable: false, summary: 'venue failure could not be classified' },
}

const AUTH_CODES = [
  '-1002', '-1022', '-2014', '-2015', '10003', '10004', '10005', '10007', '10010',
  '33004', '50103', '50104', '50105', '50106', '40002', '40003', '40005', '40009', '40018',
] as const
const AUTH_TOKENS = [
  'invalid api-key', 'invalid api key', 'api key is invalid', 'api-key format invalid', 'api key has expired',
  'permission denied', 'invalid signature', 'error sign', 'user authentication failed', 'unmatched ip',
  'invalid ip', 'ip whitelist', 'ip not whitelisted', 'not_login', 'unauthorized', 'user or api wallet',
  'api wallet', 'authentication failed',
] as const

const CLOCK_SKEW_CODES = ['-1021', '10002', '50102'] as const
const CLOCK_SKEW_TOKENS = [
  'invalid timestamp', 'request time exceeds', 'outside of the recvwindow', 'timestamp request expired',
] as const

const RATE_LIMIT_CODES = ['-1003', '-1008', '-1015', '10006', '10429', '20003', '50011'] as const
const RATE_LIMIT_TOKENS = [
  'rate limit', 'rate_limit', 'too many request', 'too many visits', 'request_frequency',
  'operation too frequent', 'max rate of messages',
] as const

const TRANSPORT_TOKENS = [
  'connection reset', 'econnreset', 'econnrefused', 'etimedout', 'eai_again', 'enotfound', 'epipe',
  'socket hang up', 'network error', 'network request failed', 'fetch failed', 'connection aborted',
  'connection closed', 'connection timed out', 'timeout waiting for response', 'timed out',
  'bad gateway', 'gateway timeout', 'service unavailable', 'temporarily unavailable',
] as const

const PRICE_BAND_CODES = [
  '51137', '51138', '-4016', '-4024', '110003', '30208', '30209', '110120', '110121', '25205',
  '25206', '22047',
] as const
const PRICE_BAND_TOKENS = [
  'highest price limit for the buy leg', 'lowest price limit for the sell leg',
  'price exceeds the allowable range', 'price is higher than the maximum', 'price is lower than the minimum',
  'price higher than multiplier up', 'price lower than multiplier down',
  'price_highter_than_multiplier_up', 'price_lower_than_multiplier_down',
  'filter failure: percent_price', 'filter failure: percent_price_by_side',
  'trading price cannot be below', 'trading price cannot exceed',
  'order price exceeds the maximum price limit', 'order price is higher than the maximum buying price',
  'order price is lower than the minimum selling price', 'order price cannot be smaller than',
  'order price cannot be higher than', 'price_too_deviated',
  'order price deviates too much from mark price', 'outside the price band', 'outside price band',
  'exceeds price limit', 'price too far from oracle', 'price is too far from oracle',
]

const REJECTED_CODES = [
  '-2018', '-2019', '110004', '110006', '110007', '110012', '110044', '110045', '110051', '110052',
  '110053', '51008', '25202', '25203', '40310000', '-1111', '-4003', '-4004', '-4005', '110017',
  '110094', '25207', '25208', '110', '140', '434', '51010', '10008', '110015', '110024', '110025',
  '110026', '110028', '110029', '110036', '110038', '110073', '25009', '25010', '-2022', '-2024',
  '110005', '110008', '110010', '110034', '-2023', '-2027', '-2028', '110011', '110013', '110039',
  '110040', '110046', '110089', '110090', '-1121', '10029', '25100',
] as const
const REJECTED_TOKENS = [
  'insufficient_available', 'insufficient balance', 'insufficient margin', 'insufficient buying power',
  'not enough balance', 'margin insufficient', 'balance_not_enough', 'balance is not enough',
  'margin while available', 'minimum value', 'step size', 'minqty', 'min qty', 'minsize', 'min size',
  'min_notional', 'minnotional', 'invalid qty', 'invalid quantity', 'invalid size', 'invalid amount',
  'bad precision', 'too many decimals', 'minimum price variation', 'order size',
  'reduceonly order is rejected', 'reduce-only order', 'reduce only', 'position not sufficient',
  'position_empty', 'position not found', 'position does not exist', 'position side does not match',
  'risk_limit_exceeded', 'liquidate_immediately', 'in liquidation', 'trigger a forced liquidation',
  'exceeds the maximum risk limit', 'leverage too high', 'leverage too low', 'margin mode', 'position mode',
  'post only', 'post-only', 'would immediately match', 'order rejected', 'invalid order',
  'unknown asset', 'asset not found', 'invalid symbol', 'bad_symbol', 'contract_not_found',
  'trading pair does not exist', 'symbol is invalid', 'no security definition has been found',
  'account mode', 'hedge mode', 'one-way mode', 'okx_swap_account_mode_required',
]

const MARKET_UNAVAILABLE_CODES = [
  '-1016', '10016', '10019', '110063', '110066', '25101', '25102', '25104',
] as const
const MARKET_UNAVAILABLE_TOKENS = [
  'service is restarting', 'settlement in progress', 'temporarily closed for maintenance',
  'contract delisted', 'trading is currently not allowed', 'market is closed',
] as const

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function hasCode(lower: string, codes: readonly string[]): boolean {
  return codes.some((code) =>
    new RegExp(`(?:s?code|retcode|error(?:\\s+code)?)\\s*['" :=-]*${escapeRegExp(code)}(?!\\d)`).test(lower),
  )
}

const hasToken = (lower: string, tokens: readonly string[]): boolean => tokens.some((token) => lower.includes(token))

function rawMessage(err: unknown): string {
  if (typeof err === 'string') return err
  if (err instanceof Error) {
    const body = (err as { body?: unknown }).body
    return typeof body === 'string' && body.length > 0 ? body : err.message
  }
  if (err !== null && typeof err === 'object') {
    const o = err as Record<string, unknown>
    for (const key of ['message', 'body', 'error', 'msg', 'reason'] as const) {
      const value = o[key]
      if (typeof value === 'string' && value.length > 0) return value
    }
    try {
      return JSON.stringify(err)
    } catch {
      return String(err)
    }
  }
  return String(err)
}

function statusOf(err: unknown, ctx: { status?: number } | undefined, raw: string): number | undefined {
  if (ctx?.status !== undefined) return ctx.status
  if (err !== null && typeof err === 'object') {
    const status = (err as { status?: unknown }).status
    if (typeof status === 'number') return status
  }
  const http = /\bhttp\s+(\d{3})\b/i.exec(raw)
  if (http?.[1] !== undefined) return Number(http[1])
  const gateway = /\b(5\d{2})\s+(?:bad gateway|gateway timeout|service unavailable)\b/i.exec(raw)
  if (gateway?.[1] !== undefined) return Number(gateway[1])
  return undefined
}

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/pending_orders/error_classification.py:1-200; adapted.
/** 按 QD 的关键字 / 状态码规则分类，并映射成协议 Problem。 */
export function classifyVenueError(err: unknown, ctx?: { status?: number }): { class: VenueErrorClass; problem: Problem } {
  const raw = rawMessage(err)
  const lower = raw.toLowerCase()
  const status = statusOf(err, ctx, raw)

  let category: VenueErrorClass
  if (status === 401 || status === 403 || hasCode(lower, AUTH_CODES) || hasToken(lower, AUTH_TOKENS)) {
    category = 'auth'
  } else if (hasCode(lower, CLOCK_SKEW_CODES) || hasToken(lower, CLOCK_SKEW_TOKENS)) {
    category = 'clock_skew'
  } else if (status === 429 || hasCode(lower, RATE_LIMIT_CODES) || hasToken(lower, RATE_LIMIT_TOKENS)) {
    category = 'rate_limit'
  } else if ((status !== undefined && status >= 500) || hasToken(lower, TRANSPORT_TOKENS)) {
    category = 'transport'
  } else if (hasCode(lower, PRICE_BAND_CODES) || hasToken(lower, PRICE_BAND_TOKENS)) {
    category = 'price_band'
  } else if (hasCode(lower, REJECTED_CODES) || hasToken(lower, REJECTED_TOKENS)) {
    category = 'rejected'
  } else if (hasCode(lower, MARKET_UNAVAILABLE_CODES) || hasToken(lower, MARKET_UNAVAILABLE_TOKENS)) {
    category = 'market_unavailable'
  } else {
    category = 'unknown'
  }

  const mapped = PROBLEM_FOR_CLASS[category]
  const problem = makeProblem(mapped.name, mapped.summary, {
    retryable: mapped.retryable,
    venue: { id: VENUE_ID, message: raw },
  })
  return { class: category, problem }
}
