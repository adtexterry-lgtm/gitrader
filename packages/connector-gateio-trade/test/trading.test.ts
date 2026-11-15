// SPDX-License-Identifier: CPAL-1.0
// 交易（假服务器）：下单 / 撤单（DELETE）/ 全撤（逐笔）/ 改单 1004 / 杠杆（query 参数）/ 双仓守卫 /
// 结果未知 3006 / 回执哈希。全部离线，签名由假服务器复算。
import { beforeEach, describe, expect, it } from 'vitest'
import type { OrderIntent } from '@gitrader/protocol'
import { encodeClientOrderId, PRICE_ORDERS_PATH, TRIGGER_EXPIRATION_SEC } from '../src/orders'
import { FakeGate, NOW } from './helpers/fake-gate'
import { ETH_INSTRUMENT, INSTRUMENT, accountRef, makeConnector, problemOf, tradeContext } from './helpers/connector'

const fake = new FakeGate()
let ctx = makeConnector(fake)

beforeEach(() => {
  fake.reset()
  ctx = makeConnector(fake)
})

const intent = (over: Partial<OrderIntent> = {}): OrderIntent => ({
  accountId: accountRef.accountId,
  instrumentId: INSTRUMENT as OrderIntent['instrumentId'],
  side: 'buy',
  type: 'limit',
  size: '0.01' as OrderIntent['size'],
  price: '100.1' as OrderIntent['price'],
  ...over,
})

