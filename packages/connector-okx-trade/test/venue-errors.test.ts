// SPDX-License-Identifier: CPAL-1.0
// 错误码分类（全离线）：OKX v5 码 → 稳定分类 → 协议 Problem + retryable 位；认不出来不猜。
import { describe, expect, it } from 'vitest'
import {
  classifyOkxError, isRateLimitCode, isUnknownOutcomeCode, OKX_ERROR_CLASSES, refineOrderSizeProblem,
} from '../src/venue-errors'

describe('code table', () => {
  const cases: Array<[number, string]> = [
    [50111, 'credentials'],
    [50113, 'credentials'],
    [50120, 'credentials'],
    [50105, 'credentials'],
    [50102, 'clock_skew'],
    [50112, 'clock_skew'],
    [50011, 'rate_limit'],
    [51001, 'invalid_instrument'],
    [50001, 'transport'],
    [51006, 'price_band'],
    [51024, 'exchange_rejected'],
    [51025, 'risk_limit'],
    [51203, 'risk_limit'],
    [51008, 'insufficient_funds'],
    [51119, 'insufficient_funds'],
    [51150, 'order_size'],
    [51121, 'order_size'],
    [51000, 'order_size'],
    [51200, 'order_size'],
    [51004, 'account_configuration'],
    [59001, 'account_configuration'],
    [51023, 'position_conflict'],
    [51169, 'position_conflict'],
    [51011, 'risk_limit'],
    [51009, 'exchange_rejected'],
    [51117, 'risk_limit'],
    [51016, 'exchange_rejected'],
    [51400, 'exchange_rejected'],
    [51503, 'exchange_rejected'],
    [50000, 'exchange_rejected'],
    [50121, 'credentials'],
  ]

  for (const [code, expected] of cases) {
    it(`${code} classifies as ${expected}`, () => {
      const out = classifyOkxError({ text: 'upstream says no', code })
      expect(out.class).toBe(expected)
    })
  }

  it('exposes the outcome-unknown and rate-limit predicates from the table', () => {
    expect(isUnknownOutcomeCode('50004')).toBe(true)
    expect(isUnknownOutcomeCode(50004)).toBe(true)
    expect(isUnknownOutcomeCode('51008')).toBe(false)
    expect(isRateLimitCode('50011')).toBe(true)
    expect(isRateLimitCode('51603')).toBe(false)
  })

  it('the table only holds known OKX classes', () => {
    const allowed = new Set([
      'credentials', 'clock_skew', 'rate_limit', 'invalid_instrument', 'transport', 'price_band',
      'insufficient_funds', 'order_size', 'account_configuration', 'position_conflict', 'risk_limit',
      'market_unavailable', 'exchange_rejected',
    ])
    for (const value of Object.values(OKX_ERROR_CLASSES)) expect(allowed.has(value)).toBe(true)
  })
})

describe('problem mapping', () => {
  it('credentials → 3005 VENUE_AUTH, not retryable', () => {
    const { problem } = classifyOkxError({ text: 'Invalid API Key', code: 50111 })
    expect(problem).toMatchObject({ code: 3005, name: 'VENUE_AUTH', retryable: false, category: 'VENUE' })
    expect(problem.venue).toEqual({ id: 'okx', code: 50111, message: 'Invalid API Key' })
  })

  it('clock skew → INVALID_PARAMS with a resync hint', () => {
    const { problem } = classifyOkxError({ text: 'Timestamp request expired', code: 50112 })
    expect(problem.name).toBe('INVALID_PARAMS')
    expect(problem.message).toMatch(/resync/)
  })

  it('rate limit → 3002 VENUE_RATE_LIMITED, retryable', () => {
    const { problem } = classifyOkxError({ text: 'Too Many Requests', code: 50011 })
    expect(problem).toMatchObject({ code: 3002, retryable: true })
  })

  it('HTTP 429 counts as a rate limit even without a code', () => {
    expect(classifyOkxError({ text: 'slow down', status: 429 }).class).toBe('rate_limit')
  })

  it('HTTP 401 / 403 count as credentials even without a code', () => {
    expect(classifyOkxError({ text: 'nope', status: 401 }).class).toBe('credentials')
    expect(classifyOkxError({ text: 'nope', status: 403 }).class).toBe('credentials')
  })

  it('insufficient margin → 3004', () => {
    const { problem } = classifyOkxError({ text: 'Insufficient balance', code: 51008 })
    expect(problem.code).toBe(3004)
    expect(problem.retryable).toBe(false)
  })

  it('order size → 1002 PRECISION', () => {
    expect(classifyOkxError({ text: 'Order amount is too small', code: 51200 }).problem.code).toBe(1002)
  })

  it('unknown codes fall back to 3001 and are never retryable', () => {
    const { problem, class: klass } = classifyOkxError({ text: 'something odd happened', code: 59999 })
    expect(klass).toBe('exchange_rejected')
    expect(problem).toMatchObject({ code: 3001, name: 'VENUE_REJECTED', retryable: false })
  })

  it('HTTP 5xx counts as transport (retryable 3003)', () => {
    const { problem } = classifyOkxError({ text: 'boom', status: 502 })
    expect(problem).toMatchObject({ code: 3003, retryable: true })
  })

  it('keyword fallbacks work without a numeric code', () => {
    expect(classifyOkxError({ text: 'apikey does not exist' }).class).toBe('credentials')
    expect(classifyOkxError({ text: 'instrument id does not exist' }).class).toBe('invalid_instrument')
    expect(classifyOkxError({ text: 'price should be higher than the minimum' }).class).toBe('price_band')
    expect(classifyOkxError({ text: 'trading is not open for this instrument' }).class).toBe('market_unavailable')
    expect(classifyOkxError({ text: 'no position to close' }).class).toBe('position_conflict')
  })

  it('the venue segment keeps the upstream wording untouched', () => {
    const { problem } = classifyOkxError({ text: 'Order amount is too small (minSz 1)', code: 51200 })
    expect(problem.venue?.message).toBe('Order amount is too small (minSz 1)')
  })
})

describe('order-size refinement', () => {
  it('promotes a notional error to 1003 MIN_NOTIONAL', () => {
    const base = classifyOkxError({ text: 'minimum order amount is 5 USDT', code: 51200 }).problem
    expect(refineOrderSizeProblem(base, { text: 'minimum order amount is 5 USDT' }).code).toBe(1003)
  })

  it('leaves a plain size error as PRECISION', () => {
    const base = classifyOkxError({ text: 'size must be a multiple of the lot size', code: 51200 }).problem
    expect(refineOrderSizeProblem(base, { text: 'size must be a multiple of the lot size' }).code).toBe(1002)
  })

  it('is a no-op for problems that are not PRECISION', () => {
    const auth = classifyOkxError({ text: 'Invalid API Key', code: 50111 }).problem
    expect(refineOrderSizeProblem(auth, { text: 'Invalid API Key' })).toBe(auth)
  })
})
