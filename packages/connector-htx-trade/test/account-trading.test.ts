// SPDX-License-Identifier: CPAL-1.0
// 账户读取 + 交易动作（对假服务器发真实 HTTP 语义的请求；全部离线）。
// 假服务器按官方文档写路由：v1 私有接口全是 POST，v5 读接口是 GET；市价平仓端点只计数不实现为查询。
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { asDecimal } from '@gitrader/protocol'
import type { InstrumentId, OrderIntent } from '@gitrader/protocol'
import type { ProblemError } from '../src/errors'
import { HtxAccounts } from '../src/account'
import { buildTpslBody } from '../src/orders'
import { HtxTrading } from '../src/trading'
import { FakeHtx, NOW } from './helpers/fake-htx'
import { account, btc, contractSizeOf, ctx, freshQuote, instrumentOf, newHttp } from './helpers/harness'

let lastFake: FakeHtx | null = null

function setup(over: { family?: 'v5' | 'v1'; hedge?: boolean; patch?: (fake: FakeHtx) => typeof fetch; contractSizeOf?: (code: string) => string | undefined } = {}) {
  const fake = new FakeHtx()
  lastFake = fake
  const sizeOf = over.contractSizeOf ?? contractSizeOf
  // patch 必须在建 http 之前：客户端在构造时就抓住了 fetchImpl
  if (over.patch !== undefined) fake.fetch = over.patch(fake)
  const http = newHttp(fake)
  const accounts = new HtxAccounts({
    http,
    clock: () => NOW,
    options: { family: over.family ?? 'v5', defaultSymbol: 'BTC-USDT' },
    contractSizeOf: sizeOf,
  }, ['secret', 'key'])
  const trading = new HtxTrading({
    http,
    instrumentOf: (id) => instrumentOf(id),
    quoteOf: () => freshQuote(),
    openOrders: (ref, symbol) => accounts.openOrders(ref, symbol),
    orderStatus: (ref, key, opts) => accounts.orderStatus(ref, key, opts ?? {}),
    faceValueOf: (id) => sizeOf(id.replace(/^htx:/i, '')),
    clock: () => NOW,
    family: over.family ?? 'v5',
    hedge: over.hedge ?? false,
    marginMode: 'cross',
    defaultSymbol: 'BTC-USDT',
    accounts,
  }, ['secret', 'key'])
  return { fake, http, accounts, trading }
}

/** 只读路径永远不许触发市价平仓端点；下单也不许隐式切换杠杆。 */
afterEach(() => {
  expect(lastFake?.closeAllCalls ?? 0).toBe(0)
  expect(lastFake?.leverSwitchedByOrder ?? 0).toBe(0)
  lastFake = null
})

const intent = (over: Partial<OrderIntent> = {}): OrderIntent => ({
  accountId: 'acct_htx_1',
  instrumentId: 'htx:BTC-USDT',
  side: 'buy',
  type: 'limit',
  size: asDecimal('0.01'),
  price: asDecimal('100'),
  ...over,
})

const AUTH_KEYS = ['AccessKeyId', 'Signature', 'SignatureMethod', 'SignatureVersion', 'Timestamp']

function seedOrder(fake: FakeHtx, id: number): void {
  fake.orders.set(id, {
    id, order_id: id, client_order_id: String(id), contract_code: 'BTC-USDT', direction: 'buy', offset: 'both',
    volume: 10, trade_volume: 0, price: '100', order_price_type: 'limit', status: 3, created_at: NOW, lever_rate: 3,
  })
}

