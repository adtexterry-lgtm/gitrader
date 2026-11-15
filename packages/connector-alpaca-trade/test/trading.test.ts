// SPDX-License-Identifier: CPAL-1.0
// 交易路径（十二条 #2 #3 #9；美股八条第 6、7 条）：下单 / 改单 PATCH / 撤单 DELETE 单张 / 全撤 DELETE 官方端点 /
// 3006 后按 client_order_id 对账 / 位置级 OCO / 定时全撤 5002 / 杠杆只能等于账户倍数。
import { describe, expect, it } from 'vitest'
import type { AccountId, OrderIntent } from '@gitrader/protocol'
import type { SocketLike } from '../src/stream'
import { FakeAlpaca, NOW, orderRow, positionRow } from './helpers/fake-alpaca'
import { ADDRESS, accountRef, ackProblem, makeConnector, problemOf, tradeContext } from './helpers/connector'

const ACCOUNT = 'acct_alpaca_test' as AccountId
const CID = 'b'.repeat(32)

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

/** 第一条 POST /v2/orders 的 body（前面的 GET /v2/account 没有 body）。 */
function postBody(fake: FakeAlpaca): Record<string, unknown> {
  const call = fake.callsFor('POST', '/v2/orders')[0]
  return call === undefined || call.body === '' ? {} : (JSON.parse(call.body) as Record<string, unknown>)
}

async function setup(over: Parameters<typeof makeConnector>[1] = {}) {
  const fake = new FakeAlpaca()
  const t = makeConnector(fake, over)
  await t.connector.start()
  return { fake, ...t }
}