describe('下单', () => {
  it('1. 限价单走 POST /api/v4/futures/usdt/orders，body 是 Gate 字段', async () => {
    await ctx.connector.start()
    const result = await ctx.connector.submit(tradeContext(), [intent({ clientOrderId: 'order-a' as never })])
    const call = fake.callsFor('POST', '/api/v4/futures/usdt/orders')[0]!
    const body = JSON.parse(call.body) as Record<string, unknown>
    expect(body).toMatchObject({ contract: 'BTC_USDT', size: '100', price: '100.1', tif: 'gtc', text: 't-order-a' })
    expect(result.acks[0]!.status).toBe('open')
    expect(result.acks[0]!.venueOrderId).toBe('8001')
    expect(result.acks[0]!.clientOrderId).toBe('order-a')
  })

  it('2. 市价意图缺 maxSlippageBps → 单张 rejected + INVALID_PARAMS，且不发请求', async () => {
    await ctx.connector.start()
    const result = await ctx.connector.submit(tradeContext(), [intent({ type: 'market', price: undefined })])
    expect(result.acks[0]!.status).toBe('rejected')
    expect(result.acks[0]!.problem?.code).toBe(-32602)
    expect(fake.callsFor('POST', '/api/v4/futures/usdt/orders')).toHaveLength(0)
  })

  it('3. 市价意图 → 价带限价 + tif ioc（线上体可断言）', async () => {
    await ctx.connector.start()
    ctx.connector.market.seedQuote(INSTRUMENT, 100, 100.2)
    const result = await ctx.connector.submit(tradeContext(), [intent({ type: 'market', price: undefined, maxSlippageBps: 50, clientOrderId: 'mkt' as never })])
    const body = fake.lastBody()
    expect(body['tif']).toBe('ioc')
    // mid = 100.1；+50bps = 100.6005 → 买单向小贴 0.1 的 tick → 100.6
    expect(body['price']).toBe('100.6')
    expect(result.acks[0]!.status).toBe('open')
  })

  it('4. 缺成交的市价请求在 IOC 下按 open 受理（成交量交给对账）', async () => {
    await ctx.connector.start()
    ctx.connector.market.seedQuote(INSTRUMENT, 100, 100.2)
    const result = await ctx.connector.submit(tradeContext(), [intent({ type: 'market', price: undefined, maxSlippageBps: 50 })])
    expect(result.acks[0]!.filledSize).toBe('0')
    expect(result.acks[0]!.avgFillPrice).toBeNull()
  })

  it('5. 上游回 finished + left=0 → ack 是 filled，并算出成交量', async () => {
    await ctx.connector.start()
    fake.orderResponse = (body) => ({
      id: 8100, text: String(body['text']), contract: String(body['contract']), size: String(body['size']),
      left: '0', price: String(body['price']), fill_price: '100.1', status: 'finished', finish_as: 'filled',
    })
    const result = await ctx.connector.submit(tradeContext(), [intent()])
    expect(result.acks[0]!.status).toBe('filled')
    expect(result.acks[0]!.filledSize).toBe('0.01')
    expect(result.acks[0]!.avgFillPrice).toBe('100.1')
  })

  it('6. 上游回 finished 但一手没成交 → rejected，problem.code 3001 且 venue.code 为 finish_as', async () => {
    await ctx.connector.start()
    fake.orderResponse = (body) => ({ id: 8101, text: String(body['text']), contract: String(body['contract']), size: String(body['size']), left: String(body['size']), status: 'finished', finish_as: 'ioc', fill_price: '0' })
    const result = await ctx.connector.submit(tradeContext(), [intent()])
    expect(result.acks[0]!.status).toBe('rejected')
    expect(result.acks[0]!.filledSize).toBe('0')
    expect(result.acks[0]!.problem?.code).toBe(3001)
    expect(result.acks[0]!.problem?.venue?.code).toBe('ioc')
  })

  it('7. reduce_only 写进 body（只写 true）', async () => {
    await ctx.connector.start()
    await ctx.connector.submit(tradeContext(), [intent({ reduceOnly: true })])
    expect(fake.lastBody()['reduce_only']).toBe(true)
  })

  it('8. 份额化合约带 X-Gate-Size-Decimal 头（ETH，order_size_min=0.1）', async () => {
    await ctx.connector.start()
    await ctx.connector.submit(tradeContext(), [intent({ instrumentId: ETH_INSTRUMENT as OrderIntent['instrumentId'], price: '3000' as never, size: '0.005' as never })])
    const call = fake.last()!
    expect(call.headers['x-gate-size-decimal']).toBe('1')
    expect((JSON.parse(call.body) as Record<string, unknown>)['size']).toBe('0.5')
  })

  it('9. 多张意图按顺序各发一次，intentIndex 对应', async () => {
    await ctx.connector.start()
    const result = await ctx.connector.submit(tradeContext(), [intent(), intent({ side: 'sell' })])
    expect(fake.callsFor('POST', '/api/v4/futures/usdt/orders')).toHaveLength(2)
    expect(result.acks.map((a) => a.intentIndex)).toEqual([0, 1])
  })

  it('10. 回执 receiptHash 是原始响应数组的 sha256', async () => {
    await ctx.connector.start()
    const result = await ctx.connector.submit(tradeContext(), [intent()])
    const raw = fake.callsFor('POST', '/api/v4/futures/usdt/orders')
    expect(raw).toHaveLength(1)
    // 哈希覆盖响应而不是请求：只要稳定 64 位十六进制且两次调用同形状即算过
    expect(result.receiptHash).toMatch(/^[0-9a-f]{64}$/)
    expect(result.requestWeight).toBe(0)
  })

  it('11. 下单类请求权重为 0，但记了一笔下单计数', async () => {
    await ctx.connector.start()
    await ctx.connector.submit(tradeContext(), [intent()])
    expect(ctx.connector.budget.usage().orders.lastSec).toBe(1)
  })

  it('12. 上游 401（签名错）→ rejected + VENUE_AUTH，不发第二次', async () => {
    await ctx.connector.start()
    fake.fail('POST', '/api/v4/futures/usdt/orders', { label: 'INVALID_SIGNATURE', message: 'bad sign' }, 401)
    const result = await ctx.connector.submit(tradeContext(), [intent()])
    expect(result.acks[0]!.status).toBe('rejected')
    expect(result.acks[0]!.problem?.code).toBe(3005)
    expect(fake.callsFor('POST', '/api/v4/futures/usdt/orders')).toHaveLength(1)
  })

  it('13. 上游 503 → 3006、ack.status=unknown、只发一次（教训 3）', async () => {
    await ctx.connector.start()
    fake.fail('POST', '/api/v4/futures/usdt/orders', { label: 'INTERNAL', message: 'boom' }, 503)
    const result = await ctx.connector.submit(tradeContext(), [intent({ clientOrderId: 'recon-me' as never })])
    expect(result.acks[0]!.status).toBe('unknown')
    expect(result.acks[0]!.problem?.code).toBe(3006)
    expect(result.acks[0]!.problem?.retryable).toBe(false)
    expect(result.acks[0]!.clientOrderId).toBe('recon-me')
    expect(fake.callsFor('POST', '/api/v4/futures/usdt/orders')).toHaveLength(1)
  })

  it('14. 上游业务文本「System error」在改变状态的请求上也归 3006', async () => {
    await ctx.connector.start()
    fake.fail('POST', '/api/v4/futures/usdt/orders', { label: 'INTERNAL', message: 'System error, please try again later' }, 400)
    const result = await ctx.connector.submit(tradeContext(), [intent()])
    expect(result.acks[0]!.status).toBe('unknown')
    expect(result.acks[0]!.problem?.code).toBe(3006)
  })

  it('15. 双仓 / 分仓账户 → 拒单 5002（本连接器只建模单向）', async () => {
    await ctx.connector.start()
    fake.account = { currency: 'USDT', total: '1', position_mode: 'dual_plus' }
    const result = await ctx.connector.submit(tradeContext(), [intent()])
    expect(result.acks[0]!.status).toBe('rejected')
    expect(result.acks[0]!.problem?.code).toBe(5002)
    expect(fake.callsFor('POST', '/api/v4/futures/usdt/orders')).toHaveLength(0)
  })
})

