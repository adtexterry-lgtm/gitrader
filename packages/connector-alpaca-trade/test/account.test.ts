// SPDX-License-Identifier: CPAL-1.0
// 账户读取（十二条 #5 #10；八条第 6 条）：账户 / 限制标志 / 持仓专用端点 / 挂单 / 成交（活动 id 去重键）/ 查单 / 启动对账。
import { describe, expect, it } from 'vitest'
import { parseActivityFill } from '../src/parse'
import { API_KEY, API_SECRET, BASE_URL, DATA_URL, FakeAlpaca, NOW, activityRow, accountRow, orderRow, positionRow } from './helpers/fake-alpaca'
import { accountRef, fixedBudget, makeConnector, problemOf } from './helpers/connector'

async function setup(over: Parameters<typeof makeConnector>[1] = {}) {
  const fake = new FakeAlpaca()
  const t = makeConnector(fake, over)
  await t.connector.start()
  return { fake, ...t }
}

describe('账户快照', () => {
  it('余额取现金、可用取 buying_power（含保证金），并标明来源 rest', async () => {
    const { accounts } = await setup()
    const snap = await accounts.accountState(accountRef)
    expect(snap.source).toBe('rest')
    expect(snap.balances[0]?.asset).toBe('USD')
    expect(snap.balances[0]?.total).toBe('10000')
    expect(snap.balances[0]?.available).toBe('20000')
    expect(snap.availableDeductsOpenOrders).toBe(false)
  })
  it('保证金快照：equity / 维持保证金 / 倍数（账户级）', async () => {
    const { accounts } = await setup()
    const snap = await accounts.accountState(accountRef)
    expect(snap.margin.equity).toBe('10500.5')
    expect(snap.margin.leverage).toBe(2)
    expect(snap.margin.valuationCcy).toBe('USD')
  })
  it('marginRatio = 维持保证金 / 权益（十进制，不是浮点）', async () => {
    const { fake, accounts } = await setup()
    fake.account = accountRow({ equity: '1000', maintenance_margin: '250' })
    const snap = await accounts.accountState(accountRef)
    expect(snap.margin.marginRatio).toBe('0.25')
  })
  it('账户限制标志原样上报（八条 #6）', async () => {
    const { accounts } = await setup()
    const r = await accounts.restrictions(accountRef)
    expect(r.daytradeCount).toBe(3)
    expect(r.patternDayTrader).toBe(false)
    expect(r.shortingEnabled).toBe(true)
    expect(r.tradingBlocked).toBe(false)
    expect(r.accountBlocked).toBe(false)
    expect(r.multiplier).toBe(2)
  })
  it('trading_blocked=true 如实上报', async () => {
    const { fake, accounts } = await setup()
    fake.account = accountRow({ trading_blocked: true })
    expect((await accounts.restrictions(accountRef)).tradingBlocked).toBe(true)
  })
  it('账户限制带 TTL 缓存（5 s 内只读一次）', async () => {
    const { fake, accounts } = await setup()
    await accounts.restrictions(accountRef)
    await accounts.restrictions(accountRef)
    expect(fake.callsFor('GET', '/v2/account')).toHaveLength(1)
  })
  it('账户缺 equity → 抛（不把空值当 0）', async () => {
    const { fake, accounts } = await setup()
    fake.account = { id: 'x', cash: '1', buying_power: '1' }
    const p = await problemOf(() => accounts.accountState(accountRef))
    expect(p.code).toBe(4001)
    expect(p.message).toContain('equity')
  })
})

