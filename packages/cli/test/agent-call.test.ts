// SPDX-License-Identifier: CPAL-1.0
// `gitrader agent`：令牌来源、工具校验、与 MCP 相同的 params 拼法、错误原样透传、令牌不落输出。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Args, CliIo } from '../src/index'
import { cmdAgent } from '../src/agent-call'

const TOKEN = `gtk_${'A'.repeat(52)}`
let home: string
let out: string[]
let err: string[]

const io = (env: Record<string, string | undefined> = {}): CliIo => ({
  out: (s) => { out.push(s) },
  err: (s) => { err.push(s) },
  env: { GITRADER_HOME: home, ...env },
  interactive: false,
  readSecret: async () => { throw new Error('unexpected secret prompt') },
})

const args = (cmd: string[], flags: Record<string, string | true> = {}): Args => ({ cmd, flags })

function writeToken(name = 'agent.token'): void {
  const dir = join(home, 'agent-tokens')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name), `${TOKEN}\n`)
}

function writeService(port = 47911): void {
  writeFileSync(join(home, 'service.json'), JSON.stringify({ port, pid: 1, token: 'svc_must-not-be-used', startedAt: 1, version: '0' }))
}

interface Seen { url: string; init: RequestInit }
const fakeFetch = (seen: Seen[], reply: unknown, status = 200): typeof fetch =>
  (async (url: string, init: RequestInit) => {
    seen.push({ url, init })
    return new Response(JSON.stringify(reply), { status })
  }) as unknown as typeof fetch

beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'gitrader-agent-cli-')); out = []; err = [] })
afterEach(() => { rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })

describe('gitrader agent', () => {
  it('reads token from the single token file', async () => {
    writeToken('default.token')
    writeService()
    const seen: Seen[] = []
    const code = await cmdAgent(home, args(['agent', 'market', 'quote'], { args: '{"instrumentId":"hyperliquid:BTC"}' }), io(), {
      fetch: fakeFetch(seen, { ok: true, result: { data: { instrumentId: 'hyperliquid:BTC', bid: '1' } } }),
    })
    expect(code).toBe(0)
    expect(seen[0]!.url).toBe('http://127.0.0.1:47911/api/op/agent.market')
    expect((seen[0]!.init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`)
    expect(JSON.parse(out.join(''))).toMatchObject({ instrumentId: 'hyperliquid:BTC' })
  })

  it('multiple token files need --token-file', async () => {
    writeToken('one.token')
    writeToken('two.token')
    writeService()
    const seen: Seen[] = []
    const code = await cmdAgent(home, args(['agent', 'account', 'summary']), io(), { fetch: fakeFetch(seen, { ok: true, result: { data: {} } }) })
    expect(code).toBe(2)
    expect(seen).toHaveLength(0)
    expect(err.join('')).toContain('one.token')
    expect(err.join('')).toContain('two.token')
    expect(err.join('')).toContain('--token-file')
  })

  it('unknown tool lists available tools', async () => {
    writeToken()
    writeService()
    const code = await cmdAgent(home, args(['agent', 'nope', 'x']), io())
    expect(code).toBe(2)
    expect(err.join('')).toContain('market')
    expect(err.join('')).toContain('propose')
    expect(out).toHaveLength(0)
  })

  it('propose goes to agent.propose with same params shape as MCP', async () => {
    writeToken()
    writeService()
    const seen: Seen[] = []
    const intents = [
      { accountId: 'paper', instrumentId: 'hyperliquid:BTC', side: 'buy', type: 'market', reason: 'test' },
      { accountId: 'paper', instrumentId: 'hyperliquid:ETH', side: 'sell', type: 'limit', reason: 'test' },
    ]
    const payload = JSON.stringify({ accountId: 'paper', intents, reason: 'test' })
    const code = await cmdAgent(home, args(['agent', 'propose', 'order'], { args: payload }), io(), {
      fetch: fakeFetch(seen, { ok: true, result: { data: { proposalId: 'prop_1' } } }),
    })
    expect(code).toBe(0)
    expect(seen[0]!.url.endsWith('/api/op/agent.propose')).toBe(true)
    const body = JSON.parse(String(seen[0]!.init.body)) as { params: { action: string; intents: { clientOrderId?: string }[] } }
    expect(body.params.action).toBe('order')
    expect(body.params.intents).toHaveLength(2)
    for (const intent of body.params.intents) expect(typeof intent.clientOrderId).toBe('string')
    expect(body.params.intents[0]!.clientOrderId).not.toBe(body.params.intents[1]!.clientOrderId)
  })

  it('kernel error prints original json and exits 1', async () => {
    writeToken()
    writeService()
    const problem = { code: 2001, name: 'RISK_BLOCKED', category: 'RISK', retryable: false, message: 'original kernel message', ruleHits: [{ code: 'LEVERAGE' }] }
    const seen: Seen[] = []
    const code = await cmdAgent(home, args(['agent', 'market', 'quote'], { args: '{"instrumentId":"hyperliquid:BTC"}' }), io(), {
      fetch: fakeFetch(seen, { ok: false, error: problem }, 403),
    })
    expect(code).toBe(1)
    expect(JSON.parse(out.join(''))).toEqual({ error: problem })
    expect(err.join('').trim().split('\n')).toHaveLength(1)
    expect(err.join('')).toMatch(/[\u4e00-\u9fa5]/)
  })

  it('token never appears in output', async () => {
    writeToken()
    writeService()
    const ok = await cmdAgent(home, args(['agent', 'account', 'summary']), io(), {
      fetch: fakeFetch([], { ok: true, result: { data: { accountId: 'paper' } } }),
    })
    const problem = { code: 5003, name: 'AUTH_FAILED', category: 'PROTOCOL', retryable: false, message: 'revoked' }
    const bad = await cmdAgent(home, args(['agent', 'account', 'summary']), io(), { fetch: fakeFetch([], { ok: false, error: problem }, 401) })
    expect(ok).toBe(0)
    expect(bad).toBe(1)
    expect([...out, ...err].join('')).not.toContain(TOKEN)
  })
})