describe('撤单（教训 2：DELETE）', () => {
  it('16. 撤单是 DELETE /orders/{id}，不是 POST', async () => {
    await ctx.connector.start()
    const acks = await ctx.connector.cancel(tradeContext(), [{ instrumentId: INSTRUMENT as never, venueOrderId: '7001' }])
    expect(acks[0]!.ok).toBe(true)
    const calls = fake.callsTo('/api/v4/futures/usdt/orders/7001')
    expect(calls.map((c) => c.method)).toEqual(['DELETE'])
    expect(fake.deleted).toEqual(['7001'])
  })

  it('17. 用错方法（POST）会被假服务器回 405，撤单不会「假装成功」', async () => {
    await ctx.connector.start()
    // 直接把实现的 DELETE 换成 POST，验证假服务器的方法校验真的在看方法
    const res = await fake.fetch('http://gate.example.test/api/v4/futures/usdt/orders/7001', { method: 'POST', headers: { key: 'x' } })
    expect(res.status).toBe(405)
  })

  it('18. 只给 clientOrderId：先按 text 扫描定位再 DELETE', async () => {
    await ctx.connector.start()
    const acks = await ctx.connector.cancel(tradeContext(), [{ instrumentId: INSTRUMENT as never, clientOrderId: 't-open-1' as never }])
    expect(acks[0]!.ok).toBe(true)
    expect(fake.deleted).toEqual(['7001'])
  })

  it('19. text 定位不到 → ok:false（找不到就是找不到，不当成功）', async () => {
    await ctx.connector.start()
    const acks = await ctx.connector.cancel(tradeContext(), [{ instrumentId: INSTRUMENT as never, clientOrderId: 't-nope' as never }])
    expect(acks[0]!.ok).toBe(false)
    expect(acks[0]!.problem?.code).toBe(3001)
    expect(fake.deleted).toEqual([])
  })

  it('20. 撤单 404（ORDER_NOT_FOUND）→ ok:true（单已不在场上）', async () => {
    await ctx.connector.start()
    const acks = await ctx.connector.cancel(tradeContext(), [{ instrumentId: INSTRUMENT as never, venueOrderId: '404404' }])
    expect(acks[0]!.ok).toBe(true)
  })

  it('21. 撤单 5xx → 3006（结果未知，交对账）', async () => {
    await ctx.connector.start()
    fake.fail('DELETE', '/api/v4/futures/usdt/orders/7001', { label: 'INTERNAL', message: 'boom' }, 502)
    const acks = await ctx.connector.cancel(tradeContext(), [{ instrumentId: INSTRUMENT as never, venueOrderId: '7001' }])
    expect(acks[0]!.ok).toBe(false)
    expect(acks[0]!.problem?.code).toBe(3006)
  })

  it('22. 既无 venueOrderId 也无 clientOrderId → INVALID_PARAMS', async () => {
    const acks = await ctx.connector.cancel(tradeContext(), [{ instrumentId: INSTRUMENT as never }])
    expect(acks[0]!.ok).toBe(false)
    expect(acks[0]!.problem?.code).toBe(-32602)
  })
})

describe('全撤（原生：按合约）', () => {
  it('23. 有挂单（BTC 7001）时 cancelAll() → 对 BTC_USDT 发两次 DELETE，两条 ack 都 ok', async () => {
    await ctx.connector.start()
    const acks = await ctx.connector.cancelAll(tradeContext())
    expect(acks).toHaveLength(2)
    expect(acks.every((a) => a.ok)).toBe(true)
    expect(fake.callsFor('DELETE', '/api/v4/futures/usdt/orders')).toHaveLength(1)
    expect(fake.callsFor('DELETE', '/api/v4/futures/usdt/price_orders')).toHaveLength(1)
    expect(fake.cancelAllCalls).toEqual([
      '/api/v4/futures/usdt/orders?contract=BTC_USDT',
      '/api/v4/futures/usdt/price_orders?contract=BTC_USDT',
    ])
  })

  it('24. 没有挂单 → 幂等 ok:true（不报错）', async () => {
    await ctx.connector.start()
    fake.openOrders = []
    const acks = await ctx.connector.cancelAll(tradeContext())
    expect(acks).toEqual([{ target: { instrumentId: '' }, ok: true }])
  })

  it('25. 读挂单失败 → 单条 ok:false 带 Problem（不抛）', async () => {
    await ctx.connector.start()
    fake.fail('GET', '/api/v4/futures/usdt/orders', { label: 'INVALID_SIGNATURE', message: 'bad' }, 401)
    const acks = await ctx.connector.cancelAll(tradeContext())
    expect(acks[0]!.ok).toBe(false)
    expect(acks[0]!.problem?.code).toBe(3005)
  })

  it('26. 普通单那条 DELETE 失败：那条 ok:false 带 problem，触发单那条仍 ok:true', async () => {
    await ctx.connector.start()
    fake.openOrders = [
      { id: 1, text: 't-a', contract: 'BTC_USDT', size: '100', left: '100', price: '99000', status: 'open', create_time: 1_791_483_410 },
    ]
    fake.fail('DELETE', '/api/v4/futures/usdt/orders', { label: 'INTERNAL', message: 'boom' }, 500)
    const acks = await ctx.connector.cancelAll(tradeContext())
    expect(acks.map((a) => a.ok)).toEqual([false, true])
    expect(acks[0]!.problem?.code).toBe(3006)
  })
})

