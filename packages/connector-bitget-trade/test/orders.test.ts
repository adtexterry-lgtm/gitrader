// SPDX-License-Identifier: CPAL-1.0
// OrderIntent → 线上请求体：市价模拟（价带限价 + ioc）、force 映射、数量规整、持仓字段、计划委托。
import { describe, expect, it } from 'vitest'
import type { OrderIntent } from '@gitrader/protocol'
import {
  OrderBuildError, buildOrder, forceOf, newClientOrderId, normalizeMarginMode, positionFields, sanitizeClientOid,
} from '../src/orders'
import type { BuildOptions, PriceRef } from '../src/orders'
import { parseInstrumentRecords } from '../src/parse'
import type { InstrumentRecord } from '../src/parse'
import { NOW, contractRow } from './helpers/fake-bitget'

const records = parseInstrumentRecords([contractRow(), contractRow({ symbol: 'OLDUSDT', symbolStatus: 'offline' })], NOW)
const btc = records.find((r) => r.symbol === 'BTCUSDT') as InstrumentRecord
const ref: PriceRef = { bid: 100.1, ask: 100.2, mid: 100.15 }

/** 测试里用宽松字面量构造意图（Decimal 是品牌类型，测试不逐个 asDecimal）。 */
type LooseIntent = Record<string, unknown>
function intent(over: LooseIntent = {}): OrderIntent {
  // 缺省 size / price 组合的名义额 = 0.1 × 60000 = 6000 USDT（高于 minTradeUSDT 5）
  return { accountId: 'acct_t', instrumentId: 'bitget:BTCUSDT', side: 'buy', type: 'limit', size: '0.1', price: '60000', ...over } as unknown as OrderIntent
}

function buildError(fn: () => unknown): { code: number; name: string; message: string } {
  try {
    fn()
  } catch (e) {
    if (e instanceof OrderBuildError) return e.problem
    throw e
  }
  throw new Error('expected OrderBuildError')
}

describe('夹具与记录', () => {
  it('合约记录带 tick / step / minSize / maxLeverage', () => {
    expect(btc.tick).toBe('0.1')
    expect(btc.step).toBe('0.001')
    expect(btc.minSize).toBe('0.001')
    expect(btc.minNotional).toBe('5')
    expect(btc.maxLeverage).toBe(125)
  })
  it('标的层面声明了可下单类型（数据包本身是空数组）', () => {
    expect(btc.instrument.orderTypes).toContain('limit')
    expect(btc.instrument.orderTypes).toContain('trailing_stop')
    expect(btc.instrument.triggerPriceTypes).toEqual(['mark'])
  })
})

describe('市价 = 价带限价 + ioc（教训 4）', () => {
  it('缺 maxSlippageBps → INVALID_PARAMS', () => {
    const p = buildError(() => buildOrder(intent({ type: 'market', price: undefined }), btc, ref))
    expect(p.code).toBe(-32602)
    expect(p.message).toContain('maxSlippageBps')
  })
  it('没有报价参考 → STALE_PRICE', () => {
    const p = buildError(() => buildOrder(intent({ type: 'market', price: undefined, maxSlippageBps: 50 }), btc, {}))
    expect(p.code).toBe(2007)
  })
  it('报价陈旧 → STALE_PRICE', () => {
    const p = buildError(() => buildOrder(intent({ type: 'market', price: undefined, maxSlippageBps: 50 }), btc, { ...ref, stale: true }))
    expect(p.code).toBe(2007)
  })
  it('买单：mid × (1 + bps) 后向下贴 tick，force = ioc，orderType = limit', () => {
    const built = buildOrder(intent({ type: 'market', price: undefined, maxSlippageBps: 50 }), btc, ref)
    // 100.15 × 1.005 = 100.65075 → 向下到 0.1 刻度 = 100.6
    expect(built.body['price']).toBe('100.6')
    expect(built.body['force']).toBe('ioc')
    expect(built.body['orderType']).toBe('limit')
    expect(built.endpoint).toBe('order')
  })
  it('卖单：mid × (1 − bps) 后向上贴 tick', () => {
    const built = buildOrder(intent({ type: 'market', side: 'sell', price: undefined, maxSlippageBps: 50 }), btc, ref)
    // 100.15 × 0.995 = 99.64925 → 向上 = 99.7
    expect(built.body['price']).toBe('99.7')
    expect(built.body['force']).toBe('ioc')
  })
  it('没给 mid 时用 bid / ask 的平均', () => {
    const built = buildOrder(intent({ type: 'market', price: undefined, maxSlippageBps: 0.0001 }), btc, { bid: 100.1, ask: 100.2 })
    expect(built.body['price']).toBe('100.1')
  })
  it('市价请求体里没有触发字段', () => {
    const built = buildOrder(intent({ type: 'market', price: undefined, maxSlippageBps: 10 }), btc, ref)
    expect(built.body['triggerPrice']).toBeUndefined()
    expect(built.body['planType']).toBeUndefined()
    expect(built.body['executePrice']).toBeUndefined()
  })
})

