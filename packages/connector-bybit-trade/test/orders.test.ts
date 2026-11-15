// SPDX-License-Identifier: CPAL-1.0
// 下单参数构造（纯函数）：市价→价带限价+IOC、触发单价带三件套、精度、positionIdx、
// orderLinkId 约束、保护腿与持仓级 trading-stop。全部离线，无签名、无网络。
import { describe, expect, it } from 'vitest'
import { asDecimal } from '@gitrader/protocol'
import type { OrderIntent } from '@gitrader/protocol'
import {
  buildOrderParams, buildProtectionOrders, buildTradingStop, CLIENT_ORDER_ID_MAX, inferPositionIdx, newClientOrderId,
  OrderBuildError, sanitizeClientOrderId, triggerDirectionOf,
} from '../src/orders'
import { btc, freshQuote } from './helpers/harness'

/** 测试里数量 / 价格写成普通字符串（Decimal 是 branded string，运行时就是字符串）。 */
type LooseTpSlLeg = { triggerPrice: string; price?: string }
type LooseIntent = Partial<Omit<OrderIntent, 'size' | 'price' | 'notional' | 'triggerPrice' | 'tpsl' | 'trailing'>> &
  Pick<OrderIntent, 'side' | 'type'> & {
    size?: string
    price?: string
    notional?: string
    triggerPrice?: string
    tpsl?: { stopLoss?: LooseTpSlLeg; takeProfit?: LooseTpSlLeg; grouping: 'order' | 'position' }
    trailing?: { callbackRatio: string; activationPrice?: string; activationRatio?: string }
  }

const intent = (over: LooseIntent): OrderIntent => ({
  accountId: 'acc_bybit_1',
  instrumentId: 'bybit:BTCUSDT',
  ...over,
} as unknown as OrderIntent)

const ref = freshQuote()

const build = (over: LooseIntent, opts: Parameters<typeof buildOrderParams>[2] = {}): Record<string, unknown> =>
  buildOrderParams(intent(over), btc(), opts).body

const problemOf = (fn: () => unknown): { code: number; name: string; message: string } => {
  try {
    fn()
  } catch (e) {
    if (e instanceof OrderBuildError) return e.problem as { code: number; name: string; message: string }
    throw e
  }
  throw new Error('expected OrderBuildError')
}

describe('限价单', () => {
  it('limit 买单的请求体字段与顺序（category / symbol / side / orderType / qty / price / timeInForce / positionIdx / orderLinkId）', () => {
    const body = build({ side: 'buy', type: 'limit', size: '0.1', price: '100.1', clientOrderId: 'gt-abc' })
    expect(Object.keys(body)).toEqual([
      'category', 'symbol', 'side', 'orderType', 'qty', 'price', 'timeInForce', 'positionIdx', 'orderLinkId',
    ])
    expect(body).toMatchObject({
      category: 'linear', symbol: 'BTCUSDT', side: 'Buy', orderType: 'Limit', qty: '0.1',
      price: '100.1', timeInForce: 'GTC', positionIdx: 0, orderLinkId: 'gt-abc',
    })
  })

  it('limit 卖单 side 发 Sell（不是 sell）', () => {
    expect(build({ side: 'sell', type: 'limit', size: '0.1', price: '100.1' }).side).toBe('Sell')
  })

  it('tif ioc / fok 原样映射', () => {
    expect(build({ side: 'buy', type: 'limit', size: '0.1', price: '100.1', tif: 'ioc' }).timeInForce).toBe('IOC')
    expect(build({ side: 'buy', type: 'limit', size: '0.1', price: '100.1', tif: 'fok' }).timeInForce).toBe('FOK')
  })

  it('tif alo → PostOnly', () => {
    expect(build({ side: 'buy', type: 'limit', size: '0.1', price: '100.1', tif: 'alo' }).timeInForce).toBe('PostOnly')
  })

  it('postOnly: true → PostOnly（tif gtc 也允许）', () => {
    expect(build({ side: 'buy', type: 'limit', size: '0.1', price: '100.1', postOnly: true }).timeInForce).toBe('PostOnly')
  })

  it('postOnly + tif ioc → 1004', () => {
    expect(problemOf(() => build({ side: 'buy', type: 'limit', size: '0.1', price: '100.1', postOnly: true, tif: 'ioc' })).code).toBe(1004)
  })

  it('limit 缺 price → INVALID_PARAMS（-32602）', () => {
    expect(problemOf(() => build({ side: 'buy', type: 'limit', size: '0.1' })).name).toBe('INVALID_PARAMS')
  })

  it('limit 带 triggerPrice → INVALID_PARAMS（普通单不接受触发价）', () => {
    expect(problemOf(() => build({ side: 'buy', type: 'limit', size: '0.1', price: '100.1', triggerPrice: '99' })).name).toBe('INVALID_PARAMS')
  })

  it('价格不是 tick 的整数倍（reject）→ 1002 PRECISION', () => {
    const p = problemOf(() => build({ side: 'buy', type: 'limit', size: '0.1', price: '100.15' }))
    expect(p.code).toBe(1002)
    expect(p.message).toContain('tick size')
  })

  it('passive：买单向下贴 tick（100.15 → 100.1）', () => {
    const built = buildOrderParams(intent({ side: 'buy', type: 'limit', size: '0.1', price: '100.15', rounding: 'passive' }), btc())
    expect(built.body.price).toBe('100.1')
    expect(built.rounded).toEqual([{ field: 'price', from: '100.15', to: '100.1' }])
  })

  it('passive：卖单向上贴 tick（100.15 → 100.2）', () => {
    const built = buildOrderParams(intent({ side: 'sell', type: 'limit', size: '0.1', price: '100.15', rounding: 'passive' }), btc())
    expect(built.body.price).toBe('100.2')
  })
})