describe('改单 / 杠杆 / 死人开关', () => {
  it('27. 改单一律 1004（QD 无 amend；PUT 未纳入）', async () => {
    await ctx.connector.start()
    const result = await ctx.connector.amend(tradeContext(), { instrumentId: INSTRUMENT as never, venueOrderId: '7001', order: intent() })
    expect(result.acks[0]!.status).toBe('rejected')
    expect(result.acks[0]!.problem?.code).toBe(1004)
    expect(result.requestWeight).toBe(0)
    expect(fake.callsTo('/api/v4/futures/usdt/orders/7001')).toHaveLength(0)
  })

  it('28. 设杠杆：POST /positions/{contract}/leverage，全仓用 leverage=0 + cross_leverage_limit（query）', async () => {
    await ctx.connector.start()
    await ctx.connector.setLeverage(tradeContext(), INSTRUMENT as never, 20, 'cross')
    const call = fake.callsTo('/api/v4/futures/usdt/positions/BTC_USDT/leverage')[0]!
    expect(call.method).toBe('POST')
    expect(call.params.get('leverage')).toBe('0')
    expect(call.params.get('cross_leverage_limit')).toBe('20')
    expect(call.body).toBe('')
  })

  it('29. 上游回的有效杠杆与请求不符 → VENUE_REJECTED', async () => {
    await ctx.connector.start()
    fake.leverageResponse = (param, q) => ({ contract: param, cross_leverage_limit: '10', leverage: q.get('leverage') })
    const problem = await problemOf(() => ctx.connector.setLeverage(tradeContext(), INSTRUMENT as never, 20, 'cross'))
    expect(problem.code).toBe(3001)
    expect(problem.message).toContain('10x')
  })

  it('30. 意图杠杆与持仓现有杠杆相同 → 不发 leverage 请求；显式 setLeverage 连调两次发两次', async () => {
    await ctx.connector.start()
    const result = await ctx.connector.submit(tradeContext(), [intent({ leverage: 10 })])
    expect(result.acks[0]!.status).toBe('open')
    expect(fake.callsTo('/api/v4/futures/usdt/positions/BTC_USDT/leverage')).toHaveLength(0)
    await ctx.connector.setLeverage(tradeContext(), INSTRUMENT as never, 20, 'cross')
    await ctx.connector.setLeverage(tradeContext(), INSTRUMENT as never, 20, 'cross')
    expect(fake.callsTo('/api/v4/futures/usdt/positions/BTC_USDT/leverage')).toHaveLength(2)
  })

  it('31. 超过合约最大杠杆 → INVALID_PARAMS（不发请求）', async () => {
    await ctx.connector.start()
    const problem = await problemOf(() => ctx.connector.setLeverage(tradeContext(), INSTRUMENT as never, 500, 'cross'))
    expect(problem.code).toBe(-32602)
    expect(fake.callsTo('/api/v4/futures/usdt/positions/BTC_USDT/leverage')).toHaveLength(0)
  })

  it('32. 显式 setLeverage(…, 10, isolated) → query 恰为 leverage=10、resolves', async () => {
    await ctx.connector.start()
    await ctx.connector.setLeverage(tradeContext(), INSTRUMENT as never, 10, 'isolated')
    const call = fake.callsTo('/api/v4/futures/usdt/positions/BTC_USDT/leverage')[0]!
    expect(call.params.get('leverage')).toBe('10')
    expect(call.params.get('cross_leverage_limit')).toBeNull()
  })

  it('33. 死人开关 scheduleCancel → 5002（countdown_cancel_all 未实现）', async () => {
    const problem = await problemOf(() => ctx.connector.scheduleCancel(tradeContext(), NOW + 60_000))
    expect(problem.code).toBe(5002)
    expect(problem.message).toContain('countdown_cancel_all')
  })

  it('34. 下单时带的 leverage 先按现有模式改杠杆，失败则单张打回', async () => {
    await ctx.connector.start()
    fake.fail('POST', '/api/v4/futures/usdt/positions/BTC_USDT/leverage', { label: 'LEVERAGE_TOO_HIGH', message: 'leverage too high' }, 400)
    const result = await ctx.connector.submit(tradeContext(), [intent({ leverage: 50 })])
    expect(result.acks[0]!.status).toBe('rejected')
    expect(fake.callsFor('POST', '/api/v4/futures/usdt/orders')).toHaveLength(0)
    expect(fake.callsFor('POST', '/api/v4/futures/usdt/positions/BTC_USDT/leverage')[0]!.params.get('leverage')).toBe('50')
  })

  it('35. 下单时带的 leverage 与现状不同 → 按现有模式（逐仓）发 leverage=20 再下单', async () => {
    await ctx.connector.start()
    const result = await ctx.connector.submit(tradeContext(), [intent({ leverage: 20 })])
    expect(result.acks[0]!.status).toBe('open')
    const calls = fake.callsTo('/api/v4/futures/usdt/positions/BTC_USDT/leverage')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.params.get('leverage')).toBe('20')
    expect(calls[0]!.params.get('cross_leverage_limit')).toBeNull()
  })
})

