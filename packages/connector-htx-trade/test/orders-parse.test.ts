// SPDX-License-Identifier: CPAL-1.0
// 下单请求体构造 + 响应解析（纯函数，不联网）。字段名按 HTX 官方文档，不按客户端旧写法。
import { describe, expect, it } from 'vitest'
import { asDecimal } from '@gitrader/protocol'
import type { OrderIntent } from '@gitrader/protocol'
import {
  buildCancelAllBody, buildCancelBody, buildLeverBody, buildOrderBody, buildOrderQueryParams, buildTpslBody,
  numericClientOrderId, OrderBuildError, positionSideOf, tpslSideOk,
} from '../src/orders'
import type { BuildOptions } from '../src/orders'
import {
  absDecimal, baseSizeOf, decimalOf, fillDedupeKey, firstOrderRow, instrumentIdOf, isClosingTrade, num, orderStatusOf,
  parseAccountSnapshot, parseOpenOrder, parseOrderStatusResult, parsePosition, parsePositions, parseTrade, parseTrades,
  symbolOf,
} from '../src/parse'
import { parseContract } from '../src/market'
import { baseToContracts, contractsToBase, isMultipleOf, snapToTick, truncateToStep } from '../src/precision'
import { btc, contractSizeOf, freshQuote, instruments } from './helpers/harness'
import { NOW } from './helpers/fake-htx'

/** 一张 BTC-USDT 的面值（币）：0.001。 */
const FACE = '0.001'

const intent = (over: Partial<OrderIntent> = {}): OrderIntent => ({
  accountId: 'acct_htx_1',
  instrumentId: 'htx:BTC-USDT',
  side: 'buy',
  type: 'limit',
  size: asDecimal('0.01'),
  price: asDecimal('100'),
  ...over,
})

const build = (over: Partial<OrderIntent> = {}, opts: BuildOptions = {}) => buildOrderBody(intent(over), btc(), { faceValue: FACE, ...opts })

