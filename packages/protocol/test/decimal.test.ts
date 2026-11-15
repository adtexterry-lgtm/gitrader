// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest'
import { asDecimal, isDecimal, normalizeDecimal } from '../src/model/decimal'
import { validateBySchemaId, modelId } from '../src/validate'

const COMMON_DECIMAL = `${modelId('Common')}#/$defs/Decimal`

describe('十进制字符串规范形', () => {
  const good = ['0', '1', '-1', '83064.5', '-0.112158', '0.0000125', '100', '1000000', '0.1', '123456789012345678901234567890']
  const bad = ['', '00', '01', '1.50', '1.', '.5', '1e3', '+1', '-0', '-0.0', '0.0', ' 1', '1 ', 'NaN', 'Infinity', '1,000', '0x10', '123456789012345678901234567890.1']
  it.each(good)('合法 %s', (v) => {
    expect(isDecimal(v)).toBe(true)
    expect(validateBySchemaId(COMMON_DECIMAL, v).ok).toBe(true)
  })
  it.each(bad)('非法 %j', (v) => {
    expect(isDecimal(v)).toBe(false)
    expect(validateBySchemaId(COMMON_DECIMAL, v).ok).toBe(false)
  })
  it('number 与 null 不是十进制字符串', () => {
    expect(isDecimal(1.5)).toBe(false)
    expect(isDecimal(null)).toBe(false)
    expect(validateBySchemaId(COMMON_DECIMAL, 1.5).ok).toBe(false)
  })
  it('有效数字 ≤ 30：30 位通过，31 位拒绝，前导零不算', () => {
    expect(isDecimal('1'.repeat(30))).toBe(true)
    expect(isDecimal('1'.repeat(31))).toBe(false)
    expect(isDecimal(`0.${'0'.repeat(40)}1`)).toBe(true)
    expect(isDecimal(`1.${'1'.repeat(29)}`)).toBe(true)
    expect(isDecimal(`1.${'1'.repeat(30)}`)).toBe(false)
    expect(validateBySchemaId(COMMON_DECIMAL, '1'.repeat(31)).ok).toBe(false)
  })
  it('asDecimal 对非法输入抛错', () => {
    expect(asDecimal('1.5')).toBe('1.5')
    expect(() => asDecimal('1.50')).toThrow(TypeError)
  })
  it.each([
    ['1.50', '1.5'], ['+1', '1'], ['-0', '0'], ['0.0', '0'], ['1e3', '1000'], ['1.5e-3', '0.0015'], ['123e-2', '1.23'], ['5e-3', '0.005'],
    ['00012.3400', '12.34'], ['-0.0010', '-0.001'], ['.5', '0.5'], ['10', '10'], ['2.5E2', '250'],
  ])('normalizeDecimal(%s) = %s', (input, expected) => {
    expect(normalizeDecimal(input)).toBe(expected)
  })
  it('normalizeDecimal 拒绝非数字', () => {
    expect(() => normalizeDecimal('abc')).toThrow(TypeError)
    expect(() => normalizeDecimal('')).toThrow(TypeError)
    expect(() => normalizeDecimal('.')).toThrow(TypeError)
  })
})
