// SPDX-License-Identifier: CPAL-1.0
// K4（ADR-20）：gitrader agent 的结果未知语义——发出后断开 = 结果未知（不可当失败重试）、拒连 = 可重试、内核回来后按 order.lookup 找回。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Args, CliIo } from '../src/index'
import { cmdAgent } from '../src/agent-call'

const TOKEN = `gtk_${'A'.repeat(52)}`
const intent = { accountId: 'paper', instrumentId: 'hyperliquid:BTC', side: 'buy', type: 'market', size: '0.002', reason: 'r' }
let home: string
let out: string[]
let err: string[]

const io = (): CliIo => ({
  out: (s) => { out.push(s) },
  err: (s) => { err.push(s) },
  env: { GITRADER_HOME: home },
  interactive: false,
  readSecret: async () => { throw new Error('unexpected secret prompt') },
})
const args = (cmd: string[], flags: Record<string, string | true> = {}): Args => ({ cmd, flags })

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'gitrader-k4-cli-'))
  out = []
  err = []
  mkdirSync(join(home, 'agent-tokens'), { recursive: true })
  writeFileSync(join(home, 'agent-tokens', 'agent.token'), `${TOKEN}\n`)
  writeFileSync(join(home, 'service.json'), JSON.stringify({ port: 1, pid: 1, token: 'svc_unused', startedAt: 1, version: '0' }))
})
afterEach(() => { rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })

/** undici 风格的网络错误：TypeError('fetch failed') + cause.code。 */
const netError = (code: string, message: string): TypeError => new TypeError('fetch failed', { cause: Object.assign(new Error(message), { code }) })
const reply = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status })
const bodyOf = (init: RequestInit): { params: Record<string, any> } => JSON.parse(String(init.body)) // eslint-disable-line @typescript-eslint/no-explicit-any
const place = args(['agent', 'order', 'place'], { args: JSON.stringify({ intent }) })

describe('K4 gitrader agent 结果未知语义', () => {
  it('ECONNRESET after send is outcome-unknown and prints the clientOrderId', async () => {
    const ids: string[] = []
    const fetchFn = (async (url: string, init: RequestInit) => {
      if (url.endsWith('/agent.order')) { ids.push(bodyOf(init).params.intent.clientOrderId); throw netError('ECONNRESET', 'read ECONNRESET') }
      return reply({ ok: false, error: { code: 4001, name: 'INTERNAL', category: 'ENGINE', retryable: false, message: 'no lookup' } }, 404) // order.lookup 也不可用
    }) as unknown as typeof fetch
    const code = await cmdAgent(home, place, io(), { fetch: fetchFn, recoverAttempts: 1, recoverEveryMs: 1 })
    expect(code).toBe(1)
    const text = err.join('')
    expect(text).toContain('结果未知')
    expect(text).toContain('这笔可能已经成交')
    expect(text).toContain('同一个 clientOrderId')
    expect(text).toContain(ids[0]!)
    const e = JSON.parse(out.join('')).error
    expect(e).toMatchObject({ code: 3006, name: 'VENUE_OUTCOME_UNKNOWN', retryable: false, clientOrderIds: [ids[0]] })
    expect(text).not.toContain('连不上')
  })

  it('ECONNREFUSED stays retryable', async () => {
    const fetchFn = (async () => { throw netError('ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:1') }) as unknown as typeof fetch
    const code = await cmdAgent(home, place, io(), { fetch: fetchFn })
    expect(code).toBe(1)
    expect(err.join('')).toContain('内核没在运行（连不上）')
    expect(err.join('')).toContain('gitrader serve')
    expect(err.join('')).not.toContain('结果未知')
    expect(JSON.parse(out.join('')).error).toMatchObject({ name: 'INTERNAL', retryable: true })
  })

  it('kernel restarted: recover finds the filled order', async () => {
    const fetchFn = (async (url: string, init: RequestInit) => {
      if (url.endsWith('/agent.order')) throw netError('ECONNRESET', 'read ECONNRESET')
      if (url.endsWith('/order.lookup')) return reply({ ok: true, result: { found: true, order: { orderId: 'ord_K4', status: 'filled', clientOrderId: bodyOf(init).params.clientOrderId } } })
      return reply({ ok: false, error: { code: 4001, name: 'INTERNAL', category: 'ENGINE', retryable: false, message: 'x' } }, 404)
    }) as unknown as typeof fetch
    const code = await cmdAgent(home, place, io(), { fetch: fetchFn, recoverEveryMs: 1 })
    expect(code).toBe(0)
    expect(JSON.parse(out.join(''))).toMatchObject({ recoveredAfterTimeout: true, order: { orderId: 'ord_K4', status: 'filled' } })
    expect(err.join('')).not.toContain('结果未知')
  })

  it('只读调用中途断开：不说结果未知，可直接重试', async () => {
    const fetchFn = (async () => { throw netError('ECONNRESET', 'read ECONNRESET') }) as unknown as typeof fetch
    const code = await cmdAgent(home, args(['agent', 'market', 'search']), io(), { fetch: fetchFn })
    expect(code).toBe(1)
    expect(err.join('')).toContain('可以直接重试')
    expect(err.join('')).not.toContain('这笔可能已经成交')
  })
})
