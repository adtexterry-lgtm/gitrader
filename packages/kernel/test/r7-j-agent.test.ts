// SPDX-License-Identifier: CPAL-1.0
// r7 WP-J：GQ-42 令牌轮换 / GQ-43 吊销原因 / GQ-44 中文说明 / GQ-46 接管后状态 / GQ-48 标的搜索
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { OrderIntent } from '../src/proto'
import { startHttp } from '../src/http/server'
import { zhNote, stopAdvice } from '../src/api/agent-out'
import { BTC } from './helpers/fake-connector'
import { enableLive, makeAgent, makeHarness } from './helpers/harness'
import type { Harness, TestAgent } from './helpers/harness'

/* eslint-disable @typescript-eslint/no-explicit-any */
let h: Harness
beforeEach(async () => { h = await makeHarness() })
afterEach(async () => { await h.cleanup() })

const RID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d'
interface Reply { data: any; session: any }
const call = async (a: TestAgent, tool: string, params: Record<string, unknown> = {}): Promise<Reply> =>
  (await h.k.ops.call(h.k, `agent.${tool}`, { principal: a.principal, params: { requestId: RID, ...params }, transport: 'http' })) as Reply
const intent = (o: Partial<OrderIntent> = {}): OrderIntent => ({ accountId: h.paper.accountId as never, instrumentId: BTC, side: 'buy', type: 'market', size: '0.003' as never, leverage: 2, reason: 'funding flipped', ...o } as OrderIntent)

describe('GQ-42 轮换后旧令牌立即失效（含已进缓存的）', () => {
  it('旧令牌失效（反例）、新令牌可用（正例）', async () => {
    const a = await makeAgent(h, 'paper')
    expect(h.k.agents.verifyToken(a.token)).not.toBeNull() // 进缓存
    const r = h.k.agents.rotateKey(a.keyId, await h.pinProof(), h.human('cli:keys.rotate').origin)
    expect(h.k.agents.verifyToken(a.token)).toBeNull()
    expect(h.k.agents.verifyToken(r.token)).toMatchObject({ keyId: a.keyId })
  })
  it('别的进程改了钥匙文档（指纹变了）而本进程缓存还在：旧令牌也认不了', async () => {
    const a = await makeAgent(h, 'paper')
    expect(h.k.agents.verifyToken(a.token)).not.toBeNull()
    const docs = (h.k.agents as any).docs
    const doc = docs.get('agentkey', a.keyId)
    docs.put('agentkey', a.keyId, { ...doc, secret: { ...doc.secret, fp: 'ffffffffffffffff' } }) // 不经过本实例的 cache.clear()
    expect(h.k.agents.verifyToken(a.token)).toBeNull()
  })
})

