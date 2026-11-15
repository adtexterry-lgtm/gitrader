// SPDX-License-Identifier: CPAL-1.0
// 响应 → 协议模型（纯函数）：订单状态映射、持仓（张→币）、账户、挂单、成交（去重键 / 手续费符号）、
// 订单详情、资金费流水、私有流归一（保留成交号与零仓平仓行）。
import { describe, expect, it } from 'vitest'
import type { AccountId } from '@gitrader/protocol'
import {
  PRICE_ORDER_PREFIX, absDec, decimalOf, isLiquidationText, mapOpenOrderType, mapOrderStatus, marginOfPositionRow, msOfEither,
  msOfSeconds, multipliersOf, orderStatusWord, parseAccount, parseFill, parseFills, parseFundingRows, parseOpenOrder,
  parseOpenOrders, parseOrderDetail, parsePosition, parsePositions, parsePriceOrder, parsePriceOrders, positiveDecimalOf,
  priceOrderIdOf, priceOrderStatusWord, requireMultiplier, signedDecimalOf,
} from '../src/parse'
import type { RawOrder, RawPosition } from '../src/parse'
import { NOW } from './helpers/fake-gate'

const ctx = { accountId: 'acct_gateio_test' as AccountId, now: NOW }
const positionRow = (over: Partial<RawPosition> = {}): RawPosition => ({
  contract: 'BTC_USDT', size: '100', leverage: '10', mode: 'single', entry_price: '99000', mark_price: '100000',
  value: '1000', margin: '99', unrealised_pnl: '10', realised_pnl: '2', liq_price: '90000',
  create_time: 1_791_483_400, update_time: 1_791_483_430, ...over,
})

describe('数值 / 时间', () => {
  it('1. decimalOf 归一宽松文本，非法回落 0', () => {
    expect(decimalOf(' 1.500 ')).toBe('1.5')
    expect(decimalOf('-0')).toBe('0')
    expect(decimalOf(2)).toBe('2')
    expect(decimalOf('abc')).toBe('0')
    expect(decimalOf(undefined)).toBe('0')
  })

  it('2. signedDecimalOf 保留符号', () => {
    expect(signedDecimalOf('-250')).toBe('-250')
    expect(absDec(decimalOf('-250'))).toBe('250')
    expect(absDec(decimalOf('7'))).toBe('7')
  })

  it('3. msOfSeconds：Gate 的 create_time 是秒（可带小数）', () => {
    expect(msOfSeconds('1791483435', 0)).toBe(1_791_483_435_000)
    expect(msOfSeconds('1791483435.5', 0)).toBe(1_791_483_435_500)
    expect(msOfSeconds(undefined, 42)).toBe(42)
    expect(msOfSeconds('nope', 7)).toBe(7)
  })

  it('4. msOfEither 按量级认毫秒 / 秒', () => {
    expect(msOfEither(1_791_483_435_000, 0)).toBe(1_791_483_435_000)
    expect(msOfEither(1_791_483_435, 0)).toBe(1_791_483_435_000)
    expect(msOfEither('bad', 5)).toBe(5)
  })
})

describe('订单状态映射', () => {
  it('5. open / finished / cancelled 三态', () => {
    expect(mapOrderStatus('open')).toBe('open')
    expect(mapOrderStatus('finished')).toBe('filled')
    expect(mapOrderStatus('cancelled')).toBe('cancelled')
    expect(mapOrderStatus('canceled')).toBe('cancelled')
  })

  it('6. finish_as 细化 finished：ioc / stp / reduce_only 是撤而不是全成', () => {
    expect(mapOrderStatus('finished', 'ioc')).toBe('cancelled')
    expect(mapOrderStatus('finished', 'stp')).toBe('cancelled')
    expect(mapOrderStatus('finished', 'reduce_only')).toBe('cancelled')
    expect(mapOrderStatus('finished', 'filled')).toBe('filled')
  })

  it('7. 不认识的状态返回 null（不猜成 open）', () => {
    expect(mapOrderStatus('weird')).toBeNull()
    expect(mapOrderStatus(undefined)).toBeNull()
    expect(mapOrderStatus(null)).toBeNull()
  })

  it('8. 挂单类型：limit / 空串都是 limit，market 归 unknown', () => {
    expect(mapOpenOrderType('limit')).toBe('limit')
    expect(mapOpenOrderType(undefined)).toBe('limit')
    expect(mapOpenOrderType('market')).toBe('unknown')
    expect(mapOpenOrderType('stop')).toBe('unknown')
  })
})

