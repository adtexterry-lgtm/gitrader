// SPDX-License-Identifier: CPAL-1.0
// ADR-22（A 半）：MCP 层未知工具名的提示 —— 命中别名给正名与一行示例，否则给最接近的工具名，末尾指到 discover。
import { describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { mcpToolsForLevel } from '@gitrader/protocol'
import { createGitraderMcp } from '../src/server'
import type { SessionInfo } from '../src/server'
import type { KernelReply } from '../src/client'

const RID = '11111111-2222-4333-8444-555555555555'
const sessionFor = (level: SessionInfo['level']): SessionInfo => ({
  keyId: 'ak_TEST', mandateId: 'mdt_TEST', level, tier: 'x', status: 'active', allowAgentLayout: false,
  tools: mcpToolsForLevel(level, { allowAgentLayout: false }).map((t) => t.name),
})

interface Sent { op: string; params: Record<string, unknown> }
function fakeKernel(initial: SessionInfo) {
  const state = { session: initial, sent: [] as Sent[] }
  const client = {
    async call(op: string, params: Record<string, unknown>): Promise<KernelReply> {
      state.sent.push({ op, params })
      if (op === 'agent.session') return { ok: true, result: state.session }
      return { ok: true, result: { data: { echo: op }, session: state.session } }
    },
  }
  return { state, client }
}

async function connect(client: { call: (op: string, p: Record<string, unknown>) => Promise<KernelReply> }) {
  const mcp = createGitraderMcp({ client, newRequestId: () => RID })
  const [a, b] = InMemoryTransport.createLinkedPair()
  const host = new Client({ name: 'test-host', version: '0' }, { capabilities: {} })
  await mcp.refreshSession()
  await mcp.server.connect(b)
  await host.connect(a)
  return { mcp, host }
}

/** 调一个不存在的工具名，取回错误对象（方法名、错误码、消息）。 */
async function unknownTool(name: string): Promise<{ code: number; name: string; message: string }> {
  const k = fakeKernel(sessionFor('L1'))
  const { host } = await connect(k.client)
  const r = await host.callTool({ name, arguments: {} })
  expect(r.isError).toBe(true)
  expect(k.state.sent.filter((s) => s.op !== 'agent.session')).toHaveLength(0) // 未知工具不打内核（agent.session 是启动时查级别）
  return JSON.parse((r.content as { text: string }[])[0]!.text).error as { code: number; name: string; message: string }
}

describe('未知工具名的提示', () => {
  it('accounts → 指向正名 account 与一行示例', async () => {
    const e = await unknownTool('accounts')
    expect(e.code).toBe(-32601)
    expect(e.name).toBe('METHOD_NOT_FOUND')
    expect(e.message).toContain('Use account')
    expect(e.message).toContain("gitrader agent account list --args '")
  })

  it('acount → 最近的正名 account', async () => {
    const e = await unknownTool('acount')
    expect(e.code).toBe(-32601)
    expect(e.name).toBe('METHOD_NOT_FOUND')
    expect(e.message).toContain('Did you mean: account')
  })

  it('zzz → 没有建议时指到 discover 分组', async () => {
    const e = await unknownTool('zzz')
    expect(e.code).toBe(-32601)
    expect(e.name).toBe('METHOD_NOT_FOUND')
    expect(e.message).toContain('All tools: discover groups')
  })
})
