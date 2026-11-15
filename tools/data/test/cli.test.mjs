// SPDX-License-Identifier: CPAL-1.0
// CLI：退出码约定（0 / 1 / 2）、摘要内容；inspect.mjs 作为 @gitrader/data-files run 的薄封装也能直接跑。
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { registerTsShim } from '../lib/ts-shim.mjs'
import { fakeConnector, series, tmpDir } from './helpers.mjs'

await registerTsShim()
const { main } = await import('../lib/cli.mjs')

const HOUR = 3_600_000
const FROM = Date.parse('2024-05-01T00:00:00Z')
const rows = series({ from: FROM, step: HOUR, count: 4 })

function captured() {
  const io = { out: '', err: '' }
  return {
    io,
    stdout: (text) => { io.out += text },
    stderr: (text) => { io.err += text },
  }
}

const argvFor = (dir) => [
  '--venue', 'binance', '--instrument', 'BTCUSDT', '--interval', '1h',
  '--from', String(FROM), '--to', String(FROM + 3 * HOUR), '--out', join(dir, 'btc-1h.json'),
]

test('无参数 → 退出码 2，用法写 stderr', async () => {
  const c = captured()
  assert.equal(await main([], { stdout: c.stdout, stderr: c.stderr }), 2)
  assert.match(c.io.err, /usage: node tools\/data\/fetch-candles\.mjs/)
})

test('--help → 退出码 0，用法写 stdout', async () => {
  const c = captured()
  assert.equal(await main(['--help'], { stdout: c.stdout, stderr: c.stderr }), 0)
  assert.match(c.io.out, /--venue/)
  assert.match(c.io.out, /--max-pages/)
})

test('用法错误 → 退出码 2，错误行在前', async () => {
  const c = captured()
  const code = await main(['--venue', 'binance', '--instrument', 'BTCUSDT', '--interval', '9h', '--from', '1', '--out', 'a.json'], {
    stdout: c.stdout, stderr: c.stderr,
  })
  assert.equal(code, 2)
  assert.match(c.io.err, /^unknown interval: 9h/)
})

test('成功 → 退出码 0，摘要含根数 / sha256 / 清单路径', async (t) => {
  const dir = tmpDir(t)
  const c = captured()
  const code = await main(argvFor(dir), { stdout: c.stdout, stderr: c.stderr }, {
    createConnector: async () => fakeConnector({ rows, pageSize: 1000 }),
  })
  assert.equal(code, 0)
  assert.match(c.io.out, /^venue\s+binance$/m)
  assert.match(c.io.out, /^candles\s+4（1 页 \/ 1 次调用）$/m)
  assert.match(c.io.out, /^sha256\s+sha256:[0-9a-f]{64}$/m)
  assert.match(c.io.out, /^manifest\s+.*btc-1h\.manifest\.json$/m)
  assert.equal(c.io.err, '')
})

test('maxPages 到顶：退出码仍 0，stderr 给 --max-pages 截断警告', async (t) => {
  const dir = tmpDir(t)
  const wide = series({ from: FROM, step: HOUR, count: 10 })
  const c = captured()
  const code = await main(
    [
      '--venue', 'binance', '--instrument', 'BTCUSDT', '--interval', '1h',
      '--from', String(FROM), '--to', String(FROM + 9 * HOUR), '--out', join(dir, 'partial.json'),
      '--max-pages', '2',
    ],
    { stdout: c.stdout, stderr: c.stderr },
    { createConnector: async () => fakeConnector({ rows: wide, pageSize: 3 }) },
  )
  assert.equal(code, 0)
  assert.match(c.io.out, /^candles\s+6（2 页 \/ 2 次调用）$/m)
  assert.match(c.io.err, /stopped after --max-pages 2 continuation calls/)
  assert.match(c.io.err, /may not reach --to/)
})

test('连接器抛错 → 退出码 1，错误脱敏成一行', async (t) => {
  const dir = tmpDir(t)
  const c = captured()
  const code = await main(argvFor(dir), { stdout: c.stdout, stderr: c.stderr }, {
    createConnector: async () => {
      throw new Error('upstream said no')
    },
  })
  assert.equal(code, 1)
  assert.match(c.io.err, /^error: upstream said no$/m)
  assert.equal(c.io.out, '')
})

test('inspect.mjs 是 data-files run 的薄封装：help 0 / inspect 能出报告 / 坏命令 2', (t) => {
  const dir = tmpDir(t)
  const file = join(dir, 'sample.json')
  const body = { candles: rows }
  writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`, 'utf8')
  const script = join(import.meta.dirname, '..', 'inspect.mjs')

  const help = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8' })
  assert.equal(help.status, 0)
  assert.match(help.stdout, /usage: data-files <command>/)

  const report = spawnSync(process.execPath, [script, 'inspect', file], { encoding: 'utf8' })
  assert.equal(report.status, 0)
  assert.match(report.stdout, /^sha256: sha256:[0-9a-f]{64}$/m)
  assert.match(report.stdout, /candles/)

  const manifest = spawnSync(process.execPath, [script, 'manifest', file], { encoding: 'utf8' })
  assert.equal(manifest.status, 0)
  assert.match(manifest.stdout, /^\s+kind: candles$/m)

  const bad = spawnSync(process.execPath, [script, 'bogus'], { encoding: 'utf8' })
  assert.equal(bad.status, 2)
})

test('fetch-candles.mjs 入口可执行：--help 0，缺参数 2', (t) => {
  const script = join(import.meta.dirname, '..', 'fetch-candles.mjs')
  const help = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8' })
  assert.equal(help.status, 0)
  assert.match(help.stdout, /--instrument/)

  const missing = spawnSync(process.execPath, [script, '--venue', 'binance'], { encoding: 'utf8' })
  assert.equal(missing.status, 2)
  assert.match(missing.stderr, /--instrument is required/)
})

test('失败时不留半截 JSON：清单与 json 只在成功后存在', async (t) => {
  const dir = tmpDir(t)
  const out = join(dir, 'never.json')
  const c = captured()
  const code = await main(
    ['--venue', 'binance', '--instrument', 'BTCUSDT', '--interval', '1h', '--from', String(FROM), '--to', String(FROM + HOUR), '--out', out],
    { stdout: c.stdout, stderr: c.stderr },
    { createConnector: async () => ({ describe: () => ({}), candles: async () => { throw new Error('boom') }, close: async () => {} }) },
  )
  assert.equal(code, 1)
  assert.throws(() => readFileSync(out, 'utf8'), /ENOENT/)
})
