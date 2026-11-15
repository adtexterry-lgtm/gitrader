// SPDX-License-Identifier: CPAL-1.0
// 下单构造（美股八条逐条）：时段、市价价带、碎股、卖空、账户限制、能力（1004）、tpsl / bracket / oto。
// 全部是纯函数断言：不发请求，只看 body 与 Problem。
import { describe, expect, it } from 'vitest'
import type { AccountId, OrderIntent } from '@gitrader/protocol'
import { parseAsset } from '../src/assets'
import type { AssetRecord } from '../src/assets'
import { OrderBuildError, buildOrder, describeBody, sessionHint } from '../src/orders'
import type { BuildContext } from '../src/orders'
import { parseCalendar, sessionStateAt } from '../src/sessions'
import { calendarRows, NOW } from './helpers/fake-alpaca'

const ACCOUNT = 'acct_alpaca_test' as AccountId
const calendar = parseCalendar(calendarRows(), 'America/New_York', NOW)
const regular = sessionStateAt(NOW, calendar)
const pre = sessionStateAt(1_792_587_600_000, calendar) // 09:00 ET
const post = sessionStateAt(1_792_614_600_000, calendar) // 16:30 ET
const saturday = sessionStateAt(1_792_850_400_000, calendar)
const earlyClosePost = sessionStateAt(1_792_690_200_000, calendar) // 10-22 13:30 ET

const asset = (over: Record<string, unknown> = {}): AssetRecord => parseAsset({
  id: 'asset-aapl', class: 'us_equity', exchange: 'NASDAQ', symbol: 'AAPL', name: 'Apple', status: 'active',
  tradable: true, marginable: true, shortable: true, borrow_status: 'easy_to_borrow', fractionable: true,
  price_increment: '0.01', min_trade_increment: '0.0001', min_order_size: '0.0001',
  margin_requirement_long: '30', margin_requirement_short: '30',
  ...over,
}, { calendar, now: NOW })

const ctx = (over: Partial<BuildContext> = {}): BuildContext => ({
  asset: asset(),
  session: regular,
  heldLongQty: '10',
  shortingEnabled: true,
  extendedHoursAllowed: false,
  ref: { bid: 189.99, ask: 190.01, mid: 190, ageMs: 100 },
  now: NOW,
  ...over,
})

/** 测试用宽松构造器（协议的数量 / 价格是品牌类型 Decimal，测试里直接写文本更清楚）。 */
const intent = (over: Record<string, unknown> = {}): OrderIntent => ({
  accountId: ACCOUNT,
  instrumentId: 'alpaca:AAPL',
  side: 'buy',
  type: 'limit',
  price: '190.00',
  size: '1',
  ...over,
} as unknown as OrderIntent)

const codeOf = (fn: () => unknown): number => {
  try {
    fn()
  } catch (e) {
    if (e instanceof OrderBuildError) return e.problem.code
    throw e
  }
  throw new Error('expected OrderBuildError')
}
const problemOf = (fn: () => unknown) => {
  try {
    fn()
  } catch (e) {
    if (e instanceof OrderBuildError) return e.problem
    throw e
  }
  throw new Error('expected OrderBuildError')
}

describe('限价单基本形状', () => {
  it('限价买单：type=limit + limit_price + gtc', () => {
    const built = buildOrder(intent(), ctx())
    expect(built.body['type']).toBe('limit')
    expect(built.body['limit_price']).toBe('190')
    expect(built.body['time_in_force']).toBe('gtc')
    expect(built.body['qty']).toBe('1')
    expect(built.orderClass).toBe('simple')
  })
  it('client_order_id 透传（协议 32 位 hex）', () => {
    const id = 'a'.repeat(32)
    expect(buildOrder(intent({ clientOrderId: id }), ctx()).body['client_order_id']).toBe(id)
  })
  it('没有 clientOrderId 时 body 里不出现该字段（不编一个空号）', () => {
    expect(buildOrder(intent(), ctx()).body['client_order_id']).toBeUndefined()
  })
  it('describeBody 键排序（日志 / 断言用）', () => {
    const text = describeBody({ b: '2', a: '1' })
    expect(text).toBe('a=1&b=2')
  })
  it('限价不在 tick 上 → 1002（不静默移动价格）', () => {
    expect(codeOf(() => buildOrder(intent({ price: '190.005' }), ctx()))).toBe(1002)
  })
  it("rounding:'passive' 时买单向下贴 tick", () => {
    const built = buildOrder(intent({ price: '190.005', rounding: 'passive' }), ctx())
    expect(built.body['limit_price']).toBe('190')
  })
  it("rounding:'passive' 时卖单向上贴 tick", () => {
    const built = buildOrder(intent({ side: 'sell', price: '190.005', rounding: 'passive' }), ctx())
    expect(built.body['limit_price']).toBe('190.01')
  })
  it('缺 price 的限价单 → INVALID_PARAMS', () => {
    expect(codeOf(() => buildOrder(intent({ price: undefined }), ctx()))).toBe(-32602)
  })
})

