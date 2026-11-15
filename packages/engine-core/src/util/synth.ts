// SPDX-License-Identifier: CPAL-1.0
// 确定性合成 K 线（种子固定）：给一致性测试夹具和基准用，不是行情。几何随机游走 + 慢周期趋势 + 波动聚集，保证五个示例策略都会开平仓。
import type { Candle } from '../types'

/** mulberry32：32 位种子的确定性伪随机数，输出 [0,1)。 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface SynthOptions { n: number; seed?: number; t0?: number; intervalMs?: number; start?: number }

export function synthCandles(o: SynthOptions): Candle[] {
  const rnd = mulberry32(o.seed ?? 1)
  const step = o.intervalMs ?? 60_000
  const t0 = o.t0 ?? Date.UTC(2026, 0, 1)
  const out: Candle[] = new Array(o.n)
  let price = o.start ?? 80_000
  let vol = 0.0008
  for (let i = 0; i < o.n; i++) {
    const open = price
    vol = Math.max(0.0002, Math.min(0.004, vol * 0.98 + 0.02 * 0.0008 + (rnd() - 0.5) * 0.0002))
    const drift = 0.00003 * Math.sin(i / 3000) + 0.00002 * Math.sin(i / 400)
    const ret = drift + (rnd() + rnd() + rnd() - 1.5) * 2 * vol
    price = Math.max(1, open * (1 + ret))
    const hi = Math.max(open, price) * (1 + rnd() * vol)
    const lo = Math.min(open, price) * (1 - rnd() * vol)
    out[i] = { t: t0 + i * step, o: Number(open.toFixed(2)), h: Number(hi.toFixed(2)), l: Number(lo.toFixed(2)), c: Number(price.toFixed(2)), v: Number((10 + rnd() * 90).toFixed(3)) }
  }
  return out
}