describe('限价', () => {
  it('缺 price → INVALID_PARAMS', () => {
    expect(buildError(() => buildOrder(intent({ price: undefined }), btc, ref)).code).toBe(-32602)
  })
  it('price 正好在 tick 上 → 原样', () => {
    expect(buildOrder(intent({ price: '99000.1' }), btc, ref).body['price']).toBe('99000.1')
  })
  it('price 不在 tick 上且 rounding=reject → PRECISION', () => {
    const p = buildError(() => buildOrder(intent({ price: '99000.15' }), btc, ref))
    expect(p.code).toBe(1002)
    expect(p.message).toContain('tick 0.1')
  })
  it('rounding=passive 买单向下贴 tick，并记录 rounded', () => {
    const built = buildOrder(intent({ price: '99000.15', rounding: 'passive' }), btc, ref)
    expect(built.body['price']).toBe('99000.1')
    expect(built.rounded).toEqual([{ field: 'price', from: '99000.15', to: '99000.1' }])
  })
  it('rounding=passive 卖单向上贴 tick', () => {
    const built = buildOrder(intent({ side: 'sell', price: '99000.15', rounding: 'passive' }), btc, ref)
    expect(built.body['price']).toBe('99000.2')
  })
  it('price 为 0 / 负数 → INVALID_PARAMS', () => {
    expect(buildError(() => buildOrder(intent({ price: '0' }), btc, ref)).code).toBe(-32602)
  })
  it('非数字 price → INVALID_PARAMS', () => {
    expect(buildError(() => buildOrder(intent({ price: 'abc' }), btc, ref)).code).toBe(-32602)
  })
  it('市价 maxSlippageBps 为 NaN / 0 / 负数 → INVALID_PARAMS（不让 BigInt 抛 RangeError）', () => {
    for (const bps of [Number.NaN, 0, -5]) {
      const p = buildError(() => buildOrder(intent({ type: 'market', price: undefined, maxSlippageBps: bps }), btc, ref))
      expect(p.code).toBe(-32602)
      expect(p.message).toContain('maxSlippageBps')
    }
  })
  it('参考价太旧（ageMs 超阈值）→ STALE_PRICE', () => {
    const p = buildError(() => buildOrder(intent({ type: 'market', price: undefined, maxSlippageBps: 50 }), btc, { ...ref, ageMs: 6_000 }))
    expect(p.code).toBe(2007)
    expect(p.message).toContain('6000 ms')
  })
  it('refPriceMaxAgeMs 调大后同样的年龄能过', () => {
    const built = buildOrder(intent({ type: 'market', price: undefined, maxSlippageBps: 50 }), btc, { ...ref, ageMs: 6_000 }, { refPriceMaxAgeMs: 10_000 })
    expect(built.body['force']).toBe('ioc')
  })
  it('请求体必带 symbol / productType / marginCoin / marginMode', () => {
    const body = buildOrder(intent(), btc, ref).body
    expect(body['symbol']).toBe('BTCUSDT')
    expect(body['productType']).toBe('USDT-FUTURES')
    expect(body['marginCoin']).toBe('USDT')
    expect(body['marginMode']).toBe('crossed')
  })
  it('isolated 的 intent → marginMode isolated', () => {
    expect(buildOrder(intent({ marginMode: 'isolated' }), btc, ref).body['marginMode']).toBe('isolated')
  })
  it('marginMode 归一（cross → crossed；空 → crossed）', () => {
    expect(normalizeMarginMode('cross')).toBe('crossed')
    expect(normalizeMarginMode('crossed')).toBe('crossed')
    expect(normalizeMarginMode('isolated')).toBe('isolated')
    expect(normalizeMarginMode('ISO')).toBe('isolated')
    expect(normalizeMarginMode(undefined)).toBe('crossed')
    expect(normalizeMarginMode('weird')).toBe('crossed')
  })
})

