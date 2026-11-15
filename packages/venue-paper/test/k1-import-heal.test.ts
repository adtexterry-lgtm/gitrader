// SPDX-License-Identifier: CPAL-1.0
// fix-r2 K1 / S1：导入状态时补完半个事务（父单已成交 → 激活等父单的子单；父单已撤未成交 → 撤掉子单），并拒绝不合法的状态。
import { describe, expect, it } from 'vitest'
import { PaperVenue } from '../src/venue'
import { BTC, TestMarket, ctx, intent } from './helpers/test-market'

const A = 'acct_A'

async function filledWithStop() {
  const m = new TestMarket()
  const v = new PaperVenue({ market: m, clock: () => m.now })
  v.createAccount({ accountId: A, initialBalance: '100000' })
  await v.submit(ctx(A), [intent(A, { type: 'market', price: undefined, maxSlippageBps: 50, size: '1', tpsl: { grouping: 'order', stopLoss: { triggerPrice: '78000' } } })])
  return { m, v, state: JSON.parse(v.exportState()) as { orderSeq: number; fillSeq: number; accounts: Array<{ orders: Array<Record<string, unknown>> }> } }
}

describe('K1 importState heals half-written parent/child state', () => {
  it('waitingParent child of filled parent is activated on import', async () => {
    const { m, state } = await filledWithStop()
    const child = state.accounts[0]!.orders.find((o) => o.role === 'sl')!
    child.waitingParent = true // 模拟落盘停在「成交已写、子单激活还没写」
    const v2 = new PaperVenue({ market: m, clock: () => m.now })
    v2.importState(JSON.stringify(state))
    const live = v2.orders(A, { live: true }).filter((o) => o.role === 'sl')
    expect(live).toHaveLength(1)
    // 激活后的子单参与触发：价格跌破止损 → 平仓
    m.setPrice(BTC, 77900)
    await v2.tick()
    expect(v2.orders(A).find((o) => o.role === 'sl')?.status).toBe('filled')
  })

  it('child of cancelled parent is cancelled on import', async () => {
    const { m, state } = await filledWithStop()
    const parent = state.accounts[0]!.orders.find((o) => o.role === 'parent')!
    const child = state.accounts[0]!.orders.find((o) => o.role === 'sl')!
    parent.status = 'cancelled'
    parent.filled = { $b: '0' }
    child.waitingParent = true
    const v2 = new PaperVenue({ market: m, clock: () => m.now })
    v2.importState(JSON.stringify(state))
    expect(v2.orders(A).find((o) => o.role === 'sl')?.status).toBe('cancelled')
    expect(v2.orders(A, { live: true })).toHaveLength(0)
  })

  it('rejects invalid states instead of importing odd numbers', async () => {
    const { m, state } = await filledWithStop()
    const v2 = new PaperVenue({ market: m, clock: () => m.now })
    expect(() => v2.importState(JSON.stringify({ ...state, orderSeq: -1 }))).toThrow(/sequence/)
    expect(() => v2.importState(JSON.stringify({ ...state, accounts: [{ ...state.accounts[0], cash: 12 }] }))).toThrow(/cash/)
    expect(() => v2.importState(JSON.stringify({ ...state, accounts: [state.accounts[0], state.accounts[0]] }))).toThrow(/duplicated/)
    expect(() => v2.importState('{"v":1')).toThrow()
  })

  it('open orders expose the parent link for adoption', async () => {
    const { v } = await filledWithStop()
    const oo = await v.openOrders({ accountId: A } as never)
    const parentId = v.orders(A).find((o) => o.role === 'parent')!.venueOrderId
    expect(oo.find((o) => o.reduceOnly)?.parentVenueOrderId).toBe(parentId)
  })
})
