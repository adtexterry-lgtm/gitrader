// SPDX-License-Identifier: CPAL-1.0
// informationRatio 的单元测试：主动收益、跟踪误差、IR 年化与长度校验。
import { describe, expect, it } from 'vitest'
import { informationRatio } from '../src/dist'

describe('informationRatio', () => {
  it('主动收益均值、样本跟踪误差与每期 IR', () => {
    const result = informationRatio([0.02, 0.01, 0.03], [0.01, 0.01, 0.01])
    expect(result.n).toBe(3)
    expect(result.activeMean).toBeCloseTo(0.01, 12)
    expect(result.trackingError).toBeCloseTo(0.01, 12)
    expect(result.ir!).toBeCloseTo(1, 12)
  })

  it('periodsPerYear 只年化 IR', () => {
    const result = informationRatio([0.02, 0.01, 0.03], [0.01, 0.01, 0.01], {
      periodsPerYear: 4,
    })
    expect(result.trackingError).toBeCloseTo(0.01, 12)
    expect(result.ir!).toBeCloseTo(2, 12)
  })

  it('长度不等抛 RangeError', () => {
    expect(() => informationRatio([0.01], [0.01, 0.02])).toThrow(RangeError)
    expect(() => informationRatio([0.01, 0.02], [0.01])).toThrow(RangeError)
  })

  it('跟踪误差为 0 时 IR 为 null', () => {
    const result = informationRatio([0.01, 0.02], [0.01, 0.02])
    expect(result.trackingError).toBe(0)
    expect(result.ir).toBeNull()
  })
})