describe('force（时效）映射', () => {
  it('postOnly → post_only', () => expect(forceOf(intent({ postOnly: true }))).toBe('post_only'))
  it('tif alo → post_only（协议没有 post_only 枚举）', () => expect(forceOf(intent({ tif: 'alo' }))).toBe('post_only'))
  it('tif ioc → ioc', () => expect(forceOf(intent({ tif: 'ioc' }))).toBe('ioc'))
  it('tif fok → fok', () => expect(forceOf(intent({ tif: 'fok' }))).toBe('fok'))
  it('缺省 → gtc', () => expect(forceOf(intent())).toBe('gtc'))
  it('postOnly 与 tif ioc 同时给 → post_only 优先', () => expect(forceOf(intent({ postOnly: true, tif: 'ioc' }))).toBe('post_only'))
  it('gtd 不在支持列表里 → 按 gtc 发（不静默改成 ioc）', () => expect(forceOf(intent({ tif: 'gtd' }))).toBe('gtc'))
  it('请求体里的 force 与 forceOf 一致', () => {
    expect(buildOrder(intent({ postOnly: true }), btc, ref).body['force']).toBe('post_only')
  })
})

describe('数量规整', () => {
  it('向零截断到 step（0.0109 → 0.01）', () => {
    expect(buildOrder(intent({ size: '0.0109' }), btc, ref).body['size']).toBe('0.01')
  })
  it('小于 step → PRECISION', () => {
    const p = buildError(() => buildOrder(intent({ size: '0.0009' }), btc, ref))
    expect(p.code).toBe(1002)
    expect(p.message).toContain('lot step')
  })
  it('小于 minSize → PRECISION', () => {
    const record: InstrumentRecord = { ...btc, minSize: '0.5' } as unknown as InstrumentRecord
    const p = buildError(() => buildOrder(intent({ size: '0.4' }), record, ref))
    expect(p.code).toBe(1002)
    expect(p.message).toContain('minimum')
  })
  it('只给 notional 时按 mid 折算数量', () => {
    // 10 / 100.15 = 0.099850... → 截断到 0.001 = 0.099
    const built = buildOrder(intent({ size: undefined, notional: '10' }), btc, ref)
    expect(built.body['size']).toBe('0.099')
  })
  it('触发单的 notional 用触发价折算（没有限价也能定数量）', () => {
    // 20 / 60000 = 0.000333… → 截断到 0.001 = 0（不足一个 step）
    const p = buildError(() => buildOrder(intent({ type: 'stop_market', size: undefined, notional: '20', price: undefined, triggerPrice: '60000' }), btc, {}))
    expect(p.code).toBe(1002)
    // 600 / 60000 = 0.01
    const built = buildOrder(intent({ type: 'stop_market', size: undefined, notional: '600', price: undefined, triggerPrice: '60000' }), btc, {})
    expect(built.body['size']).toBe('0.01')
  })
  it('size 与 notional 都不给 → INVALID_PARAMS', () => {
    expect(buildError(() => buildOrder(intent({ size: undefined }), btc, ref)).code).toBe(-32602)
  })
  it('负 size → INVALID_PARAMS', () => {
    expect(buildError(() => buildOrder(intent({ size: '-1' }), btc, ref)).code).toBe(-32602)
  })
  it('名义额低于 minTradeUSDT → MIN_NOTIONAL', () => {
    // 0.001 × 100 = 0.1 < 5
    const p = buildError(() => buildOrder(intent({ size: '0.001', price: '100' }), btc, ref))
    expect(p.code).toBe(1003)
  })
  it('reduceOnly 豁免名义额下限', () => {
    const built = buildOrder(intent({ size: '0.001', price: '100', reduceOnly: true }), btc, ref)
    expect(built.body['size']).toBe('0.001')
  })
})

