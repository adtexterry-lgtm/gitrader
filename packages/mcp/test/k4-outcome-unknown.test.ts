// SPDX-License-Identifier: CPAL-1.0
// K4（ADR-20）：发出后断开 = 结果未知（3006、不可重试、带 clientOrderIds）；没发出 = 可重试；重启后按 order.lookup 回查；预览回显 clientOrderId。
// 用真本地 http 服务器（端口 0 由系统分配）造"收到请求后掐断连接 / 响应读到一半断开 / 拒连"。
import { createServer } from 'node:http'
import type { IncomingMessage, Server as HttpServer, ServerResponse } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { mcpToolsForLevel } from '@gitrader/protocol'
import { KernelClient } from '../src/client'
import type { KernelReply } from '../src/client'
import { createGitraderMcp } from '../src/server'
import type { SessionInfo } from '../src/server'

const TOKEN = `gtk_${'A'.repeat(52)}`
const session: SessionInfo = { keyId: 'ak_TEST', mandateId: 'mdt_TEST', level: 'L1', tier: 'x', status: 'active', allowAgentLayout: false, tools: mcpToolsForLevel('L1').map((t) => t.name) }
const intent = { accountId: 'acct_X', instrumentId: 'hyperliquid:BTC', side: 'buy', type: 'market', size: '0.002', reason: 'r' }
const CLOID = /^[0-9a-f]{32}$/

