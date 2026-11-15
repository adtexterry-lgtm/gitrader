// SPDX-License-Identifier: CPAL-1.0
// 交易动作：下单 / 撤单 / 全撤 / 改单 / 杠杆 / 保护单 / 死人开关。全部离线（假服务器复算签名并校验方法与必填参数）。
import { describe, expect, it } from 'vitest'
import type { OrderIntent } from '@gitrader/protocol'
import { ProblemError } from '../src/errors'
import { ACCOUNT_ID, accountRef, fixedBudget, makeConnector, tradeContext } from './helpers/connector'
import { API_SECRET, FakeBitget, NOW, json } from './helpers/fake-bitget'

async function setup(over: Parameters<typeof makeConnector>[1] = {}) {
  const fake = new FakeBitget()
  const made = makeConnector(fake, over)
  made.connector.market.seedContracts(fake.contracts, NOW)
  made.connector.market.seedQuote('bitget:BTCUSDT', 100.1, 100.2, NOW)
  made.accounts.seedPosMode('BTCUSDT', 'one_way_mode')
  made.accounts.seedPosMode('ETHUSDT', 'one_way_mode')
  return { fake, ...made }
}

/** 测试里用宽松字面量构造意图（Decimal 是品牌类型，测试不逐个 asDecimal）。 */
function limitIntent(over: Record<string, unknown> = {}): OrderIntent {
  // 缺省 0.1 × 60000 = 6000 USDT 名义额（高于 minTradeUSDT 5）
  return { accountId: ACCOUNT_ID, instrumentId: 'bitget:BTCUSDT', side: 'buy', type: 'limit', size: '0.1', price: '60000', ...over } as unknown as OrderIntent
}

describe('submit · 普通委托', () => {
  it('限价单 → POST place-order，回执 open + 上游 orderId', async () => {
    const { fake, trading } = await setup()
    const result = await trading.submit(tradeContext(), [limitIntent({ clientOrderId: 'gtorder1' })])
    const call = fake.callsFor('POST', '/api/v2/mix/order/place-order')[0]!
    const body = JSON.parse(call.body) as Record<string, string>
    expect(body['symbol']).toBe('BTCUSDT')
    expect(body['productType']).toBe('USDT-FUTURES')
    expect(body['marginCoin']).toBe('USDT')
    expect(body['orderType']).toBe('limit')
    expect(body['price']).toBe('60000')
    expect(body['size']).toBe('0.1')
    expect(body['force']).toBe('gtc')
    expect(body['side']).toBe('buy')
    expect(body['reduceOnly']).toBe('NO')
    expect(body['clientOid']).toBe('gtorder1')
    expect(result.acks[0]!.status).toBe('open')
    expect(result.acks[0]!.venueOrderId).toBe('9001')
    expect(result.acks[0]!.clientOrderId).toBe('gtorder1')
    expect(result.receiptHash).toMatch(/^[0-9a-f]{64}$/)
    expect(result.requestWeight).toBe(0)
  })
  it('回执的 receiptHash 是原始响应的 sha256 形状（64 hex）', async () => {
    const { trading } = await setup()
    const result = await trading.submit(tradeContext(), [limitIntent()])
    expect(result.receiptHash).toHaveLength(64)
  })
  it('市价意图（有报价 + maxSlippageBps）→ 发价带限价 + ioc', async () => {
    const { fake, trading } = await setup()
    await trading.submit(tradeContext(), [limitIntent({ type: 'market', price: undefined, maxSlippageBps: 50 })])
    const body = JSON.parse(fake.callsFor('POST', '/api/v2/mix/order/place-order')[0]!.body) as Record<string, string>
    expect(body['orderType']).toBe('limit')
    expect(body['force']).toBe('ioc')
    expect(body['price']).toBe('100.6')
  })
  it('市价意图缺 maxSlippageBps → 该张 rejected（不发请求）', async () => {
    const { fake, trading } = await setup()
    const result = await trading.submit(tradeContext(), [limitIntent({ type: 'market', price: undefined })])
    expect(result.acks[0]!.status).toBe('rejected')
    expect(result.acks[0]!.problem?.code).toBe(-32602)
    expect(fake.callsFor('POST', '/api/v2/mix/order/place-order')).toHaveLength(0)
  })
  it('带 tpsl 的意图 → 1004，且不发请求', async () => {
    const { fake, trading } = await setup()
    const result = await trading.submit(tradeContext(), [limitIntent({ tpsl: { stopLoss: { triggerPrice: '90' }, grouping: 'position' } })])
    expect(result.acks[0]!.status).toBe('rejected')
    expect(result.acks[0]!.problem?.name).toBe('ORDER_TYPE_UNSUPPORTED')
    expect(fake.callsFor('POST', '/api/v2/mix/order/place-order')).toHaveLength(0)
  })
  it('批量里一张坏一张好：坏的 rejected、好的照发', async () => {
    const { fake, trading } = await setup()
    const result = await trading.submit(tradeContext(), [
      limitIntent({ type: 'market', price: undefined }),
      limitIntent({ clientOrderId: 'gtgood' }),
    ])
    expect(result.acks).toHaveLength(2)
    expect(result.acks[0]!.status).toBe('rejected')
    expect(result.acks[1]!.status).toBe('open')
    expect(result.acks[1]!.intentIndex).toBe(1)
    expect(fake.callsFor('POST', '/api/v2/mix/order/place-order')).toHaveLength(1)
  })
  it('带 leverage 的意图先设杠杆再下单', async () => {
    const { fake, trading } = await setup()
    const result = await trading.submit(tradeContext(), [limitIntent({ leverage: 10, marginMode: 'cross' })])
    expect(result.acks[0]!.status).toBe('open')
    const lev = JSON.parse(fake.callsFor('POST', '/api/v2/mix/account/set-leverage')[0]!.body) as Record<string, string>
    expect(lev['leverage']).toBe('10')
    expect(lev['marginMode']).toBe('crossed')
    expect(fake.calls.findIndex((c) => c.path === '/api/v2/mix/account/set-leverage'))
      .toBeLessThan(fake.calls.findIndex((c) => c.path === '/api/v2/mix/order/place-order'))
  })
  it('杠杆设置被上游改成别的值 → 该张 rejected', async () => {
    const fake = new FakeBitget()
    fake.leverageResponse = (body) => ({ longLeverage: String(Number(body['leverage']) - 1) })
    const made = makeConnector(fake)
    made.connector.market.seedContracts(fake.contracts, NOW)
    made.connector.market.seedQuote('bitget:BTCUSDT', 100.1, 100.2, NOW)
    made.accounts.seedPosMode('BTCUSDT', 'one_way_mode')
    const result = await made.trading.submit(tradeContext(), [limitIntent({ leverage: 10 })])
    expect(result.acks[0]!.status).toBe('rejected')
    expect(result.acks[0]!.problem?.code).toBe(3001)
    expect(fake.callsFor('POST', '/api/v2/mix/order/place-order')).toHaveLength(0)
  })
})

