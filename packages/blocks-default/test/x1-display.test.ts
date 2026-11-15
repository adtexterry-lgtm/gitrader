// SPDX-License-Identifier: CPAL-1.0
import { describe, expect, it } from 'vitest'
import { accountLabel, approvalRule, formatPrice, formatPriceCopy, visibleResult } from '../src/display'
import { normalizeAccounts } from '../src/model-positions'

describe('X1 display boundaries', () => {
  it('truncates to the instrument tick precision without changing quantity', () => {
    expect(formatPrice('12345.67891', { tick: '0.01' as never })).toBe('12,345.67')
    expect(formatPriceCopy('成交 买 0.00012345 @ 12,345.67891', { tick: '0.01' as never })).toBe('成交 买 0.00012345 @ 12,345.67')
  })
  it('honours both decimal and significant figure limits', () => {
    expect(formatPrice('1234.5678', { sigFigs: 5, maxDecimals: 4 })).toBe('1,234.5')
    expect(formatPrice('0.0012345678', { sigFigs: 5, maxDecimals: 6 })).toBe('0.001234')
    expect(formatPrice('123456.7', { sigFigs: 5, maxDecimals: 2 })).toBe('123,456')
  })
  it('keeps large decimal strings exact and handles absent values', () => {
    expect(formatPrice('9007199254740993.129', { maxDecimals: 2 })).toBe('9,007,199,254,740,993.12')
    for (const value of [null, undefined, '', false, 'bad', NaN]) expect(formatPrice(value)).toBe('—')
    expect(formatPrice(0, { maxDecimals: 2 })).toBe('0')
  })
  it('formats generated protection prices but preserves unrelated text', () => {
    expect(formatPriceCopy('挂止损 79,000.123456，止盈 81,000.888888', { maxDecimals: 1 })).toBe('挂止损 79,000.1，止盈 81,000.8')
    expect(formatPriceCopy('提案 T-20261027-000001')).toBe('提案 T-20261027-000001')
  })
  it('shows aliases or the last six characters, never the raw fallback ID', () => {
    expect(accountLabel('account-123456', '纸面')).toBe('纸面')
    expect(accountLabel('account-123456')).toBe('123456')
    expect(normalizeAccounts([{ accountId: 'account-123456', alias: 'account-123456' }])[0]?.alias).toBe('123456')
  })
  it('removes duplicate result words while retaining distinct results', () => {
    expect(visibleResult('订单被拦截', { label: '被拦截', tone: 'err' })).toBeUndefined()
    expect(visibleResult('账户：只减仓', { label: '只减仓', tone: 'warn' })).toBeUndefined()
    expect(visibleResult('提出提案', { label: '待批', tone: 'warn' })?.label).toBe('待批')
  })
  it('distinguishes approval from a real rejection', () => {
    expect(approvalRule('需人批准，上限 0，实际 1')).toBe(true)
    expect(approvalRule('需要你确认')).toBe(true)
    expect(approvalRule('当前交易状态不允许，先恢复交易')).toBe(false)
  })
})
