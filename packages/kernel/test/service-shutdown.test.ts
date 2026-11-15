// SPDX-License-Identifier: CPAL-1.0
// fix-r4 C4：service.shutdown —— 会话或 service 令牌可调（不要 PIN）；回包先送出，100 ms 后通知宿主；无令牌被拒。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeAgent, makeHarness } from './helpers/harness'
import type { Harness } from './helpers/harness'

let h: Harness
let port = 0
let svcToken = ''
let sesToken = ''

beforeEach(async () => {
  h = await makeHarness()
  const r = await h.k.start({ port: 0 })
  port = r.port
  svcToken = (JSON.parse(readFileSync(join(h.home, 'service.json'), 'utf8')) as { token: string }).token
  sesToken = h.k.auth.exchangeBoot(r.bootToken).sessionToken
})
afterEach(async () => { await h.cleanup() })

async function shutdown(token?: string): Promise<{ status: number; json: any }> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  const res = await fetch(`http://127.0.0.1:${port}/api/op/service.shutdown`, { method: 'POST', headers, body: JSON.stringify({ params: {} }) })
  return { status: res.status, json: await res.json().catch(() => null) }
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('service.shutdown', () => {
  it('service 令牌可调：返回 ok，回调约 100 ms 后恰好被调用一次，账本留一条 service_shutdown 注记', async () => {
    const cb = vi.fn()
    h.k.onShutdownRequest = cb
    const r = await shutdown(svcToken)
    expect(r.status).toBe(200)
    expect(r.json.result).toEqual({ ok: true })
    expect(cb).not.toHaveBeenCalled() // 先把回包送出去，再通知
    await sleep(400)
    expect(cb).toHaveBeenCalledTimes(1)
    const notes = h.k.ledger.query({ types: ['annotation'], limit: 20 }).filter((e) => (e.payload as { setting?: string } | undefined)?.setting === 'service_shutdown')
    expect(notes).toHaveLength(1)
  })

  it('会话令牌也可调，不要 PIN', async () => {
    const cb = vi.fn()
    h.k.onShutdownRequest = cb
    expect((await shutdown(sesToken)).status).toBe(200)
    await sleep(400)
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('没带令牌 → 被拒，回调不会被调用', async () => {
    const cb = vi.fn()
    h.k.onShutdownRequest = cb
    const r = await shutdown()
    expect(r.status).toBe(401)
    expect(r.json.error.code).toBe(5003)
    await sleep(300)
    expect(cb).not.toHaveBeenCalled()
  })

  it('Agent 令牌调用被拒（Agent 主体什么人面动作都调不了），回调不会被调用', async () => {
    const agent = await makeAgent(h, 'paper')
    const cb = vi.fn()
    h.k.onShutdownRequest = cb
    const r = await shutdown(agent.token)
    expect([401, 403]).toContain(r.status)
    expect(r.json.ok).toBe(false)
    await sleep(300)
    expect(cb).not.toHaveBeenCalled()
  })

  it('宿主没接回调也不报错', async () => {
    expect((await shutdown(svcToken)).status).toBe(200)
    await sleep(200)
  })
})