describe('下单请求体（v5）', () => {
  it('限价买入：contract_code / volume(字符串张) / side / type=limit / margin_mode / position_side / price / time_in_force', () => {
    const built = build({}, { family: 'v5' })
    expect(built.body).toMatchObject({
      contract_code: 'BTC-USDT',
      volume: '10',
      side: 'buy',
      type: 'limit',
      time_in_force: 'gtc',
      margin_mode: 'cross',
      position_side: 'both',
      price: '100',
    })
    expect(String(built.body.client_order_id)).toMatch(/^\d+$/)
  })

  it('0.01 BTC 按 0.001 的面值换成 10 张（v5 volume 是 String）', () => {
    expect(build({ size: asDecimal('0.01') }).volume).toBe(10)
    expect(build({ size: asDecimal('0.01') }).body.volume).toBe('10')
  })

  it('不足一张：1002 PRECISION', () => {
    expect(() => build({ size: asDecimal('0.0005') })).toThrow(OrderBuildError)
    try {
      build({ size: asDecimal('0.0005') })
    } catch (e) {
      expect((e as OrderBuildError).problem.name).toBe('PRECISION')
    }
  })

  it('数量不是面值整数倍且 rounding=reject（缺省）→ 1002，消息写面值', () => {
    try {
      build({ size: asDecimal('0.0109') })
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as OrderBuildError).problem.name).toBe('PRECISION')
      expect((e as OrderBuildError).problem.message).toContain('0.001')
    }
  })

  it('rounding=passive：币数量向下截到整张（0.0109 → 10 张）', () => {
    const built = build({ size: asDecimal('0.0109'), rounding: 'passive' })
    expect(built.volume).toBe(10)
    expect(built.rounded).toEqual([{ field: 'size', from: '0.0109', to: '0.01' }])
  })

  it('面值 10 的合约：size 15 在 reject 下 1002，在 passive 下 1 张', () => {
    // 15 / 10 = 1.5 张：reject 拒绝，passive 向下取 1 张（10 币）。
    expect(() => build({ size: asDecimal('15') }, { faceValue: '10' })).toThrow(OrderBuildError)
    try {
      build({ size: asDecimal('15') }, { faceValue: '10' })
    } catch (e) {
      expect((e as OrderBuildError).problem.name).toBe('PRECISION')
    }
    const passive = build({ size: asDecimal('15'), rounding: 'passive' }, { faceValue: '10' })
    expect(passive.volume).toBe(1)
    expect(passive.body.volume).toBe('1')
  })

  it('数量缺失且无 notional → INVALID_PARAMS', () => {
    expect(() => build({ size: undefined, price: asDecimal('100') })).toThrow(/size or notional/)
  })

  it('notional 用参考价折成币数量再折张', () => {
    const built = build({ size: undefined, notional: asDecimal('1000') }, { ref: freshQuote() })
    // 1000 USDT / 100 = 10 BTC，再按 0.001 的面值 = 10000 张
    expect(built.volume).toBe(10_000)
  })

  it('notional 换算：缺省 rounding 也向下截到整张并记入 rounded', () => {
    const built = build({ size: undefined, notional: asDecimal('10.05') })
    expect(built.body.volume).toBe('100')
    expect(built.rounded).toEqual([{ field: 'size', from: '0.1005', to: '0.1' }])
  })

  it('size 不是面值整数倍且缺省 rounding → PRECISION（不静默截断）', () => {
    try {
      build({ size: asDecimal('0.1005') })
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as OrderBuildError).problem.name).toBe('PRECISION')
    }
  })

  it('notional 没有参考价 → STALE_PRICE', () => {
    try {
      build({ size: undefined, notional: asDecimal('1000') })
    } catch (e) {
      expect((e as OrderBuildError).problem.name).toBe('STALE_PRICE')
    }
  })

  it('价格不在 tick 上且 rounding=reject → PRECISION', () => {
    try {
      build({ price: asDecimal('100.05') })
    } catch (e) {
      expect((e as OrderBuildError).problem.name).toBe('PRECISION')
    }
  })

  it('rounding=passive：买单价格向下贴 tick 并记在 rounded 里', () => {
    const built = build({ price: asDecimal('100.05'), rounding: 'passive' })
    expect(built.body.price).toBe('100')
    expect(built.rounded).toEqual([{ field: 'price', from: '100.05', to: '100' }])
  })

  it('tif=ioc → type=limit + time_in_force=ioc（v5 的 type 没有 ioc）', () => {
    const body = build({ tif: 'ioc' }).body
    expect(body.type).toBe('limit')
    expect(body.time_in_force).toBe('ioc')
  })

  it('tif=fok → type=limit + time_in_force=fok', () => {
    const body = build({ tif: 'fok' }).body
    expect(body.type).toBe('limit')
    expect(body.time_in_force).toBe('fok')
  })

  it('postOnly → type=post_only，且不发 time_in_force', () => {
    const body = build({ postOnly: true }).body
    expect(body.type).toBe('post_only')
    expect(body.time_in_force).toBeUndefined()
  })

  it('postOnly 与 tif=ioc 冲突 → 1004', () => {
    expect(() => build({ postOnly: true, tif: 'ioc' })).toThrow(OrderBuildError)
  })

  it('reduce_only=1（单向平仓）', () => {
    expect(build({ reduceOnly: true }).body.reduce_only).toBe(1)
  })

  it('hedge 模式开多 → position_side=long，且不发 reduce_only', () => {
    const built = build({}, { hedge: true })
    expect(built.body.position_side).toBe('long')
    expect(built.body.reduce_only).toBeUndefined()
  })

  it('hedge 模式平多（sell + reduceOnly）→ position_side=long', () => {
    expect(build({ side: 'sell', reduceOnly: true }, { hedge: true }).body.position_side).toBe('long')
  })

  it('hedge 模式开空 → position_side=short', () => {
    expect(build({ side: 'sell' }, { hedge: true }).body.position_side).toBe('short')
  })

  it('显式 posSide 覆盖推导', () => {
    expect(positionSideOf('buy', false, true, 'short')).toBe('short')
  })

  it('margin_mode 可由选项覆盖', () => {
    expect(build({}, { marginMode: 'isolated' }).body.margin_mode).toBe('isolated')
  })

  it('市价意图：type=limit + time_in_force=ioc + 价带限价', () => {
    const built = build({ type: 'market', price: undefined, maxSlippageBps: 50 }, { ref: freshQuote() })
    expect(built.body.type).toBe('limit')
    expect(built.body.time_in_force).toBe('ioc')
    expect(Number(built.body.price)).toBeLessThanOrEqual(100 * 1.005)
    expect(Number(built.body.price)).toBeGreaterThan(100)
  })

  it('市价意图缺 maxSlippageBps → INVALID_PARAMS', () => {
    expect(() => build({ type: 'market', price: undefined }, { ref: freshQuote() })).toThrow(/maxSlippageBps/)
  })

  it('市价意图的报价陈旧 → STALE_PRICE', () => {
    try {
      build({ type: 'market', price: undefined, maxSlippageBps: 50 }, { ref: { ...freshQuote(), stale: true } })
    } catch (e) {
      expect((e as OrderBuildError).problem.name).toBe('STALE_PRICE')
    }
  })

  it('触发单不声明 → 1004（不凭记忆编计划委托端点）', () => {
    try {
      build({ type: 'stop_market', price: undefined, triggerPrice: asDecimal('90') })
    } catch (e) {
      expect((e as OrderBuildError).problem.name).toBe('ORDER_TYPE_UNSUPPORTED')
    }
  })

  it('twap / trailing_stop → 1004', () => {
    expect(() => build({ type: 'twap' })).toThrow(OrderBuildError)
    expect(() => build({ type: 'trailing_stop' })).toThrow(OrderBuildError)
  })

  it('未知标的 → 1001', () => {
    try {
      buildOrderBody(intent(), undefined, { faceValue: FACE })
    } catch (e) {
      expect((e as OrderBuildError).problem.name).toBe('INSTRUMENT_UNKNOWN')
    }
  })

  it('缺面值（没 start()）→ INSTRUMENT_UNKNOWN，不读 instrument.contractSize', () => {
    try {
      buildOrderBody(intent(), btc(), {})
    } catch (e) {
      expect((e as OrderBuildError).problem.name).toBe('INSTRUMENT_UNKNOWN')
      expect((e as OrderBuildError).problem.message).toContain('call start() first')
    }
  })

  it('最小名义额不足 → 1003', () => {
    const small = { ...btc(), minNotional: asDecimal('100000') }
    try {
      buildOrderBody(intent(), small, { faceValue: FACE })
    } catch (e) {
      expect((e as OrderBuildError).problem.name).toBe('MIN_NOTIONAL')
    }
  })

  it('reduce-only 豁免最小名义额', () => {
    const small = { ...btc(), minNotional: asDecimal('100000') }
    expect(() => buildOrderBody(intent({ reduceOnly: true }), small, { faceValue: FACE })).not.toThrow()
  })
})