describe('持仓（专用端点，教训 5）', () => {
  it('多头持仓字段齐全，且没有资金费 / 强平价（八条 #8）', async () => {
    const { accounts } = await setup()
    const positions = await accounts.positions(accountRef)
    expect(positions).toHaveLength(1)
    const pos = positions[0]!
    expect(pos.instrumentId).toBe('alpaca:AAPL')
    expect(pos.side).toBe('long')
    expect(pos.size).toBe('10')
    expect(pos.entryPrice).toBe('180')
    expect(pos.markPrice).toBe('190')
    expect(pos.notional).toBe('1900')
    expect(pos.unrealizedPnl).toBe('100')
    expect(pos.fundingSinceOpen).toBe('0')
    expect(pos.liquidationPrice).toBeNull()
    expect(pos.leverage).toBe(1)
  })
  it('空头：side=short 或负 qty 都认', async () => {
    const { fake, accounts } = await setup()
    fake.positions = [positionRow({ side: 'short', qty: '-4' }), positionRow({ symbol: 'MSFT', side: undefined, qty: '-2' })]
    const positions = await accounts.positions(accountRef)
    expect(positions.map((p) => p.side)).toEqual(['short', 'short'])
    expect(positions[0]?.size).toBe('4')
  })
  it('负数 qty 的空头 size 用字符串取绝对值（不经过 Number）', async () => {
    const { fake, accounts } = await setup()
    fake.positions = [positionRow({
      side: 'short', qty: '-0.123456789', qty_available: '-0.123456789',
      avg_entry_price: '1.000000001', current_price: '1.000000002', market_value: '-0.123456789', unrealized_pl: '-0.000000001',
    })]
    const positions = await accounts.positions(accountRef)
    expect(positions[0]?.side).toBe('short')
    expect(positions[0]?.size).toBe('0.123456789')
    expect(positions[0]?.unrealizedPnl).toBe('-0.000000001')
  })
  it('零仓位行不进持仓表', async () => {
    const { fake, accounts } = await setup()
    fake.positions = [positionRow({ qty: '0' })]
    expect(await accounts.positions(accountRef)).toHaveLength(0)
  })
  it('持仓行缺 symbol → 抛（fail closed）', async () => {
    const { fake, accounts } = await setup()
    fake.positions = [{ qty: '1' }]
    expect((await problemOf(() => accounts.positions(accountRef))).code).toBe(4001)
  })
  it('heldLongQty 只数多头，另一标的为 0', async () => {
    const { accounts } = await setup()
    expect(await accounts.heldLongQty(accountRef, 'alpaca:AAPL')).toBe('10')
    expect(await accounts.heldLongQty(accountRef, 'alpaca:MSFT')).toBe('0')
  })
  it('heldLongQty 取 qty_available（可卖量），不是名义 qty', async () => {
    const { fake, accounts } = await setup()
    fake.positions = [positionRow({ qty: '10', qty_available: '0' })]
    expect(await accounts.heldLongQty(accountRef, 'alpaca:AAPL')).toBe('0')
  })
  it('heldLongQty 每次强制新拉持仓（不吃 TTL 缓存）', async () => {
    const { fake, accounts } = await setup()
    expect(await accounts.heldLongQty(accountRef, 'alpaca:AAPL')).toBe('10')
    fake.positions = []
    expect(await accounts.heldLongQty(accountRef, 'alpaca:AAPL')).toBe('0')
    expect(fake.callsFor('GET', '/v2/positions')).toHaveLength(2)
  })
  it('持仓读失败 → 清缓存并抛（不拿旧持仓判断能不能卖）', async () => {
    const { fake, accounts } = await setup()
    await accounts.positions(accountRef)
    fake.fail('GET', '/v2/positions', { message: 'internal error' }, 500)
    expect((await problemOf(() => accounts.positions(accountRef, { fresh: true }))).code).toBe(3003)
  })
})

describe('挂单', () => {
  it('挂单字段：类型 / 价格 / 数量 / 客户端单号', async () => {
    const { accounts } = await setup()
    const open = await accounts.openOrders(accountRef)
    expect(open).toHaveLength(1)
    expect(open[0]?.venueOrderId).toBe('ord-open-1')
    expect(open[0]?.clientOrderId).toBe('client-open-1')
    expect(open[0]?.type).toBe('limit')
    expect(open[0]?.price).toBe('189.5')
    expect(open[0]?.size).toBe('1')
    expect(open[0]?.reduceOnly).toBe(false)
  })
  it('按标的过滤：请求带 symbols=AAPL', async () => {
    const { fake, accounts } = await setup()
    await accounts.openOrders(accountRef, 'alpaca:AAPL')
    expect(fake.callsFor('GET', '/v2/orders')[0]?.params.get('symbols')).toBe('AAPL')
  })
  it('其它标的没有挂单', async () => {
    const { accounts } = await setup()
    expect(await accounts.openOrders(accountRef, 'alpaca:MSFT')).toHaveLength(0)
  })
  it('止损单映射成 stop_market / isTrigger', async () => {
    const { fake, accounts } = await setup()
    fake.openOrders = [orderRow({ type: 'stop', stop_price: '150', limit_price: null })]
    const open = await accounts.openOrders(accountRef)
    expect(open[0]?.type).toBe('stop_market')
    expect(open[0]?.isTrigger).toBe(true)
    expect(open[0]?.triggerPrice).toBe('150')
  })
  it('翻页用 after_order_id（after 是时间戳）', async () => {
    const { fake, accounts } = await setup()
    fake.openOrders = Array.from({ length: 600 }, (_, i) => orderRow({ id: `ord-${i}`, client_order_id: `c-${i}`, status: 'new' }))
    const open = await accounts.openOrders(accountRef)
    expect(open).toHaveLength(600)
    const calls = fake.callsFor('GET', '/v2/orders')
    expect(calls).toHaveLength(2)
    expect(calls[1]?.params.get('after_order_id')).toBe('ord-499')
    expect(calls[1]?.params.get('after')).toBeNull()
  })
  it('假服务器：非时间戳的 after 回 422', async () => {
    const fake = new FakeAlpaca()
    const res = await fake.fetch(`${BASE_URL}/v2/orders?after=ord-1`, {
      method: 'GET', headers: { 'APCA-API-KEY-ID': API_KEY, 'APCA-API-SECRET-KEY': API_SECRET },
    })
    expect(res.status).toBe(422)
    expect((await res.json() as { code: number }).code).toBe(42210000)
  })
})

