// SPDX-License-Identifier: CPAL-1.0
import { describe, expect, it } from 'vitest'
import type { OrderIntent } from '@gitrader/protocol'
import { validateInstrument } from '@gitrader/protocol'
import { BUILDER_FEE_TENTH_BPS, OrderBuildError, buildOrder, builderMaxFeeRate } from '../src/orders'
import { buildInstrumentRecords } from '../src/parse'
import type { InstrumentRecord } from '../src/parse'
import { loadFixture } from './helpers/fake-hl'

const NOW = 1791483435048
const defaultDex = buildInstrumentRecords(loadFixture('metaAndAssetCtxs.json'), '', 0, NOW)
const xyz = buildInstrumentRecords(loadFixture('metaAndAssetCtxs-xyz.json'), 'xyz', 1, NOW)
const rec = (list: InstrumentRecord[], coin: string) => list.find((r) => r.coin === coin)!
const BTC = rec(defaultDex, 'BTC') // szDecimals 5
const ETH = rec(defaultDex, 'ETH') // szDecimals 4
const TSLA = rec(xyz, 'xyz:TSLA')

// 测试里数值写普通字符串：入参放宽成 Record，再一次性断言成 OrderIntent
const base = (over: Record<string, unknown>): OrderIntent => ({
  accountId: 'acct_01TEST', instrumentId: 'hyperliquid:BTC', side: 'buy', type: 'limit', size: '0.001', price: '80000', ...over,
}) as unknown as OrderIntent

const code = (fn: () => unknown): number => {
  try { fn() } catch (e) { if (e instanceof OrderBuildError) return e.problem.code; throw e }
  throw new Error('expected OrderBuildError')
}

describe('limit / tif / reduceOnly wire shape', () => {
  it('gtc limit: asset id, canonical strings, cloid with 0x', () => {
    const b = buildOrder(base({ clientOrderId: '9f1c3b5e7a2d4c6e8f0a1b2c3d4e5f60' }), BTC)
    expect(b.grouping).toBe('na')
    expect(b.orders).toEqual([{ a: BTC.assetId, b: true, p: '80000', s: '0.001', r: false, t: { limit: { tif: 'Gtc' } }, c: '0x9f1c3b5e7a2d4c6e8f0a1b2c3d4e5f60' }])
    expect(BTC.assetId).toBe(0)
  })

  it('generates a 32-hex client order id when none is given', () => {
    const b = buildOrder(base({}), BTC)
    expect(b.clientOrderId).toMatch(/^[0-9a-f]{32}$/)
    expect(b.orders[0]!.c).toBe(`0x${b.clientOrderId}`)
  })

  it('size truncates toward zero; a size below the lot step is a PRECISION error', () => {
    expect(buildOrder(base({ size: '0.0012349', price: '90000' }), BTC).orders[0]!.s).toBe('0.00123')
    expect(code(() => buildOrder(base({ size: '0.000001', reduceOnly: true }), BTC))).toBe(1002)
  })

  it('postOnly -> Alo, ioc -> Ioc, reduceOnly flag, unsupported tifs rejected with 1004', () => {
    expect((buildOrder(base({ postOnly: true }), BTC).orders[0]!.t as any).limit.tif).toBe('Alo')
    expect((buildOrder(base({ tif: 'alo' }), BTC).orders[0]!.t as any).limit.tif).toBe('Alo')
    expect((buildOrder(base({ tif: 'ioc' }), BTC).orders[0]!.t as any).limit.tif).toBe('Ioc')
    expect(buildOrder(base({ reduceOnly: true }), BTC).orders[0]!.r).toBe(true)
    expect(code(() => buildOrder(base({ tif: 'fok' }), BTC))).toBe(1004)
    expect(code(() => buildOrder(base({ tif: 'gtd' }), BTC))).toBe(1004)
    expect(code(() => buildOrder(base({ tif: 'ioc', postOnly: true }), BTC))).toBe(1004)
    expect(code(() => buildOrder(base({ type: 'twap' }), BTC))).toBe(1004)
    expect(code(() => buildOrder(base({ type: 'trailing_stop' }), BTC))).toBe(1004)
  })

  it('unknown / delisted instrument -> 1001', () => {
    expect(code(() => buildOrder(base({}), undefined))).toBe(1001)
    const delisted = rec(xyz, 'xyz:OLDCO1')
    expect(delisted.instrument.status).toBe('delisted')
    expect(code(() => buildOrder(base({ instrumentId: 'hyperliquid:xyz:OLDCO1' }), delisted))).toBe(1001)
  })

  it('minimum order value 10 USDC applies, reduce-only is exempt', () => {
    expect(code(() => buildOrder(base({ size: '0.0001', price: '80000' }), BTC))).toBe(1003)
    expect(buildOrder(base({ size: '0.0001', price: '80000', reduceOnly: true }), BTC).orders).toHaveLength(1)
  })
})

