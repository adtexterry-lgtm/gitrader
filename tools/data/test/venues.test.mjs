// SPDX-License-Identifier: CPAL-1.0
// 场所注册表：10 个只读数据连接器都能被解析出来、都自报历史分页上限、都没有下单能力；
// 并用注入的假 fetch 跑一次真实连接器（binance）→ 本工具分页 → 落盘，全程离线。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { registerTsShim } from '../lib/ts-shim.mjs'
import { series, tmpDir } from './helpers.mjs'

await registerTsShim()
const { VENUES, VENUE_NAMES, createConnector, historyOf, closeConnector } = await import('../lib/venues.mjs')
const { runFetch } = await import('../lib/fetch-candles.mjs')

/** 最小 Response 替身：binance 连接器只用到 ok / status / headers.get / json / text。 */
function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  }
}

const HOUR = 3_600_000
const FROM = Date.parse('2024-01-01T00:00:00Z')
const TO = FROM + 5 * HOUR

test('注册表覆盖 10 个场所，每个都能构造出连接器并自报 history 分页上限', async () => {
  assert.equal(VENUE_NAMES.length, 10)
  assert.deepEqual(VENUE_NAMES, Object.keys(VENUES).sort())
  for (const venue of VENUE_NAMES) {
    const connector = await createConnector(venue, { fetchImpl: async () => jsonResponse([]) })
    const history = historyOf(connector)
    assert.ok(history.pageLimit > 0, `${venue} pageLimit`)
    assert.ok(history.maxCandles > 0, `${venue} maxCandles`)
    const caps = connector.describe()
    assert.equal(caps.venue, venue)
    assert.equal(caps['x-data-only'], true, `${venue} 应为只读数据源`)
    for (const mode of Object.values(caps.orderTypes)) assert.equal(mode, 'none', `${venue} 不该有下单能力`)
    assert.equal(typeof connector.candles, 'function')
    await closeConnector(connector)
  }
})

test('未知场所报错并列出可选值', async () => {
  await assert.rejects(() => createConnector('nope'), /unknown venue: "nope"; supported: binance/)
})

test('真实 binance 连接器 + 假 fetch：本层续拉拼页 → 规范文件与清单（离线）', async (t) => {
  const dir = tmpDir(t)
  const rows = series({ from: FROM, step: HOUR, count: 6 })
  const requests = []
  // 每次 HTTP 只给 2 根：连接器内部一页就没铺满 1500，于是本层按「末根 + 周期」续拉。
  const fetchImpl = async (url) => {
    const u = new URL(url)
    requests.push(Object.fromEntries(u.searchParams))
    const start = Number(u.searchParams.get('startTime'))
    const end = Number(u.searchParams.get('endTime'))
    const limit = Number(u.searchParams.get('limit'))
    const page = rows.filter((c) => c.t >= start && c.t <= end).slice(0, Math.min(2, limit))
    return jsonResponse(page.map((c) => [c.t, String(c.o), String(c.h), String(c.l), String(c.c), String(c.v)]))
  }

  const out = join(dir, 'btc-1h.json')
  const result = await runFetch(
    { venue: 'binance', instrumentId: 'binance:BTCUSDT', interval: '1h', from: FROM, to: TO, out, maxPages: 200 },
    { connectorOptions: { fetchImpl } },
  )

  assert.equal(result.count, 6)
  assert.equal(result.calls, 3)
  assert.equal(requests.length, 3)
  assert.equal(requests[0].symbol, 'BTCUSDT')
  assert.equal(requests[0].interval, '1h')
  assert.deepEqual(JSON.parse(readFileSync(result.jsonPath, 'utf8')).candles.map((c) => c.t), rows.map((c) => c.t))
  const manifest = JSON.parse(readFileSync(result.manifestPath, 'utf8'))
  assert.equal(manifest.source.venue, 'binance')
  assert.equal(manifest.source.pageLimit, 1500)
  assert.equal(manifest.candles, 6)
})