describe('持仓字段（oneWay / hedge）', () => {
  it('oneWay 买：side=buy + reduceOnly=NO，且不发 tradeSide', () => {
    const body = buildOrder(intent(), btc, ref).body
    expect(body['side']).toBe('buy')
    expect(body['reduceOnly']).toBe('NO')
    expect(body['tradeSide']).toBeUndefined()
  })
  it('oneWay reduceOnly：reduceOnly=YES', () => {
    expect(buildOrder(intent({ reduceOnly: true }), btc, ref).body['reduceOnly']).toBe('YES')
  })
  it('hedge 开多：tradeSide=open + side=buy', () => {
    const opts: BuildOptions = { posMode: 'hedge', holdSide: 'long' }
    const body = buildOrder(intent(), btc, ref, opts).body
    expect(body['tradeSide']).toBe('open')
    expect(body['side']).toBe('buy')
    expect(body['reduceOnly']).toBeUndefined()
  })
  it('hedge 平多：tradeSide=close + side=buy（side 是持仓方向，QD bitget.py:427-440）', () => {
    const opts: BuildOptions = { posMode: 'hedge', holdSide: 'long' }
    const body = buildOrder(intent({ side: 'sell', reduceOnly: true }), btc, ref, opts).body
    expect(body['tradeSide']).toBe('close')
    expect(body['side']).toBe('buy')
  })
  it('hedge 平空：tradeSide=close + side=sell', () => {
    const opts: BuildOptions = { posMode: 'hedge', holdSide: 'short' }
    const body = buildOrder(intent({ side: 'buy', reduceOnly: true }), btc, ref, opts).body
    expect(body['tradeSide']).toBe('close')
    expect(body['side']).toBe('sell')
  })
  it('positionFields 无 holdSide 时按 reduceOnly 反推方向', () => {
    expect(positionFields('buy', true, { posMode: 'hedge' })).toEqual({ tradeSide: 'close', side: 'sell' })
    expect(positionFields('sell', true, { posMode: 'hedge' })).toEqual({ tradeSide: 'close', side: 'buy' })
  })
  it('positionFields oneWay 只给 side + reduceOnly', () => {
    expect(positionFields('sell', false)).toEqual({ side: 'sell', reduceOnly: 'NO' })
  })
})

