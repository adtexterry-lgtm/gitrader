// SPDX-License-Identifier: CPAL-1.0
// ta/volume.ts 的量价指标单测：OBV、VWAP、MFI、CMF、AD 线的取值、预热期与入参校验。

import { describe, expect, it } from 'vitest'
import { adLine, cmf, mfi, obv, vwap } from '../src/strategy/ta/volume'

interface Row {
  h: number
  l: number
  c: number
  v: number
}

function bars(rows: Row[]) {
  return rows.map((r) => ({ o: r.c, h: r.h, l: r.l, c: r.c, v: r.v }))
}

describe('obv', () => {
  it('按收盘价涨跌累加成交量，第 0 项为 0', () => {
    const c = [1, 2, 2, 1]
    const v = [10, 20, 30, 40]
    const input = bars(c.map((ci, i) => ({ h: ci, l: ci, c: ci, v: v[i]! })))
    expect(obv(input)).toEqual([0, 20, 20, -20])
  })
})

describe('vwap', () => {
  const tp = [1, 2, 3]
  const v = [1, 1, 2]
  const input = bars(tp.map((t, i) => ({ h: t, l: t, c: t, v: v[i]! })))

  it('累计口径为 Σ(tp·v)/Σv', () => {
    const out = vwap(input)
    expect(out).toHaveLength(3)
    expect(out[0]!).toBeCloseTo(1, 9)
    expect(out[1]!).toBeCloseTo(1.5, 9)
    expect(out[2]!).toBeCloseTo(2.25, 9)
  })

  it('传 period 时用含当前的滚动窗口', () => {
    const out = vwap(input, 2)
    expect(out[0]).toBeNull()
    expect(out[1]!).toBeCloseTo(1.5, 9)
    expect(out[2]!).toBeCloseTo((2 * 1 + 3 * 2) / 3, 9)
  })

  it('成交量为 0 时全为 null', () => {
    const zero = bars(tp.map((t) => ({ h: t, l: t, c: t, v: 0 })))
    expect(vwap(zero)).toEqual([null, null, null])
    expect(vwap(zero, 2)).toEqual([null, null, null])
  })
})

describe('mfi', () => {
  it('period 2 时按正负资金流给出 0–100', () => {
    const tp = [1, 2, 3, 2]
    const input = bars(tp.map((t) => ({ h: t, l: t, c: t, v: 1 })))
    const out = mfi(input, 2)
    expect(out[0]).toBeNull()
    expect(out[1]).toBeNull()
    expect(out[2]!).toBeCloseTo(100, 9)
    expect(out[3]!).toBeCloseTo(60, 9)
  })

  it('典型价不变时非 null 项为 50', () => {
    const input = bars([5, 5, 5, 5, 5, 5].map((c) => ({ h: c, l: c, c, v: 2 })))
    const out = mfi(input, 3)
    expect(out.slice(0, 3)).toEqual([null, null, null])
    for (const value of out.slice(3)) {
      expect(value!).toBeCloseTo(50, 9)
    }
  })
})

describe('cmf', () => {
  it('mfm 为 1 时该窗口取 1，为正区间之前为 null', () => {
    const input = bars([
      { h: 2, l: 0, c: 2, v: 1 },
      { h: 2, l: 0, c: 2, v: 1 },
      { h: 2, l: 0, c: 2, v: 1 },
    ])
    const out = cmf(input, 3)
    expect(out[0]).toBeNull()
    expect(out[1]).toBeNull()
    expect(out[2]!).toBeCloseTo(1, 9)
  })

  it('mfm 为 -1 时该窗口取 -1', () => {
    const input = bars([
      { h: 2, l: 0, c: 0, v: 1 },
      { h: 2, l: 0, c: 0, v: 1 },
      { h: 2, l: 0, c: 0, v: 1 },
    ])
    const out = cmf(input, 3)
    expect(out[2]!).toBeCloseTo(-1, 9)
  })

  it('h == l 时 adLine 为全 0 累计', () => {
    const input = bars([
      { h: 3, l: 3, c: 3, v: 5 },
      { h: 3, l: 3, c: 3, v: 7 },
      { h: 3, l: 3, c: 3, v: 11 },
    ])
    const out = adLine(input)
    for (const value of out) {
      expect(value!).toBeCloseTo(0, 9)
    }
  })
})

describe('adLine', () => {
  it('累加 mfm·v，mfm 为 0 时不再增加', () => {
    const input = bars([
      { h: 2, l: 0, c: 2, v: 5 },
      { h: 2, l: 0, c: 1, v: 10 },
    ])
    const out = adLine(input)
    expect(out).toHaveLength(2)
    expect(out[0]!).toBeCloseTo(5, 9)
    expect(out[1]!).toBeCloseTo(5, 9)
  })
})

describe('period 校验', () => {
  const input = bars([
    { h: 1, l: 1, c: 1, v: 1 },
    { h: 2, l: 2, c: 2, v: 1 },
    { h: 3, l: 3, c: 3, v: 1 },
  ])

  it('mfi(bars, 0) 抛 RangeError', () => {
    expect(() => mfi(input, 0)).toThrow(RangeError)
  })

  it('cmf(bars, 2.5) 抛 RangeError', () => {
    expect(() => cmf(input, 2.5)).toThrow(RangeError)
  })
})

describe('因果性', () => {
  const rows: Row[] = [
    { h: 10, l: 8, c: 9, v: 5 },
    { h: 9, l: 7, c: 8, v: 6 },
    { h: 8, l: 6, c: 7, v: 4 },
    { h: 8, l: 7, c: 8, v: 9 },
    { h: 9, l: 8, c: 9, v: 3 },
    { h: 11, l: 9, c: 10, v: 7 },
    { h: 12, l: 10, c: 11, v: 2 },
    { h: 11, l: 9, c: 10, v: 8 },
    { h: 10, l: 8, c: 9, v: 6 },
    { h: 9, l: 8, c: 8, v: 4 },
  ]

  it('obv 与累计 vwap 的前 5 项等于只用前 5 根的结果', () => {
    const full = bars(rows)
    const head = full.slice(0, 5)
    const fullObv = obv(full)
    const headObv = obv(head)
    const fullVwap = vwap(full)
    const headVwap = vwap(head)
    for (let i = 0; i < 5; i++) {
      expect(fullObv[i]).toBe(headObv[i])
      expect(fullVwap[i]).toBe(headVwap[i])
    }
  })
})
