// SPDX-License-Identifier: CPAL-1.0
// 订单参数构造（纯函数，全离线）：七种订单类型的参数表、数量「张 → 币」折 ctVal、
// 精度（tick / lot）、posSide 与 reduceOnly、算法单通道、保护单（OCO / conditional）。
import { describe, expect, it } from 'vitest'
import type { OrderIntent } from '@gitrader/protocol'
import {
  ALGO_PATH, ORDER_PATH, buildOrderParams, buildProtectionOrders, newClientOrderId, OrderBuildError, resolvePosSide,
  sanitizeClientOrderId,
} from '../src/orders'
import type { BuiltOrderParams } from '../src/orders'
import { parseInstrumentRecords } from '../src/parse'
import type { InstrumentRecord } from '../src/parse'
import { NOW, instruments } from './helpers/fake-okx-trade'

const records: InstrumentRecord[] = parseInstrumentRecords(instruments, NOW)
const btc = records.find((r) => r.symbol === 'BTC-USDT-SWAP')!
const eth = records.find((r) => r.symbol === 'ETH-USDT-SWAP')!

function intent(over: Record<string, unknown> = {}): OrderIntent {
  return {
    accountId: 'acct_test',
    instrumentId: btc.instrument.instrumentId,
    side: 'buy',
    type: 'limit',
    size: '0.05',
    price: '100000',
    ...over,
  } as unknown as OrderIntent
}

function built(over: Record<string, unknown> = {}, opts: Parameters<typeof buildOrderParams>[2] = {}): BuiltOrderParams {
  return buildOrderParams(intent(over), btc, opts)
}

function problemOf(fn: () => unknown): string {
  try {
    fn()
  } catch (e) {
    if (e instanceof OrderBuildError) return `${e.problem.code}:${e.problem.name}`
    throw e
  }
  throw new Error('expected a build error')
}

describe('instrument records (settleCcy filter, ctVal folding)', () => {
  it('keeps USDT and USDC SWAPs only', () => {
    const symbols = records.map((r) => r.symbol).sort()
    expect(symbols).toEqual(['BTC-USDC-SWAP', 'BTC-USDT-SWAP', 'ETH-USDT-SWAP'])
    expect(symbols).not.toContain('BTC-USD-SWAP')
    expect(symbols).not.toContain('BTC-USDT-260327')
  })

  it('reads ctVal into contractSize and derives the contract lot step', () => {
    expect(btc.ctVal).toBe('0.01')
    expect(btc.instrument.contractSize).toBe('0.01')
    // lotSz 0.01 张 × ctVal 0.01 = 0.0001 币；反过来 0.0001 / 0.01 = 0.01 张
    expect(btc.lotContracts).toBe('0.01')
    expect(btc.instrument.size.step).toBe('0.0001')
    expect(eth.ctVal).toBe('0.1')
    expect(eth.lotContracts).toBe('0.01')
  })
})

describe('limit orders', () => {
  it('builds the /trade/order body in a fixed key order', () => {
    const out = built({ clientOrderId: 'gtclient0123456789' })
    expect(out.kind).toBe('order')
    expect(out.path).toBe(ORDER_PATH)
    expect(out.body).toEqual({
      instId: 'BTC-USDT-SWAP',
      tdMode: 'cross',
      side: 'buy',
      posSide: 'net',
      ordType: 'limit',
      sz: '5',
      px: '100000',
      clOrdId: 'gtclient0123456789',
    })
    expect(out.contracts).toBe('5')
    expect(out.baseSize).toBe('0.05')
  })

  it('maps tif to OKX ordType (gtc → limit, alo → post_only, ioc, fok)', () => {
    expect(built({ tif: 'gtc' }).body.ordType).toBe('limit')
    expect(built({ tif: 'alo' }).body.ordType).toBe('post_only')
    expect(built({ tif: 'ioc' }).body.ordType).toBe('ioc')
    expect(built({ tif: 'fok' }).body.ordType).toBe('fok')
    expect(built({ postOnly: true }).body.ordType).toBe('post_only')
  })

  it('rejects postOnly combined with a taker tif', () => {
    expect(problemOf(() => built({ postOnly: true, tif: 'ioc' }))).toBe('1004:ORDER_TYPE_UNSUPPORTED')
  })

  it('honours an isolated margin mode through tdMode', () => {
    expect(built({ marginMode: 'isolated' }).body.tdMode).toBe('isolated')
  })
})

