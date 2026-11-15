// SPDX-License-Identifier: CPAL-1.0
// 订单参数表（全离线、纯函数）：每种订单类型 → /fapi/v1/order 参数，精度截断、tif、positionSide、保护单。
import { describe, expect, it } from 'vitest'
import type { OrderIntent } from '@gitrader/protocol'
import { OrderBuildError, buildOrderParams, buildProtectionOrders, inferPositionSide, newClientOrderId, sanitizeClientOrderId } from '../src/orders'
import { parseInstrumentRecords } from '../src/parse'
import type { InstrumentRecord } from '../src/parse'
import { NOW, symbolEntry } from './helpers/fake-binance-trade'

const records = parseInstrumentRecords({ symbols: [symbolEntry()] }, NOW)
const BTC = records[0]!
const ETH: InstrumentRecord = parseInstrumentRecords({ symbols: [symbolEntry({ symbol: 'ETHUSDT', baseAsset: 'ETH', pricePrecision: 1 })] }, NOW)[0]!

const base = (over: Record<string, unknown>): OrderIntent => ({
  accountId: 'acct_01TEST',
  instrumentId: 'binance:BTCUSDT',
  side: 'buy',
  type: 'limit',
  size: '0.010',
  price: '95000',
  ...over,
}) as unknown as OrderIntent

const code = (fn: () => unknown): number => {
  try {
    fn()
  } catch (e) {
    if (e instanceof OrderBuildError) return e.problem.code
    throw e
  }
  throw new Error('expected OrderBuildError')
}

const name = (fn: () => unknown): string => {
  try {
    fn()
  } catch (e) {
    if (e instanceof OrderBuildError) return e.problem.name
    throw e
  }
  throw new Error('expected OrderBuildError')
}