describe('市价意图 = 价带限价 + IOC', () => {
  it('缺 maxSlippageBps → INVALID_PARAMS（不隐式给滑点）', () => {
    const p = problemOf(() => build({ side: 'buy', type: 'market', size: '0.1' }, { ref }))
    expect(p.name).toBe('INVALID_PARAMS')
    expect(p.message).toContain('maxSlippageBps')
  })

  it('maxSlippageBps 非正 → INVALID_PARAMS', () => {
    expect(problemOf(() => build({ side: 'buy', type: 'market', size: '0.1', maxSlippageBps: 0 }, { ref })).name).toBe('INVALID_PARAMS')
  })

  it('买单 50 bps：orderType = Limit + IOC + 参考价上浮后贴 tick（100.1×1.005=100.6005 → 100.6）', () => {
    const body = build({ side: 'buy', type: 'market', size: '0.1', maxSlippageBps: 50 }, { ref })
    expect(body.orderType).toBe('Limit')
    expect(body.timeInForce).toBe('IOC')
    expect(body.price).toBe('100.6')
  })

  it('卖单 50 bps：参考价下浮后向上贴 tick（100.1×0.995=99.5995 → 99.6）', () => {
    const body = build({ side: 'sell', type: 'market', size: '0.1', maxSlippageBps: 50 }, { ref })
    expect(body.orderType).toBe('Limit')
    expect(body.timeInForce).toBe('IOC')
    expect(body.price).toBe('99.6')
  })

  it('价带只收紧不放宽（clampLimitPrice 把越界价拉回参考价带内）', () => {
    // 参考价 100.1、带宽 10 bps 时，上游给的 100.15 会被夹回 100.2001 以内；这里断言不超过 ref×(1+bps)
    const body = build({ side: 'buy', type: 'market', size: '0.1', maxSlippageBps: 10 }, { ref })
    expect(Number(body.price)).toBeLessThanOrEqual(100.1 * (1 + 10 / 10_000))
  })

  it('没有参考价 → 2007 STALE_PRICE（不猜价）', () => {
    const p = problemOf(() => build({ side: 'buy', type: 'market', size: '0.1', maxSlippageBps: 20 }, {}))
    expect(p.code).toBe(2007)
  })

  it('参考价陈旧 → STALE_PRICE', () => {
    const p = problemOf(() => build({ side: 'buy', type: 'market', size: '0.1', maxSlippageBps: 20 }, { ref: { ...ref, stale: true } }))
    expect(p.code).toBe(2007)
  })

  it('市价意图带 tif gtc → 1004', () => {
    expect(problemOf(() => build({ side: 'buy', type: 'market', size: '0.1', maxSlippageBps: 20, tif: 'gtc' }, { ref })).code).toBe(1004)
  })

  it('市价意图 + postOnly → 1004', () => {
    expect(problemOf(() => build({ side: 'buy', type: 'market', size: '0.1', maxSlippageBps: 20, postOnly: true }, { ref })).code).toBe(1004)
  })
})

