// SPDX-License-Identifier: CPAL-1.0
import { describe, expect, it } from 'vitest'
import { HyperliquidConnector } from '../src/connector'
import type { AccountRef, Hex } from '@gitrader/protocol/connector'
import { FakeHl, FX_NOW } from './helpers/fake-hl'

const ref: AccountRef = { accountId: 'acct_riskConfigTest', address: `0x${'1'.repeat(40)}` as Hex, accountModel: 'standard' }

describe('market price band configuration', () => {
  it('keeps default and configured values consistent in static and initial dynamic rules', async () => {
    for (const [configured, expected] of [[undefined, 800], [1_250, 1_250]] as const) {
      const hl = new FakeHl()
      const connector = new HyperliquidConnector({
        environment: 'mainnet', fetchImpl: hl.fetch, useWs: false, discoveryIntervalMs: 0, clock: () => FX_NOW,
        ...(configured === undefined ? {} : { marketPriceBandBps: configured }),
        accounts: { stream: false, marketPriceBandBps: 400 },
      })
      try {
        const staticRules = connector.describe().rules
        expect(staticRules?.marketPriceBandBps).toBeDefined()
        const staticRule = staticRules!.marketPriceBandBps!
        expect(staticRule).toBe(expected)
        expect(typeof staticRule).toBe('number')

        const initial = await connector.accountState(ref)
        expect(initial.stale).toBe(true)
        expect(initial.rules?.marketPriceBandBps).toBeDefined()
        const dynamicRule = initial.rules!.marketPriceBandBps!
        expect(dynamicRule).toBe(expected)
        expect(typeof dynamicRule).toBe('number')
      } finally {
        await connector.close()
      }
    }
  })

  it('rejects non-finite, fractional, negative, and above-range values', () => {
    for (const marketPriceBandBps of [-1, 1.5, 10_001, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new HyperliquidConnector({ environment: 'mainnet', marketPriceBandBps })).toThrow(RangeError)
    }
  })
})