describe('market orders', () => {
  const ref = { bid: 100000, ask: 100002, mid: 100001, stale: false }

  it('sends a price-banded IOC (buy rounds down, sell rounds up)', () => {
    const buy = built({ type: 'market', price: undefined, maxSlippageBps: 50 }, { ref })
    expect(buy.body).toMatchObject({ ordType: 'ioc', px: '100501', sz: '5' })
    const sell = built({ type: 'market', price: undefined, side: 'sell', maxSlippageBps: 50 }, { ref })
    expect(sell.body.px).toBe('99501')
  })

  it('needs maxSlippageBps (no implicit default)', () => {
    expect(problemOf(() => built({ type: 'market', price: undefined }, { ref }))).toBe('-32602:INVALID_PARAMS')
    expect(problemOf(() => built({ type: 'market', price: undefined, maxSlippageBps: 0 }, { ref }))).toBe('-32602:INVALID_PARAMS')
  })

  it('rejects a stale or missing quote before the network', () => {
    expect(problemOf(() => built({ type: 'market', price: undefined, maxSlippageBps: 50 }, { ref: { ...ref, stale: true } }))).toBe('2007:STALE_PRICE')
    expect(problemOf(() => built({ type: 'market', price: undefined, maxSlippageBps: 50 }))).toBe('2007:STALE_PRICE')
  })

  it('accepts only ioc (or no tif) on a market order', () => {
    expect(built({ type: 'market', price: undefined, maxSlippageBps: 50 }, { ref }).body.ordType).toBe('ioc')
    expect(problemOf(() => built({ type: 'market', price: undefined, maxSlippageBps: 50, tif: 'gtc' }, { ref }))).toBe('1004:ORDER_TYPE_UNSUPPORTED')
  })

  it('rejects postOnly on a market order', () => {
    expect(problemOf(() => built({ type: 'market', price: undefined, maxSlippageBps: 50, postOnly: true }, { ref }))).toBe('1004:ORDER_TYPE_UNSUPPORTED')
  })
})

describe('conditional (stop / take) algo orders', () => {
  it('stop_market → conditional with slTriggerPx and a market slOrdPx (-1)', () => {
    const out = built({ type: 'stop_market', price: undefined, triggerPrice: '95000' })
    expect(out.kind).toBe('algo')
    expect(out.path).toBe(ALGO_PATH)
    expect(out.body).toEqual({
      instId: 'BTC-USDT-SWAP',
      tdMode: 'cross',
      side: 'buy',
      posSide: 'net',
      ordType: 'conditional',
      sz: '5',
      slTriggerPx: '95000',
      slOrdPx: '-1',
      slTriggerPxType: 'mark',
      algoClOrdId: out.clientOrderId,
    })
    expect(out.body.clOrdId).toBeUndefined()
  })

  it('stop_limit → conditional with slOrdPx = price', () => {
    const out = built({ type: 'stop_limit', price: '94900', triggerPrice: '95000' })
    expect(out.body.ordType).toBe('conditional')
    expect(out.body.slTriggerPx).toBe('95000')
    expect(out.body.slOrdPx).toBe('94900')
  })

  it('take_market / take_limit use the tp* fields and mark triggers', () => {
    expect(built({ type: 'take_market', price: undefined, triggerPrice: '105000' }).body).toMatchObject({ tpTriggerPx: '105000', tpOrdPx: '-1' })
    expect(built({ type: 'take_limit', price: '104900', triggerPrice: '105000' }).body).toMatchObject({ tpTriggerPx: '105000', tpOrdPx: '104900' })
    expect(built({ type: 'take_market', price: undefined, triggerPrice: '105000' }).body.tpTriggerPxType).toBe('mark')
  })

  it('a trigger order without triggerPrice is rejected', () => {
    expect(problemOf(() => built({ type: 'stop_market', price: undefined }))).toBe('-32602:INVALID_PARAMS')
  })

  it('a plain limit order cannot carry a triggerPrice', () => {
    expect(problemOf(() => built({ triggerPrice: '95000' }))).toBe('-32602:INVALID_PARAMS')
  })

  it('only mark-price triggers are supported', () => {
    expect(problemOf(() => built({ type: 'stop_market', price: undefined, triggerPrice: '95000', triggerType: 'last' }))).toBe('1004:ORDER_TYPE_UNSUPPORTED')
  })
})

