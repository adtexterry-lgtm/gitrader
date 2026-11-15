// SPDX-License-Identifier: CPAL-1.0
// 时间序列切分：purged K-fold、walk-forward 窗口与组合枚举。

export interface Fold {
  test: [number, number]
  train: number[]
}

export interface Window {
  train: [number, number]
  test: [number, number]
}

export function purgedKFold(opts: {
  n: number
  k: number
  horizon?: number
  embargo?: number
}): Fold[] {
  const { n, k } = opts
  const horizon = opts.horizon ?? 1
  const embargo = opts.embargo ?? 0

  if (n < k) throw new RangeError('n must be greater than or equal to k')
  if (k < 2) throw new RangeError('k must be at least 2')
  if (horizon < 1) throw new RangeError('horizon must be at least 1')
  if (embargo < 0) throw new RangeError('embargo must be non-negative')

  const base = Math.floor(n / k)
  const remainder = n % k
  const folds: Fold[] = []
  let a = 0

  for (let f = 0; f < k; f++) {
    const size = base + (f < remainder ? 1 : 0)
    const b = a + size
    const train: number[] = []

    for (let i = 0; i < n; i++) {
      const overlapsTest = i + horizon - 1 >= a && i < b + embargo
      if (!overlapsTest) train.push(i)
    }

    folds.push({ test: [a, b], train })
    a = b
  }

  return folds
}

export function walkForward(opts: {
  n: number
  trainLen: number
  testLen: number
  step?: number
  anchored?: boolean
}): Window[] {
  const { n, trainLen, testLen } = opts
  const step = opts.step ?? testLen
  const anchored = opts.anchored ?? false

  if (trainLen < 1) throw new RangeError('trainLen must be at least 1')
  if (testLen < 1) throw new RangeError('testLen must be at least 1')
  if (step < 1) throw new RangeError('step must be at least 1')
  if (trainLen + testLen > n) {
    throw new RangeError('trainLen + testLen must not exceed n')
  }

  const windows: Window[] = []
  let testStart = trainLen

  while (testStart + testLen <= n) {
    const testEnd = testStart + testLen
    const trainStart = anchored ? 0 : testStart - trainLen
    windows.push({
      train: [trainStart, testStart],
      test: [testStart, testEnd],
    })
    testStart += step
  }

  return windows
}

export function combinations(n: number, k: number): number[][] {
  if (k > n || k < 0) return []
  if (k === 0) return [[]]

  const result: number[][] = []
  const current: number[] = []

  const build = (start: number): void => {
    if (current.length === k) {
      result.push([...current])
      return
    }

    const remaining = k - current.length
    for (let i = start; i <= n - remaining; i++) {
      current.push(i)
      build(i + 1)
      current.pop()
    }
  }

  build(0)
  return result
}
