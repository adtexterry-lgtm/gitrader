// SPDX-License-Identifier: CPAL-1.0
// 分页拼接：假连接器单页上限小 → 本层用「末根 + 周期」推进游标续拉，结果必须升序、无重复、不越界。
import test from 'node:test'
import assert from 'node:assert/strict'
import { registerTsShim } from '../lib/ts-shim.mjs'
import { fakeConnector, series } from './helpers.mjs'

await registerTsShim()
const { pageCandles } = await import('../lib/fetch-candles.mjs')

const HOUR = 3_600_000
const FROM = Date.parse('2024-01-01T00:00:00Z')
const rows = series({ from: FROM, step: HOUR, count: 10 })
const TO = FROM + 9 * HOUR

const base = { instrumentId: 'binance:BTCUSDT', interval: '1h', from: FROM, to: TO }

test('单页就够：只调用一次，根数与区间完全对上', async () => {
  const connector = fakeConnector({ rows, pageSize: 1000 })
  const out = await pageCandles({ connector, ...base })
  assert.equal(out.calls, 1)
  assert.equal(out.pages, 1)
  assert.equal(out.candles.length, 10)
  assert.deepEqual(out.candles.map((c) => c.t), rows.map((c) => c.t))
})

test('单页上限 3 → 4 次调用拼成完整 10 根，升序无重复', async () => {
  const connector = fakeConnector({ rows, pageSize: 3 })
  const out = await pageCandles({ connector, ...base })
  assert.equal(out.calls, 4)
  assert.equal(out.candles.length, 10)
  assert.deepEqual(out.candles.map((c) => c.t), rows.map((c) => c.t))
  assert.equal(new Set(out.candles.map((c) => c.t)).size, 10)
  // 游标 = 上一页末根 + 周期（与 connector-binance-data/src/market.ts:289 同口径）
  assert.deepEqual(connector.calls.map((c) => c.from), [FROM, FROM + 3 * HOUR, FROM + 6 * HOUR, FROM + 9 * HOUR])
  assert.ok(connector.calls.every((c) => c.to === TO && c.interval === '1h' && c.instrumentId === 'binance:BTCUSDT'))
})

test('连接器把区间外的行也返回时，只留 from..to 之内的根', async () => {
  const wide = series({ from: FROM - 3 * HOUR, step: HOUR, count: 16 })
  const connector = fakeConnector({ rows: wide, pageSize: 1000 })
  const out = await pageCandles({ connector, ...base })
  assert.equal(out.candles.length, 10)
  assert.equal(out.candles[0].t, FROM)
  assert.equal(out.candles.at(-1).t, TO)
})

test('游标不前进时立刻停手，不空转到 maxPages', async () => {
  let served = 0
  const stuck = {
    calls: [],
    describe: () => ({ history: { pageLimit: 3 } }),
    async candles(_id, _iv, opts = {}) {
      this.calls.push(opts)
      served++
      return rows.slice(0, 3) // 永远返回同一页，游标推进不了
    },
    async close() {},
  }
  const out = await pageCandles({ connector: stuck, ...base, maxPages: 50 })
  assert.equal(out.calls, 2)
  assert.equal(served, 2)
  assert.equal(out.candles.length, 3)
})

test('区间里没有数据：一次调用即返回空结果，不抛错', async () => {
  const connector = fakeConnector({ rows: [], pageSize: 10 })
  const out = await pageCandles({ connector, ...base })
  assert.equal(out.calls, 1)
  assert.deepEqual(out.candles, [])
})

test('月线续拉：游标取末根 + 1 ms，单页只回 1 根也不漏整月', async () => {
  const months = [
    Date.parse('2024-02-01T00:00:00Z'),
    Date.parse('2024-03-01T00:00:00Z'),
    Date.parse('2024-04-01T00:00:00Z'),
  ]
  const connector = {
    describe: () => ({ history: { pageLimit: 1 } }),
    async candles(_id, _iv, opts = {}) {
      const t = months.find((m) => m >= opts.from)
      return t === undefined ? [] : [{ t, o: 100, h: 105, l: 95, c: 101, v: 1 }]
    },
    async close() {},
  }
  const out = await pageCandles({ connector, instrumentId: 'binance:BTCUSDT', interval: '1M', from: months[0], to: months[2] })
  assert.equal(out.candles.length, 3)
  assert.deepEqual(out.candles.map((c) => c.t), months)
  assert.equal(out.truncated, false)
})

test('maxPages 用满仍未到 to → truncated: true，落 6 根', async () => {
  const connector = fakeConnector({ rows, pageSize: 3 })
  const out = await pageCandles({ connector, ...base, maxPages: 2 })
  assert.equal(out.truncated, true)
  assert.equal(out.calls, 2)
  assert.equal(out.candles.length, 6)
  assert.deepEqual(out.candles.map((c) => c.t), rows.slice(0, 6).map((c) => c.t))
})

test('正常拉满到 to → truncated: false', async () => {
  const connector = fakeConnector({ rows, pageSize: 3 })
  const out = await pageCandles({ connector, ...base, maxPages: 200 })
  assert.equal(out.truncated, false)
  assert.equal(out.candles.length, 10)
})

test('坏的连接器行为：非数组页 / 没有 candles 方法都报错', async () => {
  const bad = { describe: () => ({}), async candles() { return 'nope' }, async close() {} }
  await assert.rejects(() => pageCandles({ connector: bad, ...base }), /non-array candle page/)
  await assert.rejects(() => pageCandles({ connector: {}, ...base }), /has no candles\(\) method/)
})

test('坏 K 线（缺字段 / NaN）被丢弃，其余照收', async () => {
  const dirty = [
    { t: FROM, o: 100, h: 105, l: 95, c: 101 },
    { t: FROM + HOUR, o: Number.NaN, h: 1, l: 1, c: 1, v: 1 },
    { t: FROM + 2 * HOUR },
    { t: FROM + 3 * HOUR, o: 103, h: 108, l: 98, c: 104, v: 3 },
  ]
  const connector = fakeConnector({ rows: dirty, pageSize: 1000 })
  const out = await pageCandles({ connector, ...base })
  assert.deepEqual(out.candles.map((c) => c.t), [FROM, FROM + 3 * HOUR])
  assert.deepEqual(out.candles[0], { t: FROM, o: 100, h: 105, l: 95, c: 101, v: 0 })
})
