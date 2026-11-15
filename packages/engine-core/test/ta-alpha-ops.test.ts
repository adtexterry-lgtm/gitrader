// SPDX-License-Identifier: CPAL-1.0
// Alpha158 批 A 算子：滚动求和、Pearson 相关、窗口百分位名次、极值距今根数、线性回归末点残差的精确数值与 null 口径。
import { describe, expect, it } from 'vitest'
import {
  idxMax,
  idxMin,
  linearResidual,
  rankPct,
  rollingCorr,
  rollingSum,
} from '../src/strategy/ta/alpha-ops'

describe('rollingSum', () => {
  it('period 3 的窗口求和与前 period-1 项为 null', () => {
    expect(rollingSum([1, 2, 3, 4, 5], 3)).toEqual([null, null, 6, 9, 12])
  })

  it('窗口内含 null 时为 null', () => {
    expect(rollingSum([1, 2, null, 4, 5], 2)).toEqual([null, 3, null, null, 9])
  })

  it('输入短于 period 时全 null', () => {
    expect(rollingSum([1, 2], 3)).toEqual([null, null])
  })
})

describe('rollingCorr', () => {
  it('完全正相关为 1、完全负相关为 -1', () => {
    const positive = rollingCorr([1, 2, 3, 4], [2, 4, 6, 8], 3)
    expect(positive[0]).toBeNull()
    expect(positive[1]).toBeNull()
    expect(positive[2]).toBeCloseTo(1, 12)
    expect(positive[3]).toBeCloseTo(1, 12)
    const negative = rollingCorr([1, 2, 3, 4], [8, 6, 4, 2], 3)
    expect(negative[2]).toBeCloseTo(-1, 12)
    expect(negative[3]).toBeCloseTo(-1, 12)
  })

  it('常数序列分母为 0 时为 null', () => {
    expect(rollingCorr([2, 2, 2], [1, 2, 3], 3)).toEqual([null, null, null])
  })

  it('窗口内含 null 时为 null', () => {
    const out = rollingCorr([1, 2, null, 4], [1, 2, 3, 4], 2)
    expect(out[0]).toBeNull()
    expect(out[1]).toBeCloseTo(1, 12)
    expect(out[2]).toBeNull()
    expect(out[3]).toBeNull()
  })
})

describe('rankPct', () => {
  it('末值在窗口内的百分位', () => {
    expect(rankPct([3, 1, 2, 2, 5], 5)).toEqual([null, null, null, null, 1])
  })

  it('并列取平均名次', () => {
    const out = rankPct([1, 2, 2, 2, 2], 5)
    expect(out[4]).toBeCloseTo(0.7, 12)
  })

  it('滚动窗口按窗口内名次计算', () => {
    const out = rankPct([1, 3, 2, 5], 3)
    expect(out[0]).toBeNull()
    expect(out[1]).toBeNull()
    expect(out[2]).toBeCloseTo(2 / 3, 12)
    expect(out[3]).toBeCloseTo(1, 12)
  })

  it('窗口内含 null 时为 null', () => {
    expect(rankPct([1, null, 3], 3)).toEqual([null, null, null])
  })
})

describe('idxMax / idxMin', () => {
  it('最大值并列取最早出现，返回距今根数', () => {
    expect(idxMax([1, 3, 3, 2], 4)).toEqual([null, null, null, 2])
  })

  it('最小值并列取最早出现，返回距今根数', () => {
    expect(idxMin([1, 3, 3, 2], 4)).toEqual([null, null, null, 3])
  })

  it('滚动窗口的距今根数', () => {
    expect(idxMax([5, 1, 2, 3, 4], 2)).toEqual([null, 1, 0, 0, 0])
    expect(idxMin([5, 1, 2, 3, 4], 2)).toEqual([null, 0, 1, 1, 1])
  })

  it('窗口内含 null 时为 null', () => {
    expect(idxMax([1, null, 3], 2)).toEqual([null, null, null])
    expect(idxMin([1, null, 3], 2)).toEqual([null, null, null])
  })
})

describe('linearResidual', () => {
  it('精确直线的末点残差为 0', () => {
    const out = linearResidual([2, 4, 6, 8], 4)
    expect(out[0]).toBeNull()
    expect(out[3]).toBeCloseTo(0, 9)
  })

  it('手算的残差数值', () => {
    const out = linearResidual([1, 2, 4], 3)
    expect(out[1]).toBeNull()
    expect(out[2]).toBeCloseTo(0.1666666666667, 6)
  })

  it('窗口内含 null 时为 null', () => {
    expect(linearResidual([1, null, 4], 3)).toEqual([null, null, null])
  })
})

describe('period 校验', () => {
  it('period 0 抛错且消息含 period', () => {
    expect(() => rollingSum([1, 2, 3], 0)).toThrow(/period/)
    expect(() => rollingCorr([1, 2, 3], [1, 2, 3], 0)).toThrow(/period/)
    expect(() => rankPct([1, 2, 3], 0)).toThrow(/period/)
    expect(() => idxMax([1, 2, 3], 0)).toThrow(/period/)
    expect(() => idxMin([1, 2, 3], 0)).toThrow(/period/)
    expect(() => linearResidual([1, 2, 3], 0)).toThrow(/period/)
  })

  it('period 非整数时抛错且消息含 period', () => {
    expect(() => rollingSum([1, 2, 3], 1.5)).toThrow(/period/)
  })
})
