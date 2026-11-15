// SPDX-License-Identifier: CPAL-1.0
// K2（R3-02）：纸面孤儿单（内核记了 submitted、场所从没见过）启动时收敛为终态，不再每次重启 HALTED；撤这样一张单算成功；实盘不变。
import { afterEach, describe, expect, it } from 'vitest'
import { makeCrashHarness, settle, stopIntent } from './helpers/crash-points'
import type { CrashHarness } from './helpers/crash-points'
import { makeHarness } from './helpers/harness'
import type { Harness } from './helpers/harness'
import { NEVER_REACHED_MESSAGE } from '../src/trading'
import type { Order } from '../src/proto'

let h: CrashHarness | undefined
let lh: Harness | undefined
afterEach(async () => { await h?.cleanup(); h = undefined; await lh?.cleanup(); lh = undefined })

async function orphan(h: CrashHarness, extra: Record<string, unknown> = {}): Promise<string> {
  const intent = { ...stopIntent(h.paperAccountId()), ...extra }
  const crashed = h.arm('afterOrderSubmittedTx')
  const placed = settle(h.world.k.trading.place({ intent: intent as never }, h.world.human))
  await crashed
  await placed
  return (intent as { clientOrderId?: string }).clientOrderId ?? ''
}

const reservations = (h: CrashHarness) => [...(h.world.k.trading as unknown as { reservations: { records: Map<string, { record: { clientOrderId: string } }> } }).reservations.records.values()].map((r) => r.record.clientOrderId)

