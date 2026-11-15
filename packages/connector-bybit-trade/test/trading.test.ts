// SPDX-License-Identifier: CPAL-1.0
// 交易：下单 / 撤单 / 全撤 / 改单 / 杠杆 / 保证金模式 / 持仓级 TP-SL。
// 每个用例都打到假服务器（它复算签名 + 校验方法与必填参数），并断言发出去的 方法 / 路径 / 请求体。
import { describe, expect, it } from 'vitest'
import type { OrderIntent } from '@gitrader/protocol'
import { asProblem, ProblemError } from '../src/errors'
import { BybitAccounts } from '../src/account'
import { BybitTrading } from '../src/trading'
import { API_KEY, API_SECRET, FakeBybitTrade, NOW } from './helpers/fake-bybit-trade'
import { account, ctx, freshQuote, instrumentOf, newHttp } from './helpers/harness'

function harness(fake: FakeBybitTrade, over: { positionMode?: 'oneWay' | 'hedge'; quote?: () => { bid: number; ask: number; mid: number; stale: boolean } | undefined } = {}) {
  const http = newHttp(fake)
  const accounts = new BybitAccounts(
    { http, clock: () => NOW, instrumentOf: (id) => instrumentOf(id) },
    [API_SECRET, API_KEY],
  )
  const trading = new BybitTrading({
    http,
    instrumentOf: (id) => instrumentOf(id),
    quoteOf: () => (over.quote ? over.quote() : freshQuote()),
    openOrders: (ref, id) => accounts.openOrders(ref, id),
    orderStatus: (ref, key, opts) => accounts.orderStatus(ref, key, opts ?? {}),
    clock: () => NOW,
    ...(over.positionMode !== undefined ? { positionMode: over.positionMode } : {}),
    defaultSymbol: 'BTCUSDT',
  }, [API_SECRET, API_KEY])
  return { http, accounts, trading }
}

type LooseIntent = Partial<Omit<OrderIntent, 'size' | 'price' | 'notional' | 'triggerPrice' | 'tpsl'>> & {
  size?: string
  price?: string
  notional?: string
  triggerPrice?: string
  tpsl?: { stopLoss?: { triggerPrice: string; price?: string }; takeProfit?: { triggerPrice: string; price?: string }; grouping: 'order' | 'position' }
}

const intent = (over: LooseIntent = {}): OrderIntent => ({
  accountId: 'acc_bybit_1',
  instrumentId: 'bybit:BTCUSDT',
  side: 'buy',
  type: 'limit',
  size: '0.1',
  price: '100',
  ...over,
} as unknown as OrderIntent)

