// SPDX-License-Identifier: CPAL-1.0
import { describe, expect, it } from 'vitest'
import { PaperVenue } from '../src/venue'
import { BTC, TestMarket, ctx, intent } from './helpers/test-market'

describe('D1 paper position mark timestamp', () => {
  it('tracks the accepted quote time, freezes it with a stale mark, updates on recovery, and keeps stale-price rejection', async () => {
    const market = new TestMarket()
    const venue = new PaperVenue({ market, clock: () => market.now })
    venue.createAccount({ accountId: 'acct_D1', initialBalance: '100000' })
    const submitted = await venue.submit(ctx('acct_D1'), [intent('acct_D1', { type: 'market', price: undefined, maxSlippageBps: 50 })])
    expect(submitted.acks[0]).toMatchObject({ status: 'filled' })

    const initial = await venue.accountState({ accountId: 'acct_D1' } as never)
    const initialPosition = initial.positions[0]!
    expect(initialPosition.markTs).toBe(market.quoteTs[BTC])
    expect(initialPosition.markPrice).toBe('80000.5')

    const acceptedPrice = initialPosition.markPrice
    const acceptedTs = initialPosition.markTs
    const restored = new PaperVenue({ market, clock: () => market.now })
    restored.importState(venue.exportState())
    market.now += 1_000
    delete market.quoteTs[BTC]
    const missing = await restored.accountState({ accountId: 'acct_D1' } as never)
    expect(missing.stale).toBe(true)
    expect(missing.positions[0]).toMatchObject({ markPrice: acceptedPrice, markTs: acceptedTs })

    market.now += 1_000
    market.quoteTs[BTC] = market.now
    market.stale.add(BTC)
    const stale = await restored.accountState({ accountId: 'acct_D1' } as never)
    expect(stale.stale).toBe(true)
    expect(stale.positions[0]).toMatchObject({ markPrice: acceptedPrice, markTs: acceptedTs })

    market.stale.delete(BTC)
    market.setPrice(BTC, 81_000)
    const recovered = await restored.accountState({ accountId: 'acct_D1' } as never)
    expect(recovered.stale).toBe(false)
    expect(recovered.positions[0]).toMatchObject({ markPrice: '81000', markTs: market.now })

    market.stale.add(BTC)
    const rejected = await restored.submit(ctx('acct_D1'), [intent('acct_D1', { type: 'market', price: undefined, maxSlippageBps: 50 })])
    expect(rejected.acks[0]?.problem?.code).toBe(2007)
    await venue.close()
    await restored.close()
  })
})