describe('持仓（张 → 币，观察教训 5）', () => {
  it('9. 多头 100 张 × 0.0001 = 0.01 BTC，方向 long', () => {
    const p = parsePosition(positionRow(), ctx, decimalOf('0.0001'))!
    expect(p.instrumentId).toBe('gateio:BTC_USDT')
    expect(p.size).toBe('0.01')
    expect(p.side).toBe('long')
    expect(p.entryPrice).toBe('99000')
    expect(p.markPrice).toBe('100000')
    expect(p.notional).toBe('1000')
    expect(p.leverage).toBe(10)
    expect(p.liquidationPrice).toBe('90000')
    expect(p.initialMargin).toBe('99')
  })

  it('10. 负张数 = 空头，size 取绝对值', () => {
    const p = parsePosition(positionRow({ contract: 'ETH_USDT', size: '-250', leverage: '20' }), ctx, decimalOf('0.01'))!
    expect(p.side).toBe('short')
    expect(p.size).toBe('2.5')
  })

  it('11. 双仓模式以 mode 确认方向', () => {
    expect(parsePosition(positionRow({ size: '100', mode: 'dual_short' }), ctx, decimalOf('0.0001'))!.side).toBe('short')
    expect(parsePosition(positionRow({ size: '-100', mode: 'dual_long' }), ctx, decimalOf('0.0001'))!.side).toBe('long')
  })

  it('12. 零仓位行丢弃', () => {
    expect(parsePosition(positionRow({ size: '0' }), ctx, decimalOf('0.0001'))).toBeUndefined()
    expect(parsePositions([{ contract: 'BTC_USDT', size: '0' }, { contract: 'ETH_USDT', size: '1', leverage: '10' }], ctx, () => decimalOf('1'))).toHaveLength(1)
  })

  it('13. 没有 value 时用 mark_price × size 自己算名义额', () => {
    const p = parsePosition(positionRow({ value: '0' }), ctx, decimalOf('0.0001'))!
    // 0.01 BTC × 100000 = 1000
    expect(p.notional).toBe('1000')
  })

  it('14. liq_price 为 0 时报 null（不是 0）', () => {
    expect(parsePosition(positionRow({ liq_price: '0' }), ctx, decimalOf('0.0001'))!.liquidationPrice).toBeNull()
  })

  it('15. 资金费累计恒 0（Gate 不给，不编数字）', () => {
    expect(parsePosition(positionRow(), ctx, decimalOf('0.0001'))!.fundingSinceOpen).toBe('0')
  })

  it('16. 缺 contract 的行跳过（不造出假标的）', () => {
    expect(parsePosition({ size: '1' }, ctx, decimalOf('1'))).toBeUndefined()
  })
})

