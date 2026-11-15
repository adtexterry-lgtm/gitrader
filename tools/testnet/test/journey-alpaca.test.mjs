// SPDX-License-Identifier: CPAL-1.0
// alpaca 旅程的离线验收：真连接器（esbuild 临时 ESM）+ 本包假 Alpaca（进程内 fetch，不开端口），不联网。
// 与 test/journey-<venue>.test.mjs 同口径三例（完整旅程 / 缺密钥退出 3 且零请求 / 下单端点失败退出 1 不回显密钥），
// 外加一例：实盘密钥前缀（AK）配模拟盘 → 构造期拒绝、零请求（美股八条 7）。
import assert from 'node:assert/strict'
import test from 'node:test'
import { loadBundle } from '../lib/load-connector.mjs'
import { STEP_NAMES, parseJsonOutput } from './support/harness.mjs'

const FAKE_PATH = 'packages/connector-alpaca-trade/test/helpers/fake-alpaca.ts'

/** 起一个假 Alpaca（进程内 fetch）+ 跑一遍旅程；夹具里的 AAPL 多头与旧挂单先清掉（旅程要求账户干净）。 */
async function runJourney(options = {}) {
  const { fake: mod } = await loadBundle({ fake: FAKE_PATH })
  const server = new mod.FakeAlpaca()
  server.positions = []
  server.openOrders = []
  options.prepare?.(server, mod)
  const journey = await import('../journey-alpaca.mjs')
  const lines = []
  const fetchImpl = options.fetchWrap ? options.fetchWrap(server.fetch) : server.fetch
  const code = await journey.main(options.argv ?? ['--json'], {
    env: options.env ?? { ALPACA_PAPER_API_KEY: mod.API_KEY, ALPACA_PAPER_API_SECRET: mod.API_SECRET },
    stdout: (line) => lines.push(line),
    stderr: (line) => lines.push(line),
    fetchImpl,
    // 2026-10-21T14:00Z = 10:00 ET（常规时段内）：时段判定可复现，no serendipity。
    clock: () => mod.NOW,
  })
  return { code, lines, text: lines.join('\n'), steps: parseJsonOutput(lines), server, mod }
}

const orderWrites = (server, method) => server.calls.filter((call) => call.method === method && call.path.startsWith('/v2/orders'))

test('alpaca：假服务器上跑完整旅程，13 步全过并打到对的端点', async () => {
  const { code, text, steps, server, mod } = await runJourney()
  assert.equal(code, 0, text)
  assert.equal(steps.ok, true)
  assert.deepEqual(steps.steps.map((step) => step.name), STEP_NAMES)
  assert.deepEqual(steps.steps.filter((step) => !step.ok).map((step) => `${step.name}:${step.receipt}`), [])
  // 改单：Alpaca 声明 amend=native，这一步必须真跑（receipt 是「旧价 -> 新价」，不是 skipped:）。
  const amend = steps.steps.find((step) => step.name === 'amend')
  assert.equal(amend.ok, true)
  assert.doesNotMatch(amend.receipt, /^skipped:/)

  // 端点：下单（限价 + 触发各一张）、改单、撤单（两张）都得走对。
  assert.ok(server.callsFor('POST', '/v2/orders').length >= 2, '限价单与触发单都应 POST /v2/orders')
  assert.ok(orderWrites(server, 'PATCH').length >= 1, 'amend 应走 PATCH /v2/orders/{id}')
  assert.ok(orderWrites(server, 'DELETE').length >= 2, '两张单都要 DELETE /v2/orders/{id}')
  assert.ok(server.callsFor('GET', '/v2/calendar').length >= 1, 'start() 应拉交易日历')
  assert.ok(server.calls.some((call) => call.host.startsWith('data.')), '参考价应走数据 API 快照')

  // 鉴权是请求头密钥对（不是 HMAC），且只打模拟盘基址。
  const trading = server.calls.filter((call) => !call.host.startsWith('data.'))
  assert.ok(trading.length >= 8, '应有一串交易请求')
  assert.deepEqual(trading.filter((call) => call.headers['apca-api-key-id'] !== mod.API_KEY).map((call) => `${call.method} ${call.path}`), [])
  assert.deepEqual(trading.filter((call) => call.host === 'api.alpaca.markets').map((call) => `${call.method} ${call.path}`), [], '不打实盘主机 api.alpaca.markets')
  assert.ok(trading.every((call) => call.host === 'paper-api.alpaca.markets'), '交易请求全打 paper-api.alpaca.markets')
  assert.ok(!text.includes(mod.API_KEY) && !text.includes(mod.API_SECRET), '输出里不得出现密钥原文')
})

test('alpaca：没有密钥时退出 3，不发任何请求，也不回显值', async () => {
  const { code, text, server } = await runJourney({ argv: [], env: {} })
  assert.equal(code, 3, text)
  assert.equal(server.calls.length, 0, '缺密钥时不应该发任何请求')
  assert.match(text, /缺少密钥环境变量/)
  assert.match(text, /ALPACA_PAPER_API_KEY/)
  assert.match(text, /ALPACA_PAPER_API_SECRET/)
  assert.match(text, /本脚本不发任何请求/)
})

test('alpaca：下单端点失败时退出 1，打印脱敏 Problem，后续步骤标 skipped', async () => {
  const { code, text, steps, mod } = await runJourney({
    fetchWrap: (inner) => async (input, init) => {
      const method = (init?.method ?? 'GET').toUpperCase()
      if (method === 'POST' && new URL(String(input)).pathname === '/v2/orders') {
        return new Response('upstream down', { status: 503 })
      }
      return inner(input, init)
    },
  })
  assert.equal(code, 1, text)
  assert.equal(steps.failedStep, 'place-limit')
  const place = steps.steps.find((step) => step.name === 'place-limit')
  assert.equal(place.ok, false)
  assert.equal(typeof place.problem.name, 'string')
  assert.ok(steps.steps.slice(steps.steps.indexOf(place) + 1).every((step) => step.skipped))
  assert.ok(!text.includes(mod.API_KEY) && !text.includes(mod.API_SECRET), '输出里不得出现密钥原文')

  // 人读模式（不带 --json）要把脱敏 Problem 打在 stderr 上。
  const readable = await runJourney({
    argv: [],
    fetchWrap: (inner) => async (input, init) => {
      const method = (init?.method ?? 'GET').toUpperCase()
      if (method === 'POST' && new URL(String(input)).pathname === '/v2/orders') {
        return new Response('upstream down', { status: 503 })
      }
      return inner(input, init)
    },
  })
  assert.equal(readable.code, 1)
  assert.match(readable.text, /Problem: /)
  assert.match(readable.text, /失败于「place-limit」/)
  assert.ok(!readable.text.includes(readable.mod.API_KEY) && !readable.text.includes(readable.mod.API_SECRET), '人读模式也不得回显密钥原文')
})

test('alpaca：实盘密钥前缀 AK 配模拟盘 → 构造期拒绝，退出 1 且零请求', async () => {
  const { fake: mod } = await loadBundle({ fake: FAKE_PATH })
  const { code, text, server } = await runJourney({
    env: { ALPACA_PAPER_API_KEY: mod.LIVE_API_KEY, ALPACA_PAPER_API_SECRET: mod.API_SECRET },
  })
  assert.equal(code, 1, text)
  assert.match(text, /连接器构造失败/)
  assert.equal(server.calls.length, 0, '前缀不符不该发出任何请求')
  assert.ok(!text.includes(mod.LIVE_API_KEY) && !text.includes(mod.API_SECRET), '拒绝信息里不得回显密钥原文')
})