describe('成交（account activities FILL，活动 id 作去重键）', () => {
  it('一行 FILL → VenueFill，venueFillId = order_id + cum_qty', async () => {
    const { accounts } = await setup()
    const fills = await accounts.fills(accountRef, NOW - 3_600_000)
    expect(fills).toHaveLength(1)
    const fill = fills[0]!
    expect(fill.venueFillId).toBe('ord-fill-1:5')
    expect(fill.venueOrderId).toBe('ord-fill-1')
    expect(fill.instrumentId).toBe('alpaca:AAPL')
    expect(fill.side).toBe('buy')
    expect(fill.size).toBe('5')
    expect(fill.price).toBe('190.01')
    expect(fill.fee).toBe('0')
    expect(fill.feeCcy).toBe('USD')
    expect(fill.liquidity).toBe('taker')
  })
  it('请求带 activity_types=FILL / direction=asc / after=<秒级 ISO>', async () => {
    const { fake, accounts } = await setup()
    await accounts.fills(accountRef, NOW - 60_000 + 789)
    const call = fake.callsFor('GET', '/v2/account/activities')[0]
    expect(call?.params.get('activity_types')).toBe('FILL')
    expect(call?.params.get('direction')).toBe('asc')
    expect(call?.params.get('after')).toBe('2026-10-21T13:59:00Z')
    expect(call?.params.get('after')).not.toContain('.')
  })
  it('重复活动 id 只入账一次（去重键生效）', async () => {
    const { fake, accounts } = await setup()
    fake.activities = [activityRow(), activityRow({ price: '190.02' })]
    const fills = await accounts.fills(accountRef, 0)
    expect(fills).toHaveLength(1)
  })
  it('超过 page_size 时按 page_token 翻页', async () => {
    const { fake, accounts } = await setup()
    fake.activities = Array.from({ length: 150 }, (_, i) => activityRow({
      id: `act-${i}`,
      order_id: `ord-${i}`,
      cum_qty: String(i + 1),
      transaction_time: new Date(NOW - 100_000 + i * 1000).toISOString(),
    }))
    const fills = await accounts.fills(accountRef, 0)
    expect(fills).toHaveLength(150)
    const calls = fake.callsFor('GET', '/v2/account/activities')
    expect(calls).toHaveLength(2)
    expect(calls[1]?.params.get('page_token')).toBe('act-99')
  })
  it('按时间升序返回', async () => {
    const { fake, accounts } = await setup()
    fake.activities = [
      activityRow({ id: 'a', order_id: 'ord-a', cum_qty: '5', transaction_time: new Date(NOW).toISOString() }),
      activityRow({ id: 'b', order_id: 'ord-b', cum_qty: '5', transaction_time: new Date(NOW - 5000).toISOString() }),
    ]
    const fills = await accounts.fills(accountRef, 0)
    expect(fills.map((f) => f.venueFillId)).toEqual(['ord-b:5', 'ord-a:5'])
  })
  it('FILL 缺 id → 抛（坏行不静默）', async () => {
    const { fake, accounts } = await setup()
    fake.activities = [{ activity_type: 'FILL', symbol: 'AAPL', qty: '1', price: '1', order_id: 'o' }]
    expect((await problemOf(() => accounts.fills(accountRef, 0))).code).toBe(4001)
  })
  it('极小成交量原样保留（不经过 Number）', async () => {
    const { fake, accounts } = await setup()
    fake.activities = [activityRow({ qty: '0.000000001', cum_qty: '0.000000001' })]
    const fills = await accounts.fills(accountRef, 0)
    expect(fills[0]?.size).toBe('0.000000001')
    expect(fills[0]?.venueFillId).toBe('ord-fill-1:0.000000001')
  })
  it('FILL 缺 cum_qty → parseActivityFill 直接抛 TypeError', () => {
    expect(() => parseActivityFill({
      id: 'act-x', activity_type: 'FILL', transaction_time: '2026-10-21T13:35:00Z', price: '190', qty: '1',
      side: 'buy', symbol: 'AAPL', order_id: 'ord-x',
    }, { now: NOW })).toThrow(TypeError)
  })
})

