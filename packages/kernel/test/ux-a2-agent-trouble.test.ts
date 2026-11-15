// SPDX-License-Identifier: CPAL-1.0
// A2 追加：第 1 层 INVALID_PARAMS 的 next 附调用示例；第 3 层 K5 agentTrouble 供数（内存计数，不写账本）。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AgentTrouble } from '../src/agent-trouble'
import { BTC } from './helpers/fake-connector'
import { makeAgent, makeHarness } from './helpers/harness'
import type { Harness } from './helpers/harness'

let h: Harness
beforeEach(async () => { h = await makeHarness() })
afterEach(async () => { await h.cleanup() })
const RID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d'
type P = { name: string; message: string; next?: string }
const call = async (a: Awaited<ReturnType<typeof makeAgent>>, tool: string, params: Record<string, unknown>): Promise<{ ok: boolean; p?: P }> =>
  h.k.ops.call(h.k, `agent.${tool}`, { principal: a.principal, params: { requestId: RID, ...params }, transport: 'http' }).then(() => ({ ok: true }), (x: { problem?: P }) => ({ ok: false, ...(x.problem ? { p: x.problem } : {}) }))

describe('第 1 层：INVALID_PARAMS 的 next 附正确调用示例', () => {
  it('order.preview 缺 intent / 未知动作 / 缺动作：next 都是 gitrader agent … --args 示例，message 不变', async () => {
    const a = await makeAgent(h, 'paper')
    const r1 = await call(a, 'order', { action: 'preview', accountId: h.paper.accountId, intents: [{}] })
    expect(r1.p?.name).toBe('INVALID_PARAMS')
    expect(r1.p?.message).toContain('intent is required')
    expect(r1.p?.next).toMatch(/^gitrader agent order preview --args '\{.*"intent".*\}'$/)
    const r2 = await call(a, 'account', { action: 'sumary' })
    expect(r2.p?.name).toBe('INVALID_PARAMS')
    expect(r2.p?.next).toMatch(/^gitrader agent account \w+ --args '/)
    const r3 = await call(a, 'account', {})
    expect(r3.p?.next).toMatch(/^gitrader agent account \w+ --args '/)
  })
  it('非 INVALID_PARAMS 的拒绝不带 next', async () => {
    const a = await makeAgent(h, 'read_only')
    const r = await call(a, 'order', { action: 'preview', accountId: h.paper.accountId, intent: { accountId: h.paper.accountId, instrumentId: BTC, side: 'buy', type: 'market', size: '0.001', reason: 't' } })
    expect(r.ok).toBe(false)
    expect(r.p?.name).not.toBe('INVALID_PARAMS')
    expect(r.p?.next).toBeUndefined()
  })
})

describe('第 3 层 K5：agentTrouble', () => {
  it('连续 3 次参数错 → 快照出现；成功一次清零；不写账本', async () => {
    const a = await makeAgent(h, 'paper')
    expect(h.k.healthSnapshot().agentTrouble).toBeNull()
    const ledgerBefore = h.k.ledger.count()
    for (let i = 0; i < 2; i++) await call(a, 'order', { action: 'preview', accountId: h.paper.accountId })
    expect(h.k.healthSnapshot().agentTrouble).toBeNull()
    await call(a, 'order', { action: 'preview', accountId: h.paper.accountId })
    const t = h.k.healthSnapshot().agentTrouble!
    expect(t).toMatchObject({ key: 'bot-paper', count: 3 })
    expect(typeof t.at).toBe('number')
    expect(t.lastError).toContain('order.preview')
    expect(t.lastError).not.toContain(a.token)
    expect((h.k.status() as { agentTrouble: unknown }).agentTrouble).toMatchObject({ count: 3 })
    expect(h.k.ledger.count()).toBe(ledgerBefore)
    expect((await call(a, 'account', { action: 'summary', accountId: h.paper.accountId })).ok).toBe(true)
    expect(h.k.healthSnapshot().agentTrouble).toBeNull()
  })
  it('5 分钟窗口：旧失败不算', () => {
    let now = 0
    const t = new AgentTrouble(() => now)
    t.fail('k1', 'INVALID_PARAMS', 'order', 'preview'); now += 1000
    t.fail('k1', 'INVALID_PARAMS', 'order', 'preview'); now += 6 * 60_000
    t.fail('k1', 'INVALID_PARAMS', 'order', 'preview')
    expect(t.worst(() => 'x')).toBeNull()
    now += 1000; t.fail('k1', 'INVALID_PARAMS', 'order', 'preview'); now += 1000; t.fail('k1', 'INVALID_PARAMS', 'order', 'preview')
    expect(t.worst((id) => `name-${id}`)).toMatchObject({ key: 'name-k1', count: 3 })
  })
  it('风控 / 级别类拒绝不计数', () => {
    const t = new AgentTrouble(() => 0)
    for (let i = 0; i < 5; i++) t.fail('k1', 'MANDATE_LEVEL', 'order', 'place')
    expect(t.worst((id) => id)).toBeNull()
  })
})
