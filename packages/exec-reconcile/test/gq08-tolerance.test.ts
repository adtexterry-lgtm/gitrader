// SPDX-License-Identifier: CPAL-1.0
// GQ-08：数量 / 持仓容差按十进制精确比较（容差的小数位可以比被比较的数更长）。
import { describe, expect, it } from 'vitest'
import { decimalAtScale } from '../src/decimal'
import { classifyPositions } from '../src/positions'
import { resolveOptions, sizeEqual } from '../src/tolerance'
import { input, longPosition, NOW, venuePositionOf } from './helpers'

// ---- 随机源与 oracle（与被测代码完全独立：只用 BigInt）----
const SCALE = 18
const ONE = 10n ** BigInt(SCALE)
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
/** 随机十进制：返回文本，以及它在 18 位标度上的整数值（oracle）。最多 18 位小数，可为负，可带尾零。 */
function gen(rnd: () => number, allowNegative: boolean): { text: string; units: bigint } {
  const dp = Math.floor(rnd() * (SCALE + 1))                  // 小数位 0..18
  const len = 1 + Math.floor(rnd() * (dp + 3))                // 有效数字串长度
  let digits = ''
  for (let i = 0; i < len; i += 1) digits += String(Math.floor(rnd() * 10))
  const mag = BigInt(digits)
  let text = dp === 0 ? mag.toString() : `${(mag / 10n ** BigInt(dp)).toString()}.${(mag % 10n ** BigInt(dp)).toString().padStart(dp, '0')}`
  if (dp > 0 && rnd() < 0.3) text += '0'.repeat(1 + Math.floor(rnd() * 2))   // 尾零不改变数值
  const neg = allowNegative && rnd() < 0.25
  return { text: neg ? `-${text}` : text, units: (neg ? -mag : mag) * 10n ** BigInt(SCALE - dp) }
}
const fmt18 = (u: bigint): string => {
  const neg = u < 0n
  const v = neg ? -u : u
  return `${neg ? '-' : ''}${(v / ONE).toString()}.${(v % ONE).toString().padStart(SCALE, '0')}`
}
const absB = (v: bigint): bigint => (v < 0n ? -v : v)

describe('GQ-08 数量容差：十进制精确比较', () => {
  it('QA 复现七行：容差 0.0001 / 0.5 下 5 vs 6 等', () => {
    const rows: Array<[tol: string, local: string, venue: string, clean: boolean]> = [
      ['0.0001', '1.00', '2.00', false],
      ['0.0001', '0.001', '0.002', false],
      ['0.0001', '0.0001', '0.0002', true],   // 差恰等于容差
      ['0.0001', '5', '6', false],
      ['0', '5', '6', false],
      ['0.5', '5', '6', false],
      ['1', '5', '6', true],                  // 差恰等于容差
    ]
    for (const [tol, local, venue, clean] of rows) {
      const found = classifyPositions(input({
        positions: [longPosition({ size: local })],
        venue: { positions: [venuePositionOf(longPosition({ size: venue }))] },
      }), resolveOptions({ now: NOW, positionTolerance: tol }))
      expect(found.some((f) => f.code === 'position_size_mismatch'), `tol ${tol} ${local} vs ${venue}`).toBe(!clean)
    }
  })

  it('正反双向：该接受的接受，不该接受的拒绝', () => {
    expect(sizeEqual('5', '5.00004', '0.0001')).toBe(true)     // 差 0.00004 <= 0.0001
    expect(sizeEqual('5', '5.0002', '0.0001')).toBe(false)     // 差 0.0002 > 0.0001
    expect(sizeEqual('1.10', '1.1', '0')).toBe(true)           // 尾零
    expect(sizeEqual('-0.0001', '0', '0.0001')).toBe(true)     // 带符号缺口
    expect(sizeEqual('-0.0002', '0', '0.0001')).toBe(false)
    expect(sizeEqual('0.1', '0.1005', '0.001')).toBe(true)     // 原有用例（decimal-tolerance.test.ts:48）
  })

  it('边界：差恰等于容差判相等，多 1e-18 判不等（18 位小数）', () => {
    const rnd = mulberry32(7)
    for (let i = 0; i < 500; i += 1) {
      const a = gen(rnd, true)
      const d = BigInt(1 + Math.floor(rnd() * 1_000_000)) * 10n ** BigInt(Math.floor(rnd() * 13))   // 差，单位 1e-18
      const bUnits = a.units + d
      expect(sizeEqual(a.text, fmt18(bUnits), fmt18(d)), `等于容差 ${a.text}`).toBe(true)
      expect(sizeEqual(a.text, fmt18(bUnits), fmt18(d - 1n)), `超出 1e-18 ${a.text}`).toBe(false)
    }
  })

  it('性质：1 万组随机（最多 18 位小数、含负数、含尾零）与 BigInt oracle 一致', () => {
    const rnd = mulberry32(20261028)
    let equalCount = 0
    for (let i = 0; i < 10_000; i += 1) {
      const a = gen(rnd, true), b = gen(rnd, true), tol = gen(rnd, false)
      const expected = absB(a.units - b.units) <= tol.units
      if (expected) equalCount += 1
      expect(sizeEqual(a.text, b.text, tol.text), `${a.text} vs ${b.text} tol ${tol.text}`).toBe(expected)
    }
    expect(equalCount).toBeGreaterThan(100)      // 防止生成器退化成「全部不等」
    expect(equalCount).toBeLessThan(9_900)       // 也防止退化成「全部相等」
  })

  it('性质：差超容差必报 position_size_mismatch，差不超容差必不报（经 classifyPositions）', () => {
    const rnd = mulberry32(42)
    let mismatches = 0
    for (let i = 0; i < 2_000; i += 1) {
      const a = gen(rnd, false), b = gen(rnd, false), tol = gen(rnd, false)
      if (a.units === 0n || b.units === 0n) continue            // 0 走「缺失」分支，不是数量不符
      const expectMismatch = absB(a.units - b.units) > tol.units
      const found = classifyPositions(input({
        positions: [longPosition({ size: a.text })],
        venue: { positions: [venuePositionOf(longPosition({ size: b.text }))] },
      }), resolveOptions({ now: NOW, positionTolerance: tol.text }))
      const got = found.some((f) => f.code === 'position_size_mismatch')
      if (got) mismatches += 1
      expect(got, `${a.text} vs ${b.text} tol ${tol.text}`).toBe(expectMismatch)
    }
    expect(mismatches).toBeGreaterThan(100)                    // 防止生成器退化成「全部一致」
  })

  it('decimalAtScale 不再静默失真：小数位多于标度抛 RangeError，够长照旧', () => {
    expect(() => decimalAtScale('0.0001', 0)).toThrow(RangeError)
    expect(() => decimalAtScale('0.5', 0)).toThrow(RangeError)
    expect(decimalAtScale('0.0001', 4)).toBe(1n)
    expect(decimalAtScale('0.0001', 6)).toBe(100n)
    expect(decimalAtScale('5', 3)).toBe(5000n)
  })

  it('负容差：sizeEqual 抛 RangeError（与 resolveOptions 同口径，不再悄悄返回 false）', () => {
    expect(() => sizeEqual('1', '1', '-0.1')).toThrow(RangeError)
  })
})