describe('order type → parameter table', () => {
  it('market: LIMIT + IOC at the reference price ± maxSlippageBps, snapped to the tick', () => {
    const { params, endpoint } = buildOrderParams(
      base({ type: 'market', price: undefined, size: '0.1012345', maxSlippageBps: 10 }),
      BTC,
      { ref: { bid: 99.9, ask: 100.1, mid: 100 } },
    )
    // 买价 = 100 × (1 + 10/1e4) = 100.1，正好落在 tick 0.10 上
    expect(params).toMatchObject({ symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', timeInForce: 'IOC', quantity: '0.101', price: '100.1' })
    expect(endpoint).toBe('order')
    // 卖价 = 100 × (1 − 10/1e4) = 99.9
    const sell = buildOrderParams(
      base({ type: 'market', side: 'sell', price: undefined, size: '0.1', maxSlippageBps: 10 }),
      BTC,
      { ref: { mid: 100 } },
    )
    expect(sell.params.price).toBe('99.9')
  })

  it('market needs maxSlippageBps and a fresh reference price', () => {
    expect(name(() => buildOrderParams(base({ type: 'market', price: undefined }), BTC))).toBe('INVALID_PARAMS')
    expect(code(() => buildOrderParams(base({ type: 'market', price: undefined, maxSlippageBps: 10 }), BTC))).toBe(2007)
    expect(code(() => buildOrderParams(base({ type: 'market', price: undefined, maxSlippageBps: 0 }), BTC))).toBe(-32602)
    expect(code(() => buildOrderParams(
      base({ type: 'market', price: undefined, maxSlippageBps: 10 }),
      BTC,
      { ref: { mid: 100, stale: true } },
    ))).toBe(2007)
  })

  it('limit gtc: quantity truncated to stepSize, price kept on the tick, client order id carried', () => {
    const { params, clientOrderId } = buildOrderParams(base({ clientOrderId: 'gt-manual-1' }), BTC)
    expect(params).toEqual({
      symbol: 'BTCUSDT',
      side: 'BUY',
      type: 'LIMIT',
      timeInForce: 'GTC',
      quantity: '0.01',
      price: '95000',
      newClientOrderId: 'gt-manual-1',
    })
    expect(clientOrderId).toBe('gt-manual-1')
  })

  it('limit ioc / fok / alo map to IOC / FOK / GTX, and postOnly forces GTX', () => {
    expect(buildOrderParams(base({ tif: 'ioc' }), BTC).params.timeInForce).toBe('IOC')
    expect(buildOrderParams(base({ tif: 'fok' }), BTC).params.timeInForce).toBe('FOK')
    expect(buildOrderParams(base({ tif: 'alo' }), BTC).params.timeInForce).toBe('GTX')
    expect(buildOrderParams(base({ postOnly: true }), BTC).params.timeInForce).toBe('GTX')
  })

  it('gtd is not supported (1004) and market + gtc is rejected', () => {
    expect(code(() => buildOrderParams(base({ tif: 'gtd' }), BTC))).toBe(1004)
    expect(code(() => buildOrderParams(
      base({ type: 'market', tif: 'gtc', price: undefined, size: '0.1', maxSlippageBps: 10 }),
      BTC,
      { ref: { mid: 100 } },
    ))).toBe(1004)
  })

  it('stop_market: algo CONDITIONAL + triggerPrice + workingType=MARK_PRICE, no price / tif', () => {
    const { params, endpoint, clientOrderId } = buildOrderParams(
      base({ type: 'stop_market', price: undefined, triggerPrice: '90000', clientOrderId: 'gt-stop-1' }),
      BTC,
    )
    expect(endpoint).toBe('algo')
    expect(params).toMatchObject({
      algoType: 'CONDITIONAL', type: 'STOP_MARKET', triggerPrice: '90000', workingType: 'MARK_PRICE', quantity: '0.01', clientAlgoId: 'gt-stop-1',
    })
    expect(params.stopPrice).toBeUndefined()
    expect(params.newClientOrderId).toBeUndefined()
    expect(params.timeInForce).toBeUndefined()
    expect(params.price).toBeUndefined()
    expect(clientOrderId).toBe('gt-stop-1')
  })

  it('stop_limit: algo STOP + triggerPrice + price + GTC', () => {
    const { params, endpoint } = buildOrderParams(base({ type: 'stop_limit', triggerPrice: '90000', price: '89900' }), BTC)
    expect(endpoint).toBe('algo')
    expect(params).toMatchObject({
      algoType: 'CONDITIONAL', type: 'STOP', triggerPrice: '90000', price: '89900', timeInForce: 'GTC', workingType: 'MARK_PRICE',
    })
    expect(params.stopPrice).toBeUndefined()
  })

  it('take_market / take_limit map to algo TAKE_PROFIT_MARKET / TAKE_PROFIT', () => {
    const tm = buildOrderParams(base({ type: 'take_market', price: undefined, triggerPrice: '110000' }), BTC).params
    expect(tm).toMatchObject({ algoType: 'CONDITIONAL', type: 'TAKE_PROFIT_MARKET', triggerPrice: '110000', workingType: 'MARK_PRICE' })
    const tl = buildOrderParams(base({ type: 'take_limit', triggerPrice: '110000', price: '110100' }), BTC).params
    expect(tl).toMatchObject({ algoType: 'CONDITIONAL', type: 'TAKE_PROFIT', triggerPrice: '110000', price: '110100', timeInForce: 'GTC' })
  })

  it('trailing_stop: algo TRAILING_STOP_MARKET with callbackRate in percent', () => {
    const t = (b: Record<string, string>) => buildOrderParams(base({ type: 'trailing_stop', price: undefined, triggerPrice: undefined, trailing: b }), BTC)
    const out = t({ callbackRatio: '0.02', activationPrice: '99500' })
    expect(out.endpoint).toBe('algo')
    expect(out.params).toMatchObject({
      algoType: 'CONDITIONAL',
      type: 'TRAILING_STOP_MARKET',
      callbackRate: '2',
      activatePrice: '99500',
      workingType: 'MARK_PRICE',
      quantity: '0.01',
    })
    expect(out.params.triggerPrice).toBeUndefined()
    expect(out.params.newClientOrderId).toBeUndefined()
    expect(t({ callbackRatio: '0.001' }).params.callbackRate).toBe('0.1')
    expect(t({ callbackRatio: '0.1' }).params.callbackRate).toBe('10')
  })

  it('trailing_stop rejects out-of-range callbackRatio instead of clamping, and rejects activationRatio', () => {
    const t = (b: Record<string, string>) => buildOrderParams(base({ type: 'trailing_stop', price: undefined, trailing: b }), BTC)
    expect(name(() => t({ callbackRatio: '0.5' }))).toBe('INVALID_PARAMS')
    expect(name(() => t({ callbackRatio: '0.0001' }))).toBe('INVALID_PARAMS')
    expect(name(() => t({ callbackRatio: '0.02', activationRatio: '0.01' }))).toBe('INVALID_PARAMS')
    // 给了 activationPrice 时 activationRatio 不再是被丢弃的唯一激活条件
    expect(t({ callbackRatio: '0.02', activationPrice: '99500', activationRatio: '0.01' }).params.activatePrice).toBe('99500')
  })

  it('trailing_stop needs callbackRatio; trailing params on other types are rejected', () => {
    expect(name(() => buildOrderParams(base({ type: 'trailing_stop', price: undefined }), BTC))).toBe('INVALID_PARAMS')
    expect(name(() => buildOrderParams(base({ trailing: { callbackRatio: '0.02' } }), BTC))).toBe('INVALID_PARAMS')
  })

  it('twap and unsupported trigger types are 1004; unknown/delisted instruments are 1001', () => {
    expect(code(() => buildOrderParams(base({ type: 'twap' }), BTC))).toBe(1004)
    expect(code(() => buildOrderParams(base({ type: 'stop_market', triggerType: 'last', triggerPrice: '90000' }), BTC))).toBe(1004)
    expect(code(() => buildOrderParams(base({}), undefined))).toBe(1001)
    const delisted = parseInstrumentRecords({ symbols: [symbolEntry({ status: 'CLOSE' })] }, NOW)[0]!
    expect(code(() => buildOrderParams(base({}), delisted))).toBe(1001)
  })

  it('triggerPrice on a plain limit order is rejected (no silent drop)', () => {
    expect(name(() => buildOrderParams(base({ triggerPrice: '90000' }), BTC))).toBe('INVALID_PARAMS')
  })
})

describe('precision (stepSize / tickSize)', () => {
  it('sizes truncate toward zero on stepSize 0.001', () => {
    expect(buildOrderParams(base({ size: '0.0123456' }), BTC).params.quantity).toBe('0.012')
    expect(buildOrderParams(base({ size: '1.9999' }), BTC).params.quantity).toBe('1.999')
  })

  it('a size below the lot step or below minQty is PRECISION (1002)', () => {
    expect(code(() => buildOrderParams(base({ size: '0.0001' }), BTC))).toBe(1002)
    const minQtyRecord = parseInstrumentRecords({
      symbols: [symbolEntry({ filters: [
        { filterType: 'PRICE_FILTER', tickSize: '0.10' },
        { filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.05' },
        { filterType: 'MIN_NOTIONAL', notional: '5' },
      ] })],
    }, NOW)[0]!
    expect(code(() => buildOrderParams(base({ size: '0.010' }), minQtyRecord))).toBe(1002)
  })

  it('prices off the tick are PRECISION in reject mode', () => {
    expect(code(() => buildOrderParams(base({ price: '95000.05' }), BTC))).toBe(1002)
  })

  it('passive rounding: buy floors, sell ceils, and records the change', () => {
    const buy = buildOrderParams(base({ price: '95000.05', rounding: 'passive' }), BTC)
    expect(buy.params.price).toBe('95000')
    expect(buy.rounded).toEqual([{ field: 'price', from: '95000.05', to: '95000' }])
    const sell = buildOrderParams(base({ side: 'sell', price: '95000.01', rounding: 'passive' }), BTC)
    expect(sell.params.price).toBe('95000.1')
  })

  it('ETH has a coarser tick (0.1) and still validates', () => {
    const eth = buildOrderParams({ accountId: 'acct_01TEST', instrumentId: 'binance:ETHUSDT', side: 'buy', type: 'limit', size: '1', price: '3000.1' } as unknown as OrderIntent, ETH)
    expect(eth.params.price).toBe('3000.1')
    expect(code(() => buildOrderParams({ accountId: 'acct_01TEST', instrumentId: 'binance:ETHUSDT', side: 'buy', type: 'limit', size: '1', price: '3000.05' } as unknown as OrderIntent, ETH))).toBe(1002)
  })

  it('notional below MIN_NOTIONAL is 1003, but reduceOnly is exempt', () => {
    expect(code(() => buildOrderParams(base({ size: '0.001', price: '100' }), BTC))).toBe(1003)
    const reduce = buildOrderParams(base({ size: '0.001', price: '100', reduceOnly: true }), BTC)
    expect(reduce.params.reduceOnly).toBe('true')
  })

  it('notional converts to size through the cached reference price; without one it is STALE_PRICE', () => {
    const withRef = buildOrderParams(base({ size: undefined, price: undefined, type: 'market', notional: '200', maxSlippageBps: 10 }), BTC, {
      ref: { bid: 99.9, ask: 100.1, mid: 100 },
    })
    expect(withRef.params.quantity).toBe('2')
    expect(code(() => buildOrderParams(base({ size: undefined, price: undefined, type: 'market', notional: '200', maxSlippageBps: 10 }), BTC))).toBe(2007)
  })

  it('size and notional both given → size wins', () => {
    expect(buildOrderParams(base({ size: '0.02', notional: '100000' }), BTC).params.quantity).toBe('0.02')
  })
})

describe('position mode / reduceOnly', () => {
  it('oneWay (default): no positionSide, reduceOnly as a query flag', () => {
    const open = buildOrderParams(base({}), BTC)
    expect(open.params.positionSide).toBeUndefined()
    expect(open.positionSide).toBe('BOTH')
    const close = buildOrderParams(base({ side: 'sell', reduceOnly: true }), BTC)
    expect(close.params.positionSide).toBeUndefined()
    expect(close.params.reduceOnly).toBe('true')
  })

  it('hedge: positionSide is sent and reduceOnly is omitted (sending both is -1106)', () => {
    const open = buildOrderParams(base({}), BTC, { positionMode: 'hedge' })
    expect(open.params.positionSide).toBe('LONG')
    expect(open.params.reduceOnly).toBeUndefined()
    const close = buildOrderParams(base({ side: 'sell', reduceOnly: true }), BTC, { positionMode: 'hedge' })
    expect(close.params.positionSide).toBe('LONG')
    expect(close.params.reduceOnly).toBeUndefined()
    const short = buildOrderParams(base({ side: 'sell' }), BTC, { positionMode: 'hedge' })
    expect(short.params.positionSide).toBe('SHORT')
  })

  it('inferPositionSide follows QD (open BUY=LONG, reduce SELL=LONG)', () => {
    expect(inferPositionSide('buy', false)).toBe('LONG')
    expect(inferPositionSide('sell', false)).toBe('SHORT')
    expect(inferPositionSide('sell', true)).toBe('LONG')
    expect(inferPositionSide('buy', true)).toBe('SHORT')
  })
})

describe('client order ids', () => {
  it('generates a gt-prefixed unique id when none is given', () => {
    const a = buildOrderParams(base({}), BTC).clientOrderId
    const b = buildOrderParams(base({}), BTC).clientOrderId
    expect(a).toMatch(/^gt[0-9a-f]{24}$/)
    expect(a).not.toBe(b)
    expect(newClientOrderId()).toMatch(/^gt[0-9a-f]{24}$/)
  })

  it('sanitizes ids to the Binance charset and 36 char limit', () => {
    expect(sanitizeClientOrderId('a b/c:d')).toBe('ab/c:d')
    expect(sanitizeClientOrderId('x'.repeat(50))).toHaveLength(36)
    expect(() => sanitizeClientOrderId('***')).toThrow(OrderBuildError)
  })
})

describe('buildProtectionOrders (post-fill reduce-only protection)', () => {
  const parent = base({
    side: 'buy',
    size: '0.010',
    type: 'market',
    price: undefined,
    clientOrderId: 'gt-parent-1',
    tpsl: { takeProfit: { triggerPrice: '110000' }, stopLoss: { triggerPrice: '90000' }, grouping: 'position' },
  })

  it('emits algo STOP_MARKET + TAKE_PROFIT_MARKET with quantity = filled delta and the opposite side', () => {
    const out = buildProtectionOrders(parent, '0.010' as never, BTC)
    expect(out.stopLoss?.endpoint).toBe('algo')
    expect(out.stopLoss?.params).toMatchObject({
      algoType: 'CONDITIONAL', symbol: 'BTCUSDT', side: 'SELL', type: 'STOP_MARKET', quantity: '0.01',
      triggerPrice: '90000', workingType: 'MARK_PRICE', reduceOnly: 'true', clientAlgoId: 'gt-parent-1-sl',
    })
    expect(out.takeProfit?.params).toMatchObject({
      algoType: 'CONDITIONAL', symbol: 'BTCUSDT', side: 'SELL', type: 'TAKE_PROFIT_MARKET', quantity: '0.01',
      triggerPrice: '110000', reduceOnly: 'true', clientAlgoId: 'gt-parent-1-tp',
    })
    expect(out.stopLoss?.params.stopPrice).toBeUndefined()
    expect(out.stopLoss?.params.newClientOrderId).toBeUndefined()
    expect(out.stopLoss?.params.timeInForce).toBeUndefined()
    expect(out.stopLoss?.clientOrderId).toBe('gt-parent-1-sl')
    expect(out.takeProfit?.clientOrderId).toBe('gt-parent-1-tp')
  })

  it('only the filled delta is protected (partial fill)', () => {
    const out = buildProtectionOrders(parent, '0.0034' as never, BTC)
    expect(out.stopLoss?.params.quantity).toBe('0.003')
    expect(out.takeProfit?.params.quantity).toBe('0.003')
  })

  it('a short parent protects with BUY reduce-only orders', () => {
    const short = { ...parent, side: 'sell' } as unknown as OrderIntent
    const out = buildProtectionOrders(short, '0.01' as never, BTC)
    expect(out.stopLoss?.params.side).toBe('BUY')
    expect(out.takeProfit?.params.side).toBe('BUY')
  })

  it('hedge mode uses positionSide and drops reduceOnly', () => {
    const out = buildProtectionOrders(parent, '0.01' as never, BTC, { positionMode: 'hedge' })
    expect(out.stopLoss?.params.positionSide).toBe('LONG')
    expect(out.stopLoss?.params.reduceOnly).toBeUndefined()
  })

  it('a leg with a limit price becomes STOP / TAKE_PROFIT with GTC and price', () => {
    const withPrices = {
      ...parent,
      tpsl: { takeProfit: { triggerPrice: '110000', price: '110100' }, stopLoss: { triggerPrice: '90000', price: '89900' }, grouping: 'position' },
    } as unknown as OrderIntent
    const out = buildProtectionOrders(withPrices, '0.01' as never, BTC)
    expect(out.stopLoss?.params).toMatchObject({ algoType: 'CONDITIONAL', type: 'STOP', triggerPrice: '90000', price: '89900', timeInForce: 'GTC' })
    expect(out.takeProfit?.params).toMatchObject({ algoType: 'CONDITIONAL', type: 'TAKE_PROFIT', triggerPrice: '110000', price: '110100', timeInForce: 'GTC' })
  })

  it('refuses intents without tpsl, with a delta below the lot step, or an unknown instrument', () => {
    expect(name(() => buildProtectionOrders(base({}), '0.01' as never, BTC))).toBe('INVALID_PARAMS')
    expect(code(() => buildProtectionOrders(parent, '0.0001' as never, BTC))).toBe(1002)
    expect(code(() => buildProtectionOrders(parent, '0.01' as never, undefined))).toBe(1001)
  })
})
