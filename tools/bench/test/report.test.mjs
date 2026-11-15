// SPDX-License-Identifier: CPAL-1.0
// 报告层单测：JSON 结构、Markdown 关键行、零承诺语言自检、落盘。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildReport, renderMarkdownReport, writeReports, findPromiseWords } from '../lib/report.mjs'

const section = {
  kind: 'backtest',
  bars: 100_000,
  runs: 3,
  dataGenMs: 42.5,
  strategies: [
    { id: 'ema-trend', bars: 100_000, runs: 3, firstMs: 90, warm: { samples: 2, minMs: 60, p50Ms: 70, p95Ms: 80, maxMs: 80 }, barsPerSec: 1_428_571, fills: 1234, trades: 600 },
    { id: 'grid', bars: 100_000, runs: 3, firstMs: 80, warm: { samples: 2, minMs: 50, p50Ms: 55, p95Ms: 60, maxMs: 60 }, barsPerSec: 1_818_181, fills: 900, trades: 400 },
  ],
  warm: { samples: 4, minMs: 50, p50Ms: 60, p95Ms: 80, maxMs: 80 },
  lastStats: null,
}

function sampleReport(overrides = {}) {
  return buildReport({
    params: { bars: 100_000, runs: 3, rounds: 3, renderRounds: 5, strategies: ['ema-cross', 'grid'] },
    env: { node: 'v22.23.2', platform: 'win32 10.0.26200', cpu: 'Test CPU', cores: 24, generatedAt: '2026-10-21T00:00:00.000Z' },
    backtest: section,
    indicators: {
      kind: 'indicators', bars: 100_000, rounds: 3, count: 2, skipped: [],
      items: [
        { name: 'sma(20)', p50Ms: 1.5, p95Ms: 2, barsPerSec: 66_666_667 },
        { name: 'rsi(14)', p50Ms: 3.5, p95Ms: 4, barsPerSec: 28_571_429 },
      ],
      sweepMs: { samples: 2, minMs: 5, p50Ms: 5.5, p95Ms: 6, maxMs: 6 }, throughputPerSec: 36_363_636,
    },
    render: {
      kind: 'render', rounds: 5, points: 5000, trades: 200, digest: 'abcd',
      items: [
        { name: 'markdown', firstMs: 12, p50Ms: 9, p95Ms: 10, bytes: 20_000 },
        { name: 'html', firstMs: 15, p50Ms: 11, p95Ms: 13, bytes: 70_000 },
      ],
    },
    memoryRssMb: 180,
    ...overrides,
  })
}

test('buildReport：判定取最好一条策略的吞吐，未达门槛如实为 false', () => {
  const r = sampleReport()
  assert.equal(r.suite, 'gitrader-tools-bench')
  assert.equal(r.schemaVersion, 1)
  assert.equal(r.verdict.targetBarsPerSec, 1_000_000)
  assert.equal(r.verdict.bestBarsPerSec, 1_818_181)
  assert.equal(r.verdict.backtestTargetMet, true)

  const slow = sampleReport({ backtest: { ...section, strategies: [{ ...section.strategies[0], barsPerSec: 400_000 }] } })
  assert.equal(slow.verdict.backtestTargetMet, false)
  assert.equal(slow.verdict.bestBarsPerSec, 400_000)

  const none = buildReport({ params: {}, env: null })
  assert.equal(none.verdict.backtestTargetMet, null)
  assert.equal(none.verdict.bestBarsPerSec, null)
})

test('renderMarkdownReport：三节齐全、p50 / p95、既有口径对照、复现命令', () => {
  const md = renderMarkdownReport(sampleReport())
  assert.match(md, /^# Gitrader 性能基准（tools\/bench）/m)
  assert.match(md, /## 1\. 回测吞吐/)
  assert.match(md, /## 2\. 指标库吞吐/)
  assert.match(md, /## 3\. 报告渲染耗时/)
  assert.match(md, /\| 策略 \| K 线根数 \| 首次 ms \| 热启 p50 ms \| 热启 p95 ms \| 根 \/ 秒 \| 成交笔数 \|/)
  assert.match(md, /\| ema-trend \| 100000 \| 90 \| 70 \| 80 \|/)
  assert.match(md, /docs\/perf-baseline\.md/)
  assert.match(md, /它的统计量是含首次在内的各轮中位数，本表「根 \/ 秒」是热启 p50/)
  assert.match(md, /同机同代码才可比/)
  assert.match(md, /建议门槛 N = 100 万 根 \/ 秒/)
  assert.match(md, /node tools\/bench\/run\.mjs/)
  assert.match(md, /--bars 525600/)
  assert.match(md, /达到建议门槛/)
  assert.equal(findPromiseWords(md).length, 0, `Markdown 里出现禁词：${findPromiseWords(md).join(', ')}`)
})

test('renderMarkdownReport：缺节时明说未跑，不编数字', () => {
  const md = renderMarkdownReport(buildReport({ params: { bars: 100 }, env: { generatedAt: 'x' }, backtest: null, indicators: null, render: null }))
  assert.match(md, /本次未跑（--only 未包含 backtest）/)
  assert.match(md, /本次未跑（--only 未包含 indicators）/)
  assert.match(md, /本次未跑（--only 未包含 render）/)
  assert.match(md, /本次未跑回测吞吐，无判定/)
})

test('findPromiseWords：命中禁词（中英、大小写不敏感）', () => {
  assert.deepEqual(findPromiseWords('这不是 guaranteed 的'), ['guaranteed'])
  assert.deepEqual(findPromiseWords('Risk-Free 方案'), ['risk-free'])
  assert.deepEqual(findPromiseWords('稳' + '赚' + '不赔'), ['稳' + '赚'])
  assert.deepEqual(findPromiseWords('p50 / p95，全部离线'), [])
})

test('writeReports：JSON 与 Markdown 同目录落盘，JSON 可解析', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bench-report-test-'))
  try {
    const report = sampleReport()
    const out = writeReports(report, { outDir: join(dir, 'nested', 'results') })
    assert.equal(out.mdPath, join(dir, 'nested', 'results', 'bench.md'))
    const parsed = JSON.parse(readFileSync(out.jsonPath, 'utf8'))
    assert.equal(parsed.suite, 'gitrader-tools-bench')
    assert.equal(parsed.backtest.bars, 100_000)
    assert.equal(parsed.verdict.backtestTargetMet, true)
    const md = readFileSync(out.mdPath, 'utf8')
    assert.match(md, /## 1\. 回测吞吐/)
    assert.ok(md.endsWith('\n'), 'Markdown 以换行结尾')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
