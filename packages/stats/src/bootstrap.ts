// SPDX-License-Identifier: CPAL-1.0
// 循环块自助法重抽样与可复现随机数，自实现均值与夏普，零依赖。

export function mulberry32(seed: number): () => number {
  let a = seed | 0
  return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}

export interface BootstrapResult {
  values: number[]
  mean: number
  ci: [number, number]
  pValue: number
}

function meanOf(ys: number[]): number {
  if (ys.length === 0) return 0
  let sum = 0
  for (const y of ys) sum += y
  return sum / ys.length
}

function stdevOf(ys: number[]): number {
  const m = ys.length
  if (m < 2) return 0
  const mu = meanOf(ys)
  let ss = 0
  for (const y of ys) {
    const d = y - mu
    ss += d * d
  }
  return Math.sqrt(ss / (m - 1))
}

function sharpe(ys: number[]): number {
  const sd = stdevOf(ys)
  if (!(sd > 0) || !Number.isFinite(sd)) return 0
  return meanOf(ys) / sd
}

export function quantile(sorted: number[], q: number): number {
  if (!(q >= 0 && q <= 1)) throw new RangeError('quantile: q 必须在 [0, 1] 内')
  const m = sorted.length
  if (m === 0) throw new RangeError('quantile: 输入序列不能为空')
  const h = (m - 1) * q
  const lo = Math.floor(h)
  const hi = Math.min(lo + 1, m - 1)
  const base = sorted[lo]!
  return base + (h - lo) * (sorted[hi]! - base)
}

export function circularBlockBootstrap(xs: number[], opts: { blockLen: number; samples: number; seed?: number; level?: number; stat?: (ys: number[]) => number }): BootstrapResult {
  const { blockLen, samples } = opts
  const seed = opts.seed ?? 1
  const level = opts.level ?? 0.95
  const stat = opts.stat ?? sharpe
  const n = xs.length

  if (n < 1) throw new RangeError('circularBlockBootstrap: xs 至少需要一个元素')
  if (!(blockLen >= 1)) throw new RangeError('circularBlockBootstrap: blockLen 必须 >= 1')
  if (!(samples >= 1)) throw new RangeError('circularBlockBootstrap: samples 必须 >= 1')
  if (!(level > 0 && level < 1)) throw new RangeError('circularBlockBootstrap: level 必须在 (0, 1) 内')

  const rand = mulberry32(seed)
  const values: number[] = []
  const buf: number[] = new Array<number>(n)

  for (let k = 0; k < samples; k++) {
    let filled = 0
    while (filled < n) {
      const start = Math.floor(rand() * n)
      for (let i = 0; i < blockLen && filled < n; i++) {
        buf[filled] = xs[(start + i) % n]!
        filled++
      }
    }
    values.push(stat(buf.slice()))
  }

  const sorted = values.slice().sort((a, b) => a - b)
  const lower = quantile(sorted, (1 - level) / 2)
  const upper = quantile(sorted, (1 + level) / 2)
  let nonPositive = 0
  for (const v of values) if (v <= 0) nonPositive++

  return {
    values,
    mean: meanOf(values),
    ci: [lower, upper],
    pValue: nonPositive / samples,
  }
}