type Handler = (op: string, params: Record<string, unknown>, req: IncomingMessage, res: ServerResponse) => void
const servers: HttpServer[] = []
async function startKernel(handler: Handler): Promise<string> {
  const srv = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += String(c) })
    req.on('end', () => {
      const op = (req.url ?? '').replace('/api/op/', '')
      handler(op, (JSON.parse(raw || '{}') as { params?: Record<string, unknown> }).params ?? {}, req, res)
    })
  })
  servers.push(srv)
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  const addr = srv.address()
  return `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
}
afterEach(() => { for (const s of servers.splice(0)) { s.closeAllConnections(); s.close() } })

const json = (res: ServerResponse, body: unknown): void => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
const answerSession = (res: ServerResponse): void => json(res, { ok: true, result: session })

async function connect(client: Pick<KernelClient, 'call'>) {
  const mcp = createGitraderMcp({ client, recoverEveryMs: 1, recoverTimeoutMs: 500, recoverAttempts: 2 })
  const [a, b] = InMemoryTransport.createLinkedPair()
  const host = new Client({ name: 'h', version: '0' }, { capabilities: {} })
  await mcp.refreshSession()
  await mcp.server.connect(b)
  await host.connect(a)
  return host
}
const errOf = (r: unknown): any => JSON.parse(((r as { content: { text: string }[] }).content[0]!).text).error // eslint-disable-line @typescript-eslint/no-explicit-any
const valOf = (r: unknown): any => JSON.parse(((r as { content: { text: string }[] }).content[0]!).text) // eslint-disable-line @typescript-eslint/no-explicit-any

describe('K4 结果未知语义', () => {
  it('ECONNRESET after send is outcome-unknown with clientOrderIds', async () => {
    const sent: string[] = []
    const url = await startKernel((op, params, req, res) => {
      if (op === 'agent.session') return answerSession(res)
      if (op === 'agent.order') { sent.push((params.intent as { clientOrderId: string }).clientOrderId); req.socket.destroy(); return } // 收到了、没回应就断
      res.writeHead(404); res.end()
    })
    // 客户端层：标 outcomeUnknown，不标 notSent
    const client = new KernelClient({ baseUrl: url, token: TOKEN })
    const raw = await client.call('agent.order', { action: 'place', intent })
    expect(raw).toMatchObject({ ok: false, outcomeUnknown: true, error: { code: 3006, name: 'VENUE_OUTCOME_UNKNOWN', category: 'VENUE', retryable: false, venue: { id: 'gitrader-kernel' } } })
    expect((raw as { notSent?: true }).notSent).toBeUndefined()
    // MCP 层：写动作给 3006 + 本次的 clientOrderIds + 不许盲目重发
    const host = await connect(client)
    const r = await host.callTool({ name: 'order', arguments: { action: 'place', intent } })
    expect(r.isError).toBe(true)
    const e = errOf(r)
    const id = sent[sent.length - 1]!
    expect(id).toMatch(CLOID)
    expect(e).toMatchObject({ code: 3006, name: 'VENUE_OUTCOME_UNKNOWN', retryable: false, clientOrderIds: [id] })
    expect(e.message).toMatch(/connection to the kernel dropped/)
    expect(e.message).toMatch(/Do NOT resend/)
    expect(e.message).not.toMatch(/did not answer within/) // 断开与超时的文案区分开
    expect(e.venue.message).toBeTruthy()
  })

  it('ECONNREFUSED stays retryable', async () => {
    const url = await startKernel((_o, _p, _q, res) => { res.end() })
    const dead = servers.pop()!
    dead.close() // 端口刚释放：连上去 = 拒连
    const client = new KernelClient({ baseUrl: url, token: TOKEN })
    const r = await client.call('agent.order', { action: 'place', intent })
    expect(r).toMatchObject({ ok: false, notSent: true, error: { name: 'INTERNAL', retryable: true, message: expect.stringMatching(/cannot reach the Gitrader kernel/) } })
    expect((r as { outcomeUnknown?: true }).outcomeUnknown).toBeUndefined()
    // 内核从没起过（service.json 读不到）同样是"没发出"
    const noHome = new KernelClient({ baseUrl: () => { throw new Error('no running Gitrader service found at x') }, token: TOKEN })
    expect(await noHome.call('agent.order', {})).toMatchObject({ ok: false, notSent: true, error: { retryable: true } })
    // MCP 层：写动作拒连不是"结果未知"，原样报可重试
    const host = await connect({ call: async (op, p, o) => (op === 'agent.session' ? { ok: true, result: session } : client.call(op, p, o)) })
    const e = errOf(await host.callTool({ name: 'order', arguments: { action: 'place', intent } }))
    expect(e).toMatchObject({ name: 'INTERNAL', retryable: true })
    expect(e.name).not.toBe('VENUE_OUTCOME_UNKNOWN')
  })

  it('kernel restarted: recover() finds the filled order', async () => {
    let lookups = 0
    const url = await startKernel((op, params, req, res) => {
      if (op === 'agent.session') return answerSession(res)
      if (op === 'agent.order') { req.socket.destroy(); return } // 内核处理了单，但回包前连接断了
      if (op === 'order.lookup') {
        lookups += 1
        return json(res, { ok: true, result: { found: true, order: { orderId: 'ord_K4', status: 'filled', clientOrderId: params.clientOrderId }, trail: ['order.intent', 'fill'] } })
      }
      res.writeHead(404); res.end()
    })
    const host = await connect(new KernelClient({ baseUrl: url, token: TOKEN }))
    const r = await host.callTool({ name: 'order', arguments: { action: 'place', intent } })
    expect(r.isError).toBeFalsy()
    expect(valOf(r)).toMatchObject({ recoveredAfterTimeout: true, order: { orderId: 'ord_K4', status: 'filled' } })
    expect(lookups).toBe(1)
  })

  it('响应体读到一半断开 = 结果未知', async () => {
    const url = await startKernel((op, _p, req, res) => {
      if (op === 'agent.session') return answerSession(res)
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': '500' })
      res.write('{"ok":true,"result":{"da')
      setTimeout(() => req.socket.destroy(), 20)
    })
    const r = await new KernelClient({ baseUrl: url, token: TOKEN }).call('agent.order', { action: 'cancel' })
    expect(r).toMatchObject({ ok: false, outcomeUnknown: true, status: 200, error: { name: 'VENUE_OUTCOME_UNKNOWN', retryable: false, message: expect.stringMatching(/reading the reply/) } })
    // 只读调用的中途断开：MCP 给 INTERNAL + retryable:true（没有副作用）
    const host = await connect(new KernelClient({ baseUrl: url, token: TOKEN }))
    const e = errOf(await host.callTool({ name: 'market', arguments: { action: 'search' } }))
    expect(e).toMatchObject({ name: 'INTERNAL', retryable: true })
  })

  it('preview echoes clientOrderId', async () => {
    const id = 'ef'.repeat(16)
    const client = {
      async call(op: string): Promise<KernelReply> {
        if (op === 'agent.session') return { ok: true, result: session }
        return { ok: true, result: { data: { confirmToken: 'ctk_a.b', normalizedIntent: { clientOrderId: id, size: '0.002' } }, session } }
      },
    }
    const host = await connect(client)
    const v = valOf(await host.callTool({ name: 'order', arguments: { action: 'preview', intent } }))
    expect(v.clientOrderId).toBe(id)
    expect(v.normalizedIntent.clientOrderId).toBe(id) // 原有字段不动
  })

  it('下单类：本地合成的失败（没发出）带 clientOrderIds；内核答复的拒绝原话透传不加字段', async () => {
    let mode: 'refused' | 'denied' = 'refused'
    const client = {
      async call(op: string): Promise<KernelReply> {
        if (op === 'agent.session') return { ok: true, result: session }
        return mode === 'refused'
          ? { ok: false, status: 0, notSent: true, error: { code: 4001, name: 'INTERNAL', category: 'ENGINE', retryable: true, message: 'cannot reach the Gitrader kernel at x: ECONNREFUSED' } }
          : { ok: false, status: 403, error: { code: 2001, name: 'RULE_DENIED', category: 'RISK', retryable: false, message: 'denied' } }
      },
    }
    const host = await connect(client)
    const a = errOf(await host.callTool({ name: 'order', arguments: { action: 'place', intent } }))
    expect(a).toMatchObject({ name: 'INTERNAL', retryable: true })
    expect(a.clientOrderIds).toHaveLength(1)
    mode = 'denied'
    const b = errOf(await host.callTool({ name: 'order', arguments: { action: 'place', intent } }))
    expect(b).toEqual({ code: 2001, name: 'RULE_DENIED', category: 'RISK', retryable: false, message: 'denied' })
  })
})
