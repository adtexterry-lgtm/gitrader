// SPDX-License-Identifier: CPAL-1.0
import { describe, expect, it } from 'vitest'
import { isTighteningLimits } from '../src/model-risk'

describe('P2-3 UI tightening route', () => {
  it('requires all changed fields to tighten and fails closed for unknown fields', () => {
    const current = { maxOrderNotional: '100', maxLeverage: 5 }
    expect(isTighteningLimits({ maxOrderNotional: '90', maxLeverage: 4 }, current)).toBe(true)
    expect(isTighteningLimits({ maxOrderNotional: '90', maxLeverage: 6 }, current)).toBe(false)
    expect(isTighteningLimits({ maxOrderNotional: '100' }, current)).toBe(false)
    expect(isTighteningLimits({ unknown: 1 }, current)).toBe(false)
    expect(isTighteningLimits({ maxOrderNotional: '50' }, {})).toBe(true)
  })
  it('does not round reconciliation-grade decimal strings when choosing the no-PIN route', () => {
    expect(isTighteningLimits({ maxOrderNotional: '9007199254740993' }, { maxOrderNotional: '9007199254740992' })).toBe(false)
    expect(isTighteningLimits({ maxDailyLossRatio: '0.0100' }, { maxDailyLossRatio: '0.0101' })).toBe(true)
    expect(isTighteningLimits({ maxLeverage: 1.5 }, { maxLeverage: 2 })).toBe(false)
  })
})
