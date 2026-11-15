// SPDX-License-Identifier: CPAL-1.0
// 口径工具的单测：分位数 / 中位数 / 汇总 / 吞吐 / 展示层格式化。
// 只断言算法，不依赖计时（计时的稳定性不是单测能保证的事）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { percentile, median, summarizeMs, perSec, roundTo, humanizeCount } from '../lib/stats.mjs'

test('percentile：最近秩，与 bench/engine 的 pct 同算法', () => {
  const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
  assert.equal(percentile(xs, 0), 1)
  assert.equal(percentile(xs, 0.5), 6) // floor(10 * 0.5) = 5 → 第 6 个
  assert.equal(percentile(xs, 0.95), 10)
  assert.equal(percentile([5], 0.99), 5)
  assert.equal(percentile([3, 1, 2], 0.5), 2) // 不改入参、内部排序
  assert.deepEqual(xs, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  assert.ok(Number.isNaN(percentile([], 0.5)))
  assert.throws(() => percentile(xs, 1.5), RangeError)
})

test('median / summarizeMs：中位数与 p50 / p95 汇总', () => {
  assert.equal(median([3, 1, 2]), 2)
  assert.equal(median([4, 1, 3, 2]), 2.5)
  assert.ok(Number.isNaN(median([])))
  const s = summarizeMs([10, 20, 30, 40])
  assert.equal(s.samples, 4)
  assert.equal(s.minMs, 10)
  assert.equal(s.maxMs, 40)
  assert.equal(s.p50Ms, 30) // floor(4 * 0.5) = 2
  assert.equal(s.p95Ms, 40)
  assert.equal(summarizeMs([]).samples, 0)
})

test('perSec / roundTo / humanizeCount：吞吐与展示层', () => {
  assert.equal(perSec(1_000_000, 1000), 1_000_000)
  assert.equal(perSec(500, 500), 1000)
  assert.ok(Number.isNaN(perSec(1, 0)))
  assert.equal(roundTo(1.23456, 3), 1.235)
  assert.equal(roundTo(Number.NaN, 2), null)
  assert.equal(humanizeCount(12_500_000), '1250 万')
  assert.equal(humanizeCount(2_020_000), '202 万')
  assert.equal(humanizeCount(500_000_000), '5 亿')
  assert.equal(humanizeCount(42), '42')
  assert.equal(humanizeCount(Number.NaN), '—')
})
