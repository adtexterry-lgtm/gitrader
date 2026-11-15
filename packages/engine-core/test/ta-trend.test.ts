// SPDX-License-Identifier: CPAL-1.0
// trend.ts 的单元测试：SMA/EMA/WMA、MACD 与交叉信号。
import { describe, expect, it } from 'vitest'
import { cross, ema, macd, sma, wma } from '../src/strategy/ta/trend'

function expectSeries(
  actual: ReadonlyArray<number | null>,
  expected: ReadonlyArray<number | null>,
): void {
  expect(actual.length).toBe(expected.length)
  for (let i = 0; i < expected.length; i++) {
    const exp = expected[i]
    const got = actual[i]
    if (exp === null || exp === undefined) {
      expect(got).toBeNull()
    } else {
      expect(got).not.toBeNull()
      expect(got as number).toBeCloseTo(exp, 9)
    }
  }
}

describe('sma', () => {
  it('3 周期窗口与预热期', () => {
    expectSeries(sma([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4])
  })

  it('长度不足时全为 null', () => {
    expectSeries(sma([1, 2], 3), [null, null])
  })
})

describe('ema', () => {
  it('以简单平均为种子并递推', () => {
    expectSeries(ema([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4])
  })

  it('常数序列保持常数', () => {
    const out = ema([5, 5, 5, 5], 2)
    for (const value of out) {
      if (value !== null) expect(value).toBeCloseTo(5, 9)
    }
  })
})

describe('wma', () => {
  it('线性加权最新权重最大', () => {
    const out = wma([1, 2, 3, 4, 5], 3)
    expect(out[0]).toBeNull()
    expect(out[1]).toBeNull()
    expect(out[2] as number).toBeCloseTo(2.3333333333, 9)
    expect(out[3] as number).toBeCloseTo(3.3333333333, 9)
    expect(out[4] as number).toBeCloseTo(4.3333333333, 9)
  })
})

describe('macd', () => {
  it('常数序列的 macd、signal、hist 均约为 0', () => {
    const values = new Array<number>(40).fill(7)
    const result = macd(values, 3, 5, 2)
    for (let i = 0; i < 4; i++) expect(result.macd[i]).toBeNull()
    for (const series of [result.macd, result.signal, result.hist]) {
      for (const value of series) {
        if (value !== null) expect(value).toBeCloseTo(0, 9)
      }
    }
    expect(result.signal[4]).toBeNull()
    expect(result.signal[5]).not.toBeNull()
  })

  it('严格递增序列的 macd 后半段为正', () => {
    const values = Array.from({ length: 40 }, (_, i) => i + 1)
    const result = macd(values, 3, 5, 2)
    for (let i = 10; i < values.length; i++) {
      expect(result.macd[i] as number).toBeGreaterThan(0)
    }
  })

  it('参数非法时抛 RangeError', () => {
    expect(() => macd([1, 2, 3], 5, 3)).toThrow(RangeError)
    expect(() => sma([1, 2, 3], 0)).toThrow(RangeError)
  })
})

describe('cross', () => {
  it('识别上穿与下穿', () => {
    expectSeries(cross([null, 1, 3, 1], [null, 2, 2, 2]), [null, null, 1, -1])
  })

  it('长度不等时抛 RangeError', () => {
    expect(() => cross([1, 2], [1, 2, 3])).toThrow(RangeError)
  })
})

describe('因果性', () => {
  it('前 10 项结果与只用前 10 项输入一致', () => {
    const full = Array.from({ length: 20 }, (_, i) => i + 1)
    const head = full.slice(0, 10)
    expectSeries(sma(full, 3).slice(0, 10), sma(head, 3))
    expectSeries(ema(full, 3).slice(0, 10), ema(head, 3))
  })
})