describe('K2 orphan paper orders converge on restart', () => {
  it.each(Array.from({ length: 10 }, (_, i) => i))('paper submitted order unknown to venue becomes rejected INTERRUPTED_BEFORE_VENUE on startup (run %i)', async () => {
    h = await makeCrashHarness()
    const cloid = 'c1'.repeat(16)
    await orphan(h, { clientOrderId: cloid })
    const w = await h.restart()
    const acct = h.paperAccountId()
    const o = w.k.orders.list({ accountId: acct, limit: 100 }).find((x) => x.clientOrderId === cloid || x.clientOrderId.startsWith(`${cloid}:`))!
    expect(o).toMatchObject({ status: 'rejected', venueOrderId: null })
    expect(o.problem?.name).toBe('VENUE_REJECTED')
    expect(o.problem?.message).toBe(NEVER_REACHED_MESSAGE)
    expect(w.k.ledger.trace({ orderId: o.orderId }).find((e) => e.type === 'order.rejected')?.payload).toMatchObject({ stage: 'recovery' })
    expect(w.k.tstate.effective([{ type: 'account', id: acct }]).state).toBe('ACTIVE')
    expect(w.k.orders.list({ accountId: acct, openOnly: true })).toHaveLength(0)
    expect(reservations(h)).not.toContain(cloid)
    expect(w.k.ledger.verify().ok).toBe(true)
  })

  it('a paper reconcile that times out while market data is still stale is retried instead of halting', async () => {
    h = await makeCrashHarness()
    const cloid = 'c5'.repeat(16)
    // 先开一笔仓（纸面快照的新鲜度取决于持仓标的的行情），再造一张孤儿单
    expect((await h.world.k.trading.place({ intent: stopIntent(h.paperAccountId()) }, h.world.human)).order?.status).toBe('filled')
    h.market.now += 6_000; h.market.setPrice('hyperliquid:BTC', 80000.5)
    await orphan(h, { clientOrderId: cloid, size: '0.002' })
    h.market.stale.add('hyperliquid:BTC') // 重启时行情还没连上
    const w = await h.restart()
    const acct = h.paperAccountId()
    expect(w.k.tstate.effective([{ type: 'account', id: acct }]).state).toBe('ACTIVE')
    expect([...w.k.ledger.iterate()].some((e) => e.type === 'startup.reconciled' && (e.payload as { retry?: boolean }).retry === true)).toBe(true)
    h.market.stale.delete('hyperliquid:BTC')
    h.market.now += 6_000; h.market.setPrice('hyperliquid:BTC', 80000.5)
    await w.k.tickOnce()
    const o = w.k.orders.list({ accountId: acct, limit: 100 }).find((x) => x.clientOrderId.startsWith(cloid))!
    expect(o.status).toBe('rejected')
    expect(w.k.tstate.effective([{ type: 'account', id: acct }]).state).toBe('ACTIVE')
  }, 60_000)

  it('retainedUnknown reservation released', async () => {
    h = await makeCrashHarness()
    await orphan(h, { clientOrderId: 'c2'.repeat(16) })
    const w = await h.restart()
    const acct = w.k.accounts.get(h.paperAccountId())
    const snap = await w.k.bus.snapshot(acct, { maxAgeMs: 0 })
    const result = await w.k.trading.reconcileReservations(snap)
    expect(result.retainedUnknown).toEqual([])
    expect(reservations(h)).toEqual([])
  })

  it('reuse of the same clientOrderId after recovery fills once', async () => {
    h = await makeCrashHarness()
    const cloid = 'c3'.repeat(16)
    await orphan(h, { clientOrderId: cloid })
    const w = await h.restart()
    const acct = h.paperAccountId()
    const r1 = await w.k.trading.place({ intent: { ...stopIntent(acct), clientOrderId: cloid } as never }, w.human)
    expect(r1.order?.status).toBe('filled')
    const r2 = await w.k.trading.place({ intent: { ...stopIntent(acct), clientOrderId: cloid } as never }, w.human)
    expect(r2.order?.orderId).toBe(r1.order?.orderId) // 同 id 再发：幂等返回同一张单
    expect(w.k.orders.fills({ accountId: acct }).filter((f) => f.clientOrderId === cloid)).toHaveLength(1)
  })

  it('cancel of never-reached order succeeds', async () => {
    h = await makeCrashHarness()
    const w = h.world
    const acct = h.paperAccountId()
    const o = injectSubmitted(w.k, acct)
    const proof = w.k.pin.isSet() ? await w.k.auth.pinProof(w.human.principal, '482916') : await w.k.auth.setupPin(w.human.principal, '482916')
    const r = await w.k.trading.cancel({ accountId: acct, orderId: o.orderId }, { ...w.human, proof })
    expect(r).toEqual({ ok: true })
    expect(w.k.orders.get(o.orderId)?.status).toBe('cancelled')
    expect(w.k.ledger.trace({ orderId: o.orderId }).find((e) => e.type === 'order.cancelled')?.payload).toMatchObject({ reason: 'never_reached_venue' })
    expect(JSON.stringify(r)).not.toMatch(/kernel-sim/)
  })

  it('live account keeps HALTED', async () => {
    lh = await makeHarness()
    const o = injectSubmitted(lh.k, lh.liveAcct.accountId)
    const out = await lh.k.startupReconcile(2_000, 'hyperliquid')
    expect(out.find((x) => x.account === lh!.liveAcct.accountId)).toMatchObject({ ok: false })
    expect(lh.k.tstate.effective([{ type: 'account', id: lh.liveAcct.accountId }]).state).toBe('HALTED')
    expect(lh.k.orders.get(o.orderId)?.status).toBe('submitted')
  })
})

function injectSubmitted(k: import('../src/kernel').Kernel, accountId: string): Order {
  const now = k.clock.now()
  const o = {
    orderId: `ord_k2inject${accountId.slice(-12)}`, clientOrderId: 'de'.repeat(16), venueOrderId: null, accountId, instrumentId: 'hyperliquid:BTC', side: 'buy', type: 'limit', tif: 'gtc',
    size: '0.001', filledSize: '0', price: '70000', triggerPrice: null, avgFillPrice: null, status: 'submitted', fee: '0', origin: { actor: 'user:usr_local', actorType: 'human', tool: 'test', requestId: '11111111-2222-4333-8444-555555555555', via: 'ui' },
    createdAt: now, updatedAt: now, submittedAt: now,
  } as unknown as Order
  k.orders.upsert(o, '70', true)
  return o
}
