// SPDX-License-Identifier: CPAL-1.0
// 落盘：原文 CSV / 规范 JSON（normalizeCandleFile）/ manifest（manifestFor）三件套的形状与 sha256。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { registerTsShim } from '../lib/ts-shim.mjs'
import { fakeConnector, series, tmpDir } from './helpers.mjs'

await registerTsShim()
const { writeCandleFiles, runFetch, outputPaths } = await import('../lib/fetch-candles.mjs')

const HOUR = 3_600_000
const FROM = Date.parse('2024-03-01T00:00:00Z')
const rows = series({ from: FROM, step: HOUR, count: 5 })
const TO = FROM + 4 * HOUR

const options = {
  venue: 'binance', instrumentId: 'binance:BTCUSDT', interval: '1h', from: FROM, to: TO, out: '', maxPages: 200,
}

const sha256 = (buf) => `sha256:${createHash('sha256').update(buf).digest('hex')}`

test('三件套路径：out 决定 json，同名 .csv 与 .manifest.json 落同目录', () => {
  const paths = outputPaths('data/sub/btc-1h.json')
  assert.match(paths.jsonPath, /btc-1h\.json$/)
  assert.match(paths.csvPath, /btc-1h\.csv$/)
  assert.match(paths.manifestPath, /btc-1h\.manifest\.json$/)
  assert.ok(paths.jsonPath.includes(join('data', 'sub')))
})

test('CSV 原文：表头 t,o,h,l,c,v + 一行一根', (t) => {
  const dir = tmpDir(t)
  const written = writeCandleFiles({ candles: rows, options: { ...options, out: join(dir, 'btc-1h.json') } })
  const csv = readFileSync(written.csvPath, 'utf8')
  const lines = csv.trimEnd().split('\n')
  assert.equal(lines[0], 't,o,h,l,c,v')
  assert.equal(lines.length, 6)
  assert.equal(lines[1], [rows[0].t, rows[0].o, rows[0].h, rows[0].l, rows[0].c, rows[0].v].join(','))
})

test('规范 JSON：{ candles: [...] } 升序、字段齐全（normalizeCandleFile 口径）', (t) => {
  const dir = tmpDir(t)
  const written = writeCandleFiles({ candles: rows, options: { ...options, out: join(dir, 'nested/dir/btc-1h.json') } })
  const body = JSON.parse(readFileSync(written.jsonPath, 'utf8'))
  assert.deepEqual(Object.keys(body), ['candles'])
  assert.deepEqual(body.candles, rows)
  assert.equal(written.report.parsed, 5)
  assert.equal(written.report.duplicates, 0)
  assert.equal(written.report.interval.label, '1h')
  assert.equal(written.report.gaps.length, 0)
  assert.equal(written.report.ohlcViolations, 0)
})

test('manifest：sha256 与文件独立计算一致，bytes / format / kind / 绝对路径都对', (t) => {
  const dir = tmpDir(t)
  const written = writeCandleFiles({ candles: rows, options: { ...options, out: join(dir, 'btc-1h.json') } })
  const manifest = JSON.parse(readFileSync(written.manifestPath, 'utf8'))
  const buf = readFileSync(written.jsonPath)
  assert.equal(manifest.version, 1)
  assert.equal(manifest.candles, 5)
  assert.equal(manifest.files.length, 1)
  const entry = manifest.files[0]
  assert.equal(entry.path, written.jsonPath)
  assert.equal(entry.kind, 'candles')
  assert.equal(entry.format, 'json')
  assert.equal(entry.sha256, sha256(buf))
  assert.equal(entry.sha256, written.report.sha256)
  assert.equal(entry.bytes, statSync(written.jsonPath).size)
  assert.equal(entry.bytes, buf.length)
})

test('小数价格与极小值经 CSV 往返仍然逐值相等', (t) => {
  const dir = tmpDir(t)
  const odd = [
    { t: FROM, o: 0.00001234, h: 0.00001235, l: 0.00001233, c: 0.00001234, v: 1e-7 },
    { t: FROM + HOUR, o: 43210.12345678, h: 43210.98765432, l: 43209.5, c: 43210.5, v: 123456.789 },
  ]
  const written = writeCandleFiles({ candles: odd, options: { ...options, out: join(dir, 'odd.json') } })
  assert.deepEqual(JSON.parse(readFileSync(written.jsonPath, 'utf8')).candles, odd)
})

test('manifest 的 source 段记下场所 / 区间 / 连接器自报的分页上限', (t) => {
  const dir = tmpDir(t)
  const written = writeCandleFiles({
    candles: rows,
    options: { ...options, out: join(dir, 'btc-1h.json') },
    history: { pageLimit: 1500, maxCandles: 1500 },
  })
  const manifest = JSON.parse(readFileSync(written.manifestPath, 'utf8'))
  assert.deepEqual(manifest.source, {
    venue: 'binance', instrumentId: 'binance:BTCUSDT', instrument: 'BTCUSDT', interval: '1h',
    from: FROM, to: TO, requestedPages: 200, truncated: false, pageLimit: 1500, maxCandles: 1500,
  })
})

test('runFetch 全流程：假连接器 → 文件齐活 → 连接器被关掉', async (t) => {
  const dir = tmpDir(t)
  const connector = fakeConnector({ rows, pageSize: 2 })
  const out = join(dir, 'out', 'btc-1h.json')
  const result = await runFetch({ ...options, out }, { createConnector: async () => connector })
  assert.equal(result.count, 5)
  assert.equal(result.calls, 3)
  assert.equal(connector.closed, true)
  assert.equal(JSON.parse(readFileSync(result.jsonPath, 'utf8')).candles.length, 5)
  assert.equal(JSON.parse(readFileSync(result.manifestPath, 'utf8')).files[0].sha256, result.report.sha256)
})

test('区间无数据：照样写出空 candles 与清单，报告带警告', async (t) => {
  const dir = tmpDir(t)
  const out = join(dir, 'empty.json')
  const result = await runFetch({ ...options, out }, { createConnector: async () => fakeConnector({ rows: [] }) })
  assert.equal(result.count, 0)
  assert.equal(result.truncated, false)
  assert.deepEqual(JSON.parse(readFileSync(result.jsonPath, 'utf8')), { candles: [] })
  assert.equal(result.report.warnings.includes('no candles parsed'), true)
  assert.equal(JSON.parse(readFileSync(result.manifestPath, 'utf8')).candles, 0)
})

test('maxPages 到顶：落盘 6 根、truncated 透传到返回值与清单 source', async (t) => {
  const dir = tmpDir(t)
  const wide = series({ from: FROM, step: HOUR, count: 10 })
  const out = join(dir, 'partial.json')
  const result = await runFetch(
    { ...options, to: FROM + 9 * HOUR, out, maxPages: 2 },
    { createConnector: async () => fakeConnector({ rows: wide, pageSize: 3 }) },
  )
  assert.equal(result.truncated, true)
  assert.equal(result.count, 6)
  assert.equal(JSON.parse(readFileSync(result.jsonPath, 'utf8')).candles.length, 6)
  const manifest = JSON.parse(readFileSync(result.manifestPath, 'utf8'))
  assert.equal(manifest.candles, 6)
  assert.equal(manifest.source.truncated, true)
  assert.equal(manifest.source.requestedPages, 2)
})