describe('下单请求体（v1）', () => {
  it('限价买入：direction / offset=both / lever_rate / order_price_type / volume(数字张)', () => {
    const built = build({}, { family: 'v1', leverage: 5 })
    expect(built.body).toMatchObject({
      contract_code: 'BTC-USDT',
      volume: 10,
      direction: 'buy',
      offset: 'both',
      lever_rate: 5,
      order_price_type: 'limit',
      price: '100',
    })
    expect(typeof built.body.volume).toBe('number')
  })

  it('单向平仓带 reduce_only=1', () => {
    expect(build({ reduceOnly: true }, { family: 'v1', leverage: 5 }).body.reduce_only).toBe(1)
  })

  it('hedge 开仓 → offset=open，平仓 → offset=close 且不带 reduce_only', () => {
    expect(build({}, { family: 'v1', hedge: true, leverage: 5 }).body.offset).toBe('open')
    const close = build({ side: 'sell', reduceOnly: true }, { family: 'v1', hedge: true, leverage: 5 })
    expect(close.body.offset).toBe('close')
    expect(close.body.reduce_only).toBeUndefined()
  })

  it('lever_rate 缺失（opts / intent 都没有）→ INVALID_PARAMS，不猜 1', () => {
    try {
      build({}, { family: 'v1' })
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as OrderBuildError).problem.name).toBe('INVALID_PARAMS')
      expect((e as OrderBuildError).problem.message).toContain('lever_rate')
    }
  })

  it('intent.leverage 直接进 lever_rate', () => {
    expect(build({ leverage: 7 }, { family: 'v1' }).body.lever_rate).toBe(7)
  })

  it('v1 不接受 isolated（swap_cross_* 是交叉保证金）→ INVALID_PARAMS', () => {
    try {
      build({}, { family: 'v1', marginMode: 'isolated', leverage: 5 })
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as OrderBuildError).problem.name).toBe('INVALID_PARAMS')
    }
  })
})