describe('price rule', () => {
  it('rounding=reject (default) refuses an off-grid price; passive rounds buy down / sell up', () => {
    expect(code(() => buildOrder(base({ price: '80000.55' }), BTC))).toBe(1002)
    expect(buildOrder(base({ price: '80000.55', rounding: 'passive' }), BTC).orders[0]!.p).toBe('80000')
    const sell = buildOrder(base({ side: 'sell', price: '80000.55', rounding: 'passive' }), BTC)
    expect(sell.orders[0]!.p).toBe('80001')
    expect(sell.rounded).toEqual([{ field: 'price', from: '80000.55', to: '80001' }])
  })

  it('strips trailing zeros', () => {
    expect(buildOrder(base({ price: '80000.0' }), BTC).orders[0]!.p).toBe('80000')
  })
})

describe('market orders are IOC limits with a slippage cap', () => {
  const ref = { bid: 79999.5, ask: 80000.5, mid: 80000 }
  it('buy caps above mid, sell caps below mid', () => {
    const buy = buildOrder(base({ type: 'market', price: undefined, maxSlippageBps: 50 }), BTC, ref)
    expect(buy.orders[0]).toMatchObject({ p: '80400', t: { limit: { tif: 'Ioc' } } })
    const sell = buildOrder(base({ type: 'market', side: 'sell', price: undefined, maxSlippageBps: 50 }), BTC, ref)
    expect(sell.orders[0]!.p).toBe('79600')
  })

  it('never exceeds the cap when the cap is off-grid (buy snaps down)', () => {
    // ETH szDecimals 4 -> 1 decimal at 4-digit prices; 3500.5 * 1.005 = 3518.0025 -> 3518
    const buy = buildOrder(base({ instrumentId: 'hyperliquid:ETH', type: 'market', price: undefined, size: '1', maxSlippageBps: 50 }), ETH, { mid: 3500.5 })
    expect(buy.orders[0]!.p).toBe('3518')
    const sell = buildOrder(base({ instrumentId: 'hyperliquid:ETH', type: 'market', side: 'sell', price: undefined, size: '1', maxSlippageBps: 50 }), ETH, { mid: 3500.5 })
    // 3500.5 * 0.995 = 3482.9975 -> snap up -> 3483
    expect(sell.orders[0]!.p).toBe('3483')
  })

  it('needs maxSlippageBps (no implicit default) and a fresh price', () => {
    expect(code(() => buildOrder(base({ type: 'market', price: undefined }), BTC, ref))).toBe(-32602)
    expect(code(() => buildOrder(base({ type: 'market', price: undefined, maxSlippageBps: 50 }), BTC))).toBe(2007)
    expect(code(() => buildOrder(base({ type: 'market', price: undefined, maxSlippageBps: 50 }), BTC, { ...ref, stale: true }))).toBe(2007)
  })

  it('notional converts to size at the reference price, truncating', () => {
    const b = buildOrder(base({ size: undefined, notional: '1000', price: '80000' }), BTC, { mid: 80000 })
    expect(b.orders[0]!.s).toBe('0.0125')
  })
})

