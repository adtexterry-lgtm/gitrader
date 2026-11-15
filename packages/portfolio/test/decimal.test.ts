// SPDX-License-Identifier: CPAL-1.0
// 十进制记账层：18 位定点内部算、8 位对外落位；输出必须是协议规范形。
import { describe, expect, it } from 'vitest'
import { isDecimal } from '@gitrader/protocol'
import { LEDGER_DP, dec, divOr, fx, share } from '../src/decimal'
import { D } from './factories'

describe('dec / LEDGER_DP', () => {
  it('对外精度固定 8 位，四舍五入而非截断', () => {
    expect(LEDGER_DP).toBe(8)
    expect(dec(fx('0.123456789'))).toBe('0.12345679')
    expect(dec(fx('0.123456784'))).toBe('0.12345678')
    expect(dec(fx('-0.123456789'))).toBe('-0.12345679')
  })

  it('零写 "0"，不写 "-0"，不写尾随 0', () => {
    expect(dec(0n)).toBe('0')
    expect(dec(fx('-0'))).toBe('0')
    expect(dec(fx('1.50000000'))).toBe('1.5')
    expect(dec(fx('80000'))).toBe('80000')
  })

  it('输出通过协议 isDecimal 校验（规范形与协议同源，独立校验）', () => {
    for (const value of ['0', '1', '-1', '0.00000001', '80000', '-123456789.12345679', '999999999999.99999999']) {
      expect(isDecimal(dec(fx(value)))).toBe(true)
    }
  })
})

describe('定点算术不碰浮点', () => {
  it('0.1 + 0.2 精确等于 0.3', () => {
    expect(dec(fx('0.1') + fx('0.2'))).toBe('0.3')
    expect(dec(fx('0.1') + fx('0.2')) === '0.30000000000000004').toBe(false)
  })

  it('大额加小额不丢位', () => {
    expect(dec(fx('123456789.12345678') + fx('0.00000001'))).toBe('123456789.12345679')
  })

  it('divOr 分母为 0 时回 fallback，不抛也不产出 Infinity', () => {
    expect(dec(divOr(fx('1'), fx('0')))).toBe('0')
    expect(dec(divOr(fx('1'), fx('0'), fx('7')))).toBe('7')
  })
})

describe('share', () => {
  it('三分之一落在 8 位小数上（明确截断点，不做「看起来像 1」的处理）', () => {
    expect(share(D('1'), D('3'))).toBe('0.33333333')
    expect(share(D('2'), D('4'))).toBe('0.5')
    expect(share(D('0'), D('3'))).toBe('0')
  })

  it('分母为 0 时回 0', () => {
    expect(share(D('5'), D('0'))).toBe('0')
  })
})
