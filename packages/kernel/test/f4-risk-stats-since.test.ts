// SPDX-License-Identifier: CPAL-1.0
// ADR-25 D3：risk.stats 支持按事件时间起点（sinceTs）统计、把提案阶段预检的拒绝计入 denied、并按 actor 记提案数。
import { afterEach, describe, expect, it } from 'vitest'
import { asDecimal } from '@gitrader/protocol'
import type { OrderIntent } from '../src/proto'
import { makeAgent, makeHarness } from './helpers/harness'
import type { Harness } from './helpers/harness'
import { BTC } from './helpers/fake-connector'
import { newClientOrderId } from '../src/util/ids'

let h: Harness | undefined
afterEach(async () => { await h?.cleanup() })

const orderIntent = (accountId: string, overrides: Partial<OrderIntent> = {}): OrderIntent => ({
  accountId: accountId as never, instrumentId: BTC, side: 'buy', type: 'limit',
  size: asDecimal('0.001'), price: asDecimal('80000'), tif: 'gtc', clientOrderId: newClientOrderId(), ...overrides,
})

describe('risk stats since and proposals', () => {
  it('sinceTs filters older ledger entries', async () => {
    h = await makeHarness()
    h.sim.marks.delete(BTC)
    h.live.marks.delete(BTC)
    const first = await h.k.trading.preview(orderIntent(h.paper.accountId), h.human())
    expect(first.precheck.verdict).toBe('deny')
    const t1 = h.clock.advance(60_000)
    const second = await h.k.trading.preview(orderIntent(h.paper.accountId), h.human())
    expect(second.precheck.verdict).toBe('deny')
    expect(h.k.risk.stats({ sinceTs: t1 }).denied).toBe(1)
    expect(h.k.risk.stats().denied).toBe(2)
  })

  it('proposal-stage denials are counted', async () => {
    h = await makeHarness()
    h.sim.marks.delete(BTC)
    h.live.marks.delete(BTC)
    const agent = await makeAgent(h, 'confirm')
    const ctx = agent.ctx('propose')
    const proposal = await h.k.trading.propose({ accountId: h.paper.accountId, reason: 'denied proposal', intents: [orderIntent(h.paper.accountId)] }, ctx)
    expect(proposal.status).toBe('denied')
    const stats = h.k.risk.stats()
    expect(stats.denied).toBe(1)
    expect(stats.byActor[ctx.origin.actor]?.denied).toBe(1)
  })

  it('只读档在纸面账户提案被拒：文案说只读（不提实盘），计入 denied 且只计一次', async () => {
    h = await makeHarness()
    const agent = await makeAgent(h, 'read_only')
    const ctx = agent.ctx('propose')
    const proposal = await h.k.trading.propose({ accountId: h.paper.accountId, reason: 'readonly try', intents: [orderIntent(h.paper.accountId)] }, ctx)
    expect(proposal.status).toBe('denied')
    const hit = (proposal.precheck?.ruleHits ?? []).find((r) => r.code === 'MANDATE_LEVEL')
    expect(hit?.message).toContain('这把钥匙是只读档，不能下单')
    expect(hit?.message).not.toContain('实盘')
    const stats = h.k.risk.stats()
    expect(stats.denied).toBe(1)
    expect(stats.byActor[ctx.origin.actor]?.denied).toBe(1)
  })

  it('proposals are counted per actor', async () => {
    h = await makeHarness()
    const agent = await makeAgent(h, 'confirm')
    const ctx = agent.ctx('propose')
    const one = await h.k.trading.propose({ accountId: h.paper.accountId, reason: 'first', intents: [orderIntent(h.paper.accountId)] }, ctx)
    const two = await h.k.trading.propose({ accountId: h.paper.accountId, reason: 'second', intents: [orderIntent(h.paper.accountId)] }, ctx)
    expect([one.status, two.status]).toEqual(['pending', 'pending'])
    const stats = h.k.risk.stats()
    expect(stats.byActor[ctx.origin.actor]?.proposals).toBe(2)
  })

  it('risk.stats op rejects a bad sinceTs', async () => {
    h = await makeHarness()
    await expect(h.k.ops.call(h.k, 'risk.stats', { principal: h.session, params: { sinceTs: -1 }, transport: 'http' }))
      .rejects.toMatchObject({ problem: { name: 'INVALID_PARAMS' } })
    await expect(h.k.ops.call(h.k, 'risk.stats', { principal: h.session, params: { sinceTs: 'x' }, transport: 'http' }))
      .rejects.toMatchObject({ problem: { name: 'INVALID_PARAMS' } })
    const ok = await h.k.ops.call(h.k, 'risk.stats', { principal: h.session, params: { sinceTs: 0 }, transport: 'http' }) as { denied: number }
    expect(ok.denied).toBe(0)
  })
})