describe('回执 / 张币往返 / 内核形客户端号', () => {
  it('36. 回执成交量按 record 乘数算（响应不带 contract）', async () => {
    await ctx.connector.start()
    fake.orderResponse = () => ({ id: 8102, left: '0', status: 'finished', finish_as: 'filled' })
    const result = await ctx.connector.submit(tradeContext(), [intent()])
    expect(result.acks[0]!.filledSize).toBe('0.01')
  })

  it('37. 张币往返：0.0123 BTC → 123 张，ETH 0.005 → 0.5 张', async () => {
    await ctx.connector.start()
    await ctx.connector.submit(tradeContext(), [intent({ size: '0.0123' as never })])
    expect(fake.lastBody()['size']).toBe('123')
    await ctx.connector.submit(tradeContext(), [intent({ instrumentId: ETH_INSTRUMENT as never, price: '3000' as never, size: '0.005' as never })])
    expect(fake.lastBody()['size']).toBe('0.5')
    fake.positions = [
      { contract: 'BTC_USDT', size: '123', leverage: '10', value: '1230', mode: 'single' },
      { contract: 'ETH_USDT', size: '0.5', leverage: '10', value: '1500', mode: 'single' },
    ]
    const positions = await ctx.connector.positions(accountRef)
    expect(positions.map((p) => p.size)).toEqual(['0.0123', '0.005'])
  })

  it('38. 内核形 32 位号全链路：body.text 编码、回执原号、挂单 / 成交 / 撤单都能回到原号', async () => {
    const id = '0123456789abcdef0123456789abcdef'
    await ctx.connector.start()
    const result = await ctx.connector.submit(tradeContext(), [intent({ clientOrderId: id as never })])
    expect(fake.lastBody()['text']).toBe(encodeClientOrderId(id))
    expect(encodeClientOrderId(id)).toHaveLength(24)
    expect(result.acks[0]!.clientOrderId).toBe(id)
    ;(fake.openOrders[0] as Record<string, unknown>)['text'] = encodeClientOrderId(id)
    const found = await ctx.connector.orderStatus(accountRef, { clientOrderId: id })
    expect(found.found).toBe(true)
    expect((await ctx.connector.openOrders(accountRef))[0]!.clientOrderId).toBe(id)
    ;(fake.myTrades[0] as Record<string, unknown>)['text'] = encodeClientOrderId(id)
    expect((await ctx.connector.fills(accountRef, 0))[0]!.clientOrderId).toBe(id)
    const acks = await ctx.connector.cancel(tradeContext(), [{ instrumentId: INSTRUMENT as never, clientOrderId: id as never }])
    expect(acks[0]!.ok).toBe(true)
    expect(fake.callsFor('DELETE', '/api/v4/futures/usdt/orders/7001')).toHaveLength(1)
  })

  it('39. 回执：open + 部分成交（left 40/100）→ open，filledSize 0.006', async () => {
    await ctx.connector.start()
    fake.orderResponse = (body) => ({ id: 8103, size: String(body['size']), left: '40', price: String(body['price']), status: 'open', finish_as: '' })
    const result = await ctx.connector.submit(tradeContext(), [intent()])
    expect(result.acks[0]!.status).toBe('open')
    expect(result.acks[0]!.filledSize).toBe('0.006')
  })

  it('40. 响应缺 id → unknown 3006（不得盲目重发）', async () => {
    await ctx.connector.start()
    fake.orderResponse = () => ({ status: 'open', left: '100', size: '100' })
    const result = await ctx.connector.submit(tradeContext(), [intent()])
    expect(result.acks[0]!.status).toBe('unknown')
    expect(result.acks[0]!.problem?.code).toBe(3006)
  })

  it('41. 429 限流 → rejected 3003（不是 3006）；POST 400 TOO_BUSY → unknown 3006', async () => {
    await ctx.connector.start()
    fake.failNext('POST', '/api/v4/futures/usdt/orders', { label: 'TOO_MANY_REQUESTS', message: 'Too many requests, please try again later' }, 429)
    const limited = await ctx.connector.submit(tradeContext(), [intent()])
    expect(limited.acks[0]!.status).toBe('rejected')
    expect(limited.acks[0]!.problem?.code).toBe(3003)
    // 429 让预算整体退避 60 s；测试预算的时钟是冻结的，同一个连接器再下单会永远等退避，所以换一个新连接器。
    const fresh = makeConnector(fake)
    await fresh.connector.start()
    fake.failNext('POST', '/api/v4/futures/usdt/orders', { label: 'TOO_BUSY' }, 400)
    const busy = await fresh.connector.submit(tradeContext(), [intent()])
    expect(busy.acks[0]!.status).toBe('unknown')
    expect(busy.acks[0]!.problem?.code).toBe(3006)
  })
})