describe('submit · 计划委托', () => {
  it('触发单 → POST place-plan-order，回执 untriggered', async () => {
    const { fake, trading } = await setup()
    const result = await trading.submit(tradeContext(), [limitIntent({ type: 'stop_market', price: undefined, triggerPrice: '90' })])
    const call = fake.callsFor('POST', '/api/v2/mix/order/place-plan-order')[0]!
    const body = JSON.parse(call.body) as Record<string, string>
    expect(body['planType']).toBe('normal_plan')
    expect(body['triggerType']).toBe('mark_price')
    expect(body['triggerPrice']).toBe('90')
    expect(body['orderType']).toBe('market')
    expect(body['executePrice']).toBeUndefined()
    expect(result.acks[0]!.status).toBe('untriggered')
    expect(result.acks[0]!.venueOrderId).toBe('9101')
  })
  it('追踪单 → place-plan-order + track_plan + callbackRatio（不发 rangeRate）', async () => {
    const { fake, trading } = await setup()
    await trading.submit(tradeContext(), [limitIntent({ type: 'trailing_stop', price: undefined, triggerPrice: '100', trailing: { callbackRatio: '0.02' } })])
    const body = JSON.parse(fake.callsFor('POST', '/api/v2/mix/order/place-plan-order')[0]!.body) as Record<string, string>
    expect(body['planType']).toBe('track_plan')
    expect(body['callbackRatio']).toBe('2')
    expect(body['rangeRate']).toBeUndefined()
  })
  it('stop_limit → orderType=limit + price（不发 executePrice）', async () => {
    const { fake, trading } = await setup()
    await trading.submit(tradeContext(), [limitIntent({ type: 'stop_limit', price: '99.5', triggerPrice: '100' })])
    const body = JSON.parse(fake.callsFor('POST', '/api/v2/mix/order/place-plan-order')[0]!.body) as Record<string, string>
    expect(body['orderType']).toBe('limit')
    expect(body['price']).toBe('99.5')
    expect(body['executePrice']).toBeUndefined()
  })
  it('计划委托提交没走 place-order（端点分流正确）', async () => {
    const { fake, trading } = await setup()
    await trading.submit(tradeContext(), [limitIntent({ type: 'take_market', price: undefined, triggerPrice: '110' })])
    expect(fake.callsFor('POST', '/api/v2/mix/order/place-order')).toHaveLength(0)
    expect(fake.callsFor('POST', '/api/v2/mix/order/place-plan-order')).toHaveLength(1)
  })
})

