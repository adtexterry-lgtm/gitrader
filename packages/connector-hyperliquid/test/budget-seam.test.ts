// SPDX-License-Identifier: CPAL-1.0
import { afterEach, describe, expect, it, vi } from 'vitest'
import { KernelRateBudget } from '../../kernel/src/budget'
import type { RateBudget } from '../src/budget'
import { HyperliquidConnector } from '../src/connector'
import type { TradeContext } from '@gitrader/protocol/connector'
import { FakeHl } from './helpers/fake-hl'
import { makeTestSigner } from './helpers/test-signer'

afterEach(() => { vi.useRealTimers() })

describe('kernel budget and connector priority seam', () => {
  it('lets scheduleCancel reach the network before queued account and mark reads, then releases them with the window', async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 })
    const hl = new FakeHl()
    const kernelBudget = new KernelRateBudget({
      limit: 1200,
      targetRatio: 0.6,
      windowMs: 60_000,
      clock: { now: () => Date.now() },
    })
    // HL local RateBudget.usage includes byKind; the Kernel shape does not.
    const budget = kernelBudget as unknown as RateBudget
    const acquire = vi.spyOn(kernelBudget, 'acquire')
    const c = new HyperliquidConnector({
      environment: 'testnet', fetchImpl: hl.fetch, budget, useWs: false,
      discoveryIntervalMs: 0, pollMs: 60_000_000, markStaleMs: 20_000,
      clock: () => Date.now(),
    })
    const signer = makeTestSigner()
    const ctx: TradeContext = {
      account: { accountId: 'acct_01TEST', address: signer.address, accountModel: 'standard' },
      signer,
      onSigned: () => {},
    }

    try {
      hl.exchange = () => ({ status: 'ok', response: { type: 'default' } })
      hl.info.set('clearinghouseState', () => ({
        marginSummary: { accountValue: '0', totalNtlPos: '0', totalMarginUsed: '0' },
        crossMaintenanceMarginUsed: '0', withdrawable: '0', assetPositions: [],
      }))
      hl.info.set('spotClearinghouseState', () => ({ balances: [] }))
      hl.info.set('frontendOpenOrders', () => [])
      hl.info.set('userRateLimit', () => ({ cumVlm: '0' }))
      hl.info.set('userAbstraction', () => 'default')

      await c.market.refreshInstruments()
      await vi.advanceTimersByTimeAsync(20_001)
      expect(kernelBudget.used()).toBeLessThanOrEqual(576)
      kernelBudget.charge(576 - kernelBudget.used())
      hl.calls.length = 0
      acquire.mockClear()

      await c.accountView(ctx.account)
      const accountAcquireCalls = acquire.mock.calls as unknown as Array<[number, { kind?: string; priority?: string }]>
      expect(accountAcquireCalls.some(([weight, options]) => weight === 2 && options?.kind === 'background' && options?.priority === 'low')).toBe(true)
      const beforeMarkAcquireCount = accountAcquireCalls.length
      expect(c.mark('hyperliquid:BTC')).toBeUndefined()

      const acquireCalls = acquire.mock.calls as unknown as Array<[number, { kind?: string; priority?: string }]>
      const markAcquires = acquireCalls.slice(beforeMarkAcquireCount)
      expect(markAcquires.some(([weight, options]) => weight === 20 && options?.kind === 'background' && options?.priority === 'low')).toBe(true)
      expect(hl.calls).toEqual([])

      await c.scheduleCancel(ctx, Date.now() + 60_000)
      expect(hl.calls[0]?.endpoint).toBe('exchange')
      expect(hl.calls[0]?.body.action.type).toBe('scheduleCancel')
      expect(hl.infoCalls()).toEqual([])

      await vi.advanceTimersByTimeAsync(60_001)
      await vi.waitFor(() => {
        expect(hl.infoCalls('clearinghouseState').length).toBeGreaterThan(0)
        expect(hl.infoCalls('metaAndAssetCtxs').length).toBeGreaterThan(0)
      }, { timeout: 2000 })
      expect(hl.calls[0]?.endpoint).toBe('exchange')
      expect(hl.calls[0]?.body.action.type).toBe('scheduleCancel')
    } finally {
      await c.close()
    }
  })
})