describe('trigger orders and TP/SL', () => {
  it('stop_market is a market trigger labelled sl, take_limit a limit trigger labelled tp', () => {
    const stop = buildOrder(base({ type: 'stop_market', side: 'sell', price: undefined, triggerPrice: '79000', reduceOnly: true }), BTC)
    expect(stop.orders[0]).toMatchObject({ b: false, p: '79000', r: true, t: { trigger: { isMarket: true, triggerPx: '79000', tpsl: 'sl' } } })
    const take = buildOrder(base({ type: 'take_limit', side: 'sell', price: '82500', triggerPrice: '82000' }), BTC)
    expect(take.orders[0]).toMatchObject({ p: '82500', t: { trigger: { isMarket: false, triggerPx: '82000', tpsl: 'tp' } } })
    expect(code(() => buildOrder(base({ type: 'stop_market', price: undefined }), BTC))).toBe(-32602)
    expect(code(() => buildOrder(base({ type: 'stop_market', price: undefined, triggerPrice: '79000', triggerType: 'last' }), BTC))).toBe(1004)
  })

  it('order-level TP/SL: parent + opposite reduce-only trigger children, grouping normalTpsl', () => {
    const b = buildOrder(base({ tpsl: { takeProfit: { triggerPrice: '82000' }, stopLoss: { triggerPrice: '78000' }, grouping: 'order' } }), BTC)
    expect(b.grouping).toBe('normalTpsl')
    expect(b.roles).toEqual(['parent', 'tp', 'sl'])
    expect(b.orders[1]).toMatchObject({ b: false, r: true, s: '0.001', t: { trigger: { isMarket: true, triggerPx: '82000', tpsl: 'tp' } } })
    expect(b.orders[2]).toMatchObject({ b: false, r: true, t: { trigger: { isMarket: true, triggerPx: '78000', tpsl: 'sl' } } })
    expect(b.orders[1]!.c).toBeUndefined()
  })

  it('position-level TP/SL uses positionTpsl; a limit price on a leg makes it a limit trigger', () => {
    const b = buildOrder(base({ side: 'sell', tpsl: { stopLoss: { triggerPrice: '82000', price: '82100' }, grouping: 'position' } }), BTC)
    expect(b.grouping).toBe('positionTpsl')
    expect(b.orders[1]).toMatchObject({ b: true, p: '82100', t: { trigger: { isMarket: false, triggerPx: '82000', tpsl: 'sl' } } })
  })
})

describe('HIP-3 markets', () => {
  it('asset id = 100000 + dexIndex * 10000 + position in the raw universe (delisted entries count)', () => {
    const universe = loadFixture<any[]>('metaAndAssetCtxs-xyz.json')[0].universe
    const pos = universe.findIndex((u: any) => u.name === 'xyz:TSLA')
    expect(pos).toBeGreaterThanOrEqual(0)
    expect(TSLA.assetId).toBe(110000 + pos)
    expect(TSLA.instrument.instrumentId).toBe('hyperliquid:xyz:TSLA')
    expect(TSLA.instrument.marketGroup).toBe('xyz')
    expect(TSLA.instrument.underlying?.synthetic).toBe(true)
    const b = buildOrder(base({ instrumentId: 'hyperliquid:xyz:TSLA', price: '379.5', size: '1' }), TSLA)
    expect(b.orders[0]!.a).toBe(TSLA.assetId)
  })
})

describe('builder constants', () => {
  it('1 bp is 10 tenths of a basis point = 0.01%', () => {
    expect(BUILDER_FEE_TENTH_BPS).toBe(10)
    expect(builderMaxFeeRate()).toBe('0.01%')
    expect(builderMaxFeeRate(1)).toBe('0.001%') // 官方 SDK 示例里的 f=1
  })
})

describe('v0.1.3 alignment', () => {
  it('HL instruments declare 24/7 sessions and no fixed spread, and validate against the protocol schema', () => {
    for (const r of [BTC, TSLA]) {
      expect(r.instrument.sessions).toEqual({ tz: 'UTC', windows: [{ days: [0, 1, 2, 3, 4, 5, 6], from: '00:00', to: '23:59', quality: 'regular' }] })
      expect(r.instrument.typicalSpreadBps).toBeUndefined()
      const v = validateInstrument(r.instrument)
      expect(v.ok, JSON.stringify(v)).toBe(true)
    }
  })

  it('legId is carried by the kernel only: it never reaches the venue wire', () => {
    const a = buildOrder(base({ clientOrderId: '9f1c3b5e7a2d4c6e8f0a1b2c3d4e5f60' }), BTC)
    const b = buildOrder(base({ clientOrderId: '9f1c3b5e7a2d4c6e8f0a1b2c3d4e5f60', legId: 'leg-1', exitPlanId: 'plan-1' }), BTC)
    expect(b.orders).toEqual(a.orders)
  })
})
