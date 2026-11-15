// SPDX-License-Identifier: CPAL-1.0
// 价格 / 数量规整（教训 7）：全走协议定点十进制，不做浮点加减，不朝成交方向放宽。
import { describe, expect, it } from 'vitest'
import {
  applyBps, decimalsOf, isMultipleOf, isWholeQty, normalizeFractionalQty, snapToTick, toFx, truncateToStep,
} from '../src/precision'

describe('定点解析', () => {
  it('合法正数', () => {
    expect(toFx('190.01')).not.toBeUndefined()
    expect(toFx(190)).not.toBeUndefined()
  })
  it('非法 / 非正 / 空 → undefined', () => {
    expect(toFx('abc')).toBeUndefined()
    expect(toFx('0')).toBeUndefined()
    expect(toFx('-1')).toBeUndefined()
    expect(toFx('')).toBeUndefined()
    expect(toFx(undefined)).toBeUndefined()
  })
  it('decimalsOf', () => {
    expect(decimalsOf('0.01')).toBe(2)
    expect(decimalsOf('1')).toBe(0)
    expect(decimalsOf('0.000001')).toBe(6)
  })
})

describe('整股 / 步长', () => {
  it('isWholeQty 认整数股', () => {
    expect(isWholeQty('10')).toBe(true)
    expect(isWholeQty('0.5')).toBe(false)
  })
  it('isMultipleOf 认步长倍数的数量', () => {
    expect(isMultipleOf('0.0002', '0.0001')).toBe(true)
    expect(isMultipleOf('0.00015', '0.0001')).toBe(false)
    expect(isMultipleOf('abc', '1')).toBe(false)
  })
  it('truncateToStep 向零截断（不四舍五入）', () => {
    expect(truncateToStep('0.526315789', '0.0001')).toBe('0.5263')
    expect(truncateToStep('1.999', '1')).toBe('1')
  })
  it('truncateToStep 遇到非法值抛 RangeError', () => {
    expect(() => truncateToStep('0', '1')).toThrow(RangeError)
  })
  it('normalizeFractionalQty 截到 6 位（不取整成整股）', () => {
    expect(normalizeFractionalQty('0.1234567')).toBe('0.123456')
    expect(normalizeFractionalQty('3')).toBe('3')
  })
})

describe('贴 tick 与滑点带', () => {
  it('向下 / 向上贴 tick；正好整除时不动', () => {
    expect(snapToTick('190.005', '0.01', 'down')).toBe('190')
    expect(snapToTick('190.005', '0.01', 'up')).toBe('190.01')
    expect(snapToTick('190.01', '0.01', 'up')).toBe('190.01')
  })
  it('贴 tick 遇到非法值抛 RangeError', () => {
    expect(() => snapToTick('0', '0.01', 'down')).toThrow(RangeError)
  })
  it('applyBps 向上 / 向下（整数运算，无浮点漂移）', () => {
    expect(applyBps('190', 50, 'up')).toBe('190.95')
    expect(applyBps('190', 50, 'down')).toBe('189.05')
    expect(applyBps('190.01', 10, 'up')).toBe('190.20001')
  })
  it('applyBps 用绝对值（负 bps 不会反向放大）', () => {
    expect(applyBps('100', -50, 'up')).toBe('100.5')
  })
})