describe('触发单（StopOrder）', () => {
  it('stop_market 卖出：triggerBy=MarkPrice + triggerDirection=2 + orderType=Market（不发 orderFilter）', () => {
    const body = build({ side: 'sell', type: 'stop_market', size: '0.1', triggerPrice: '99' }, { ref })
    expect(body).toMatchObject({
      orderType: 'Market', triggerPrice: '99', triggerBy: 'MarkPrice', triggerDirection: 2,
    })
    expect('orderFilter' in body).toBe(false)
    expect(body.price).toBeUndefined()
  })

  it('take_market 卖出：triggerDirection=1（涨破触发）', () => {
    expect(build({ side: 'sell', type: 'take_market', size: '0.1', triggerPrice: '102' }, { ref }).triggerDirection).toBe(1)
  })

  it('stop_market 买入（突破入场）：triggerDirection=1，不发 orderFilter', () => {
    const body = build({ side: 'buy', type: 'stop_market', size: '0.1', triggerPrice: '102' }, { ref })
    expect(body.triggerDirection).toBe(1)
    expect('orderFilter' in body).toBe(false)
  })

  it('stop_limit 买入：orderType=Limit + price + triggerPrice + GTC', () => {
    const body = build({ side: 'buy', type: 'stop_limit', size: '0.1', price: '102.5', triggerPrice: '102' }, { ref })
    expect(body).toMatchObject({ orderType: 'Limit', price: '102.5', triggerPrice: '102', timeInForce: 'GTC' })
  })

  it('take_limit 卖出：orderType=Limit + IOC 可选', () => {
    const body = build({ side: 'sell', type: 'take_limit', size: '0.1', price: '102.5', triggerPrice: '102', tif: 'ioc' }, { ref })
    expect(body).toMatchObject({ orderType: 'Limit', timeInForce: 'IOC', triggerDirection: 1 })
  })

  it('触发单缺 triggerPrice → INVALID_PARAMS', () => {
    expect(problemOf(() => build({ side: 'sell', type: 'stop_market', size: '0.1' })).name).toBe('INVALID_PARAMS')
  })

  it('触发价站错边（卖出 stop 挂在参考价上方）→ INVALID_PARAMS', () => {
    const p = problemOf(() => build({ side: 'sell', type: 'stop_market', size: '0.1', triggerPrice: '102' }, { ref }))
    expect(p.name).toBe('INVALID_PARAMS')
    expect(p.message).toContain('fall')
  })

  it('触发价站错边（买入 stop 挂在参考价下方）→ INVALID_PARAMS', () => {
    expect(problemOf(() => build({ side: 'buy', type: 'stop_market', size: '0.1', triggerPrice: '98' }, { ref })).name).toBe('INVALID_PARAMS')
  })

  it('没有参考价时不做站边检查（只按 type + side 推方向）', () => {
    const body = build({ side: 'sell', type: 'stop_market', size: '0.1', triggerPrice: '102' }, {})
    expect(body.triggerDirection).toBe(2)
  })

  it('triggerType last → triggerBy=LastPrice', () => {
    expect(build({ side: 'sell', type: 'stop_market', size: '0.1', triggerPrice: '99', triggerType: 'last' }, { ref }).triggerBy).toBe('LastPrice')
  })

  it('triggerType index → 1004（本包只发 MarkPrice / LastPrice）', () => {
    expect(problemOf(() => build({ side: 'sell', type: 'stop_market', size: '0.1', triggerPrice: '99', triggerType: 'index' }, { ref })).code).toBe(1004)
  })

  it('触发市价单带 tif ioc → 1004（纯触发市价不接受 tif）', () => {
    expect(problemOf(() => build({ side: 'sell', type: 'stop_market', size: '0.1', triggerPrice: '99', tif: 'ioc' }, { ref })).code).toBe(1004)
  })

  it('触发市价单 + postOnly → 1004', () => {
    expect(problemOf(() => build({ side: 'sell', type: 'stop_market', size: '0.1', triggerPrice: '99', postOnly: true }, { ref })).code).toBe(1004)
  })
})

