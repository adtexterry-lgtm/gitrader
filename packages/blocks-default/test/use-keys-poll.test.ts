// SPDX-License-Identifier: CPAL-1.0
// R-51：页面可见时每 15 s 补拉钥匙 / 授权书列表；隐藏时停；重新可见立即拉一次。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { shouldPollKeys } from '../src/hooks'

describe('shouldPollKeys', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2024-01-01T00:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('polls every 15s while visible', () => {
    const lastAt = Date.now()
    expect(shouldPollKeys(true, lastAt, Date.now())).toBe(false)
    vi.advanceTimersByTime(14_999)
    expect(shouldPollKeys(true, lastAt, Date.now())).toBe(false)
    vi.advanceTimersByTime(1)
    expect(shouldPollKeys(true, lastAt, Date.now())).toBe(true)
    vi.advanceTimersByTime(15_000)
    expect(shouldPollKeys(true, lastAt, Date.now())).toBe(true)
  })

  it('does not poll while hidden', () => {
    const lastAt = Date.now()
    expect(shouldPollKeys(false, lastAt, Date.now())).toBe(false)
    vi.advanceTimersByTime(60_000)
    expect(shouldPollKeys(false, lastAt, Date.now())).toBe(false)
    expect(shouldPollKeys(false, 0, Date.now())).toBe(false)
  })

  it('polls immediately when becoming visible', () => {
    const lastAt = Date.now()
    vi.advanceTimersByTime(20_000)
    expect(shouldPollKeys(false, lastAt, Date.now())).toBe(false)
    expect(shouldPollKeys(true, lastAt, Date.now())).toBe(true)
    expect(shouldPollKeys(true, 0, Date.now())).toBe(true)
  })
})
