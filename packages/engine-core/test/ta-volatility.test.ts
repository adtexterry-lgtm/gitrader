// SPDX-License-Identifier: CPAL-1.0
// 波动类指标测试：逐条覆盖 trueRange / atr / rollingStd / bollinger / donchian / keltner / logReturns / annualizedVol 与因果性。

import { describe, expect, it } from 'vitest'
import {
  annualizedVol,
  atr,
  bollinger,
  donchian,
  keltner,
  logReturns,
  rollingStd,
  trueRange,
} from '../src/strategy/ta/volatility'

/** 按 h / l / c 三列构造最小 bar；o 取收盘价，v 取 0。 */
function barsFrom(hs: number[], ls: number[], cs: number[]) {
  return hs.map((h, i) => ({ o: cs[i]!, h, l: ls[i]!, c: cs[i]!, v: 0 }))
}

/** 20 根无跳空、振幅恒为 1 的 bars。 */
function flatBars(count: number) {
  const hs = new Array<number>(count).fill(2)
  const ls = new Array<number>(count).fill(1)
  const cs = new Array<number>(count).fill(1.5)
  return barsFrom(hs, ls, cs)
}

describe('trueRange', () => {
  it('第 0 项为 h - l，之后含前收盘价', () => {
    const bars = barsFrom([2, 3, 4], [1, 2, 3], [1.5, 2.5, 3.5])
    const tr = trueRange(bars)
    expect(tr.length).toBe(3)
    expect(tr[0]!).toBeCloseTo(1, 9)
    expect(tr[1]!).toBeCloseTo(1.5, 9)
    expect(tr[2]!).toBeCloseTo(1.5, 9)
  })
})

describe('atr', () => {
  it('前 period-1 项为 null，恒振幅时从第 period-1 项起为 1', () => {
    const bars = flatBars(20)
    const out = atr(bars, 5)
    expect(out.length).toBe(20)
    for (let i = 0; i < 4; i++) expect(out[i]).toBeNull()
    for (let i = 4; i < 20; i++) expect(out[i]!).toBeCloseTo(1, 9)
  })

  it('拒绝非法 period', () => {
    expect(() => atr(flatBars(5), 0)).toThrow(RangeError)
    expect(() => atr(flatBars(5), 2.5)).toThrow(RangeError)
  })
})

describe('rollingStd', () => {
  it('ddof 0 与 ddof 1 的窗口标准差', () => {
    const values = [1, 2, 3, 4, 5]
    const pop = rollingStd(values, 3)
    expect(pop[0]).toBeNull()
    expect(pop[1]).toBeNull()
    expect(pop[2]!).toBeCloseTo(0.8164965809, 9)
    const sample = rollingStd(values, 3, 1)
    expect(sample[2]!).toBeCloseTo(1, 9)
  })

  it('period <= ddof 抛 RangeError', () => {
    expect(() => rollingStd([1, 2, 3], 2, 2)).toThrow(RangeError)
  })
})

describe('bollinger', () => {
  it('middle / upper / lower / bandwidth / percentB 的第 2 项', () => {
    const out = bollinger([1, 2, 3, 4, 5], 3, 2)
    for (const key of ['middle', 'upper', 'lower', 'bandwidth', 'percentB'] as const) {
      expect(out[key][0]).toBeNull()
      expect(out[key][1]).toBeNull()
    }
    expect(out.middle[2]!).toBeCloseTo(2, 9)
    expect(out.upper[2]!).toBeCloseTo(3.6329931619, 9)
    expect(out.lower[2]!).toBeCloseTo(0.3670068381, 9)
    expect(out.bandwidth[2]!).toBeCloseTo(1.6329931619, 9)
    expect(out.percentB[2]!).toBeCloseTo(0.8061862178, 9)
  })
})

describe('donchian', () => {
  it('含当前 bar 的最高 / 最低 / 平均', () => {
    const bars = barsFrom([2, 3, 4, 5, 6], [1, 2, 3, 4, 5], [1.5, 2.5, 3.5, 4.5, 5.5])
    const out = donchian(bars, 3)
    expect(out.upper[0]).toBeNull()
    expect(out.upper[1]).toBeNull()
    expect([out.upper[2], out.upper[3], out.upper[4]]).toEqual([4, 5, 6])
    expect([out.lower[2], out.lower[3], out.lower[4]]).toEqual([1, 2, 3])
    expect([out.middle[2], out.middle[3], out.middle[4]]).toEqual([2.5, 3.5, 4.5])
  })
})

describe('keltner', () => {
  it('恒振幅时上下轨与 middle 的距离为 k * atr', () => {
    const bars = flatBars(20)
    const out = keltner(bars, 5, 5, 2)
    for (let i = 4; i < 20; i++) {
      const mid = out.middle[i]!
      const up = out.upper[i]!
      const lo = out.lower[i]!
      expect(up - mid).toBeCloseTo(2, 9)
      expect(mid - lo).toBeCloseTo(2, 9)
    }
  })
})

describe('logReturns', () => {
  it('相邻比值的自然对数', () => {
    const out = logReturns([1, Math.E, Math.E * Math.E])
    expect(out.length).toBe(3)
    expect(out[0]).toBeNull()
    expect(out[1]!).toBeCloseTo(1, 12)
    expect(out[2]!).toBeCloseTo(1, 12)
  })

  it('非正值参与时该项为 null', () => {
    const out = logReturns([1, 0, 2])
    expect(out[0]).toBeNull()
    expect(out[1]).toBeNull()
    expect(out[2]).toBeNull()
  })
})