describe('trailing stop (move_order_stop)', () => {
  it('builds move_order_stop with callbackRatio and activePx', () => {
    const out = built({
      type: 'trailing_stop', price: undefined, triggerPrice: undefined,
      trailing: { callbackRatio: '0.02', activationPrice: '101000' },
    })
    expect(out.body.ordType).toBe('move_order_stop')
    expect(out.body.callbackRatio).toBe('0.02')
    expect(out.body.activePx).toBe('101000')
    expect(out.body.sz).toBe('5')
  })

  it('rejects activationRatio without an activation price', () => {
    expect(problemOf(() => built({ type: 'trailing_stop', price: undefined, trailing: { callbackRatio: '0.02', activationRatio: '0.01' } }))).toBe('-32602:INVALID_PARAMS')
  })

  it('rejects a callbackRatio outside OKX 0.01–1', () => {
    expect(problemOf(() => built({ type: 'trailing_stop', price: undefined, trailing: { callbackRatio: '0.001' } }))).toBe('-32602:INVALID_PARAMS')
    expect(problemOf(() => built({ type: 'trailing_stop', price: undefined, trailing: { callbackRatio: '2' } }))).toBe('-32602:INVALID_PARAMS')
  })

  it('rejects trailing parameters on a non-trailing order', () => {
    expect(problemOf(() => built({ trailing: { callbackRatio: '0.02' } }))).toBe('-32602:INVALID_PARAMS')
  })
})

describe('size: base quantity → contracts via ctVal', () => {
  it('folds the base quantity by ctVal (0.055 BTC / 0.01 = 5.5 contracts)', () => {
    expect(built({ size: '0.055' }).body.sz).toBe('5.5')
  })

  it('truncates to the contract lot step instead of rounding up', () => {
    // 0.050049 币 = 5.0049 张 → 5 张（lot 0.01）
    expect(built({ size: '0.050049' }).body.sz).toBe('5')
  })

  it('uses ETH ctVal (0.1) so 0.35 ETH = 3.5 contracts', () => {
    const out = buildOrderParams(intent({ instrumentId: eth.instrument.instrumentId, size: '0.35', price: '3000' }), eth)
    expect(out.body.sz).toBe('3.5')
  })

  it('rejects a size below one contract lot', () => {
    expect(problemOf(() => built({ size: '0.00005' }))).toBe('1002:PRECISION')
  })

  it('accepts a size exactly at minSz (0.0001 BTC = 0.01 contracts)', () => {
    expect(built({ size: '0.0001' }).body.sz).toBe('0.01')
  })

  it('converts a notional into contracts using the limit price', () => {
    // 500 USDT / 100000 = 0.005 币 → 0.5 张
    expect(built({ size: undefined, notional: '500' }).body.sz).toBe('0.5')
  })

  it('rejects an intent without size or notional', () => {
    expect(problemOf(() => built({ size: undefined }))).toBe('-32602:INVALID_PARAMS')
  })
})