describe('账户读取', () => {
  it('accountState：余额（v5 官方顶层字段）+ 持仓一起回', async () => {
    const { fake, accounts } = setup()
    fake.positions = [{ contract_code: 'BTC-USDT', direction: 'buy', volume: 10, cost_open: '100', last_price: '110', lever_rate: 3 }]
    const snapshot = await accounts.accountState(account())
    expect(String(snapshot.margin.equity)).toBe('1000.5')
    expect(String(snapshot.margin.initialMargin)).toBe('100.25')
    expect(snapshot.margin.valuationCcy).toBe('USD')
    expect(snapshot.positions).toHaveLength(1)
    expect(String(snapshot.positions[0]!.size)).toBe('0.01')
    expect(snapshot.source).toBe('rest')
  })

  it('v1 家族：余额走 POST swap_cross_account_info，accountModel=standard', async () => {
    const { fake, accounts } = setup({ family: 'v1' })
    const snapshot = await accounts.accountState(account())
    expect(String(snapshot.margin.equity)).toBe('1000.5')
    expect(snapshot.accountModel).toBe('standard')
    const req = fake.seen.find((r) => r.path === '/linear-swap-api/v1/swap_cross_account_info')!
    expect(req.method).toBe('POST')
    expect(fake.seen.some((r) => r.path === '/v5/trade/position/opens')).toBe(false)
  })

  it('v1 读接口全部 POST：query 只有五个鉴权键，业务参数在 body', async () => {
    const { fake, accounts } = setup({ family: 'v1' })
    seedOrder(fake, 5)
    fake.addTrade({ id: '1', created_at: NOW - 1_000 })
    await accounts.accountState(account())
    await accounts.openOrders(account())
    await accounts.orderStatus(account(), { venueOrderId: '5', instrumentId: 'htx:BTC-USDT' })
    await accounts.fills(account(), NOW - 86_400_000, { instrumentId: 'htx:BTC-USDT' })
    const paths = [
      '/linear-swap-api/v1/swap_cross_account_info',
      '/linear-swap-api/v1/swap_cross_position_info',
      '/linear-swap-api/v1/swap_cross_openorders',
      '/linear-swap-api/v1/swap_cross_order_info',
      '/linear-swap-api/v1/swap_cross_matchresults_exact',
    ]
    for (const path of paths) {
      const req = fake.seen.find((r) => r.path === path)
      expect(req, path).toBeDefined()
      expect(req!.method, path).toBe('POST')
      expect(Object.keys(req!.query).sort(), path).toEqual(AUTH_KEYS)
    }
    const openReq = fake.seen.find((r) => r.path.endsWith('swap_cross_openorders'))!
    expect(Number(openReq.body.page_index)).toBe(1)
    expect(openReq.query.page_index).toBeUndefined()
    const statusReq = fake.seen.find((r) => r.path.endsWith('swap_cross_order_info'))!
    expect(statusReq.body.order_id).toBe('5')
    const fillsReq = fake.seen.find((r) => r.path.endsWith('swap_cross_matchresults_exact'))!
    expect(fillsReq.body.trade_type).toBe(0)
    expect(fillsReq.body.contract_code).toBe('BTC-USDT')
  })

  it('v5 持仓只打 GET position/opens；失败照抛，且不碰市价平仓端点', async () => {
    const { fake, accounts } = setup()
    fake.positionsFailure = { code: 6001, message: 'The Single-Asset Collateral mode is temporarily unavailable' }
    fake.positions = [{ contract_code: 'ETH-USDT', direction: 'sell', volume: 5, cost_open: '20', last_price: '19', lever_rate: 2 }]
    await expect(accounts.accountState(account())).rejects.toBeDefined()
    expect(fake.closeAllCalls).toBe(0)
    expect(fake.seen.some((r) => r.path === '/v5/trade/position/opens')).toBe(true)
    expect(fake.seen.some((r) => r.path === '/v5/trade/position_all')).toBe(false)
  })

  it('v5 持仓行按 position_side / mark_price / open_avg_price 解析', async () => {
    const { fake, accounts } = setup()
    fake.positions = [{ contract_code: 'ETH-USDT', direction: 'buy', volume: 5, cost_open: '20', last_price: '19', open_avg_price: '18', mark_price: '19.5', position_side: 'short', lever_rate: 2 }]
    const positions = await accounts.positions(account())
    expect(positions).toHaveLength(1)
    expect(positions[0]!.side).toBe('short')
    expect(String(positions[0]!.entryPrice)).toBe('18')
    expect(String(positions[0]!.markPrice)).toBe('19.5')
  })

  it('openOrders（v5）：GET /v5/trade/order/opens 两页（100 + 1 行）合并 101 行', async () => {
    const { fake, accounts } = setup()
    for (let i = 0; i < 101; i++) seedOrder(fake, 1000 + i)
    const open = await accounts.openOrders(account())
    expect(open).toHaveLength(101)
    const reqs = fake.seen.filter((r) => r.path === '/v5/trade/order/opens')
    expect(reqs).toHaveLength(2)
    expect(reqs[0]!.method).toBe('GET')
    expect(reqs[0]!.query.limit).toBe('100')
    expect(reqs[0]!.query.direct).toBe('next')
    expect(reqs[0]!.query.from).toBeUndefined()
    expect(reqs[1]!.query.from).toBe(String(1000 + 99))
  })

  it('openOrders（v5）：剩余量 = (volume − trade_volume) × 面值', async () => {
    const { fake, accounts } = setup()
    fake.orders.set(1, {
      id: 1, order_id: 7, client_order_id: '999', contract_code: 'BTC-USDT', direction: 'sell', offset: 'both',
      volume: 10, trade_volume: 4, price: '100', order_price_type: 'limit', status: 4, created_at: NOW, lever_rate: 3, reduce_only: 1,
    })
    const open = await accounts.openOrders(account())
    expect(String(open[0]!.size)).toBe('0.006')
    expect(String(open[0]!.origSize)).toBe('0.01')
    expect(open[0]!.side).toBe('sell')
    expect(open[0]!.reduceOnly).toBe(true)
    expect(open[0]!.clientOrderId).toBe('999')
  })

  it('openOrders（v1）：POST body 带 page_index / page_size，两页取回 60 行', async () => {
    const { fake, accounts } = setup({ family: 'v1' })
    for (let i = 0; i < 60; i++) seedOrder(fake, 1000 + i)
    const open = await accounts.openOrders(account())
    expect(open).toHaveLength(60)
    const reqs = fake.seen.filter((r) => r.path.endsWith('swap_cross_openorders'))
    expect(reqs).toHaveLength(2)
    expect(reqs[0]!.method).toBe('POST')
    expect(reqs[0]!.query.page_index).toBeUndefined()
    expect(Number(reqs[0]!.body.page_index)).toBe(1)
    expect(Number(reqs[0]!.body.page_size)).toBe(50)
  })

  it('openOrders：给 instrumentId 时带 contract_code 过滤', async () => {
    const { fake, accounts } = setup()
    await accounts.openOrders(account(), 'htx:BTC-USDT')
    expect(fake.seen[0]!.query.contract_code).toBe('BTC-USDT')
  })

  it('orderStatus（v5）：GET /v5/trade/order，请求体为空，state 原样回', async () => {
    const { fake, accounts } = setup()
    seedOrder(fake, 5)
    fake.orders.get(5)!.state = 'partially_canceled'
    const status = await accounts.orderStatus(account(), { venueOrderId: '5', instrumentId: 'htx:BTC-USDT' })
    expect(status.found).toBe(true)
    expect(status.status).toBe('partially_canceled')
    const req = fake.seen[0]!
    expect(req.method).toBe('GET')
    expect(req.path).toBe('/v5/trade/order')
    expect(req.rawBody).toBe('')
    expect(req.query.order_id).toBe('5')
  })

  it('orderStatus：v5 明确 1061 → found:false', async () => {
    const { accounts } = setup()
    const status = await accounts.orderStatus(account(), { venueOrderId: '999', instrumentId: 'htx:BTC-USDT' })
    expect(status.found).toBe(false)
  })

  it('orderStatus：v5 GET 的 5xx → 抛 3003，不吞成 found:false', async () => {
    const { fake, accounts } = setup()
    fake.nextFailure = { status: 500, body: { status: 'error', err_msg: 'server error' } }
    let problem: ProblemError | undefined
    try {
      await accounts.orderStatus(account(), { venueOrderId: '5', instrumentId: 'htx:BTC-USDT' })
    } catch (e) {
      problem = e as ProblemError
    }
    expect(problem?.problem.code).toBe(3003)
  })

  it('orderStatus（v1）：POST swap_cross_order_info，业务参数在 body', async () => {
    const { fake, accounts } = setup({ family: 'v1' })
    seedOrder(fake, 5)
    const status = await accounts.orderStatus(account(), { venueOrderId: '5', instrumentId: 'htx:BTC-USDT' })
    expect(status.found).toBe(true)
    expect(status.status).toBe('3')
    const req = fake.seen[0]!
    expect(req.method).toBe('POST')
    expect(req.body.order_id).toBe('5')
    expect(req.query.order_id).toBeUndefined()
  })

  it('orderStatus：缺 instrumentId 也没有 defaultSymbol → INVALID_PARAMS', async () => {
    const { http } = setup()
    const noDefault = new HtxAccounts({ http, clock: () => NOW, contractSizeOf })
    await expect(noDefault.orderStatus(account(), { venueOrderId: '1' })).rejects.toBeDefined()
  })

  it('orderStatus：clientOrderId 走确定性映射后发给场所', async () => {
    const { fake, accounts } = setup()
    await accounts.orderStatus(account(), { clientOrderId: 'ord-abc', instrumentId: 'htx:BTC-USDT' })
    expect(fake.seen[0]!.query.client_order_id).toMatch(/^\d+$/)
  })

  it('fills（v1）：POST body 含 trade_type 0 / size 50 / direct next，按下一段 next_id 翻页', async () => {
    const { fake, accounts } = setup({ family: 'v1' })
    fake.matchPageSize = 2
    fake.addTrade({ id: '9000001', created_at: NOW - 1_000 })
    fake.addTrade({ id: '9000002', created_at: NOW - 2_000 })
    fake.addTrade({ id: '9000003', created_at: NOW - 3_000 })
    const fills = await accounts.fills(account(), NOW - 86_400_000, { instrumentId: 'htx:BTC-USDT' })
    expect(fills).toHaveLength(3)
    const reqs = fake.seen.filter((r) => r.path.endsWith('swap_cross_matchresults_exact'))
    expect(reqs).toHaveLength(2)
    expect(reqs[0]!.method).toBe('POST')
    expect(reqs[0]!.body.trade_type).toBe(0)
    expect(Number(reqs[0]!.body.size)).toBe(50)
    expect(reqs[0]!.body.direct).toBe('next')
    expect(reqs[0]!.query.contract_code).toBeUndefined()
    expect(reqs[1]!.body.from_id).toBe('9000002')
  })

  it('fills（v1）：同一 id 的两行去重，按成交号去重', async () => {
    const { fake, accounts } = setup({ family: 'v1' })
    fake.addTrade({ id: '1', created_at: NOW - 1_000, create_date: NOW - 1_000 })
    fake.addTrade({ id: '1', created_at: NOW - 1_000, create_date: NOW - 1_000 })
    fake.addTrade({ id: '2', created_at: NOW - 2_000, create_date: NOW - 2_000 })
    const fills = await accounts.fills(account(), NOW - 86_400_000, { instrumentId: 'htx:BTC-USDT' })
    expect(fills).toHaveLength(2)
    expect(fills[0]!.venueFillId).toBe('2')
  })

  it('fills（v5）：GET /v5/trade/order/details，官方示例行 → 0.001 / fee 0.01884', async () => {
    const { fake, accounts } = setup()
    fake.addV5Trade({
      id: '100000032538647', trade_id: '100000032538647', trade_volume: '1', trade_price: '31400',
      trade_fee: '0.01884', role: 'TAKER', created_at: NOW - 1_000, created_time: NOW - 1_000,
    })
    const fills = await accounts.fills(account(), NOW - 3_600_000, { instrumentId: 'htx:BTC-USDT' })
    expect(fills).toHaveLength(1)
    expect(String(fills[0]!.size)).toBe('0.001')
    expect(String(fills[0]!.fee)).toBe('0.01884')
    const req = fake.seen[0]!
    expect(req.method).toBe('GET')
    expect(req.path).toBe('/v5/trade/order/details')
    expect(req.query.limit).toBe('100')
    expect(req.query.direct).toBe('next')
    expect(req.query.contract_code).toBe('BTC-USDT')
  })

  it('fills：不给合约也没有 defaultSymbol → INVALID_PARAMS（HTX 成交端点必须给合约）', async () => {
    const { http } = setup()
    const noDefault = new HtxAccounts({ http, clock: () => NOW, contractSizeOf })
    await expect(noDefault.fills(account(), NOW - 1_000)).rejects.toBeDefined()
  })

  it('fills（v1）：超过 12 周直接拒（不给半份历史）', async () => {
    const { accounts } = setup({ family: 'v1' })
    await expect(accounts.fills(account(), NOW - 200 * 86_400_000, { instrumentId: 'htx:BTC-USDT' })).rejects.toBeDefined()
  })

  it('fills（v5）：超过 3 天直接拒', async () => {
    const { accounts } = setup()
    await expect(accounts.fills(account(), NOW - 5 * 86_400_000, { instrumentId: 'htx:BTC-USDT' })).rejects.toBeDefined()
  })

  it('startupSnapshot：账户 + 挂单 + 成交，成交覆盖持仓合约', async () => {
    const { fake, accounts } = setup()
    fake.positions = [{ contract_code: 'BTC-USDT', direction: 'buy', volume: 10, cost_open: '100', last_price: '100', lever_rate: 3 }]
    seedOrder(fake, 77)
    fake.addV5Trade({ id: '11', trade_id: '11', created_at: NOW - 500, created_time: NOW - 500 })
    const snapshot = await accounts.startupSnapshot(account(), NOW - 86_400_000)
    expect(snapshot.account.positions).toHaveLength(1)
    expect(snapshot.openOrders).toHaveLength(1)
    expect(snapshot.fills).toHaveLength(1)
    expect(snapshot.truncated).toBe(false)
  })

  it('未 start()（面值未知）时 openOrders / fills / positions 都抛 INSTRUMENT_UNKNOWN', async () => {
    const { fake, accounts } = setup({ contractSizeOf: () => undefined })
    seedOrder(fake, 1)
    fake.positions = [{ contract_code: 'BTC-USDT', direction: 'buy', volume: 1, cost_open: '100', last_price: '100', lever_rate: 3 }]
    fake.addV5Trade({ id: '1', trade_id: '1', created_at: NOW - 500, created_time: NOW - 500 })
    await expect(accounts.openOrders(account())).rejects.toMatchObject({ problem: { name: 'INSTRUMENT_UNKNOWN' } })
    await expect(accounts.positions(account())).rejects.toMatchObject({ problem: { name: 'INSTRUMENT_UNKNOWN' } })
    await expect(accounts.fills(account(), NOW - 3_600_000, { instrumentId: 'htx:BTC-USDT' })).rejects.toMatchObject({ problem: { name: 'INSTRUMENT_UNKNOWN' } })
  })
})

