// SPDX-License-Identifier: CPAL-1.0
// 测试夹具：手工 K 线（可控的高低点）+ engine-core 的确定性合成 K 线（公开 API synthCandles）。
import { synthCandles } from '@gitrader/engine-core'
import type { Candle } from '@gitrader/engine-core'

/** 对齐到 UTC 日界，DCA 的「按天」用例才不会被任意起点切到两天。 */
export const T0 = Math.ceil(1_700_000_000_000 / 86_400_000) * 86_400_000
export const HOUR = 3_600_000

/** 一根 K 线：t 递增由 index 决定。 */
export function bar(o: number, h: number, l: number, c: number, i: number, intervalMs = HOUR): Candle {
  return { t: T0 + i * intervalMs, o, h, l, c, v: 1 }
}

/** 按收盘价序列造 K 线：开盘 = 上一根收盘，高低点 = 开收的极值 ± pad。 */
export function series(closes: readonly number[], opts: { pad?: number; intervalMs?: number; t0?: number } = {}): Candle[] {
  const pad = opts.pad ?? 0
  const intervalMs = opts.intervalMs ?? HOUR
  const t0 = opts.t0 ?? T0
  const out: Candle[] = []
  let prev = closes[0] ?? 1
  for (let i = 0; i < closes.length; i++) {
    const c = closes[i] as number
    const o = i === 0 ? c : prev
    out.push({
      t: t0 + i * intervalMs,
      o,
      h: Math.max(o, c) + pad,
      l: Math.min(o, c) - pad,
      c,
      v: 1,
    })
    prev = c
  }
  return out
}

/** engine-core 的确定性合成行情（种子固定，可重放）。 */
export function synthetic(n = 300, seed = 11, start = 100): Candle[] {
  return synthCandles({ n, seed, start, intervalMs: HOUR, t0: T0 })
}

/** 断言浮点接近。 */
export function near(actual: number, expected: number, tol = 1e-9): boolean {
  return Math.abs(actual - expected) <= tol * Math.max(1, Math.abs(expected))
}
