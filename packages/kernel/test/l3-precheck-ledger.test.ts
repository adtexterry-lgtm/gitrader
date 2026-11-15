// SPDX-License-Identifier: CPAL-1.0
// L1 + L3 接线（ADR-18 / L1）：预览轰炸时账本只增前 20 条 + 汇总；提案永远逐条；被限的调用有痕；下单与急停不计数。
import { afterEach, describe, expect, it } from 'vitest'
import { makeAgent, makeHarness } from './helpers/harness'
import type { Harness } from './helpers/harness'
import { BTC } from './helpers/fake-connector'
import { Metrics } from '../src/metrics'
import type { OrderIntent } from '../src/proto'

let h: Harness | undefined
afterEach(async () => { await h?.cleanup(); h = undefined })

const notes = (h: Harness, kind: string) => [...h.k.ledger.iterate()].filter((e) => e.type === 'annotation' && (e.payload as { kind?: string } | undefined)?.kind === kind)
const prechecks = (h: Harness, actor: string) => [...h.k.ledger.iterate()].filter((e) => (e.type === 'risk.precheck' || e.type === 'risk.denied') && e.origin.actor === actor)

describe('L3 preview precheck ledger throttle', () => {
  it('100 previews in one minute write 20 entries plus one summary, chain stays valid', async () => {
    h = await makeHarness()
    const a = await makeAgent(h, 'paper')
    const ctx = a.ctx('order')
    const intent = { accountId: h.paper.accountId, instrumentId: BTC, side: 'buy', type: 'limit', price: '1', size: '0.001', reason: 'l3 bombard' } as unknown as OrderIntent
    for (let i = 0; i < 100; i++) await h.k.trading.preview(intent, ctx).catch(() => undefined)
    expect(prechecks(h, ctx.origin.actor)).toHaveLength(20)
    expect(notes(h, 'precheck.summary')).toHaveLength(0)
    h.clock.advance(61_000)
    await h.k.trading.tick()
    const [summary] = notes(h, 'precheck.summary')
    expect(summary?.payload).toMatchObject({ actor: ctx.origin.actor, count: 80 })
    expect((summary?.payload as { samplePrecheckIds: string[] }).samplePrecheckIds).toHaveLength(3)
    expect(h.k.ledger.verify().ok).toBe(true)
  })

  it('proposal prechecks are never summarised', async () => {
    h = await makeHarness()
    const a = await makeAgent(h, 'confirm')
    const ctx = a.ctx('propose')
    const intent = { accountId: h.paper.accountId, instrumentId: BTC, side: 'buy', type: 'limit', price: '70000', size: '0.001', reason: 'l3 proposal' } as unknown as OrderIntent
    for (let i = 0; i < 25; i++) {
      await h.k.trading.propose({ accountId: h.paper.accountId, intents: [{ ...intent, clientOrderId: i.toString(16).padStart(32, '0') } as never], reason: 'l3 proposal' }, ctx).catch(() => undefined)
    }
    const proposalPrechecks = [...h.k.ledger.iterate()].filter((e) => (e.type === 'risk.precheck' || e.type === 'risk.denied') && (e.payload as { path?: string } | undefined)?.path === 'proposal')
    expect(proposalPrechecks.length).toBeGreaterThanOrEqual(21)
  })
})

describe('L1 operation rate wiring', () => {
  it('read-only bombardment is limited, leaves a ledger note and a metric; place stays exempt', async () => {
    h = await makeHarness()
    const a = await makeAgent(h, 'paper')
    let limited = 0
    for (let i = 0; i < 150; i++) {
      try { h.k.consumeOperationRate(a.principal, 'agent.market', { action: 'quote' }) } catch (e) { expect((e as { problem: { name: string; message: string } }).problem).toMatchObject({ name: 'RATE_BUDGET' }); limited++ }
    }
    expect(limited).toBeGreaterThan(0)
    for (let i = 0; i < 500; i++) h.k.consumeOperationRate(a.principal, 'agent.order', { action: 'place' }) // 下单不计数
    for (let i = 0; i < 500; i++) h.k.consumeOperationRate(a.principal, 'kill') // 急停不计数
    // 另一把钥匙不受影响
    const b = await makeAgent(h, 'read_only')
    expect(() => h!.k.consumeOperationRate(b.principal, 'agent.market', { action: 'quote' })).not.toThrow()
    h.clock.advance(61_000)
    await h.k.tickOnce()
    const [note] = notes(h, 'rate.limited')
    expect(note?.payload).toMatchObject({ principal: `agent:${a.keyId}`, count: limited, operations: { 'agent.market': limited } })
    expect(new Metrics({ events: h.k.events, status: () => h!.k.status() }).render()).toContain(`gitrader_op_rate_limited_total{principal="agent:${a.keyId}"} ${limited}`)
  })
})