describe('结果未知（教训 3：3006 不重发）', () => {
  it('POST 5xx → ack unknown + 3006，且只有一次请求', async () => {
    const { fake, trading } = await setup()
    fake.fail('POST', '/api/v2/mix/order/place-order', { code: '500', msg: 'internal error' }, 502)
    const result = await trading.submit(tradeContext(), [limitIntent()])
    expect(result.acks[0]!.status).toBe('unknown')
    expect(result.acks[0]!.problem?.code).toBe(3006)
    expect(result.acks[0]!.problem?.retryable).toBe(false)
    expect(fake.callsFor('POST', '/api/v2/mix/order/place-order')).toHaveLength(1)
  })
  it('信封「System error」在 POST 上也是 3006', async () => {
    const { fake, trading } = await setup()
    fake.fail('POST', '/api/v2/mix/order/place-order', { code: '30001', msg: 'System busy, please try again later' }, 200)
    const result = await trading.submit(tradeContext(), [limitIntent()])
    expect(result.acks[0]!.status).toBe('unknown')
    expect(result.acks[0]!.problem?.code).toBe(3006)
  })
  it('408 → 3006', async () => {
    const { fake, trading } = await setup()
    fake.fail('POST', '/api/v2/mix/order/place-order', { code: '408' }, 408)
    const result = await trading.submit(tradeContext(), [limitIntent()])
    expect(result.acks[0]!.problem?.code).toBe(3006)
  })
})

describe('40774（持仓模式不匹配）重试一次', () => {
  it('第一次 40774 → 换一套持仓字段重发，第二次成功', async () => {
    const { fake, trading } = await setup()
    fake.failNext('POST', '/api/v2/mix/order/place-order', { code: '40774', msg: 'The position mode does not match' }, 200)
    const result = await trading.submit(tradeContext(), [limitIntent({ clientOrderId: 'gtretry' })])
    const calls = fake.callsFor('POST', '/api/v2/mix/order/place-order')
    expect(calls).toHaveLength(2)
    const first = JSON.parse(calls[0]!.body) as Record<string, string>
    const second = JSON.parse(calls[1]!.body) as Record<string, string>
    expect(first['reduceOnly']).toBe('NO')
    expect(first['tradeSide']).toBeUndefined()
    expect(second['tradeSide']).toBe('open')
    expect(second['reduceOnly']).toBeUndefined()
    expect(result.acks[0]!.status).toBe('open')
  })
  it('重试也只重试一次（再失败就按错误回执）', async () => {
    const { fake, trading } = await setup()
    fake.fail('POST', '/api/v2/mix/order/place-order', { code: '40774', msg: 'still mismatched' }, 200)
    const result = await trading.submit(tradeContext(), [limitIntent()])
    expect(fake.callsFor('POST', '/api/v2/mix/order/place-order')).toHaveLength(2)
    expect(result.acks[0]!.status).toBe('rejected')
    expect(result.acks[0]!.problem?.code).toBe(3001)
  })
})

