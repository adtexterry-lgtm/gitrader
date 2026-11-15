// SPDX-License-Identifier: CPAL-1.0
// 账户读取：持仓（专用端点）/ 余额与保证金 / 挂单（普通 + 计划）/ 成交（去重）/ 单状态 / 启动对账。
import { describe, expect, it } from 'vitest'
import type { OrderIntent } from '@gitrader/protocol'
import { parseAccount, parseEntrustedPage, parseFill, parseFills, parseOrderDetail, parsePosition, parsePositions } from '../src/parse'
import { ProblemError } from '../src/errors'
import { feeBreakdown, feeStorage } from '../src/fees'
import { ACCOUNT_ID, accountRef, makeConnector, tradeContext } from './helpers/connector'
import { FakeBitget, NOW, json } from './helpers/fake-bitget'

const ctx = { accountId: ACCOUNT_ID, now: NOW }

describe('持仓解析（/position/all-position 的真实形状）', () => {
  it('多头行：side=long、size=total、名义额=mark×size', () => {
    const p = parsePosition({
      symbol: 'BTCUSDT', holdSide: 'long', total: '0.010', avgPx: '99000', markPrice: '100000',
      unrealizedPL: '10', achievedProfits: '2', leverage: '10', marginSize: '99', keepMarginRate: '0.004',
      liquidationPrice: '90000', marginMode: 'crossed', cTime: String(NOW - 60_000), uTime: String(NOW - 1_000),
    }, ctx)!
    expect(p.side).toBe('long')
    expect(p.size).toBe('0.01')
    expect(p.entryPrice).toBe('99000')
    expect(p.markPrice).toBe('100000')
    expect(p.notional).toBe('1000')
    expect(p.unrealizedPnl).toBe('10')
    expect(p.realizedPnl).toBe('2')
    expect(p.leverage).toBe(10)
    expect(p.marginMode).toBe('cross')
    expect(p.initialMargin).toBe('99')
    expect(p.maintenanceMargin).toBe('4')
    expect(p.liquidationPrice).toBe('90000')
    expect(p.fundingSinceOpen).toBe('0')
    expect(p.openedAt).toBe(NOW - 60_000)
    expect(p.updatedAt).toBe(NOW - 1_000)
  })
  it('空头行：total 负数 → side=short、size 取绝对值', () => {
    const p = parsePosition({ symbol: 'ETHUSDT', holdSide: 'short', total: '-2.5', avgPx: '3100', markPrice: '3000', marginMode: 'isolated' }, ctx)!
    expect(p.side).toBe('short')
    expect(p.size).toBe('2.5')
    expect(p.notional).toBe('7500')
    expect(p.marginMode).toBe('isolated')
  })
  it('holdSide=net：按 total 符号判方向', () => {
    expect(parsePosition({ symbol: 'BNBUSDT', holdSide: 'net', total: '5', markPrice: '610' }, ctx)!.side).toBe('long')
    expect(parsePosition({ symbol: 'BNBUSDT', holdSide: 'net', total: '-5', markPrice: '610' }, ctx)!.side).toBe('short')
  })
  it('total=0 的行被跳过（零仓位不在协议持仓里）', () => {
    expect(parsePosition({ symbol: 'XRPUSDT', holdSide: 'long', total: '0' }, ctx)).toBeUndefined()
  })
  it('没有 symbol 的行被跳过', () => {
    expect(parsePosition({ holdSide: 'long', total: '1' }, ctx)).toBeUndefined()
  })
  it('liquidationPrice=0 → null（不是 0）', () => {
    expect(parsePosition({ symbol: 'BTCUSDT', total: '1', markPrice: '100', liquidationPrice: '0' }, ctx)!.liquidationPrice).toBeNull()
  })
  it('缺 leverage 时回落 1（协议要求 ≥ 1）', () => {
    expect(parsePosition({ symbol: 'BTCUSDT', total: '1', markPrice: '100' }, ctx)!.leverage).toBe(1)
  })
  it('多个持仓一起解析，零仓位被过滤', () => {
    const rows = [
      { symbol: 'BTCUSDT', holdSide: 'long', total: '0.01', markPrice: '100000' },
      { symbol: 'ETHUSDT', holdSide: 'short', total: '-1', markPrice: '3000' },
      { symbol: 'XRPUSDT', holdSide: 'long', total: '0' },
    ]
    expect(parsePositions(rows, ctx).map((p) => p.instrumentId)).toEqual(['bitget:BTCUSDT', 'bitget:ETHUSDT'])
  })
  it('非数组输入 → 空数组（不崩）', () => {
    expect(parsePositions(null, ctx)).toEqual([])
  })
})