describe('数量 / 名义额 / 精度', () => {
  it('数量按 qtyStep 向零截断（0.0109 → 0.01）', () => {
    expect(build({ side: 'buy', type: 'limit', size: '0.1009', price: '100' }).qty).toBe('0.1')
  })

  it('数量低于 step → 1002', () => {
    expect(problemOf(() => build({ side: 'buy', type: 'limit', size: '0.0005', price: '100' })).code).toBe(1002)
  })

  it('数量低于 minOrderQty → 1002（ETH min 0.01，给 0.009 截断成 0）', () => {
    const eth = btc()
    const ethInst = { ...eth, instrumentId: 'bybit:ETHUSDT', symbol: 'ETHUSDT', size: { step: '0.01', decimals: 2, min: '0.02' } }
    const p = problemOf(() => buildOrderParams(intent({ instrumentId: 'bybit:ETHUSDT', side: 'buy', type: 'limit', size: '0.01', price: '2429' }), ethInst as typeof eth))
    expect(p.code).toBe(1002)
    expect(p.message).toContain('minOrderQty')
  })

  it('notional 换算成数量（100 / 100.1 → 0.999，按 step 截断）', () => {
    // 市价意图（limit + IOC）也能用名义额下单：100 / 100.1 = 0.999 币
    expect(build({ side: 'buy', type: 'market', notional: '100', maxSlippageBps: 10 }, { ref }).qty).toBe('0.999')
  })

  it('notional 没有参考价 → 2007 STALE_PRICE', () => {
    expect(problemOf(() => build({ side: 'buy', type: 'market', notional: '100', maxSlippageBps: 10 })).code).toBe(2007)
  })

  it('notional 非正 → INVALID_PARAMS', () => {
    expect(problemOf(() => build({ side: 'buy', type: 'market', notional: '0', maxSlippageBps: 10 }, { ref })).name).toBe('INVALID_PARAMS')
  })

  it('既没 size 也没 notional → INVALID_PARAMS', () => {
    expect(problemOf(() => build({ side: 'buy', type: 'limit', price: '100' })).name).toBe('INVALID_PARAMS')
  })

  it('名义额低于 minNotionalValue → 1003 MIN_NOTIONAL', () => {
    const p = problemOf(() => build({ side: 'buy', type: 'limit', size: '0.001', price: '100' }))
    expect(p.code).toBe(1003)
  })

  it('reduceOnly 豁免最小名义额', () => {
    expect(build({ side: 'sell', type: 'limit', size: '0.001', price: '100', reduceOnly: true }).qty).toBe('0.001')
  })
})

describe('持仓模式与 positionIdx', () => {
  it('oneWay：reduceOnly 发在请求体上，positionIdx = 0', () => {
    const body = build({ side: 'sell', type: 'limit', size: '0.1', price: '100', reduceOnly: true })
    expect(body.reduceOnly).toBe(true)
    expect(body.positionIdx).toBe(0)
  })

  it('oneWay 非 reduceOnly 不带 reduceOnly 字段', () => {
    expect('reduceOnly' in build({ side: 'buy', type: 'limit', size: '0.1', price: '100' })).toBe(false)
  })

  it('hedge 买单 → positionIdx 1（long 槽），不发 reduceOnly', () => {
    const body = build({ side: 'buy', type: 'limit', size: '0.1', price: '100' }, { positionMode: 'hedge' })
    expect(body.positionIdx).toBe(1)
    expect('reduceOnly' in body).toBe(false)
  })

  it('hedge 卖单 → positionIdx 2（short 槽）', () => {
    expect(build({ side: 'sell', type: 'limit', size: '0.1', price: '100' }, { positionMode: 'hedge' }).positionIdx).toBe(2)
  })

  it('hedge 平多（sell + reduceOnly）→ 仍落 long 槽 1，且发 reduceOnly', () => {
    const body = build({ side: 'sell', type: 'limit', size: '0.1', price: '100', reduceOnly: true }, { positionMode: 'hedge' })
    expect(body.positionIdx).toBe(1)
    expect(body.reduceOnly).toBe(true)
  })

  it('hedge 显式 posSide=short → 2（内核可覆盖推导）', () => {
    expect(build({ side: 'buy', type: 'limit', size: '0.1', price: '100' }, { positionMode: 'hedge', posSide: 'short' }).positionIdx).toBe(2)
  })

  it('inferPositionIdx：oneWay 恒 0；hedge 按 side / reduceOnly 分槽', () => {
    expect(inferPositionIdx('buy', false, false)).toBe(0)
    expect(inferPositionIdx('sell', true, false)).toBe(0)
    expect(inferPositionIdx('buy', false, true)).toBe(1)
    expect(inferPositionIdx('sell', false, true)).toBe(2)
    expect(inferPositionIdx('sell', true, true)).toBe(1)
    expect(inferPositionIdx('buy', true, true)).toBe(2)
  })
})