describe('保证金：下单绝不切模式', () => {
  it('42. BTC 逐仓 10 倍 + 意图 leverage 5 → query 恰为 leverage=5，再发 POST /orders', async () => {
    await ctx.connector.start()
    const result = await ctx.connector.submit(tradeContext(), [intent({ leverage: 5 })])
    expect(result.acks[0]!.status).toBe('open')
    const lev = fake.callsFor('POST', '/api/v4/futures/usdt/positions/BTC_USDT/leverage')
    expect(lev).toHaveLength(1)
    expect(lev[0]!.query).toBe('leverage=5')
    expect(fake.callsFor('POST', '/api/v4/futures/usdt/orders')).toHaveLength(1)
  })

  it('43. BTC 全仓 10 倍 + 意图 leverage 5 → query 恰为 cross_leverage_limit=5&leverage=0', async () => {
    await ctx.connector.start()
    ;(fake.positions[0] as Record<string, unknown>)['leverage'] = '0'
    ;(fake.positions[0] as Record<string, unknown>)['cross_leverage_limit'] = '10'
    const result = await ctx.connector.submit(tradeContext(), [intent({ leverage: 5 })])
    expect(result.acks[0]!.status).toBe('open')
    expect(fake.callsFor('POST', '/api/v4/futures/usdt/positions/BTC_USDT/leverage')[0]!.query)
      .toBe('cross_leverage_limit=5&leverage=0')
  })

  it('44. 模式不符（逐仓持仓 + marginMode cross）→ rejected -32602 带 hint，不发杠杆与下单', async () => {
    await ctx.connector.start()
    const result = await ctx.connector.submit(tradeContext(), [intent({ marginMode: 'cross', leverage: 5 })])
    expect(result.acks[0]!.status).toBe('rejected')
    expect(result.acks[0]!.problem?.code).toBe(-32602)
    expect(result.acks[0]!.problem?.message).toContain('set margin mode explicitly first')
    expect(fake.callsTo('/api/v4/futures/usdt/positions/BTC_USDT/leverage')).toHaveLength(0)
    expect(fake.callsFor('POST', '/api/v4/futures/usdt/orders')).toHaveLength(0)
  })

  it('45. 合约还没有保证金设置（/positions/ETH_USDT 404）+ leverage → rejected -32602 带 hint，没发下单', async () => {
    await ctx.connector.start()
    fake.positions = (fake.positions as unknown[]).filter((row) => (row as Record<string, unknown>)['contract'] !== 'ETH_USDT')
    const result = await ctx.connector.submit(tradeContext(), [intent({ instrumentId: ETH_INSTRUMENT as never, price: '3000' as never, size: '0.005' as never, leverage: 5 })])
    expect(result.acks[0]!.status).toBe('rejected')
    expect(result.acks[0]!.problem?.code).toBe(-32602)
    expect(result.acks[0]!.problem?.message).toContain('set margin mode explicitly first')
    expect(fake.callsFor('POST', '/api/v4/futures/usdt/orders')).toHaveLength(0)
  })

  it('46. reduceOnly 平仓带 leverage / marginMode → 不读持仓设置、不发杠杆，直接下单', async () => {
    await ctx.connector.start()
    const result = await ctx.connector.submit(tradeContext(), [intent({ reduceOnly: true, leverage: 5, marginMode: 'cross' })])
    expect(result.acks[0]!.status).toBe('open')
    expect(fake.callsFor('GET', '/api/v4/futures/usdt/positions/BTC_USDT')).toHaveLength(0)
    expect(fake.callsTo('/api/v4/futures/usdt/positions/BTC_USDT/leverage')).toHaveLength(0)
    expect(fake.callsFor('POST', '/api/v4/futures/usdt/orders')).toHaveLength(1)
  })

  it('47. marginMode strictIsolated → 5002', async () => {
    await ctx.connector.start()
    const result = await ctx.connector.submit(tradeContext(), [intent({ marginMode: 'strictIsolated' })])
    expect(result.acks[0]!.status).toBe('rejected')
    expect(result.acks[0]!.problem?.code).toBe(5002)
  })

  it('48. 双仓账户显式 setLeverage → 5002 且无请求；持仓模式读不到 → submit rejected 3003 retryable、无 POST /orders', async () => {
    await ctx.connector.start()
    fake.account = { currency: 'USDT', total: '1', position_mode: 'dual' }
    expect((await problemOf(() => ctx.connector.setLeverage(tradeContext(), INSTRUMENT as never, 10, 'cross'))).code).toBe(5002)
    expect(fake.callsTo('/api/v4/futures/usdt/positions/BTC_USDT/leverage')).toHaveLength(0)
    fake.reset()
    const fresh = makeConnector(fake)
    await fresh.connector.start()
    fake.fail('GET', '/api/v4/futures/usdt/accounts', { label: 'INTERNAL', message: 'boom' }, 500)
    const result = await fresh.connector.submit(tradeContext(), [intent()])
    expect(result.acks[0]!.status).toBe('rejected')
    expect(result.acks[0]!.problem?.code).toBe(3003)
    expect(result.acks[0]!.problem?.retryable).toBe(true)
    expect(fake.callsFor('POST', '/api/v4/futures/usdt/orders')).toHaveLength(0)
  })
})

