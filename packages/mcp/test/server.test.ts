// SPDX-License-Identifier: CPAL-1.0
// MCP 服务器：工具清单与协议包一致、按级别加载、tools/list_changed、origin 的 requestId、错误原话透传、不轮询。
import { describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import { MCP_BUDGET, MCP_TOOLS, mcpToolsForLevel } from '@gitrader/protocol'
import type { Problem } from '@gitrader/protocol'
import { createGitraderMcp, toMcpTool } from '../src/server'
import { toolDescription } from '../src/describe'
import type { SessionInfo } from '../src/server'
import type { KernelReply } from '../src/client'

const RID = '11111111-2222-4333-8444-555555555555'
const sessionFor = (level: SessionInfo['level'], allowAgentLayout = false): SessionInfo => ({
  keyId: 'ak_TEST', mandateId: 'mdt_TEST', level, tier: 'x', status: 'active', allowAgentLayout,
  tools: mcpToolsForLevel(level, { allowAgentLayout }).map((t) => t.name),
})

interface Sent { op: string; params: Record<string, unknown> }
function fakeKernel(initial: SessionInfo, handler: (op: string, params: Record<string, unknown>) => KernelReply | undefined = () => undefined) {
  const state = { session: initial, sent: [] as Sent[] }
  const client = {
    async call(op: string, params: Record<string, unknown>): Promise<KernelReply> {
      state.sent.push({ op, params })
      const custom = handler(op, params)
      if (custom) return custom
      if (op === 'agent.session') return { ok: true, result: state.session }
      return { ok: true, result: { data: { echo: op }, session: state.session } }
    },
  }
  return { state, client }
}

async function connect(client: { call: (op: string, p: Record<string, unknown>) => Promise<KernelReply> }, opts: { maxResultChars?: number } = {}) {
  const mcp = createGitraderMcp({ client, newRequestId: () => RID, ...opts })
  const [a, b] = InMemoryTransport.createLinkedPair()
  const host = new Client({ name: 'test-host', version: '0' }, { capabilities: {} })
  let changed = 0
  host.setNotificationHandler(ToolListChangedNotificationSchema, () => { changed += 1 })
  await mcp.refreshSession()
  await mcp.server.connect(b)
  await host.connect(a)
  return { mcp, host, changed: () => changed }
}

describe('工具清单', () => {
  it('toMcpTool 与协议包一致：名称、描述、入参 schema、注解逐项相等', () => {
    for (const t of MCP_TOOLS) {
      const m = toMcpTool(t)
      expect(m.name).toBe(t.name)
      expect(m.description).toBe(toolDescription(t))
      expect(m.description.startsWith(t.description)).toBe(true)
      expect(m.inputSchema).toEqual({ type: 'object', properties: t.inputSchema.properties, required: t.inputSchema.required })
      expect(m.annotations ?? {}).toEqual(t.annotations)
    }
  })

  it.each([
    ['L0', 13, false],
    ['L1', 16, false],
    ['L2', 16, false],
    ['L3', 16, false],
    ['L4', 16, false],
    ['L1', 17, true],
  ] as const)('%s 钥匙（布局开关 %s）：宿主看到 %i 个工具', async (level, count, layout) => {
    const k = fakeKernel(sessionFor(level, layout))
    const { host } = await connect(k.client)
    const { tools } = await host.listTools()
    expect(tools).toHaveLength(count)
    expect(tools.map((t) => t.name)).toEqual(sessionFor(level, layout).tools)
    // L0 默认没有执行组与提案组；写工具带 destructive 注解，读工具带 readOnly 注解
    if (level === 'L0') expect(tools.map((t) => t.name)).not.toEqual(expect.arrayContaining(['order']))
    expect(tools.find((t) => t.name === 'market')!.annotations).toMatchObject({ readOnlyHint: true })
    expect(tools.find((t) => t.name === 'takeover')!.annotations).toMatchObject({ destructiveHint: true })
  })

  it('默认纸面钥匙的 16 个工具：每条描述 ≤ 60 字，定义总量在预算内', async () => {
    const { host } = await connect(fakeKernel(sessionFor('L1')).client)
    const { tools } = await host.listTools()
    expect(tools.every((t) => [...(t.description ?? '')].length <= MCP_BUDGET.maxDescriptionChars)).toBe(true)
    expect(tools.length).toBeLessThanOrEqual(MCP_BUDGET.defaultLoadTarget)
  })

  it('握手说明很短，并写明默认受大模型实盘开仓保护', async () => {
    const { host } = await connect(fakeKernel(sessionFor('L1')).client)
    const ins = host.getInstructions() ?? ''
    expect(ins.length).toBeLessThan(400)
    expect(ins).toMatch(/大模型实盘开仓默认被策略拒绝/)
    expect(ins).not.toMatch(/gtk_/)
  })

  it('order 工具描述写明 LLM 实盘开仓默认被策略拒绝', async () => {
    const { host } = await connect(fakeKernel(sessionFor('L3')).client)
    const order = (await host.listTools()).tools.find((t) => t.name === 'order')!
    expect(order.description).toMatch(/LLM 实盘开仓默认被策略拒绝/)
  })
})

describe('调用', () => {
  it('拒绝不符合实验输入 schema 的调用，不触达内核', async () => {
    const k = fakeKernel(sessionFor('L1'))
    const { host, mcp } = await connect(k.client)
    const problem: Problem = { code: -32602, name: 'INVALID_PARAMS', category: 'PROTOCOL', retryable: false, message: 'Invalid experiment input' }
    const experimentId = 'exp_000000000000000000000001'
    const invalid = [
      { action: 'update', experimentId, patch: { stage: 'shadow' } },
      { action: 'update', experimentId, patch: { metrics: {} } },
      { action: 'update', experimentId, patch: { runs: [] } },
      { action: 'pack', experimentId, pack: { runId: 'run-sample', stats: { trades: 999 } } },
      { action: 'attach', experimentId, attach: { run: { accountId: 'acct_000000000000000000000001', stage: 'shadow', from: 0, to: null } } },
    ]
    try {
      for (const args of invalid) {
        const before = k.state.sent.length
        const result = await host.callTool({ name: 'experiment', arguments: args })
        expect(result.isError).toBe(true)
        expect(JSON.parse((result.content as { text: string }[])[0]!.text)).toEqual({ error: problem })
        expect(k.state.sent.length).toBe(before)
      }
    } finally {
      await host.close()
      await mcp.server.close()
    }
  })

  it('stage、pack、export 经 agent.experiment 转发并保留内核响应', async () => {
    const problem: Problem = { code: 1013, name: 'EXPERIMENT_TRANSITION_DENIED', category: 'REJECTED', retryable: false, message: 'Live stage transitions must be completed by a human in the workbench.' }
    const k = fakeKernel(sessionFor('L1'), (op, p) => {
      if (op === 'agent.experiment' && p.action === 'stage') return { ok: false, status: 400, error: problem }
      if (op === 'agent.experiment' && (p.action === 'pack' || p.action === 'export')) return { ok: true, result: { data: { action: p.action, recorded: true }, session: sessionFor('L1') } }
      return undefined
    })
    const { host, mcp } = await connect(k.client)
    const experimentId = 'exp_000000000000000000000001'
    const requests = [
      { action: 'stage', experimentId, to: 'live_small' },
      { action: 'pack', experimentId, pack: { runId: 'run-sample', note: 'sample' } },
      { action: 'export', experimentId },
    ]
    try {
      const results = []
      for (const args of requests) results.push(await host.callTool({ name: 'experiment', arguments: args }))
      expect(results[0]!.isError).toBe(true)
      expect(JSON.parse((results[0]!.content as { text: string }[])[0]!.text)).toEqual({ error: problem })
      expect(results[1]!.isError).toBeFalsy()
      expect(JSON.parse((results[1]!.content as { text: string }[])[0]!.text)).toEqual({ action: 'pack', recorded: true })
      expect(results[2]!.isError).toBeFalsy()
      expect(JSON.parse((results[2]!.content as { text: string }[])[0]!.text)).toEqual({ action: 'export', recorded: true })
      expect(k.state.sent.filter((sent) => sent.op === 'agent.experiment').map((sent) => sent.params)).toEqual(
        requests.map((args) => ({ ...args, requestId: RID })),
      )
      expect(k.state.sent.filter((sent) => sent.op === 'agent.session')).toHaveLength(2)
      expect(k.state.sent.every((sent) => sent.op === 'agent.experiment' || sent.op === 'agent.session')).toBe(true)
    } finally {
      await host.close()
      await mcp.server.close()
    }
  })

  it('转发到 agent.<工具名>，附上 MCP 进程生成的 requestId；Agent 自带的 requestId / actor 字段不能覆盖盖章依据', async () => {
    const k = fakeKernel(sessionFor('L1'))
    const { host } = await connect(k.client)
    const r = await host.callTool({ name: 'market', arguments: { action: 'quote', instrumentId: 'hyperliquid:BTC', requestId: 'forged' } })
    expect(r.isError).toBeFalsy()
    const sent = k.state.sent.find((s) => s.op === 'agent.market')!
    expect(sent.params).toMatchObject({ action: 'quote', instrumentId: 'hyperliquid:BTC', requestId: RID })
    expect(JSON.parse((r.content as { text: string }[])[0]!.text)).toEqual({ echo: 'agent.market' })
  })

  it('未知工具名直接报错，不打内核', async () => {
    const k = fakeKernel(sessionFor('L1'))
    const { host } = await connect(k.client)
    const before = k.state.sent.length
    const r = await host.callTool({ name: 'approve_proposal', arguments: {} })
    expect(r.isError).toBe(true)
    expect(JSON.parse((r.content as { text: string }[])[0]!.text).error.name).toBe('METHOD_NOT_FOUND')
    expect(k.state.sent.length).toBe(before)
  })

  it('错误原话透传：规则名、上游 venue.message 一字不改', async () => {
    const problem: Problem = {
      code: 2001, name: 'RULE_DENIED', category: 'RISK', retryable: false, message: 'live entries originating from an LLM agent are denied by policy',
      ruleHits: [{ ruleId: 'pol_X#denyLlmLiveEntries', code: 'LLM_LIVE_ENTRY', message: 'live entries originating from an LLM agent are denied by policy', limit: '0' as never, actual: '1' as never, unit: 'entries', action: 'deny', scope: 'policy' }],
    }
    const venue: Problem = { code: 3001, name: 'VENUE_REJECTED', category: 'VENUE', retryable: false, message: 'venue rejected the order', venue: { id: 'hyperliquid', message: 'Order has invalid size.' } }
    const k = fakeKernel(sessionFor('L3'), (op, p) => (op === 'agent.order' ? { ok: false, status: 403, error: p.action === 'preview' ? problem : venue } : undefined))
    const { host } = await connect(k.client)
    const a = await host.callTool({ name: 'order', arguments: { action: 'preview', intent: {} } })
    expect(a.isError).toBe(true)
    expect(JSON.parse((a.content as { text: string }[])[0]!.text)).toEqual({ error: problem })
    const b = await host.callTool({ name: 'order', arguments: { action: 'place', confirmToken: 'ctk_x' } })
    expect(JSON.parse((b.content as { text: string }[])[0]!.text).error.venue.message).toBe('Order has invalid size.')
  })

  it('结果过大时给出缩小查询的提示，而不是把上下文撑爆', async () => {
    const k = fakeKernel(sessionFor('L1'), (op) => (op === 'agent.ledger' ? { ok: true, result: { data: { blob: 'x'.repeat(500) }, session: sessionFor('L1') } } : undefined))
    const { host } = await connect(k.client, { maxResultChars: 100 })
    const r = await host.callTool({ name: 'ledger', arguments: { action: 'query' } })
    expect(JSON.parse((r.content as { text: string }[])[0]!.text)).toMatchObject({ truncated: true })
  })
})

describe('动态加载与心跳', () => {
  it('级别变化时发 tools/list_changed，重新列出后工具集随之变化', async () => {
    const k = fakeKernel(sessionFor('L1'))
    const { host, changed, mcp } = await connect(k.client)
    expect((await host.listTools()).tools).toHaveLength(16)
    // 人把钥匙降到只读：下一次调用的返回里带回新级别
    k.state.session = sessionFor('L0')
    await host.callTool({ name: 'market', arguments: { action: 'search' } })
    await new Promise((r) => setTimeout(r, 20))
    expect(changed()).toBe(1)
    expect(mcp.session()!.level).toBe('L0')
    expect((await host.listTools()).tools).toHaveLength(13)
    // 又升回去 + 打开布局开关
    k.state.session = sessionFor('L3', true)
    await host.callTool({ name: 'market', arguments: { action: 'search' } })
    await new Promise((r) => setTimeout(r, 20))
    expect(changed()).toBe(2)
    expect((await host.listTools()).tools).toHaveLength(17)
  })

  it('级别没变就不发通知', async () => {
    const k = fakeKernel(sessionFor('L1'))
    const { host, changed } = await connect(k.client)
    await host.callTool({ name: 'market', arguments: { action: 'search' } })
    await host.callTool({ name: 'account', arguments: { action: 'list' } })
    await new Promise((r) => setTimeout(r, 20))
    expect(changed()).toBe(0)
  })

  it('被内核拒绝（例如越权）之后重新对一次级别，并把错误原样给 Agent', async () => {
    const k = fakeKernel(sessionFor('L3'), (op) => (op === 'agent.order' ? { ok: false, status: 403, error: { code: 2003, name: 'MANDATE_LEVEL', category: 'RISK', retryable: false, message: 'order needs level L1 or higher (this key is L0)' } } : undefined))
    const { host, changed } = await connect(k.client)
    k.state.session = sessionFor('L0') // 授权书在两次调用之间被降级（如心跳超时）
    const r = await host.callTool({ name: 'order', arguments: { action: 'place', intent: {} } })
    expect(r.isError).toBe(true)
    await new Promise((res) => setTimeout(res, 20))
    expect(changed()).toBe(1)
    expect((await host.listTools()).tools).toHaveLength(13)
  })

  it('不自动发心跳：没有 Agent 调用时，对内核的调用次数不增加（启动时的一次级别查询除外）', async () => {
    const k = fakeKernel(sessionFor('L1'))
    await connect(k.client)
    const after = k.state.sent.length
    await new Promise((r) => setTimeout(r, 300))
    expect(after).toBe(1)
    expect(k.state.sent.length).toBe(1)
    expect(k.state.sent.some((s) => s.op === 'agent.mandate')).toBe(false)
  })

  it('内核没起来：仍能握手，列出 L0 清单；调用时报内核不可达（原样），不崩溃', async () => {
    const unreachable: KernelReply = { ok: false, status: 0, error: { code: 4001, name: 'INTERNAL', category: 'ENGINE', retryable: true, message: 'cannot reach the Gitrader kernel at http://127.0.0.1:1: fetch failed' } }
    const client = { call: async (): Promise<KernelReply> => unreachable }
    const { host } = await connect(client)
    expect((await host.listTools()).tools).toHaveLength(13)
    const r = await host.callTool({ name: 'market', arguments: { action: 'search' } })
    expect(r.isError).toBe(true)
    expect((r.content as { text: string }[])[0]!.text).toMatch(/cannot reach the Gitrader kernel/)
  })
})
