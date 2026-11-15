// SPDX-License-Identifier: CPAL-1.0
// K1（R3-01）：崩溃后「场所上有止损、内核没记录」→ 启动领养；「止损从没挂上」→ 纸面幂等补挂；实盘只告警 + REDUCING。
import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { makeCrashHarness, settle, stopIntent } from './helpers/crash-points'
import type { CrashHarness, CrashWorld } from './helpers/crash-points'
import { makeHarness } from './helpers/harness'
import type { Harness } from './helpers/harness'
import { reconcileProtection } from '../src/child-protect'
import { recordPaperState } from '../src/paper-integrity'
import { derivedStopClientOrderId } from '../src/trading'
import type { Order } from '../src/proto'

let h: CrashHarness | undefined
let lh: Harness | undefined
afterEach(async () => { await h?.cleanup(); h = undefined; await lh?.cleanup(); lh = undefined })

const stops = (w: CrashWorld, accountId: string) => w.k.orders.list({ accountId, limit: 1000 }).filter((o) => o.tpslRole === 'sl')
const annotations = (w: CrashWorld, kind: string) => [...w.k.ledger.iterate()].filter((e) => e.type === 'annotation' && (e.payload as { kind?: string } | undefined)?.kind === kind)
const venueLiveStops = (w: CrashWorld, accountId: string) => w.paper.orders(accountId, { live: true }).filter((o) => o.reduceOnly && (o.type === 'stop_market' || o.type === 'stop_limit'))

async function crashAt(point: 'beforeRecordChildren' | 'afterVenueEvent', extra: Record<string, unknown> = {}): Promise<{ parentCloid: string }> {
  const intent = stopIntent(h!.paperAccountId(), extra as never)
  const crashed = h!.arm(point, 1)
  const placed = settle(h!.world.k.trading.place({ intent }, h!.world.human))
  await crashed
  await placed
  const order = [...h!.world.paper.orders(h!.paperAccountId())].filter((o) => o.role === 'parent').at(-1)
  return { parentCloid: order!.clientOrderId }
}