describe('账户 / 保证金', () => {
  it('余额取 available，总权益取 accountEquity', () => {
    const parsed = parseAccount([
      { marginCoin: 'USDT', accountEquity: '1020.5', available: '900.25', locked: '120.25', unrealizedPL: '20.5' },
      { marginCoin: 'BGB', accountEquity: '3', available: '3', locked: '0' },
    ], ctx)
    expect(parsed.balances).toHaveLength(2)
    expect(parsed.balances[0]).toMatchObject({ asset: 'USDT', total: '1020.5', available: '900.25', hold: '120.25' })
    expect(parsed.margin.valuationCcy).toBe('USDT')
    expect(parsed.margin.available).toBe('900.25')
  })
  it('equity 直接用 accountEquity（上游已含未实现盈亏，不重复叠加）', () => {
    const parsed = parseAccount([{ marginCoin: 'USDT', accountEquity: '1020.5', unrealizedPL: '20.5' }], ctx)
    expect(parsed.margin.equity).toBe('1020.5')
  })
  it('初始 / 维持保证金由持仓汇总', () => {
    const positions = parsePositions([
      { symbol: 'BTCUSDT', holdSide: 'long', total: '0.01', markPrice: '100000', marginSize: '99', keepMarginRate: '0.004' },
      { symbol: 'ETHUSDT', holdSide: 'short', total: '-2.5', markPrice: '3000', marginSize: '375', keepMarginRate: '0.005' },
    ], ctx)
    const parsed = parseAccount([{ marginCoin: 'USDT', accountEquity: '1000' }], ctx, positions)
    expect(parsed.margin.initialMargin).toBe('474')
    expect(parsed.margin.maintenanceMargin).toBe('41.5')
    expect(parsed.margin.leverage).toBe(1)
  })
  it('保证金率 = 维持保证金 / 权益', () => {
    const positions = parsePositions([{ symbol: 'BTCUSDT', holdSide: 'long', total: '0.01', markPrice: '100000', keepMarginRate: '0.05' }], ctx)
    const parsed = parseAccount([{ marginCoin: 'USDT', accountEquity: '1000' }], ctx, positions)
    expect(parsed.margin.maintenanceMargin).toBe('50')
    expect(parsed.margin.marginRatio).toBe('0.05')
  })
  it('权益为 0 时保证金率为 0（不除零）', () => {
    const parsed = parseAccount([{ marginCoin: 'USDT', accountEquity: '0' }], ctx)
    expect(parsed.margin.marginRatio).toBe('0')
  })
  it('没有 USDT 行时余额为空但不崩', () => {
    const parsed = parseAccount([{ marginCoin: 'BGB', accountEquity: '1' }], ctx)
    expect(parsed.margin.equity).toBe('0')
    expect(parsed.balances).toHaveLength(1)
  })
  it('单个对象（非数组）也认', () => {
    const parsed = parseAccount({ marginCoin: 'USDT', accountEquity: '5' }, ctx)
    expect(parsed.balances[0]?.total).toBe('5')
  })
  it('available 缺失时回落 crossedMaxAvailable', () => {
    const parsed = parseAccount([{ marginCoin: 'USDT', accountEquity: '10', crossedMaxAvailable: '8' }], ctx)
    expect(parsed.margin.available).toBe('8')
  })
})