describe('annualizedVol', () => {
  it('对数收益 ±ln2 的年化样本标准差', () => {
    const out = annualizedVol([1, 2, 1, 2, 1, 2], 2, 252)
    expect(out.length).toBe(6)
    expect(out[0]).toBeNull()
    expect(out[1]).toBeNull()
    const expected = Math.LN2 * Math.sqrt(2) * Math.sqrt(252)
    for (let i = 2; i < 6; i++) expect(out[i]!).toBeCloseTo(expected, 9)
  })
})

describe('因果性', () => {
  it('atr 前 10 项与只用前 10 根 bars 的结果一致', () => {
    const all = barsFrom(
      [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21],
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20],
      [1.5, 2.5, 3.5, 4.5, 5.5, 6.5, 7.5, 8.5, 9.5, 10.5, 11.5, 12.5, 13.5, 14.5, 15.5, 16.5, 17.5, 18.5, 19.5, 20.5],
    )
    const full = atr(all, 5)
    const head = atr(all.slice(0, 10), 5)
    for (let i = 0; i < 10; i++) {
      expect(full[i]).toBe(head[i])
    }
  })
})

describe('GQ-26 极端输入', () => {
  /** 旧算法的逐字副本，用来钉「正常量级结果逐位不变」。 */
  const naiveStd = (values: number[], period: number, ddof = 0): Array<number | null> => {
    const out: Array<number | null> = new Array(values.length).fill(null)
    for (let i = period - 1; i < values.length; i++) {
      let sum = 0
      for (let j = i - period + 1; j <= i; j++) sum += values[j]!
      const mean = sum / period
      let sq = 0
      for (let j = i - period + 1; j <= i; j++) {
        const d = values[j]! - mean
        sq += d * d
      }
      out[i] = Math.sqrt(sq / (period - ddof))
    }
    return out
  }
  const base = Array.from({ length: 60 }, (_, i) => 1 + (i % 7) / 10)

  it('1e300 量级：bollinger 全部有限，且与缩放后的结果等价（尺度等变）', () => {
    const small = bollinger(base, 20, 2)
    const big = bollinger(
      base.map((v) => v * 1e300),
      20,
      2,
    )
    for (const key of ['middle', 'upper', 'lower'] as const) {
      big[key].forEach((v, i) => {
        if (v === null) {
          expect(small[key][i]).toBeNull()
          return
        }
        expect(Number.isFinite(v)).toBe(true) // 修前这里是 ±Infinity
        expect(v / 1e300).toBeCloseTo(small[key][i]!, 9)
      })
    }
    for (const key of ['bandwidth', 'percentB'] as const) {
      // 这两项与量级无关，应与小量级结果相同
      big[key].forEach((v, i) => {
        if (v === null) {
          expect(small[key][i]).toBeNull()
          return
        }
        expect(Number.isFinite(v)).toBe(true) // 修前 percentB 是 NaN
        expect(v).toBeCloseTo(small[key][i]!, 9)
      })
    }
  })

  it('正常量级：rollingStd 与旧算法逐位相同（不是近似）', () => {
    const data = Array.from({ length: 200 }, (_, i) => 100 + Math.sin(i / 3) * 7 + ((i * 7919) % 13) / 5)
    for (const ddof of [0, 1]) expect(rollingStd(data, 14, ddof)).toEqual(naiveStd(data, 14, ddof))
  })

  it('窗口内有 NaN：含它的窗口输出 null，离开窗口后恢复（不向后传染）', () => {
    const v = Array.from({ length: 30 }, (_, i) => 100 + i)
    v[10] = Number.NaN
    const std = rollingStd(v, 5)
    const bb = bollinger(v, 5, 2)
    for (let i = 4; i < 30; i++) {
      const covered = i >= 10 && i <= 14 // 包含下标 10 的窗口
      for (const s of [std, bb.middle, bb.upper, bb.lower, bb.bandwidth, bb.percentB]) {
        if (covered) expect(s[i]).toBeNull()
        else expect(Number.isFinite(s[i] as number)).toBe(true) // 修前 bollinger 从 10 起全是 NaN
      }
    }
  })

  it('±Infinity 输入同样给 null，不产出 NaN / Infinity', () => {
    const v = Array.from({ length: 20 }, (_, i) => 50 + i)
    v[6] = Number.POSITIVE_INFINITY
    for (const s of [rollingStd(v, 4), ...Object.values(bollinger(v, 4, 2))]) {
      for (const x of s) expect(x === null || Number.isFinite(x)).toBe(true)
    }
  })

  it('反例：全 0 窗口 std 为 0，常数窗口不被误判成坏值', () => {
    expect(rollingStd([0, 0, 0, 0], 4)[3]).toBe(0)
    expect(rollingStd([5, 5, 5, 5], 4)[3]).toBe(0)
    expect(rollingStd([1, 2, 3], 3, 3 - 2)[2]).toBeCloseTo(1, 12) // ddof=1：样本标准差 ÷(3−1)
    expect(rollingStd([1, 2, 3], 3, 3 - 1)[2]).toBeCloseTo(Math.SQRT2, 12) // ddof=2、period=3 仍合法（÷(3−2)）
  })
})