describe('client_order_id 映射（int64）', () => {
  it('有数字的 id：取最后 18 位并去掉前导 0', () => {
    expect(numericClientOrderId('gt00000123456789')).toBe('123456789')
  })

  it('超长数字只留最后 18 位', () => {
    expect(numericClientOrderId('1'.repeat(20))).toBe('1'.repeat(18))
  })

  it('没有数字的 id：确定性哈希映射，非 0 且不超过 int64 正区间', () => {
    const a = numericClientOrderId('gtabcdef')
    const b = numericClientOrderId('gtabcdef')
    expect(a).toBe(b)
    expect(a).toMatch(/^\d+$/)
    expect(Number(a)).toBeGreaterThan(0)
    expect(BigInt(a) < 2n ** 63n).toBe(true)
  })

  it('不同 id 映射不同（碰撞概率可忽略）', () => {
    expect(numericClientOrderId('gt-a')).not.toBe(numericClientOrderId('gt-b'))
  })

  it('内核给的 id 原样进 BuiltOrder，场所拿到的是映射后的 int64', () => {
    const built = build({ clientOrderId: 'ord-42' })
    expect(built.clientOrderId).toBe('ord-42')
    expect(built.body.client_order_id).toBe(numericClientOrderId('ord-42'))
  })
})

describe('撤单 / 查询 / 杠杆 / 止盈止损 请求体', () => {
  it('撤单按 order_id', () => {
    expect(buildCancelBody('BTC-USDT', { venueOrderId: '123' })).toEqual({ contract_code: 'BTC-USDT', order_id: '123' })
  })

  it('撤单按 client_order_id（字符串先映射成 int64）', () => {
    expect(buildCancelBody('BTC-USDT', { clientOrderId: 'ord-42' })).toEqual({
      contract_code: 'BTC-USDT',
      client_order_id: numericClientOrderId('ord-42'),
    })
  })

  it('撤单两个键都没有 → INVALID_PARAMS', () => {
    expect(() => buildCancelBody('BTC-USDT', {})).toThrow(OrderBuildError)
  })

  it('全撤体：不给合约就是全部（空对象）', () => {
    expect(buildCancelAllBody()).toEqual({})
    expect(buildCancelAllBody('BTC-USDT')).toEqual({ contract_code: 'BTC-USDT' })
  })

  it('订单查询参数：contract_code + order_id / client_order_id', () => {
    expect(buildOrderQueryParams('BTC-USDT', { venueOrderId: '9' })).toEqual({ contract_code: 'BTC-USDT', order_id: '9' })
    expect(buildOrderQueryParams('BTC-USDT', { clientOrderId: '123' })).toEqual({ contract_code: 'BTC-USDT', client_order_id: '123' })
  })

  it('杠杆体（v5）：contract_code / lever_rate / margin_mode', () => {
    expect(buildLeverBody('BTC-USDT', 10, 'isolated')).toEqual({ contract_code: 'BTC-USDT', lever_rate: 10, margin_mode: 'isolated' })
  })

  it('杠杆体（v1）：只有 contract_code / lever_rate（官方没有 margin_mode）', () => {
    expect(buildLeverBody('BTC-USDT', 10, 'cross', 'v1')).toEqual({ contract_code: 'BTC-USDT', lever_rate: 10 })
    expect(() => buildLeverBody('BTC-USDT', 10, 'isolated', 'v1')).toThrow(OrderBuildError)
  })

  it('杠杆越界（0 / 126 / 非整数）→ INVALID_PARAMS', () => {
    expect(() => buildLeverBody('BTC-USDT', 0)).toThrow(OrderBuildError)
    expect(() => buildLeverBody('BTC-USDT', 126)).toThrow(OrderBuildError)
    expect(() => buildLeverBody('BTC-USDT', 1.5)).toThrow(OrderBuildError)
  })

  it('止盈止损体：tp/sl 触发价 + optimal_5 价格类型（QD 口径）', () => {
    const body = buildTpslBody({
      contractCode: 'BTC-USDT',
      direction: 'sell',
      volume: 10,
      takeProfit: { triggerPrice: asDecimal('110') },
      stopLoss: { triggerPrice: asDecimal('90') },
    })
    expect(body).toEqual({
      contract_code: 'BTC-USDT',
      direction: 'sell',
      volume: 10,
      tp_trigger_price: '110',
      tp_order_price_type: 'optimal_5',
      sl_trigger_price: '90',
      sl_order_price_type: 'optimal_5',
    })
  })

  it('止盈止损体：给了 order price 就用 limit + tp_order_price', () => {
    const body = buildTpslBody({ contractCode: 'BTC-USDT', direction: 'sell', volume: 1, takeProfit: { triggerPrice: asDecimal('110'), price: asDecimal('109.9') } })
    expect(body.tp_order_price).toBe('109.9')
    expect(body.tp_order_price_type).toBe('limit')
  })

  it('止盈止损体：tp/sl 都不给 → INVALID_PARAMS；volume 非整数 → PRECISION', () => {
    expect(() => buildTpslBody({ contractCode: 'BTC-USDT', direction: 'sell', volume: 1 })).toThrow(OrderBuildError)
    expect(() => buildTpslBody({ contractCode: 'BTC-USDT', direction: 'sell', volume: 0, takeProfit: { triggerPrice: asDecimal('1') } })).toThrow(OrderBuildError)
  })

  it('止盈止损方向合理性：平多的止盈在上方、止损在下方', () => {
    expect(tpslSideOk('tp', 'sell', 110, 100)).toBe(true)
    expect(tpslSideOk('tp', 'sell', 90, 100)).toBe(false)
    expect(tpslSideOk('sl', 'sell', 90, 100)).toBe(true)
    expect(tpslSideOk('sl', 'buy', 90, 100)).toBe(false)
  })
})

