// SPDX-License-Identifier: CPAL-1.0
// MCP 服务器 ↔ 真内核（本机 HTTP，真鉴权，内存里的 MCP 传输）：纸面闭环、origin 盖章、实盘开仓被默认策略拦住并返回规则名。
// 内核用 kernel 包自己的测试夹具（假连接器 + 假时钟）；这里证明的是"接缝"——MCP 进程到内核的真实 HTTP 路径。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { enableLive, makeAgent, makeHarness } from '../../kernel/test/helpers/harness'
import type { Harness, TestAgent } from '../../kernel/test/helpers/harness'
import { BTC } from '../../kernel/test/helpers/fake-connector'
import { KernelClient } from '../src/client'
import { createGitraderMcp } from '../src/server'

let h: Harness
let port = 0
beforeEach(async () => {
  h = await makeHarness()
  port = (await h.k.start({})).port
})
afterEach(async () => { await h.cleanup() })

let n = 0
const rid = (): string => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`

async function hostFor(agent: TestAgent): Promise<{ host: Client; ids: string[] }> {
  const ids: string[] = []
  const mcp = createGitraderMcp({ client: new KernelClient({ baseUrl: `http://127.0.0.1:${port}`, token: agent.token }), newRequestId: () => { const x = rid(); ids.push(x); return x } })
  await mcp.refreshSession()
  const [a, b] = InMemoryTransport.createLinkedPair()
  const host = new Client({ name: 'test-host', version: '0' }, { capabilities: {} })
  await mcp.server.connect(b)
  await host.connect(a)
  return { host, ids }
}
const text = (r: unknown): any => JSON.parse(((r as { content: { text: string }[] }).content[0]!).text) // eslint-disable-line @typescript-eslint/no-explicit-any