describe('查单与启动对账', () => {
  it('按 venueOrderId 查：found + 协议状态词', async () => {
    const { accounts } = await setup()
    const st = await accounts.orderStatus(accountRef, { venueOrderId: 'ord-open-1' })
    expect(st.found).toBe(true)
    expect(st.status).toBe('open')
    expect(st.filledSize).toBe('0')
  })
  it('calculated：成交量够 qty → filled，不够 → expired', async () => {
    const { fake, accounts } = await setup()
    fake.openOrders = [orderRow({ id: 'calc-full', status: 'calculated', qty: '10', filled_qty: '10' })]
    expect((await accounts.orderStatus(accountRef, { venueOrderId: 'calc-full' })).status).toBe('filled')
    fake.openOrders = [orderRow({ id: 'calc-part', status: 'calculated', qty: '10', filled_qty: '4' })]
    expect((await accounts.orderStatus(accountRef, { venueOrderId: 'calc-part' })).status).toBe('expired')
  })
  it('replaced 但没有 replaced_by → 3003（不把 replaced 当终态）', async () => {
    const { fake, accounts } = await setup()
    fake.openOrders = [orderRow({ id: 'ord-old', client_order_id: 'client-old', status: 'replaced' })]
    const problem = await problemOf(() => accounts.orderStatus(accountRef, { clientOrderId: 'client-old' }))
    expect(problem.code).toBe(3003)
    expect(problem.retryable).toBe(true)
  })
  it('按 clientOrderId 查走官方 by_client_order_id 端点', async () => {
    const { fake, accounts } = await setup()
    const st = await accounts.orderStatus(accountRef, { clientOrderId: 'client-open-1' })
    expect(st.found).toBe(true)
    expect(fake.callsFor('GET', '/v2/orders:by_client_order_id')[0]?.params.get('client_order_id')).toBe('client-open-1')
  })
  it('查不到 → found:false（不抛）', async () => {
    const { accounts } = await setup()
    expect(await accounts.orderStatus(accountRef, { clientOrderId: 'nope' })).toEqual({ found: false })
  })
  it('两个键都没给 → INVALID_PARAMS', async () => {
    const { accounts } = await setup()
    expect((await problemOf(() => accounts.orderStatus(accountRef, {}))).code).toBe(-32602)
  })
  it('启动对账：账户 + 挂单 + 成交，truncated=false', async () => {
    const { accounts } = await setup()
    const snap = await accounts.startupSnapshot(accountRef, NOW - 86_400_000)
    expect(snap.account.balances[0]?.asset).toBe('USD')
    expect(snap.openOrders).toHaveLength(1)
    expect(snap.fills).toHaveLength(1)
    expect(snap.fillsSince).toBe(NOW - 86_400_000)
    expect(snap.truncated).toBe(false)
  })
  it('成交命中翻页上限 → truncated=true', async () => {
    const { fake, accounts } = await setup()
    fake.activities = Array.from({ length: 5000 }, (_, i) => activityRow({ id: `act-${i}`, order_id: `ord-${i}`, cum_qty: String(i + 1) }))
    const snap = await accounts.startupSnapshot(accountRef, 0)
    expect(snap.truncated).toBe(true)
  })
})

describe('日历加载用注入时钟', () => {
  it('load 的日期窗口与 loadedAt 都走构造注入的时钟', async () => {
    const { AlpacaCalendar } = await import('../src/calendar')
    const { AlpacaHttp } = await import('../src/rest')
    const fake = new FakeAlpaca()
    const http = new AlpacaHttp({
      mode: 'paper', baseUrl: BASE_URL, dataBaseUrl: DATA_URL, apiKey: API_KEY, apiSecret: API_SECRET,
      fetchImpl: fake.fetch, clock: () => NOW, budget: fixedBudget(),
    })
    const calendar = new AlpacaCalendar(http, 6 * 60 * 60_000, () => NOW)
    await calendar.load()
    const call = fake.callsFor('GET', '/v2/calendar')[0]
    expect(call?.params.get('start')).toBe('2026-10-14')
    expect(call?.params.get('end')).toBe('2026-11-04')
    expect(calendar.loadedAt()).toBe(NOW)
  })
})
