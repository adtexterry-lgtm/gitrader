// SPDX-License-Identifier: CPAL-1.0
// r7 WP-K：GQ-52 Idempotency-Key 头 + GQ-54 params.apiBase（Discord）。本地假服务器（随机端口），不连任何真实 IM。
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error 纯 JS 插件，没有类型声明
import { handleNotifySend } from '../index.mjs'

const NOTICE = { key: 'k1', level: 'warn', title: 'T', lines: ['a: 1'], ts: 1760000000000, topic: 'risk.denials' }
const servers: ReturnType<typeof createServer>[] = []
afterEach(() => { for (const s of servers.splice(0)) s.close() })

interface Seen { url: string; headers: Record<string, string | string[] | undefined> }
async function fakeServer(): Promise<{ base: string; seen: Seen[] }> {
  const seen: Seen[] = []
  const server = createServer((req, res) => {
    req.resume()
    req.on('end', () => { seen.push({ url: req.url ?? '', headers: req.headers }); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ id: '555' })) })
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen }
}
const send = (extra: Record<string, unknown>, deps: Record<string, unknown> = {}) => handleNotifySend({ notice: NOTICE, params: { ...extra } }, { ...{ webhookUrl: 'https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwx', sleep: async () => {} }, ...deps })
function capture() {
  const urls: string[] = []
  const heads: Record<string, string>[] = []
  const fetchImpl = async (url: string, init: { headers: Record<string, string> }) => {
    urls.push(String(url)); heads.push(init.headers)
    return { ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify({ id: '555' }), json: async () => ({ id: '555' }) }
  }
  return { urls, heads, fetchImpl }
}

describe('Discord GQ-54 apiBase', () => {
  it('不给 apiBase：走官方地址', async () => {
    const c = capture()
    expect(await send({}, { fetchImpl: c.fetchImpl })).toMatchObject({ ok: true })
    expect(c.urls[0]!.startsWith('https://discord.com/api/webhooks/')).toBe(true)
  })

  it('https apiBase：请求发到自定义 origin，路径仍取自原配置', async () => {
    const c = capture()
    expect(await send({ apiBase: 'https://example.com' }, { fetchImpl: c.fetchImpl })).toMatchObject({ ok: true })
    expect(c.urls[0]!.startsWith('https://example.com/')).toBe(true)
    expect(c.urls[0]).toContain('/api/webhooks')
  })

  it('回环 http：开测试开关才放行，真的打到本地假服务器；不开开关则拒绝且不发请求', async () => {
    const { base, seen } = await fakeServer()
    expect(await send({ apiBase: base }, { allowInsecureLoopback: true })).toMatchObject({ ok: true })
    expect(seen).toHaveLength(1)
    expect(seen[0]!.url).toContain('/api/webhooks')
    const denied = await send({ apiBase: base })
    expect(denied).toMatchObject({ ok: false, retryable: false })
    expect(seen).toHaveLength(1)
  })

  it('非回环的明文 http、带路径 / 凭据的 apiBase、乱写的值：一律拒绝，不发请求', async () => {
    const c = capture()
    for (const bad of ['http://example.com', 'https://u:p@example.com', 'https://example.com/x', 'not a url', 42]) {
      expect(await send({ apiBase: bad }, { fetchImpl: c.fetchImpl, allowInsecureLoopback: true })).toMatchObject({ ok: false, retryable: false })
    }
    expect(c.urls).toHaveLength(0)
  })
})

describe('Discord GQ-52 Idempotency-Key', () => {
  it('内核给的 params.idempotencyKey 进请求头；不给就没有这个头', async () => {
    const { base, seen } = await fakeServer()
    expect(await send({ apiBase: base, idempotencyKey: 'abc123' }, { allowInsecureLoopback: true })).toMatchObject({ ok: true })
    expect(seen[0]!.headers['idempotency-key']).toBe('abc123')
    expect(await send({ apiBase: base }, { allowInsecureLoopback: true })).toMatchObject({ ok: true })
    expect(seen[1]!.headers['idempotency-key']).toBeUndefined()
  })
})
