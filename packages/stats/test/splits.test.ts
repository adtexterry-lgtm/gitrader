// SPDX-License-Identifier: CPAL-1.0
// splits.ts 的单元测试：切分边界、purge/embargo、walk-forward 与组合枚举。

import { describe, expect, it } from 'vitest'
import { combinations, purgedKFold, walkForward } from '../src/splits'

function range(start: number, end: number): number[] {
  const result: number[] = []
  for (let i = start; i < end; i++) result.push(i)
  return result
}

describe('purgedKFold', () => {
  it('splits 100 samples into 5 folds with purge and embargo', () => {
    const folds = purgedKFold({ n: 100, k: 5, horizon: 3, embargo: 2 })

    expect(folds).toHaveLength(5)
    expect(folds.map((fold) => fold.test)).toEqual([
      [0, 20],
      [20, 40],
      [40, 60],
      [60, 80],
      [80, 100],
    ])
    expect(folds[0]!.train).toEqual(range(22, 100))
    expect(folds[1]!.train).toEqual([...range(0, 18), ...range(42, 100)])
    expect(folds[4]!.train).toEqual(range(0, 78))
  })

  it('gives the first remainder folds one extra sample and uses default purge', () => {
    const folds = purgedKFold({ n: 10, k: 3 })

    expect(folds.map((fold) => fold.test[1] - fold.test[0])).toEqual([4, 3, 3])
    expect(folds.map((fold) => fold.test)).toEqual([
      [0, 4],
      [4, 7],
      [7, 10],
    ])
    expect(folds[1]!.train).toEqual([0, 1, 2, 3, 7, 8, 9])
  })

  it('keeps train disjoint from test and covers every sample exactly once', () => {
    const folds = purgedKFold({ n: 100, k: 5, horizon: 3, embargo: 2 })
    const covered = new Array<boolean>(100).fill(false)

    for (const fold of folds) {
      const [start, end] = fold.test
      const testSet = new Set(range(start, end))

      for (const index of fold.train) {
        expect(testSet.has(index)).toBe(false)
      }
      for (let i = start; i < end; i++) {
        expect(covered[i]).toBe(false)
        covered[i] = true
      }
    }

    expect(covered.every(Boolean)).toBe(true)
  })

  it('rejects invalid parameters', () => {
    expect(() => purgedKFold({ n: 3, k: 5 })).toThrow(RangeError)
    expect(() => purgedKFold({ n: 10, k: 1 })).toThrow(RangeError)
  })
})

describe('walkForward', () => {
  it('rolls a fixed-length training window forward', () => {
    const windows = walkForward({ n: 100, trainLen: 50, testLen: 10 })

    expect(windows).toHaveLength(5)
    expect(windows[0]).toEqual({ train: [0, 50], test: [50, 60] })
    expect(windows[1]).toEqual({ train: [10, 60], test: [60, 70] })
    expect(windows[windows.length - 1]!.test).toEqual([90, 100])
  })

  it('anchors the training window at zero', () => {
    const windows = walkForward({
      n: 100,
      trainLen: 50,
      testLen: 10,
      anchored: true,
    })

    for (const window of windows) {
      expect(window.train[0]).toBe(0)
    }
    expect(windows[2]!.train).toEqual([0, 70])
  })

  it('honours a custom step and drops windows past the sample end', () => {
    const windows = walkForward({ n: 105, trainLen: 50, testLen: 10, step: 20 })

    expect(windows.map((window) => window.test)).toEqual([
      [50, 60],
      [70, 80],
      [90, 100],
    ])
  })

  it('rejects invalid parameters', () => {
    expect(() => walkForward({ n: 20, trainLen: 15, testLen: 10 })).toThrow(
      RangeError,
    )
  })
})

describe('combinations', () => {
  it('enumerates combinations in lexicographic order', () => {
    expect(combinations(4, 2)).toEqual([
      [0, 1],
      [0, 2],
      [0, 3],
      [1, 2],
      [1, 3],
      [2, 3],
    ])
    expect(combinations(16, 8)).toHaveLength(12870)
    expect(combinations(3, 0)).toEqual([[]])
    expect(combinations(2, 3)).toEqual([])
  })
})
