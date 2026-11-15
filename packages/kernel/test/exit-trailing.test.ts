// SPDX-License-Identifier: CPAL-1.0
import { describe, expect, it } from 'vitest'
import {
  activationPriceFor,
  chooseExit,
  initTrailing,
  pctToPrice,
  stepTrailing,
  trailingStopPrice,
} from '../src/exit/trailing'
import type { ExitHit, TrailingSpec, TrailingState } from '../src/exit/trailing'

const longSpec: TrailingSpec = {
  side: 'long',
  entryPrice: '100',
  callbackRatio: '0.02',
  activationRatio: '0.05',
  openedAt: 0,
}

describe('long trailing', () => {
  it('stays inactive below the activation price', () => {
    const state = initTrailing(longSpec)
    const next = stepTrailing(longSpec, state, '103', 1).state
    expect(next.active).toBe(false)
    expect(next.extreme).toBe('100')
  })

  it('activates at the activation price and tracks the high', () => {
    const state = stepTrailing(longSpec, initTrailing(longSpec), '105', 2).state
    expect(state.active).toBe(true)
    expect(state.extreme).toBe('105')
  })

  it('raises the extreme on a new high', () => {
    const activated = stepTrailing(longSpec, initTrailing(longSpec), '105', 2).state
    const state = stepTrailing(longSpec, activated, '110', 3).state
    expect(state.extreme).toBe('110')
    expect(trailingStopPrice(longSpec, state)).toBe('107.8')
  })

  it('does not fire above the trailing stop', () => {
    const activated = stepTrailing(longSpec, initTrailing(longSpec), '105', 2).state
    const extreme = stepTrailing(longSpec, activated, '110', 3).state
    const result = stepTrailing(longSpec, extreme, '108', 4)
    expect(result.fire).toBeUndefined()
    expect(result.state.fired).toBeUndefined()
  })

  it('fires trailing at the stop price', () => {
    const activated = stepTrailing(longSpec, initTrailing(longSpec), '105', 2).state
    const extreme = stepTrailing(longSpec, activated, '110', 3).state
    const result = stepTrailing(longSpec, extreme, '107.8', 4)
    expect(result.fire).toEqual({ reason: 'trailing', price: '107.8', ts: 4 })
    expect(result.state.fired).toEqual({ reason: 'trailing', price: '107.8', ts: 4 })
  })

  it('is idempotent after firing', () => {
    const activated = stepTrailing(longSpec, initTrailing(longSpec), '105', 2).state
    const extreme = stepTrailing(longSpec, activated, '110', 3).state
    const fired = stepTrailing(longSpec, extreme, '107.8', 4).state
    const again = stepTrailing(longSpec, fired, '90', 5)
    expect(again.fire).toBeUndefined()
    expect(again.state).toBe(fired)
  })
})

describe('short trailing', () => {
  const shortSpec: TrailingSpec = {
    side: 'short',
    entryPrice: '100',
    callbackRatio: '0.02',
    openedAt: 0,
  }

  it('activates immediately without an activation condition', () => {
    const state = initTrailing(shortSpec)
    expect(state.active).toBe(true)
    expect(state.extreme).toBe('100')
  })

  it('tracks the low and fires at the mirrored stop', () => {
    const lower = stepTrailing(shortSpec, initTrailing(shortSpec), '90', 1).state
    expect(lower.extreme).toBe('90')
    expect(trailingStopPrice(shortSpec, lower)).toBe('91.8')
    const result = stepTrailing(shortSpec, lower, '91.8', 2)
    expect(result.fire).toEqual({ reason: 'trailing', price: '91.8', ts: 2 })
  })
})

describe('exit priority', () => {
  const hit = (reason: ExitHit['reason'], price = '100'): ExitHit => ({ reason, price, ts: 1 })

  it('prefers stop_loss over trailing', () => {
    expect(chooseExit([hit('trailing'), hit('stop_loss')])?.reason).toBe('stop_loss')
  })

  it('prefers trailing over take_profit per the QD default _choose order', () => {
    // protection.py:333-334 default mode: stop_loss 0, trailing_stop 1, time_limit 2, take_profit 3.
    expect(chooseExit([hit('take_profit'), hit('trailing')])?.reason).toBe('trailing')
  })

  it('prefers stop_loss over time_limit and take_profit', () => {
    expect(chooseExit([hit('take_profit'), hit('time_limit'), hit('stop_loss')])?.reason).toBe('stop_loss')
  })

  it('returns undefined for no hits', () => {
    expect(chooseExit([])).toBeUndefined()
  })
})

describe('time limit', () => {
  const timedSpec: TrailingSpec = {
    side: 'long',
    entryPrice: '100',
    callbackRatio: '0.02',
    timeLimitMs: 60_000,
    openedAt: 0,
  }

  it('does not fire one millisecond before the limit', () => {
    const result = stepTrailing(timedSpec, initTrailing(timedSpec), '100', 59_999)
    expect(result.fire).toBeUndefined()
  })

  it('fires exactly at the limit', () => {
    const before = stepTrailing(timedSpec, initTrailing(timedSpec), '100', 59_999).state
    const result = stepTrailing(timedSpec, before, '100', 60_000)
    expect(result.fire).toEqual({ reason: 'time_limit', price: '100', ts: 60_000 })
  })
})

describe('price conversion', () => {
  it('converts long percentages to absolute prices', () => {
    expect(pctToPrice('100', 'long', '0.03', 'sl')).toBe('97')
    expect(pctToPrice('100', 'long', '0.03', 'tp')).toBe('103')
  })

  it('converts short percentages to absolute prices', () => {
    expect(pctToPrice('100', 'short', '0.03', 'sl')).toBe('103')
    expect(pctToPrice('100', 'short', '0.03', 'tp')).toBe('97')
  })

  it('computes the trailing activation price', () => {
    expect(activationPriceFor('100', 'long', '0.05')).toBe('105')
    expect(activationPriceFor('100', 'short', '0.05')).toBe('95')
  })
})

describe('validation', () => {
  it('rejects a non-positive callback ratio', () => {
    expect(() => initTrailing({ ...longSpec, callbackRatio: '0' })).toThrow(/callbackRatio/)
  })

  it('rejects a non-numeric tick price', () => {
    const state = initTrailing(longSpec)
    expect(() => stepTrailing(longSpec, state, 'abc', 1)).toThrow(/price/)
  })

  it('rejects a non-positive tick price', () => {
    const state = initTrailing(longSpec)
    expect(() => stepTrailing(longSpec, state, '0', 1)).toThrow(/price/)
  })

  it('rejects a non-positive pct', () => {
    expect(() => pctToPrice('100', 'long', '0', 'sl')).toThrow(/pct/)
  })

  it('rejects a non-positive entry price in activationPriceFor', () => {
    expect(() => activationPriceFor('0', 'long', '0.05')).toThrow(/entryPrice/)
  })
})

describe('persistence', () => {
  it('survives a JSON round trip and keeps stepping identically', () => {
    const state = stepTrailing(longSpec, initTrailing(longSpec), '105', 2).state
    const restored = JSON.parse(JSON.stringify(state)) as TrailingState
    const fromOriginal = stepTrailing(longSpec, state, '110', 3)
    const fromRestored = stepTrailing(longSpec, restored, '110', 3)
    expect(fromRestored).toEqual(fromOriginal)
    expect(fromRestored.state.extreme).toBe('110')
  })
})
