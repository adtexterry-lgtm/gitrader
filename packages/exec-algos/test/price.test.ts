// SPDX-License-Identifier: CPAL-1.0
// 定价：挂单价按 tick 两向取整、市价价带取整方向、非法入参。
import { describe, expect, it } from 'vitest'
import { bandPrice, makerPrice } from '../src'

describe('makerPrice', () => {
  it('买单按 tick 向下取整：100.03 × (1 − 7/10000) = 100.03 × 0.9993 = 99.959979 → 99.95', () => {
    expect(makerPrice('buy', '100.03', 7, '0.05')).toBe('99.95')
  })

  it('卖单按 tick 向上取整：100.03 × 1.0007 = 100.100021 → 0.05 × 2002 = 100.10 不够，取 100.15', () => {
    expect(makerPrice('sell', '100.03', 7, '0.05')).toBe('100.15')
  })

  it('偏移价正好落在 tick 上时不动：100 × 0.9995 = 99.95 → 向下到 0.1 → 99.9', () => {
    expect(makerPrice('buy', '100', 5, '0.1')).toBe('99.9')
  })

  it('偏移 0：买单卖单都等于参考价并按 tick 取整（250.5 是 0.5 的整数倍）', () => {
    expect(makerPrice('buy', '250.5', 0, '0.5')).toBe('250.5')
    expect(makerPrice('sell', '250.5', 0, '0.5')).toBe('250.5')
  })

  it('参考价本身不是 tick 整数倍时也按方向取整：3.14159 → 买 3.14', () => {
    expect(makerPrice('buy', '3.14159', 0, '0.01')).toBe('3.14')
  })

  it('小数 bps：卖 20 × 1.00125 = 20.025，tick 0.001 正好整除', () => {
    expect(makerPrice('sell', '20', 12.5, '0.001')).toBe('20.025')
  })

  it('tick 为 1：卖 100.2 × 1.0001 = 100.3002 → 向上取 101', () => {
    expect(makerPrice('sell', '100.2', 1, '1')).toBe('101')
  })

  it('小价格：买 0.00012345 × 0.999 = 0.00012332655 → tick 0.00001 向下 → 0.00012', () => {
    expect(makerPrice('buy', '0.00012345', 10, '0.00001')).toBe('0.00012')
  })

  it('参考价或 tick 非正、bps 非有限或为负都抛 RangeError', () => {
    expect(() => makerPrice('buy', '0', 5, '0.01')).toThrow(RangeError)
    expect(() => makerPrice('buy', '100', 5, '0')).toThrow(RangeError)
    expect(() => makerPrice('buy', '100', Number.NaN, '0.01')).toThrow(RangeError)
    expect(() => makerPrice('sell', '100', -1, '0.01')).toThrow(RangeError)
  })
})

describe('bandPrice', () => {
  it('买单上沿向下取整：100.01 × 1.005 = 100.51005 → 100.5', () => {
    expect(bandPrice('buy', '100.01', 50, '0.05')).toBe('100.5')
  })

  it('卖单下沿向上取整：100.01 × 0.995 = 99.50995 → 99.55', () => {
    expect(bandPrice('sell', '100.01', 50, '0.05')).toBe('99.55')
  })

  it('滑点 0 的价带就是参考价按 tick 取整', () => {
    expect(bandPrice('buy', '100', 0, '0.1')).toBe('100')
  })

  it('负滑点或非有限滑点抛 RangeError', () => {
    expect(() => bandPrice('buy', '100', -5, '0.01')).toThrow(RangeError)
    expect(() => bandPrice('sell', '100', Number.POSITIVE_INFINITY, '0.01')).toThrow(RangeError)
  })
})
