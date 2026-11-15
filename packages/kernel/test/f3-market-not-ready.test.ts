// SPDX-License-Identifier: CPAL-1.0
// ADR-23：内核刚重启、标的目录还在异步加载时，取不到标的要报可重试的「行情未就绪」，不是 INSTRUMENT_UNKNOWN。
import { afterEach, describe, expect, it } from 'vitest'
import { asDecimal } from '@gitrader/protocol'
import type { OrderIntent } from '@gitrader/protocol'
import { makeHarness } from './helpers/harness'
import type { Harness } from './helpers/harness'
import { BTC } from './helpers/fake-connector'
import { newClientOrderId } from '../src/util/ids'
import { KernelError } from '../src/util/errors'

let h: Harness | undefined
afterEach(async () => { await h?.cleanup() })

function intent(accountId: string, instrumentId: string = BTC): OrderIntent {
  return { accountId: accountId as never, instrumentId: instrumentId as never, side: 'buy', type: 'limit', size: asDecimal('0.001'), price: asDecimal('80000'), tif: 'gtc', clientOrderId: newClientOrderId() }
}

async function problemOf(p: Promise<unknown>): Promise<KernelError['problem']> {
  try {
    await p
  } catch (error) {
    if (error instanceof KernelError) return error.problem
    throw error
  }
  throw new Error('expected the call to throw')
}

describe('ADR-23 market data not ready', () => {
  it('preview while the catalog is still loading is retryable VENUE_UNAVAILABLE', async () => {
    h = await makeHarness()
    h.live.instrumentsList.length = 0
    h.sim.instrumentsList.length = 0

    const problem = await problemOf(h.k.trading.preview(intent(h.paper.accountId), h.human()))

    expect(problem.name).toBe('VENUE_UNAVAILABLE')
    expect(problem.retryable).toBe(true)
    expect(problem.retryAfterMs).toBe(3000)
    expect(problem.message.startsWith('market data not ready')).toBe(true)
  })

  it('unknown instrument after the catalog has loaded stays INSTRUMENT_UNKNOWN', async () => {
    h = await makeHarness()

    const problem = await problemOf(h.k.trading.preview(intent(h.paper.accountId, 'hyperliquid:NOPE'), h.human()))

    expect(problem.name).toBe('INSTRUMENT_UNKNOWN')
  })

  it('ConnectorBus.catalogLoading', async () => {
    h = await makeHarness()
    const bus = h.k.bus

    expect(bus.catalogLoading('nowhere:BTC' as never)).toBe(false)

    const saved = h.live.instrumentsList.splice(0, h.live.instrumentsList.length)
    expect(bus.catalogLoading(BTC as never)).toBe(true)

    h.live.instrumentsList.push(...saved)
    expect(bus.catalogLoading(BTC as never)).toBe(false)
  })
})