describe('cancel', () => {
  it('按 venueOrderId 撤单 → POST cancel-order + orderId', async () => {
    const { fake, trading } = await setup()
    const acks = await trading.cancel(tradeContext(), [{ instrumentId: 'bitget:BTCUSDT', venueOrderId: '7001' }])
    const body = JSON.parse(fake.callsFor('POST', '/api/v2/mix/order/cancel-order')[0]!.body) as Record<string, string>
    expect(body['orderId']).toBe('7001')
    expect(body['symbol']).toBe('BTCUSDT')
    expect(body['productType']).toBe('USDT-FUTURES')
    expect(acks[0]!.ok).toBe(true)
  })
  it('按 clientOrderId 撤单 → clientOid', async () => {
    const { fake, trading } = await setup()
    await trading.cancel(tradeContext(), [{ instrumentId: 'bitget:BTCUSDT', clientOrderId: 'gtcancel1' }])
    const body = JSON.parse(fake.callsFor('POST', '/api/v2/mix/order/cancel-order')[0]!.body) as Record<string, string>
    expect(body['clientOid']).toBe('gtcancel1')
  })
  it('撤单是 POST（写成 DELETE 会被假服务器 405 挡住）', async () => {
    const { fake, trading } = await setup()
    await trading.cancel(tradeContext(), [{ instrumentId: 'bitget:BTCUSDT', venueOrderId: '7001' }])
    expect(fake.callsFor('DELETE', '/api/v2/mix/order/cancel-order')).toHaveLength(0)
    expect(fake.callsFor('POST', '/api/v2/mix/order/cancel-order')).toHaveLength(1)
  })
  it('没有 orderId / clientOrderId → INVALID_PARAMS，不发请求', async () => {
    const { fake, trading } = await setup()
    const acks = await trading.cancel(tradeContext(), [{ instrumentId: 'bitget:BTCUSDT' }])
    expect(acks[0]!.ok).toBe(false)
    expect(acks[0]!.problem?.code).toBe(-32602)
    expect(fake.callsFor('POST', '/api/v2/mix/order/cancel-order')).toHaveLength(0)
  })
  it('非法 instrumentId → INVALID_PARAMS', async () => {
    const { trading } = await setup()
    const acks = await trading.cancel(tradeContext(), [{ instrumentId: 'binance:BTCUSDT', venueOrderId: '1' }])
    expect(acks[0]!.ok).toBe(false)
    expect(acks[0]!.problem?.code).toBe(-32602)
  })
  it('上游说订单不存在 → 改打 cancel-plan-order（三族各查一次 + orderIdList）', async () => {
    const { fake, trading } = await setup()
    fake.fail('POST', '/api/v2/mix/order/cancel-order', { code: '40768', msg: 'Order does not exist' }, 400)
    const acks = await trading.cancel(tradeContext(), [{ instrumentId: 'bitget:BTCUSDT', venueOrderId: '7101' }])
    expect(fake.callsFor('POST', '/api/v2/mix/order/cancel-order')).toHaveLength(1)
    const planCalls = fake.callsFor('GET', '/api/v2/mix/order/orders-plan-pending')
    expect(planCalls).toHaveLength(3)
    expect(planCalls.map((c) => c.params.get('planType'))).toEqual(['normal_plan', 'track_plan', 'profit_loss'])
    const cancelPlan = fake.callsFor('POST', '/api/v2/mix/order/cancel-plan-order')
    expect(cancelPlan).toHaveLength(1)
    const body = JSON.parse(cancelPlan[0]!.body) as Record<string, unknown>
    expect(body['orderIdList']).toEqual([{ orderId: '7101' }])
    expect(body['planType']).toBe('normal_plan')
    expect(acks[0]!.ok).toBe(true)
  })
  it('按 clientOrderId 撤已提交的计划单 → cancel-order 0 次，cancel-plan-order 1 次', async () => {
    const { fake, trading } = await setup()
    fake.planEntrusted = {
      entrustedList: [{ orderId: '9101', clientOid: 'gtplan2', symbol: 'BTCUSDT', side: 'sell', planType: 'normal_plan', orderType: 'market', triggerPrice: '110', size: '0.1', planStatus: 'live' }],
      endId: '',
    }
    await trading.submit(tradeContext(), [limitIntent({ type: 'take_market', price: undefined, triggerPrice: '110', clientOrderId: 'gtplan2' })])
    const acks = await trading.cancel(tradeContext(), [{ instrumentId: 'bitget:BTCUSDT', clientOrderId: 'gtplan2' }])
    expect(fake.callsFor('POST', '/api/v2/mix/order/cancel-order')).toHaveLength(0)
    expect(fake.callsFor('POST', '/api/v2/mix/order/cancel-plan-order')).toHaveLength(1)
    expect(acks[0]!.ok).toBe(true)
  })
  it('撤单的 clientOid 也过 sanitizeClientOid（与下单一致）', async () => {
    const { fake, trading } = await setup()
    await trading.submit(tradeContext(), [limitIntent({ clientOrderId: 'my-order_1' })])
    await trading.cancel(tradeContext(), [{ instrumentId: 'bitget:BTCUSDT', clientOrderId: 'my-order_1' }])
    const body = JSON.parse(fake.callsFor('POST', '/api/v2/mix/order/cancel-order')[0]!.body) as Record<string, string>
    expect(body['clientOid']).toBe('myorder1')
  })
  it('cancel-plan-order 的 failureList 逐单核（ok:false + venue.message）', async () => {
    const { fake, trading } = await setup()
    fake.fail('POST', '/api/v2/mix/order/cancel-order', { code: '40768', msg: 'Order does not exist' }, 400)
    fake.cancelPlanResponse = () => ({ successList: [], failureList: [{ orderId: '7101', errorMsg: 'cancel failed', errorCode: '43025' }] })
    const acks = await trading.cancel(tradeContext(), [{ instrumentId: 'bitget:BTCUSDT', venueOrderId: '7101' }])
    expect(acks[0]!.ok).toBe(false)
    expect(acks[0]!.problem?.venue?.message).toBe('cancel failed')
  })
  it('cancel-plan-order 两表都空 → ok:false + 3006', async () => {
    const { fake, trading } = await setup()
    fake.fail('POST', '/api/v2/mix/order/cancel-order', { code: '40768', msg: 'Order does not exist' }, 400)
    fake.cancelPlanResponse = () => ({ successList: [], failureList: [] })
    const acks = await trading.cancel(tradeContext(), [{ instrumentId: 'bitget:BTCUSDT', venueOrderId: '7101' }])
    expect(acks[0]!.ok).toBe(false)
    expect(acks[0]!.problem?.code).toBe(3006)
  })
  it('计划单列表读失败 → ok:false + 该 problem', async () => {
    const { fake, trading } = await setup()
    fake.fail('POST', '/api/v2/mix/order/cancel-order', { code: '40768', msg: 'Order does not exist' }, 400)
    fake.fail('GET', '/api/v2/mix/order/orders-plan-pending', { code: '50011', msg: 'rate limit' }, 200)
    const acks = await trading.cancel(tradeContext(), [{ instrumentId: 'bitget:BTCUSDT', venueOrderId: '7101' }])
    expect(acks[0]!.ok).toBe(false)
    expect(acks[0]!.problem?.code).toBe(3003)
  })
  it('其它错误不换端点，ok=false 带上游原文', async () => {
    const { fake, trading } = await setup()
    fake.fail('POST', '/api/v2/mix/order/cancel-order', { code: '40774', msg: 'position mode mismatch' }, 200)
    const acks = await trading.cancel(tradeContext(), [{ instrumentId: 'bitget:BTCUSDT', venueOrderId: '1' }])
    expect(acks[0]!.ok).toBe(false)
    expect(acks[0]!.problem?.venue?.message).toContain('position mode')
    expect(fake.callsFor('POST', '/api/v2/mix/order/cancel-plan-order')).toHaveLength(0)
  })
})

