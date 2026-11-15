// SPDX-License-Identifier: CPAL-1.0
// 只测辅助函数（端口分配 / 就绪轮询超时 / PID 过滤 / 表格）；真旅程由人跑 `node tools/smoke/journey.mjs`。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { formatTable, killTargets, pickFreePort, waitForReady } from '../lib/helpers.mjs'

const listen = (port) => new Promise((res, rej) => {
  const s = createServer()
  s.once('error', rej)
  s.listen(port, '127.0.0.1', () => res(s))
})

test('pickFreePort 返回可绑定的端口（1..65535 整数）', async () => {
  const port = await pickFreePort()
  assert.ok(Number.isInteger(port) && port > 0 && port < 65536, `bad port ${port}`)
  // 拿到的端口立刻能绑：说明分配时确实释放了
  const srv = await listen(port)
  await new Promise((r) => srv.close(r))
})

test('pickFreePort 两次调用都合法（不保证不相同）', async () => {
  const [a, b] = [await pickFreePort(), await pickFreePort()]
  for (const p of [a, b]) assert.ok(Number.isInteger(p) && p > 0 && p < 65536)
})

test('waitForReady：200 立刻成功，带 Bearer 令牌', async () => {
  let seen = null
  const fetchImpl = async (_url, init) => { seen = init?.headers ?? null; return { status: 200, json: async () => ({ ready: true }) } }
  const r = await waitForReady('http://127.0.0.1:1/api/ready', { token: 'tok', fetchImpl, timeoutMs: 500 })
  assert.equal(r.ok, true)
  assert.equal(r.lastStatus, 200)
  assert.equal(r.attempts, 1)
  assert.equal(seen.authorization, 'Bearer tok')
  assert.deepEqual(r.body, { ready: true })
})

test('waitForReady：一直 503 → 超时返回 ok:false（不抛错）', async () => {
  let calls = 0
  const fetchImpl = async () => { calls += 1; return { status: 503, json: async () => ({ ready: false }) } }
  const r = await waitForReady('http://127.0.0.1:1/api/ready', { fetchImpl, timeoutMs: 120, intervalMs: 10, sleep: (ms) => new Promise((res) => setTimeout(res, ms)) })
  assert.equal(r.ok, false)
  assert.equal(r.lastStatus, 503)
  assert.ok(r.attempts >= 2, `attempts ${r.attempts}`)
  assert.ok(r.elapsedMs >= 100, `elapsed ${r.elapsedMs}`)
  assert.equal(calls, r.attempts)
})

test('waitForReady：fetch 抛错（服务还没起来）也按超时收口', async () => {
  const fetchImpl = async () => { throw new Error('ECONNREFUSED') }
  const r = await waitForReady('http://127.0.0.1:1/api/ready', { fetchImpl, timeoutMs: 60, intervalMs: 5 })
  assert.equal(r.ok, false)
  assert.equal(r.lastStatus, 0)
  assert.ok(r.attempts >= 1)
})

test('waitForReady：先失败后成功 → ok:true 且 attempts 计数正确', async () => {
  let n = 0
  const fetchImpl = async () => { n += 1; return { status: n < 3 ? 503 : 200, json: async () => ({ ready: n >= 3 }) } }
  const r = await waitForReady('http://127.0.0.1:1/api/ready', { fetchImpl, timeoutMs: 1_000, intervalMs: 5 })
  assert.equal(r.ok, true)
  assert.equal(r.attempts, 3)
})

test('killTargets：只留自己记录过的正整数 PID，去掉重复 / 当前进程 / 非法值', () => {
  const pids = killTargets([
    1234,
    { pid: 1234 },
    { pid: process.pid },
    process.pid,
    0,
    -5,
    1.5,
    null,
    undefined,
    { pid: '5678' },
    { pid: 4321 },
  ])
  assert.deepEqual(pids, [1234, 4321])
})

test('killTargets：空输入与全非法输入返回空数组', () => {
  assert.deepEqual(killTargets([]), [])
  assert.deepEqual(killTargets(undefined), [])
  assert.deepEqual(killTargets([{ pid: 0 }, { pid: process.pid }, { nope: 1 }]), [])
})

test('formatTable：表头 / 分隔线 / 每行列数一致', () => {
  const text = formatTable([
    { step: 'init', ms: '12', result: 'ok', detail: 'exit 0' },
    { step: 'serve', ms: '345', result: 'ok', detail: '' },
  ])
  const lines = text.split('\n')
  assert.equal(lines.length, 4)
  assert.match(lines[0], /^#\s+step/)
  assert.match(lines[1], /^-/)
  assert.ok(lines[2].startsWith('1'))
  assert.ok(lines[3].startsWith('2'))
  assert.ok(lines[3].includes('serve'))
  assert.ok(lines[3].includes('345'))
})
