// SPDX-License-Identifier: CPAL-1.0
import { describe, expect, it } from 'vitest'
import { clampLimitPrice } from '../src/limit-safety'
import { classifyVenueError } from '../src/venue-errors'
import { CircuitBreaker } from '../src/circuit-breaker'

describe('clampLimitPrice: tighten to the marketable band, never widen', () => {
  it('caps buys at ref·(1 + band) and floors sells at ref·(1 − band)', () => {
    expect(clampLimitPrice('buy', 110, 100, 500)).toEqual({ price: 105, clamped: true })
    expect(clampLimitPrice('buy', 95, 100, 500)).toEqual({ price: 95, clamped: false })
    expect(clampLimitPrice('sell', 90, 100, 500)).toEqual({ price: 95, clamped: true })
    expect(clampLimitPrice('sell', 105, 100, 500)).toEqual({ price: 105, clamped: false })
  })

  it('leaves the price untouched when the reference is non-positive or not finite', () => {
    expect(clampLimitPrice('buy', 110, 0, 500)).toEqual({ price: 110, clamped: false })
    expect(clampLimitPrice('sell', 90, Number.NaN, 500)).toEqual({ price: 90, clamped: false })
  })
})

describe('classifyVenueError: QD keyword / status rules mapped to Problem', () => {
  it('transport: ECONNRESET -> VENUE_UNAVAILABLE, retryable', () => {
    const r = classifyVenueError(new Error('ECONNRESET'))
    expect(r.class).toBe('transport')
    expect(r.problem.code).toBe(3003)
    expect(r.problem.retryable).toBe(true)
  })

  it('rate_limit: status 429 -> VENUE_UNAVAILABLE, retryable', () => {
    const r = classifyVenueError({ status: 429 })
    expect(r.class).toBe('rate_limit')
    expect(r.problem.code).toBe(3003)
    expect(r.problem.retryable).toBe(true)
  })

  it('price_band: Hyperliquid oracle text -> INVALID_PARAMS, not retryable', () => {
    const r = classifyVenueError(new Error('Price too far from oracle'))
    expect(r.class).toBe('price_band')
    expect(r.problem.code).toBe(-32602)
    expect(r.problem.retryable).toBe(false)
  })

  it('rejected: insufficient margin -> VENUE_REJECTED, not retryable', () => {
    const r = classifyVenueError(new Error('Insufficient margin'))
    expect(r.class).toBe('rejected')
    expect(r.problem.code).toBe(3001)
    expect(r.problem.retryable).toBe(false)
  })

  it('unknown: unrecognized text -> VENUE_UNAVAILABLE, not retryable', () => {
    const r = classifyVenueError(new Error('kaboom'))
    expect(r.class).toBe('unknown')
    expect(r.problem.code).toBe(3003)
    expect(r.problem.retryable).toBe(false)
  })

  it('clock_skew: out-of-window timestamp text -> INVALID_PARAMS, not retryable', () => {
    const r = classifyVenueError(new Error('Invalid timestamp: request time exceeds recvWindow'))
    expect(r.class).toBe('clock_skew')
    expect(r.problem.code).toBe(-32602)
    expect(r.problem.retryable).toBe(false)
  })

  it('clock_skew: QD code -1021 -> INVALID_PARAMS, not retryable', () => {
    const r = classifyVenueError(new Error('{"code":-1021,"msg":"timestamp outside of the recvwindow"}'))
    expect(r.class).toBe('clock_skew')
    expect(r.problem.code).toBe(-32602)
    expect(r.problem.retryable).toBe(false)
  })

  it('market_unavailable: maintenance text -> VENUE_UNAVAILABLE, retryable', () => {
    const r = classifyVenueError(new Error('market temporarily closed for maintenance'))
    expect(r.class).toBe('market_unavailable')
    expect(r.problem.code).toBe(3003)
    expect(r.problem.retryable).toBe(true)
  })
})

describe('classifyVenueError: QD tokens missing from the first pass', () => {
  it("bad_symbol -> rejected", () => {
    expect(classifyVenueError(new Error('bad_symbol')).class).toBe('rejected')
  })

  it('no security definition has been found -> rejected', () => {
    expect(classifyVenueError(new Error('No security definition has been found for the request')).class).toBe('rejected')
  })

  it('account mode -> rejected', () => {
    expect(classifyVenueError(new Error('account mode mismatch')).class).toBe('rejected')
  })

  it('hedge mode -> rejected', () => {
    expect(classifyVenueError(new Error('hedge mode is not supported')).class).toBe('rejected')
  })

  it('one-way mode -> rejected', () => {
    expect(classifyVenueError(new Error('one-way mode required')).class).toBe('rejected')
  })

  it('okx_swap_account_mode_required -> rejected', () => {
    expect(classifyVenueError(new Error('okx_swap_account_mode_required')).class).toBe('rejected')
  })
})

describe('CircuitBreaker: closed -> open -> half_open -> closed', () => {
  it('trips after 3 failures, probes once, recovers, and re-trips', () => {
    let now = 0
    const cb = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 1000, clock: () => now })

    expect(cb.state()).toBe('closed')
    cb.onFailure()
    cb.onFailure()
    expect(cb.state()).toBe('closed')
    cb.onFailure()
    expect(cb.state()).toBe('open')
    expect(cb.allow()).toBe(false)
    expect(cb.stats()).toEqual({ failures: 3, openedAt: 0, opens: 1 })

    now = 1000
    expect(cb.allow()).toBe(true)
    expect(cb.state()).toBe('half_open')
    expect(cb.allow()).toBe(false)

    cb.onSuccess()
    expect(cb.state()).toBe('closed')
    expect(cb.stats().failures).toBe(0)

    cb.onFailure()
    cb.onFailure()
    cb.onFailure()
    expect(cb.state()).toBe('open')
    expect(cb.stats().opens).toBe(2)
  })

  it('half_open failure re-opens and resets the cooldown clock', () => {
    let now = 0
    const cb = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 1000, clock: () => now })
    cb.onFailure()
    cb.onFailure()
    cb.onFailure()
    expect(cb.stats().openedAt).toBe(0)

    now = 1000
    expect(cb.allow()).toBe(true)
    expect(cb.state()).toBe('half_open')

    now = 1500
    cb.onFailure()
    expect(cb.state()).toBe('open')
    expect(cb.stats().openedAt).toBe(1500)
    expect(cb.allow()).toBe(false)
  })
})

describe('CircuitBreaker: release returns an uncertain half_open permit', () => {
  it('lets allow() through again after a half_open permit is released', () => {
    let now = 0
    const cb = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 1000, clock: () => now })
    cb.onFailure()
    cb.onFailure()
    cb.onFailure()

    now = 1000
    expect(cb.allow()).toBe(true)
    expect(cb.state()).toBe('half_open')
    expect(cb.allow()).toBe(false)

    cb.release()
    expect(cb.state()).toBe('half_open')
    expect(cb.stats()).toEqual({ failures: 3, openedAt: 0, opens: 1 })
    expect(cb.allow()).toBe(true)
    expect(cb.state()).toBe('half_open')
  })

  it('is a no-op while closed', () => {
    const cb = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 1000, clock: () => 0 })
    const before = cb.stats()
    cb.release()
    expect(cb.state()).toBe('closed')
    expect(cb.stats()).toEqual(before)
    expect(cb.allow()).toBe(true)
  })
})
