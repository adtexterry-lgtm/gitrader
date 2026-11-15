// SPDX-License-Identifier: CPAL-1.0
// 性能基准夹具：确定性 K 线生成 + 计时器。被 test/perf.test.ts 使用，不参与常规断言。
import type { Bar } from '../src/types'

/** 线性同余生成 10 万根量级的确定性 K 线（价格围绕 100 波动，量 1000±）。 */
export function makeBars(count: number, seed = 20261021): Bar[] {
  let state = seed
  const next = (): number => {
    state = (state * 1103515245 + 12345) % 2147483648
    return state / 2147483648
  }
  const bars: Bar[] = []
  let close = 100
  for (let i = 0; i < count; i++) {
    const drift = (next() - 0.5) * 0.6
    const open = close
    close = Math.max(1, open + drift)
    const high = Math.max(open, close) + next() * 0.5
    const low = Math.min(open, close) - next() * 0.5
    bars.push({ t: i, o: open, h: high, l: low, c: close, v: 800 + Math.round(next() * 400) })
  }
  return bars
}

/** 重复 runs 次取最小值，避免 JIT 预热与 GC 抖动把结果抬高。 */
export function bench(fn: () => unknown, runs = 3): number {
  fn()
  let best = Number.POSITIVE_INFINITY
  for (let i = 0; i < runs; i++) {
    const start = performance.now()
    fn()
    best = Math.min(best, performance.now() - start)
  }
  return best
}