describe('挂单', () => {
  it('普通挂单：size 减去已成交、类型与减仓标记', () => {
    const parsed = parseEntrustedPage({
      entrustedList: [
        { orderId: '7001', clientOid: 'c1', symbol: 'BTCUSDT', side: 'buy', orderType: 'limit', price: '99000', size: '0.01', baseVolume: '0.004', reduceOnly: 'NO', cTime: String(NOW - 1_000) },
      ],
      endId: '',
    }, NOW)
    expect(parsed.orders).toHaveLength(1)
    const order = parsed.orders[0]!
    expect(order.venueOrderId).toBe('7001')
    expect(order.clientOrderId).toBe('c1')
    expect(order.type).toBe('limit')
    expect(order.size).toBe('0.006')
    expect(order.origSize).toBe('0.01')
    expect(order.reduceOnly).toBe(false)
    expect(order.isTrigger).toBe(false)
    expect(order.createdAt).toBe(NOW - 1_000)
  })
  it('计划委托：planType → 类型映射 + isTrigger=true', () => {
    const parsed = parseEntrustedPage({ entrustedList: [{ orderId: '1', symbol: 'BTCUSDT', side: 'sell', planType: 'normal_plan', triggerPrice: '88000', size: '0.01' }], endId: '' }, NOW)
    const order = parsed.orders[0]!
    expect(order.isTrigger).toBe(true)
    expect(order.triggerPrice).toBe('88000')
    expect(order.price).toBeNull()
  })
  it('loss_plan / profit_plan 映射成 stop_market / take_market', () => {
    expect(parseEntrustedPage([{ orderId: '1', symbol: 'BTCUSDT', planType: 'loss_plan', size: '1' }], NOW).orders[0]!.type).toBe('stop_market')
    expect(parseEntrustedPage([{ orderId: '1', symbol: 'BTCUSDT', planType: 'profit_plan', size: '1' }], NOW).orders[0]!.type).toBe('take_market')
  })
  it('reduceOnly=YES / tradeSide=close 都算减仓', () => {
    expect(parseEntrustedPage([{ orderId: '1', symbol: 'B', reduceOnly: 'YES', size: '1' }], NOW).orders[0]!.reduceOnly).toBe(true)
    expect(parseEntrustedPage([{ orderId: '1', symbol: 'B', tradeSide: 'close', size: '1' }], NOW).orders[0]!.reduceOnly).toBe(true)
  })
  it('缺 orderId 但有 clientOid 也能成行', () => {
    expect(parseEntrustedPage([{ clientOid: 'c9', symbol: 'B', size: '1' }], NOW).orders[0]!.venueOrderId).toBe('c9')
  })
  it('两者都没有 → 跳过', () => {
    expect(parseEntrustedPage([{ symbol: 'B', size: '1' }], NOW).orders).toEqual([])
  })
  it('endId 带回（分页游标）', () => {
    expect(parseEntrustedPage({ entrustedList: [], endId: '777' }, NOW).endId).toBe('777')
  })
  it('entrustedList=null 当作空', () => {
    expect(parseEntrustedPage({ entrustedList: null, endId: '' }, NOW).orders).toEqual([])
  })
  it('响应没有 entrustedList 键 → 报 3003（不当作空表）', () => {
    for (const bad of [{}, null]) {
      try {
        parseEntrustedPage(bad, NOW)
        throw new Error('expected a throw')
      } catch (e) {
        expect(e).toBeInstanceOf(ProblemError)
        expect((e as ProblemError).problem).toMatchObject({ code: 3003, retryable: true })
      }
    }
  })
  it('rows 带回原始对象行（供计划单撑单 / 查单用）', () => {
    const parsed = parseEntrustedPage([{ orderId: '1', symbol: 'BTCUSDT', planType: 'normal_plan', size: '1' }], NOW)
    expect(parsed.rows).toHaveLength(1)
    expect(parsed.rows[0]!.planType).toBe('normal_plan')
  })
  it('tpsl 计划行（loss_plan）算减仓：reduceOnly=true / stop_market / isTrigger', () => {
    const order = parseEntrustedPage([{ orderId: '7201', symbol: 'BTCUSDT', planType: 'loss_plan', triggerPrice: '85000', size: '0.01' }], NOW).orders[0]!
    expect(order.reduceOnly).toBe(true)
    expect(order.type).toBe('stop_market')
    expect(order.isTrigger).toBe(true)
  })
})