/** 假 socket（私有流改写测试用；不联网）。 */
class TestSocket implements SocketLike {
  sent: string[] = []
  onopen: ((ev?: unknown) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: ((ev?: unknown) => void) | null = null
  onerror: ((ev?: unknown) => void) | null = null
  send(data: string): void { this.sent.push(data) }
  close(): void { this.onclose?.() }
  open(): void { this.onopen?.() }
  emit(payload: unknown): void { this.onmessage?.({ data: JSON.stringify(payload) }) }
}

describe('submit：下单', () => {
  it('限价买单：POST /v2/orders，回执带 venueOrderId', async () => {
    const { fake, connector, trading } = await setup()
    const result = await trading.submit(tradeContext(), [intent({ clientOrderId: CID })])
    expect(result.acks).toHaveLength(1)
    const ack = result.acks[0]!
    expect(ack.venueOrderId).toBe('ord-1')
    expect(ack.clientOrderId).toBe(CID)
    expect(ack.status).toBe('open')
    expect(ack.filledSize).toBe('0')
    const body = postBody(fake)
    expect(body['symbol']).toBe('AAPL')
    expect(body['side']).toBe('buy')
    expect(body['type']).toBe('limit')
    expect(body['time_in_force']).toBe('gtc')
    expect(body['qty']).toBe('1')
    expect(body['client_order_id']).toBe(CID)
    expect(connector.environment).toBe('testnet')
  })
  it('receiptHash 是 sha256 十六进制，requestWeight 计一次下单', async () => {
    const { trading } = await setup()
    const result = await trading.submit(tradeContext(), [intent()])
    expect(result.receiptHash).toMatch(/^[0-9a-f]{64}$/)
    expect(result.requestWeight).toBe(1)
  })
  it('市价意图：body 是价带限价 + ioc', async () => {
    const { fake, trading } = await setup()
    await trading.submit(tradeContext(), [intent({ type: 'market', price: undefined, maxSlippageBps: 50 })])
    const body = postBody(fake)
    expect(body['type']).toBe('limit')
    expect(body['time_in_force']).toBe('ioc')
    // fake 的 snapshot ask = 190.02 → ×1.005 = 190.9701 → 贴 tick 向下 190.97
    expect(body['limit_price']).toBe('190.97')
  })
  it('bracket：回执 role=parent，body 带 order_class 与两条腿', async () => {
    const { fake, trading } = await setup()
    const result = await trading.submit(tradeContext(), [intent({ tpsl: { takeProfit: { triggerPrice: '200' }, stopLoss: { triggerPrice: '180' }, grouping: 'order' } })])
    expect(result.acks[0]?.role).toBe('parent')
    expect(postBody(fake)['order_class']).toBe('bracket')
  })
  it('整股标的 size 1.5 → 1002 且 POST 0 次（不静默截成 1 股）', async () => {
    const { fake, trading } = await setup()
    const result = await trading.submit(tradeContext(), [intent({ instrumentId: 'alpaca:WHOLE', size: '1.5' })])
    expect(ackProblem(result.acks[0]).code).toBe(1002)
    expect(ackProblem(result.acks[0]).message).toContain('not a multiple of')
    expect(fake.callsFor('POST', '/v2/orders')).toHaveLength(0)
  })
  it('碎股的市价意图 → INVALID_PARAMS 且 POST 0 次', async () => {
    const { fake, trading } = await setup()
    const result = await trading.submit(tradeContext(), [intent({ type: 'market', price: undefined, maxSlippageBps: 20, size: '0.5' })])
    expect(ackProblem(result.acks[0]).code).toBe(-32602)
    expect(fake.callsFor('POST', '/v2/orders')).toHaveLength(0)
  })
  it('一张坏单不影响同批下一张，且坏单不发请求', async () => {
    const { fake, trading } = await setup()
    const result = await trading.submit(tradeContext(), [
      intent({ instrumentId: 'alpaca:WHOLE', size: '0.5' }),
      intent(),
    ])
    expect(result.acks).toHaveLength(2)
    expect(result.acks[0]?.status).toBe('rejected')
    expect(ackProblem(result.acks[0]).code).toBe(1002)
    expect(result.acks[1]?.status).toBe('open')
    expect(fake.callsFor('POST', '/v2/orders')).toHaveLength(1)
  })
  it('账户冻结（trading_blocked）→ 整批拒，0 次下单请求', async () => {
    const { fake, trading } = await setup()
    fake.account = { ...fake.account, trading_blocked: true }
    const result = await trading.submit(tradeContext(), [intent()])
    expect(result.acks[0]?.status).toBe('rejected')
    expect(ackProblem(result.acks[0]).code).toBe(3001)
    expect(fake.callsFor('POST', '/v2/orders')).toHaveLength(0)
  })
  it('account_blocked 同口径', async () => {
    const { fake, trading } = await setup()
    fake.account = { ...fake.account, account_blocked: true }
    const result = await trading.submit(tradeContext(), [intent()])
    expect(ackProblem(result.acks[0]).message).toContain('blocked')
    expect(fake.callsFor('POST', '/v2/orders')).toHaveLength(0)
  })
  it('休市（周六）→ 拒单且不发请求（不排队到次日）', async () => {
    const { fake, trading, setNow } = await setup()
    setNow(1_792_850_400_000) // 2026-10-24 10:00 ET 周六
    const result = await trading.submit(tradeContext(), [intent()])
    expect(ackProblem(result.acks[0]).code).toBe(-32602)
    expect(fake.callsFor('POST', '/v2/orders')).toHaveLength(0)
  })
  it('卖出超过持仓且不可做空 → 拒单，不发请求', async () => {
    const { fake, trading } = await setup()
    const result = await trading.submit(tradeContext(), [intent({ instrumentId: 'alpaca:NOSHORT', side: 'sell', size: '50' })])
    expect(ackProblem(result.acks[0]).code).toBe(3001)
    expect(fake.callsFor('POST', '/v2/orders')).toHaveLength(0)
  })
  it('POST 5xx → ack.status=unknown + 3006，且按 client_order_id 能对账回真实状态', async () => {
    const { fake, trading } = await setup()
    // 上游其实收下了这张单（模拟「请求发出去了但响应丢了」）。
    fake.openOrders = [orderRow({ id: 'ord-lost', client_order_id: CID, status: 'new' })]
    fake.failNext('POST', '/v2/orders', { message: 'internal server error' }, 500)
    const result = await trading.submit(tradeContext(), [intent({ clientOrderId: CID })])
    const ack = result.acks[0]!
    expect(ack.status).toBe('unknown')
    expect(ack.problem?.code).toBe(3006)
    expect(ack.problem?.retryable).toBe(false)
    const status = await trading.reconcile(tradeContext(), CID)
    expect(status.found).toBe(true)
    expect(status.venueOrderId).toBe('ord-lost')
    expect(status.status).toBe('open')
    expect(fake.callsFor('POST', '/v2/orders')).toHaveLength(1) // 不重发
  })
  it('qty_available=0 时 reduce-only 卖 10 → INVALID_PARAMS 且 POST 0 次', async () => {
    const { fake, trading } = await setup()
    fake.positions = [positionRow({ qty: '10', qty_available: '0' })]
    const result = await trading.submit(tradeContext(), [intent({ side: 'sell', size: '10', reduceOnly: true })])
    expect(ackProblem(result.acks[0]).code).toBe(-32602)
    expect(ackProblem(result.acks[0]).message).toContain('reduce-only')
    expect(fake.callsFor('POST', '/v2/orders')).toHaveLength(0)
  })
  it('两次卖单之间持仓变空 → 第二次被拒（每次都新拉持仓）', async () => {
    const { fake, trading } = await setup()
    const first = await trading.submit(tradeContext(), [intent({ side: 'sell', size: '5', reduceOnly: true })])
    expect(first.acks[0]?.status).toBe('open')
    fake.positions = []
    const second = await trading.submit(tradeContext(), [intent({ side: 'sell', size: '5', reduceOnly: true })])
    expect(ackProblem(second.acks[0]).code).toBe(-32602)
    expect(fake.callsFor('GET', '/v2/positions')).toHaveLength(2)
    expect(fake.callsFor('POST', '/v2/orders')).toHaveLength(1)
  })
  it('坏单回执用预置 clientOrderId（对得上账本）', async () => {
    const { trading } = await setup()
    const result = await trading.submit(tradeContext(), [intent({ clientOrderId: CID, price: '1.005' })])
    expect(result.acks[0]?.clientOrderId).toBe(CID)
  })
  it('账户读取失败时卖单 fail closed（不把平仓发成开空）', async () => {
    const { fake, trading } = await setup()
    fake.fail('GET', '/v2/positions', { code: 50010000, message: 'internal error' }, 500)
    const result = await trading.submit(tradeContext(), [intent({ side: 'sell', size: '1' })])
    expect(ackProblem(result.acks[0]).message).toContain('cannot verify')
    expect(fake.callsFor('POST', '/v2/orders')).toHaveLength(0)
  })
})

describe('cancel：撤单（DELETE 单张）', () => {
  it('按 venueOrderId 撤：DELETE /v2/orders/{id}', async () => {
    const { fake, trading } = await setup()
    const acks = await trading.cancel(tradeContext(), [{ instrumentId: 'alpaca:AAPL', venueOrderId: 'ord-open-1' }])
    expect(acks[0]?.ok).toBe(true)
    expect(fake.callsFor('DELETE', '/v2/orders/ord-open-1')).toHaveLength(1)
  })
  it('只有 clientOrderId：先按官方端点查 id 再撤', async () => {
    const { fake, trading } = await setup()
    const acks = await trading.cancel(tradeContext(), [{ instrumentId: 'alpaca:AAPL', clientOrderId: 'client-open-1' }])
    expect(acks[0]?.ok).toBe(true)
    expect(fake.callsFor('GET', '/v2/orders:by_client_order_id')).toHaveLength(1)
    expect(fake.callsFor('DELETE', '/v2/orders/ord-open-1')).toHaveLength(1)
  })
  it('查不到的 clientOrderId → ok:false，不发 DELETE', async () => {
    const { fake, trading } = await setup()
    const acks = await trading.cancel(tradeContext(), [{ instrumentId: 'alpaca:AAPL', clientOrderId: 'nope' }])
    expect(acks[0]?.ok).toBe(false)
    expect(acks[0]?.problem?.code).toBe(3001)
    expect(fake.callsFor('DELETE', '/v2/orders/ord-open-1')).toHaveLength(0)
  })
  it('既没有 venueOrderId 也没有 clientOrderId → INVALID_PARAMS', async () => {
    const { trading } = await setup()
    const acks = await trading.cancel(tradeContext(), [{ instrumentId: 'alpaca:AAPL' }])
    expect(acks[0]?.problem?.code).toBe(-32602)
  })
  it('DELETE 5xx → ok:false + 3006（不重试）', async () => {
    const { fake, trading } = await setup()
    fake.fail('DELETE', '/v2/orders/ord-open-1', { message: 'service unavailable' }, 503)
    const acks = await trading.cancel(tradeContext(), [{ instrumentId: 'alpaca:AAPL', venueOrderId: 'ord-open-1' }])
    expect(acks[0]?.ok).toBe(false)
    expect(acks[0]?.problem?.code).toBe(3006)
  })
})

describe('cancelAll：全撤用官方 DELETE /v2/orders（教训 2）', () => {
  it('不给标的：一次 DELETE /v2/orders，逐张 POST 撤单 0 次', async () => {
    const { fake, trading } = await setup()
    const acks = await trading.cancelAll(tradeContext())
    expect(acks).toHaveLength(1)
    expect(acks[0]?.ok).toBe(true)
    expect(fake.callsFor('DELETE', '/v2/orders')).toHaveLength(1)
    expect(fake.calls.filter((c) => c.method === 'DELETE' && c.path.startsWith('/v2/orders/'))).toHaveLength(0)
  })
  it('207 里有一行失败 → ok:false 并报出数量', async () => {
    const { fake, trading } = await setup()
    fake.failWith.set('DELETE /v2/orders', () => new Response(JSON.stringify([{ id: 'a', status: 200 }, { id: 'b', status: 422 }]), {
      status: 207, headers: { 'content-type': 'application/json' },
    }))
    const acks = await trading.cancelAll(tradeContext())
    expect(acks[0]?.ok).toBe(false)
    expect(acks[0]?.problem?.message).toContain('1 of 2')
  })
  it('给标的：按标的列挂单后逐张 DELETE', async () => {
    const { fake, trading } = await setup()
    const acks = await trading.cancelAll(tradeContext(), 'alpaca:AAPL')
    expect(acks[0]?.ok).toBe(true)
    expect(fake.callsFor('GET', '/v2/orders')).toHaveLength(1)
    expect(fake.callsFor('DELETE', '/v2/orders/ord-open-1')).toHaveLength(1)
  })
  it('给标的但一张失败 → ok:false，消息含 n of m', async () => {
    const { fake, trading } = await setup()
    fake.fail('DELETE', '/v2/orders/ord-open-1', { message: 'order not found' }, 404)
    const acks = await trading.cancelAll(tradeContext(), 'alpaca:AAPL')
    expect(acks[0]?.ok).toBe(false)
    expect(acks[0]?.problem?.message).toContain('1 of 1')
  })
  it('挂单列表读失败 → ok:false 且 0 次撤单', async () => {
    const { fake, trading } = await setup()
    fake.fail('GET', '/v2/orders', { message: 'internal error' }, 500)
    const acks = await trading.cancelAll(tradeContext(), 'alpaca:AAPL')
    expect(acks[0]?.ok).toBe(false)
    expect(fake.calls.filter((c) => c.method === 'DELETE')).toHaveLength(0)
  })
})

describe('amend：改单（PATCH）', () => {
  it('限价单改量改价 → PATCH 只带 qty / limit_price / time_in_force', async () => {
    const { fake, trading } = await setup()
    const result = await trading.amend(tradeContext(), {
      instrumentId: 'alpaca:AAPL',
      venueOrderId: 'ord-open-1',
      order: intent({ size: '2', price: '191.00' }),
    })
    expect(result.acks[0]?.status).toBe('open')
    const body = fake.lastBody()
    expect(body['qty']).toBe('2')
    expect(body['limit_price']).toBe('191')
    expect(body['time_in_force']).toBe('gtc')
    expect(body['symbol']).toBeUndefined()
    expect(body['side']).toBeUndefined()
    expect(body['type']).toBeUndefined()
  })
  it('带腿的单不能改 → 1004 且不发 PATCH', async () => {
    const { fake, trading } = await setup()
    const submit = await trading.submit(tradeContext(), [intent({ clientOrderId: CID, tpsl: { takeProfit: { triggerPrice: '200' }, stopLoss: { triggerPrice: '180' }, grouping: 'order' } })])
    const venueOrderId = submit.acks[0]?.venueOrderId ?? ''
    const result = await trading.amend(tradeContext(), { instrumentId: 'alpaca:AAPL', venueOrderId, order: intent({ price: '191.00' }) })
    expect(result.acks[0]?.problem?.code).toBe(1004)
    expect(fake.calls.filter((c) => c.method === 'PATCH')).toHaveLength(0)
  })
  it('市价意图不能改（价带是一次性的）→ 1004', async () => {
    const { fake, trading } = await setup()
    const result = await trading.amend(tradeContext(), {
      instrumentId: 'alpaca:AAPL', venueOrderId: 'ord-open-1',
      order: intent({ type: 'market', price: undefined, maxSlippageBps: 20 }),
    })
    expect(result.acks[0]?.problem?.code).toBe(1004)
    expect(fake.calls.filter((c) => c.method === 'PATCH')).toHaveLength(0)
  })
  it('查不到原单 → 3001', async () => {
    const { trading } = await setup()
    const result = await trading.amend(tradeContext(), { instrumentId: 'alpaca:AAPL', venueOrderId: 'missing', order: intent() })
    expect(result.acks[0]?.problem?.code).toBe(3001)
  })
  it('既无 venueOrderId 也无 clientOrderId → INVALID_PARAMS', async () => {
    const { trading } = await setup()
    const result = await trading.amend(tradeContext(), { instrumentId: 'alpaca:AAPL', order: intent() })
    expect(result.acks[0]?.problem?.code).toBe(-32602)
  })
  it('按 clientOrderId 改（先查 id 再 PATCH），回执仍用原 client id', async () => {
    const { fake, trading } = await setup()
    const result = await trading.amend(tradeContext(), { instrumentId: 'alpaca:AAPL', clientOrderId: 'client-open-1', order: intent({ size: '3' }) })
    expect(result.acks[0]?.clientOrderId).toBe('client-open-1')
    expect(result.acks[0]?.venueOrderId).toBe('ord-1')
    expect(fake.last()?.method).toBe('PATCH')
  })
  it('改追踪止损：PATCH body 用 trail，不用 trail_percent', async () => {
    const { fake, trading } = await setup()
    fake.openOrders = [orderRow({ id: 'ord-trail', client_order_id: 'client-trail', type: 'trailing_stop', order_class: 'simple' })]
    const result = await trading.amend(tradeContext(), {
      instrumentId: 'alpaca:AAPL', venueOrderId: 'ord-trail', clientOrderId: 'client-trail',
      order: intent({ type: 'trailing_stop', price: undefined, trailing: { callbackRatio: '0.02' } }),
    })
    expect(result.acks[0]?.status).toBe('open')
    const body = fake.lastBody()
    expect(body['trail']).toBe('2')
    expect(body['trail_percent']).toBeUndefined()
  })
  it('PATCH 断网 → ack.status=unknown + 3006，且只发一次', async () => {
    const { fake, trading } = await setup()
    fake.networkError('PATCH', '/v2/orders/ord-open-1')
    const result = await trading.amend(tradeContext(), { instrumentId: 'alpaca:AAPL', venueOrderId: 'ord-open-1', order: intent({ size: '2' }) })
    expect(result.acks[0]?.status).toBe('unknown')
    expect(result.acks[0]?.problem?.code).toBe(3006)
    expect(fake.callsFor('PATCH', '/v2/orders/ord-open-1')).toHaveLength(1)
  })
  it('replace 返回新单：ack 用原 clientOrderId，venueOrderId 用新 id；按原 id 查单追到活单', async () => {
    const { fake, trading, accounts } = await setup()
    const result = await trading.amend(tradeContext(), {
      instrumentId: 'alpaca:AAPL', venueOrderId: 'ord-open-1', clientOrderId: 'client-open-1', order: intent({ size: '2' }),
    })
    const ack = result.acks[0]!
    expect(ack.clientOrderId).toBe('client-open-1')
    expect(ack.venueOrderId).toBe('ord-1')
    const status = await accounts.orderStatus(accountRef, { clientOrderId: 'client-open-1' })
    expect(status.found).toBe(true)
    expect(status.venueOrderId).toBe('ord-1')
    expect(status.status).toBe('open')
    expect(fake.callsFor('GET', '/v2/orders/ord-1')).toHaveLength(1)
  })
  it('流事件改写回原 clientOrderId；replaced 事件不外发', async () => {
    const socket = new TestSocket()
    const fake = new FakeAlpaca()
    const t = makeConnector(fake, { streamSocket: () => socket })
    await t.connector.start()
    await t.trading.amend(tradeContext(), {
      instrumentId: 'alpaca:AAPL', venueOrderId: 'ord-open-1', clientOrderId: 'client-open-1', order: intent({ size: '2' }),
    })
    const fills: Array<{ clientOrderId: string | null }> = []
    const updates: Array<{ status: string }> = []
    t.connector.subscribe({ channel: 'userFills', address: ADDRESS }, (e) => {
      if (e.channel === 'userFills') fills.push(...e.fills)
    })
    t.connector.subscribe({ channel: 'orderUpdates', address: ADDRESS }, (e) => {
      if (e.channel === 'orderUpdates') updates.push(...e.updates)
    })
    const ready = t.connector.stream.connect()
    socket.open()
    socket.emit({ stream: 'authorization', data: { status: 'authorized' } })
    socket.emit({ stream: 'listening', data: { streams: ['trade_updates'] } })
    await ready
    socket.emit({
      stream: 'trade_updates',
      data: {
        event: 'fill', execution_id: 'exec-1', price: '190.01', qty: '5', timestamp: '2026-10-21T13:35:00Z',
        order: { id: 'ord-1', client_order_id: 'client-r1', symbol: 'AAPL', side: 'buy', status: 'filled', qty: '5', filled_qty: '5' },
      },
    })
    expect(fills[0]?.clientOrderId).toBe('client-open-1')
    const before = updates.length
    socket.emit({
      stream: 'trade_updates',
      data: { event: 'replaced', order: { id: 'ord-1', client_order_id: 'client-r1', symbol: 'AAPL', side: 'buy', status: 'replaced' } },
    })
    expect(updates).toHaveLength(before)
    expect(updates.every((u) => u.status !== 'replaced')).toBe(true)
  })
})

describe('私有流：calculated 按累计成交量判', () => {
  async function listen() {
    const socket = new TestSocket()
    const fake = new FakeAlpaca()
    const t = makeConnector(fake, { streamSocket: () => socket })
    await t.connector.start()
    const updates: Array<{ status: string }> = []
    t.connector.subscribe({ channel: 'orderUpdates', address: ADDRESS }, (e) => {
      if (e.channel === 'orderUpdates') updates.push(...e.updates)
    })
    const ready = t.connector.stream.connect()
    socket.open()
    socket.emit({ stream: 'authorization', data: { status: 'authorized' } })
    socket.emit({ stream: 'listening', data: { streams: ['trade_updates'] } })
    await ready
    const emitCalculated = (qty: string, filledQty: string): void => {
      socket.emit({
        stream: 'trade_updates',
        data: { event: 'fill', order: { id: 'ord-1', symbol: 'AAPL', side: 'buy', status: 'calculated', qty, filled_qty: filledQty } },
      })
    }
    return { updates, emitCalculated }
  }
  it('filled_qty < qty → 外发 expired', async () => {
    const { updates, emitCalculated } = await listen()
    emitCalculated('2', '1')
    expect(updates).toHaveLength(1)
    expect(updates[0]?.status).toBe('expired')
  })
  it('filled_qty = qty → 外发 filled', async () => {
    const { updates, emitCalculated } = await listen()
    emitCalculated('2', '2')
    expect(updates).toHaveLength(1)
    expect(updates[0]?.status).toBe('filled')
  })
})

describe('能力：定时全撤 / 杠杆（八条 #8）', () => {
  it('scheduleCancel → 5002（Alpaca 没有定时全撤）', async () => {
    const { trading } = await setup()
    await expect(trading.scheduleCancel(tradeContext(), NOW + 60_000)).rejects.toMatchObject({ problem: { code: 5002 } })
  })
  it('杠杆等于账户倍数（2x）→ 通过', async () => {
    const { connector } = await setup()
    await expect(connector.setLeverage(tradeContext(), 'alpaca:AAPL', 2, 'cross')).resolves.toBeUndefined()
  })
  it('杠杆不等于账户倍数 → 5002（账户级设定，改不了）', async () => {
    const { connector } = await setup()
    await expect(connector.setLeverage(tradeContext(), 'alpaca:AAPL', 3, 'cross')).rejects.toMatchObject({ problem: { code: 5002 } })
  })
  it('逐仓 → 5002（美股没有逐仓）', async () => {
    const { connector } = await setup()
    await expect(connector.setLeverage(tradeContext(), 'alpaca:AAPL', 2, 'isolated')).rejects.toMatchObject({ problem: { code: 5002 } })
  })
  it('杠杆非正整数 → INVALID_PARAMS', async () => {
    const { connector } = await setup()
    await expect(connector.setLeverage(tradeContext(), 'alpaca:AAPL', 0, 'cross')).rejects.toMatchObject({ problem: { code: -32602 } })
  })
})

describe('位置级保护单（OCO）', () => {
  it('POST order_class=oco，带 take_profit / stop_loss', async () => {
    const { fake, trading } = await setup()
    const result = await trading.placeProtection(tradeContext(), {
      symbol: 'AAPL', qty: '10', takeProfitPrice: '200', stopLossPrice: '180', clientOrderId: CID,
    })
    expect(result[0]?.ok).toBe(true)
    expect(result[0]?.venueOrderId).toBe('ord-1')
    const body = postBody(fake)
    expect(body['order_class']).toBe('oco')
    expect(body['side']).toBe('sell')
    expect(body['time_in_force']).toBe('gtc')
    expect(body['take_profit']).toEqual({ limit_price: '200' })
    expect(body['stop_loss']).toEqual({ stop_price: '180' })
    expect(body['limit_price']).toBeUndefined()
  })
  it('上游拒绝 → 逐条回报 ok:false + problem，不抛', async () => {
    const { fake, trading } = await setup()
    fake.fail('POST', '/v2/orders', { message: 'insufficient qty available for order' }, 403)
    const result = await trading.placeProtection(tradeContext(), { symbol: 'AAPL', qty: '10', takeProfitPrice: '200', stopLossPrice: '180' })
    expect(result[0]?.ok).toBe(false)
    expect(result[0]?.problem?.code).toBe(3004)
  })
  it('两条腿都没有 → 构造期抛 INVALID_PARAMS', async () => {
    const { trading } = await setup()
    await expect(trading.placeProtection(tradeContext(), { symbol: 'AAPL', qty: '10' })).rejects.toMatchObject({ problem: { code: -32602 } })
  })
  it('只给止损 → OCO 缺腿，构造期抛且不发请求', async () => {
    const { fake, trading } = await setup()
    const problem = await problemOf(() => trading.placeProtection(tradeContext(), { symbol: 'AAPL', qty: '10', stopLossPrice: '180' }))
    expect(problem.code).toBe(-32602)
    expect(problem.message).toContain('both legs')
    expect(fake.callsFor('POST', '/v2/orders')).toHaveLength(0)
  })
  it('数量非正 → 构造期抛 INVALID_PARAMS', async () => {
    const { trading } = await setup()
    await expect(trading.placeProtection(tradeContext(), { symbol: 'AAPL', qty: '0', takeProfitPrice: '200', stopLossPrice: '180' })).rejects.toMatchObject({ problem: { code: -32602 } })
  })
})

describe('账户引用与诊断', () => {
  it('accountRef 原样透传', () => {
    expect(accountRef.accountId).toBe(ACCOUNT)
  })
  it('session() 走注入时钟', async () => {
    const { trading } = await setup()
    expect(trading.session().phase).toBe('regular')
  })
  it('mapStatus 覆盖 Alpaca 原生状态', async () => {
    const { trading } = await setup()
    expect(trading.mapStatus('partially_filled')).toBe('partially_filled')
    expect(trading.mapStatus('canceled')).toBe('cancelled')
    expect(trading.mapStatus('held')).toBe('untriggered')
    expect(trading.mapStatus('accepted')).toBe('submitted')
    expect(trading.mapStatus('pending_new')).toBe('submitted')
    expect(trading.mapStatus('done_for_day')).toBe('expired')
  })
})
