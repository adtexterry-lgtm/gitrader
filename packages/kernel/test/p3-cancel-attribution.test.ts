// SPDX-License-Identifier: CPAL-1.0
// fix-r4 C11：子单（止损）的 order.cancelled 记真正的触发主体——人撤 = 人；系统随人动作 = system:kernel 且指回人的 requestId；永不回落到开仓 Agent。
import { afterEach, describe, expect, it } from 'vitest'
import { CRASH_PIN, makeCrashHarness } from './helpers/crash-points'
import type { CrashHarness } from './helpers/crash-points'
import type { ActorCtx } from '../src/trading'
import type { OrderIntent } from '../src/proto'

let h: CrashHarness | undefined
afterEach(async () => { await h?.cleanup(); h = undefined })

const BTC_ID = 'hyperliquid:BTC'

async function paperAgent(h: CrashHarness, name: string): Promise<{ ctx: ActorCtx }> {
  const w = h.world
  const proof = w.k.pin.isSet() ? await w.k.auth.pinProof(w.human.principal, CRASH_PIN) : await w.k.auth.setupPin(w.human.principal, CRASH_PIN)
  const r = w.k.agents.createKey({ name, host: 'other', tier: 'paper', mandate: { accounts: [h.paperAccountId()] } as never }, proof, w.human.origin)
  const principal = w.k.auth.authenticateToken(r.token)!
  return { ctx: { principal, origin: w.k.auth.originFor(principal, 'order', 'mcp', '11111111-2222-4333-8444-555555555551') } }
}

async function agentOpensWithStop(): Promise<{ stopId: string; tpId: string; agent: ActorCtx }> {
  h = await makeCrashHarness()
  const k = h.world.k
  const agent = (await paperAgent(h, 'agent-a')).ctx
  const intent = { accountId: h.paperAccountId(), instrumentId: BTC_ID, side: 'buy', type: 'market', size: '0.001', reason: 'p3', tpsl: { grouping: 'order', stopLoss: { triggerPrice: '78000' }, takeProfit: { triggerPrice: '90000' } } } as unknown as OrderIntent
  expect((await k.trading.place({ intent }, agent)).order?.status).toBe('filled')
  const stop = k.orders.list({ accountId: h.paperAccountId(), limit: 100 }).find((o) => o.tpslRole === 'sl')!
  expect(stop.origin.actor.startsWith('agent:')).toBe(true) // 前提：止损子单落库时沿用父单 origin
  const tp = k.orders.list({ accountId: h.paperAccountId(), limit: 100 }).find((o) => o.tpslRole === 'tp')!
  return { stopId: stop.orderId, tpId: tp.orderId, agent }
}

const cancelledOf = (orderId: string) => h!.world.k.ledger.query({ types: ['order.cancelled'], orderId, limit: 100 })
const settleTicks = async (): Promise<void> => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)) }