describe('submit：下单', () => {
  it('限价单打 POST /v5/order/create，回执带 venueOrderId 且状态 open', async () => {
    const fake = new FakeBybitTrade()
    const { trading } = harness(fake)
    const result = await trading.submit(ctx(), [intent({ clientOrderId: 'gt-sub-1' })])
    const call = fake.callsFor('POST', '/v5/order/create')[0]!
    expect(call.body).toMatchObject({ category: 'linear', symbol: 'BTCUSDT', side: 'Buy', orderType: 'Limit', qty: '0.1', price: '100' })
    expect(result.acks).toHaveLength(1)
    expect(result.acks[0]).toMatchObject({ intentIndex: 0, clientOrderId: 'gt-sub-1', status: 'open', builder: { attached: false } })
    expect(result.acks[0]!.venueOrderId).toMatch(/^ord-/)
    expect(result.receiptHash).toMatch(/^[0-9a-f]{64}$/)
    expect(result.requestWeight).toBe(0)
  })

  it('市价意图发 Limit + IOC（不是 Market）', async () => {
    const fake = new FakeBybitTrade()
    const { trading } = harness(fake)
    await trading.submit(ctx(), [intent({ type: 'market', size: '0.1', price: undefined, maxSlippageBps: 25 })])
    expect(fake.last()!.body).toMatchObject({ orderType: 'Limit', timeInForce: 'IOC' })
  })

  it('触发单回执状态是 untriggered（不再发 orderFilter）', async () => {
    const fake = new FakeBybitTrade()
    const { trading } = harness(fake)
    const result = await trading.submit(ctx(), [intent({ type: 'stop_market', side: 'sell', triggerPrice: '99', price: undefined, reduceOnly: true })])
    expect(result.acks[0]!.status).toBe('untriggered')
    const body = fake.last()!.body as Record<string, unknown>
    expect(body.triggerDirection).toBe(2)
    expect('orderFilter' in body).toBe(false)
  })

  it('带 tpsl 的意图回 1004，且不发任何请求', async () => {
    const fake = new FakeBybitTrade()
    const { trading } = harness(fake)
    const result = await trading.submit(ctx(), [intent({ tpsl: { stopLoss: { triggerPrice: '95' }, grouping: 'order' } })])
    expect(result.acks[0]!.status).toBe('rejected')
    expect(result.acks[0]!.problem?.code).toBe(1004)
    expect(result.acks[0]!.problem?.message).toContain('buildProtectionOrders')
    expect(fake.callsTo('/v5/order/create')).toHaveLength(0)
  })

  it('构造失败（缺 price）→ rejected ack 带 Problem，不联网', async () => {
    const fake = new FakeBybitTrade()
    const { trading } = harness(fake)
    const result = await trading.submit(ctx(), [intent({ price: undefined })])
    expect(result.acks[0]!.status).toBe('rejected')
    expect(result.acks[0]!.problem?.name).toBe('INVALID_PARAMS')
    expect(fake.callsTo('/v5/order/create')).toHaveLength(0)
  })

  it('多张意图：acks 顺序与 intentIndex 一一对应，后者失败不影响前者', async () => {
    const fake = new FakeBybitTrade()
    const { trading } = harness(fake)
    const result = await trading.submit(ctx(), [
      intent({ clientOrderId: 'gt-a' }),
      intent({ price: undefined, clientOrderId: 'gt-b' }),
      intent({ clientOrderId: 'gt-c', side: 'sell' }),
    ])
    expect(result.acks.map((a) => a.intentIndex)).toEqual([0, 1, 2])
    expect(result.acks.map((a) => a.status)).toEqual(['open', 'rejected', 'open'])
    expect(fake.callsTo('/v5/order/create')).toHaveLength(2)
  })

  it('上游 10001（params error）→ rejected ack 带 INVALID_PARAMS', async () => {
    const fake = new FakeBybitTrade()
    fake.fail('POST', '/v5/order/create', 10001, 'params error')
    const { trading } = harness(fake)
    const result = await trading.submit(ctx(), [intent()])
    expect(result.acks[0]!.status).toBe('rejected')
    expect(result.acks[0]!.problem?.name).toBe('INVALID_PARAMS')
  })

  it('上游 10000（结果未知）→ ack 状态 unknown + 3006，绝不报 rejected', async () => {
    const fake = new FakeBybitTrade()
    fake.fail('POST', '/v5/order/create', 10000, 'Server error')
    const { trading } = harness(fake)
    const result = await trading.submit(ctx(), [intent({ clientOrderId: 'gt-unknown' })])
    expect(result.acks[0]!.status).toBe('unknown')
    expect(result.acks[0]!.problem?.code).toBe(3006)
    expect(result.acks[0]!.problem?.retryable).toBe(false)
    expect(result.acks[0]!.clientOrderId).toBe('gt-unknown')
  })

  it('上游 110072（orderLinkId 重复）→ 3006，按 clientOrderId 对账', async () => {
    const fake = new FakeBybitTrade()
    fake.fail('POST', '/v5/order/create', 110072, 'OrderLinkedID is duplicate')
    const { trading } = harness(fake)
    const result = await trading.submit(ctx(), [intent({ clientOrderId: 'gt-dup' })])
    expect(result.acks[0]!.status).toBe('unknown')
    expect(result.acks[0]!.problem?.code).toBe(3006)
    expect(result.acks[0]!.problem?.retryable).toBe(false)
  })

  it('先显式setLeverage，再省略marginMode下单以沿用账户模式', async () => {
    const fake = new FakeBybitTrade()
    const { trading } = harness(fake)
    await trading.setLeverage(ctx(), 'bybit:BTCUSDT', 10, 'isolated')
    await trading.submit(ctx(), [intent({ leverage: 10 })])
    const paths = fake.calls.map((c) => `${c.method} ${c.path}`)
    expect(paths).toEqual([
      'POST /v5/account/set-margin-mode',
      'POST /v5/position/set-leverage',
      'POST /v5/order/create',
    ])
    expect(fake.callsFor('POST', '/v5/account/set-margin-mode')[0]!.body).toEqual({ setMarginMode: 'ISOLATED_MARGIN' })
    expect(fake.callsFor('POST', '/v5/position/set-leverage')[0]!.body).toEqual({
      category: 'linear', symbol: 'BTCUSDT', buyLeverage: '10', sellLeverage: '10',
    })
  })

  it('显式 marginMode 的 submit fail-closed 且不调用账户设置、杠杆或下单端点', async () => {
    const fake = new FakeBybitTrade()
    const { trading } = harness(fake)
    const result = await trading.submit(ctx(), [intent({ leverage: 10, marginMode: 'isolated' })])
    expect(result.acks[0]!.status).toBe('rejected')
    expect(result.acks[0]!.problem?.name).toBe('INVALID_PARAMS')
    expect(result.acks[0]!.problem?.message).toContain('hint: 请在场所显式确认模式并省略 marginMode 以沿用账户现状')
    expect(fake.callsTo('/v5/account/set-margin-mode')).toHaveLength(0)
    expect(fake.callsTo('/v5/position/set-leverage')).toHaveLength(0)
    expect(fake.callsTo('/v5/order/create')).toHaveLength(0)
  })

  it('意图不带 marginMode 时只设杠杆，不切账户级保证金模式', async () => {
    const fake = new FakeBybitTrade()
    const { trading } = harness(fake)
    await trading.submit(ctx(), [intent({ leverage: 5 })])
    expect(fake.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /v5/position/set-leverage',
      'POST /v5/order/create',
    ])
    expect(trading.leverageState()).toEqual([{ instrumentId: 'bybit:BTCUSDT', leverage: 5, marginMode: 'account' }])
  })

  it('reduce-only 意图不做杠杆 / 保证金配置', async () => {
    const fake = new FakeBybitTrade()
    const { trading } = harness(fake)
    await trading.submit(ctx(), [intent({ side: 'sell', reduceOnly: true, leverage: 5, marginMode: 'isolated' })])
    expect(fake.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['POST /v5/order/create'])
  })

  it('设杠杆失败 → 该张被打回，不下单', async () => {
    const fake = new FakeBybitTrade()
    fake.fail('POST', '/v5/position/set-leverage', 110013, 'risk limit exceeded')
    const { trading } = harness(fake)
    const result = await trading.submit(ctx(), [intent({ leverage: 20 })])
    expect(result.acks[0]!.status).toBe('rejected')
    expect(result.acks[0]!.problem?.code).toBe(3001)
    expect(fake.callsTo('/v5/order/create')).toHaveLength(0)
  })

  it('错误信息里不会漏出 apiSecret / apiKey', async () => {
    const fake = new FakeBybitTrade()
    fake.fail('POST', '/v5/order/create', 110004, `insufficient balance; echoed ${API_SECRET}`)
    const { trading } = harness(fake)
    const result = await trading.submit(ctx(), [intent()])
    const text = String(result.acks[0]!.problem?.venue?.message ?? '')
    expect(text).not.toContain(API_SECRET)
  })
})

