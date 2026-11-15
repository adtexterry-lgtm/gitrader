// SPDX-License-Identifier: CPAL-1.0
// CSCV 回测过拟合概率：按 Bailey–Borwein–López de Prado–Zhu (2014) 实现。
/*
 * 算法出处：Bailey, Borwein, López de Prado, Zhu,
 * "The Probability of Backtest Overfitting", Journal of Computational Finance (2014).
 * 组合的样本外排名约定为 ω = rank / (N + 1)，其中 rank 为按指标升序排列的 1 基位置，
 * 再取 λ = ln(ω / (1 − ω))；λ <= 0 记为一次过拟合。
 */

export interface PboResult {
  pbo: number
  lambdas: number[]
  combos: number
  oosRankMean: number
  degradation: { slope: number; intercept: number }
  probLossOos: number
}

function sharpe(xs: number[]): number {
  const n = xs.length
  if (n < 2) return 0
  let sum = 0
  for (let i = 0; i < n; i++) sum += xs[i]!
  const mean = sum / n
  let ss = 0
  for (let i = 0; i < n; i++) {
    const d = xs[i]! - mean
    ss += d * d
  }
  const sd = Math.sqrt(ss / (n - 1))
  if (!(sd > 0)) return 0
  return mean / sd
}

function combinations(n: number, k: number): number[][] {
  const result: number[][] = []
  const current: number[] = []
  const walk = (start: number): void => {
    if (current.length === k) {
      result.push(current.slice())
      return
    }
    const remaining = k - current.length
    for (let i = start; i <= n - remaining; i++) {
      current.push(i)
      walk(i + 1)
      current.pop()
    }
  }
  walk(0)
  return result
}

export function cscvPbo(
  returns: number[][],
  opts?: { blocks?: number; metric?: (xs: number[]) => number },
): PboResult {
  const t = returns.length
  const n = t === 0 ? 0 : returns[0]!.length
  const s = opts?.blocks ?? 16

  if (!Number.isInteger(s) || s < 2 || s % 2 !== 0) {
    throw new RangeError('blocks must be a positive even integer')
  }
  if (t < s || n < 2) {
    throw new RangeError('returns must have at least blocks periods and at least 2 strategies')
  }

  const metricFn = opts?.metric ?? sharpe

  const base = Math.floor(t / s)
  const extra = t % s
  const starts = new Array<number>(s)
  const ends = new Array<number>(s)
  let cursor = 0
  for (let b = 0; b < s; b++) {
    const len = base + (b < extra ? 1 : 0)
    starts[b] = cursor
    cursor += len
    ends[b] = cursor
  }

  const combos = combinations(s, s / 2)
  const lambdas: number[] = []
  let overfitCount = 0
  let lossCount = 0
  let rankSum = 0
  let sumX = 0
  let sumY = 0
  let sumXX = 0
  let sumXY = 0

  const isMask = new Array<boolean>(s)
  for (const isBlocks of combos) {
    isMask.fill(false)
    for (const b of isBlocks) isMask[b] = true

    const isMetrics = new Array<number>(n)
    const oosMetrics = new Array<number>(n)

    for (let j = 0; j < n; j++) {
      const isSeq: number[] = []
      const oosSeq: number[] = []
      for (let b = 0; b < s; b++) {
        const start = starts[b]!
        const end = ends[b]!
        const target = isMask[b] === true ? isSeq : oosSeq
        for (let p = start; p < end; p++) target.push(returns[p]![j]!)
      }
      isMetrics[j] = metricFn(isSeq)
      oosMetrics[j] = metricFn(oosSeq)
    }

    let best = 0
    for (let j = 1; j < n; j++) {
      if (isMetrics[j]! > isMetrics[best]!) best = j
    }

    const order = new Array<number>(n)
    for (let j = 0; j < n; j++) order[j] = j
    order.sort((a, b) => {
      const va = oosMetrics[a]!
      const vb = oosMetrics[b]!
      if (va < vb) return -1
      if (va > vb) return 1
      return a - b
    })

    const rank = order.indexOf(best) + 1
    const omega = rank / (n + 1)
    const lambda = Math.log(omega / (1 - omega))
    lambdas.push(lambda)
    rankSum += omega
    if (lambda <= 0) overfitCount++

    const x = isMetrics[best]!
    const y = oosMetrics[best]!
    if (y < 0) lossCount++
    sumX += x
    sumY += y
    sumXX += x * x
    sumXY += x * y
  }

  const count = combos.length
  const meanX = sumX / count
  const meanY = sumY / count
  const denom = sumXX - sumX * meanX
  let slope = 0
  if (denom > 0) slope = (sumXY - sumX * meanY) / denom
  const intercept = meanY - slope * meanX

  return {
    pbo: overfitCount / count,
    lambdas,
    combos: count,
    oosRankMean: rankSum / count,
    degradation: { slope, intercept },
    probLossOos: lossCount / count,
  }
}
