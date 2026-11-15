// SPDX-License-Identifier: CPAL-1.0
// E0-4：接入请求（agent 发起 → 人在浏览器输 PIN 批准）。请求只存内存；令牌只在批准时生成并落盘。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeAgent, makeHarness, TEST_PIN } from './helpers/harness'
import type { Harness } from './helpers/harness'

let h: Harness
beforeEach(async () => { h = await makeHarness() })
afterEach(async () => { await h.cleanup() })

interface RequestView { requestId: string; state: string; createdAt: number; expiresAt: number; input: unknown; keyId?: string; tokenFilePath?: string; note?: string }
interface RequestReply { requestId: string; expiresAt: number }
interface ApproveReply { requestId: string; keyId: string; tokenFilePath: string; name: string }

const input = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ name: 'agent-bot', host: 'claude-code', tier: 'paper', mandate: { accounts: [h.paper.accountId] }, ...over })
const request = async (value: unknown): Promise<RequestReply> =>
  (await h.k.ops.call(h.k, 'agentkey.request', { principal: h.session, params: { input: value }, transport: 'http' })) as RequestReply
const status = async (requestId: string): Promise<RequestView> =>
  (await h.k.ops.call(h.k, 'agentkey.request.status', { principal: h.session, params: { requestId }, transport: 'http' })) as RequestView
const list = async (): Promise<{ requests: RequestView[] }> =>
  (await h.k.ops.call(h.k, 'agentkey.request.list', { principal: h.session, params: {}, transport: 'http' })) as { requests: RequestView[] }

describe('E0-4 接入请求', () => {
  it('request then approve writes token file and status has path but no token', async () => {
    await h.pinProof()
    const created = await request(input())
    expect(created.requestId).toMatch(/^akr_[0-9a-f]{16}$/)
    expect(created.expiresAt).toBeGreaterThan(h.clock.now())
    const pending = await status(created.requestId)
    expect(pending.state).toBe('pending')
    expect((await list()).requests).toHaveLength(1)

    const approved = await h.k.ops.call(h.k, 'agentkey.request.approve', { principal: h.session, params: { requestId: created.requestId }, transport: 'http', pin: TEST_PIN }) as ApproveReply
    expect(approved.requestId).toBe(created.requestId)
    expect(approved.name).toBe('agent-bot')
    expect(approved.tokenFilePath).toBe(join(h.home, 'agent-tokens', 'agent-bot.token'))
    const content = readFileSync(approved.tokenFilePath, 'utf8')
    expect(content.startsWith('gtk_')).toBe(true)
    const token = content.trim()
    expect(JSON.stringify(approved)).not.toContain(token)

    const after = await status(created.requestId)
    expect(after.state).toBe('approved')
    expect(after.keyId).toBe(approved.keyId)
    expect(after.tokenFilePath).toBe(approved.tokenFilePath)
    expect(JSON.stringify(after)).not.toContain(token)
    expect((await list()).requests).toHaveLength(0)
    expect(h.k.agents.listKeys().some((k) => k.keyId === approved.keyId)).toBe(true)
  })

  it('service principal cannot approve', async () => {
    const created = await request(input())
    await expect(h.k.ops.call(h.k, 'agentkey.request.approve', { principal: { kind: 'service' }, params: { requestId: created.requestId }, transport: 'http', pin: TEST_PIN }))
      .rejects.toMatchObject({ problem: { name: 'AUTH_FAILED' } })
    expect((await status(created.requestId)).state).toBe('pending')
  })

  it('request expires after ttl', async () => {
    const created = await request(input())
    h.clock.advance(600_000)
    expect((await status(created.requestId)).state).toBe('expired')
    expect((await list()).requests).toHaveLength(0)
    await h.pinProof()
    await expect(h.k.ops.call(h.k, 'agentkey.request.approve', { principal: h.session, params: { requestId: created.requestId }, transport: 'http', pin: TEST_PIN }))
      .rejects.toMatchObject({ problem: { name: 'INVALID_PARAMS' } })
  })

  it('at most three pending requests', async () => {
    for (let i = 0; i < 3; i++) await request(input({ name: `agent-bot-${i}` }))
    await expect(request(input({ name: 'agent-bot-3' }))).rejects.toMatchObject({ problem: { name: 'INVALID_PARAMS' } })
    expect((await list()).requests).toHaveLength(3)
    const first = (await list()).requests[0]!
    await h.k.ops.call(h.k, 'agentkey.request.reject', { principal: h.session, params: { requestId: first.requestId, note: '先不接' }, transport: 'http' })
    expect((await status(first.requestId)).state).toBe('rejected')
    const created = await request(input({ name: 'agent-bot-3' }))
    expect((await list()).requests).toHaveLength(3)
    expect(created.requestId).toMatch(/^akr_/)
  })

  it('agent principal cannot request', async () => {
    const a = await makeAgent(h, 'read_only')
    await expect(h.k.ops.call(h.k, 'agentkey.request', { principal: a.principal, params: { input: input() }, transport: 'http' }))
      .rejects.toMatchObject({ problem: { name: 'AUTH_FAILED' } })
  })

  it('invalid confirm-tier input is rejected before pending', async () => {
    await expect(request(input({ tier: 'confirm', mandate: { accounts: [h.paper.accountId] } })))
      .rejects.toMatchObject({ problem: { name: 'INVALID_PARAMS' } })
    expect((await list()).requests).toHaveLength(0)
  })
})