describe('cancel / cancelAll（POST，不是 DELETE）', () => {
  it('按 venueOrderId 撤：POST /v5/order/cancel + body.orderId', async () => {
    const fake = new FakeBybitTrade()
    const { trading } = harness(fake)
    const acks = await trading.cancel(ctx(), [{ instrumentId: 'bybit:BTCUSDT', venueOrderId: 'ord-1' }])
    expect(acks[0]!.ok).toBe(true)
    const call = fake.callsFor('POST', '/v5/order/cancel')[0]!
    expect(call.body).toEqual({ category: 'linear', symbol: 'BTCUSDT', orderId: 'ord-1' })
  })

  it('按 clientOrderId 撤：body.orderLinkId', async () => {
    const fake = new FakeBybitTrade()
    const { trading } = harness(fake)
    await trading.cancel(ctx(), [{ instrumentId: 'bybit:BTCUSDT', clientOrderId: 'gt-c1' }])
    expect(fake.callsFor('POST', '/v5/order/cancel')[0]!.body).toMatchObject({ orderLinkId: 'gt-c1' })
  })

  it('用 DELETE 打这个路径会被上游 404（撤单必须是 POST）', async () => {
    const fake = new FakeBybitTrade()
    const { http } = harness(fake)
    const err = await http
      .signed('DELETE', '/v5/order/cancel', { body: { category: 'linear', symbol: 'BTCUSDT', orderId: '1' } })
      .catch((e: unknown) => e)
    expect((err as { status?: number }).status).toBe(404)
    expect(asProblem(err).code).toBe(3001)
    expect(fake.callsFor('POST', '/v5/order/cancel')).toHaveLength(0)
  })

  it('两个 id 都没给 → INVALID_PARAMS，不发请求', async () => {
    const fake = new FakeBybitTrade()
    const { trading } = harness(fake)
    const acks = await trading.cancel(ctx(), [{ instrumentId: 'bybit:BTCUSDT' }])
    expect(acks[0]!.ok).toBe(false)
    expect(acks[0]!.problem?.name).toBe('INVALID_PARAMS')
    expect(fake.callsTo('/v5/order/cancel')).toHaveLength(0)
  })

  it('非本场所的 instrumentId → ok:false，不发请求', async () => {
    const fake = new FakeBybitTrade()
    const { trading } = harness(fake)
    const acks = await trading.cancel(ctx(), [{ instrumentId: 'binance:BTCUSDT', venueOrderId: '1' }])
    expect(acks[0]!.ok).toBe(false)
    expect(acks[0]!.problem?.name).toBe('INVALID_PARAMS')
    expect(fake.callsTo('/v5/order/cancel')).toHaveLength(0)
  })

  it('上游 110001（订单不存在）撤单按已达成处理（ok:true）', async () => {
    const fake = new FakeBybitTrade()
    fake.fail('POST', '/v5/order/cancel', 110001, 'Order does not exist')
    const { trading } = harness(fake)
    const acks = await trading.cancel(ctx(), [{ instrumentId: 'bybit:BTCUSDT', venueOrderId: 'ord-gone' }])
    expect(acks[0]!.ok).toBe(true)
  })

  it('撤单遇到 110008（仓位不足）也算已不在场上', async () => {
    const fake = new FakeBybitTrade()
    fake.fail('POST', '/v5/order/cancel', 110008, 'position is insufficient')
    const { trading } = harness(fake)
    const acks = await trading.cancel(ctx(), [{ instrumentId: 'bybit:BTCUSDT', venueOrderId: 'ord-gone' }])
    expect(acks[0]!.ok).toBe(true)
  })

  it('撤单遇到 10001（参数错）→ ok:false + INVALID_PARAMS（不再做原文子串匹配）', async () => {
    const fake = new FakeBybitTrade()
    fake.fail('POST', '/v5/order/cancel', 10001, 'params error: orderLinkId invalid')
    const { trading } = harness(fake)
    const acks = await trading.cancel(ctx(), [{ instrumentId: 'bybit:BTCUSDT', clientOrderId: 'gt-c1' }])
    expect(acks[0]!.ok).toBe(false)
    expect(acks[0]!.problem?.name).toBe('INVALID_PARAMS')
  })

  it('上游其它错误 → ok:false 带 Problem（原文保留）', async () => {
    const fake = new FakeBybitTrade()
    fake.fail('POST', '/v5/order/cancel', 10016, 'Service is restarting')
    const { trading } = harness(fake)
    const acks = await trading.cancel(ctx(), [{ instrumentId: 'bybit:BTCUSDT', venueOrderId: 'ord-1' }])
    expect(acks[0]!.ok).toBe(false)
    expect(acks[0]!.problem?.code).toBe(3006)
  })

  it('cancelAll 给 instrumentId → body.symbol', async () => {
    const fake = new FakeBybitTrade()
    const { trading } = harness(fake)
    const acks = await trading.cancelAll(ctx(), 'bybit:ETHUSDT')
    expect(acks[0]!.ok).toBe(true)
    expect(fake.callsFor('POST', '/v5/order/cancel-all')[0]!.body).toEqual({ category: 'linear', symbol: 'ETHUSDT' })
  })

  it('cancelAll 不给 instrumentId → 按 settleCoin=USDT 全撤', async () => {
    const fake = new FakeBybitTrade()
    const { trading } = harness(fake)
    const acks = await trading.cancelAll(ctx())
    expect(acks[0]!.ok).toBe(true)
    expect(fake.callsFor('POST', '/v5/order/cancel-all')[0]!.body).toEqual({ category: 'linear', settleCoin: 'USDT' })
  })

  it('cancelAll 成功时 success=1 → ok:true', async () => {
    const fake = new FakeBybitTrade()
    fake.cancelAllResult = { list: [], success: '1' }
    const { trading } = harness(fake)
    const acks = await trading.cancelAll(ctx(), 'bybit:BTCUSDT')
    expect(acks[0]!.ok).toBe(true)
  })

  it('cancelAll 回 success=0 → ok:false + VENUE_REJECTED', async () => {
    const fake = new FakeBybitTrade()
    fake.cancelAllResult = { list: [], success: '0' }
    const { trading } = harness(fake)
    const acks = await trading.cancelAll(ctx(), 'bybit:BTCUSDT')
    expect(acks[0]!.ok).toBe(false)
    expect(acks[0]!.problem?.name).toBe('VENUE_REJECTED')
  })

  it('cancelAll 失败 → ok:false 带 Problem', async () => {
    const fake = new FakeBybitTrade()
    fake.fail('POST', '/v5/order/cancel-all', 10006, 'Too many visits')
    const { trading } = harness(fake)
    const acks = await trading.cancelAll(ctx(), 'bybit:BTCUSDT')
    expect(acks[0]!.ok).toBe(false)
    expect(acks[0]!.problem?.code).toBe(3002)
  })
})

