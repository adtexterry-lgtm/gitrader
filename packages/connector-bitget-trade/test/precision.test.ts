// SPDX-License-Identifier: CPAL-1.0
// 精度规整：Bitget 的 pricePlace / priceEndStep / volumePlace 口径（QD bitget.py:471-627）。
import { describe, expect, it } from 'vitest'
import { applyBps, decimalsOf, isMultipleOf, snapToTick, toFx, truncateToStep } from '../src/precision'

describe('toFx', () => {
  it('接受正十进制字符串', () => {
    expect(toFx('0.001')).toBe(1_000_000_000_000_000n)
  })
  it('接受正数数字', () => {
    expect(toFx(1.5)).toBe(1_500_000_000_000_000_000n)
  })
  it('拒绝 0 / 负数', () => {
    expect(toFx('0')).toBeUndefined()
    expect(toFx('-1')).toBeUndefined()
  })
  it('拒绝空串 / 非数字 / undefined', () => {
    expect(toFx('')).toBeUndefined()
    expect(toFx('abc')).toBeUndefined()
    expect(toFx(undefined)).toBeUndefined()
    expect(toFx(null)).toBeUndefined()
  })
  it('拒绝 NaN / Infinity（number 形态）', () => {
    expect(toFx(Number.NaN)).toBeUndefined()
    expect(toFx(Number.POSITIVE_INFINITY)).toBeUndefined()
  })
})

describe('decimalsOf', () => {
  it('0.1 → 1 位', () => expect(decimalsOf('0.1')).toBe(1))
  it('0.001 → 3 位', () => expect(decimalsOf('0.001')).toBe(3))
  it('整数 → 0 位', () => expect(decimalsOf('1')).toBe(0))
  it('1.00000001 → 8 位', () => expect(decimalsOf('1.00000001')).toBe(8))
})

describe('truncateToStep（向零截断，QD _floor_to_step 同向）', () => {
  it('0.0109 / step 0.001 → 0.01', () => expect(truncateToStep('0.0109', '0.001')).toBe('0.01'))
  it('0.0199 / step 0.001 → 0.019', () => expect(truncateToStep('0.0199', '0.001')).toBe('0.019'))
  it('比 step 小 → 0', () => expect(truncateToStep('0.0009', '0.001')).toBe('0'))
  it('正好整除不变', () => expect(truncateToStep('0.012', '0.001')).toBe('0.012'))
  it('step = 1 时取整', () => expect(truncateToStep('2.99', '1')).toBe('2'))
  it('负数 / 非法输入抛 RangeError', () => {
    expect(() => truncateToStep('-1', '0.001')).toThrow(RangeError)
    expect(() => truncateToStep('x', '0.001')).toThrow(RangeError)
  })
})

describe('snapToTick', () => {
  it('down 时向下取整（100.27 / 0.1 → 100.2）', () => expect(snapToTick('100.27', '0.1', 'down')).toBe('100.2'))
  it('up 时向上取整（100.27 / 0.1 → 100.3）', () => expect(snapToTick('100.27', '0.1', 'up')).toBe('100.3'))
  it('正好整除时两个方向都不动', () => {
    expect(snapToTick('100.3', '0.1', 'down')).toBe('100.3')
    expect(snapToTick('100.3', '0.1', 'up')).toBe('100.3')
  })
  it('step 0.5 的价（priceEndStep=5 / pricePlace=1）', () => {
    expect(snapToTick('100.4', '0.5', 'down')).toBe('100')
    expect(snapToTick('100.4', '0.5', 'up')).toBe('100.5')
  })
  it('非法输入抛 RangeError', () => {
    expect(() => snapToTick('0', '0.1', 'down')).toThrow(RangeError)
  })
})

describe('applyBps（滑点带）', () => {
  it('向上 50 bps：100 → 100.5', () => expect(applyBps('100', 50, 'up')).toBe('100.5'))
  it('向下 50 bps：100 → 99.5', () => expect(applyBps('100', 50, 'down')).toBe('99.5'))
  it('0 bps 不动', () => expect(applyBps('100', 0, 'up')).toBe('100'))
  it('向下取整到 1e-18 定点（10 / 3 bps 不出现浮点尾巴）', () => {
    expect(applyBps('100', 3, 'up')).toBe('100.03')
  })
  it('负 bps 按绝对值处理（方向由参数决定）', () => expect(applyBps('100', -50, 'down')).toBe('99.5'))
})

describe('isMultipleOf', () => {
  it('0.012 是 0.001 的整数倍', () => expect(isMultipleOf('0.012', '0.001')).toBe(true))
  it('0.0125 不是 0.001 的整数倍', () => expect(isMultipleOf('0.0125', '0.001')).toBe(false))
  it('0 不是（toFx 拒绝）', () => expect(isMultipleOf('0', '0.001')).toBe(false))
  it('非法输入 → false', () => expect(isMultipleOf('x', '0.001')).toBe(false))
})