describe('K1 venue child adoption and protective re-placement', () => {
  for (const point of ['beforeRecordChildren', 'afterVenueEvent'] as const) {
    it.each(Array.from({ length: 10 }, (_, i) => i))(`venue open stop with no local order is adopted (${point}, run %i)`, async () => {
      h = await makeCrashHarness()
      await crashAt(point)
      const w = await h.restart()
      const acct = h.paperAccountId()
      const [stop] = stops(w, acct)
      expect(stop).toMatchObject({ status: 'untriggered', tpslRole: 'sl', triggerPrice: '78000', reduceOnly: true })
      expect(stop!.venueOrderId).toBe(venueLiveStops(w, acct)[0]!.venueOrderId)
      expect(w.k.orders.list({ accountId: acct, openOnly: true }).map((o) => o.orderId)).toContain(stop!.orderId)
      expect(annotations(w, 'order.child_adopted')).toHaveLength(1)
      expect(w.k.tstate.effective([{ type: 'account', id: acct }]).state).toBe('ACTIVE')
      const reconciled = [...w.k.ledger.iterate()].filter((e) => e.type === 'startup.reconciled').at(-1)!
      expect(reconciled.payload).toMatchObject({ ok: true, unresolved: [] })
      const snap = await w.k.bus.snapshot(w.k.accounts.get(acct), { maxAgeMs: 0 })
      expect(snap.positions.find((p) => p.instrumentId === stop!.instrumentId)?.side).toBe('long')
      expect(w.k.ledger.verify().ok).toBe(true)
      // 再重启一次：不重复领养、不补挂
      const w2 = await h.restart()
      expect(stops(w2, acct)).toHaveLength(1)
      expect(venueLiveStops(w2, acct)).toHaveLength(1)
    })
  }

  it('filled parent with stop intent and no stop is re-placed once, idempotent across restarts', async () => {
    h = await makeCrashHarness()
    const { parentCloid } = await crashAt('beforeRecordChildren')
    // 模拟「场所上的止损也丢了」：从落盘状态里拿掉子单，并按内核的摘要规则登记（等价于场所自己丢了这张单）
    const file = join(h.home, 'paper-state.json')
    const state = JSON.parse(readFileSync(file, 'utf8')) as { accounts: Array<{ orders: Array<{ role: string }> }> }
    state.accounts[0]!.orders = state.accounts[0]!.orders.filter((o) => o.role === 'parent')
    const raw = JSON.stringify(state)
    writeFileSync(file, raw)
    const db = new DatabaseSync(join(h.home, 'data', 'gitrader.sqlite'))
    recordPaperState(db as never, raw, h.market.now, 0)
    db.close()
    const w = await h.restart()
    const acct = h.paperAccountId()
    const derived = derivedStopClientOrderId(parentCloid)
    const placed = w.k.orders.byClientOrderId(derived)
    expect(placed).toMatchObject({ type: 'stop_market', reduceOnly: true, side: 'sell', triggerPrice: '78000', tpslRole: 'sl', status: 'untriggered' })
    expect(venueLiveStops(w, acct)).toHaveLength(1)
    expect(annotations(w, 'order.child_replaced')).toHaveLength(1)
    expect(w.k.tstate.effective([{ type: 'account', id: acct }]).state).toBe('ACTIVE')
    for (let i = 0; i < 3; i++) {
      const again = await h.restart()
      expect(venueLiveStops(again, acct)).toHaveLength(1)
      expect(again.k.orders.list({ accountId: acct, limit: 1000 }).filter((o) => o.clientOrderId === derived)).toHaveLength(1)
    }
    expect(annotations(h.world, 'order.child_replaced')).toHaveLength(1)
  })

  it('a second position on the same instrument gets its own replacement (coverage counts size, not just presence)', async () => {
    h = await makeCrashHarness()
    const acct = h.paperAccountId()
    expect((await h.world.k.trading.place({ intent: stopIntent(acct) }, h.world.human)).order?.status).toBe('filled')
    h.market.now += 6_000 // 开仓冷却
    h.market.setPrice('hyperliquid:BTC', 80000.5)
    const { parentCloid } = await crashAt('beforeRecordChildren', { size: '0.002' })
    // 场所也丢了第二张单的止损（同上：去掉没有内核记录的那张子单并按内核规则登记摘要）
    const file = join(h.home, 'paper-state.json')
    const state = JSON.parse(readFileSync(file, 'utf8')) as { accounts: Array<{ orders: Array<{ role: string; parentId?: string; venueOrderId: string }> }> }
    const parents = state.accounts[0]!.orders.filter((o) => o.role === 'parent')
    const second = parents[parents.length - 1]!.venueOrderId
    state.accounts[0]!.orders = state.accounts[0]!.orders.filter((o) => !(o.role === 'sl' && o.parentId === second))
    const raw = JSON.stringify(state)
    writeFileSync(file, raw)
    const db = new DatabaseSync(join(h.home, 'data', 'gitrader.sqlite'))
    recordPaperState(db as never, raw, h.market.now, 0)
    db.close()
    const w = await h.restart()
    const replaced = w.k.orders.byClientOrderId(derivedStopClientOrderId(parentCloid))
    expect(replaced).toMatchObject({ size: '0.002', status: 'untriggered' })
    const live = venueLiveStops(w, acct)
    expect(live).toHaveLength(2)
    expect(live.reduce((s, o) => s + Number(o.size), 0)).toBeCloseTo(0.003, 9)
  })

  it('a stop the human cancelled afterwards is not put back', async () => {
    h = await makeCrashHarness()
    await crashAt('beforeRecordChildren')
    let w = await h.restart()
    const acct = h.paperAccountId()
    const [stop] = stops(w, acct)
    const proof = w.k.pin.isSet() ? await w.k.auth.pinProof(w.human.principal, '482916') : await w.k.auth.setupPin(w.human.principal, '482916')
    expect((await w.k.trading.cancel({ accountId: acct, orderId: stop!.orderId }, { ...w.human, proof })).ok).toBe(true)
    w = await h.restart()
    expect(venueLiveStops(w, acct)).toHaveLength(0)
    expect(annotations(w, 'order.child_replaced')).toHaveLength(0)
  })

  it('live account is not auto-placed: REDUCING with reason', async () => {
    lh = await makeHarness()
    const parent = syntheticParent(lh, lh.liveAcct.accountId)
    const before = lh.k.orders.list({ accountId: lh.liveAcct.accountId, limit: 100 }).length
    const out = await reconcileProtection(lh.k, lh.liveAcct, { positions: [position(lh.liveAcct.accountId, parent)], openOrders: [] })
    expect(out.replaced).toEqual([])
    expect(out.unprotected).toHaveLength(1)
    expect(lh.k.orders.list({ accountId: lh.liveAcct.accountId, limit: 100 })).toHaveLength(before)
    const st = lh.k.tstate.effective([{ type: 'account', id: lh.liveAcct.accountId }])
    expect(st.state).toBe('REDUCING')
    expect(st.reasons[0]!.reason).toContain('仓位无止损')
    expect([...lh.k.ledger.iterate()].some((e) => (e.payload as { kind?: string } | undefined)?.kind === 'position.unprotected')).toBe(true)
  })

  it('replacement rejected by gate keeps REDUCING, gate unchanged', async () => {
    lh = await makeHarness()
    const policyBefore = JSON.stringify(lh.k.risk.current())
    const parent = syntheticParent(lh, lh.paper.accountId, '78000.123') // 不在价格刻度上：补挂被拒（PRECISION），闸门照旧
    const out = await reconcileProtection(lh.k, lh.paper, { positions: [position(lh.paper.accountId, parent)], openOrders: [] })
    expect(out.replaced).toEqual([])
    expect(out.unprotected).toHaveLength(1)
    expect(lh.k.tstate.effective([{ type: 'account', id: lh.paper.accountId }]).state).toBe('REDUCING')
    expect(JSON.stringify(lh.k.risk.current())).toBe(policyBefore)
  })
})

function syntheticParent(lh: Harness, accountId: string, trigger = '78000'): Order {
  const now = lh.clock.now()
  const cloid = 'ab'.repeat(16)
  const order = {
    orderId: 'ord_k1synthetic000000000001', clientOrderId: cloid, venueOrderId: 'venue-parent-1', accountId, instrumentId: 'hyperliquid:BTC', side: 'buy', type: 'market', tif: 'ioc',
    size: '0.001', filledSize: '0.001', price: null, triggerPrice: null, avgFillPrice: '80001', status: 'filled', fee: '0', origin: lh.human().origin, createdAt: now, updatedAt: now, closedAt: now,
  } as unknown as Order
  lh.k.orders.upsert(order, '80', true)
  lh.k.docs.put('order-record', order.orderId, { intent: { accountId, instrumentId: 'hyperliquid:BTC', side: 'buy', type: 'market', size: '0.001', clientOrderId: cloid, tpsl: { grouping: 'order', stopLoss: { triggerPrice: trigger } } } })
  return order
}

function position(accountId: string, parent: Order) {
  return { accountId, instrumentId: parent.instrumentId, side: 'long', size: '0.001', entryPrice: '80001', markPrice: '80000', notional: '80', unrealizedPnl: '0', realizedPnl: '0', leverage: 1, marginMode: 'cross' } as never
}
