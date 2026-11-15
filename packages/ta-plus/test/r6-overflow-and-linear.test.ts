// SPDX-License-Identifier: CPAL-1.0
// 第六轮 C 包（R3-11 / R1-PERF-07）：kurtosis / amihud 溢出、correl / beta 的 period、O(n) 实现与朴素实现逐点一致。
import { describe, expect, it } from 'vitest'
import { amihudIlliquidity, beta, correl, kurtosis, linRegSlope, maxDrawdown, rollingMax, simpleReturns } from '../src/index'
import { linearRegression } from '../../engine-core/src/strategy/ta/overlap'

function lcg(seed: number): () => number {
  let s = seed >>> 0
  return () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return s / 4294967296 }
}
function walk(n: number, seed = 7, start = 30000): number[] {
  const r = lcg(seed)
  const out: number[] = []
  let p = start
  for (let i = 0; i < n; i++) { p *= 1 + 0.01 * (r() + r() + r() - 1.5); out.push(p) }
  return out
}

/** 两遍法参考实现（与旧版逐窗朴素算法同一公式）。 */
function kurtosisNaive(xs: number[], p: number, i: number, sample = true): number {
  const w = xs.slice(i - p + 1, i + 1)
  const m = w.reduce((a, b) => a + b, 0) / p
  let m2 = 0
  for (const x of w) m2 += (x - m) ** 2
  if (m2 === 0) return 0
  if (!sample) { let m4 = 0; for (const x of w) m4 += (x - m) ** 4; return m4 / p / ((m2 / p) ** 2) - 3 }
  const s = Math.sqrt(m2 / (p - 1))
  let acc = 0
  for (const x of w) acc += ((x - m) / s) ** 4
  return (p * (p + 1)) / ((p - 1) * (p - 2) * (p - 3)) * acc - (3 * (p - 1) ** 2) / ((p - 2) * (p - 3))
}

describe('R3-11 kurtosis：与尺度无关，不再在 1e299 量级给常数', () => {
  const mk = (scale: number, n = 40): number[] => { const r = lcg(99); return Array.from({ length: n }, () => scale * (1 + r() * 0.5)) }
  it('1e299 / 1e300 量级与 1e150 量级同值，不是旧的常数 −3.5392', () => {
    const ref = kurtosis(mk(1e150), 20).at(-1)!
    for (const sc of [1e299, 1e300, 1e-200]) {
      const got = kurtosis(mk(sc), 20).at(-1)!
      expect(got).not.toBeCloseTo(-3.5392156862745097, 6)
      expect(Math.abs(got - ref)).toBeLessThan(1e-9)
    }
  })
  it('收益序列与价格序列：与两遍法参考值的偏差在容差内（窗口 5 / 20 / 500，样本与总体两种口径）', () => {
    const px = walk(3000)
    const rets = (simpleReturns(px) as (number | null)[]).map((x) => x ?? 0)
    for (const [xs, tol] of [[rets, 1e-9], [px, 1e-6]] as const) {
      for (const p of [5, 20, 500]) {
        for (const sample of [true, false]) {
          const k = kurtosis(xs, p, { sample })
          let worst = 0
          for (let i = p - 1; i < xs.length; i += 7) worst = Math.max(worst, Math.abs(k[i]! - kurtosisNaive(xs, p, i, sample)))
          expect(worst, `p=${p} sample=${sample}`).toBeLessThan(tol)
        }
      }
    }
  })
  it('常数窗口给 0；常数段之后窗口恢复正常；全零序列给 0', () => {
    const xs = [3, 1, 4, 1, 5, 9, 2, 6, 7, 7, 7, 7, 7, 7, 7, 7, 8, 3]
    const k = kurtosis(xs, 5)
    expect(k[12]).toBe(0)
    expect(k[15]).toBe(0)
    expect(Math.abs(k[17]! - kurtosisNaive(xs, 5, 17))).toBeLessThan(1e-9)
    expect(kurtosis([0, 0, 0, 0, 0], 4).slice(3)).toEqual([0, 0])
  })
  it('窗口方差突然变小（相消严重）时仍然准确', () => {
    const xs = [...walk(60, 5, 1e6), ...Array.from({ length: 80 }, (_, i) => 1e6 + (i % 3) * 1e-3)]
    const k = kurtosis(xs, 30)
    for (let i = 29; i < xs.length; i++) expect(Math.abs(k[i]! - kurtosisNaive(xs, 30, i)), `i=${i}`).toBeLessThan(1e-6)
  })
})