describe('成交', () => {
  it('单笔成交：tradeId 作去重键、feeDetail 列表扣费取反、taker', () => {
    const fill = parseFill({
      tradeId: 't-1', orderId: '9001', clientOid: 'c1', symbol: 'BTCUSDT', side: 'buy', baseVolume: '0.005',
      fillPrice: '100.1', fillTime: String(NOW - 500), profit: '0', tradeScope: 'taker',
      feeDetail: [{ feeCoin: 'USDT', totalFee: '-0.0002' }],
    }, NOW)!
    expect(fill.venueFillId).toBe('BTCUSDT:t-1')
    expect(fill.venueOrderId).toBe('9001')
    expect(fill.clientOrderId).toBe('c1')
    expect(fill.size).toBe('0.005')
    expect(fill.price).toBe('100.1')
    expect(fill.fee).toBe('0.0002')
    expect(fill.feeCcy).toBe('USDT')
    expect(fill.liquidity).toBe('taker')
    expect(fill.ts).toBe(NOW - 500)
  })
  it('REST 成交号按标的命名空间；无 tradeId 的非零成交保持空号', () => {
    const ids = ['BTCUSDT', 'ETHUSDT'].map((symbol) => parseFill({ tradeId: 'shared', symbol, baseVolume: '1', fillPrice: '1' }, NOW)!.venueFillId)
    expect(ids).toEqual(['BTCUSDT:shared', 'ETHUSDT:shared'])
    expect(parseFill({ symbol: 'BTCUSDT', baseVolume: '1', fillPrice: '1' }, NOW)!.venueFillId).toBe('')
    expect(parseFill({ symbol: 'BTCUSDT', baseVolume: '0', fillPrice: '1' }, NOW)).toBeUndefined()
  })
  it('newFees 形态：BGB 抵扣 + 收取币 → feeCcy=MIXED 且不相加（明细在逐币口径里）', () => {
    const fill = parseFill({
      tradeId: 't-2', orderId: '9001', symbol: 'BTCUSDT', side: 'buy', baseVolume: '0.005', fillPrice: '100.2',
      feeDetail: { newFees: { d: '-0.0000001', r: '-0.0001' } },
    }, NOW)!
    expect(fill.feeCcy).toBe('MIXED')
    expect(fill.fee).toBe('0')
  })
  it('maker 按 tradeScope / execType 判定', () => {
    expect(parseFill({ tradeId: 'a', symbol: 'B', baseVolume: '1', fillPrice: '1', tradeScope: 'maker' }, NOW)!.liquidity).toBe('maker')
    expect(parseFill({ tradeId: 'a', symbol: 'B', baseVolume: '1', fillPrice: '1', execType: 'M' }, NOW)!.liquidity).toBe('taker')
  })
  it('没有 tradeId 且数量为 0 → 丢弃；有 tradeId 的零数量保留（去重键仍在）', () => {
    expect(parseFill({ symbol: 'B', baseVolume: '0', fillPrice: '1' }, NOW)).toBeUndefined()
    expect(parseFill({ tradeId: 'zero', symbol: 'B', baseVolume: '0', fillPrice: '1' }, NOW)!.venueFillId).toBe('B:zero')
  })
  it('fillList 排序按时间升序', () => {
    const fills = parseFills({
      fillList: [
        { tradeId: 'b', symbol: 'B', baseVolume: '1', fillPrice: '1', fillTime: '200' },
        { tradeId: 'a', symbol: 'B', baseVolume: '1', fillPrice: '1', fillTime: '100' },
      ],
    }, NOW)
    expect(fills.map((f) => f.venueFillId)).toEqual(['B:a', 'B:b'])
  })
  it('realizedPnl 保留符号（profit 正负都原样）', () => {
    expect(parseFill({ tradeId: 'x', symbol: 'B', baseVolume: '1', fillPrice: '1', profit: '-3.5' }, NOW)!.realizedPnl).toBe('-3.5')
  })
})

