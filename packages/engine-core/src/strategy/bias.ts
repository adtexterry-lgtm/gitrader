// SPDX-License-Identifier: CPAL-1.0
// 前视偏差（lookahead）自检：信号序列在第 i 根上的值只能依赖 ≤ i 的 K 线。
// 做法：在若干截断点 k 上，用 candles[0..k] 重算一遍，要求重算出的 target[0..k] 与整段计算出的 target[0..k] 逐根相等。
// 任何指标偷看了未来 K 线（例如 close[i+1]），截断后同一根上的值就会变，这里能抓到。
// 为控制耗时，只在最近 `window` 根（默认 3000）上做；再长的序列因果性与窗口内相同。
import type { Candle } from '../types'

export interface SignalLike { target: readonly number[] }
export type EvalFn = (candles: Candle[]) => SignalLike | Promise<SignalLike>

export interface LookaheadResult {
  result: 'pass' | 'fail' | 'not_run'
  checkedBars: number
  samples: number
  /** fail 时：第一处不一致的下标（相对检查窗口）。 */
  firstMismatch?: number
}

export async function lookaheadCheck(evaluate: EvalFn, candles: readonly Candle[], opts: { window?: number; samples?: number; tolerance?: number } = {}): Promise<LookaheadResult> {
  const window = opts.window ?? 3000
  const samples = opts.samples ?? 6
  const tol = opts.tolerance ?? 1e-9
  const slice = candles.length > window ? candles.slice(-window) : candles.slice()
  const n = slice.length
  if (n < 40) return { result: 'not_run', checkedBars: n, samples: 0 }
  const full = (await evaluate(slice)).target
  if (full.length !== n) return { result: 'fail', checkedBars: n, samples: 0, firstMismatch: Math.min(full.length, n) }
  const points = new Set<number>()
  for (let s = 1; s <= samples; s++) points.add(Math.floor((n - 1) * (s / (samples + 1))) + 1)
  points.add(n - 2)
  for (const k of [...points].sort((a, b) => a - b)) {
    if (k < 20 || k >= n - 1) continue
    const part = (await evaluate(slice.slice(0, k + 1))).target
    for (let i = 0; i <= k; i++) {
      if (!(Math.abs((part[i] ?? NaN) - full[i]!) <= tol)) return { result: 'fail', checkedBars: n, samples: points.size, firstMismatch: i }
    }
  }
  return { result: 'pass', checkedBars: n, samples: points.size }
}
