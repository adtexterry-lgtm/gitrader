// SPDX-License-Identifier: CPAL-1.0
import { afterEach, describe, expect, it } from 'vitest'
import { asDecimal } from '@gitrader/protocol'
import type { GateDecision, OrderIntent, Position } from '../src/proto'
import { BTC } from './helpers/fake-connector'
import { makeAgent, makeHarness } from './helpers/harness'
import type { Harness } from './helpers/harness'
import { newClientOrderId } from '../src/util/ids'

let h: Harness | undefined
afterEach(async () => { await h?.cleanup(); h = undefined })

type MarkSource = { mark?: (_id: string, options?: { allowStale?: boolean }) => { price: string; ts: number; source: 'venue_mark' | 'last' | 'mid' } | undefined }

function markSource(harness: Harness): MarkSource { return harness.live as unknown as MarkSource }

/** 旧标记先返回，安装后 N ms 起返回新鲜标记（新鲜 = 假时钟当前时刻）。 */
function staleThenFresh(harness: Harness, freshAfterMs: number): void {
  const startedAt = performance.now()
  markSource(harness).mark = () => ({
    price: '80000',
    ts: performance.now() - startedAt >= freshAfterMs ? harness.clock.now() : harness.clock.now() - 5_001,
    source: 'venue_mark',
  })
}

function alwaysStale(harness: Harness): void {
  markSource(harness).mark = () => ({ price: '80000', ts: harness.clock.now() - 5_001, source: 'venue_mark' })
}

function alwaysFresh(harness: Harness): void {
  markSource(harness).mark = () => ({ price: '80000', ts: harness.clock.now(), source: 'venue_mark' })
}

function intent(accountId: string, extra: Partial<OrderIntent> = {}): OrderIntent {
  return { accountId: accountId as never, instrumentId: BTC, side: 'sell', type: 'market', size: asDecimal('0.01'), reduceOnly: true, clientOrderId: newClientOrderId(), reason: 'P0-1 fresh mark fixture', ...extra }
}

function longPosition(accountId: string, size = '0.01'): Position {
  return { accountId: accountId as never, instrumentId: BTC, side: 'long', size: asDecimal(size), entryPrice: asDecimal('80000'), markPrice: asDecimal('80000'), notional: asDecimal(String(Number(size) * 80_000)), unrealizedPnl: asDecimal('0'), realizedPnl: asDecimal('0'), leverage: 1, marginMode: 'cross', liquidationPrice: null, fundingSinceOpen: asDecimal('0'), openedAt: 0, updatedAt: 0 }
}

function gateFor(harness: Harness, clientOrderId: string): GateDecision | undefined {
  const entry = [...harness.k.ledger.iterate()].reverse().find((item) => item.type === 'order.intent' && item.subject.clientOrderId === clientOrderId)
  return (entry?.payload as { gate?: { decision?: GateDecision } } | undefined)?.gate?.decision
}

describe('P0-1 first-order stale mark waits for a fresh value', () => {
  it('stale cached mark + refresh lands in 300ms → first precheck allow', async () => {
    h = await makeHarness()
    staleThenFresh(h, 300)
    const startedAt = performance.now()
    const mark = await h.k.bus.gateMark(BTC, { allowStale: true, deadline: performance.now() + 10_000 })
    expect(mark?.ts).toBe(h.clock.now())
    expect(performance.now() - startedAt).toBeLessThan(2_000)
    const orderIntent = intent(h.paper.accountId, { side: 'buy', reduceOnly: false, size: asDecimal('0.001') })
    const result = await h.k.trading.place({ intent: orderIntent }, h.human())
    expect(result.order?.status).toBe('filled')
    const decision = gateFor(h, orderIntent.clientOrderId!)!
    expect(decision.ruleHits).not.toContainEqual(expect.objectContaining({ code: 'STALE_PRICE' }))
  })

  it('refresh never lands → STALE_PRICE deny, fail-closed', async () => {
    h = await makeHarness()
    h.k.bus.freshMarkWaitMs = 200
    alwaysStale(h)
    const orderIntent = intent(h.paper.accountId, { side: 'buy', reduceOnly: false, size: asDecimal('0.001') })
    const result = await h.k.trading.place({ intent: orderIntent }, h.human())
    expect(result.order?.status).toBe('denied')
    expect(result.order?.problem?.ruleHits).toContainEqual(expect.objectContaining({ code: 'STALE_PRICE' }))
    expect(h.sim.submitted).toHaveLength(0)
    expect(gateFor(h, orderIntent.clientOrderId!)?.verdict).not.toBe('allow')
  })

  it('agent cancel path waits for fresh mark', async () => {
    h = await makeHarness()
    const agent = await makeAgent(h, 'auto_limited')
    const placed = await h.k.trading.place({ intent: intent(h.paper.accountId, { side: 'buy', type: 'limit', reduceOnly: false, size: asDecimal('0.001'), price: asDecimal('80000'), reason: 'P0-1 agent cancel fixture' }) }, agent.ctx())
    expect(['open', 'untriggered']).toContain(placed.order?.status)
    staleThenFresh(h, 300)
    await expect(h.k.trading.cancel({ accountId: h.paper.accountId, orderId: placed.order!.orderId }, agent.ctx())).resolves.toMatchObject({ ok: true })
    expect(h.sim.cancelCalls).toHaveLength(1)
    const entry = [...h.k.ledger.iterate()].reverse().find((row) => row.type === 'order.cancelled' && row.subject.orderId === placed.order!.orderId)!
    const gate = (entry.payload as { gate?: { decision?: GateDecision } }).gate?.decision
    expect(gate?.ruleHits ?? []).not.toContainEqual(expect.objectContaining({ code: 'STALE_PRICE' }))
  })

  it('human reduce with stale price still allowed with warn', async () => {
    h = await makeHarness()
    h.k.bus.freshMarkWaitMs = 100
    h.sim.positions.set(h.paper.accountId, [longPosition(h.paper.accountId)])
    alwaysStale(h)
    const proof = await h.pinProof()
    const orderIntent = intent(h.paper.accountId)
    const result = await h.k.trading.place({ intent: orderIntent }, { ...h.human(), proof })
    expect(result.order?.status).toBe('filled')
    expect(h.sim.submitted).toHaveLength(1)
    const decision = gateFor(h, orderIntent.clientOrderId!)!
    expect(decision.decision).toBe('ALLOW')
    expect(decision.ruleHits).toContainEqual(expect.objectContaining({ code: 'STALE_PRICE', action: 'warn' }))
  })

  it('approved replay waits for fresh mark', async () => {
    h = await makeHarness()
    const agent = await makeAgent(h, 'auto_limited')
    alwaysFresh(h)
    const proposal = await h.k.trading.propose({
      accountId: h.paper.accountId,
      forcePending: true,
      reason: 'P0-1 approved replay fixture',
      intents: [intent(h.paper.accountId, { side: 'buy', reduceOnly: false, size: asDecimal('0.001') })],
    }, agent.ctx())
    expect(proposal.status).toBe('pending')
    staleThenFresh(h, 300)
    const approved = await h.k.trading.approve(proposal.proposalId, await h.pinProof(), h.human('proposal.approve'))
    expect(approved.status).toBe('executed')
    expect(h.sim.submitted).toHaveLength(1)
    const entry = [...h.k.ledger.iterate()].reverse().find((row) => row.type === 'order.intent' && (row.payload as { path?: string }).path === 'approved')!
    const decision = (entry.payload as { gate: { decision: GateDecision } }).gate.decision
    expect(decision.ruleHits).not.toContainEqual(expect.objectContaining({ code: 'STALE_PRICE' }))
  })
})