describe('cancelAll', () => {
  it('给 symbol → 按标的模拟：cancel-all-orders 0 次，逐张 cancel-order + 计划单逐张', async () => {
    const { fake, trading } = await setup()
    const acks = await trading.cancelAll(tradeContext(), 'bitget:BTCUSDT')
    expect(fake.callsFor('POST', '/api/v2/mix/order/cancel-all-orders')).toHaveLength(0)
    const normalCancels = fake.callsFor('POST', '/api/v2/mix/order/cancel-order')
    expect(normalCancels).toHaveLength(1)
    expect((JSON.parse(normalCancels[0]!.body) as Record<string, string>)['orderId']).toBe('7001')
    const planCancels = fake.callsFor('POST', '/api/v2/mix/order/cancel-plan-order')
    expect(planCancels).toHaveLength(2)
    const planTypes = planCancels.map((c) => (JSON.parse(c.body) as Record<string, string>)['planType'])
    expect(planTypes).toEqual(['normal_plan', 'loss_plan'])
    expect(acks).toHaveLength(1)
    expect(acks[0]!.ok).toBe(true)
  })
  it('每次 cancel-plan-order 都带非空 orderIdList', async () => {
    const { fake, trading } = await setup()
    await trading.cancelAll(tradeContext(), 'bitget:BTCUSDT')
    const planCancels = fake.callsFor('POST', '/api/v2/mix/order/cancel-plan-order')
    expect(planCancels.length).toBeGreaterThan(0)
    for (const call of planCancels) {
      const body = JSON.parse(call.body) as { orderIdList?: unknown }
      expect(Array.isArray(body.orderIdList)).toBe(true)
      expect((body.orderIdList as unknown[]).length).toBeGreaterThan(0)
    }
  })
  it('计划单列表读不到 → ok:false 且 cancel-order 0 次', async () => {
    const { fake, trading } = await setup()
    fake.fail('GET', '/api/v2/mix/order/orders-plan-pending', { code: '500' }, 400)
    const acks = await trading.cancelAll(tradeContext(), 'bitget:BTCUSDT')
    expect(acks[0]!.ok).toBe(false)
    expect(fake.callsFor('POST', '/api/v2/mix/order/cancel-order')).toHaveLength(0)
  })
  it('一张 cancel-order 失败 → ok:false，message 含 "of"', async () => {
    const { fake, trading } = await setup()
    fake.fail('POST', '/api/v2/mix/order/cancel-order', { code: '40774', msg: 'nope' }, 200)
    const acks = await trading.cancelAll(tradeContext(), 'bitget:BTCUSDT')
    expect(acks[0]!.ok).toBe(false)
    expect(acks[0]!.problem?.message).toContain(' of ')
  })
  it('不给 symbol → 先读挂单，再按标的逐个全撤（不用 cancel-all-orders）', async () => {
    const { fake, trading } = await setup()
    const acks = await trading.cancelAll(tradeContext())
    expect(fake.callsFor('GET', '/api/v2/mix/order/orders-pending').length).toBeGreaterThanOrEqual(1)
    expect(fake.callsFor('POST', '/api/v2/mix/order/cancel-all-orders')).toHaveLength(0)
    expect(fake.callsFor('POST', '/api/v2/mix/order/cancel-order')).toHaveLength(1)
    expect(acks).toHaveLength(1)
    expect(acks[0]!.ok).toBe(true)
  })
})

