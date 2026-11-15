// SPDX-License-Identifier: CPAL-1.0
// 精度：tick / step 的定点规整（不碰 JS 浮点加减）。手算写在注释里。
import { describe, expect, it } from 'vitest'
import { decimalsOf, isMultipleOf, snapToTick, toFx, truncateToStep } from '../src/precision'
import { clampLimitPrice } from '../src/limit-safety'

describe('toFx', () => {
  it('正数解析成定点数', () => {
    expect(toFx('0.001')).toBeTruthy()
  })

  it('0 / 负数 / 空串 / 非数字一律 undefined', () => {
    expect(toFx('0')).toBeUndefined()
    expect(toFx('-1')).toBeUndefined()
    expect(toFx('')).toBeUndefined()
    expect(toFx('abc')).toBeUndefined()
    expect(toFx(undefined)).toBeUndefined()
    expect(toFx(null)).toBeUndefined()
  })

  it('接受 number（Bybit 有些字段就是 number）', () => {
    expect(toFx(1.5)).toBeTruthy()
  })
})

describe('decimalsOf', () => {
  it('按小数点后的位数算（0.001 → 3，100 → 0）', () => {
    expect(decimalsOf('0.001')).toBe(3)
    expect(decimalsOf('100')).toBe(0)
    expect(decimalsOf('0.0001')).toBe(4)
  })
})

describe('truncateToStep（向零截断）', () => {
  it('0.1009 按 step 0.001 → 0.1', () => {
    expect(truncateToStep('0.1009', '0.001')).toBe('0.1')
  })

  it('0.0123 按 step 0.01 → 0.01', () => {
    expect(truncateToStep('0.0123', '0.01')).toBe('0.01')
  })

  it('已是整数倍时原值不动（0.5 / 0.1 → 0.5）', () => {
    expect(truncateToStep('0.5', '0.1')).toBe('0.5')
  })

  it('小于一个 step 时截断成 0', () => {
    expect(Number(truncateToStep('0.0004', '0.001'))).toBe(0)
  })

  it('非法输入抛 RangeError（不静默返回 0）', () => {
    expect(() => truncateToStep('0', '0.001')).toThrow(RangeError)
    expect(() => truncateToStep('0.1', '0')).toThrow(RangeError)
  })

  it('大数也不丢精度（123456.789012 按 step 0.000001）', () => {
    expect(truncateToStep('123456.789012', '0.000001')).toBe('123456.789012')
  })
})

describe('isMultipleOf', () => {
  it('100.1 是 tick 0.1 的整数倍', () => {
    expect(isMultipleOf('100.1', '0.1')).toBe(true)
  })

  it('100.15 不是 tick 0.1 的整数倍', () => {
    expect(isMultipleOf('100.15', '0.1')).toBe(false)
  })

  it('非法输入 → false（不抛）', () => {
    expect(isMultipleOf('x', '0.1')).toBe(false)
    expect(isMultipleOf('1', '0')).toBe(false)
  })
})

describe('snapToTick', () => {
  it('down：100.15 → 100.1（买单只向下贴）', () => {
    expect(snapToTick('100.15', '0.1', 'down')).toBe('100.1')
  })

  it('up：100.15 → 100.2（卖单只向上贴）', () => {
    expect(snapToTick('100.15', '0.1', 'up')).toBe('100.2')
  })

  it('已在 tick 上时两个方向都不动（100.2）', () => {
    expect(snapToTick('100.2', '0.1', 'down')).toBe('100.2')
    expect(snapToTick('100.2', '0.1', 'up')).toBe('100.2')
  })

  it('小数 tick（0.0001）不引入浮点误差：0.00015 → down 0.0001 / up 0.0002', () => {
    expect(snapToTick('0.00015', '0.0001', 'down')).toBe('0.0001')
    expect(snapToTick('0.00015', '0.0001', 'up')).toBe('0.0002')
  })

  it('非法输入抛 RangeError', () => {
    expect(() => snapToTick('0', '0.1', 'down')).toThrow(RangeError)
  })
})

describe('clampLimitPrice（只收紧不放宽）', () => {
  it('买单高于上限时夹回上限', () => {
    const out = clampLimitPrice('buy', 101, 100, 50) // 100 × 1.005 = 100.5
    expect(out.price).toBeCloseTo(100.5, 10)
    expect(out.clamped).toBe(true)
  })

  it('卖单低于下限时抬回下限', () => {
    const out = clampLimitPrice('sell', 99, 100, 50) // 100 × 0.995 = 99.5
    expect(out.price).toBeCloseTo(99.5, 10)
    expect(out.clamped).toBe(true)
  })

  it('在带内的价格原样通过（不 clamped）', () => {
    expect(clampLimitPrice('buy', 100.2, 100, 50)).toEqual({ price: 100.2, clamped: false })
  })

  it('参考价非正 / 非有限时不动（不猜）', () => {
    expect(clampLimitPrice('buy', 101, 0, 50)).toEqual({ price: 101, clamped: false })
    expect(clampLimitPrice('buy', 101, Number.NaN, 50)).toEqual({ price: 101, clamped: false })
  })

  it('限价非有限时不动', () => {
    expect(clampLimitPrice('sell', Number.NaN, 100, 50).clamped).toBe(false)
  })
})
