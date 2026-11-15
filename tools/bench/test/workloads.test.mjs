// SPDX-License-Identifier: CPAL-1.0
// 三个负载的小规模冒烟：真的走 esbuild 打包工作区 TS，真的调 engine-core / 指标库 / report，
// 但只用几百根 K 线——单测不跑 10 万根全量（那是 run.mjs 的活）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadBenchDeps, repoRoot } from '../lib/loader.mjs'
import { synthCandles, syntheticResult } from '../lib/dataset.mjs'
import { benchBacktest } from '../workloads/backtest.mjs'
import { benchIndicators } from '../workloads/indicators.mjs'
import { benchRender } from '../workloads/render.mjs'

const root = repoRoot()
const deps = await loadBenchDeps(root)
const candles = synthCandles({ n: 400, seed: 1, intervalMs: 60_000 })

const emaCross = await deps.core.loadStrategyFile(join(root, 'packages', 'engine-core', 'test', 'fixtures', 'strategies', 'ema-cross.ts'))

test('benchBacktest：示例策略 400 根小规模跑通，吞吐为正、成交可复现', async () => {
  assert.equal(emaCross.errors.length, 0, `策略加载报错：${JSON.stringify(emaCross.errors)}`)
  const r = await benchBacktest({ core: deps.core, strategies: [{ id: emaCross.def.id, def: emaCross.def, params: emaCross.def.defaults }], candles, runs: 2 })
  assert.equal(r.kind, 'backtest')
  assert.equal(r.bars, 400)
  assert.equal(r.strategies.length, 1)
  const s = r.strategies[0]
  assert.ok(s.firstMs >= 0)
  assert.ok(s.barsPerSec > 0, 'barsPerSec 必须为正')
  assert.ok(Number.isInteger(s.fills) && s.fills >= 0, 'fills 必须是整数')
  assert.equal(s.warm.samples, 1, 'runs=2 → 1 个热启样本')
  assert.equal(r.warm.samples, 1)

  const again = await benchBacktest({ core: deps.core, strategies: [{ id: emaCross.def.id, def: emaCross.def, params: emaCross.def.defaults }], candles, runs: 1 })
  assert.equal(again.strategies[0].fills, s.fills, '同一份数据 + 同一策略 → 成交笔数一致')
  assert.equal(again.strategies[0].warm.samples, 1, 'runs=1 时用该轮作热启样本（报告中注明含预热）')

  await assert.rejects(benchBacktest({ core: deps.core, strategies: [], candles }), /至少给一个策略/)
  await assert.rejects(benchBacktest({ core: deps.core, strategies: [{ id: 'x', def: emaCross.def }], candles: [] }), /K 线不足/)
})

test('benchIndicators：真实指标库 300 根跑通，坏用例记进 skipped 不崩', async () => {
  const small = candles.slice(0, 300)
  const r = await benchIndicators({
    ta: deps.ta,
    candles: small,
    rounds: 2,
    cases: [
      { name: 'sma(20)', fn: (ta, { closes }) => ta.sma(closes, 20) },
      { name: 'ema(20)', fn: (ta, { closes }) => ta.ema(closes, 20) },
      { name: 'atr(14)', fn: (ta, { bars }) => ta.atr(bars, 14) },
    ],
  })
  assert.equal(r.kind, 'indicators')
  assert.equal(r.bars, 300)
  assert.equal(r.count, 3)
  assert.deepEqual(r.skipped, [])
  assert.ok(r.throughputPerSec > 0, '合计吞吐必须为正')
  assert.ok(r.sweepMs.p50Ms >= 0)
  for (const it of r.items) {
    assert.ok(it.barsPerSec > 0, `${it.name} 吞吐必须为正`)
    assert.ok(it.warm.samples === 1)
  }
  // 按吞吐降序
  assert.deepEqual(r.items.map((i) => i.name), [...r.items].sort((a, b) => b.barsPerSec - a.barsPerSec).map((i) => i.name))

  const withBad = await benchIndicators({
    ta: deps.ta,
    candles: small,
    rounds: 1,
    cases: [
      { name: 'sma(20)', fn: (ta, { closes }) => ta.sma(closes, 20) },
      { name: 'not-an-indicator', fn: () => { throw new Error('no such export') } },
    ],
  })
  assert.equal(withBad.count, 1)
  assert.equal(withBad.skipped.length, 1)
  assert.equal(withBad.skipped[0].name, 'not-an-indicator')
  assert.match(withBad.skipped[0].reason, /no such export/)
})

test('benchRender：Markdown / HTML / both 三样都出字节，输入相同结果相同', async () => {
  const result = syntheticResult({ points: 200, trades: 20, seed: 7 })
  const r = await benchRender({ report: deps.report, result, rounds: 2 })
  assert.equal(r.kind, 'render')
  assert.equal(r.points, 200)
  assert.equal(r.trades, 20)
  assert.deepEqual(r.items.map((i) => i.name), ['markdown', 'html', 'both'])
  const [md, html, both] = r.items
  assert.ok(md.bytes > 1000, 'Markdown 至少 1 KB')
  assert.ok(html.bytes > md.bytes, 'HTML 应比 Markdown 大')
  assert.ok(both.bytes >= html.bytes, 'both 至少含 HTML 的长度')
  assert.equal(typeof r.digest, 'string')
  assert.ok(r.digest.length > 0)
  for (const it of r.items) {
    assert.ok(it.p50Ms >= 0)
    assert.ok(Number.isFinite(it.firstMs))
  }

  // 同一输入重复渲染：字节数与 digest 不变（纯函数，没有掺时间戳）
  const again = await benchRender({ report: deps.report, result, rounds: 2 })
  assert.equal(again.items[0].bytes, md.bytes)
  assert.equal(again.digest, r.digest)

  // 报告层自己出的 Markdown 也不许出现禁词（端到端再查一次）
  const { findPromiseWords } = await import('../lib/report.mjs')
  const text = readFileSync(join(root, 'tools', 'bench', 'README.md'), 'utf8')
  assert.equal(findPromiseWords(text).length, 0, `README 出现禁词：${findPromiseWords(text).join(', ')}`)
})