describe('时段（八条 #1 / #2）', () => {
  it('休市（周六）的市价意图 → INVALID_PARAMS + hint', () => {
    const problem = problemOf(() => buildOrder(intent({ type: 'market', maxSlippageBps: 20 }), ctx({ session: saturday })))
    expect(problem.code).toBe(-32602)
    expect(problem.message).toContain('market is closed')
    expect(problem.message).toContain('never queues')
  })
  it('休市时的限价意图同样拒（不挂到次日开盘）', () => {
    expect(problemOf(() => buildOrder(intent(), ctx({ session: saturday }))).message).toContain('market is closed')
  })
  it('盘前市价意图 → 拒（扩展时段不按未知价成交）', () => {
    const problem = problemOf(() => buildOrder(intent({ type: 'market', maxSlippageBps: 20 }), ctx({ session: pre, extendedHoursAllowed: true })))
    expect(problem.code).toBe(-32602)
    expect(problem.message).toContain('market intent outside regular hours')
  })
  it('盘前限价但没声明 extendedHours → 拒并提示怎么开', () => {
    const problem = problemOf(() => buildOrder(intent(), ctx({ session: pre })))
    expect(problem.message).toContain('pass extendedHours: true')
  })
  it('盘前限价且显式声明 → extended_hours=true + day', () => {
    const built = buildOrder(intent(), ctx({ session: pre, extendedHoursAllowed: true }))
    expect(built.body['extended_hours']).toBe(true)
    expect(built.body['time_in_force']).toBe('day')
    expect(built.tifForcedDay).toBe(true)
    expect(built.warnings.length).toBeGreaterThan(0)
  })
  it('盘后限价且声明 → 可发', () => {
    expect(buildOrder(intent(), ctx({ session: post, extendedHoursAllowed: true })).body['extended_hours']).toBe(true)
  })
  it('扩展时段的止损单 → 拒（Alpaca 扩展时段只收限价）', () => {
    const problem = problemOf(() => buildOrder(intent({ type: 'stop_market', price: undefined, triggerPrice: '180.00' }), ctx({ session: pre, extendedHoursAllowed: true })))
    expect(problem.message).toContain('limit orders only')
  })
  it('提前收盘后的 13:30 → 视为 post（有声明就能发限价）', () => {
    expect(buildOrder(intent(), ctx({ session: earlyClosePost, extendedHoursAllowed: true })).body['extended_hours']).toBe(true)
  })
  it('sessionHint 给出下一开盘时刻', () => {
    expect(sessionHint(pre)).toContain('next regular open')
  })
})

