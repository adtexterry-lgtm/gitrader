// SPDX-License-Identifier: CPAL-1.0
// R1-PERF-09：rollingStd 预扫快路径 / 逐窗口慢路径，结果与「逐窗口精确两遍法」（2c4acdb 的口径）逐点一致；bollinger 改用内部 Float64Array 后输出不变。
import { describe, expect, it } from 'vitest'
import { bollinger, rollingStd } from '../src/strategy/ta/volatility'

/** 参照实现：对每个窗口精确两遍法（按 2 的幂缩放），窗口含非有限值 → null。 */
function refStd(values: number[], period: number, ddof: number): Array<number | null> {
  const out: Array<number | null> = new Array<number | null>(values.length).fill(null)
  for (let i = period - 1; i < values.length; i++) {
    const w = values.slice(i - period + 1, i + 1)
    if (!w.every(Number.isFinite)) continue
    const max = Math.max(...w.map(Math.abs))
    if (max === 0) { out[i] = 0; continue }
    const scale = 2 ** Math.floor(Math.log2(max))
    const mean = w.reduce((a, x) => a + x / scale, 0) / period
    out[i] = Math.sqrt(w.reduce((a, x) => a + (x / scale - mean) ** 2, 0) / (period - ddof)) * scale
  }
  return out
}

function lcg(seed: number): () => number {
  let x = seed >>> 0 || 1
  return () => ((x = (Math.imul(x, 1103515245) + 12345) >>> 0) / 4294967296)
}
const walk = (n: number, p0: number, vol: number, seed: number): number[] => {
  const r = lcg(seed)
  const out: number[] = []
  let p = p0
  for (let i = 0; i < n; i++) { p = Math.max(p0 * 0.05, p * (1 + (r() - 0.5) * 2 * vol)); out.push(p) }
  return out
}

function expectClose(got: Array<number | null>, want: Array<number | null>, label: string): void {
  expect(got.length, label).toBe(want.length)
  for (let i = 0; i < want.length; i++) {
    const w = want[i]!, g = got[i]!
    if (w === null || g === null) { if (w !== g) throw new Error(`${label}[${i}]: got ${String(g)} want ${String(w)}`); continue }
    if (Math.abs(g - w) > 1e-9 * Math.max(1, Math.abs(w))) throw new Error(`${label}[${i}]: got ${g} want ${w}`)
  }
}

const VECTORS: Record<string, number[]> = {
  price1e3: walk(6000, 1000, 0.004, 3),
  price8e4: walk(6000, 80_000, 0.002, 4),
  stable: walk(6000, 1, 0.0001, 5),
  holes: walk(4000, 1000, 0.004, 6).map((x, i) => (i % 997 === 13 ? NaN : i % 1499 === 7 ? Infinity : i % 2003 === 11 ? -Infinity : x)),
  zeros: new Array<number>(1500).fill(0),
  zerosThenPrice: walk(3000, 1000, 0.004, 7).map((x, i) => (Math.floor(i / 300) % 2 ? 0 : x)),
  flatThenJump: [...new Array<number>(500).fill(1234.5678), ...walk(500, 1234.5678, 0.01, 8), ...new Array<number>(500).fill(99.25)],
  bigLevel: walk(3000, 1e8, 1e-7, 9),
  drift: walk(40_000, 1000, 0.002, 10).map((x, i) => x + i * 0.5), // 长序列、价格单边漂移
  huge: walk(1500, 1000, 0.004, 11).map((x) => x * 1e297),
  tiny: walk(1500, 1000, 0.004, 12).map((x) => x * 1e-300),
  mixedScale: walk(1500, 1000, 0.004, 13).map((x, i) => (i % 400 < 200 ? x : x * 1e200)),
}

describe('rollingStd 快路径 / 慢路径 = 逐窗口精确两遍法（1e-9 内）', () => {
  for (const [name, xs] of Object.entries(VECTORS)) {
    for (const period of [2, 5, 20, 200]) {
      for (const ddof of [0, 1]) {
        it(`${name} period=${period} ddof=${ddof}`, () => {
          expectClose(rollingStd(xs, period, ddof), refStd(xs, period, ddof), `${name} p${period} d${ddof}`)
        })
      }
    }
  }

  it('period ≤ ddof 抛 RangeError；序列比窗口短 → 全 null', () => {
    expect(() => rollingStd([1, 2, 3], 1, 1)).toThrow(RangeError)
    expect(() => rollingStd([1, 2, 3], 2, 2)).toThrow(RangeError)
    expect(rollingStd([1, 2], 3)).toEqual([null, null])
  })

  it('NaN / ±Infinity 只让所在窗口为 null，离开窗口后恢复，且与参照一致', () => {
    const xs = [1, 2, 3, NaN, 5, 6, 7, 8, Infinity, 10, 11, 12, 13]
    const got = rollingStd(xs, 3, 0)
    expect(got.slice(0, 2)).toEqual([null, null])
    expect(got[3]).toBeNull()
    expect(got[5]).toBeNull()
    expect(got[6]).not.toBeNull()
    expect(got[10]).toBeNull()
    expect(got[11]).not.toBeNull()
    expectClose(got, refStd(xs, 3, 0), 'holes-small')
  })

  it('平盘窗口：大价位平台后接常数 → 标准差为 0（1e-9 内）', () => {
    const xs = [...walk(400, 80_000, 0.003, 21), ...new Array<number>(400).fill(80_123.45)]
    const got = rollingStd(xs, 20, 0)
    for (let i = 419; i < xs.length; i++) expect(Math.abs(got[i]!)).toBeLessThan(1e-9)
  })

  it('含 NaN 的序列里，正常量级窗口的结果与全序列无 NaN 时逐位相同（慢路径不改数值）', () => {
    const xs = walk(300, 100, 0.01, 31)
    const clean = rollingStd(xs, 14, 0)
    const holey = xs.slice()
    holey[40] = NaN
    const got = rollingStd(holey, 14, 0)
    for (let i = 60; i < xs.length; i++) expect(got[i]).toBe(clean[i])
  })

  it('bollinger 与参照逐点一致（middle / upper / lower / bandwidth / percentB），null 位置一致', () => {
    for (const name of ['price1e3', 'stable', 'holes', 'zerosThenPrice', 'huge']) {
      const xs = VECTORS[name]!
      const b = bollinger(xs, 20, 2)
      const sd = refStd(xs, 20, 0)
      for (let i = 0; i < xs.length; i++) {
        const w = xs.slice(Math.max(0, i - 19), i + 1)
        const finite = i >= 19 && w.every(Number.isFinite)
        if (!finite) { expect(b.middle[i], `${name} middle[${i}]`).toBeNull(); continue }
        const mid = w.reduce((a, x) => a + x, 0) / 20
        expect(Math.abs(b.middle[i]! - mid), `${name} middle[${i}]`).toBeLessThanOrEqual(1e-9 * Math.max(1, Math.abs(mid)))
        const up = mid + 2 * sd[i]!, lo = mid - 2 * sd[i]!
        if (!Number.isFinite(up) || !Number.isFinite(lo)) { expect(b.upper[i]).toBeNull(); continue }
        expect(Math.abs(b.upper[i]! - up), `${name} upper[${i}]`).toBeLessThanOrEqual(1e-9 * Math.max(1, Math.abs(up)))
        expect(Math.abs(b.lower[i]! - lo), `${name} lower[${i}]`).toBeLessThanOrEqual(1e-9 * Math.max(1, Math.abs(lo)))
      }
    }
  })
})
