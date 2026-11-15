// SPDX-License-Identifier: CPAL-1.0
import { describe, expect, it } from 'vitest'
import { roundOut } from '../src/util/decimal'

describe('roundOut', () => {
  it('去掉二进制尾差', () => {
    expect(roundOut(0.10600000000000001)).toBe(0.106)
    expect(roundOut(0.1 + 0.2)).toBe(0.3)
    expect(roundOut(9.885907098069096)).toBeCloseTo(9.885907098069096, 13)
  })
  it('反例：不动已经干净的值、非有限数原样返回、不把 15 位以内的真值截掉', () => {
    expect(roundOut(98.2724111122207)).toBe(98.2724111122207)
    expect(roundOut(1e-9)).toBe(1e-9)
    expect(roundOut(123456789.123456)).toBe(123456789.123456)
    expect(roundOut(Number.NaN)).toBeNaN()
    expect(roundOut(Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY)
    expect(roundOut(0)).toBe(0)
  })
})