describe('账户', () => {
  it('17. 余额 / 可用 / 冻结（position_margin + order_margin）', () => {
    const parsed = parseAccount({
      currency: 'USDT', total: '1020.5', available: '900.25', position_margin: '99', order_margin: '5.5',
    }, ctx)
    expect(parsed.balances).toHaveLength(1)
    expect(parsed.balances[0]).toMatchObject({ asset: 'USDT', total: '1020.5', available: '900.25', hold: '104.5' })
  })

  it('18. equity = total + unrealised_pnl（Gate 的 total 不含未实现盈亏）', () => {
    const parsed = parseAccount({ total: '1020.5', available: '900', unrealised_pnl: '20.5' }, ctx)
    expect(parsed.margin.equity).toBe('1041')
    expect(parsed.margin.available).toBe('900')
    expect(parsed.balances[0]!.total).toBe('1020.5')
  })

  it('19. 给了 maintenance_rate 才算维持保证金，否则 0', () => {
    const of = (c: string): ReturnType<typeof decimalOf> | undefined => (c === 'BTC_USDT' ? decimalOf('0.0001') : undefined)
    const withRate = parsePositions([positionRow({ value: '1000', maintenance_rate: '0.005' })], ctx, of)
    const parsed = parseAccount({ total: '100', position_margin: '10' }, ctx, withRate)
    expect(parsed.margin.maintenanceMargin).toBe('5')
    expect(Number(parsed.margin.marginRatio)).toBeCloseTo(0.05, 12)
    expect(parseAccount({ total: '100', position_margin: '10' }, ctx).margin.maintenanceMargin).toBe('0')
    expect(parseAccount({ total: '100', position_margin: '10' }, ctx).margin.marginRatio).toBe('0')
  })

  it('20. 初始保证金优先用 position_margin；缺失时按持仓汇总', () => {
    const positions = parsePositions([positionRow()], ctx, () => decimalOf('0.0001'))
    expect(parseAccount({ total: '1', position_margin: '99' }, ctx, positions).margin.initialMargin).toBe('99')
    expect(parseAccount({ total: '1' }, ctx, positions).margin.initialMargin).toBe('99')
  })

  it('21. 持仓模式：position_mode 优先，缺失回落 in_dual_mode', () => {
    expect(parseAccount({ total: '1', position_mode: 'dual' }, ctx).positionMode).toBe('dual')
    expect(parseAccount({ total: '1', in_dual_mode: true }, ctx).positionMode).toBe('dual')
    expect(parseAccount({ total: '1', in_dual_mode: false }, ctx).positionMode).toBe('single')
    expect(parseAccount({ total: '1' }, ctx).positionMode).toBe('')
  })

  it('22. 全零账户不产出余额行；非对象输入不炸', () => {
    expect(parseAccount({}, ctx).balances).toHaveLength(0)
    expect(parseAccount(null, ctx).balances).toHaveLength(0)
    expect(parseAccount([], ctx).margin.valuationCcy).toBe('USDT')
  })
})

describe('挂单', () => {
  const row = (over: Partial<RawOrder> = {}): RawOrder => ({
    id: 7001, text: 't-open-1', contract: 'BTC_USDT', size: '100', left: '40', price: '99000', status: 'open',
    create_time: 1_791_483_410, ...over,
  })

  it('23. 剩余量 = |left| 张 × quanto_multiplier；原量 = |size| 张 × 张值', () => {
    const o = parseOpenOrder(row(), NOW, decimalOf('0.0001'))!
    expect(o.origSize).toBe('0.01')
    expect(o.size).toBe('0.004')
    expect(o.price).toBe('99000')
    expect(o.clientOrderId).toBe('t-open-1')
    expect(o.type).toBe('limit')
  })

  it('24. size 符号给方向；reduce_only 透传', () => {
    expect(parseOpenOrder(row({ size: '-100' }), NOW, decimalOf('0.0001'))!.side).toBe('sell')
    expect(parseOpenOrder(row({ reduce_only: true }), NOW, decimalOf('0.0001'))!.reduceOnly).toBe(true)
    expect(parseOpenOrder(row(), NOW, decimalOf('0.0001'))!.reduceOnly).toBe(false)
  })

  it('25. 没有 id 的行跳过；没有 text 时 clientOrderId 为 null', () => {
    expect(parseOpenOrder(row({ id: undefined }), NOW, decimalOf('0.0001'))).toBeUndefined()
    expect(parseOpenOrder(row({ text: '' }), NOW, decimalOf('0.0001'))!.clientOrderId).toBeNull()
  })

  it('26. 数组按创建时间排序，非数组返回空', () => {
    const list = parseOpenOrders([row({ id: 2, create_time: 1_791_483_420 }), row({ id: 1 })], NOW, () => decimalOf('0.0001'))
    expect(list.map((o) => o.venueOrderId)).toEqual(['1', '2'])
    expect(parseOpenOrders('nope', NOW, () => decimalOf('0.0001'))).toEqual([])
  })
})

