// SPDX-License-Identifier: CPAL-1.0
// 合成数据的单测：确定性、形状、合成回测结果的字段形态（渲染基准的输入）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mulberry32, synthCandles, closesOf, syntheticResult } from '../lib/dataset.mjs'

test('synthCandles：同种子同结果，异种子不同，K 线形状合法', () => {
  const a = synthCandles({ n: 500, seed: 1, intervalMs: 60_000 })
  const b = synthCandles({ n: 500, seed: 1, intervalMs: 60_000 })
  const c = synthCandles({ n: 500, seed: 2, intervalMs: 60_000 })
  assert.deepEqual(a, b)
  assert.notDeepEqual(a, c)
  assert.equal(a.length, 500)
  for (let i = 0; i < a.length; i++) {
    const k = a[i]
    assert.ok(k.c > 0, 'close 必须为正')
    assert.ok(k.h >= Math.max(k.o, k.c), 'high 不低于 open / close')
    assert.ok(k.l <= Math.min(k.o, k.c), 'low 不高于 open / close')
    assert.ok(k.v > 0, 'volume 必须为正')
    if (i > 0) assert.equal(k.t - a[i - 1].t, 60_000, '时间戳等步长')
  }
  assert.deepEqual(closesOf(a).slice(0, 3), a.slice(0, 3).map((k) => k.c))
})

test('mulberry32：输出落在 [0,1)，同种子可复现', () => {
  const r1 = mulberry32(42)
  const r2 = mulberry32(42)
  for (let i = 0; i < 100; i++) {
    const x = r1()
    assert.ok(x >= 0 && x < 1)
    assert.equal(x, r2())
  }
})

test('syntheticResult：确定性、字段形态与 stats 自洽', () => {
  const r1 = syntheticResult({ points: 300, trades: 20, seed: 7 })
  const r2 = syntheticResult({ points: 300, trades: 20, seed: 7 })
  assert.deepEqual(r1, r2)
  assert.equal(r1.equity.length, 300)
  assert.equal(r1.trades.length, 20)
  assert.equal(r1.stats.finalEquity, r1.equity[r1.equity.length - 1].v)
  assert.ok(r1.stats.maxDrawdownRatio <= 0)
  assert.ok(Number.isFinite(r1.stats.totalReturnRatio))
  for (const t of r1.trades) {
    assert.ok(t.side === 'buy' || t.side === 'sell')
    assert.ok(t.price > 0 && t.size > 0 && t.fee >= 0)
    assert.equal(typeof t.t, 'number')
  }
  // 时间戳落在权益曲线的覆盖范围内（渲染按 t 分月不会越界）
  const last = r1.equity[r1.equity.length - 1].t
  for (const t of r1.trades) assert.ok(t.t >= r1.equity[0].t && t.t <= last)
})