describe('amend', () => {
  it('限价单带 venueOrderId → rejected 1004，不发请求', async () => {
    const { fake, trading } = await setup()
    const result = await trading.amend(tradeContext(), {
      instrumentId: 'bitget:BTCUSDT', venueOrderId: '7001', order: limitIntent({ price: '59000', size: '0.2' }),
    })
    expect(result.acks[0]!.status).toBe('rejected')
    expect(result.acks[0]!.problem?.code).toBe(1004)
    expect(result.acks[0]!.problem?.name).toBe('ORDER_TYPE_UNSUPPORTED')
    expect(fake.callsFor('POST', '/api/v2/mix/order/modify-order')).toHaveLength(0)
  })
  it('限价单带 clientOrderId → rejected 1004，不发请求', async () => {
    const { fake, trading } = await setup()
    const result = await trading.amend(tradeContext(), { instrumentId: 'bitget:BTCUSDT', clientOrderId: 'gtamend1', order: limitIntent() })
    expect(result.acks[0]!.status).toBe('rejected')
    expect(result.acks[0]!.problem?.code).toBe(1004)
    expect(result.acks[0]!.problem?.name).toBe('ORDER_TYPE_UNSUPPORTED')
    expect(fake.callsFor('POST', '/api/v2/mix/order/modify-order')).toHaveLength(0)
  })
  it('既无 venueOrderId 也无 clientOrderId → 一样是 rejected 1004，不发请求', async () => {
    const { fake, trading } = await setup()
    const result = await trading.amend(tradeContext(), { instrumentId: 'bitget:BTCUSDT', order: limitIntent() })
    expect(result.acks[0]!.status).toBe('rejected')
    expect(result.acks[0]!.problem?.code).toBe(1004)
    expect(result.acks[0]!.problem?.name).toBe('ORDER_TYPE_UNSUPPORTED')
    expect(fake.callsFor('POST', '/api/v2/mix/order/modify-order')).toHaveLength(0)
  })
  it('stop_market 等非 limit 类型 → 一样是 rejected 1004，不发请求', async () => {
    const { fake, trading } = await setup()
    const result = await trading.amend(tradeContext(), {
      instrumentId: 'bitget:BTCUSDT', venueOrderId: '1', order: limitIntent({ type: 'stop_market', price: undefined, triggerPrice: '90' }),
    })
    expect(result.acks[0]!.status).toBe('rejected')
    expect(result.acks[0]!.problem?.code).toBe(1004)
    expect(result.acks[0]!.problem?.name).toBe('ORDER_TYPE_UNSUPPORTED')
    expect(fake.callsFor('POST', '/api/v2/mix/order/modify-order')).toHaveLength(0)
  })
  it('两种类型 ×（给 / 不给 id）全部 rejected 1004，一条请求也不发', async () => {
    const { fake, trading } = await setup()
    const orders = [
      limitIntent({ price: '59000', size: '0.2' }),
      limitIntent({ type: 'stop_market', price: undefined, triggerPrice: '90' }),
    ]
    for (const order of orders) {
      for (const ids of [{ venueOrderId: '7001' }, { clientOrderId: 'gtamend1' }, {}]) {
        const result = await trading.amend(tradeContext(), { instrumentId: 'bitget:BTCUSDT', order, ...ids })
        expect(result.acks[0]!.status).toBe('rejected')
        expect(result.acks[0]!.problem?.code).toBe(1004)
        expect(result.acks[0]!.problem?.name).toBe('ORDER_TYPE_UNSUPPORTED')
      }
    }
    expect(fake.callsFor('POST', '/api/v2/mix/order/modify-order')).toHaveLength(0)
  })
  it('ack.clientOrderId = 净化后的 req.clientOrderId（gt-amend_1 → gtamend1）', async () => {
    const { trading } = await setup()
    const result = await trading.amend(tradeContext(), {
      instrumentId: 'bitget:BTCUSDT', clientOrderId: 'gt-amend_1', order: limitIntent({ price: '59000', size: '0.2' }),
    })
    expect(result.acks[0]!.clientOrderId).toBe('gtamend1')
  })
  it('一条请求都不发，回执里也没有 venueOrderId（不冒报新单）', async () => {
    const { fake, trading } = await setup()
    const result = await trading.amend(tradeContext(), {
      instrumentId: 'bitget:BTCUSDT', venueOrderId: '7001', clientOrderId: 'gt-amend_1', order: limitIntent({ price: '59000', size: '0.2' }),
    })
    expect(fake.calls).toHaveLength(0)
    expect(result.acks[0]!.venueOrderId).toBeNull()
    expect(result.acks[0]!.clientOrderId).toBe('gtamend1')
  })
  it('回执：requestWeight = 0，receiptHash 取自 problem.message', async () => {
    const { trading } = await setup()
    const a = await trading.amend(tradeContext(), { instrumentId: 'bitget:BTCUSDT', venueOrderId: '7001', order: limitIntent() })
    const b = await trading.amend(tradeContext(), {
      instrumentId: 'bitget:BTCUSDT', venueOrderId: '7002', order: limitIntent({ type: 'stop_market', price: undefined, triggerPrice: '90' }),
    })
    expect(a.requestWeight).toBe(0)
    expect(b.requestWeight).toBe(0)
    expect(a.receiptHash).toBe(b.receiptHash)
    expect(a.receiptHash).toHaveLength(64)
  })
})