describe('成交（观察教训 10：成交号是去重键）', () => {
  it('REST 成交 ID 按 contract 隔离；缺 ID 的非零量仍为空串', () => {
    const btc = parseFill({ id: 'shared', contract: 'BTC_USDT', size: '1' }, NOW, decimalOf('0.0001'))!
    const eth = parseFill({ id: 'shared', contract: 'ETH_USDT', size: '1' }, NOW, decimalOf('0.01'))!
    const missing = parseFill({ contract: 'BTC_USDT', size: '1' }, NOW, decimalOf('0.0001'))!
    expect(btc.venueFillId).toBe('BTC_USDT:shared')
    expect(eth.venueFillId).toBe('ETH_USDT:shared')
    expect(missing.venueFillId).toBe('')
  })

  it('27. 成交号 = id，数量折成币数，角色 maker / taker', () => {
    const f = parseFill({
      id: 90001, create_time: 1_791_483_420.5, contract: 'BTC_USDT', order_id: '7001', size: '60', price: '100100',
      role: 'taker', text: 't-open-1', fee: '-0.006',
    }, NOW, decimalOf('0.0001'))!
    expect(f.venueFillId).toBe('BTC_USDT:90001')
    expect(f.size).toBe('0.006')
    expect(f.side).toBe('buy')
    expect(f.liquidity).toBe('taker')
    expect(f.feeCcy).toBe('USDT')
    expect(f.ts).toBe(1_791_483_420_500)
  })

  it('28. 手续费原样（Gate 的 fee 正 = 付出，与协议同号）', () => {
    expect(parseFill({ id: 'a', contract: 'BTC_USDT', size: '1', fee: '-0.006' }, NOW, decimalOf('0.0001'))!.fee).toBe('-0.006')
    expect(parseFill({ id: 'b', contract: 'BTC_USDT', size: '1', fee: '0.001' }, NOW, decimalOf('0.0001'))!.fee).toBe('0.001')
    expect(parseFill({ id: 'c', contract: 'BTC_USDT', size: '1', fee: '0' }, NOW, decimalOf('0.0001'))!.fee).toBe('0')
  })

  it('29. 卖方向为负张数', () => {
    expect(parseFill({ id: 'd', contract: 'BTC_USDT', size: '-60' }, NOW, decimalOf('0.0001'))!.side).toBe('sell')
  })

  it('30. 零数量但有成交号的行保留（平仓尾笔），既无号又无量才丢', () => {
    const kept = parseFill({ id: 'e', contract: 'BTC_USDT', size: '0' }, NOW, decimalOf('0.0001'))
    expect(kept?.venueFillId).toBe('BTC_USDT:e')
    expect(kept?.size).toBe('0')
    expect(parseFill({ contract: 'BTC_USDT', size: '0' }, NOW, decimalOf('0.0001'))).toBeUndefined()
  })

  it('31. 成交数组按时间升序、缺 contract 跳过', () => {
    const list = parseFills([
      { id: '2', contract: 'BTC_USDT', size: '1', create_time: 1_791_483_425 },
      { id: '1', contract: 'BTC_USDT', size: '1', create_time: 1_791_483_420 },
      { id: '3', size: '1' },
    ], NOW, () => decimalOf('0.0001'))
    expect(list.map((f) => f.venueFillId)).toEqual(['BTC_USDT:1', 'BTC_USDT:2'])
  })
})

describe('订单详情 / 资金费', () => {
  it('32. 详情：成交额 = (|size| − |left|) × 张值；状态落成内核认得的词', () => {
    const s = parseOrderDetail({ id: 7001, size: '100', left: '40', status: 'open' }, decimalOf('0.0001'))
    expect(s.found).toBe(true)
    expect(s.status).toBe('partially_filled')
    expect(s.filledSize).toBe('0.006')
    expect(s.venueOrderId).toBe('7001')
  })

  it('33. 详情：非对象 / 空对象 → found=false', () => {
    expect(parseOrderDetail(null, decimalOf('0.0001')).found).toBe(false)
    expect(parseOrderDetail({}, decimalOf('0.0001')).found).toBe(false)
    expect(parseOrderDetail([1, 2], decimalOf('0.0001')).found).toBe(false)
  })

  it('34. 资金费：change 的符号即现金流符号（正 = 收到）', () => {
    const rows = parseFundingRows([
      { id: 'f-1', time: 1_791_480_000, contract: 'BTC_USDT', change: '0.1234' },
      { id: 'f-2', time: 1_791_451_200, contract: 'BTC_USDT', change: '-0.05' },
    ])
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ id: 'f-2', amount: '-0.05', asset: 'USDT', ts: 1_791_451_200_000 })
    expect(rows[1]!.amount).toBe('0.1234')
  })

  it('35. 资金费：没有 id 时用 ts:amount 兜底，非数组返回空', () => {
    expect(parseFundingRows([{ time: 1_791_480_000, change: '1' }])[0]!.id).toBe('1791480000000:1')
    expect(parseFundingRows('x')).toEqual([])
  })
})

