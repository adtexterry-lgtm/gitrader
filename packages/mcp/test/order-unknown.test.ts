// SPDX-License-Identifier: CPAL-1.0
// 下单类调用：clientOrderId 必带；内核超时 = 结果未知（不是失败，更不是"连不上"），不让 Agent 盲目重发。
import { describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { mcpToolsForLevel } from '@gitrader/protocol'
import { KernelClient } from '../src/client'
import type { KernelReply } from '../src/client'
import { createGitraderMcp } from '../src/server'
import type { SessionInfo } from '../src/server'

const CLOID = /^[0-9a-f]{32}$/
const sessionFor = (level: SessionInfo['level']): SessionInfo => ({
  keyId: 'ak_TEST', mandateId: 'mdt_TEST', level, tier: 'x', status: 'active', allowAgentLayout: false, tools: mcpToolsForLevel(level).map((t) => t.name),
})
const timedOut = (): KernelReply => ({ ok: false, status: 0, timedOut: true, error: { code: 4001, name: 'INTERNAL', category: 'ENGINE', retryable: true, message: 'the kernel did not answer within 90s (it may be busy); the request may still have been processed' } })
const paperIntent = { accountId: 'acct_X', instrumentId: 'hyperliquid:BTC', side: 'buy', type: 'market', size: '0.002', reason: 'r' }

interface Sent { op: string; params: Record<string, unknown>; opts?: { timeoutMs?: number } }
function fake(level: SessionInfo['level'], handler: (op: string, params: Record<string, unknown>) => KernelReply | undefined = () => undefined) {
  const sent: Sent[] = []
  const session = sessionFor(level)
  const client = {
    async call(op: string, params: Record<string, unknown>, opts?: { timeoutMs?: number }): Promise<KernelReply> {
      sent.push({ op, params, ...(opts ? { opts } : {}) })
      return handler(op, params) ?? (op === 'agent.session' ? { ok: true, result: session } : { ok: true, result: { data: { echo: op }, session } })
    },
  }
  return { sent, client }
}
async function connect(client: Pick<KernelClient, 'call'>, orderTimeoutMs?: number, extra: { recoverAttempts?: number } = {}) {
  const mcp = createGitraderMcp({ client, recoverEveryMs: 1, recoverTimeoutMs: 50, ...extra, ...(orderTimeoutMs ? { orderTimeoutMs } : {}) })
  const [a, b] = InMemoryTransport.createLinkedPair()
  const host = new Client({ name: 'h', version: '0' }, { capabilities: {} })
  await mcp.refreshSession()
  await mcp.server.connect(b)
  await host.connect(a)
  return host
}
const errOf = (r: unknown): any => JSON.parse(((r as { content: { text: string }[] }).content[0]!).text).error // eslint-disable-line @typescript-eslint/no-explicit-any

describe('clientOrderId 必带', () => {
  it('order.place / preview 的意图没给就由 MCP 生成（32 位十六进制）；给了就原样用；Agent 的入参对象不被改写', async () => {
    const k = fake('L1')
    const host = await connect(k.client)
    await host.callTool({ name: 'order', arguments: { action: 'place', intent: paperIntent } })
    await host.callTool({ name: 'order', arguments: { action: 'preview', intent: { ...paperIntent, clientOrderId: 'ab'.repeat(16) } } })
    const sent = k.sent.filter((s) => s.op === 'agent.order')
    expect((sent[0]!.params.intent as { clientOrderId: string }).clientOrderId).toMatch(CLOID)
    expect((sent[1]!.params.intent as { clientOrderId: string }).clientOrderId).toBe('ab'.repeat(16))
    expect(paperIntent).not.toHaveProperty('clientOrderId')
  })

  it('每次生成的都不一样；propose 的每条意图也带', async () => {
    const k = fake('L2')
    const host = await connect(k.client)
    await host.callTool({ name: 'propose', arguments: { action: 'order', accountId: 'acct_X', intents: [paperIntent, paperIntent], reason: 'r' } })
    const intents = k.sent.find((s) => s.op === 'agent.propose')!.params.intents as { clientOrderId: string }[]
    expect(intents.every((i) => CLOID.test(i.clientOrderId))).toBe(true)
    expect(new Set(intents.map((i) => i.clientOrderId)).size).toBe(2)
  })

  it('下单类调用用更长的时限；读调用用默认时限', async () => {
    const k = fake('L1')
    const host = await connect(k.client, 77_000)
    await host.callTool({ name: 'order', arguments: { action: 'place', intent: paperIntent } })
    await host.callTool({ name: 'market', arguments: { action: 'search' } })
    expect(k.sent.find((s) => s.op === 'agent.order')!.opts).toEqual({ timeoutMs: 77_000 })
    expect(k.sent.find((s) => s.op === 'agent.market')!.opts?.timeoutMs).toBeUndefined()
  })
})

describe('超时 = 结果未知', () => {
  it('place 超时：3006、不要重发、带回 clientOrderId 与查询办法；不当成"连不上"', async () => {
    const k = fake('L1', (op) => (op === 'agent.order' ? timedOut() : undefined))
    const host = await connect(k.client)
    const r = await host.callTool({ name: 'order', arguments: { action: 'place', intent: paperIntent } })
    expect(r.isError).toBe(true)
    const e = errOf(r)
    const sent = (k.sent.find((s) => s.op === 'agent.order')!.params.intent as { clientOrderId: string }).clientOrderId
    expect(e).toMatchObject({ code: 3006, name: 'VENUE_OUTCOME_UNKNOWN', retryable: false, clientOrderIds: [sent] })
    expect(e.message).toMatch(/outcome unknown/)
    expect(e.message).toMatch(/Do NOT resend/)
    expect(e.message).toContain(sent)
    expect(e.message).toContain('ledger {action:"trace"')
    expect(e.message).toMatch(/SAME clientOrderId/)
    expect(e.message).not.toMatch(/cannot reach/)
  })

  it('先 preview 再 place(confirmToken) 超时：回显预览时绑定的 clientOrderId', async () => {
    const id = 'cd'.repeat(16)
    const session = sessionFor('L3')
    const k = fake('L3', (op, p) => {
      if (op !== 'agent.order') return undefined
      return p.action === 'preview' ? { ok: true, result: { data: { confirmToken: 'ctk_abc.def', normalizedIntent: { clientOrderId: id } }, session } } : timedOut()
    })
    const host = await connect(k.client)
    await host.callTool({ name: 'order', arguments: { action: 'preview', intent: paperIntent } })
    const r = await host.callTool({ name: 'order', arguments: { action: 'place', confirmToken: 'ctk_abc.def' } })
    expect(errOf(r)).toMatchObject({ name: 'VENUE_OUTCOME_UNKNOWN', clientOrderIds: [id] })
  })

  it('propose 超时：同样是结果未知，带回每条意图的 clientOrderId', async () => {
    const k = fake('L2', (op) => (op === 'agent.propose' ? timedOut() : undefined))
    const host = await connect(k.client)
    const e = errOf(await host.callTool({ name: 'propose', arguments: { action: 'order', accountId: 'acct_X', intents: [paperIntent], reason: 'r' } }))
    expect(e.name).toBe('VENUE_OUTCOME_UNKNOWN')
    expect(e.clientOrderIds).toHaveLength(1)
  })

  it('没有 clientOrderId 可查的写动作（平仓）超时：同样不让重发，提示查持仓 / 挂单 / 账本', async () => {
    const k = fake('L1', (op) => (op === 'agent.order' ? timedOut() : undefined))
    const host = await connect(k.client)
    const e = errOf(await host.callTool({ name: 'order', arguments: { action: 'close', accountId: 'acct_X', instrumentId: 'hyperliquid:BTC' } }))
    expect(e.name).toBe('VENUE_OUTCOME_UNKNOWN')
    expect(e.message).toMatch(/Do NOT resend/)
    expect(e.message).toMatch(/positions/)
  })

  it('preview 超时没有副作用，按普通超时报；读工具超时同理（都不是"结果未知"）', async () => {
    const k = fake('L1', (op) => (op === 'agent.order' || op === 'agent.market' ? timedOut() : undefined))
    const host = await connect(k.client)
    for (const call of [{ name: 'order', arguments: { action: 'preview', intent: paperIntent } }, { name: 'market', arguments: { action: 'search' } }]) {
      const e = errOf(await host.callTool(call))
      expect(e.name).toBe('INTERNAL')
      expect(e.message).toMatch(/did not answer/)
    }
  })

  it('握手说明与 order / propose 的描述都写了"结果未知勿重发"', async () => {
    const host = await connect(fake('L2').client)
    const tools = (await host.listTools()).tools
    expect(tools.find((t) => t.name === 'order')!.description).toMatch(/结果未知勿重发/)
    expect(tools.find((t) => t.name === 'propose')!.description).toMatch(/结果未知勿重发/)
    expect(host.getInstructions()).toMatch(/clientOrderId/)
  })
})

describe('超时后用内核的 order.lookup 回查', () => {
  it('回查到原单：不报错，把当前状态当结果返回（recoveredAfterTimeout），并且用的是 order.lookup 而不是账本', async () => {
    let lookups = 0
    const found = { found: true, order: { orderId: 'ord_X', status: 'filled', clientOrderId: 'x' }, trail: ['order.intent', 'order.accepted', 'fill'] }
    const k = fake('L1', (op, p) => {
      if (op === 'agent.order') return timedOut()
      if (op === 'order.lookup') { lookups += 1; return { ok: true, result: lookups < 2 ? { found: false } : { ...found, order: { ...found.order, clientOrderId: p.clientOrderId } } } } // 第二次才查到（内核刚缓过来）
      return undefined
    })
    const host = await connect(k.client)
    const r = await host.callTool({ name: 'order', arguments: { action: 'place', intent: paperIntent } })
    expect(r.isError).toBeFalsy()
    const v = JSON.parse((r.content as { text: string }[])[0]!.text)
    expect(v).toMatchObject({ recoveredAfterTimeout: true, order: { orderId: 'ord_X', status: 'filled' }, trail: ['order.intent', 'order.accepted', 'fill'] })
    const sent = (k.sent.find((s) => s.op === 'agent.order')!.params.intent as { clientOrderId: string }).clientOrderId
    const lookupCalls = k.sent.filter((s) => s.op === 'order.lookup')
    expect(lookupCalls).toHaveLength(2)
    expect(lookupCalls[0]!.params).toEqual({ clientOrderId: sent })
    expect(k.sent.some((s) => s.op === 'agent.ledger')).toBe(false)
  })

  it('propose 超时后回查到提案：返回票号与状态', async () => {
    const k = fake('L2', (op) => {
      if (op === 'agent.propose') return timedOut()
      if (op === 'order.lookup') return { ok: true, result: { found: false, proposal: { ticket: 'T-20261010-0001', status: 'pending', proposalId: 'prop_1' } } }
      return undefined
    })
    const host = await connect(k.client)
    const v = JSON.parse(((await host.callTool({ name: 'propose', arguments: { action: 'order', accountId: 'acct_X', intents: [paperIntent], reason: 'r' } })).content as { text: string }[])[0]!.text)
    expect(v).toMatchObject({ recoveredAfterTimeout: true, proposal: { ticket: 'T-20261010-0001', status: 'pending' } })
  })

  it('回查也没查到（内核答了但不认识这个单）：仍报结果未知，并说明已经查过；不重发原请求', async () => {
    const k = fake('L1', (op) => (op === 'agent.order' ? timedOut() : op === 'order.lookup' ? { ok: true, result: { found: false } } : undefined))
    const host = await connect(k.client, undefined, { recoverAttempts: 3 })
    const e = errOf(await host.callTool({ name: 'order', arguments: { action: 'place', intent: paperIntent } }))
    expect(e.name).toBe('VENUE_OUTCOME_UNKNOWN')
    expect(e.message).toMatch(/already asked the kernel \(order\.lookup\)/)
    expect(e.message).toMatch(/SAME clientOrderId/)
    expect(k.sent.filter((s) => s.op === 'agent.order')).toHaveLength(1) // 原请求只发了一次
    expect(k.sent.filter((s) => s.op === 'order.lookup')).toHaveLength(3)
  })

  it('回查时内核仍然没有回应：报结果未知，说明回查也没成', async () => {
    const k = fake('L1', (op) => (op === 'agent.order' || op === 'order.lookup' ? timedOut() : undefined))
    const host = await connect(k.client, undefined, { recoverAttempts: 2 })
    const e = errOf(await host.callTool({ name: 'order', arguments: { action: 'place', intent: paperIntent } }))
    expect(e.name).toBe('VENUE_OUTCOME_UNKNOWN')
    expect(e.message).toMatch(/order\.lookup and it still did not answer/)
  })

  it('没有 clientOrderId 可查的写动作（平仓）不回查', async () => {
    const k = fake('L1', (op) => (op === 'agent.order' ? timedOut() : undefined))
    const host = await connect(k.client)
    await host.callTool({ name: 'order', arguments: { action: 'close', accountId: 'acct_X', instrumentId: 'hyperliquid:BTC' } })
    expect(k.sent.some((s) => s.op === 'order.lookup')).toBe(false)
  })
})

describe('真 KernelClient + 卡住的内核', () => {
  it('内核不回应：place 在下单类时限后报"结果未知"，读工具在默认时限后报普通超时', async () => {
    const hang = ((_url: string, init: RequestInit) => new Promise((_res, rej) => { init.signal!.addEventListener('abort', () => rej(init.signal!.reason)) })) as never
    const session = sessionFor('L1')
    const answering = ((url: string, init: RequestInit) => (String(url).endsWith('agent.session') ? Promise.resolve(new Response(JSON.stringify({ ok: true, result: session }))) : (hang as (u: string, i: RequestInit) => Promise<Response>)(url, init))) as never
    const client = new KernelClient({ baseUrl: 'http://127.0.0.1:1', token: `gtk_${'A'.repeat(52)}`, fetch: answering, timeoutMs: 60 })
    const host = await connect(client, 120)
    const t0 = Date.now()
    const placed = errOf(await host.callTool({ name: 'order', arguments: { action: 'place', intent: paperIntent } }))
    expect(placed).toMatchObject({ code: 3006, name: 'VENUE_OUTCOME_UNKNOWN' })
    expect(placed.venue.message).toMatch(/no reply within/)
    const read = errOf(await host.callTool({ name: 'market', arguments: { action: 'search' } }))
    expect(read).toMatchObject({ name: 'INTERNAL', message: expect.stringMatching(/did not answer within/) })
    expect(Date.now() - t0).toBeLessThan(5_000)
  })
})

describe('KernelClient 的超时', () => {
  it('内核迟迟不答：返回 timedOut（与"连不上"区分）；单次调用可覆盖时限', async () => {
    const hang = ((_url: string, init: RequestInit) => new Promise((_res, rej) => { init.signal!.addEventListener('abort', () => rej(init.signal!.reason)) })) as never
    const c = new KernelClient({ baseUrl: 'http://127.0.0.1:1', token: `gtk_${'A'.repeat(52)}`, fetch: hang, timeoutMs: 5_000 })
    const t0 = Date.now()
    const r = await c.call('agent.order', {}, { timeoutMs: 40 })
    expect(Date.now() - t0).toBeLessThan(2_000)
    expect(r).toMatchObject({ ok: false, timedOut: true, error: { message: expect.stringMatching(/did not answer within/) } })
    expect(JSON.stringify(r)).not.toMatch(/cannot reach/)
  })
})
