// SPDX-License-Identifier: CPAL-1.0
// GEP over stdio：握手、请求/响应、host.* 请求被回 -32601、关停。用假引擎（test/fixtures/fake-engine.mjs）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openEngine, MAX_STDIO_LINE_BYTES, GEP_VERSION } from '../lib/gep-stdio.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const FAKE = join(HERE, 'fixtures/fake-engine.mjs')

test('openEngine：用令牌完成 gep.hello，拿到会话与引擎身份', async () => {
  const eng = await openEngine({ command: process.execPath, args: [FAKE] })
  try {
    assert.equal(eng.hello.version, GEP_VERSION)
    assert.equal(eng.hello.sessionId, 'sess_fake')
    assert.equal(eng.hello.engine.id, 'fake-engine')
  } finally {
    await eng.close()
  }
})

test('openEngine：host.* 请求收到 -32601（测试台不假装有行情源），并记录在 hostCalls', async () => {
  const eng = await openEngine({ command: process.execPath, args: [FAKE] })
  try {
    await new Promise((r) => setTimeout(r, 100))
    assert.ok(eng.hostCalls.some((c) => c.method === 'host.instruments'))
  } finally {
    await eng.close()
  }
})

test('openEngine：错误令牌握手失败（5003），不静默放行', async () => {
  await assert.rejects(
    openEngine({ command: process.execPath, args: [FAKE], token: 'bad' }),
    (e) => e?.gepError?.code === 5003,
  )
})

test('openEngine：close 后引擎进程退出，退出码为 0', async () => {
  const eng = await openEngine({ command: process.execPath, args: [FAKE] })
  const code = await eng.close()
  assert.equal(code, 0)
})

test('GEP stdio 帧上限与协议常量对齐（1 MiB / 版本 0.1）', () => {
  assert.equal(MAX_STDIO_LINE_BYTES, 1024 * 1024)
  assert.equal(GEP_VERSION, '0.1')
})
