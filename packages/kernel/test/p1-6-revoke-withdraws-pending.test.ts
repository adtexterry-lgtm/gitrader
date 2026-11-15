// SPDX-License-Identifier: CPAL-1.0
// P1-6：吊销钥匙 → 作废其待批提案；报出名下遗留的持仓 / 挂单（只统计，不平仓、不撤单）；
// 吊销后的失败原因说「钥匙已被撤销」，问题码仍是 MANDATE_EXPIRED。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { OrderIntent } from '../src/proto'
import type { RevokeResult } from '../src/agent-revoke'
import { BTC, ETH } from './helpers/fake-connector'
import { TEST_PIN, enableLive, makeAgent, makeHarness } from './helpers/harness'
import type { Harness } from './helpers/harness'

let h: Harness
beforeEach(async () => { h = await makeHarness() })
afterEach(async () => { await h.cleanup() })

const liveIntent = (o: Partial<OrderIntent> = {}): OrderIntent => ({ accountId: h.liveAcct.accountId as never, instrumentId: BTC, side: 'buy', type: 'market', size: '0.003' as never, leverage: 2, reason: 'funding flipped', ...o } as OrderIntent)
const paperIntent = (o: Partial<OrderIntent> = {}): OrderIntent => liveIntent({ accountId: h.paper.accountId as never, ...o })

// fix-r4 C6：agentkey.revoke 的在场证明由 session 改为 pin，helper 带 PIN（先 pinProof 确保已设 PIN）
const revoke = async (keyId: string): Promise<RevokeResult & { keyId: string }> => {
  await h.pinProof()
  return (await h.k.ops.call(h.k, 'agentkey.revoke', { principal: h.session, params: { keyId }, pin: TEST_PIN, transport: 'http' })) as RevokeResult & { keyId: string }
}

describe('吊销钥匙的完整动作', () => {
  it('revoke withdraws pending proposals of that key', async () => {
    await enableLive(h)
    const a = await makeAgent(h, 'confirm')
    const b = await makeAgent(h, 'confirm')
    const p1 = await h.k.trading.propose({ accountId: h.liveAcct.accountId, intents: [liveIntent()], reason: 'one' }, a.ctx('propose'))
    const p2 = await h.k.trading.propose({ accountId: h.liveAcct.accountId, intents: [liveIntent({ size: '0.004' as never })], reason: 'two' }, a.ctx('propose'))
    const other = await h.k.trading.propose({ accountId: h.liveAcct.accountId, intents: [liveIntent({ size: '0.005' as never })], reason: 'other key' }, b.ctx('propose'))
    expect([p1.status, p2.status, other.status]).toEqual(['pending', 'pending', 'pending'])

    const r = await revoke(a.keyId)
    expect(r.keyId).toBe(a.keyId)
    expect([...r.withdrawn].sort()).toEqual([p1.ticket, p2.ticket].sort())
    const w1 = h.k.trading.getProposal(p1.proposalId)!
    const w2 = h.k.trading.getProposal(p2.proposalId)!
    expect(w1.status).toBe('withdrawn')
    expect(w2.status).toBe('withdrawn')
    expect(w1.decision?.note).toBe('钥匙已撤销，提案自动作废')
    expect(w2.decision?.note).toBe('钥匙已撤销，提案自动作废')
    // 别的钥匙的待批提案不受影响
    expect(h.k.trading.getProposal(other.proposalId)!.status).toBe('pending')
    // 作废走现有撤回路径：账本里有 proposal.withdrawn，归属已撤销的钥匙
    const withdrawnEntries = h.k.ledger.query({ types: ['proposal.withdrawn'], limit: 10 })
    expect(withdrawnEntries.map((e) => e.origin.actor)).toEqual([`agent:${a.keyId}`, `agent:${a.keyId}`])
  })

  it('revoke reports open positions and orders left behind', async () => {
    const a = await makeAgent(h, 'paper')
    const filled = await h.k.trading.place({ intent: paperIntent() }, a.ctx())
    expect(filled.order?.status).toBe('filled')
    h.clock.advance(6000)
    const open = await h.k.trading.place({ intent: paperIntent({ instrumentId: ETH, type: 'limit', price: '2399' as never, size: '0.01' as never }) }, a.ctx())
    expect(open.order?.status).toBe('open')

    const r = await revoke(a.keyId)
    expect(r.openPositions).toBe(1)
    expect(r.openOrders).toBe(1)
    // 只统计，不自动平仓、不自动撤单
    expect(h.sim.positions.get(h.paper.accountId)?.some((p) => p.instrumentId === BTC)).toBe(true)
    expect(h.k.orders.get(open.order!.orderId)!.status).toBe('open')
  })

  it('approving after revoke says key revoked', async () => {
    await enableLive(h)
    const a = await makeAgent(h, 'confirm')
    const p = await h.k.trading.propose({ accountId: h.liveAcct.accountId, intents: [liveIntent()], reason: 'before revoke' }, a.ctx('propose'))
    expect(p.status).toBe('pending')
    await revoke(a.keyId)
    // 待批提案已被自动作废，批准不再成立
    await expect(h.k.trading.approve(p.ticket, h.sessionProof(), h.human())).rejects.toMatchObject({ problem: { name: 'INVALID_PARAMS', message: expect.stringContaining('withdrawn') } })
    // 同一把钥匙再提案：失败原因说钥匙已撤销，问题码不变
    await expect(h.k.trading.propose({ accountId: h.liveAcct.accountId, intents: [liveIntent({ size: '0.004' as never })], reason: 'after revoke' }, a.ctx('propose')))
      .rejects.toMatchObject({ problem: { name: 'MANDATE_EXPIRED', message: expect.stringContaining('已被撤销') } })
  })
})

describe('撤销钥匙要 PIN（fix-r4 C6）', () => {
  it('会话没带 PIN 证明 → ATTESTATION_REQUIRED，钥匙仍可用', async () => {
    const a = await makeAgent(h, 'paper')
    await expect(h.k.ops.call(h.k, 'agentkey.revoke', { principal: h.session, params: { keyId: a.keyId }, transport: 'http' }))
      .rejects.toMatchObject({ problem: { name: 'ATTESTATION_REQUIRED' } })
    expect(h.k.agents.getKey(a.keyId)?.status).not.toBe('revoked')
  })
})
