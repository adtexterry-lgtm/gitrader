// SPDX-License-Identifier: CPAL-1.0
// 错误码分类（照 QD pending_orders/error_classification.py 的顺序与码表）→ 协议 Problem + retryable 位。
import { describe, expect, it } from 'vitest'
import { BINANCE_ERROR_CLASSES, classifyBinanceError, refineOrderSizeProblem } from '../src/venue-errors'

const classify = (code: number | undefined, text = '', status?: number) =>
  classifyBinanceError({ text, ...(code !== undefined ? { code } : {}), ...(status !== undefined ? { status } : {}) })

describe('code table → protocol problems', () => {
  it('-1021 timestamp drift → clock_skew → INVALID_PARAMS, not retryable', () => {
    const { class: klass, problem } = classify(-1021, 'Timestamp for this request is outside of the recvWindow.')
    expect(klass).toBe('clock_skew')
    expect(problem.name).toBe('INVALID_PARAMS')
    expect(problem.retryable).toBe(false)
    expect(problem.venue?.message).toContain('recvWindow')
  })

  it('-2010 / -2018 / -2019 → insufficient_funds → 3004 VENUE_INSUFFICIENT_MARGIN', () => {
    for (const code of [-2010, -2018, -2019]) {
      const { class: klass, problem } = classify(code, 'Margin is insufficient.')
      expect(klass).toBe('insufficient_funds')
      expect(problem.code).toBe(3004)
      expect(problem.retryable).toBe(false)
    }
  })

  it('-4164 notional → order_size → refined to MIN_NOTIONAL 1003 with an actionable hint', () => {
    const input = { text: "Order's notional must be no smaller than 5 (unless you choose reduce only).", code: -4164 }
    const { class: klass, problem } = classifyBinanceError(input)
    expect(klass).toBe('order_size')
    expect(problem.code).toBe(1002)
    const refined = refineOrderSizeProblem(problem, input)
    expect(refined.code).toBe(1003)
    expect(refined.name).toBe('MIN_NOTIONAL')
    expect(refined.message).toContain('hint')
  })

  it('-1111 precision overflow → order_size → PRECISION (no notional refinement)', () => {
    const input = { text: 'Precision is over the maximum defined for this asset.', code: -1111 }
    const { problem } = classifyBinanceError(input)
    expect(problem.code).toBe(1002)
    expect(refineOrderSizeProblem(problem, input).code).toBe(1002)
  })

  it('-4003 (qty below minQty) and -4014 (price not on tick) are order_size too', () => {
    expect(classify(-4003, 'Quantity less than or equal to zero.').class).toBe('order_size')
    expect(classify(-4014, 'Price not increased by tick size.').class).toBe('order_size')
  })

  it('-1121 unknown symbol → 1001 INSTRUMENT_UNKNOWN', () => {
    const { class: klass, problem } = classify(-1121, 'Invalid symbol.')
    expect(klass).toBe('invalid_symbol')
    expect(problem.code).toBe(1001)
  })

  it('-1003 / -1015 → rate_limit → 3003 VENUE_UNAVAILABLE, retryable', () => {
    for (const code of [-1003, -1015]) {
      const { class: klass, problem } = classify(code, 'Too many new orders.')
      expect(klass).toBe('rate_limit')
      expect(problem.code).toBe(3003)
      expect(problem.name).toBe('VENUE_UNAVAILABLE')
      expect(problem.retryable).toBe(true)
    }
  })

  it('-2015 / -1022 → credentials → 3005 VENUE_AUTH', () => {
    for (const code of [-2015, -1022]) {
      const { class: klass, problem } = classify(code, 'Invalid API-key, IP, or permissions for action.')
      expect(klass).toBe('credentials')
      expect(problem.code).toBe(3005)
    }
  })

  it('-4061 position side mismatch → account_configuration → 3001 VENUE_REJECTED', () => {
    const { class: klass, problem } = classify(-4061, "Order's position side does not match user's setting.")
    expect(klass).toBe('account_configuration')
    expect(problem.code).toBe(3001)
  })

  it('-4131 percent price filter → price_band → 1007 PRICE_DRIFT', () => {
    const { class: klass, problem } = classify(-4131, 'Order price is higher than the maximum buying price.')
    expect(klass).toBe('price_band')
    expect(problem.code).toBe(1007)
    expect(problem.retryable).toBe(false)
  })

  it('-2022 reduceOnly rejected → position_conflict; -2027 → risk_limit', () => {
    expect(classify(-2022, 'ReduceOnly Order is rejected.').class).toBe('position_conflict')
    expect(classify(-2027, 'Exceeded the maximum allowable position at current leverage.').class).toBe('risk_limit')
  })

  it('-1016 service shutting down → market_unavailable → 3003, retryable', () => {
    const { class: klass, problem } = classify(-1016, 'Service is shutting down.')
    expect(klass).toBe('market_unavailable')
    expect(problem.code).toBe(3003)
    expect(problem.retryable).toBe(true)
  })

  it('an unknown code falls through to 3001 VENUE_REJECTED and is not retried', () => {
    const { class: klass, problem } = classify(-9999, 'something odd happened')
    expect(klass).toBe('exchange_rejected')
    expect(problem.code).toBe(3001)
    expect(problem.retryable).toBe(false)
  })
})

describe('text-only classification (no parsed code)', () => {
  it('HTTP 429 is a rate limit even without a body code', () => {
    const { class: klass } = classify(undefined, '', 429)
    expect(klass).toBe('rate_limit')
  })

  it('HTTP 401 is credentials', () => {
    expect(classify(undefined, 'Unauthorized', 401).class).toBe('credentials')
  })

  it('HTTP 5xx is transport', () => {
    const { class: klass, problem } = classify(undefined, 'bad gateway', 502)
    expect(klass).toBe('transport')
    expect(problem.code).toBe(3003)
    expect(problem.retryable).toBe(true)
  })

  it('recognises the code inside a JSON body string', () => {
    const { class: klass } = classify(undefined, '{"code":-1021,"msg":"Timestamp for this request is outside of the recvWindow."}')
    expect(klass).toBe('clock_skew')
  })

  it('recognises keyword-only rejections (insufficient margin / step size / invalid signature)', () => {
    expect(classify(undefined, 'Margin is insufficient.').class).toBe('insufficient_funds')
    expect(classify(undefined, 'Filter failure: LOT_SIZE step size').class).toBe('order_size')
    expect(classify(undefined, 'Signature for this request is not valid.').class).toBe('credentials')
    expect(classify(undefined, 'Order would immediately trigger.').class).toBe('exchange_rejected')
  })

  it('the exported table only contains known classes', () => {
    const classes = new Set(Object.values(BINANCE_ERROR_CLASSES))
    expect([...classes].sort()).toEqual([
      'account_configuration', 'clock_skew', 'credentials', 'exchange_rejected', 'insufficient_funds', 'invalid_symbol',
      'market_unavailable', 'order_size', 'position_conflict', 'price_band', 'rate_limit', 'risk_limit', 'transport',
    ])
  })
})
