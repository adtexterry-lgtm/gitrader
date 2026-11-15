// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest'
import { dec, isDecimal } from '../src'
import * as D from '../src/decimal'

describe('十进制定点算术（src/decimal.ts）', () => {
  it('解析：符号、指数、前后零、超 18 位向零截断；非法输入抛错', () => {
    expect(D.str(D.fx('1.50'))).toBe('1.5')
    expect(D.str(D.fx('+1e3'))).toBe('1000')
    expect(D.str(D.fx('-0.0010'))).toBe('-0.001')
    expect(D.str(D.fx('.5'))).toBe('0.5')
    expect(D.str(D.fx(0.1))).toBe('0.1')
    expect(D.str(D.fx('0.1234567890123456789'))).toBe('0.123456789012345678')
    expect(D.str(D.fx('-0.1234567890123456789'))).toBe('-0.123456789012345678')
    expect(D.str(D.fx('-0'))).toBe('0')
    for (const bad of ['', 'abc', '.', '1.2.3', '1e', ' - ']) expect(() => D.fx(bad)).toThrow(TypeError)
    expect(() => D.fx(NaN)).toThrow(TypeError)
    expect(() => D.fx(Infinity)).toThrow(TypeError)
  })
  it('加减乘除比较：0.1 + 0.2 恰好等于 0.3（浮点做不到）', () => {
    expect(D.str(D.add(D.fx('0.1'), D.fx('0.2')))).toBe('0.3')
    expect(0.1 + 0.2).not.toBe(0.3)
    expect(D.str(D.sub(D.fx('1'), D.fx('0.9')))).toBe('0.1')
    expect(D.str(D.mul(D.fx('83064.5'), D.fx('0.003')))).toBe('249.1935')
    expect(D.str(D.div(D.fx('1'), D.fx('3')))).toBe('0.333333333333333333')
    expect(D.str(D.div(D.fx('-7'), D.fx('2')))).toBe('-3.5')
    expect(() => D.div(D.fx('1'), D.ZERO)).toThrow(RangeError)
    expect(D.cmp(D.fx('1.10'), D.fx('1.1'))).toBe(0)
    expect(D.cmp(D.fx('2'), D.fx('10'))).toBe(-1) // 不是字符串比较
    expect(D.cmp(D.fx('-1'), D.fx('-2'))).toBe(1)
    expect(D.sign(D.fx('-3'))).toBe(-1)
    expect(D.str(D.abs(D.fx('-3.2')))).toBe('3.2')
    expect(D.str(D.neg(D.fx('3.2')))).toBe('-3.2')
    expect(D.str(D.min(D.fx('1'), D.fx('2')))).toBe('1')
    expect(D.str(D.max(D.fx('1'), D.fx('2')))).toBe('2')
    expect(D.str(D.ONE_FX)).toBe('1')
  })
  it('精度截断：trunc 向零、floor、ceil、half（远离零）', () => {
    const v = (s: string, dp: number, mode: D.RoundMode) => D.str(D.roundFx(D.fx(s), dp, mode), dp)
    expect(v('1.2399', 2, 'trunc')).toBe('1.23')
    expect(v('-1.2399', 2, 'trunc')).toBe('-1.23')
    expect(v('-1.2301', 2, 'floor')).toBe('-1.24')
    expect(v('1.2301', 2, 'floor')).toBe('1.23')
    expect(v('1.2301', 2, 'ceil')).toBe('1.24')
    expect(v('-1.2301', 2, 'ceil')).toBe('-1.23')
    expect(v('1.235', 2, 'half')).toBe('1.24')
    expect(v('-1.235', 2, 'half')).toBe('-1.24')
    expect(v('1.234', 2, 'half')).toBe('1.23')
    expect(v('5', 0, 'trunc')).toBe('5')
    expect(D.str(D.fx('1.23456'), 3)).toBe('1.235')
  })
  it('位数统计：小数位、整数位、有效数字（HL 的 5 位有效数字规则用）', () => {
    expect(D.fracDigits(D.fx('83064.5'))).toBe(1)
    expect(D.fracDigits(D.fx('100'))).toBe(0)
    expect(D.intDigits(D.fx('83064.5'))).toBe(5)
    expect(D.intDigits(D.fx('0.5'))).toBe(0)
    expect(D.sigDigits(D.fx('83064.5'))).toBe(6)
    expect(D.sigDigits(D.fx('0.00123'))).toBe(3)
    expect(D.sigDigits(D.fx('100'))).toBe(3)
  })
  it('字符串层：输入输出都是规范十进制字符串', () => {
    expect(D.addDec('0.1', '0.2')).toBe('0.3')
    expect(D.subDec('0.3', '0.3')).toBe('0')
    expect(D.mulDec('83064.5', '0.003')).toBe('249.1935')
    expect(D.mulDec('2.5', '1.11', 2)).toBe('2.77')
    expect(D.mulDec('2.5', '1.11', 2, 'half')).toBe('2.78')
    expect(D.cmpDec('2', '10')).toBe(-1)
    expect(D.roundDec('0.0039', 3)).toBe('0.003')
    expect(D.roundDec('-0.0039', 3)).toBe('-0.003')
    expect(D.floorToStep('0.00349', '0.001')).toBe('0.003')
    expect(D.floorToStep('-0.00349', '0.001')).toBe('-0.003')
    expect(D.floorToStep('83064.57', '0.5')).toBe('83064.5')
    expect(() => D.floorToStep('1', '0')).toThrow(RangeError)
    for (const s of [D.addDec('1', '2'), D.mulDec('1.5', '2'), D.roundDec('1.99', 1)]) expect(isDecimal(s)).toBe(true)
  })
  it('随机对拍：与 BigInt 手算一致；加减在 18 位内精确', () => {
    let seed = 12345
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
    for (let k = 0; k < 500; k++) {
      const a = Math.floor(rnd() * 1e9) / 1e4
      const b = Math.floor(rnd() * 1e9) / 1e4
      const A = BigInt(Math.round(a * 1e4))
      const B = BigInt(Math.round(b * 1e4))
      const fmt = (n: bigint): string => D.str(D.fx(`${n / 10000n}.${(n % 10000n).toString().padStart(4, '0')}`))
      expect(D.addDec(String(a), String(b))).toBe(fmt(A + B))
      expect(D.cmpDec(String(a), String(b))).toBe(A < B ? -1 : A > B ? 1 : 0)
    }
  })
  it('根入口以命名空间导出（dec.*），与子路径同一份实现', () => {
    expect(dec.add).toBe(D.add)
    expect(dec.fx('1.5')).toBe(D.fx('1.5'))
  })
})