describe('price precision', () => {
  it('accepts a price on the tick', () => {
    expect(built({ price: '100000.1' }).body.px).toBe('100000.1')
  })

  it('rejects an off-tick price by default', () => {
    expect(problemOf(() => built({ price: '100000.05' }))).toBe('1002:PRECISION')
  })

  it('rounding=passive tightens instead of rejecting (buy down, sell up)', () => {
    expect(built({ price: '100000.05', rounding: 'passive' }).body.px).toBe('100000')
    expect(built({ side: 'sell', price: '100000.05', rounding: 'passive' }).body.px).toBe('100000.1')
  })
})

describe('posSide / reduceOnly', () => {
  it('net mode always sends posSide=net and allows reduceOnly', () => {
    expect(built({}).body.posSide).toBe('net')
    expect(built({ reduceOnly: true }).body.reduceOnly).toBe('true')
  })

  it('long_short mode derives long / short from side and reduceOnly', () => {
    expect(resolvePosSide('buy', false, 'hedge')).toBe('long')
    expect(resolvePosSide('sell', false, 'hedge')).toBe('short')
    expect(resolvePosSide('sell', true, 'hedge')).toBe('long')
    expect(resolvePosSide('buy', true, 'hedge')).toBe('short')
  })

  it('long_short mode never sends reduceOnly (side + posSide already mean close)', () => {
    const out = built(
      { reduceOnly: true, type: 'market', price: undefined, maxSlippageBps: 50 },
      { positionMode: 'hedge', ref: { bid: 100000, ask: 100002, mid: 100001, stale: false } },
    )
    expect(out.body.posSide).toBe('short')
    expect(out.body.reduceOnly).toBeUndefined()
  })
})

describe('client order ids', () => {
  it('generates gt + 24 hex characters', () => {
    expect(newClientOrderId()).toMatch(/^gt[0-9a-f]{24}$/)
  })

  it('strips characters OKX rejects and caps the length at 32', () => {
    expect(sanitizeClientOrderId('gt-abc_def:123')).toBe('gtabcdef123')
    expect(sanitizeClientOrderId('x'.repeat(40))).toHaveLength(32)
    expect(() => sanitizeClientOrderId('---')).toThrow(OrderBuildError)
  })
})

