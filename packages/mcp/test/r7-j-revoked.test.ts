// SPDX-License-Identifier: CPAL-1.0
// r7 WP-J GQ-43：钥匙被吊销 / 过期后，MCP 清空工具表并发 list_changed；错误原因原样给 Agent；换了令牌后下一次列工具即可恢复。
import { describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import { mcpToolsForLevel } from '@gitrader/protocol'
import { createGitraderMcp } from '../src/server'
import type { SessionInfo } from '../src/server'
import type { KernelReply } from '../src/client'

const RID = '11111111-2222-4333-8444-555555555555'
const L1: SessionInfo = { keyId: 'ak_TEST', mandateId: 'mdt_TEST', level: 'L1', tier: 'paper', status: 'active', allowAgentLayout: false, tools: mcpToolsForLevel('L1', {}).map((t) => t.name) }
const authFail = (message: string): KernelReply => ({ ok: false, status: 401, error: { code: 5003, name: 'AUTH_FAILED', category: 'PROTOCOL', retryable: false, message } })

async function setup(handler: (op: string, n: number) => KernelReply | undefined) {
  let n = 0
  const client = {
    async call(op: string): Promise<KernelReply> {
      n += 1
      return handler(op, n) ?? (op === 'agent.session' ? { ok: true, result: L1 } : { ok: true, result: { data: { echo: op }, session: L1 } })
    },
  }
  const mcp = createGitraderMcp({ client, newRequestId: () => RID })
  const [a, b] = InMemoryTransport.createLinkedPair()
  const host = new Client({ name: 'test-host', version: '0' }, { capabilities: {} })
  let changed = 0
  host.setNotificationHandler(ToolListChangedNotificationSchema, () => { changed += 1 })
  await mcp.refreshSession()
  await mcp.server.connect(b)
  await host.connect(a)
  return { host, changed: () => changed }
}
const settle = () => new Promise((r) => setTimeout(r, 20))

describe('GQ-43 吊销后的 MCP 行为', () => {
  it('KEY_REVOKED：调用报原文、工具表清空、发一次 list_changed；令牌恢复后再列工具回到 16 个并再通知一次', async () => {
    let revoked = false
    const { host, changed } = await setup((op) => {
      if (revoked) return authFail(op === 'agent.session' ? 'KEY_REVOKED: this agent key was revoked by the user' : 'KEY_REVOKED: this agent key was revoked by the user')
      return undefined
    })
    expect((await host.listTools()).tools).toHaveLength(16)
    revoked = true
    const r = await host.callTool({ name: 'market', arguments: { action: 'quote', instrumentId: 'X' } })
    expect(r.isError).toBe(true)
    expect(JSON.stringify(r.content)).toContain('KEY_REVOKED')
    await settle()
    expect(changed()).toBe(1)
    expect((await host.listTools()).tools).toHaveLength(0) // 仍吊销：刷新失败，保持空
    revoked = false // 用户换了令牌文件
    expect((await host.listTools()).tools).toHaveLength(16)
    await settle()
    expect(changed()).toBe(2)
  })

  it('笼统的 AUTH_FAILED（乱写令牌）不清空工具表、不发通知（反例）', async () => {
    let bad = false
    const { host, changed } = await setup((op) => (bad && op !== 'agent.session' ? authFail('authentication required: Authorization: Bearer <token>') : undefined))
    await host.listTools()
    bad = true
    const r = await host.callTool({ name: 'market', arguments: { action: 'quote', instrumentId: 'X' } })
    expect(r.isError).toBe(true)
    await settle()
    expect(changed()).toBe(0)
    expect((await host.listTools()).tools).toHaveLength(16)
  })

  it('KEY_EXPIRED 同样清空工具表', async () => {
    let gone = false
    const { host, changed } = await setup((op) => (gone && op !== 'agent.session' ? authFail('KEY_EXPIRED: this agent key has expired.') : undefined))
    await host.listTools()
    gone = true
    await host.callTool({ name: 'account', arguments: { action: 'list' } })
    await settle()
    expect(changed()).toBe(1)
  })
})