describe('P3 撤单归属（子单不再回落到开仓 Agent）', () => {
  it('(i) 人撤止损子单 → 记人，且没有任何一条 order.cancelled 记在 Agent 名下', async () => {
    const { stopId } = await agentOpensWithStop()
    const k = h!.world.k, human = h!.world.human
    const r = await k.trading.cancel({ accountId: h!.paperAccountId(), orderId: stopId }, human)
    expect(r.ok).toBe(true)
    await settleTicks()
    const rows = cancelledOf(stopId)
    expect(rows.length).toBeGreaterThan(0)
    for (const e of rows) { expect(e.origin.actor.startsWith('agent:')).toBe(false); expect(e.origin.actor).toBe('user:usr_local'); expect(e.origin.requestId).toBe(human.origin.requestId) }
    expect(k.ledger.verify().ok).toBe(true)
  })

  it('(ii) 人改止损（先下新止损再撤旧）→ 旧止损的撤销记人，不记 Agent', async () => {
    const { stopId } = await agentOpensWithStop()
    const k = h!.world.k, human = h!.world.human
    const acct = h!.paperAccountId()
    const next = { accountId: acct, instrumentId: BTC_ID, side: 'sell', type: 'stop_market', size: '0.001', triggerPrice: '77000', reduceOnly: true, reason: 'move stop' } as unknown as OrderIntent
    const placed = await k.trading.place({ intent: next }, human)
    expect(placed.order?.status).not.toBe('denied')
    await k.trading.cancel({ accountId: acct, orderId: stopId }, human)
    await settleTicks()
    const rows = cancelledOf(stopId)
    expect(rows.length).toBeGreaterThan(0)
    for (const e of rows) expect(e.origin.actor.startsWith('agent:')).toBe(false)
    expect(rows.every((e) => e.origin.actor === 'user:usr_local' || (e.origin.actor === 'system:kernel' && e.origin.requestId === human.origin.requestId))).toBe(true)
    expect(k.ledger.verify().ok).toBe(true)
  })

  it('(iii) 人全部平仓并撤保护单 flatten_all(keepProtective=false) → 止损的撤销记人，不记 Agent', async () => {
    const { stopId } = await agentOpensWithStop()
    const k = h!.world.k, human = h!.world.human
    const proof = await k.auth.pinProof(human.principal, CRASH_PIN)
    await k.takeover.execute({ level: 'flatten_all', scope: { type: 'account', id: h!.paperAccountId() }, reason: 'human flatten', keepProtective: false }, { ...human, proof })
    await settleTicks()
    const rows = cancelledOf(stopId)
    expect(rows.length).toBeGreaterThan(0)
    for (const e of rows) expect(e.origin.actor.startsWith('agent:')).toBe(false)
    expect(k.ledger.verify().ok).toBe(true)
  })

  it('(iii-b) 人平仓后场所回收保护单 → system:kernel 且 requestId 指向人；无登记的场所自撤 → venue:*，都不回落 Agent', async () => {
    const { stopId, tpId } = await agentOpensWithStop()
    const k = h!.world.k, human = h!.world.human, acct = h!.paperAccountId()
    await k.trading.closePosition({ accountId: acct, instrumentId: BTC_ID }, human)
    const push = (orderId: string): void => { const o = k.orders.get(orderId)!; k.trading.onOrderUpdate(acct, { venueOrderId: o.venueOrderId ?? '', clientOrderId: o.clientOrderId, status: 'cancelled' }) }
    push(stopId)
    const [cleanup] = cancelledOf(stopId)
    expect(cleanup).toMatchObject({ origin: { actor: 'system:kernel', requestId: human.origin.requestId } })
    // 登记过期（30 s 窗口外）后同类推送：记场所，仍不是 Agent
    ;(k.trading as unknown as { cancelCauses: Map<string, unknown> }).cancelCauses.clear()
    push(tpId)
    const [venueSide] = cancelledOf(tpId)
    expect(venueSide!.origin.actor.startsWith('venue:')).toBe(true)
    expect(k.ledger.verify().ok).toBe(true)
  })

  it('cancel_all 只在 keepProtective=false 时登记账户级归因（S2）', async () => {
    await agentOpensWithStop()
    const k = h!.world.k, human = h!.world.human, acct = h!.paperAccountId()
    const causes = (k.trading as unknown as { cancelCauses: Map<string, unknown> }).cancelCauses
    const bus = k.bus as unknown as { cancelAll: (...a: unknown[]) => Promise<unknown> }
    const real = bus.cancelAll.bind(bus)
    const sizes: number[] = []
    bus.cancelAll = (...a: unknown[]) => { sizes.push(causes.size); return real(...a) }
    await k.trading.cancelAll({ accountId: acct, keepProtective: true }, human)
    await k.trading.cancelAll({ accountId: acct, keepProtective: false }, human)
    expect(sizes).toEqual([0, 1])
  })

  it('Agent 自己撤自己的止盈 → 仍记 Agent', async () => {
    const { tpId, agent } = await agentOpensWithStop()
    const k = h!.world.k
    const r = await k.trading.cancel({ accountId: h!.paperAccountId(), orderId: tpId }, agent)
    expect(r.ok).toBe(true)
    await settleTicks()
    const rows = cancelledOf(tpId)
    expect(rows.length).toBeGreaterThan(0)
    for (const e of rows) expect(e.origin.actor).toBe(agent.origin.actor)
    expect(k.ledger.verify().ok).toBe(true)
  })
})