describe('市价走价带（八条 #3）', () => {
  it('缺 maxSlippageBps → INVALID_PARAMS', () => {
    const problem = problemOf(() => buildOrder(intent({ type: 'market', price: undefined }), ctx()))
    expect(problem.code).toBe(-32602)
    expect(problem.message).toContain('maxSlippageBps')
  })
  it('买单：ask × (1+bps) 向下贴 tick，且 tif=ioc', () => {
    const built = buildOrder(intent({ type: 'market', price: undefined, maxSlippageBps: 50 }), ctx())
    // 190.01 * 1.005 = 190.96005 → 贴 tick 向下 = 190.96
    expect(built.body['limit_price']).toBe('190.96')
    expect(built.body['type']).toBe('limit')
    expect(built.body['time_in_force']).toBe('ioc')
  })
  it('卖单：bid × (1−bps) 向上贴 tick，且 tif=ioc', () => {
    const built = buildOrder(intent({ side: 'sell', type: 'market', price: undefined, maxSlippageBps: 50 }), ctx())
    // 189.99 * 0.995 = 189.04005 → 向上贴 = 189.05
    expect(built.body['limit_price']).toBe('189.05')
    expect(built.body['time_in_force']).toBe('ioc')
  })
  it('没有参考价 → STALE_PRICE（不退回裸市价）', () => {
    const problem = problemOf(() => buildOrder(intent({ type: 'market', price: undefined, maxSlippageBps: 20 }), ctx({ ref: undefined })))
    expect(problem.code).toBe(2007)
    expect(problem.message).toContain('bare market order')
  })
  it('报价陈旧 → STALE_PRICE 可重试', () => {
    const problem = problemOf(() => buildOrder(intent({ type: 'market', price: undefined, maxSlippageBps: 20 }), ctx({ ref: { mid: 190, stale: true } })))
    expect(problem.code).toBe(2007)
    expect(problem.retryable).toBe(true)
  })
  it('报价年龄超限 → STALE_PRICE', () => {
    const problem = problemOf(() => buildOrder(intent({ type: 'market', price: undefined, maxSlippageBps: 20 }), ctx({ ref: { mid: 190, ageMs: 9_000 } })))
    expect(problem.message).toContain('9000 ms old')
  })
  it('滑点上限非法（0 / 负数）→ INVALID_PARAMS', () => {
    expect(codeOf(() => buildOrder(intent({ type: 'market', price: undefined, maxSlippageBps: 0 }), ctx()))).toBe(-32602)
  })
  it('滑点上限超 2000 bps → INVALID_PARAMS（明显的配置错）', () => {
    expect(problemOf(() => buildOrder(intent({ type: 'market', price: undefined, maxSlippageBps: 5_000 }), ctx())).message).toContain('sanity ceiling')
  })
  it('碎股的市价意图 → INVALID_PARAMS（碎股单只收 DAY，价带 IOC 发不出去）', () => {
    const problem = problemOf(() => buildOrder(intent({ type: 'market', price: undefined, maxSlippageBps: 20, size: '0.5' }), ctx()))
    expect(problem.code).toBe(-32602)
    expect(problem.message).toContain('fractional orders are DAY-only')
  })
  it('市价意图 + tpsl → INVALID_PARAMS（bracket / oto 只收 day / gtc）', () => {
    const problem = problemOf(() => buildOrder(intent({
      type: 'market', price: undefined, maxSlippageBps: 20,
      tpsl: { takeProfit: { triggerPrice: '200' }, stopLoss: { triggerPrice: '180' }, grouping: 'order' },
    }), ctx()))
    expect(problem.code).toBe(-32602)
    expect(problem.message).toContain('only accept day or gtc')
    expect(problem.message).toContain('limit entry')
  })
})

describe('碎股（八条 #4）', () => {
  it('fractionable 资产收小数股，并把 tif 改成 day', () => {
    const built = buildOrder(intent({ size: '0.5' }), ctx())
    expect(built.body['qty']).toBe('0.5')
    expect(built.body['time_in_force']).toBe('day')
    expect(built.tifForcedDay).toBe(true)
  })
  it('不可碎股资产的 0.5 股 → 1002（不取整成 1）', () => {
    const problem = problemOf(() => buildOrder(intent({ size: '0.5' }), ctx({ asset: asset({ fractionable: false }) })))
    expect(problem.code).toBe(1002)
    expect(problem.message).toContain('not a multiple of')
  })
  it('整股标的 size 1.5 → 1002（不静默截成 1）', () => {
    const problem = problemOf(() => buildOrder(intent({ size: '1.5' }), ctx({ asset: asset({ fractionable: false }) })))
    expect(problem.code).toBe(1002)
    expect(problem.message).toContain('not a multiple of')
    expect(problem.message).toContain('1')
  })
  it('碎股步长 0.0001 时 size 0.12345 → 1002（不截成 0.1234）', () => {
    const problem = problemOf(() => buildOrder(intent({ size: '0.12345' }), ctx()))
    expect(problem.code).toBe(1002)
    expect(problem.message).toContain('not a multiple of')
    expect(problem.message).toContain('0.0001')
  })
  it('不可碎股资产的 1 股照常', () => {
    expect(buildOrder(intent({ size: '1' }), ctx({ asset: asset({ fractionable: false }) })).body['qty']).toBe('1')
  })
  it('小数股 + ioc → INVALID_PARAMS（Alpaca 只接受 day）', () => {
    expect(codeOf(() => buildOrder(intent({ size: '0.5', tif: 'ioc' }), ctx()))).toBe(-32602)
  })
  it('notional 折算成股数（按参考价），且被截到资产步长', () => {
    const built = buildOrder(intent({ size: undefined, notional: '100' }), ctx())
    // 100 / 190 = 0.526315789… → 截到 0.0001 → 0.5263
    expect(built.body['qty']).toBe('0.5263')
  })
  it('数量低于资产步长 → 1002', () => {
    expect(codeOf(() => buildOrder(intent({ size: '0.00001' }), ctx()))).toBe(1002)
  })
  it('缺 size 与 notional → INVALID_PARAMS', () => {
    expect(codeOf(() => buildOrder(intent({ size: undefined }), ctx()))).toBe(-32602)
  })
  it('低于 min_order_size → 1002', () => {
    expect(codeOf(() => buildOrder(intent({ size: '0.0001' }), ctx({ asset: asset({ min_order_size: '0.01' }) })))).toBe(1002)
  })
})