describe('orderLinkId 约束（≤ 36）', () => {
  it('newClientOrderId 是 gt + 24 hex，长度 26', () => {
    const id = newClientOrderId()
    expect(id).toMatch(/^gt[0-9a-f]{24}$/)
    expect(id.length).toBe(26)
  })

  it('sanitizeClientOrderId 去掉非法字符并截到 36', () => {
    expect(sanitizeClientOrderId('gt/a b:c#1')).toBe('gtabc1')
    expect(sanitizeClientOrderId('x'.repeat(60)).length).toBe(CLIENT_ORDER_ID_MAX)
  })

  it('sanitizeClientOrderId 全是非法字符 → INVALID_PARAMS', () => {
    expect(problemOf(() => sanitizeClientOrderId('///')).name).toBe('INVALID_PARAMS')
  })

  it('内核给的 clientOrderId 原样进 orderLinkId（只做字符集清洗）', () => {
    expect(build({ side: 'buy', type: 'limit', size: '0.1', price: '100', clientOrderId: 'gt_keep-1' }).orderLinkId).toBe('gt_keep-1')
  })

  it('超长 clientOrderId 被截断到 36（不报错）', () => {
    const body = build({ side: 'buy', type: 'limit', size: '0.1', price: '100', clientOrderId: 'a'.repeat(50) })
    expect(String(body.orderLinkId).length).toBe(36)
  })
})

describe('不支持的订单类型', () => {
  it('twap → 1004', () => {
    expect(problemOf(() => build({ side: 'buy', type: 'twap', size: '0.1', price: '100' })).code).toBe(1004)
  })

  it('trailing_stop → 1004，并指向 buildTradingStop', () => {
    const p = problemOf(() => build({ side: 'buy', type: 'trailing_stop', size: '0.1', trailing: { callbackRatio: '0.02' } }))
    expect(p.code).toBe(1004)
    expect(p.message).toContain('buildTradingStop')
  })

  it('未知标的 → 1001 INSTRUMENT_UNKNOWN', () => {
    expect(problemOf(() => buildOrderParams(intent({ side: 'buy', type: 'limit', size: '0.1', price: '100' }), undefined)).code).toBe(1001)
  })

  it('已下架标的 → 1001', () => {
    const inst = { ...btc(), status: 'delisted' as const }
    expect(problemOf(() => buildOrderParams(intent({ side: 'buy', type: 'limit', size: '0.1', price: '100' }), inst)).code).toBe(1001)
  })
})

describe('触发方向推导', () => {
  it('stop_*：卖出 2（跌破）/ 买入 1（涨破）', () => {
    expect(triggerDirectionOf('stop_market', 'sell')).toBe(2)
    expect(triggerDirectionOf('stop_limit', 'buy')).toBe(1)
  })

  it('take_*：卖出 1（涨破）/ 买入 2（跌破）', () => {
    expect(triggerDirectionOf('take_market', 'sell')).toBe(1)
    expect(triggerDirectionOf('take_limit', 'buy')).toBe(2)
  })
})

