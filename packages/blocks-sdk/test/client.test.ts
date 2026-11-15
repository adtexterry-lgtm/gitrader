// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KernelClient, KernelError, ATTESTATION_REQUIRED, type EventEnvelope } from '../src'
import { startFakeKernel, type FakeKernel } from '../src/testing/fake-kernel'

let k: FakeKernel
let c: KernelClient | null = null

const login = async (): Promise<string> => {
  const r = await fetch(`${k.url}/api/session`, { method: 'POST', body: JSON.stringify({ bootstrap: k.bootstrapToken }) })
  return ((await r.json()) as { sessionToken: string }).sessionToken
}
const until = async (fn: () => boolean, ms = 3000) => {
  const t0 = Date.now()
  while (!fn()) { if (Date.now() - t0 > ms) throw new Error('超时'); await new Promise((r) => setTimeout(r, 10)) }
}

beforeEach(async () => { k = await startFakeKernel() })
afterEach(async () => { c?.close(); c = null; await k.close() })

describe('KernelClient · 会话与消息形状', () => {
  it('引导令牌只能换一次会话令牌；会话令牌鉴权通过', async () => {
    const tok = await login()
    const again = await fetch(`${k.url}/api/session`, { method: 'POST', body: JSON.stringify({ bootstrap: k.bootstrapToken }) })
    expect(again.status).toBe(401)
    c = new KernelClient({ url: k.wsUrl, getToken: () => tok })
    await c.connect()
    expect(c.status).toBe('open')
    expect(c.user).toBe('usr_local')
  })

  it('错误令牌：AUTH_FAILED，状态 closed，不重连', async () => {
    c = new KernelClient({ url: k.wsUrl, getToken: () => 'wrong', reconnect: { minMs: 10 } })
    await expect(c.connect()).rejects.toMatchObject({ problemName: 'AUTH_FAILED' })
    await new Promise((r) => setTimeout(r, 120))
    expect(c.status).toBe('closed')
    expect(k.connections()).toBe(0)
  })

  it('订阅 → 事件按主题投递；取消订阅后服务端不再保留', async () => {
    const tok = await login()
    c = new KernelClient({ url: k.wsUrl, getToken: () => tok })
    await c.connect()
    const got: EventEnvelope[] = []
    const off = c.subscribe('market.quote', (e) => got.push(e), { filter: { instrumentId: 'hyperliquid:BTC' }, maxHz: 5 })
    await until(() => k.subscriptions().length === 1)
    expect(k.subscriptions()[0]).toMatchObject({ topic: 'market.quote', filter: { instrumentId: 'hyperliquid:BTC' }, maxHz: 5 })
    k.publish('market.quote', { mid: '65000.5' }, 7)
    await until(() => got.length === 1)
    expect(got[0]).toMatchObject({ topic: 'market.quote', seq: 7, data: { mid: '65000.5' } })
    off()
    await until(() => k.subscriptions().length === 0)
  })

  it('查询与命令：消息形状（命令带 origin.tool / via=ui），上游错误原文保留', async () => {
    const tok = await login()
    c = new KernelClient({ url: k.wsUrl, getToken: () => tok })
    await c.connect()
    k.onQuery('market.search', (p) => ({ hits: [(p as { q: string }).q] }))
    k.onCommand('takeover.halt_new', () => ({ ok: true }))
    k.onCommand('order.place', () => { throw Object.assign(new Error('单笔名义额超限：1000 > 500'), { code: 2001, data: { name: 'RULE_DENIED', message: '单笔名义额超限：1000 > 500' } }) })
    expect(await c.query('market.search', { q: 'BTC' })).toEqual({ hits: ['BTC'] })
    await c.command('takeover.halt_new', { reason: 'x' }, { tool: 'block:block.gitrader.statusbar:takeover.halt_new' })
    expect(k.commands[0]).toMatchObject({ action: 'takeover.halt_new', params: { reason: 'x' }, origin: { tool: 'block:block.gitrader.statusbar:takeover.halt_new', via: 'ui' } })
    const err = await c.command('order.place', {}).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(KernelError)
    expect((err as KernelError).message).toBe('单笔名义额超限：1000 > 500')
    expect((err as KernelError).problemName).toBe('RULE_DENIED')
    await expect(c.query('nope')).rejects.toMatchObject({ code: -32601 })
  })

  it('需要在场证明：内核回 ATTESTATION_REQUIRED → 调 attestor → 带证明重发一次；取消则抛原错', async () => {
    const tok = await login()
    c = new KernelClient({ url: k.wsUrl, getToken: () => tok })
    await c.connect()
    k.onCommand('trading_state.resume', (_p, ctx) => {
      if (!ctx.attestation) throw Object.assign(new Error('需要在场证明'), { code: 2009, data: { name: ATTESTATION_REQUIRED } })
      return { state: 'ACTIVE' }
    })
    const attest = vi.fn(async () => ({ method: 'pin' as const, pin: '123456' }))
    c.setAttestor(attest)
    expect(await c.command('trading_state.resume', { scope: 'org' })).toEqual({ state: 'ACTIVE' })
    expect(attest).toHaveBeenCalledOnce()
    expect(k.commands.map((x) => x.attestation ?? null)).toEqual([null, { method: 'pin', pin: '123456' }])
    c.setAttestor(async () => null)
    await expect(c.command('trading_state.resume', {})).rejects.toMatchObject({ problemName: ATTESTATION_REQUIRED })
  })

  it('断线自动重连并重订阅，带上最后 seq 之后的 fromSeq', async () => {
    const tok = await login()
    c = new KernelClient({ url: k.wsUrl, getToken: () => tok, reconnect: { minMs: 20, maxMs: 50 } })
    await c.connect()
    const statuses: string[] = []
    c.onStatus((s) => statuses.push(s))
    const got: EventEnvelope[] = []
    c.subscribe('account.positions', (e) => got.push(e))
    await until(() => k.subscriptions().length === 1)
    k.publish('account.positions', { n: 1 }, 41)
    await until(() => got.length === 1)
    k.dropConnections()
    await until(() => statuses.includes('reconnecting'))
    await until(() => c!.status === 'open' && k.subscriptions().length === 1)
    expect(k.subscriptions()[0]?.fromSeq).toBe(42)
    k.publish('account.positions', { n: 2 }, 42)
    await until(() => got.length === 2)
    expect(got.map((e) => e.seq)).toEqual([41, 42])
  })

  it('断线时进行中的请求以「结果未知」拒绝', async () => {
    const tok = await login()
    c = new KernelClient({ url: k.wsUrl, getToken: () => tok, reconnect: false })
    await c.connect()
    k.onCommand('order.place', () => new Promise(() => {}))
    const p = c.command('order.place', {})
    await until(() => k.commands.length === 1)
    k.dropConnections()
    await expect(p).rejects.toMatchObject({ code: -32001 })
    await expect(p).rejects.toThrow(/结果未知/)
  })
})