describe('卖空（八条 #5）', () => {
  it('卖出不超过持仓 = 平仓，不需要 shortable', () => {
    const built = buildOrder(intent({ side: 'sell', size: '5' }), ctx({ asset: asset({ shortable: false }) }))
    expect(built.body['side']).toBe('sell')
  })
  it('卖出超过持仓且不可做空 → 3001', () => {
    const problem = problemOf(() => buildOrder(intent({ side: 'sell', size: '15' }), ctx({ asset: asset({ shortable: false }) })))
    expect(problem.code).toBe(3001)
    expect(problem.message).toContain('not shortable')
  })
  it('可做空但账户 shorting_enabled=false → 3001', () => {
    const problem = problemOf(() => buildOrder(intent({ side: 'sell', size: '15' }), ctx({ shortingEnabled: false })))
    expect(problem.message).toContain('shorting_enabled=false')
  })
  it('可做空 + borrow_status=easy_to_borrow + 账户允许 → 开空照发', () => {
    expect(buildOrder(intent({ side: 'sell', size: '15' }), ctx()).body['side']).toBe('sell')
  })
  it('shortable 但 borrow_status=hard_to_borrow → 3001（缺省不做空难借券）', () => {
    const problem = problemOf(() => buildOrder(intent({ side: 'sell', size: '15' }), ctx({ asset: asset({ borrow_status: 'hard_to_borrow' }) })))
    expect(problem.message).toContain('not easy_to_borrow')
    expect(problem.message).toContain('hard_to_borrow')
  })
  it('不易借即拒（没有放宽开关：shortable / 账户允许也不开空）', () => {
    const problem = problemOf(() => buildOrder(intent({ side: 'sell', size: '15' }), ctx({ asset: asset({ borrow_status: 'hard_to_borrow' }), shortingEnabled: true })))
    expect(problem.code).toBe(3001)
    expect(problem.message).toContain('not easy_to_borrow')
  })
  it('借券状态拿不到（borrow_status 与旧 easy_to_borrow 都缺）→ 开空 fail closed，带 hint；持仓内卖出不受影响', () => {
    const unknown = asset({ borrow_status: undefined })
    expect(unknown.borrowStatus).toBe('unknown')
    const problem = problemOf(() => buildOrder(intent({ side: 'sell', size: '15' }), ctx({ asset: unknown })))
    expect(problem.code).toBe(3001)
    expect(problem.message).toContain('borrow availability is unknown')
    expect(problem.message).toContain('sell no more than the 10 shares held')
    expect(problem.venue?.message).toBe('borrow status unavailable')
    expect(buildOrder(intent({ side: 'sell', size: '10' }), ctx({ asset: unknown })).body['qty']).toBe('10')
  })
  it('borrow_status 是不认识的值 → 按未知拒（不回落旧字段放行）', () => {
    const problem = problemOf(() => buildOrder(intent({ side: 'sell', size: '15' }), ctx({ asset: asset({ borrow_status: 'locate_required', easy_to_borrow: true }) })))
    expect(problem.message).toContain('borrow availability is unknown')
  })
  it('旧形状（只有 easy_to_borrow）仍兼容：true 放行、false 拒', () => {
    expect(buildOrder(intent({ side: 'sell', size: '15' }), ctx({ asset: asset({ borrow_status: undefined, easy_to_borrow: true }) })).body['side']).toBe('sell')
    const problem = problemOf(() => buildOrder(intent({ side: 'sell', size: '15' }), ctx({ asset: asset({ borrow_status: undefined, easy_to_borrow: false }) })))
    expect(problem.message).toContain('not easy_to_borrow')
  })
  it('持仓查不到时卖单 fail closed', () => {
    const problem = problemOf(() => buildOrder(intent({ side: 'sell', size: '5' }), ctx({ heldLongQty: null })))
    expect(problem.code).toBe(3001)
    expect(problem.message).toContain('cannot verify')
  })
  it('reduce-only 卖出超过持仓 → INVALID_PARAMS（不溢出成空头）', () => {
    const problem = problemOf(() => buildOrder(intent({ side: 'sell', size: '15', reduceOnly: true }), ctx()))
    expect(problem.code).toBe(-32602)
    expect(problem.message).toContain('reduce-only')
  })
  it('reduce-only 在持仓内正常，并留下审计告警（Alpaca 没有该字段）', () => {
    const built = buildOrder(intent({ side: 'sell', size: '5', reduceOnly: true }), ctx())
    expect(built.warnings.some((w) => w.includes('owned-share check'))).toBe(true)
  })
})