describe('杠杆 / 死人开关 / 保护单', () => {
  it('setLeverage 成功并缓存（第二次不再请求）', async () => {
    const { fake, trading } = await setup()
    await trading.setLeverage(tradeContext(), 'bitget:BTCUSDT', 10, 'cross')
    await trading.setLeverage(tradeContext(), 'bitget:BTCUSDT', 10, 'cross')
    expect(fake.callsFor('POST', '/api/v2/mix/account/set-leverage')).toHaveLength(1)
    expect(trading.leverageState()).toEqual([{ instrumentId: 'bitget:BTCUSDT', leverage: 10, marginMode: 'cross' }])
  })
  it('杠杆实际值不符 → ProblemError 3001', async () => {
    const fake = new FakeBitget()
    fake.leverageResponse = () => ({ longLeverage: '5', shortLeverage: '5' })
    const made = makeConnector(fake)
    made.connector.market.seedContracts(fake.contracts, NOW)
    await expect(made.trading.setLeverage(tradeContext(), 'bitget:BTCUSDT', 10, 'cross'))
      .rejects.toBeInstanceOf(ProblemError)
  })
  it('杠杆 0 / 非整数 → INVALID_PARAMS', async () => {
    const { trading } = await setup()
    await expect(trading.setLeverage(tradeContext(), 'bitget:BTCUSDT', 0, 'cross'))
      .rejects.toMatchObject({ problem: { code: -32602 } })
    await expect(trading.setLeverage(tradeContext(), 'bitget:BTCUSDT', 2.5, 'cross'))
      .rejects.toMatchObject({ problem: { code: -32602 } })
  })
  it('超过标的 maxLeverage → INVALID_PARAMS（不发请求）', async () => {
    const { fake, trading } = await setup()
    await expect(trading.setLeverage(tradeContext(), 'bitget:BTCUSDT', 200, 'cross'))
      .rejects.toMatchObject({ problem: { code: -32602 } })
    expect(fake.callsFor('POST', '/api/v2/mix/account/set-leverage')).toHaveLength(0)
  })
  it('scheduleCancel → 5002 CAPABILITY_UNSUPPORTED', async () => {
    const { trading } = await setup()
    await expect(trading.scheduleCancel(tradeContext(), NOW + 60_000))
      .rejects.toMatchObject({ problem: { code: 5002 } })
  })
  it('placeProtection → 两张 place-tpsl-order（SL + TP），body 对得上', async () => {
    const { fake, trading } = await setup()
    const sent = await trading.placeProtection(tradeContext(), {
      symbol: 'BTCUSDT', holdSide: 'long', size: '0.01', stopLossPrice: '90000', takeProfitPrice: '110000', clientOrderId: 'gtp1',
    })
    const calls = fake.callsFor('POST', '/api/v2/mix/order/place-tpsl-order')
    expect(calls).toHaveLength(2)
    expect(sent.map((s) => s.role)).toEqual(['sl', 'tp'])
    const first = JSON.parse(calls[0]!.body) as Record<string, string>
    expect(first['planType']).toBe('loss_plan')
    expect(first['holdSide']).toBe('long')
    expect(first['clientOid']).toBe('gtp1sl')
  })
  it('placeProtection 逐条回报：第一条成功、第二条失败也不抛', async () => {
    const { fake, trading } = await setup()
    let n = 0
    fake.failWith.set('POST /api/v2/mix/order/place-tpsl-order', () => {
      n += 1
      return n === 1
        ? json({ code: '00000', msg: 'success', data: { orderId: 'sl1' } })
        : json({ code: '40762', msg: 'The order amount exceeds the balance' }, 400)
    })
    const sent = await trading.placeProtection(tradeContext(), {
      symbol: 'BTCUSDT', holdSide: 'long', size: '0.01', stopLossPrice: '90000', takeProfitPrice: '110000',
    })
    expect(sent).toHaveLength(2)
    expect(sent[0]!.ok).toBe(true)
    expect(sent[0]!.venueOrderId).toBe('sl1')
    expect(sent[1]!.ok).toBe(false)
    expect(sent[1]!.problem?.code).toBe(3004)
    expect(fake.callsFor('POST', '/api/v2/mix/order/place-tpsl-order')).toHaveLength(2)
  })
  it('placeProtection 两条都失败也不抛（逐条 Problem）', async () => {
    const { fake, trading } = await setup()
    fake.fail('POST', '/api/v2/mix/order/place-tpsl-order', { code: '40774', msg: 'position mode mismatch' }, 200)
    const sent = await trading.placeProtection(tradeContext(), { symbol: 'BTCUSDT', holdSide: 'long', size: '0.01', stopLossPrice: '90000', takeProfitPrice: '110000' })
    expect(sent).toHaveLength(2)
    expect(sent.every((s) => s.ok === false && s.problem !== undefined)).toBe(true)
  })
  it('错误文本里没有密钥（提交失败路径）', async () => {
    const { fake, trading } = await setup()
    fake.fail('POST', '/api/v2/mix/order/place-order', { code: '40009', msg: `bad secret ${API_SECRET}` }, 200)
    const result = await trading.submit(tradeContext(), [limitIntent()])
    const text = `${result.acks[0]!.problem?.message ?? ''} ${result.acks[0]!.problem?.venue?.message ?? ''}`
    expect(text.includes(API_SECRET)).toBe(false)
  })
  it('预算对象与 HTTP 共用（下单记进 orders 桶）', async () => {
    const fake = new FakeBitget()
    const budget = fixedBudget()
    const made = makeConnector(fake, { budget })
    made.connector.market.seedContracts(fake.contracts, NOW)
    made.connector.market.seedQuote('bitget:BTCUSDT', 100.1, 100.2, NOW)
    made.accounts.seedPosMode('BTCUSDT', 'one_way_mode')
    await made.trading.submit(tradeContext(), [limitIntent()])
    expect(budget.usage().orders.lastSec).toBe(1)
  })
})

