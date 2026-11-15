// SPDX-License-Identifier: CPAL-1.0
// 内核客户端：配置解析（令牌只来自环境变量、地址只能是本机、端口可从 service.json 读）、错误原样透传、令牌不进错误信息。
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { KernelClient, resolveConfig } from '../src/client'

const TOKEN = `gtk_${'A'.repeat(52)}`

describe('resolveConfig', () => {
  it('没有令牌 / 令牌格式不对 → 调用时报错（不是启动失败），且错误里不回显令牌', () => {
    expect(() => resolveConfig({}).token()).toThrow(/GITRADER_AGENT_TOKEN/)
    expect(() => resolveConfig({ GITRADER_AGENT_TOKEN: 'gtk_secret-ish-garbage' }).token()).toThrow(/malformed/)
    try { resolveConfig({ GITRADER_AGENT_TOKEN: 'gtk_secret-ish-garbage' }).token() } catch (e) { expect(String(e)).not.toContain('secret-ish-garbage') }
    expect(resolveConfig({ GITRADER_AGENT_TOKEN: TOKEN }).token()).toBe(TOKEN)
  })

  it('令牌文件：没有环境变量时读它；文件可以晚于宿主创建，也可以轮换', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gitrader-mcp-'))
    try {
      const file = join(dir, 'agent.token')
      const cfg = resolveConfig({ GITRADER_AGENT_TOKEN_FILE: file })
      expect(() => cfg.token()).toThrow(/no agent key yet/)
      writeFileSync(file, `${TOKEN}
`)
      expect(cfg.token()).toBe(TOKEN)
      const T2 = `gtk_${'B'.repeat(52)}`
      writeFileSync(file, T2)
      expect(cfg.token()).toBe(T2)
      // 环境变量优先
      expect(resolveConfig({ GITRADER_AGENT_TOKEN: TOKEN, GITRADER_AGENT_TOKEN_FILE: file }).token()).toBe(TOKEN)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('地址只能是本机', () => {
    expect(() => resolveConfig({ GITRADER_AGENT_TOKEN: TOKEN, GITRADER_API_URL: 'http://example.org:80' })).toThrow(/local kernel/)
    expect(() => resolveConfig({ GITRADER_AGENT_TOKEN: TOKEN, GITRADER_API_URL: 'https://127.0.0.1:47900' })).toThrow(/local kernel/)
    expect(resolveConfig({ GITRADER_AGENT_TOKEN: TOKEN, GITRADER_API_URL: 'http://127.0.0.1:47900/' }).baseUrl()).toBe('http://127.0.0.1:47900')
  })

  it('没给地址就读 <GITRADER_HOME>/service.json 的端口（只读端口），每次调用时解析', () => {
    const home = mkdtempSync(join(tmpdir(), 'gitrader-mcp-'))
    try {
      const cfg = resolveConfig({ GITRADER_AGENT_TOKEN: TOKEN, GITRADER_HOME: home })
      expect(() => cfg.baseUrl()).toThrow(/no running Gitrader service/) // 内核还没起
      writeFileSync(join(home, 'service.json'), JSON.stringify({ port: 47911, pid: 1, token: 'svc_must-not-be-used', startedAt: 1, version: '0' }))
      expect(cfg.baseUrl()).toBe('http://127.0.0.1:47911') // 内核后起也能连上
    } finally { rmSync(home, { recursive: true, force: true }) }
  })
})

describe('KernelClient', () => {
  const mk = (f: typeof fetch) => new KernelClient({ baseUrl: 'http://127.0.0.1:1', token: TOKEN, fetch: f })

  it('带 Bearer 令牌 POST /api/op/<名>，body = {params}', async () => {
    let seen: { url: string; init: RequestInit } | undefined
    const c = mk((async (url: string, init: RequestInit) => { seen = { url, init }; return new Response(JSON.stringify({ ok: true, result: { data: 1 } }), { status: 200 }) }) as never)
    expect(await c.call('agent.market', { action: 'search' })).toEqual({ ok: true, result: { data: 1 } })
    expect(seen!.url).toBe('http://127.0.0.1:1/api/op/agent.market')
    expect((seen!.init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`)
    expect(JSON.parse(String(seen!.init.body))).toEqual({ params: { action: 'search' } })
  })

  it('内核返回的 Problem 原样带出（含 ruleHits）', async () => {
    const p = { code: 2001, name: 'RULE_DENIED', category: 'RISK', retryable: false, message: 'm', ruleHits: [{ ruleId: 'r', code: 'LLM_LIVE_ENTRY' }] }
    const c = mk((async () => new Response(JSON.stringify({ ok: false, error: p }), { status: 403 })) as never)
    expect(await c.call('agent.order', {})).toEqual({ ok: false, status: 403, error: p })
  })

  it('连不上内核：合成一个 INTERNAL 问题，写明地址，不含令牌', async () => {
    const c = mk((async () => { throw new TypeError('fetch failed') }) as never)
    const r = await c.call('agent.session', {})
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.message).toMatch(/cannot reach the Gitrader kernel at http:\/\/127\.0\.0\.1:1/)
      expect(JSON.stringify(r)).not.toContain(TOKEN)
    }
  })

  it('没有令牌：不发请求，直接给出 AUTH_FAILED 的说明', async () => {
    let called = false
    const c = new KernelClient({ baseUrl: 'http://127.0.0.1:1', token: () => { throw new Error('no agent key configured: …') }, fetch: (async () => { called = true; return new Response('{}') }) as never })
    const r = await c.call('agent.session', {})
    expect(called).toBe(false)
    expect(r).toMatchObject({ ok: false, error: { name: 'AUTH_FAILED', code: 5003, message: expect.stringMatching(/no agent key configured/) } })
  })

  it('非 JSON 回复也不崩', async () => {
    const c = mk((async () => new Response('<html>', { status: 502 })) as never)
    const r = await c.call('agent.session', {})
    expect(r.ok).toBe(false)
  })
})
