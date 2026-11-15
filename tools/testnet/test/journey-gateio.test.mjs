// SPDX-License-Identifier: CPAL-1.0
// gateio 旅程的离线验收：真连接器（esbuild 临时 ESM）+ 本包假服务器，不联网。
import assert from 'node:assert/strict'
import test from 'node:test'
import { HARNESS, STEP_NAMES, runJourneyFor } from './support/harness.mjs'

const VENUE = 'gateio'
const CREATE_PATH = HARNESS[VENUE].createPath

test('gateio：假服务器上跑完整旅程，13 步全过并打到对的端点', async () => {
  const { code, lines, steps, fake } = await runJourneyFor(VENUE)
  assert.equal(code, 0, lines.join('\n'))
  assert.equal(steps.ok, true)
  assert.deepEqual(steps.steps.map((step) => step.name), STEP_NAMES)
  assert.deepEqual(steps.steps.filter((step) => !step.ok).map((step) => `${step.name}:${step.receipt}`), [])
  assert.ok(fake.callsFor('POST', CREATE_PATH).length >= 1)
  assert.ok(fake.callsFor('POST', '/api/v4/futures/usdt/price_orders').length >= 1, '触发单应走 price_orders')
  assert.ok(fake.deleted.length >= 1, '普通单应用 DELETE /orders/{id} 撤掉')
  assert.ok(fake.deletedTriggers.length >= 1, '触发单应用 DELETE /price_orders/{id} 撤掉')
})

test('gateio：没有密钥时退出 3，不发任何请求，也不回显值', async () => {
  let calls = 0
  const { code, lines } = await runJourneyFor(VENUE, {
    argv: [],
    env: {},
    fetchWrap: (inner) => async (input, init) => { calls += 1; return inner(input, init) },
  })
  assert.equal(code, 3, lines.join('\n'))
  assert.equal(calls, 0, '缺密钥时不应该发任何请求')
  const text = lines.join('\n')
  assert.match(text, /GATE_TESTNET_API_KEY/)
  assert.match(text, /GATE_TESTNET_API_SECRET/)
  assert.match(text, /缺少密钥环境变量/)
})

test('gateio：下单端点失败时退出 1，打印脱敏 Problem，后续步骤标 skipped', async () => {
  const { code, lines, steps, mod } = await runJourneyFor(VENUE, {
    fetchWrap: (inner) => async (input, init) => {
      const method = (init?.method ?? 'GET').toUpperCase()
      const path = new URL(String(input)).pathname
      if (method === 'POST' && path === CREATE_PATH) return new Response('upstream down', { status: 503 })
      return inner(input, init)
    },
  })
  assert.equal(code, 1, lines.join('\n'))
  assert.equal(steps.failedStep, 'place-limit')
  const place = steps.steps.find((step) => step.name === 'place-limit')
  assert.equal(place.ok, false)
  assert.equal(typeof place.problem.name, 'string')
  assert.ok(steps.steps.slice(steps.steps.indexOf(place) + 1).every((step) => step.skipped))
  const text = lines.join('\n')
  for (const secret of [mod.API_KEY, mod.API_SECRET]) {
    assert.ok(!text.includes(secret), '输出里不得出现密钥原文')
  }

  // 人读模式（不带 --json）要把脱敏 Problem 打在 stderr 上。
  const readable = await runJourneyFor(VENUE, {
    argv: [],
    fetchWrap: (inner) => async (input, init) => {
      const method = (init?.method ?? 'GET').toUpperCase()
      const path = new URL(String(input)).pathname
      if (method === 'POST' && path === CREATE_PATH) return new Response('upstream down', { status: 503 })
      return inner(input, init)
    },
  })
  assert.equal(readable.code, 1)
  const readableText = readable.lines.join('\n')
  assert.match(readableText, /Problem: /)
  assert.match(readableText, /失败于「place-limit」/)
  for (const secret of [mod.API_KEY, mod.API_SECRET]) {
    assert.ok(!readableText.includes(secret), '人读模式也不得回显密钥原文')
  }
})