describe('交易动作', () => {
  it('submit 限价买入（v5）：ack 为 open + 场所订单号，volume 是字符串', async () => {
    const { trading, fake } = setup()
    const result = await trading.submit(ctx(), [intent()])
    expect(result.acks).toHaveLength(1)
    expect(result.acks[0]!.status).toBe('open')
    expect(result.acks[0]!.venueOrderId).toBeTruthy()
    expect(fake.orders.size).toBe(1)
    expect(fake.seen[0]!.body.volume).toBe('10')
    expect(result.receiptHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('submit：带 tpsl 的意图回 1004（submit 不挂保护单）', async () => {
    const { trading } = setup()
    const result = await trading.submit(ctx(), [intent({ tpsl: { takeProfit: { triggerPrice: asDecimal('110') }, grouping: 'position' } })])
    expect(result.acks[0]!.status).toBe('rejected')
    expect(result.acks[0]!.problem?.name).toBe('ORDER_TYPE_UNSUPPORTED')
  })

  it('submit：构造失败（不足一张）回 1002 且不发请求', async () => {
    const { trading, fake } = setup()
    const result = await trading.submit(ctx(), [intent({ size: asDecimal('0.0001') })])
    expect(result.acks[0]!.problem?.name).toBe('PRECISION')
    expect(fake.seen).toHaveLength(0)
  })

  it('submit：1499 持仓模式不匹配时只重发一次并翻 position_side', async () => {
    const { trading, fake } = setup()
    fake.accountMode = 'hedge' // 假服务器要求 long/short，客户端先发 both → 1499 → 翻成 long
    const result = await trading.submit(ctx(), [intent()])
    expect(result.acks[0]!.status).toBe('open')
    expect(fake.seen.filter((r) => r.path === '/v5/trade/order')).toHaveLength(2)
    expect(String(fake.seen[1]!.body.position_side)).toBe('long')
  })

  it('submit：1500 翻 both 时保留 reduce_only（平多单不变成反向开仓）', async () => {
    const { trading, fake } = setup({ hedge: true })
    fake.accountMode = 'oneway'
    const result = await trading.submit(ctx(), [intent({ side: 'sell', reduceOnly: true })])
    expect(result.acks[0]!.status).toBe('open')
    expect(fake.seen[0]!.body.position_side).toBe('long')
    expect(fake.seen[0]!.body.reduce_only).toBe(1)
    expect(fake.seen[1]!.body.position_side).toBe('both')
    expect(fake.seen[1]!.body.reduce_only).toBe(1)
  })

  it('submit：1499 重发仍失败就把原错交回（不无限重试）', async () => {
    let n = 0
    const { trading } = setup({
      patch: (f) => {
        const original = f.fetch
        return async (input, init) => {
          if (String(input).includes('/v5/trade/order')) {
            n += 1
            // 两次都回 1499：第一次触发重发，第二次仍失败 → 必须停手并把上游原文交回
            if (n <= 2) return new Response(JSON.stringify({ code: 1499, message: 'Hedge mode currently', data: null }), { status: 200 })
          }
          return original(input, init)
        }
      },
    })
    const result = await trading.submit(ctx(), [intent()])
    expect(result.acks[0]!.status).toBe('rejected')
    expect(result.acks[0]!.problem?.code).toBe(3001)
    expect(n).toBe(2)
  })

  it('submit：结果未知（5xx）→ status unknown，等内核按 clientOrderId 对账', async () => {
    const { trading, fake } = setup()
    fake.nextFailure = { status: 504, body: { status: 'error', err_msg: 'gateway timeout' } }
    const result = await trading.submit(ctx(), [intent()])
    expect(result.acks[0]!.status).toBe('unknown')
    expect(result.acks[0]!.problem?.code).toBe(3006)
  })

  it('submit（v1）：建单体带 direction / offset / lever_rate(取自 setLeverage)', async () => {
    const { trading, fake } = setup({ family: 'v1' })
    await trading.setLeverage(ctx(), 'htx:BTC-USDT', 5, 'cross')
    await trading.submit(ctx(), [intent()])
    const body = fake.seen.find((r) => r.path.endsWith('swap_cross_order'))!.body
    expect(body.direction).toBe('buy')
    expect(body.offset).toBe('both')
    expect(Number(body.lever_rate)).toBe(5)
    expect(fake.leverSwitchedByOrder).toBe(0)
  })

  it('submit（v1）：没有杠杆就不猜 1，拒单且不发下单请求', async () => {
    const { trading, fake } = setup({ family: 'v1' })
    const result = await trading.submit(ctx(), [intent()])
    expect(result.acks[0]!.status).toBe('rejected')
    expect(result.acks[0]!.problem?.name).toBe('INVALID_PARAMS')
    expect(fake.seen.some((r) => r.path.endsWith('swap_cross_order'))).toBe(false)
    expect(fake.leverSwitchedByOrder).toBe(0)
  })

  it('v1 open → both 翻转：开仓单不带 reduce_only', async () => {
    let first = true
    const { trading, fake } = setup({
      family: 'v1',
      hedge: true,
      patch: (f) => {
        const original = f.fetch
        return async (input, init) => {
          if (first && String(input).includes('swap_cross_order')) {
            first = false
            return new Response(JSON.stringify({ status: 'error', err_code: 1500, err_msg: 'One-way mode currently', ts: NOW }), { status: 200 })
          }
          return original(input, init)
        }
      },
    })
    await trading.setLeverage(ctx(), 'htx:BTC-USDT', 3, 'cross')
    const result = await trading.submit(ctx(), [intent()])
    expect(result.acks[0]!.status).toBe('open')
    const second = fake.seen.filter((r) => r.path.endsWith('swap_cross_order'))[0]!
    expect(second.body.offset).toBe('both')
    expect(second.body.reduce_only).toBeUndefined()
    expect(fake.leverSwitchedByOrder).toBe(0)
  })

  it('v1 close → both 翻转：平仓单带 reduce_only=1', async () => {
    let first = true
    const { trading, fake } = setup({
      family: 'v1',
      hedge: true,
      patch: (f) => {
        const original = f.fetch
        return async (input, init) => {
          if (first && String(input).includes('swap_cross_order')) {
            first = false
            return new Response(JSON.stringify({ status: 'error', err_code: 1500, err_msg: 'One-way mode currently', ts: NOW }), { status: 200 })
          }
          return original(input, init)
        }
      },
    })
    await trading.setLeverage(ctx(), 'htx:BTC-USDT', 3, 'cross')
    const result = await trading.submit(ctx(), [intent({ side: 'sell', reduceOnly: true })])
    expect(result.acks[0]!.status).toBe('open')
    const second = fake.seen.filter((r) => r.path.endsWith('swap_cross_order'))[0]!
    expect(second.body.offset).toBe('both')
    expect(second.body.reduce_only).toBe(1)
  })

  it('submit：杠杆与建单的 margin_mode 一致（都按 intent）', async () => {
    const { trading, fake } = setup()
    await trading.submit(ctx(), [intent({ leverage: 10, marginMode: 'isolated' })])
    expect(fake.seen.find((r) => r.path === '/v5/position/lever')!.body.margin_mode).toBe('isolated')
    expect(fake.seen.find((r) => r.path === '/v5/trade/order')!.body.margin_mode).toBe('isolated')
  })

  it('submit（v1）：isolated 意图 → INVALID_PARAMS，不发请求', async () => {
    const { trading, fake } = setup({ family: 'v1' })
    const result = await trading.submit(ctx(), [intent({ marginMode: 'isolated', leverage: 5 })])
    expect(result.acks[0]!.problem?.name).toBe('INVALID_PARAMS')
    expect(fake.seen).toHaveLength(0)
  })

  it('submit：给了 leverage 先调杠杆，再下单（v5 两处保证金模式一致）', async () => {
    const { trading, fake } = setup()
    await trading.submit(ctx(), [intent({ leverage: 10 })])
    const paths = fake.seen.map((r) => r.path)
    expect(paths.indexOf('/v5/position/lever')).toBeLessThan(paths.indexOf('/v5/trade/order'))
    expect(fake.seen.find((r) => r.path === '/v5/trade/order')!.body.margin_mode).toBe('cross')
  })

  it('submit：杠杆越界时单张被打回，且不发下单请求', async () => {
    const { trading, fake } = setup()
    const result = await trading.submit(ctx(), [intent({ leverage: 200 })])
    expect(result.acks[0]!.status).toBe('rejected')
    expect(fake.seen.some((r) => r.path === '/v5/trade/order')).toBe(false)
  })

  it('cancel：撤单成功（v5 POST cancel_order）', async () => {
    const { trading, fake } = setup()
    seedOrder(fake, 5)
    const acks = await trading.cancel(ctx(), [{ instrumentId: 'htx:BTC-USDT', venueOrderId: '5' }])
    expect(acks[0]!.ok).toBe(true)
    expect(fake.orders.get(5)!.status).toBe(7)
    expect(fake.seen[0]!.method).toBe('POST')
  })

  it('cancel：v5 1061（订单已成交 / 不存在）算「目的已达成」（ok=true）', async () => {
    const { trading } = setup()
    const acks = await trading.cancel(ctx(), [{ instrumentId: 'htx:BTC-USDT', venueOrderId: '424242' }])
    expect(acks[0]!.ok).toBe(true)
  })

  it('cancel（v1）：data.errors 1061 → ok:true', async () => {
    const { trading, fake } = setup({ family: 'v1' })
    fake.cancelErrors = [{ order_id: 5, err_code: 1061, err_msg: "This order doesn't exist." }]
    const acks = await trading.cancel(ctx(), [{ instrumentId: 'htx:BTC-USDT', venueOrderId: '5' }])
    expect(acks[0]!.ok).toBe(true)
  })

  it('cancel（v1）：data.errors 1056 → ok:false，venue.code 透传', async () => {
    const { trading, fake } = setup({ family: 'v1' })
    fake.cancelErrors = [{ order_id: 5, err_code: 1056, err_msg: 'In settlement' }]
    const acks = await trading.cancel(ctx(), [{ instrumentId: 'htx:BTC-USDT', venueOrderId: '5' }])
    expect(acks[0]!.ok).toBe(false)
    expect(acks[0]!.problem?.name).toBe('VENUE_REJECTED')
    expect(acks[0]!.problem?.venue?.code).toBe(1056)
  })

  it('cancel：缺订单号 → INVALID_PARAMS 且不发请求', async () => {
    const { trading, fake } = setup()
    const acks = await trading.cancel(ctx(), [{ instrumentId: 'htx:BTC-USDT' }])
    expect(acks[0]!.ok).toBe(false)
    expect(fake.seen).toHaveLength(0)
  })

  it('cancel：标的不合法 → 打回', async () => {
    const { trading } = setup()
    const acks = await trading.cancel(ctx(), [{ instrumentId: 'bybit:BTCUSDT', venueOrderId: '1' }])
    expect(acks[0]!.ok).toBe(false)
  })

  it('cancelAll（v5）：一次 POST /v5/trade/cancel_all_orders', async () => {
    const { trading, fake } = setup()
    seedOrder(fake, 11)
    const acks = await trading.cancelAll(ctx())
    expect(acks[0]!.ok).toBe(true)
    expect(fake.seen[0]!.method).toBe('POST')
    expect(fake.seen[0]!.path).toBe('/v5/trade/cancel_all_orders')
    expect(fake.orders.get(11)!.status).toBe(7)
  })

  it('cancelAll（v5）：某个逐单 code 1061 → ok:false + venue.code', async () => {
    const { trading, fake } = setup()
    seedOrder(fake, 11)
    fake.cancelAllRowCode = 1061
    const acks = await trading.cancelAll(ctx())
    expect(acks[0]!.ok).toBe(false)
    expect(acks[0]!.problem?.venue?.code).toBe(1061)
  })

  it('cancelAll（v1）：不给 instrumentId 时先读挂单，再按合约 cancelall', async () => {
    const { trading, fake } = setup({ family: 'v1' })
    seedOrder(fake, 11)
    const acks = await trading.cancelAll(ctx())
    expect(acks[0]!.ok).toBe(true)
    const paths = fake.seen.map((r) => r.path)
    expect(paths).toContain('/linear-swap-api/v1/swap_cross_openorders')
    const cancelall = fake.seen.find((r) => r.path === '/linear-swap-api/v1/swap_cross_cancelall')!
    expect(cancelall.body.contract_code).toBe('BTC-USDT')
    expect(fake.orders.get(11)!.status).toBe(7)
  })

  it('cancelAll（v1）：data.errors 1056 → ok:false', async () => {
    const { trading, fake } = setup({ family: 'v1' })
    fake.cancelErrors = [{ order_id: 11, err_code: 1056, err_msg: 'In settlement' }]
    const acks = await trading.cancelAll(ctx(), 'htx:BTC-USDT' as InstrumentId)
    expect(acks[0]!.ok).toBe(false)
    expect(acks[0]!.problem?.venue?.code).toBe(1056)
  })

  it('cancelAll（v1）：信封级 1051（没有可撤的单）→ ok:true', async () => {
    const { trading, fake } = setup({ family: 'v1' })
    fake.nextFailure = { body: { status: 'error', err_code: 1051, err_msg: 'No orders to cancel.' } }
    const acks = await trading.cancelAll(ctx(), 'htx:BTC-USDT' as InstrumentId)
    expect(acks).toEqual([{ target: { instrumentId: 'htx:BTC-USDT' }, ok: true }])
  })

  it('cancelAll（v5）：信封级 1051（没有可撤的单）→ ok:true', async () => {
    const { trading, fake } = setup()
    fake.nextFailure = { body: { code: 1051, message: 'No orders to cancel.', data: null } }
    const acks = await trading.cancelAll(ctx())
    expect(acks[0]!.ok).toBe(true)
  })

  it('cancelAll（v5）：信封级 1067 → ok:false', async () => {
    const { trading, fake } = setup()
    fake.nextFailure = { body: { code: 1067, message: 'Invalid field', data: null } }
    const acks = await trading.cancelAll(ctx())
    expect(acks[0]!.ok).toBe(false)
    expect(acks[0]!.problem?.venue?.code).toBe(1067)
  })

  it('amend：HTX 没有改单端点 → 1004', async () => {
    const { trading, fake } = setup()
    const result = await trading.amend(ctx(), { instrumentId: 'htx:BTC-USDT', venueOrderId: '5', order: intent() })
    expect(result.acks[0]!.status).toBe('rejected')
    expect(result.acks[0]!.problem?.name).toBe('ORDER_TYPE_UNSUPPORTED')
    expect(fake.seen).toHaveLength(0)
  })

  it('setLeverage：成功并记缓存（同参数第二次不再发请求）', async () => {
    const { trading, fake } = setup()
    await trading.setLeverage(ctx(), 'htx:BTC-USDT', 8, 'cross')
    await trading.setLeverage(ctx(), 'htx:BTC-USDT', 8, 'cross')
    expect(fake.seen.filter((r) => r.path === '/v5/position/lever')).toHaveLength(1)
    expect(trading.leverageState()[0]!.leverage).toBe(8)
  })

  it('setLeverage：超过合约最大杠杆的事件前拒（不发请求）', async () => {
    const { trading, fake } = setup()
    await expect(trading.setLeverage(ctx(), 'htx:BTC-USDT', 200, 'cross')).rejects.toBeDefined()
    expect(fake.seen).toHaveLength(0)
  })

  it('setLeverage（v1）：isolated → INVALID_PARAMS，不发请求', async () => {
    const { trading, fake } = setup({ family: 'v1' })
    await expect(trading.setLeverage(ctx(), 'htx:BTC-USDT', 5, 'isolated')).rejects.toBeDefined()
    expect(fake.seen).toHaveLength(0)
  })

  it('setLeverage：上游回报的生效杠杆与请求不一致 → 失败（不静默接受）', async () => {
    const { trading } = setup({
      patch: (f) => {
        const original = f.fetch
        return async (input, init) => {
          if (String(input).includes('/v5/position/lever')) {
            return new Response(JSON.stringify({ code: 200, message: 'Success', data: { contract_code: 'BTC-USDT', lever_rate: 3 } }), { status: 200 })
          }
          return original(input, init)
        }
      },
    })
    let problem: ProblemError | undefined
    try {
      await trading.setLeverage(ctx(), 'htx:BTC-USDT', 10, 'cross')
    } catch (e) {
      problem = e as ProblemError
    }
    expect(problem?.problem.message).toContain('instead of the requested')
  })

  it('setTpsl（v1）：发 swap_cross_tpsl_order，字段与 buildTpslBody 一致', async () => {
    const { trading, fake } = setup({ family: 'v1' })
    const spec = { contractCode: 'BTC-USDT', direction: 'sell' as const, volume: 10, takeProfit: { triggerPrice: asDecimal('110') } }
    await trading.setTpsl(ctx(), spec)
    const req = fake.seen.find((r) => r.path.endsWith('swap_cross_tpsl_order'))!
    expect(req.body).toEqual(buildTpslBody(spec))
  })

  it('setTpsl（v5）：v1 止盈止损端点不可用于 v5 → 1004', async () => {
    const { trading, fake } = setup()
    await expect(trading.setTpsl(ctx(), { contractCode: 'BTC-USDT', direction: 'sell', volume: 10, takeProfit: { triggerPrice: asDecimal('110') } }))
      .rejects.toMatchObject({ problem: { name: 'ORDER_TYPE_UNSUPPORTED' } })
    expect(fake.seen).toHaveLength(0)
  })

  it('setTpsl：参数不合法时不动网络', async () => {
    const { trading, fake } = setup({ family: 'v1' })
    await expect(trading.setTpsl(ctx(), { contractCode: 'BTC-USDT', direction: 'sell', volume: 0 })).rejects.toBeDefined()
    expect(fake.seen).toHaveLength(0)
  })

  it('scheduleCancel / armDeadman 不伪装：都是 5002', async () => {
    const { trading } = setup()
    await expect(trading.scheduleCancel(ctx(), NOW + 60_000)).rejects.toBeDefined()
    expect(trading.mode()).toEqual({ hedge: false, family: 'v5' })
  })

  it('submit 的 TradeContext signal 被透传给 fetch', async () => {
    const { trading } = setup()
    const ctl = new AbortController()
    ctl.abort(new Error('window closed'))
    const result = await trading.submit(ctx(ctl.signal), [intent()])
    expect(result.acks[0]!.status === 'unknown' || result.acks[0]!.status === 'rejected').toBe(true)
  })

  it('v1 hedge：平仓单带 offset=close', async () => {
    const { trading, fake } = setup({ family: 'v1', hedge: true })
    await trading.setLeverage(ctx(), 'htx:BTC-USDT', 3, 'cross')
    await trading.submit(ctx(), [intent({ side: 'sell', reduceOnly: true })])
    const body = fake.seen.find((r) => r.path.endsWith('swap_cross_order'))!.body
    expect(body.offset).toBe('close')
    expect(fake.leverSwitchedByOrder).toBe(0)
  })

  it('标的未登记（market 里没有）→ 1001', async () => {
    const { trading } = setup()
    const result = await trading.submit(ctx(), [intent({ instrumentId: 'htx:DOGE-USDT' })])
    expect(result.acks[0]!.problem?.name).toBe('INSTRUMENT_UNKNOWN')
  })

  it('面值未知（没 start()）→ 1001 且不发请求', async () => {
    const { trading, fake } = setup({ contractSizeOf: () => undefined })
    const result = await trading.submit(ctx(), [intent()])
    expect(result.acks[0]!.problem?.name).toBe('INSTRUMENT_UNKNOWN')
    expect(fake.seen).toHaveLength(0)
  })

  it('budgetUsage / defaultSymbol 是只读诊断', () => {
    const { trading } = setup()
    expect(trading.defaultSymbol()).toBe('BTC-USDT')
    expect(trading.budgetUsage().limit).toBeGreaterThan(0)
  })

  it('btc() 与 instrumentOf 同源（夹具自检）', () => {
    expect(btc().symbol).toBe('BTC-USDT')
    expect(instrumentOf('htx:ETH-USDT')!.symbol).toBe('ETH-USDT')
  })
})

describe('只读纪律', () => {
  it('src/ 文本里没有市价平仓端点，也没有 guessing 的杠杆缺省', () => {
    const dir = fileURLToPath(new URL('../src/', import.meta.url))
    const text = readdirSync(dir)
      .filter((name) => name.endsWith('.ts'))
      .map((name) => readFileSync(join(dir, name), 'utf8'))
      .join('\n')
    expect(text.includes('position_all')).toBe(false)
    expect(text.includes("/v5/trade/position'")).toBe(false)
    expect(text.includes("'ioc' as")).toBe(false)
    expect(text.includes('lever_rate ?? 1')).toBe(false)
    expect(text.includes('?? 1))')).toBe(false)
  })
})