describe('连接器级账户读取', () => {
  it('accountState 用持仓专用端点取持仓（教训 5）', async () => {
    const fake = new FakeBitget()
    const { accounts } = makeConnector(fake)
    const snapshot = await accounts.accountState(accountRef)
    expect(fake.callsTo('/api/v2/mix/position/all-position')).toHaveLength(1)
    expect(snapshot.positions).toHaveLength(3)
    expect(snapshot.accountModel).toBe('standard')
    expect(snapshot.source).toBe('rest')
    expect(snapshot.stale).toBe(false)
    expect(snapshot.balances[0]?.asset).toBe('USDT')
    expect(snapshot.margin.leverage).toBe(20)
  })
  it('openOrders 合并普通 + 计划委托（计划三族都查）', async () => {
    const fake = new FakeBitget()
    const { accounts } = makeConnector(fake)
    const orders = await accounts.openOrders(accountRef)
    expect(orders.map((o) => o.venueOrderId)).toEqual(['7001', '7101', '7201'])
    expect(fake.callsTo('/api/v2/mix/order/orders-pending')).toHaveLength(1)
    const planCalls = fake.callsTo('/api/v2/mix/order/orders-plan-pending')
    expect(planCalls).toHaveLength(3)
    expect(planCalls.map((c) => c.params.get('planType'))).toEqual(['normal_plan', 'track_plan', 'profit_loss'])
  })
  it('includePlanOrders=false 时不查计划委托', async () => {
    const fake = new FakeBitget()
    const { accounts } = makeConnector(fake, { accounts: { includePlanOrders: false } })
    const orders = await accounts.openOrders(accountRef)
    expect(orders).toHaveLength(1)
    expect(fake.callsTo('/api/v2/mix/order/orders-plan-pending')).toHaveLength(0)
  })
  it('按 instrumentId 过滤时把 symbol 传给上游', async () => {
    const fake = new FakeBitget()
    const { accounts } = makeConnector(fake)
    await accounts.openOrders(accountRef, 'bitget:BTCUSDT')
    const call = fake.callsTo('/api/v2/mix/order/orders-pending')[0]!
    expect(call.params.get('symbol')).toBe('BTCUSDT')
  })
  it('挂单分页：页满 100 且 endId 非空时继续，用 idLessThan 推进', async () => {
    const fake = new FakeBitget()
    const list = Array.from({ length: 100 }, (_, i) => ({
      orderId: `o${i}`, symbol: 'BTCUSDT', side: 'buy', orderType: 'limit', price: '1', size: '1', status: 'live',
    }))
    let page = 0
    fake.failWith.set('GET /api/v2/mix/order/orders-pending', () => {
      page += 1
      const body = page === 1
        ? { code: '00000', msg: 'success', data: { entrustedList: list, endId: 'cursor-1' } }
        : { code: '00000', msg: 'success', data: { entrustedList: [], endId: '' } }
      return json(body)
    })
    const { accounts } = makeConnector(fake, { accounts: { includePlanOrders: false } })
    const orders = await accounts.openOrders(accountRef)
    expect(orders).toHaveLength(100)
    const calls = fake.callsTo('/api/v2/mix/order/orders-pending')
    expect(calls).toHaveLength(2)
    expect(calls[1]!.params.get('idLessThan')).toBe('cursor-1')
  })
  it('挂单页不满 limit 就停止翻页（不等 endId 为空）', async () => {
    const fake = new FakeBitget()
    fake.entrusted = { entrustedList: [{ orderId: '1', symbol: 'BTCUSDT', side: 'buy', orderType: 'limit', price: '1', size: '1' }], endId: 'more' }
    const { accounts } = makeConnector(fake, { accounts: { includePlanOrders: false } })
    await accounts.openOrders(accountRef)
    expect(fake.callsTo('/api/v2/mix/order/orders-pending')).toHaveLength(1)
  })
  it('fills 从 sinceMs 开始（startTime / endTime 都在 query 里）', async () => {
    const fake = new FakeBitget()
    const { accounts } = makeConnector(fake)
    const fills = await accounts.fills(accountRef, NOW - 60_000)
    const call = fake.callsTo('/api/v2/mix/order/fills')[0]!
    expect(call.params.get('startTime')).toBe(String(NOW - 60_000))
    expect(call.params.get('endTime')).toBe(String(NOW))
    expect(fills).toHaveLength(2)
    expect(fills[0]!.venueFillId).toBe('BTCUSDT:t-1')
  })
  it('fills 显式标的在全量响应后精确过滤', async () => {
    const fake = new FakeBitget()
    fake.fills = {
      fillList: [
        { tradeId: 'btc-1', orderId: '1', symbol: 'BTCUSDT', side: 'buy', baseVolume: '1', fillPrice: '10', fillTime: String(NOW), feeDetail: [{ feeCoin: 'USDT', totalFee: '0' }] },
        { tradeId: 'eth-1', orderId: '2', symbol: 'ETHUSDT', side: 'buy', baseVolume: '2', fillPrice: '20', fillTime: String(NOW), feeDetail: [{ feeCoin: 'USDT', totalFee: '0' }] },
      ],
      endId: '',
    }
    const { connector } = makeConnector(fake)
    const fills = await connector.fills(accountRef, NOW - 60_000, { instrumentId: 'bitget:BTCUSDT' })
    expect(fills.map((fill) => fill.venueFillId)).toEqual(['BTCUSDT:btc-1'])
  })
  it('fills 按 tradeId 去重（翻页重叠不会重复入账）', async () => {
    const fake = new FakeBitget()
    const fill = { tradeId: 'dup', orderId: '1', symbol: 'BTCUSDT', side: 'buy', baseVolume: '1', fillPrice: '1' }
    fake.fills = { fillList: [fill, fill], endId: '' }
    const { accounts } = makeConnector(fake)
    expect(await accounts.fills(accountRef, 0)).toHaveLength(1)
  })
  it('fills 缺 endId 且恰满页时用原始 tradeId 请求下一页', async () => {
    const fake = new FakeBitget()
    fake.fills = {
      fillList: Array.from({ length: 100 }, (_, i) => ({
        tradeId: `raw:${i}`, orderId: '1', symbol: 'BTCUSDT', side: 'buy', baseVolume: '1', fillPrice: '1', fillTime: String(i + 1),
      })),
    }
    const { accounts } = makeConnector(fake)
    await accounts.fills(accountRef, 0)
    const calls = fake.callsTo('/api/v2/mix/order/fills')
    expect(calls).toHaveLength(2)
    expect(calls[1]!.params.get('idLessThan')).toBe('raw:99')
  })
  it('orderStatus：找到时带上游原状态（不翻译）', async () => {
    const fake = new FakeBitget()
    const { accounts } = makeConnector(fake)
    const status = await accounts.orderStatus(accountRef, { venueOrderId: '9001', symbol: 'BTCUSDT' })
    expect(status.found).toBe(true)
    expect(status.status).toBe('partially_filled')
    expect(status.filledSize).toBe('0.003')
  })
  it('orderStatus 由 instrumentId 提供重启后所需的 symbol', async () => {
    const fake = new FakeBitget()
    const { connector } = makeConnector(fake)
    const status = await connector.orderStatus(accountRef, { venueOrderId: '9001', instrumentId: 'bitget:BTCUSDT' })
    expect(status.found).toBe(true)
    expect(fake.callsTo('/api/v2/mix/order/detail')[0]!.params.get('symbol')).toBe('BTCUSDT')
  })
  it('orderStatus：上游说订单不存在 → found=false（不抛错）', async () => {
    const fake = new FakeBitget()
    fake.fail('GET', '/api/v2/mix/order/detail', { code: '40701', msg: 'Order does not exist' }, 200)
    const { accounts } = makeConnector(fake)
    const status = await accounts.orderStatus(accountRef, { venueOrderId: '404', symbol: 'BTCUSDT' })
    expect(status.found).toBe(false)
  })
  it('orderStatus：不给任何 id → INVALID_PARAMS', async () => {
    const fake = new FakeBitget()
    const { accounts } = makeConnector(fake)
    await expect(accounts.orderStatus(accountRef, {})).rejects.toMatchObject({ problem: { code: -32602 } })
  })
  it('startupSnapshot 一次拿账户 + 挂单 + 成交', async () => {
    const fake = new FakeBitget()
    const { accounts } = makeConnector(fake)
    const snapshot = await accounts.startupSnapshot(accountRef, NOW - 3_600_000)
    expect(snapshot.account.positions.length).toBe(3)
    expect(snapshot.openOrders.length).toBe(3)
    expect(snapshot.fills.length).toBe(2)
    expect(snapshot.fillsSince).toBe(NOW - 3_600_000)
    expect(snapshot.truncated).toBe(false)
  })
  it('posMode 从 /account/account 读，并缓存（只请求一次）', async () => {
    const fake = new FakeBitget()
    const { accounts } = makeConnector(fake)
    expect(await accounts.posMode('BTCUSDT')).toBe('one_way_mode')
    expect(await accounts.posMode('BTCUSDT')).toBe('one_way_mode')
    expect(fake.callsTo('/api/v2/mix/account/account')).toHaveLength(1)
  })
  it('posMode 读失败 → 空串（不抛错，下单按单向处理）', async () => {
    const fake = new FakeBitget()
    fake.fail('GET', '/api/v2/mix/account/account', { code: '40009', msg: 'nope' }, 400)
    const { accounts } = makeConnector(fake)
    expect(await accounts.posMode('BTCUSDT')).toBe('')
  })
})