describe('保证金模式 / 乘数工具 / 触发单行', () => {
  it('36. 持仓保证金解析：leverage > 0 = 逐仓，leverage 0 = 全仓（看 cross_leverage_limit）', () => {
    expect(marginOfPositionRow({ leverage: '10' })).toEqual({ mode: 'isolated', leverage: 10 })
    expect(marginOfPositionRow({ leverage: '0', cross_leverage_limit: '20' })).toEqual({ mode: 'cross', leverage: 20 })
    const p = parsePosition(positionRow({ value: '1000', maintenance_rate: '0.005' }), ctx, decimalOf('0.0001'))!
    expect(p.marginMode).toBe('isolated')
    expect(p.leverage).toBe(10)
    expect(p.maintenanceMargin).toBe('5')
  })

  it('37. 乘数工具：缺失 / 非法 / ≤ 0 都是 undefined；requireMultiplier 拿不到就报 DATA_UNAVAILABLE', () => {
    expect(positiveDecimalOf('0.0001')).toBe('0.0001')
    expect(positiveDecimalOf('0')).toBeUndefined()
    expect(positiveDecimalOf('-1')).toBeUndefined()
    expect(positiveDecimalOf(undefined)).toBeUndefined()
    expect(() => requireMultiplier(() => undefined, 'BTC_USDT')).toThrow(/quanto_multiplier unknown/)
    try {
      requireMultiplier(() => undefined, 'BTC_USDT')
    } catch (e) {
      expect((e as { problem?: { name: string } }).problem?.name).toBe('DATA_UNAVAILABLE')
    }
  })

  it('38. multipliersOf：只在 name 非空且乘数为正时进表，含下市中的合约', () => {
    const map = multipliersOf([
      { name: 'BTC_USDT', quanto_multiplier: '0.0001' },
      { name: 'OLD_USDT', quanto_multiplier: '0.01', in_delisting: true },
      { name: '', quanto_multiplier: '1' },
      { name: 'BAD_USDT', quanto_multiplier: '0' },
      null,
    ])
    expect([...map.entries()]).toEqual([['BTC_USDT', '0.0001'], ['OLD_USDT', '0.01']])
    expect(multipliersOf('nope').size).toBe(0)
  })

  it('39. orderStatusWord：open / partially_filled / filled / cancelled', () => {
    expect(orderStatusWord({ status: 'open', size: '100', left: '100' })).toBe('open')
    expect(orderStatusWord({ status: 'open', size: '100', left: '40' })).toBe('partially_filled')
    expect(orderStatusWord({ status: 'finished', finish_as: 'filled', size: '100', left: '0' })).toBe('filled')
    expect(orderStatusWord({ status: 'finished', finish_as: 'ioc', size: '100', left: '40' })).toBe('cancelled')
    expect(orderStatusWord({ status: 'weird' })).toBe('weird')
  })

  it('40. priceOrderIdOf 带 po: 前缀；空 id 返回 undefined', () => {
    expect(priceOrderIdOf({ id_string: '2111713079019438081' })).toBe(`${PRICE_ORDER_PREFIX}2111713079019438081`)
    expect(priceOrderIdOf({ id: 7 })).toBe('po:7')
    expect(priceOrderIdOf({})).toBeUndefined()
  })

  it('41. 触发单行：方向 / rule / 市价 / 限价', () => {
    const row = (over: Record<string, unknown> = {}): Parameters<typeof parsePriceOrder>[0] => ({
      id_string: '9', status: 'open', order_type: 'plan-close-long-position',
      initial: { contract: 'BTC_USDT', size: -100, price: '0', is_reduce_only: true },
      trigger: { price: '90', rule: 2 }, ...over,
    })
    const sell = parsePriceOrder(row(), NOW, decimalOf('0.0001'), () => null)!
    expect(sell).toMatchObject({ venueOrderId: 'po:9', side: 'sell', type: 'stop_market', price: null, triggerPrice: '90', size: '0.01', reduceOnly: true, isTrigger: true })
    expect(parsePriceOrder(row({ trigger: { price: '110', rule: 1 } }), NOW, decimalOf('0.0001'), () => null)!.type).toBe('take_market')
    const limit = parsePriceOrder(row({ initial: { contract: 'BTC_USDT', size: -100, price: '95', is_reduce_only: true }, trigger: { price: '90', rule: 2 } }), NOW, decimalOf('0.0001'), () => null)!
    expect(limit.type).toBe('stop_limit')
    expect(limit.price).toBe('95')
    const buy = parsePriceOrder(row({ initial: { contract: 'BTC_USDT', size: 100, price: '0' }, order_type: '', trigger: { price: '110', rule: 1 } }), NOW, decimalOf('0.0001'), () => null)!
    expect(buy.side).toBe('buy')
    expect(buy.type).toBe('stop_market')
    expect(buy.reduceOnly).toBe(false)
  })

  it('42. parsePriceOrders：逐行要乘数、带上备忘里的客户端号、按创建时间升序', () => {
    const rows = [
      { id_string: '2', create_time: 1_791_483_421, initial: { contract: 'BTC_USDT', size: 100, price: '0' }, trigger: { price: '110', rule: 1 } },
      { id_string: '1', create_time: 1_791_483_420, initial: { contract: 'ETH_USDT', size: -1, price: '0' }, trigger: { price: '90', rule: 2 } },
      { id_string: '3', create_time: 1_791_483_422, initial: { size: 1 } },
    ]
    const of = (c: string): ReturnType<typeof decimalOf> | undefined => (c === 'BTC_USDT' ? decimalOf('0.0001') : c === 'ETH_USDT' ? decimalOf('0.01') : undefined)
    const list = parsePriceOrders(rows, NOW, of, (id) => (id === 'po:1' ? 'cid-1' : null))
    expect(list.map((o) => o.venueOrderId)).toEqual(['po:1', 'po:2'])
    expect(list[0]!.clientOrderId).toBe('cid-1')
    expect(list[0]!.size).toBe('0.01')
    expect(() => parsePriceOrders([{ id_string: '4', initial: { contract: 'NOPE_USDT', size: 1, price: '0' }, trigger: { price: '1', rule: 1 } }], NOW, of, () => null)).toThrow(/quanto_multiplier unknown/)
  })

  it('43. priceOrderStatusWord：open = untriggered，finished 按 finish_as 细分', () => {
    expect(priceOrderStatusWord('open', '')).toBe('untriggered')
    expect(priceOrderStatusWord('finished', 'succeeded')).toBe('triggered')
    expect(priceOrderStatusWord('finished', 'cancelled')).toBe('cancelled')
    expect(priceOrderStatusWord('finished', 'expired')).toBe('expired')
    expect(priceOrderStatusWord('finished', 'failed')).toBe('rejected')
    expect(priceOrderStatusWord('invalid', '')).toBe('rejected')
  })

  it('44. isLiquidationText 只认 Gate 的两个保留值', () => {
    expect(isLiquidationText('liquidation')).toBe(true)
    expect(isLiquidationText('auto_deleveraging')).toBe(true)
    expect(isLiquidationText('t-open-1')).toBe(false)
    expect(isLiquidationText(undefined)).toBe(false)
  })

  it('45. parseFill：有 create_time_ms 时用它，强平文本带 liquidation', () => {
    const f = parseFill({ id: 'x', contract: 'BTC_USDT', size: '-60', create_time: 1, create_time_ms: 1_791_483_421_250, text: 'liquidation' }, NOW, decimalOf('0.0001'))!
    expect(f.ts).toBe(1_791_483_421_250)
    expect(f.liquidation).toBe(true)
    expect(parseFill({ id: 'y', contract: 'BTC_USDT', size: '1', text: 't-x' }, NOW, decimalOf('0.0001'))!.liquidation).toBeUndefined()
  })
})
