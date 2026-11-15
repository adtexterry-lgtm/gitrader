// SPDX-License-Identifier: CPAL-1.0
// 三重上限：账本 / 交易所 / 其它策略占用取最小，精确十进制。
import { describe, expect, it } from 'vitest'
import { resolveCloseQuantity } from '../src'

describe('resolveCloseQuantity', () => {
  it('交易所持仓更小 → 取交易所：min(2, 1.5 − 0) = 1.5', () => {
    expect(resolveCloseQuantity({ ledgerPosition: '2', venuePosition: '1.5', otherStrategiesHold: '0' })).toBe('1.5')
  })

  it('账本更小 → 取账本：min(1.2, 5 − 0.7) = min(1.2, 4.3) = 1.2', () => {
    expect(resolveCloseQuantity({ ledgerPosition: '1.2', venuePosition: '5', otherStrategiesHold: '0.7' })).toBe('1.2')
  })

  it('其它策略占满交易所持仓 → 0：min(3, max(0, 1 − 2)) = 0', () => {
    expect(resolveCloseQuantity({ ledgerPosition: '3', venuePosition: '1', otherStrategiesHold: '2' })).toBe('0')
  })

  it('扣掉其它策略占用后的可用量最小：min(1, 1 − 0.25) = 0.75', () => {
    expect(resolveCloseQuantity({ ledgerPosition: '1', venuePosition: '1', otherStrategiesHold: '0.25' })).toBe('0.75')
  })

  it('输出规范化：0.500 / 0.50 → 0.5', () => {
    expect(resolveCloseQuantity({ ledgerPosition: '0.500', venuePosition: '0.50', otherStrategiesHold: '0' })).toBe('0.5')
  })

  it('账本为 0 → 0（不发平仓单）', () => {
    expect(resolveCloseQuantity({ ledgerPosition: '0', venuePosition: '5', otherStrategiesHold: '0' })).toBe('0')
  })

  it('负账本按 0 处理', () => {
    expect(resolveCloseQuantity({ ledgerPosition: '-1', venuePosition: '5', otherStrategiesHold: '0' })).toBe('0')
  })

  it('18 位以内的精度不吃亏：min(12.345678, 100 − 99.9) = 0.1', () => {
    expect(
      resolveCloseQuantity({ ledgerPosition: '12.345678', venuePosition: '100', otherStrategiesHold: '99.9' }),
    ).toBe('0.1')
  })
})