describe('精度', () => {
  it('币数量 → 张数（向零截断）', () => {
    expect(baseToContracts('0.0109', '0.001')).toBe(10)
    expect(baseToContracts('1', '0.01')).toBe(100)
  })

  it('张数 → 币数量', () => {
    expect(String(contractsToBase(10, '0.001'))).toBe('0.01')
    expect(String(contractsToBase(0, '0.001'))).toBe('0')
  })

  it('face value 非法时返回 0（不瞎猜）', () => {
    expect(baseToContracts('1', '0')).toBe(0)
    expect(baseToContracts('abc', '0.001')).toBe(0)
  })

  it('tick 整数倍判定与贴价', () => {
    expect(isMultipleOf('100.1', '0.1')).toBe(true)
    expect(isMultipleOf('100.05', '0.1')).toBe(false)
    expect(String(snapToTick('100.05', '0.1', 'down'))).toBe('100')
    expect(String(snapToTick('100.05', '0.1', 'up'))).toBe('100.1')
    expect(String(truncateToStep('100.19', '0.1'))).toBe('100.1')
  })
})

describe('响应解析', () => {
  it('合约代码 ↔ instrumentId', () => {
    expect(instrumentIdOf('btc-usdt')).toBe('htx:BTC-USDT')
    expect(symbolOf('htx:BTC-USDT')).toBe('BTC-USDT')
    expect(() => symbolOf('bybit:BTCUSDT')).toThrow(RangeError)
  })

  it('decimalOf / num：空串当缺失', () => {
    expect(String(decimalOf(''))).toBe('0')
    expect(String(decimalOf('1.5'))).toBe('1.5')
    expect(Number.isNaN(num(''))).toBe(true)
    expect(num('2')).toBe(2)
    expect(String(absDecimal('-3'))).toBe('3')
  })

  it('余额（v5 官方顶层字段 + details）→ AccountSnapshot，计值 USD', () => {
    const snapshot = parseAccountSnapshot({
      state: 'normal',
      equity: '1000.5',
      initial_margin: '100.25',
      maintenance_margin: '10',
      available_margin: '900.25',
      details: [{ currency: 'USDT', equity: '1000.5', available: '900.25', initial_margin: '100.25', maintenance_margin: '10' }],
    }, 'acc_htx_1' as never, NOW)
    expect(String(snapshot.margin.equity)).toBe('1000.5')
    expect(String(snapshot.margin.available)).toBe('900.25')
    expect(String(snapshot.margin.initialMargin)).toBe('100.25')
    expect(String(snapshot.margin.maintenanceMargin)).toBe('10')
    expect(snapshot.margin.valuationCcy).toBe('USD')
    expect(snapshot.balances[0]!.asset).toBe('USDT')
    expect(snapshot.accountModel).toBe('unified')
  })

  it('余额（v1 官方数组形状）→ AccountSnapshot，计值 USDT', () => {
    const snapshot = parseAccountSnapshot([{ margin_asset: 'USDT', margin_balance: '500', margin_available: '400', margin_position: '50' }], 'acc_htx_1' as never, NOW, 'standard')
    expect(String(snapshot.margin.equity)).toBe('500')
    expect(String(snapshot.margin.initialMargin)).toBe('50')
    expect(snapshot.margin.valuationCcy).toBe('USDT')
    expect(snapshot.accountModel).toBe('standard')
  })

  it('余额为空 → 0，且不抛', () => {
    const snapshot = parseAccountSnapshot(null, 'acc_htx_1' as never, NOW)
    expect(String(snapshot.margin.equity)).toBe('0')
    expect(snapshot.balances).toEqual([])
  })

  it('持仓（v5 官方行）：open_avg_price / mark_price / position_side / 张 → 币', () => {
    const pos = parsePosition({
      contract_code: 'BTC-USDT', position_side: 'short', direction: 'buy', volume: 10,
      open_avg_price: '105', mark_price: '110', last_price: '109', lever_rate: 5, margin_mode: 'cross',
    }, 'acc_htx_1' as never, NOW, contractSizeOf)
    expect(String(pos!.size)).toBe('0.01')
    expect(pos!.side).toBe('short')
    expect(String(pos!.entryPrice)).toBe('105')
    expect(String(pos!.markPrice)).toBe('110')
    expect(pos!.leverage).toBe(5)
    expect(String(pos!.unrealizedPnl)).toBe('0')
  })

  it('持仓（v1 行）：没有 position_side 时按 direction 定多空、cost_open 做入场价', () => {
    const pos = parsePosition({ contract_code: 'BTC-USDT', direction: 'sell', volume: 10, cost_open: '100', last_price: '110', lever_rate: 5 }, 'acc_htx_1' as never, NOW, contractSizeOf)
    expect(pos!.side).toBe('short')
    expect(String(pos!.entryPrice)).toBe('100')
    expect(String(pos!.markPrice)).toBe('110')
  })

  it('持仓 volume=0 跳过；空行跳过', () => {
    expect(parsePosition({ contract_code: 'BTC-USDT', volume: 0 }, 'a' as never, NOW, contractSizeOf)).toBeNull()
    expect(parsePosition({}, 'a' as never, NOW, contractSizeOf)).toBeNull()
    expect(parsePositions([{ contract_code: 'BTC-USDT', direction: 'sell', volume: 1 }], 'a' as never, NOW, contractSizeOf)).toHaveLength(1)
  })

  it('拿不到合约面值 → INSTRUMENT_UNKNOWN（不按 1 折算、不标 estimated）', () => {
    expect(() => parsePosition({ contract_code: 'XYZ-USDT', direction: 'buy', volume: 3 }, 'a' as never, NOW)).toThrow(/contract size unknown/)
  })

  it('挂单（v1 官方行）：剩余量 = volume − trade_volume，类型按 order_price_type', () => {
    const order = parseOpenOrder({ order_id: 5, contract_code: 'BTC-USDT', direction: 'buy', volume: 10, trade_volume: 4, price: '100', order_price_type: 'limit', status: 3, created_at: NOW }, contractSizeOf, 'v1')
    expect(String(order!.size)).toBe('0.006')
    expect(String(order!.origSize)).toBe('0.01')
    expect(order!.type).toBe('limit')
    expect(order!.venueOrderId).toBe('5')
  })

  it('挂单：order_id_str 优先；没有订单号的行丢弃', () => {
    const order = parseOpenOrder({ order_id: 5, order_id_str: '9007199254740993', contract_code: 'BTC-USDT', volume: 1, price: '100' }, contractSizeOf)
    expect(order!.venueOrderId).toBe('9007199254740993')
    expect(parseOpenOrder({ contract_code: 'BTC-USDT', volume: 1 }, contractSizeOf)).toBeNull()
  })

  it('挂单（v5 官方行）：side / type / 字符串 volume / created_time / 布尔 reduce_only', () => {
    const order = parseOpenOrder({
      id: 12, order_id: '7000000001', client_order_id: '999', contract_code: 'BTC-USDT', side: 'sell',
      type: 'limit', volume: '10', trade_volume: '4', price: '100', created_time: NOW,
      reduce_only: true, state: 'new',
    }, contractSizeOf, 'v5')
    expect(String(order!.size)).toBe('0.006')
    expect(order!.side).toBe('sell')
    expect(order!.clientOrderId).toBe('999')
    expect(order!.reduceOnly).toBe(true)
    expect(order!.createdAt).toBe(NOW)
    expect(order!.venueOrderId).toBe('7000000001')
  })

  it('订单状态码映射：3 委托中 / 6 全成 / 7 已撤', () => {
    expect(orderStatusOf(3)).toBe('open')
    expect(orderStatusOf(4)).toBe('partially_filled')
    expect(orderStatusOf(6)).toBe('filled')
    expect(orderStatusOf(7)).toBe('cancelled')
    expect(orderStatusOf(99)).toBe('unknown')
  })

  it('单张订单状态：found + 原始状态文本 + 已成交数量', () => {
    const status = parseOrderStatusResult({ order_id: 11, status: 6, trade_volume: 10, contract_code: 'BTC-USDT' }, contractSizeOf)
    expect(status.found).toBe(true)
    expect(status.status).toBe('6')
    expect(String(status.filledSize)).toBe('0.01')
  })

  it('v5 订单状态原样透传上游 state（不翻译 partially_canceled）', () => {
    const status = parseOrderStatusResult({ order_id: '11', state: 'partially_canceled', trade_volume: '4', contract_code: 'BTC-USDT' }, contractSizeOf)
    expect(status.found).toBe(true)
    expect(status.status).toBe('partially_canceled')
  })

  it('订单号缺失 / 为 0 → found:false', () => {
    expect(parseOrderStatusResult({ order_id: 0 }).found).toBe(false)
    expect(parseOrderStatusResult(null).found).toBe(false)
  })

  it('订单查询的 data 可能是数组', () => {
    expect(firstOrderRow([{ order_id: 1 }])!.order_id).toBe(1)
    expect(firstOrderRow({ order_id: 2 })!.order_id).toBe(2)
    expect(firstOrderRow([])).toBeNull()
  })

  it('成交（v1 官方示例行）：trade_volume 100 × 0.001 = 0.1，fee 取反，id 是去重键', () => {
    const fill = parseTrade({
      id: '2902136-918800256249405440-1',
      contract_code: 'BTC-USDT',
      direction: 'buy',
      trade_volume: 100,
      trade_price: '48555.6',
      trade_fee: '-2.42778',
      create_date: NOW,
      role: 'Taker',
      fee_asset: 'USDT',
      real_profit: '0',
      order_id: 123,
      order_id_str: '7000000001',
    }, NOW, contractSizeOf, 'v1')
    expect(String(fill!.size)).toBe('0.1')
    expect(String(fill!.price)).toBe('48555.6')
    expect(String(fill!.fee)).toBe('2.42778')
    expect(fill!.liquidity).toBe('taker')
    expect(fill!.venueFillId).toBe('2902136-918800256249405440-1')
    expect(fillDedupeKey(fill!)).toBe('htx|2902136-918800256249405440-1')
  })

  it('成交（v5 官方示例行）：trade_id / trade_volume / trade_price / trade_fee 原样为正', () => {
    const fill = parseTrade({
      id: '100000032538647',
      trade_id: '100000032538647',
      contract_code: 'BTC-USDT',
      side: 'sell',
      trade_volume: '1',
      trade_price: '31400',
      trade_fee: '0.01884',
      role: 'TAKER',
      fee_currency: 'USDT',
      profit: '0',
      created_time: NOW,
      order_id: '7000000001',
    }, NOW, contractSizeOf, 'v5')
    expect(String(fill!.size)).toBe('0.001')
    expect(String(fill!.price)).toBe('31400')
    expect(String(fill!.fee)).toBe('0.01884')
    expect(fill!.side).toBe('sell')
    expect(fill!.liquidity).toBe('taker')
    expect(fill!.venueFillId).toBe('100000032538647')
  })

  it('成交：没有成交号 / trade_volume<=0 的行丢弃', () => {
    expect(parseTrade({ contract_code: 'BTC-USDT', trade_volume: 1 }, NOW, contractSizeOf)).toBeNull()
    expect(parseTrade({ id: 1, contract_code: 'BTC-USDT', trade_volume: 0 }, NOW, contractSizeOf)).toBeNull()
  })

  it('成交列表从 v1 的 trades / 数组 / 单行形状都能取', () => {
    expect(parseTrades({ trades: [{ id: 1, contract_code: 'BTC-USDT', trade_volume: 1 }] }, NOW, contractSizeOf)).toHaveLength(1)
    expect(parseTrades([{ id: 2, contract_code: 'BTC-USDT', trade_volume: 1 }], NOW, contractSizeOf)).toHaveLength(1)
    expect(parseTrades({ id: 3, contract_code: 'BTC-USDT', trade_volume: 1 }, NOW, contractSizeOf)).toHaveLength(1)
  })

  it('平仓行识别：offset=close 或有已实现盈亏', () => {
    expect(isClosingTrade({ offset: 'close' })).toBe(true)
    expect(isClosingTrade({ real_profit: '-1.5' })).toBe(true)
    expect(isClosingTrade({ offset: 'open', real_profit: '0' })).toBe(false)
  })

  it('baseSizeOf：面值缺失 → INSTRUMENT_UNKNOWN；有面值时张 → 币', () => {
    expect(() => baseSizeOf(5, undefined, 'XYZ-USDT')).toThrow(/contract size unknown/)
    expect(String(baseSizeOf(5, '0.01'))).toBe('0.05')
  })

  it('合约规格解析：price_tick 的指数写法规范成十进制文本', () => {
    const pep = parseContract({ contract_code: 'PEPE-USDT', contract_size: 1000000, price_tick: 1e-9, contract_status: 1 }, NOW)
    expect(pep).not.toBeNull()
    expect(pep!.price.tick).toBe('0.000000001')
  })

  it('市价价带：小 tick 标的的请求价格不含科学计数法，且是 tick 整数倍', () => {
    const pep = parseContract({ contract_code: 'PEPE-USDT', contract_size: 1000000, price_tick: 1e-9, contract_status: 1 }, NOW)!
    const built = buildOrderBody(
      intent({ instrumentId: pep.instrumentId, type: 'market', size: asDecimal('1000000'), price: undefined, maxSlippageBps: 30 }),
      pep,
      { faceValue: '1000000', ref: { bid: 0.00000094, ask: 0.00000096, stale: false } },
    )
    const price = String(built.body.price)
    expect(price).not.toContain('e')
    expect(isMultipleOf(price, '0.000000001')).toBe(true)
    expect(Number(price)).toBeLessThanOrEqual(0.00000095 * 1.003)
    expect(built.volume).toBe(1)
  })

  it('合约规格解析：contractSize 恒为 1、size.step/min/decimals 用官方面值', () => {
    const list = instruments()
    expect(list).toHaveLength(2)
    expect(String(list[0]!.contractSize)).toBe('1')
    expect(String(list[0]!.size.step)).toBe('0.001')
    expect(String(list[0]!.size.min)).toBe('0.001')
    expect(list[0]!.size.decimals).toBe(3)
    expect(list[0]!.price.tick).toBeDefined()
    expect(list[0]!.status).toBe('trading')
    expect(list[0]!.venueSizeUnit).toBe('base')
    expect(list[0]!.maxLeverage).toBe(125)
  })
})