describe('计划委托（触发 / 追踪）', () => {
  it('stop_market → place-plan-order，planType=normal_plan，mark_price，orderType=market', () => {
    const built = buildOrder(intent({ type: 'stop_market', price: undefined, triggerPrice: '90000' }), btc, ref)
    expect(built.endpoint).toBe('plan')
    expect(built.body['planType']).toBe('normal_plan')
    expect(built.body['triggerType']).toBe('mark_price')
    expect(built.body['triggerPrice']).toBe('90000')
    expect(built.body['orderType']).toBe('market')
    expect(built.body['executePrice']).toBeUndefined()
    expect(built.body['force']).toBeUndefined()
  })
  it('stop_limit → orderType=limit + price（不发 executePrice）', () => {
    const built = buildOrder(intent({ type: 'stop_limit', price: '89900.5', triggerPrice: '90000' }), btc, ref)
    expect(built.body['orderType']).toBe('limit')
    expect(built.body['price']).toBe('89900.5')
    expect(built.body['executePrice']).toBeUndefined()
    expect(built.body['planType']).toBe('normal_plan')
  })
  it('take_market → orderType=market（触发后市价成）', () => {
    const built = buildOrder(intent({ type: 'take_market', price: undefined, triggerPrice: '110000' }), btc, ref)
    expect(built.body['orderType']).toBe('market')
    expect(built.body['executePrice']).toBeUndefined()
    expect(built.endpoint).toBe('plan')
  })
  it('trailing_stop → planType=track_plan + callbackRatio（不发 rangeRate）', () => {
    const built = buildOrder(intent({ type: 'trailing_stop', price: undefined, triggerPrice: '100000', trailing: { callbackRatio: '0.02' } }), btc, ref)
    expect(built.body['planType']).toBe('track_plan')
    expect(built.body['callbackRatio']).toBe('2')
    expect(built.body['rangeRate']).toBeUndefined()
    expect(built.body['triggerPrice']).toBe('100000')
  })
  it('触发单缺 triggerPrice → INVALID_PARAMS', () => {
    expect(buildError(() => buildOrder(intent({ type: 'stop_market', price: undefined }), btc, ref)).code).toBe(-32602)
  })
  it('追踪单缺 trailing → INVALID_PARAMS', () => {
    const p = buildError(() => buildOrder(intent({ type: 'trailing_stop', price: undefined, triggerPrice: '100000' }), btc, ref))
    expect(p.code).toBe(-32602)
    expect(p.message).toContain('callbackRatio')
  })
  it('stop_limit 缺 price → INVALID_PARAMS', () => {
    expect(buildError(() => buildOrder(intent({ type: 'stop_limit', price: undefined, triggerPrice: '90000' }), btc, ref)).code).toBe(-32602)
  })
  it('触发价也走 tick 校验', () => {
    expect(buildError(() => buildOrder(intent({ type: 'stop_market', price: undefined, triggerPrice: '90000.05' }), btc, ref)).code).toBe(1002)
  })
  it('triggerType = last → ORDER_TYPE_UNSUPPORTED（只支持 mark）', () => {
    const p = buildError(() => buildOrder(intent({ type: 'stop_market', price: undefined, triggerPrice: '90000', triggerType: 'last' }), btc, ref))
    expect(p.code).toBe(1004)
  })
})

describe('不支持的类型 / 标的', () => {
  it('带 tpsl 的意图 → 1004（父单 + 保护单分两步）', () => {
    const p = buildError(() => buildOrder(intent({ tpsl: { stopLoss: { triggerPrice: '90000' }, grouping: 'position' } }), btc, ref))
    expect(p.code).toBe(1004)
    expect(p.message).toContain('buildProtectionOrders')
  })
  it('twap → 1004', () => {
    expect(buildError(() => buildOrder(intent({ type: 'twap' }), btc, ref)).code).toBe(1004)
  })
  it('未知标的 → 1001', () => {
    expect(buildError(() => buildOrder(intent({ instrumentId: 'bitget:NOPE' }), undefined, ref)).code).toBe(1001)
  })
  it('已下架标的 → 1001', () => {
    const old = records.find((r) => r.symbol === 'OLDUSDT')
    expect(buildError(() => buildOrder(intent({ instrumentId: 'bitget:OLDUSDT' }), old, ref)).code).toBe(1001)
  })
})

describe('clientOid', () => {
  it('剔除非法字符', () => expect(sanitizeClientOid('gt-a_b.c/1')).toBe('gtabc1'))
  it('截到 64 位', () => expect(sanitizeClientOid('a'.repeat(80)).length).toBe(64))
  it('全非法字符时生成前缀 + 随机 hex', () => {
    const id = sanitizeClientOid('---')
    expect(id.startsWith('gt')).toBe(true)
    expect(id.length).toBeLessThanOrEqual(64)
  })
  it('intent 里给 clientOrderId 时用它（清洗后）', () => {
    expect(buildOrder(intent({ clientOrderId: 'my-order_1' }), btc, ref).clientOrderId).toBe('myorder1')
  })
  it('没给时生成 32 位 hex', () => {
    expect(newClientOrderId()).toMatch(/^[0-9a-f]{32}$/)
  })
  it('请求体里的 clientOid 与返回的 clientOrderId 一致', () => {
    const built = buildOrder(intent({ clientOrderId: 'abc123' }), btc, ref)
    expect(built.body['clientOid']).toBe(built.clientOrderId)
  })
})
