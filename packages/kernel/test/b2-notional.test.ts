// SPDX-License-Identifier: CPAL-1.0
import { afterEach, describe, expect, it, vi } from 'vitest'
import { asDecimal, type GateInput, type OrderIntent } from '@gitrader/protocol'
import { fx, mul, str } from '@gitrader/protocol/decimal'
import { makeHarness } from './helpers/harness'
import type { Harness } from './helpers/harness'
import { BTC } from './helpers/fake-connector'
import { normalizeIntent } from '../src/normalize'
import { newClientOrderId } from '../src/util/ids'

let h: Harness | undefined
afterEach(async () => { await h?.cleanup() })

function intent(accountId: string, notional: string): OrderIntent {
  return {
    accountId: accountId as never, instrumentId: BTC as never, side: 'buy', type: 'limit',
    size: undefined, notional: asDecimal(notional), price: asDecimal('40'), tif: 'gtc', clientOrderId: newClientOrderId(),
  }
}

function sizedIntent(accountId: string, size: string, price: string): OrderIntent {
  return {
    accountId: accountId as never, instrumentId: BTC as never, side: 'buy', type: 'limit',
    size: asDecimal(size), price: asDecimal(price), tif: 'gtc', clientOrderId: newClientOrderId(),
  }
}

describe('B2 base/contract notional normalization', () => {
  it('normalizes base metadata only on the returned bus copy and uses it for notional sizing', async () => {
    h = await makeHarness()
    const source = h.live.instrumentsList[0]!
    source.contractSize = asDecimal('0.25')
    source.venueSizeUnit = 'base'
    h.sim.instrumentsList[0]!.contractSize = asDecimal('0.25')
    h.sim.instrumentsList[0]!.venueSizeUnit = 'base'

    const normalized = h.k.bus.instrument(BTC)!
    expect(normalized.contractSize).toBe('1')
    expect(source.contractSize).toBe('0.25')
    const order = normalizeIntent(intent(h.paper.accountId, '50'), normalized, { defaultMaxSlippageBps: 0 })
    expect(order.size).toBe('1.25')
    expect(str(mul(fx(order.size), mul(fx('40'), fx(normalized.contractSize))))).toBe('50')
  })

  it('preserves contract-unit face value for sizing', async () => {
    h = await makeHarness()
    const source = h.live.instrumentsList[0]!
    source.contractSize = asDecimal('0.01')
    source.venueSizeUnit = 'contract'
    h.sim.instrumentsList[0]!.contractSize = asDecimal('0.01')
    h.sim.instrumentsList[0]!.venueSizeUnit = 'contract'

    const normalized = h.k.bus.instrument(BTC)!
    expect(normalized.contractSize).toBe('0.01')
    const order = normalizeIntent(intent(h.paper.accountId, '50'), normalized, { defaultMaxSlippageBps: 0 })
    expect(order.size).toBe('125')
    expect(str(mul(fx(order.size), mul(fx('40'), fx(normalized.contractSize))))).toBe('50')
  })

  it('checks minimum notional with normalized base units and preserves contract face value', async () => {
    const harness = await makeHarness()
    h = harness
    const baseSource = harness.live.instrumentsList[0]!
    baseSource.contractSize = asDecimal('0.25')
    baseSource.venueSizeUnit = 'base'
    const baseInstrument = harness.k.bus.instrument(BTC)!
    expect(baseInstrument.contractSize).toBe('1')
    expect(() => normalizeIntent(sizedIntent(harness.paper.accountId, '1', '20'), baseInstrument, { defaultMaxSlippageBps: 0 })).not.toThrow()

    const contractSource = { ...baseSource, contractSize: asDecimal('0.01'), venueSizeUnit: 'contract' as const }
    expect(() => normalizeIntent(sizedIntent(harness.paper.accountId, '40', '20'), contractSource, { defaultMaxSlippageBps: 0 })).toThrow(/below the minimum/)
    expect(() => normalizeIntent(sizedIntent(harness.paper.accountId, '50', '20'), contractSource, { defaultMaxSlippageBps: 0 })).not.toThrow()
  })

  it('applies maxOrderNotional to the true base and contract exposure through precheckIntent', async () => {
    h = await makeHarness()
    h.live.setMark(BTC, '80000')
    await h.k.risk.relax({ limits: { maxOrderNotional: asDecimal('2000'), duplicateIntentWindowSec: 0 }, protectors: [] }, await h.pinProof(), h.human('risk.relax').origin)
    const source = h.live.instrumentsList[0]!
    source.contractSize = asDecimal('0.25')
    source.venueSizeUnit = 'base'
    let observed: GateInput | undefined
    const decide = h.k.gate.decide.bind(h.k.gate)
    vi.spyOn(h.k.gate, 'decide').mockImplementation((input) => { observed = input; return decide(input) })
    let decision = await h.k.trading.precheckIntent(sizedIntent(h.paper.accountId, '0.03', '80000'), h.human())
    let capHit = decision.ruleHits.find((hit) => hit.code === 'ORDER_NOTIONAL')
    expect(observed?.instrument?.contractSize).toBe('1')
    expect(observed?.target.kind === 'order' ? observed.target.intent.size : undefined).toBe('0.03')
    expect(capHit?.actual).toBe('2400')
    expect(decision.verdict).toBe('deny')

    source.contractSize = asDecimal('0.01')
    source.venueSizeUnit = 'contract'
    decision = await h.k.trading.precheckIntent(sizedIntent(h.paper.accountId, '3', '80000'), h.human())
    capHit = decision.ruleHits.find((hit) => hit.code === 'ORDER_NOTIONAL')
    expect(capHit?.actual).toBe('2400')
    expect(decision.verdict).toBe('deny')
  })

  it('values open-order exposure once for base units and equivalently for contract units', async () => {
    const verifyExposure = async (unit: 'base' | 'contract', face: string, openSize: string, nextSize: string, expectedInstrumentFace: string) => {
      h = await makeHarness()
      h.live.setMark(BTC, '80000')
      const source = h.live.instrumentsList[0]!
      source.contractSize = asDecimal(face)
      source.venueSizeUnit = unit
      h.sim.instrumentsList[0]!.contractSize = asDecimal(face)
      h.sim.instrumentsList[0]!.venueSizeUnit = unit
      await h.k.risk.relax({ limits: {
        maxOrderNotional: asDecimal('1000000'), maxPositionNotionalRatio: null,
        maxTotalNotionalRatio: asDecimal('0.23'), maxDailyNotional: null,
        maxDailyOrders: null, maxOrdersPerMinute: null, maxOpenPositions: null,
        duplicateIntentWindowSec: 0,
      }, protectors: [] }, await h.pinProof(), h.human('risk.relax').origin)

      const placed = await h.k.trading.place({ intent: sizedIntent(h.paper.accountId, openSize, '80000') }, h.human())
      expect(placed.order?.status, JSON.stringify(placed.order?.problem?.ruleHits?.map(({ code, actual, limit }) => ({ code, actual, limit })))).toBe('open')
      const decide = h.k.gate.decide.bind(h.k.gate)
      let observed: GateInput | undefined
      vi.spyOn(h.k.gate, 'decide').mockImplementation((input) => { observed = input; return decide(input) })
      const result = await h.k.trading.precheckIntent(sizedIntent(h.paper.accountId, nextSize, '80000'), h.human())
      expect(observed?.instrument?.contractSize).toBe(expectedInstrumentFace)
      expect(observed?.snapshot.openOrders).toEqual([{ instrumentId: BTC, side: 'buy', notional: asDecimal('1600'), count: 1 }])
      expect(result.ruleHits).toContainEqual(expect.objectContaining({ code: 'TOTAL_NOTIONAL', actual: asDecimal('0.24') }))
      const done = h
      h = undefined
      await done.cleanup()
    }

    await verifyExposure('base', '0.25', '0.02', '0.01', '1')
    await verifyExposure('contract', '0.01', '2', '1', '0.01')
  })
})