describe('MCP ↔ 内核（真 HTTP）', () => {
  it('默认纸面钥匙：16 个工具；只读调用成功；令牌错误时报 AUTH_FAILED 原话', async () => {
    const a = await makeAgent(h, 'paper')
    const { host } = await hostFor(a)
    expect((await host.listTools()).tools).toHaveLength(16)
    const q = text(await host.callTool({ name: 'market', arguments: { action: 'quote', instrumentId: BTC } }))
    expect(q.instrumentId).toBe(BTC)
    const bad = createGitraderMcp({ client: new KernelClient({ baseUrl: `http://127.0.0.1:${port}`, token: `gtk_${'A'.repeat(52)}` }) })
    const [x, y] = InMemoryTransport.createLinkedPair()
    const hh = new Client({ name: 'h', version: '0' }, { capabilities: {} })
    await bad.server.connect(y)
    await hh.connect(x)
    const r = await hh.callTool({ name: 'market', arguments: { action: 'quote', instrumentId: BTC } })
    expect(r.isError).toBe(true)
    expect(text(r).error).toMatchObject({ name: 'AUTH_FAILED' })
  })

  it('纸面下单 → 成交 → 账本条目带 origin（llm-agent / 工具名 / MCP 进程生成的 requestId / via mcp）', async () => {
    const a = await makeAgent(h, 'paper')
    const { host, ids } = await hostFor(a)
    const placed = text(await host.callTool({ name: 'order', arguments: { action: 'place', intent: { accountId: h.paper.accountId, instrumentId: BTC, side: 'buy', type: 'market', size: '0.003', leverage: 2, reason: 'funding flipped' } } }))
    expect(placed.order.status).toBe('filled')
    const requestId = ids[ids.length - 1]!
    expect(placed.order.origin).toEqual({ actor: `agent:${a.keyId}`, actorType: 'llm-agent', tool: 'order', requestId, via: 'mcp' })
    const led = text(await host.callTool({ name: 'ledger', arguments: { action: 'query', filter: { 'origin.actorType': 'llm-agent', accountId: h.paper.accountId, types: ['order.intent', 'order.accepted', 'fill'] } } }))
    expect(led.items.length).toBeGreaterThan(0)
    expect(led.items.find((e: any) => e.type === 'order.intent').origin.requestId).toBe(requestId) // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(led.items.every((e: any) => e.origin.actorType === 'llm-agent' || e.type === 'fill')).toBe(true) // eslint-disable-line @typescript-eslint/no-explicit-any
  })

  it('结果未知后的安全路径：按 clientOrderId 用 ledger.trace 查得到原单；带同一个 clientOrderId 重发返回原单，不会下第二笔', async () => {
    const a = await makeAgent(h, 'paper')
    const { host } = await hostFor(a)
    const intent = { accountId: h.paper.accountId, instrumentId: BTC, side: 'buy', type: 'market', size: '0.003', leverage: 2, reason: 'funding flipped' }
    const first = text(await host.callTool({ name: 'order', arguments: { action: 'place', intent } }))
    const cloid = first.order.clientOrderId as string
    expect(cloid).toMatch(/^[0-9a-f]{32}$/) // MCP 生成并随单回显
    const trace = text(await host.callTool({ name: 'ledger', arguments: { action: 'trace', id: cloid } }))
    expect(trace.items.some((e: any) => e.type === 'order.accepted')).toBe(true) // eslint-disable-line @typescript-eslint/no-explicit-any
    const again = text(await host.callTool({ name: 'order', arguments: { action: 'place', intent: { ...intent, clientOrderId: cloid } } }))
    expect(again.order.orderId).toBe(first.order.orderId)
    expect(h.k.orders.list({ accountId: h.paper.accountId, limit: 50 })).toHaveLength(1)
  })

  it('内核的 order.lookup 经 HTTP 对 Agent 钥匙可用：查得到自己的单，查不到别人账户的单；MCP 超时回查用的就是它', async () => {
    const a = await makeAgent(h, 'paper')
    const other = await makeAgent(h, 'paper', { accounts: [h.liveAcct.accountId as never] })
    const { host } = await hostFor(a)
    const intent = { accountId: h.paper.accountId, instrumentId: BTC, side: 'buy', type: 'market', size: '0.003', leverage: 2, reason: 'funding flipped' }
    const first = text(await host.callTool({ name: 'order', arguments: { action: 'place', intent } }))
    const cloid = first.order.clientOrderId as string
    const mine = await new KernelClient({ baseUrl: `http://127.0.0.1:${port}`, token: a.token }).call('order.lookup', { clientOrderId: cloid })
    expect(mine).toMatchObject({ ok: true, result: { found: true, order: { orderId: first.order.orderId, status: 'filled' } } })
    expect((mine as { result: { trail: string[] } }).result.trail).toEqual(expect.arrayContaining(['order.intent', 'order.accepted']))
    const theirs = await new KernelClient({ baseUrl: `http://127.0.0.1:${port}`, token: other.token }).call('order.lookup', { clientOrderId: cloid })
    expect(theirs).toMatchObject({ ok: true, result: { found: false } })
  })

  it('L3 钥匙提交实盘开仓：默认被 denyLlmLiveEntries 拦住，Agent 拿到撞了哪条规则；场所没收到任何单', async () => {
    await enableLive(h)
    const a = await makeAgent(h, 'auto_limited')
    const { host } = await hostFor(a)
    expect((await host.listTools()).tools.map((t) => t.name)).toContain('order')
    const pv = text(await host.callTool({ name: 'order', arguments: { action: 'preview', intent: { accountId: h.liveAcct.accountId, instrumentId: BTC, side: 'buy', type: 'market', size: '0.003', leverage: 2, reason: 'breakout' } } }))
    expect(pv.confirmToken).toBeUndefined()
    expect(pv.precheck.verdict).toBe('deny')
    expect(pv.precheck.ruleHits[0]).toMatchObject({ code: 'LLM_LIVE_ENTRY', action: 'deny' })
    const pl = await host.callTool({ name: 'order', arguments: { action: 'place', confirmToken: 'ctk_made-up.token' } })
    expect(pl.isError).toBe(true)
    expect(text(pl).error).toMatchObject({ code: 1008, name: 'CONFIRM_TOKEN_INVALID' })
    expect(h.live.submitted).toHaveLength(0)
  })

  it('L2 钥匙：实盘提案进待批（人批准前场所无单）；MCP 工具面里没有批准 / 拒绝', async () => {
    await enableLive(h)
    const a = await makeAgent(h, 'confirm')
    const { host } = await hostFor(a)
    const names = (await host.listTools()).tools.map((t) => t.name)
    expect(names.some((x) => /approve|reject|resume|relax|mandate_issue/.test(x))).toBe(false)
    const p = text(await host.callTool({ name: 'propose', arguments: { action: 'order', accountId: h.liveAcct.accountId, intents: [{ instrumentId: BTC, side: 'buy', type: 'limit', size: '0.003', price: '79000', tif: 'gtc', leverage: 2 }], reason: 'range support' } }))
    expect(p.status).toBe('pending')
    expect(p.ticket).toMatch(/^T-\d{8}-\d{4}$/)
    expect(h.live.submitted).toHaveLength(0)
    const prop = await host.callTool({ name: 'proposals', arguments: { action: 'approve', proposalId: p.proposalId } })
    expect(prop.isError).toBe(true)
  })

  it('人把钥匙降到只读后，下一次调用被拒，工具清单随之收缩并发出 list_changed', async () => {
    const a = await makeAgent(h, 'paper')
    const { host } = await hostFor(a)
    expect((await host.listTools()).tools).toHaveLength(16)
    h.k.agents.revokeMandate(a.mandate.mandateId, h.sessionProof(), h.human().origin)
    const r = await host.callTool({ name: 'order', arguments: { action: 'place', intent: { accountId: h.paper.accountId, instrumentId: BTC, side: 'buy', type: 'market', size: '0.003', reason: 'x' } } })
    expect(r.isError).toBe(true)
    await new Promise((res) => setTimeout(res, 30))
    expect((await host.listTools()).tools).toHaveLength(13)
  })
})