describe('不可保证金告警（margin_requirement_long 取代 maintenance_margin_requirement）', () => {
  const cashOnly = (w: string) => w.includes('is not marginable')
  it('新字段在 → 告警带 margin_requirement_long', () => {
    const built = buildOrder(intent(), ctx({ asset: asset({ marginable: false, margin_requirement_long: '100' }) }))
    expect(built.warnings.find(cashOnly)).toContain('margin_requirement_long=100')
  })
  it('只有旧字段 → 回落 maintenance_margin_requirement', () => {
    const built = buildOrder(intent(), ctx({ asset: asset({ marginable: false, margin_requirement_long: undefined, maintenance_margin_requirement: 25 }) }))
    expect(built.warnings.find(cashOnly)).toContain('maintenance_margin_requirement=25')
  })
  it('两个字段都没有 → 告警仍在，明写「不可得」（不静默消失）', () => {
    const built = buildOrder(intent(), ctx({ asset: asset({ marginable: false, margin_requirement_long: undefined, margin_requirement_short: undefined }) }))
    expect(built.warnings.find(cashOnly)).toContain('margin requirement unavailable')
  })
  it('可保证金资产不告警', () => {
    expect(buildOrder(intent(), ctx()).warnings.some(cashOnly)).toBe(false)
  })
})

describe('账户限制与能力（八条 #6 / #8）', () => {
  it('账户被冻结 → 3001，不发单', () => {
    const problem = problemOf(() => buildOrder(intent(), ctx({ accountBlocked: true })))
    expect(problem.code).toBe(3001)
    expect(problem.message).toContain('blocked')
  })
  it('标的不再可交易 → 1001', () => {
    expect(codeOf(() => buildOrder(intent(), ctx({ asset: asset({ tradable: false }) })))).toBe(1001)
  })
  it('take_market 没有对应单型 → 1004', () => {
    const problem = problemOf(() => buildOrder(intent({ type: 'take_market', price: undefined }), ctx()))
    expect(problem.code).toBe(1004)
    expect(problem.message).toContain('take-profit')
  })
  it('take_limit → 1004', () => {
    expect(codeOf(() => buildOrder(intent({ type: 'take_limit' }), ctx()))).toBe(1004)
  })
  it('twap → 1004', () => {
    expect(codeOf(() => buildOrder(intent({ type: 'twap' }), ctx()))).toBe(1004)
  })
  it('alo 时效 → 1004（Alpaca 没有 post-only）', () => {
    expect(codeOf(() => buildOrder(intent({ tif: 'alo' }), ctx()))).toBe(1004)
  })
  it('gtd 时效 → 1004', () => {
    expect(codeOf(() => buildOrder(intent({ tif: 'gtd' }), ctx()))).toBe(1004)
  })
  it('触发价类型 mark → 1004（Alpaca 按最后成交价触发）', () => {
    expect(codeOf(() => buildOrder(intent({ type: 'stop_market', price: undefined, triggerPrice: '180.00', triggerType: 'mark' }), ctx()))).toBe(1004)
  })
})