describe('订单详情：成交量不回落成均价（阻断 7）', () => {
  it('只有 priceAvg 时 filledSize = 0（不把均价当成交量）', () => {
    expect(parseOrderDetail({ orderId: '1', state: 'filled', priceAvg: '65000' }).filledSize).toBe('0')
  })
  it('优先 baseVolume，其次 filledQty（QD bitget.py:983）', () => {
    expect(parseOrderDetail({ orderId: '1', state: 'filled', baseVolume: '0.3', filledQty: '0.4' }).filledSize).toBe('0.3')
    expect(parseOrderDetail({ orderId: '1', state: 'filled', filledQty: '0.2' }).filledSize).toBe('0.2')
  })
})

describe('手续费十进制（阻断 6）', () => {
  it('feeStorage：小额 BGB 抵扣不走浮点（5e-8 形状）', () => {
    expect(feeStorage([{ feeCoin: 'USDT', totalFee: '-0.00000005' }])).toEqual({ fee: '0.00000005', feeCcy: 'USDT' })
  })
  it('同币两行用 decimal 相加（-0.1 + -0.2 → 0.3）', () => {
    expect(feeBreakdown([{ feeCoin: 'USDT', totalFee: '-0.1' }, { feeCoin: 'USDT', totalFee: '-0.2' }])).toEqual({ USDT: '0.3' })
  })
  it('newFees 双币：breakdown 逐币、storage 给 0 + MIXED（不相加）', () => {
    const raw = { newFees: { d: '-0.0000001', r: '-0.0001' } }
    expect(feeBreakdown(raw, { receivedCurrency: 'USDT' })).toEqual({ BGB: '0.0000001', USDT: '0.0001' })
    expect(feeStorage(raw, { receivedCurrency: 'USDT' })).toEqual({ fee: '0', feeCcy: 'MIXED' })
  })
  it('accounts.fills() 在一行极小额时正常返回', async () => {
    const fake = new FakeBitget()
    fake.fills = {
      fillList: [{ tradeId: 'tiny', orderId: '1', symbol: 'BTCUSDT', side: 'buy', baseVolume: '1', fillPrice: '1', feeDetail: [{ feeCoin: 'USDT', totalFee: '-0.00000005' }] }],
      endId: '',
    }
    const { accounts } = makeConnector(fake)
    const fills = await accounts.fills(accountRef, 0)
    expect(fills).toHaveLength(1)
    expect(fills[0]!.fee).toBe('0.00000005')
    expect(fills[0]!.feeCcy).toBe('USDT')
  })
})