describe('成交后补挂的保护腿（QD native_protection bybit 段）', () => {
  const parent = intent({
    side: 'buy', type: 'limit', size: '0.1', price: '100', clientOrderId: 'gt-parent',
    tpsl: { stopLoss: { triggerPrice: '95' }, takeProfit: { triggerPrice: '110' }, grouping: 'order' },
  })

  it('SL / TP 都是 reduceOnly + closeOnTrigger 的市价触发单（不发 orderFilter）', () => {
    const legs = buildProtectionOrders(parent, asDecimal('0.01'), btc())
    expect(legs.stopLoss?.body).toMatchObject({
      category: 'linear', symbol: 'BTCUSDT', side: 'Sell', orderType: 'Market', qty: '0.01',
      triggerPrice: '95', triggerBy: 'MarkPrice', triggerDirection: 2,
      reduceOnly: true, closeOnTrigger: true, positionIdx: 0,
    })
    expect('orderFilter' in legs.stopLoss!.body).toBe(false)
    expect(legs.takeProfit?.body).toMatchObject({ triggerPrice: '110', triggerDirection: 1, reduceOnly: true })
  })

  it('orderLinkId = 父单号 + -sl / -tp', () => {
    const legs = buildProtectionOrders(parent, asDecimal('0.01'), btc())
    expect(legs.stopLoss?.clientOrderId).toBe('gt-parent-sl')
    expect(legs.takeProfit?.clientOrderId).toBe('gt-parent-tp')
  })

  it('父单号 36 字符时保护腿仍 ≤ 36（截断而不是越界）', () => {
    const long = intent({
      side: 'buy', type: 'limit', size: '0.1', price: '100', clientOrderId: 'p'.repeat(36),
      tpsl: { stopLoss: { triggerPrice: '95' }, grouping: 'order' },
    })
    const legs = buildProtectionOrders(long, asDecimal('0.01'), btc())
    expect(legs.stopLoss!.clientOrderId.length).toBeLessThanOrEqual(36)
    expect(legs.stopLoss!.clientOrderId.endsWith('-sl')).toBe(true)
  })

  it('legSeq 给同一父单的多组保护腿换号（-sl1 / -sl2），都不越 36 字符', () => {
    const long = intent({
      side: 'buy', type: 'limit', size: '0.1', price: '100', clientOrderId: 'aaaabbbbccccddddeeeeffff00001111',
      tpsl: { stopLoss: { triggerPrice: '95' }, grouping: 'order' },
    })
    const first = buildProtectionOrders(long, asDecimal('0.01'), btc(), { legSeq: 1 }).stopLoss!
    const second = buildProtectionOrders(long, asDecimal('0.01'), btc(), { legSeq: 2 }).stopLoss!
    expect(first.clientOrderId).not.toBe(second.clientOrderId)
    expect(first.clientOrderId.length).toBeLessThanOrEqual(36)
    expect(second.clientOrderId.length).toBeLessThanOrEqual(36)
    expect(first.clientOrderId.endsWith('-sl1')).toBe(true)
    expect(second.clientOrderId.endsWith('-sl2')).toBe(true)
    expect(buildProtectionOrders(long, asDecimal('0.01'), btc()).stopLoss!.clientOrderId).toBe('aaaabbbbccccddddeeeeffff00001111-sl')
  })

  it('legSeq 非非负整数 → INVALID_PARAMS', () => {
    expect(problemOf(() => buildProtectionOrders(parent, asDecimal('0.01'), btc(), { legSeq: -1 })).name).toBe('INVALID_PARAMS')
    expect(problemOf(() => buildProtectionOrders(parent, asDecimal('0.01'), btc(), { legSeq: 1.5 })).name).toBe('INVALID_PARAMS')
  })

  it('平仓方向 = 父单反向（买入开仓 → 卖出保护）', () => {
    const short = intent({
      side: 'sell', type: 'limit', size: '0.1', price: '100',
      tpsl: { takeProfit: { triggerPrice: '90' }, grouping: 'order' },
    })
    expect(buildProtectionOrders(short, asDecimal('0.01'), btc()).takeProfit?.body.side).toBe('Buy')
  })

  it('给了 price 的保护腿发 Limit 触发单（GTC）', () => {
    const withLimit = intent({
      side: 'buy', type: 'limit', size: '0.1', price: '100',
      tpsl: { stopLoss: { triggerPrice: '95', price: '94.5' }, grouping: 'order' },
    })
    expect(buildProtectionOrders(withLimit, asDecimal('0.01'), btc()).stopLoss?.body).toMatchObject({
      orderType: 'Limit', price: '94.5', timeInForce: 'GTC', triggerPrice: '95',
    })
  })

  it('数量 = 本次成交数量（按 step 截断）', () => {
    expect(buildProtectionOrders(parent, asDecimal('0.0109'), btc()).stopLoss?.body.qty).toBe('0.01')
  })

  it('成交数量低于 step → 1002', () => {
    expect(problemOf(() => buildProtectionOrders(parent, asDecimal('0.0001'), btc())).code).toBe(1002)
  })

  it('没有 tpsl → INVALID_PARAMS', () => {
    const bare = intent({ side: 'buy', type: 'limit', size: '0.1', price: '100' })
    expect(problemOf(() => buildProtectionOrders(bare, asDecimal('0.01'), btc())).name).toBe('INVALID_PARAMS')
  })

  it('tpsl 里两条腿都空 → INVALID_PARAMS', () => {
    const empty = intent({ side: 'buy', type: 'limit', size: '0.1', price: '100', tpsl: { grouping: 'order' } })
    expect(problemOf(() => buildProtectionOrders(empty, asDecimal('0.01'), btc())).name).toBe('INVALID_PARAMS')
  })

  it('hedge 模式下保护腿落在父单的持仓槽（买开 → 1）', () => {
    const legs = buildProtectionOrders(parent, asDecimal('0.01'), btc(), { positionMode: 'hedge' })
    expect(legs.stopLoss?.body.positionIdx).toBe(1)
  })

  it('未知标的 → 1001', () => {
    expect(problemOf(() => buildProtectionOrders(parent, asDecimal('0.01'), undefined)).code).toBe(1001)
  })
})

