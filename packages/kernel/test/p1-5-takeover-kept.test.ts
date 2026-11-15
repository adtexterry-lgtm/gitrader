// SPDX-License-Identifier: CPAL-1.0
// P1-5：撤单级接管保留保护单并计数（keptProtective），结果记录与两条账本载荷都带这个数。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { OrderIntent } from '../src/proto'
import { BTC } from './helpers/fake-connector'
import { makeHarness } from './helpers/harness'
import type { Harness } from './helpers/harness'

let h: Harness
beforeEach(async () => { h = await makeHarness() })
afterEach(async () => { await h.cleanup() })

const mk = (o: Partial<OrderIntent> = {}): OrderIntent => ({ accountId: h.paper.accountId as never, instrumentId: BTC, side: 'buy', type: 'market', size: '0.01' as never, leverage: 2, ...o } as OrderIntent)
const acct = (): { type: 'account'; id: string } => ({ type: 'account', id: h.paper.accountId })

describe('撤单级接管保留保护单', () => {
  it('cancel_all keeps protective orders and counts them', async () => {
    await h.k.trading.place({ intent: mk() }, h.human())
    h.clock.advance(11_000)
    await h.k.trading.place({ intent: mk({ type: 'limit', price: '70000' as never, size: '0.011' as never }) }, h.human())
    h.sim.orders.push({ venueOrderId: 'vo-sl', clientOrderId: 'cd'.repeat(16), accountId: h.paper.accountId, instrumentId: BTC, side: 'sell', type: 'stop_market', size: '0.01', price: null, reduceOnly: true, isTrigger: true, status: 'open', createdAt: 0 })

    const r = await h.k.takeover.execute({ level: 'cancel_all', scope: acct(), reason: 'keep stops' }, h.human())
    expect(r.cancelled).toBe(1) // 只撤了那张普通限价单
    expect(r.keptProtective).toBe(1)
    expect(h.sim.orders.find((o) => o.venueOrderId === 'vo-sl')!.status).toBe('open')

    const applied = h.k.ledger.query({ types: ['takeover.applied'], limit: 1 })[0]!
    const completed = h.k.ledger.query({ types: ['takeover.completed'], limit: 1 })[0]!
    expect(applied.payload).toMatchObject({ cancelled: 1, keptProtective: 1 })
    expect(completed.payload).toMatchObject({ cancelled: 1, keptProtective: 1 })
  })
})
