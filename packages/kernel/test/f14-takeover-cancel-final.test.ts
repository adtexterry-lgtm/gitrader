// SPDX-License-Identifier: CPAL-1.0
// F14 / ADR-26：撤单级接管回执的 cancelled 取撤单确认后的最终值；确认没回来就记 cancelPending。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BTC } from './helpers/fake-connector'
import { makeHarness } from './helpers/harness'
import type { Harness } from './helpers/harness'
import type { OrderIntent } from '../src/proto'

let h: Harness
beforeEach(async () => { h = await makeHarness() })
afterEach(async () => { vi.restoreAllMocks(); await h.cleanup() })

const acct = (): { type: 'account'; id: string } => ({ type: 'account', id: h.paper.accountId })

async function placeLimits(prices: string[]): Promise<void> {
  for (const [index, price] of prices.entries()) {
    if (index > 0) h.clock.advance(11_000) // 下单冷却
    const r = await h.k.trading.place({ intent: {
      accountId: h.paper.accountId as never, instrumentId: BTC, side: 'buy', type: 'limit',
      price: price as never, size: '0.001' as never, tif: 'gtc',
    } as OrderIntent }, h.human())
    expect(r.order?.status).toBe('open')
  }
}

const ledgerKind = (kind: string) => [...h.k.ledger.iterate()].find((entry) => (entry.payload as { kind?: string }).kind === kind)

describe('F14 接管撤单回执', () => {
  it('cancelled count reflects final value', async () => {
    await placeLimits(['70000', '70100', '70200'])
    const rec = await h.k.takeover.execute({ level: 'cancel_all', scope: acct(), reason: 'f14 final' }, h.human())
    expect(rec.cancelled).toBe(3)
    expect(rec.cancelPending).toBeUndefined()
    expect(ledgerKind('cancel_all.confirmed')?.payload).toMatchObject({ cancelled: 3, confirmed: 3 })
    expect(rec.ok).toBe(true)
  }, 15_000)

  it('slow confirmation is reported as pending', async () => {
    await placeLimits(['70000', '70100', '70200'])
    const status = h.sim.orderStatus.bind(h.sim)
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    vi.spyOn(h.sim, 'orderStatus').mockImplementation(async (ref, key) => { await gate; return status(ref, key) })
    const started = performance.now()
    let rec: Awaited<ReturnType<Harness['k']['takeover']['execute']>>
    try {
      rec = await h.k.takeover.execute({ level: 'cancel_all', scope: acct(), reason: 'f14 pending' }, h.human())
    } finally {
      release()
    }
    const elapsed = performance.now() - started
    expect(rec.cancelled).toBe(0)
    expect(rec.cancelPending).toBe(3)
    expect(elapsed).toBeGreaterThanOrEqual(2_900)
    expect(elapsed).toBeLessThan(5_000)
    await vi.waitFor(() => expect(ledgerKind('cancel_all.confirmed')?.payload).toMatchObject({ confirmed: 3 }))
  }, 15_000)
})