describe('持仓级 TP / SL / 追踪（trading-stop）', () => {
  it('全字段请求体（symbol 大写、tpslMode 缺省 Full、triggerBy 缺省 MarkPrice）', () => {
    expect(buildTradingStop({
      symbol: 'btcusdt', stopLoss: '95000', takeProfit: '110000', trailingStop: '1500', activePrice: '100000', positionIdx: 0,
    })).toEqual({
      category: 'linear', symbol: 'BTCUSDT', tpslMode: 'Full', positionIdx: 0,
      takeProfit: '110000', stopLoss: '95000', trailingStop: '1500', activePrice: '100000',
      tpTriggerBy: 'MarkPrice', slTriggerBy: 'MarkPrice',
    })
  })

  it('只给 trailingStop 也成立（追踪单只能走这条路，positionIdx 缺省 0）', () => {
    const body = buildTradingStop({ symbol: 'BTCUSDT', trailingStop: '800' })
    expect(body.trailingStop).toBe('800')
    expect(body.positionIdx).toBe(0)
  })

  it('三个价格都没给 → INVALID_PARAMS', () => {
    expect(problemOf(() => buildTradingStop({ symbol: 'BTCUSDT' })).name).toBe('INVALID_PARAMS')
  })

  it('价格非法（0 / 负数）→ INVALID_PARAMS', () => {
    expect(problemOf(() => buildTradingStop({ symbol: 'BTCUSDT', stopLoss: '0' })).name).toBe('INVALID_PARAMS')
  })

  it('tpslMode 可显式给 Partial（按持仓部分平仓）', () => {
    expect(buildTradingStop({ symbol: 'BTCUSDT', stopLoss: '1', tpslMode: 'Partial' }).tpslMode).toBe('Partial')
  })

  it('triggerBy 可切换 LastPrice（同时作用于 TP 与 SL）', () => {
    const body = buildTradingStop({ symbol: 'BTCUSDT', stopLoss: '1', triggerBy: 'LastPrice' })
    expect(body.tpTriggerBy).toBe('LastPrice')
    expect(body.slTriggerBy).toBe('LastPrice')
  })
})
