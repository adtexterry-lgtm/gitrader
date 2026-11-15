// SPDX-License-Identifier: CPAL-1.0
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

function fakeKernel(initial: SessionInfo) {
  const state = { session: initial, sent: [] as Array<{ op: string; params: Record<string, unknown> }> }
  const client = {
    async call(op: string, params: Record<string, unknown>): Promise<KernelReply> {
      state.sent.push({ op, params })
      if (op === 'agent.session') return { ok: true, result: state.session }
      if (op === 'agent.experiment') {
        return { ok: true, result: { data: { experimentId: 'exp_test' }, session: state.session } }
      }
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
  return { mcp, host, client }
}

describe('GQ-45 experiment 入参错误带路径', () => {
  it('experiment {action:"bogus"} 的 error.message 含 /action 路径', async () => {
    const k = fakeKernel(sessionFor('L1'))
    const { host } = await connect(k.client)
    const r = await host.callTool({ name: 'experiment', arguments: { action: 'bogus' } })
    expect(r.isError).toBe(true)
    if (r.isError) {
      const text = (r.content as Array<{ text: string }>)[0]!.text
      expect(text).toContain('/action')
      expect(text).toContain('tool_help')
    }
  })

  it('{action:"create",patch:{title:"t",hypothesis:"h"}} 合法形状放行到内核', async () => {
    const k = fakeKernel(sessionFor('L1'))
    const { host } = await connect(k.client)
    const r = await host.callTool({ name: 'experiment', arguments: { action: 'create', patch: { title: 't', hypothesis: 'h' } } })
    expect(r.isError).toBeFalsy()
    expect(k.state.sent.some((s) => s.op === 'agent.experiment')).toBe(true)
  })
})