describe('amend（只改原生支持的订单类型）', () => {
  it('限价单改单：POST /v5/order/amend，只带 category / symbol / orderId / qty / price', async () => {
    const fake = new FakeBybitTrade()
    const { trading } = harness(fake)
    const result = await trading.amend(ctx(), {
      instrumentId: 'bybit:BTCUSDT',
      venueOrderId: 'ord-1',
      order: intent({ price: '101', size: '0.2' }),
    })
    const call = fake.callsFor('POST', '/v5/order/amend')[0]!
    expect(call.body).toEqual({ category: 'linear', symbol: 'BTCUSDT', orderId: 'ord-1', qty: '0.2', price: '101' })
    expect(result.acks[0]!.status).toBe('open')
    expect(result.requestWeight).toBe(0)
  })

  it('限价触发单（stop_limit）改单会带 triggerPrice', async () => {
    const fake = new FakeBybitTrade()
    const { trading } = harness(fake)
    await trading.amend(ctx(), {
      instrumentId: 'bybit:BTCUSDT',
      venueOrderId: 'ord-2',
      order: intent({ type: 'stop_limit', side: 'sell', price: '99', triggerPrice: '99.5', reduceOnly: true }),
    })
    expect(fake.callsFor('POST', '/v5/order/amend')[0]!.body).toMatchObject({ triggerPrice: '99.5', price: '99' })
  })

  it('按 clientOrderId 改单：body.orderLinkId', async () => {
    const fake = new FakeBybitTrade()
    const { trading } = harness(fake)
    await trading.amend(ctx(), { instrumentId: 'bybit:BTCUSDT', clientOrderId: 'gt-amend-1', order: intent() })
    expect(fake.callsFor('POST', '/v5/order/amend')[0]!.body).toMatchObject({ orderLinkId: 'gt-amend-1' })
  })

  it('市价意图改单 → 1004，不发请求（撤旧挂新）', async () => {
    const fake = new FakeBybitTrade()
    const { trading } = harness(fake)
    const result = await trading.amend(ctx(), {
      instrumentId: 'bybit:BTCUSDT',
      venueOrderId: 'ord-1',
      order: intent({ type: 'market', price: undefined, maxSlippageBps: 20 }),
    })
    expect(result.acks[0]!.problem?.code).toBe(1004)
    expect(fake.callsTo('/v5/order/amend')).toHaveLength(0)
  })

  it('触发市价单（stop_market）改单 → 1004', async () => {
    const fake = new FakeBybitTrade()
    const { trading } = harness(fake)
    const result = await trading.amend(ctx(), {
      instrumentId: 'bybit:BTCUSDT',
      venueOrderId: 'ord-1',
      order: intent({ type: 'stop_market', side: 'sell', price: undefined, triggerPrice: '99' }),
    })
    expect(result.acks[0]!.problem?.code).toBe(1004)
  })

  it('两个 id 都没给 → INVALID_PARAMS', async () => {
    const fake = new FakeBybitTrade()
    const { trading } = harness(fake)
    const result = await trading.amend(ctx(), { instrumentId: 'bybit:BTCUSDT', order: intent() })
    expect(result.acks[0]!.problem?.name).toBe('INVALID_PARAMS')
  })

  it('上游拒单 → ack rejected + receiptHash 非空', async () => {
    const fake = new FakeBybitTrade()
    fake.fail('POST', '/v5/order/amend', 110001, 'Order does not exist')
    const { trading } = harness(fake)
    const result = await trading.amend(ctx(), { instrumentId: 'bybit:BTCUSDT', venueOrderId: 'nope', order: intent() })
    expect(result.acks[0]!.status).toBe('rejected')
    expect(result.receiptHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('改单失败回执沿用 req.clientOrderId', async () => {
    const fake = new FakeBybitTrade()
    fake.fail('POST', '/v5/order/amend', 110001, 'Order does not exist')
    const { trading } = harness(fake)
    const result = await trading.amend(ctx(), {
      instrumentId: 'bybit:BTCUSDT', venueOrderId: 'nope', clientOrderId: 'gt-amend-1',
      order: intent({ price: '101' }),
    })
    expect(result.acks[0]!.status).toBe('rejected')
    expect(result.acks[0]!.clientOrderId).toBe('gt-amend-1')
  })
})

describe('杠杆 / 保证金模式', () => {
  it('setLeverage 先模式后杠杆（顺序照 QD）', async () => {
    const fake = new FakeBybitTrade()
    const { trading } = harness(fake)
    await trading.setLeverage(ctx(), 'bybit:BTCUSDT', 5, 'cross')
    expect(fake.calls.map((c) => c.path)).toEqual(['/v5/account/set-margin-mode', '/v5/position/set-leverage'])
    expect(fake.callsFor('POST', '/v5/account/set-margin-mode')[0]!.body).toEqual({ setMarginMode: 'REGULAR_MARGIN' })
  })

  it('110043（leverage not modified）算成功', async () => {
    const fake = new FakeBybitTrade()
    fake.fail('POST', '/v5/position/set-leverage', 110043, 'leverage not modified')
    const { trading } = harness(fake)
    await expect(trading.setLeverage(ctx(), 'bybit:BTCUSDT', 5, 'cross')).resolves.toBeUndefined()
    expect(trading.leverageState()).toEqual([{ instrumentId: 'bybit:BTCUSDT', leverage: 5, marginMode: 'cross' }])
  })

  it('110024（有持仓不能切持仓模式）→ setLeverage reject ProblemError', async () => {
    const fake = new FakeBybitTrade()
    fake.fail('POST', '/v5/account/set-margin-mode', 110024, 'You have an existing position, so the position mode cannot be switched')
    const { trading } = harness(fake)
    const err = await trading.setLeverage(ctx(), 'bybit:BTCUSDT', 3, 'isolated').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ProblemError)
  })

  it('110026（保证金模式未变）算成功', async () => {
    const fake = new FakeBybitTrade()
    fake.fail('POST', '/v5/account/set-margin-mode', 110026, 'margin mode not modified')
    const { trading } = harness(fake)
    await expect(trading.setLeverage(ctx(), 'bybit:BTCUSDT', 3, 'isolated')).resolves.toBeUndefined()
  })

  it('110036（全仓下不允许改杠杆）不吞：省略marginMode的submit被打回且不下单', async () => {
    const fake = new FakeBybitTrade()
    fake.fail('POST', '/v5/position/set-leverage', 110036, 'You are not allowed to change leverage due to cross margin mode')
    const { trading } = harness(fake)
    const result = await trading.submit(ctx(), [intent({ leverage: 10 })])
    expect(result.acks[0]!.status).toBe('rejected')
    expect(fake.callsTo('/v5/order/create')).toHaveLength(0)
  })

  it('杠杆越界（0 / 101 / 非整数）→ INVALID_PARAMS，不发请求', async () => {
    const fake = new FakeBybitTrade()
    const { trading } = harness(fake)
    for (const bad of [0, 101, 2.5]) {
      const err = await trading.setLeverage(ctx(), 'bybit:BTCUSDT', bad, 'cross').catch((e: unknown) => e)
      expect(err).toBeInstanceOf(ProblemError)
      expect(asProblem(err).name).toBe('INVALID_PARAMS')
    }
    expect(fake.callsTo('/v5/position/set-leverage')).toHaveLength(0)
  })

  it('同一标的同一档杠杆只设一次（缓存命中就不发请求）', async () => {
    const fake = new FakeBybitTrade()
    const { trading } = harness(fake)
    await trading.setLeverage(ctx(), 'bybit:BTCUSDT', 7, 'cross')
    await trading.setLeverage(ctx(), 'bybit:BTCUSDT', 7, 'cross')
    expect(fake.callsTo('/v5/position/set-leverage')).toHaveLength(1)
  })

  it('杠杆档位变化会重新发请求', async () => {
    const fake = new FakeBybitTrade()
    const { trading } = harness(fake)
    await trading.setLeverage(ctx(), 'bybit:BTCUSDT', 7, 'cross')
    await trading.setLeverage(ctx(), 'bybit:BTCUSDT', 8, 'cross')
    expect(fake.callsTo('/v5/position/set-leverage')).toHaveLength(2)
  })

  it('显式setLeverage逐仓→全仓→逐仓每次切换账户模式，随后submit省略marginMode', async () => {
    const fake = new FakeBybitTrade()
    const { trading } = harness(fake)
    const eth = (over: LooseIntent = {}): OrderIntent => intent({ instrumentId: 'bybit:ETHUSDT', size: '1', price: '2400', ...over })
    await trading.setLeverage(ctx(), 'bybit:BTCUSDT', 10, 'isolated')
    await trading.submit(ctx(), [intent({ leverage: 10 })])
    await trading.setLeverage(ctx(), 'bybit:ETHUSDT', 5, 'cross')
    await trading.submit(ctx(), [eth({ leverage: 5 })])
    await trading.setLeverage(ctx(), 'bybit:BTCUSDT', 10, 'isolated')
    await trading.submit(ctx(), [intent({ leverage: 10 })])
    const modes = fake.callsFor('POST', '/v5/account/set-margin-mode')
    expect(modes).toHaveLength(3)
    expect(modes.map((c) => (c.body as { setMarginMode?: string }).setMarginMode)).toEqual([
      'ISOLATED_MARGIN', 'REGULAR_MARGIN', 'ISOLATED_MARGIN',
    ])
    expect(fake.callsTo('/v5/position/set-leverage')).toHaveLength(3)
    expect(fake.callsTo('/v5/order/create')).toHaveLength(3)
  })

  it('同标的切换保证金模式时显式setter不吃杠杆缓存，submit省略marginMode', async () => {
    const fake = new FakeBybitTrade()
    const { trading } = harness(fake)
    await trading.setLeverage(ctx(), 'bybit:BTCUSDT', 10, 'isolated')
    await trading.submit(ctx(), [intent({ leverage: 10 })])
    await trading.setLeverage(ctx(), 'bybit:BTCUSDT', 10, 'cross')
    await trading.submit(ctx(), [intent({ leverage: 10 })])
    expect(fake.callsFor('POST', '/v5/account/set-margin-mode').map((c) => (c.body as { setMarginMode?: string }).setMarginMode)).toEqual([
      'ISOLATED_MARGIN', 'REGULAR_MARGIN',
    ])
    expect(fake.callsTo('/v5/position/set-leverage')).toHaveLength(2)
    expect(fake.callsTo('/v5/order/create')).toHaveLength(2)
  })

  it('显式setter沿用同一账户模式时不重发set-margin-mode（杠杆按标的缓存）', async () => {
    const fake = new FakeBybitTrade()
    const { trading } = harness(fake)
    const eth = (over: LooseIntent = {}): OrderIntent => intent({ instrumentId: 'bybit:ETHUSDT', size: '1', price: '2400', ...over })
    await trading.setLeverage(ctx(), 'bybit:BTCUSDT', 10, 'isolated')
    await trading.submit(ctx(), [intent({ leverage: 10 })])
    await trading.setLeverage(ctx(), 'bybit:ETHUSDT', 5, 'isolated')
    await trading.submit(ctx(), [eth({ leverage: 5 })])
    expect(fake.callsTo('/v5/account/set-margin-mode')).toHaveLength(1)
    expect(fake.callsTo('/v5/position/set-leverage')).toHaveLength(2)
  })

  it('非 Bybit 的 instrumentId → ProblemError INVALID_PARAMS', async () => {
    const fake = new FakeBybitTrade()
    const { trading } = harness(fake)
    await expect(trading.setLeverage(ctx(), 'okx:BTC-USDT-SWAP', 5, 'cross')).rejects.toBeInstanceOf(ProblemError)
  })
})

describe('持仓级 TP / SL / 追踪 与 spot 之外的兜底', () => {
  it('setTradingStop 打 POST /v5/position/trading-stop（tpslMode=Full）', async () => {
    const fake = new FakeBybitTrade()
    const { trading } = harness(fake)
    await trading.setTradingStop(ctx(), { symbol: 'btcusdt', stopLoss: '95000', takeProfit: '110000' })
    expect(fake.callsFor('POST', '/v5/position/trading-stop')[0]!.body).toEqual({
      category: 'linear', symbol: 'BTCUSDT', tpslMode: 'Full', positionIdx: 0,
      takeProfit: '110000', stopLoss: '95000', tpTriggerBy: 'MarkPrice', slTriggerBy: 'MarkPrice',
    })
  })

  it('hedge 模式不给 positionIdx → INVALID_PARAMS，不发请求', async () => {
    const fake = new FakeBybitTrade()
    const { trading } = harness(fake, { positionMode: 'hedge' })
    const err = await trading.setTradingStop(ctx(), { symbol: 'BTCUSDT', stopLoss: '95000' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ProblemError)
    expect(asProblem(err).name).toBe('INVALID_PARAMS')
    expect(fake.callsTo('/v5/position/trading-stop')).toHaveLength(0)
  })

  it('setTradingStop 缺三个价格 → 抛 ProblemError（INVALID_PARAMS），不发请求', async () => {
    const fake = new FakeBybitTrade()
    const { trading } = harness(fake)
    await expect(trading.setTradingStop(ctx(), { symbol: 'BTCUSDT' })).rejects.toBeInstanceOf(ProblemError)
    expect(fake.callsTo('/v5/position/trading-stop')).toHaveLength(0)
  })

  it('scheduleCancel → 5002 CAPABILITY_UNSUPPORTED（Bybit 没有场所级定时撤单）', async () => {
    const { trading } = harness(new FakeBybitTrade())
    const err = await trading.scheduleCancel(ctx(), NOW + 60_000).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ProblemError)
    expect(asProblem(err).code).toBe(5002)
  })

  it('openOrders / status 透传给 account 读取器', async () => {
    const fake = new FakeBybitTrade()
    const { trading } = harness(fake)
    const orders = await trading.openOrders(account(), 'bybit:BTCUSDT')
    expect(orders.length).toBeGreaterThan(0)
    const status = await trading.status(account(), { clientOrderId: 'gt-query' }, { symbol: 'BTCUSDT' })
    expect(status.found).toBe(true)
    expect(status.status).toBe('PartiallyFilled')
  })

  it('budgetUsage / mode / defaultSymbol 诊断口', async () => {
    const { trading } = harness(new FakeBybitTrade(), { positionMode: 'hedge' })
    expect(trading.mode()).toBe('hedge')
    expect(trading.defaultSymbol()).toBe('BTCUSDT')
    expect(trading.budgetUsage().limit).toBe(600)
  })
})