describe('R3-11 amihud：不可表示时给 null，不给 0', () => {
  const bars = (sc: number) => Array.from({ length: 40 }, (_, i) => { const c = sc * (1 + (i % 7) * 0.02); return { t: i, o: c, h: c * 1.01, l: c * 0.99, c, v: sc } })
  it('close × volume 溢出：整窗为 null', () => {
    for (const sc of [1e299, 1e300]) expect(amihudIlliquidity(bars(sc), 20).filter((x) => x !== null)).toEqual([])
  })
  it('正常量级与公式一致（相对误差 ≤ 1e-12）', () => {
    const px = walk(300)
    const bs = px.map((c, i) => ({ t: i, o: c, h: c * 1.01, l: c * 0.99, c, v: 100 + (i % 17) }))
    const am = amihudIlliquidity(bs, 20)
    for (let i = 20; i < bs.length; i++) {
      let s = 0
      let n = 0
      for (let j = i - 19; j <= i; j++) { const tr = bs[j]!.c * bs[j]!.v; if (bs[j - 1]!.c > 0 && tr > 0) { s += Math.abs(bs[j]!.c / bs[j - 1]!.c - 1) / tr; n++ } }
      expect(Math.abs(am[i]! - s / n) / (s / n)).toBeLessThan(1e-12)
    }
  })
})

describe('R3-11 correl / beta 的 period', () => {
  const a = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
  const b = [2, 1, 4, 3, 6, 5, 8, 7, 10, 9]
  it('period = 1 与 0 抛 RangeError（与 linRegSlope 同口径）；period = 2 正常算', () => {
    for (const f of [correl, beta]) {
      expect(() => f(a, b, 1)).toThrow(RangeError)
      expect(() => f(a, b, 0)).toThrow(RangeError)
      const out = f(a, b, 2)
      expect(out).toHaveLength(a.length)
      expect(out[0]).toBeNull()
      expect(out.slice(1).every((x) => typeof x === 'number')).toBe(true)
    }
  })
})

describe('R1-PERF-07 O(n) 实现与朴素实现逐点相等', () => {
  const px = walk(2500, 3)
  it('rollingMax：并列、递增、递减、含 NaN 的序列都与逐窗朴素扫描相等', () => {
    const naive = (xs: number[], p: number): (number | null)[] => xs.map((_, i) => { if (i < p - 1) return null; let m = xs[i - p + 1]!; for (let j = i - p + 2; j <= i; j++) if (xs[j]! > m) m = xs[j]!; return m })
    const cases: number[][] = [px, [...px].sort((x, y) => x - y), [...px].sort((x, y) => y - x), Array.from({ length: 300 }, (_, i) => (i * 7) % 5), [1, 2, NaN, 4, 5, 6, 7, 8]]
    for (const xs of cases) for (const p of [1, 2, 5, 50, 499]) expect(rollingMax(xs, p), `p=${p}`).toEqual(naive(xs, p))
  })
  it('maxDrawdown：价格序列逐位相同；含 ≤ 0 的值走朴素分支', () => {
    const naive = (xs: number[], p: number): (number | null)[] => xs.map((_, i) => {
      if (i < p - 1) return null
      let peak = -Infinity
      let worst = 0
      for (let j = i - p + 1; j <= i; j++) { if (xs[j]! > peak) peak = xs[j]!; if (peak > 0) { const dd = xs[j]! / peak - 1; if (dd < worst) worst = dd } }
      return worst
    })
    for (const p of [1, 2, 5, 20, 333]) expect(maxDrawdown(px, p), `p=${p}`).toEqual(naive(px, p))
    const withZero = [5, 4, 0, 3, -1, 6, 2]
    for (const p of [2, 3]) expect(maxDrawdown(withZero, p)).toEqual(naive(withZero, p))
  })
  it('linRegSlope：长窗口滑动与 engine-core 两遍法相对误差 < 1e-9；短窗口仍逐位同值', () => {
    for (const p of [14, 32]) expect(linRegSlope(px, p)).toStrictEqual(linearRegression(px, p).slope)
    for (const p of [33, 50, 500]) {
      const got = linRegSlope(px, p)
      const ref = linearRegression(px, p).slope
      for (let i = p - 1; i < px.length; i++) {
        const d = Math.abs(got[i]! - ref[i]!)
        expect(d / Math.max(1e-12, Math.abs(ref[i]!)) < 1e-9 || d < 1e-9, `p=${p} i=${i}`).toBe(true)
      }
    }
  })
})