describe('orderStatus：查单要带 symbol / 计划单走计划挂单（阻断 3）', () => {
  function setupTrading() {
    const fake = new FakeBitget()
    const made = makeConnector(fake)
    made.connector.market.seedContracts(fake.contracts, NOW)
    made.connector.market.seedQuote('bitget:BTCUSDT', 100.1, 100.2, NOW)
    made.accounts.seedPosMode('BTCUSDT', 'one_way_mode')
    return { fake, ...made }
  }
  const limitIntent = (over: Record<string, unknown> = {}): OrderIntent => ({
    accountId: ACCOUNT_ID, instrumentId: 'bitget:BTCUSDT', side: 'buy', type: 'limit', size: '0.1', price: '60000', ...over,
  } as unknown as OrderIntent)

  it('提交过的限价单按 clientOrderId 查 → detail 带 symbol + clientOid', async () => {
    const { fake, accounts, trading } = setupTrading()
    await trading.submit(tradeContext(), [limitIntent({ clientOrderId: 'gtlookup1' })])
    const status = await accounts.orderStatus(accountRef, { clientOrderId: 'gtlookup1' })
    expect(status.found).toBe(true)
    const call = fake.callsTo('/api/v2/mix/order/detail').at(-1)!
    expect(call.params.get('symbol')).toBe('BTCUSDT')
    expect(call.params.get('clientOid')).toBe('gtlookup1')
  })
  it('没提交过且不给 symbol → INVALID_PARAMS，detail 0 次请求', async () => {
    const fake = new FakeBitget()
    const { accounts } = makeConnector(fake)
    await expect(accounts.orderStatus(accountRef, { clientOrderId: 'nobody' })).rejects.toMatchObject({ problem: { code: -32602 } })
    expect(fake.callsTo('/api/v2/mix/order/detail')).toHaveLength(0)
  })
  it('给 venueOrderId + symbol：原生 symbol 与 bitget: 前缀都发 BTCUSDT', async () => {
    const fake = new FakeBitget()
    const { accounts } = makeConnector(fake)
    await accounts.orderStatus(accountRef, { venueOrderId: '9001', symbol: 'BTCUSDT' })
    await accounts.orderStatus(accountRef, { venueOrderId: '9001', symbol: 'bitget:BTCUSDT' })
    const calls = fake.callsTo('/api/v2/mix/order/detail')
    expect(calls.map((c) => c.params.get('symbol'))).toEqual(['BTCUSDT', 'BTCUSDT'])
    expect(calls[0]!.params.get('orderId')).toBe('9001')
  })
  it('40109 / 40768 → found:false；缺参 40001 → 抛出', async () => {
    const one = new FakeBitget()
    one.fail('GET', '/api/v2/mix/order/detail', { code: '40109', msg: 'The data of the order cannot be found, please confirm the order number' }, 400)
    expect((await makeConnector(one).accounts.orderStatus(accountRef, { venueOrderId: '1', symbol: 'BTCUSDT' })).found).toBe(false)
    const two = new FakeBitget()
    two.fail('GET', '/api/v2/mix/order/detail', { code: '40768', msg: 'Order does not exist' }, 400)
    expect((await makeConnector(two).accounts.orderStatus(accountRef, { venueOrderId: '1', symbol: 'BTCUSDT' })).found).toBe(false)
    const three = new FakeBitget()
    three.fail('GET', '/api/v2/mix/order/detail', { code: '40001', msg: 'Parameter does not exist: symbol' }, 400)
    await expect(makeConnector(three).accounts.orderStatus(accountRef, { venueOrderId: '1', symbol: 'BTCUSDT' }))
      .rejects.toMatchObject({ problem: { code: -32602 } })
  })
  it('计划单（submit stop_market）按 clientOrderId 查 → orders-plan-pending（planType + symbol）', async () => {
    const { fake, accounts, trading } = setupTrading()
    fake.planEntrusted = {
      entrustedList: [{ orderId: '9101', clientOid: 'gtplan9', symbol: 'BTCUSDT', side: 'sell', planType: 'normal_plan', orderType: 'market', triggerPrice: '90', size: '0.1', planStatus: 'live', status: 'live' }],
      endId: '',
    }
    await trading.submit(tradeContext(), [limitIntent({ type: 'stop_market', price: undefined, triggerPrice: '90', clientOrderId: 'gtplan9' })])
    const status = await accounts.orderStatus(accountRef, { clientOrderId: 'gtplan9' })
    expect(status.found).toBe(true)
    expect(status.venueOrderId).toBe('9101')
    const calls = fake.callsTo('/api/v2/mix/order/orders-plan-pending')
    expect(calls.every((c) => c.params.get('symbol') === 'BTCUSDT')).toBe(true)
    expect(calls.map((c) => c.params.get('planType'))).toContain('normal_plan')
    expect(fake.callsTo('/api/v2/mix/order/detail')).toHaveLength(0)
  })
  it('计划单列表里没有对应行 → found:false', async () => {
    const { fake, accounts, trading } = setupTrading()
    await trading.submit(tradeContext(), [limitIntent({ type: 'stop_market', price: undefined, triggerPrice: '90', clientOrderId: 'gtplan9' })])
    fake.planEntrusted = { entrustedList: [], endId: '' }
    const status = await accounts.orderStatus(accountRef, { clientOrderId: 'gtplan9' })
    expect(status.found).toBe(false)
  })
})