describe('GQ-43 吊销 / 过期给明确原因（仍 401、仍 AUTH_FAILED）', () => {
  const url = (s: { server: { address(): unknown } }): string => `http://127.0.0.1:${(s.server.address() as AddressInfo).port}/api/op/agent.session`
  const post = (u: string, token: string) => fetch(u, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{"params":{}}' })
  it('吊销：同一令牌 401 + KEY_REVOKED；乱写的令牌仍是笼统句', async () => {
    const a = await makeAgent(h, 'paper')
    const server = await startHttp(h.k, { port: 0 })
    try {
      expect((await post(url(server), a.token)).status).toBe(200)
      h.k.agents.revokeKey(a.keyId, h.sessionProof(), h.human('t').origin)
      const gone = await post(url(server), a.token)
      expect(gone.status).toBe(401)
      const body = await gone.json() as any
      expect(body.error.name).toBe('AUTH_FAILED')
      expect(body.error.message).toMatch(/^KEY_REVOKED/)
      const junk = await (await post(url(server), 'gtk_' + 'A'.repeat(52))).json() as any
      expect(junk.error.message).toContain('authentication required')
    } finally { await server.close() }
  })
  it('tokenStatus：有效 active；格式不对 unknown；轮换后的旧令牌 unknown（不是 revoked）', async () => {
    const a = await makeAgent(h, 'paper')
    expect(h.k.agents.tokenStatus(a.token)).toBe('active')
    expect(h.k.agents.tokenStatus('not-a-token')).toBe('unknown')
    h.k.agents.rotateKey(a.keyId, await h.pinProof(), h.human('t').origin)
    expect(h.k.agents.tokenStatus(a.token)).toBe('unknown')
  })
})

describe('GQ-44 中文说明与止损提示（只加字段，不改判定）', () => {
  it('zhNote / stopAdvice 纯函数正反双向', () => {
    expect(zhNote([{ code: 'LLM_LIVE_ENTRY' }])).toContain('AI 不能直接实盘开仓')
    expect(zhNote([{ code: 'NEW_CODE' }])).toContain('NEW_CODE')
    expect(zhNote([])).toBeUndefined()
    expect(stopAdvice([{ side: 'buy' }])).toHaveLength(1)
    expect(stopAdvice([{ side: 'buy', tpsl: { stopLoss: { triggerPrice: '1' } } }])).toEqual([])
    expect(stopAdvice([{ side: 'sell', reduceOnly: true }])).toEqual([])
  })
  it('被拒预览：note 中文、ruleHits[].zh 有、verdict 仍是 deny、不发 token；无 tpsl 有 warnings', async () => {
    await enableLive(h)
    const a = await makeAgent(h, 'auto_limited')
    const r = await call(a, 'order', { action: 'preview', intent: intent({ accountId: h.liveAcct.accountId as never }) })
    expect(r.data.precheck.verdict).toBe('deny')
    expect(r.data.confirmToken).toBeUndefined()
    expect(r.data.note).toContain('AI 不能直接实盘开仓')
    const hit = r.data.precheck.ruleHits.find((x: any) => x.code === 'LLM_LIVE_ENTRY')
    expect(hit.zh).toContain('AI 不能直接实盘开仓')
    expect(hit.action).toBe('deny')
    expect(r.data.warnings.join('')).toContain('没带止损')
  })
  it('纸面预览放行：没有 note；带止损的不提示，不带的提示（正反）', async () => {
    const a = await makeAgent(h, 'paper')
    const ok = await call(a, 'order', { action: 'preview', intent: intent({ tpsl: { stopLoss: { triggerPrice: '1' } } } as never) })
    expect(ok.data.note).toBeUndefined()
    expect((ok.data.warnings ?? []).join('')).not.toContain('没带止损')
    const bare = await call(a, 'order', { action: 'preview', intent: intent() })
    expect((bare.data.warnings ?? []).join('')).toContain('没带止损')
  })
})

describe('GQ-46 接管后钥匙自己看到的状态', () => {
  it('halt_new（授权书作用域）后 risk_status 与 mandate.status 都不再是 ACTIVE', async () => {
    const a = await makeAgent(h, 'paper')
    expect((await call(a, 'risk_status', { action: 'state' })).data.tradingState).toBe('ACTIVE')
    await call(a, 'takeover', { action: 'halt_new', reason: 'test self protect' })
    expect((await call(a, 'risk_status', { action: 'state' })).data.tradingState).not.toBe('ACTIVE')
    expect((await call(a, 'mandate', { action: 'status' })).data.tradingState).not.toBe('ACTIVE')
  })
  it('别的钥匙的接管不串到这把（反例）', async () => {
    const a = await makeAgent(h, 'paper')
    const b = await makeAgent(h, 'confirm')
    await call(b, 'takeover', { action: 'halt_new', reason: 'x' })
    expect((await call(a, 'risk_status', { action: 'state' })).data.tradingState).toBe('ACTIVE')
    expect((await call(b, 'risk_status', { action: 'state' })).data.tradingState).not.toBe('ACTIVE')
  })
})

describe('GQ-48 market.search', () => {
  it('btc 命中；btc/usdt 归一化；空查询空表 + hint；乱串无命中', async () => {
    const a = await makeAgent(h, 'paper')
    expect((await call(a, 'market', { action: 'search', query: 'btc' })).data.items[0].instrumentId).toBe(BTC)
    expect((await call(a, 'market', { action: 'search', query: 'btc/usdt' })).data.items.map((i: any) => i.instrumentId)).toContain(BTC)
    const empty = (await call(a, 'market', { action: 'search', query: '' })).data
    expect(empty.items).toEqual([])
    expect(empty.hint).toContain('query is required')
    expect((await call(a, 'market', { action: 'search', query: 'zzzzzz' })).data.items).toEqual([])
  })
})
