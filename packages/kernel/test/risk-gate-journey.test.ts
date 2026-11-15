// SPDX-License-Identifier: CPAL-1.0
import { afterEach, describe, expect, it } from 'vitest'
import { asDecimal } from '@gitrader/protocol'
import type { Position } from '@gitrader/protocol'
import { makeHarness, enableLive, TEST_PIN } from './helpers/harness'
import type { Harness } from './helpers/harness'
import { BTC } from './helpers/fake-connector'

let h: Harness | undefined
afterEach(async () => { await h?.cleanup() })

describe('kernel takeover journey', () => {
  it('routes a human flatten request through operations, takeover, trading, ticketed bus, and fake venue', async () => {
    h = await makeHarness()
    await enableLive(h)
    const position: Position = {
      accountId: h.liveAcct.accountId, instrumentId: BTC, side: 'long', size: asDecimal('0.001'),
      entryPrice: asDecimal('80000'), markPrice: asDecimal('80000'), notional: asDecimal('80'),
      unrealizedPnl: asDecimal('0'), realizedPnl: asDecimal('0'), leverage: 1, marginMode: 'cross',
      liquidationPrice: null, fundingSinceOpen: asDecimal('0'), openedAt: h.clock.now(), updatedAt: h.clock.now(),
    }
    h.live.positions.set(h.liveAcct.accountId, [position])

    const result = await h.k.ops.call(h.k, 'takeover.flatten_all', {
      principal: h.session,
      params: { scope: { type: 'account', id: h.liveAcct.accountId }, reason: 'verified flatten journey' },
      transport: 'http', pin: TEST_PIN,
    }) as { ok: boolean; stateAfter: string }

    expect(result).toMatchObject({ ok: true, stateAfter: 'HALTED' })
    expect(h.live.positions.get(h.liveAcct.accountId)).toEqual([])
    const submission = h.live.submitted.find((row) => row.intent.reduceOnly === true)
    expect(submission?.ctx.gate?.ticketId).toBeTruthy()
    const entry = [...h.k.ledger.iterate()].find((row) => row.type === 'order.intent' && row.subject.clientOrderId === submission?.intent.clientOrderId)!
    expect((entry.payload as { gate: { ticketId: string } }).gate.ticketId).toBe(submission?.ctx.gate?.ticketId)
  })
})
