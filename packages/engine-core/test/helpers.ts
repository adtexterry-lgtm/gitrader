// SPDX-License-Identifier: CPAL-1.0
// 测试用 K 线构造（沿用 Demo 测试的小工具）。
import type { Candle } from '../src/types'

export const H = 3_600_000
export const T0 = Date.UTC(2026, 0, 1)

/** 由收盘价序列造 K 线：开盘 = 上一根收盘，高低各 ±0.3%。 */
export function mk(closes: number[], step = H): Candle[] {
  return closes.map((c, i) => {
    const o = i === 0 ? c : closes[i - 1]!
    return { t: T0 + i * step, o, h: Math.max(o, c) * 1.003, l: Math.min(o, c) * 0.997, c, v: 100 + (i % 7) * 10 }
  })
}
export const up = (n: number, a = 100, step = 1): number[] => Array.from({ length: n }, (_, i) => a + i * step)
export const sine = (n: number, mid = 100, amp = 10, period = 40): number[] => Array.from({ length: n }, (_, i) => mid + amp * Math.sin((2 * Math.PI * i) / period))