describe('滑点参数校验（应修 4）', () => {
  it('NaN / 0 / -5 → rejected -32602，同批第二张限价单照发', async () => {
    for (const bps of [Number.NaN, 0, -5]) {
      const { fake, trading } = await setup()
      const result = await trading.submit(tradeContext(), [
        limitIntent({ type: 'market', price: undefined, maxSlippageBps: bps }),
        limitIntent({ clientOrderId: `gtok${String(bps)}` }),
      ])
      expect(result.acks).toHaveLength(2)
      expect(result.acks[0]!.status).toBe('rejected')
      expect(result.acks[0]!.problem?.code).toBe(-32602)
      expect(result.acks[1]!.status).toBe('open')
      expect(fake.callsFor('POST', '/api/v2/mix/order/place-order')).toHaveLength(1)
    }
  })
})

describe('市价参考价年龄（应修 3）', () => {
  it('报价 6 s 前 → STALE_PRICE 且 place-order 0 次', async () => {
    const { fake, trading, connector } = await setup()
    connector.market.seedQuote('bitget:BTCUSDT', 100.1, 100.2, NOW - 6_000)
    const result = await trading.submit(tradeContext(), [limitIntent({ type: 'market', price: undefined, maxSlippageBps: 50 })])
    expect(result.acks[0]!.problem?.code).toBe(2007)
    expect(fake.callsFor('POST', '/api/v2/mix/order/place-order')).toHaveLength(0)
  })
  it('报价 4 s 前 → 正常发出', async () => {
    const { fake, trading, connector } = await setup()
    connector.market.seedQuote('bitget:BTCUSDT', 100.1, 100.2, NOW - 4_000)
    const result = await trading.submit(tradeContext(), [limitIntent({ type: 'market', price: undefined, maxSlippageBps: 50 })])
    expect(result.acks[0]!.status).toBe('open')
    expect(fake.callsFor('POST', '/api/v2/mix/order/place-order')).toHaveLength(1)
  })
  it('refPriceMaxAgeMs: 10_000 时 6 s 前也发出', async () => {
    const { fake, trading, connector } = await setup({ refPriceMaxAgeMs: 10_000 })
    connector.market.seedQuote('bitget:BTCUSDT', 100.1, 100.2, NOW - 6_000)
    const result = await trading.submit(tradeContext(), [limitIntent({ type: 'market', price: undefined, maxSlippageBps: 50 })])
    expect(result.acks[0]!.status).toBe('open')
    expect(fake.callsFor('POST', '/api/v2/mix/order/place-order')).toHaveLength(1)
  })
})

describe('诊断接口', () => {
  it('mapStatus 全表可查', async () => {
    const { trading } = await setup()
    expect(trading.mapStatus('live')).toBe('open')
    expect(trading.mapStatus('filled')).toBe('filled')
    expect(trading.mapStatus('nonsense')).toBeNull()
  })
  it('budgetUsage 透传预算', async () => {
    const { trading } = await setup()
    expect(trading.budgetUsage().limit).toBe(20)
  })
  it('now() 用注入时钟', async () => {
    const { trading } = await setup()
    expect(trading.now()).toBe(NOW)
  })
  it('status 透传账户查询', async () => {
    const { trading } = await setup()
    const status = await trading.status(accountRef, { venueOrderId: '9001', symbol: 'BTCUSDT' })
    expect(status.found).toBe(true)
    expect(status.status).toBe('partially_filled')
  })
})