describe('buildProtectionOrders', () => {
  const parent = intent({ type: 'market', price: undefined, size: '0.03', reduceOnly: false })

  it('both legs → one native OCO algo order', () => {
    const out = buildProtectionOrders(
      { ...parent, tpsl: { takeProfit: { triggerPrice: '105000' }, stopLoss: { triggerPrice: '95000' }, grouping: 'position' } } as unknown as OrderIntent,
      '0.03', btc,
    )
    expect(out.mode).toBe('oco')
    expect(out.orders).toHaveLength(1)
    const body = out.orders[0]!.body
    expect(out.orders[0]!.path).toBe(ALGO_PATH)
    expect(body.ordType).toBe('oco')
    expect(body.instId).toBe('BTC-USDT-SWAP')
    expect(body.slTriggerPx).toBe('95000')
    expect(body.slOrdPx).toBe('-1')
    expect(body.tpTriggerPx).toBe('105000')
    expect(body.tpOrdPx).toBe('-1')
    expect(body.slTriggerPxType).toBe('mark')
    expect(body.tpTriggerPxType).toBe('mark')
    expect(out.orders[0]!.covers).toEqual(['sl', 'tp'])
  })

  it('truncates the filled delta by the contract lot, not to whole contracts', () => {
    const tpsl = { stopLoss: { triggerPrice: '95000' }, grouping: 'position' }
    const a = buildProtectionOrders({ ...parent, tpsl } as unknown as OrderIntent, '0.015', btc)
    expect(a.orders[0]!.body.sz).toBe('1.5')
    const b = buildProtectionOrders({ ...parent, tpsl } as unknown as OrderIntent, '0.005', btc)
    expect(b.orders[0]!.body.sz).toBe('0.5')
    expect(problemOf(() => buildProtectionOrders({ ...parent, tpsl } as unknown as OrderIntent, '0.00005', btc))).toBe('1002:PRECISION')
  })

  it('gives each protection order a fresh client id, or an explicit one', () => {
    const tpsl = { stopLoss: { triggerPrice: '95000' }, grouping: 'position' }
    const a = buildProtectionOrders({ ...parent, tpsl } as unknown as OrderIntent, '0.03', btc)
    const b = buildProtectionOrders({ ...parent, tpsl } as unknown as OrderIntent, '0.03', btc)
    const ida = a.orders[0]!.body.algoClOrdId!
    const idb = b.orders[0]!.body.algoClOrdId!
    expect(ida).not.toBe(idb)
    expect(ida).toMatch(/^[A-Za-z0-9]{1,32}$/)
    expect(b.orders[0]!.body.clOrdId).toBeUndefined()
    const fixed = buildProtectionOrders({ ...parent, tpsl } as unknown as OrderIntent, '0.03', btc, { clientOrderId: 'ocofixed1' })
    expect(fixed.orders[0]!.body.algoClOrdId).toBe('ocofixed1')
  })

  it('size = the filled delta, side is the opposite of the parent, reduceOnly in net mode', () => {
    const out = buildProtectionOrders(
      { ...parent, tpsl: { stopLoss: { triggerPrice: '95000' }, grouping: 'position' } } as unknown as OrderIntent,
      '0.03', btc,
    )
    const body = out.orders[0]!.body
    expect(body.sz).toBe('3')
    expect(body.side).toBe('sell')
    expect(body.posSide).toBe('net')
    expect(body.reduceOnly).toBe('true')
    expect(out.mode).toBe('conditional')
  })

  it('a limit leg becomes a limit-priced trigger (slOrdPx = price)', () => {
    const out = buildProtectionOrders(
      { ...parent, tpsl: { stopLoss: { triggerPrice: '95000', price: '94950' }, grouping: 'order' } } as unknown as OrderIntent,
      '0.03', btc,
    )
    expect(out.orders[0]!.body.slOrdPx).toBe('94950')
  })

  it('hedge mode uses posSide instead of reduceOnly', () => {
    const out = buildProtectionOrders(
      { ...parent, tpsl: { takeProfit: { triggerPrice: '105000' }, grouping: 'position' } } as unknown as OrderIntent,
      '0.03', btc, { positionMode: 'hedge' },
    )
    // 平掉多头 → posSide=long（side + posSide 本身就表示平仓）
    expect(out.orders[0]!.body.posSide).toBe('long')
    expect(out.orders[0]!.body.reduceOnly).toBeUndefined()
  })

  it('requires tpsl and a positive filled size', () => {
    expect(problemOf(() => buildProtectionOrders(parent, '0.03', btc))).toBe('-32602:INVALID_PARAMS')
    expect(problemOf(() => buildProtectionOrders(
      { ...parent, tpsl: { stopping: undefined } } as unknown as OrderIntent, '0.03', btc,
    ))).toBe('-32602:INVALID_PARAMS')
    expect(problemOf(() => buildProtectionOrders(
      { ...parent, tpsl: { stopLoss: { triggerPrice: '95000' }, grouping: 'position' } } as unknown as OrderIntent, '0', btc,
    ))).toBe('-32602:INVALID_PARAMS')
  })
})

describe('unsupported inputs', () => {
  it('twap is not supported (1004)', () => {
    expect(problemOf(() => built({ type: 'twap' }))).toBe('1004:ORDER_TYPE_UNSUPPORTED')
  })

  it('an unknown instrument is 1001', () => {
    expect(problemOf(() => buildOrderParams(intent({ instrumentId: 'okx:NOPE-SWAP' }), undefined))).toBe('1001:INSTRUMENT_UNKNOWN')
  })

  it('a delisted instrument is 1001', () => {
    const delisted: InstrumentRecord = {
      ...btc,
      instrument: { ...btc.instrument, status: 'delisted' },
    }
    expect(problemOf(() => buildOrderParams(intent(), delisted))).toBe('1001:INSTRUMENT_UNKNOWN')
  })
})