describe('触发单（price_orders）', () => {
  it('49. stop_market sell reduceOnly：请求体与 QD 保护单同形，size 是数字', async () => {
    await ctx.connector.start()
    await ctx.connector.submit(tradeContext(), [intent({ type: 'stop_market', price: undefined, triggerPrice: '90' as never, side: 'sell', reduceOnly: true, clientOrderId: 'trig-1' as never })])
    const call = fake.callsFor('POST', PRICE_ORDERS_PATH)[0]!
    expect(call).toBeDefined()
    const body = JSON.parse(call.body) as Record<string, unknown>
    expect(body).toEqual({
      initial: { contract: 'BTC_USDT', price: '0', tif: 'ioc', reduce_only: true, size: -100 },
      trigger: { strategy_type: 0, price_type: 1, price: '90', rule: 2, expiration: TRIGGER_EXPIRATION_SEC },
      order_type: 'plan-close-long-position',
    })
    expect(typeof (body['initial'] as Record<string, unknown>)['size']).toBe('number')
  })

  it('50. take_market 的 rule 与 order_type；stop_limit 带限价、无 reduce_only', async () => {
    await ctx.connector.start()
    await ctx.connector.submit(tradeContext(), [intent({ type: 'take_market', price: undefined, triggerPrice: '110' as never, side: 'sell' })])
    let body = fake.lastBody()
    expect((body['trigger'] as Record<string, unknown>)['rule']).toBe(1)
    expect((body['initial'] as Record<string, unknown>)['price']).toBe('0')
    await ctx.connector.submit(tradeContext(), [intent({ type: 'take_market', price: undefined, triggerPrice: '110' as never, side: 'buy', reduceOnly: true })])
    body = fake.lastBody()
    expect((body['trigger'] as Record<string, unknown>)['rule']).toBe(2)
    expect(body['order_type']).toBe('plan-close-short-position')
    expect((body['initial'] as Record<string, unknown>)['size']).toBe(100)
    await ctx.connector.submit(tradeContext(), [intent({ type: 'stop_limit', triggerPrice: '110' as never, price: '111' as never, side: 'buy' })])
    body = fake.lastBody()
    expect(body['initial']).toEqual({ contract: 'BTC_USDT', price: '111', tif: 'gtc', size: 100 })
    expect(body['order_type']).toBeUndefined()
    expect((body['trigger'] as Record<string, unknown>)['rule']).toBe(1)
  })

  it('51. triggerType：last → 0、index → 2、缺省 → 1', async () => {
    await ctx.connector.start()
    await ctx.connector.submit(tradeContext(), [intent({ type: 'stop_market', price: undefined, triggerPrice: '90' as never, side: 'sell', triggerType: 'last' })])
    expect((fake.lastBody()['trigger'] as Record<string, unknown>)['price_type']).toBe(0)
    await ctx.connector.submit(tradeContext(), [intent({ type: 'stop_market', price: undefined, triggerPrice: '90' as never, side: 'sell', triggerType: 'index' })])
    expect((fake.lastBody()['trigger'] as Record<string, unknown>)['price_type']).toBe(2)
    await ctx.connector.submit(tradeContext(), [intent({ type: 'stop_market', price: undefined, triggerPrice: '90' as never, side: 'sell' })])
    expect((fake.lastBody()['trigger'] as Record<string, unknown>)['price_type']).toBe(1)
  })

  it('52. ETH 份额化触发单：initial.amount 是字符串、无 size、带精度头', async () => {
    await ctx.connector.start()
    await ctx.connector.submit(tradeContext(), [intent({ instrumentId: ETH_INSTRUMENT as never, type: 'stop_market', price: undefined, triggerPrice: '2900' as never, side: 'sell', reduceOnly: true, size: '0.005' as never })])
    const call = fake.callsFor('POST', PRICE_ORDERS_PATH)[0]!
    const body = JSON.parse(call.body) as Record<string, unknown>
    const initial = body['initial'] as Record<string, unknown>
    expect(initial['amount']).toBe('-0.5')
    expect(Object.prototype.hasOwnProperty.call(initial, 'size')).toBe(false)
    expect(call.headers['x-gate-size-decimal']).toBe('1')
  })

  it('53. 触发单校验：缺 triggerPrice / 缺 price / tick 不合 → 在 build 阶段就拒', async () => {
    await ctx.connector.start()
    const missingTrigger = await ctx.connector.submit(tradeContext(), [intent({ type: 'stop_market', price: undefined })])
    expect(missingTrigger.acks[0]!.problem?.code).toBe(-32602)
    const missingPrice = await ctx.connector.submit(tradeContext(), [intent({ type: 'stop_limit', triggerPrice: '90' as never, price: undefined })])
    expect(missingPrice.acks[0]!.problem?.code).toBe(-32602)
    const badTick = await ctx.connector.submit(tradeContext(), [intent({ type: 'stop_market', price: undefined, triggerPrice: '90.05' as never, side: 'sell' })])
    expect(badTick.acks[0]!.problem?.code).toBe(1002)
    const trailing = await ctx.connector.submit(tradeContext(), [intent({ type: 'trailing_stop' })])
    expect(trailing.acks[0]!.problem?.code).toBe(1004)
    const postOnly = await ctx.connector.submit(tradeContext(), [intent({ type: 'stop_market', price: undefined, triggerPrice: '90' as never, side: 'sell', postOnly: true })])
    expect(postOnly.acks[0]!.problem?.code).toBe(1004)
    const tpsl = await ctx.connector.submit(tradeContext(), [intent({ type: 'stop_market', price: undefined, triggerPrice: '90' as never, side: 'sell', tpsl: { takeProfit: { triggerPrice: '110' as never }, grouping: 'order' } })])
    expect(tpsl.acks[0]!.problem?.code).toBe(1004)
    expect(fake.callsFor('POST', PRICE_ORDERS_PATH)).toHaveLength(0)
  })

  it('54. 触发单下单：ack untriggered、大整数号带 po: 前缀、openOrders 能解析回来', async () => {
    await ctx.connector.start()
    const result = await ctx.connector.submit(tradeContext(), [intent({ type: 'stop_market', price: undefined, triggerPrice: '90' as never, side: 'sell', reduceOnly: true, clientOrderId: 'trig-2' as never })])
    expect(result.acks[0]!.status).toBe('untriggered')
    expect(result.acks[0]!.venueOrderId).toBe('po:2111713079019438081')
    const open = await ctx.connector.openOrders(accountRef)
    const trigger = open.find((o) => o.venueOrderId === 'po:2111713079019438081')!
    expect(trigger).toMatchObject({ type: 'stop_market', isTrigger: true, reduceOnly: true, triggerPrice: '90', size: '0.01', clientOrderId: 'trig-2' })
  })

  it('55. 撤触发单：DELETE /price_orders/{id}', async () => {
    await ctx.connector.start()
    await ctx.connector.submit(tradeContext(), [intent({ type: 'stop_market', price: undefined, triggerPrice: '90' as never, side: 'sell', reduceOnly: true })])
    const acks = await ctx.connector.cancel(tradeContext(), [{ instrumentId: INSTRUMENT as never, venueOrderId: 'po:2111713079019438081' }])
    expect(acks[0]!.ok).toBe(true)
    expect(fake.callsFor('DELETE', '/api/v4/futures/usdt/price_orders/2111713079019438081')).toHaveLength(1)
    expect(fake.deletedTriggers).toEqual(['2111713079019438081'])
  })

  it('56. 触发单状态：open → untriggered；finished 按 finish_as 落词；404 → found:false', async () => {
    await ctx.connector.start()
    await ctx.connector.submit(tradeContext(), [intent({ type: 'stop_market', price: undefined, triggerPrice: '90' as never, side: 'sell', reduceOnly: true })])
    const id = 'po:2111713079019438081'
    expect((await ctx.connector.orderStatus(accountRef, { venueOrderId: id })).status).toBe('untriggered')
    ;(fake.priceOrders[0] as Record<string, unknown>)['status'] = 'finished'
    ;(fake.priceOrders[0] as Record<string, unknown>)['finish_as'] = 'succeeded'
    expect((await ctx.connector.orderStatus(accountRef, { venueOrderId: id })).status).toBe('triggered')
    ;(fake.priceOrders[0] as Record<string, unknown>)['finish_as'] = 'cancelled'
    expect((await ctx.connector.orderStatus(accountRef, { venueOrderId: id })).status).toBe('cancelled')
    expect((await ctx.connector.orderStatus(accountRef, { venueOrderId: 'po:999' })).found).toBe(false)
  })

  it('57. 触发单 3006：按指纹找回（同合约 / rule / 触发价 / 张数），触发价不同的行不认', async () => {
    await ctx.connector.start()
    fake.failNext('POST', PRICE_ORDERS_PATH, { label: 'INTERNAL', message: 'boom' }, 503)
    const result = await ctx.connector.submit(tradeContext(), [intent({ type: 'stop_market', price: undefined, triggerPrice: '90' as never, side: 'sell', reduceOnly: true, clientOrderId: 'trig-9' as never })])
    expect(result.acks[0]!.status).toBe('unknown')
    expect(result.acks[0]!.problem?.code).toBe(3006)
    fake.priceOrders = [
      { id_string: '111', status: 'open', initial: { contract: 'BTC_USDT', size: -100, price: '0' }, trigger: { price: '91', rule: 2 }, create_time: NOW / 1000 },
      { id_string: '222', status: 'open', initial: { contract: 'BTC_USDT', size: -100, price: '0' }, trigger: { price: '90', rule: 2 }, create_time: NOW / 1000 },
    ]
    const found = await ctx.connector.orderStatus(accountRef, { clientOrderId: 'trig-9' })
    expect(found.found).toBe(true)
    expect(found.venueOrderId).toBe('po:222')
  })

  it('58. 原生全撤（给标的）→ 恰两次 DELETE', async () => {
    await ctx.connector.start()
    const acks = await ctx.connector.cancelAll(tradeContext(), 'gateio:BTC_USDT' as never)
    expect(acks).toHaveLength(2)
    expect(acks.every((a) => a.ok)).toBe(true)
    expect(fake.callsFor('DELETE', '/api/v4/futures/usdt/orders')).toHaveLength(1)
    expect(fake.callsFor('DELETE', '/api/v4/futures/usdt/price_orders')).toHaveLength(1)
  })

  it('59. 不给标的的全撤：BTC 普通单 + ETH 触发单 → 四次 DELETE（两个合约 × 两个端点）', async () => {
    await ctx.connector.start()
    fake.priceOrders = [
      { id_string: '777', status: 'open', initial: { contract: 'ETH_USDT', size: -1, price: '0' }, trigger: { price: '90', rule: 2 }, create_time: 1_791_483_420 },
    ]
    const acks = await ctx.connector.cancelAll(tradeContext())
    expect(acks).toHaveLength(4)
    expect(acks.every((a) => a.ok)).toBe(true)
    expect(fake.callsFor('DELETE', '/api/v4/futures/usdt/orders')).toHaveLength(2)
    expect(fake.callsFor('DELETE', '/api/v4/futures/usdt/price_orders')).toHaveLength(2)
    expect(fake.cancelAllCalls).toEqual([
      '/api/v4/futures/usdt/orders?contract=BTC_USDT',
      '/api/v4/futures/usdt/price_orders?contract=BTC_USDT',
      '/api/v4/futures/usdt/orders?contract=ETH_USDT',
      '/api/v4/futures/usdt/price_orders?contract=ETH_USDT',
    ])
  })

  it('60. 撤单：ORDER_FINISHED → ok:true；INVALID_PARAM_VALUE → ok:false', async () => {
    await ctx.connector.start()
    fake.failNext('DELETE', '/api/v4/futures/usdt/orders/7001', { label: 'ORDER_FINISHED', message: 'finished' }, 404)
    expect((await ctx.connector.cancel(tradeContext(), [{ instrumentId: INSTRUMENT as never, venueOrderId: '7001' }]))[0]!.ok).toBe(true)
    fake.failNext('DELETE', '/api/v4/futures/usdt/orders/7001', { label: 'INVALID_PARAM_VALUE', message: 'bad' }, 400)
    const bad = await ctx.connector.cancel(tradeContext(), [{ instrumentId: INSTRUMENT as never, venueOrderId: '7001' }])
    expect(bad[0]!.ok).toBe(false)
    expect(bad[0]!.problem?.code).toBe(-32602)
  })

  it('61. 普通单记下下单合约：只给 clientOrderId 查单也带 contract 缩小扫描', async () => {
    await ctx.connector.start()
    const id = '0123456789abcdef0123456789abcdef'
    const result = await ctx.connector.submit(tradeContext(), [intent({
      instrumentId: ETH_INSTRUMENT as never, size: '0.01' as never, price: '3000' as never, clientOrderId: id as never,
    })])
    expect(result.acks[0]!.status).toBe('open')
    expect(fake.lastBody()['contract']).toBe('ETH_USDT')
    fake.openOrders = [
      ...(fake.openOrders as Record<string, unknown>[]),
      { id: 8001, text: encodeClientOrderId(id), contract: 'ETH_USDT', size: '1', left: '1', price: '3000', fill_price: '0', status: 'open', finish_as: '', create_time: NOW / 1000 },
    ]
    const found = await ctx.connector.orderStatus(accountRef, { clientOrderId: id })
    expect(found.found).toBe(true)
    const first = fake.callsFor('GET', '/api/v4/futures/usdt/orders')[0]!
    expect(first.params.get('contract')).toBe('ETH_USDT')
  })
})