describe('止损 / 追踪', () => {
  it('stop_market → type=stop + stop_price', () => {
    const built = buildOrder(intent({ type: 'stop_market', price: undefined, triggerPrice: '180.00' }), ctx())
    expect(built.body['type']).toBe('stop')
    expect(built.body['stop_price']).toBe('180')
  })
  it('stop_limit → type=stop_limit + 两个价格', () => {
    const built = buildOrder(intent({ type: 'stop_limit', price: '179.50', triggerPrice: '180.00' }), ctx())
    expect(built.body['type']).toBe('stop_limit')
    expect(built.body['stop_price']).toBe('180')
    expect(built.body['limit_price']).toBe('179.5')
  })
  it('stop_market 缺 triggerPrice → INVALID_PARAMS', () => {
    expect(codeOf(() => buildOrder(intent({ type: 'stop_market', price: undefined }), ctx()))).toBe(-32602)
  })
  it('trailing_stop：callbackRatio 0.02 → trail_percent 2', () => {
    const built = buildOrder(intent({ type: 'trailing_stop', price: undefined, trailing: { callbackRatio: '0.02' } }), ctx())
    expect(built.body['type']).toBe('trailing_stop')
    expect(built.body['trail_percent']).toBe('2')
  })
  it('trailing_stop 带 activationPrice → INVALID_PARAMS（Alpaca 没有激活价）', () => {
    const problem = problemOf(() => buildOrder(intent({ type: 'trailing_stop', price: undefined, trailing: { callbackRatio: '0.02', activationPrice: '200' } }), ctx()))
    expect(problem.message).toContain('activation price')
  })
  it('trailing_stop 缺 trailing → INVALID_PARAMS', () => {
    expect(codeOf(() => buildOrder(intent({ type: 'trailing_stop', price: undefined }), ctx()))).toBe(-32602)
  })
})

describe('保护单（tpsl / 八条 #8 的如实声明）', () => {
  it('两条腿 → 原生 bracket', () => {
    const built = buildOrder(intent({ tpsl: { takeProfit: { triggerPrice: '200' }, stopLoss: { triggerPrice: '180' }, grouping: 'order' } }), ctx())
    expect(built.orderClass).toBe('bracket')
    expect(built.body['order_class']).toBe('bracket')
    expect(built.body['take_profit']).toEqual({ limit_price: '200' })
    expect(built.body['stop_loss']).toEqual({ stop_price: '180' })
  })
  it('只有止盈 → oto', () => {
    expect(buildOrder(intent({ tpsl: { takeProfit: { triggerPrice: '200' }, grouping: 'order' } }), ctx()).orderClass).toBe('oto')
  })
  it('止损带限价 → stop_loss 里有 stop_price 与 limit_price', () => {
    const built = buildOrder(intent({ tpsl: { stopLoss: { triggerPrice: '180', price: '179.5' }, grouping: 'order' } }), ctx())
    expect(built.body['stop_loss']).toEqual({ stop_price: '180', limit_price: '179.5' })
  })
  it('position 分组的 tpsl → 1004（要成交后用 OCO）', () => {
    const problem = problemOf(() => buildOrder(intent({ tpsl: { takeProfit: { triggerPrice: '200' }, grouping: 'position' } }), ctx()))
    expect(problem.code).toBe(1004)
    expect(problem.message).toContain('placeProtection')
  })
  it('bracket + 小数股 → 1002（Alpaca 不收）', () => {
    const problem = problemOf(() => buildOrder(intent({ size: '0.5', tpsl: { takeProfit: { triggerPrice: '200' }, stopLoss: { triggerPrice: '180' }, grouping: 'order' } }), ctx()))
    expect(problem.code).toBe(1002)
    expect(problem.message).toContain('fractional')
  })
  it('bracket + ioc → INVALID_PARAMS（只收 day / gtc）', () => {
    const problem = problemOf(() => buildOrder(intent({ tif: 'ioc', tpsl: { takeProfit: { triggerPrice: '200' }, stopLoss: { triggerPrice: '180' }, grouping: 'order' } }), ctx()))
    expect(problem.message).toContain('day or gtc')
  })
  it('扩展时段 + bracket → INVALID_PARAMS', () => {
    const problem = problemOf(() => buildOrder(
      intent({ tpsl: { takeProfit: { triggerPrice: '200' }, stopLoss: { triggerPrice: '180' }, grouping: 'order' } }),
      ctx({ session: pre, extendedHoursAllowed: true }),
    ))
    expect(problem.message).toContain('extended hours')
  })
})
