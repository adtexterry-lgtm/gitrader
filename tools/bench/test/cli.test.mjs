// SPDX-License-Identifier: CPAL-1.0
// CLI 单测：参数解析、错误退出码、以及一条端到端的真跑（400 根，只跑回测）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs, main, strategyPath, DEFAULT_STRATEGIES } from '../run.mjs'
import { repoRoot } from '../lib/loader.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const runPath = resolve(here, '..', 'run.mjs')

test('parseArgs：默认值、显式参数、非法参数', () => {
  const d = parseArgs([])
  assert.equal(d.bars, 100_000)
  assert.equal(d.runs, 3)
  assert.equal(d.rounds, 3)
  assert.equal(d.renderRounds, 5)
  assert.deepEqual(d.strategies, [...DEFAULT_STRATEGIES])
  assert.deepEqual(d.only, ['backtest', 'indicators', 'render'])
  assert.equal(d.quiet, false)
  assert.ok(d.out.endsWith(join('tools', 'bench', 'results')))

  const c = parseArgs(['--bars', '525600', '--runs', '5', '--strategies', 'ema-cross,dca', '--only', 'render', '--quiet'])
  assert.equal(c.bars, 525_600)
  assert.equal(c.runs, 5)
  assert.deepEqual(c.strategies, ['ema-cross', 'dca'])
  assert.deepEqual(c.only, ['render'])
  assert.equal(c.quiet, true)

  assert.throws(() => parseArgs(['--bogus']), /未知参数 --bogus/)
  assert.throws(() => parseArgs(['--only', 'backtest,nope']), /--only 只认/)
  assert.throws(() => parseArgs(['--bars', '0']), /需要正数/)
  assert.throws(() => parseArgs(['--bars']), /缺少值/)
})

test('main：参数错误返回 2 并打用法，不打包工作区', async () => {
  let out = ''
  let err = ''
  const code = await main(['--nope'], { stdout: (s) => { out += s }, stderr: (s) => { err += s } })
  assert.equal(code, 2)
  assert.match(err, /未知参数 --nope/)
  assert.match(err, /node tools\/bench\/run\.mjs/)
  assert.equal(out, '')

  let helpOut = ''
  const help = await main(['--help'], { stdout: (s) => { helpOut += s }, stderr: () => {} })
  assert.equal(help, 0)
  assert.match(helpOut, /--render-rounds/)
})

test('strategyPath：ema-cross 走夹具，其余走教学示例', () => {
  const root = repoRoot()
  assert.ok(strategyPath(root, 'ema-cross').includes(join('test', 'fixtures', 'strategies')))
  assert.ok(strategyPath(root, 'grid').endsWith(join('examples', 'strategies', 'grid.ts')))
  assert.ok(existsSync(strategyPath(root, 'grid')))
  assert.ok(existsSync(strategyPath(root, 'ema-cross')))
})

test('DEFAULT_STRATEGIES：与 bench/engine/run.mjs 同五个、同顺序', () => {
  assert.deepEqual([...DEFAULT_STRATEGIES], ['ema-cross', 'mean-reversion', 'breakout', 'grid', 'dca'])
})

test('strategyPath：默认五个策略的文件都存在', () => {
  const root = repoRoot()
  for (const name of DEFAULT_STRATEGIES) {
    assert.ok(existsSync(strategyPath(root, name)), `${name} 的策略文件不存在：${strategyPath(root, name)}`)
  }
})

test('端到端：node run.mjs --bars 400 --only backtest 跑通并落盘 JSON + Markdown', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bench-cli-test-'))
  try {
    const r = spawnSync(
      process.execPath,
      [runPath, '--bars', '400', '--runs', '1', '--only', 'backtest', '--quiet', '--out', dir],
      { cwd: repoRoot(), encoding: 'utf8', timeout: 180_000 },
    )
    assert.equal(r.status, 0, `退出码 ${r.status}\nstdout:${r.stdout}\nstderr:${r.stderr}`)
    const jsonPath = join(dir, 'bench.json')
    const mdPath = join(dir, 'bench.md')
    assert.ok(existsSync(jsonPath))
    assert.ok(existsSync(mdPath))
    const report = JSON.parse(readFileSync(jsonPath, 'utf8'))
    assert.equal(report.suite, 'gitrader-tools-bench')
    assert.equal(report.params.bars, 400)
    assert.equal(report.backtest.bars, 400)
    assert.equal(report.backtest.strategies.length, 5)
    assert.ok(report.backtest.strategies.every((s) => s.barsPerSec > 0))
    assert.equal(report.indicators, null, '--only backtest 时指标节不跑')
    assert.equal(report.render, null)
    assert.equal(typeof report.memoryRssMb, 'number')
    assert.ok(Number.isFinite(report.dataGenMs))
    const md = readFileSync(mdPath, 'utf8')
    assert.match(md, /本次未跑（--only 未包含 indicators）/)
    assert.match(md, /本次未跑（--only 未包含 render）/)
    assert.match(md, /\| ema-trend \| 400 \|/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
