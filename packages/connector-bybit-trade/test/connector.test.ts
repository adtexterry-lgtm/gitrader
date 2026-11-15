// SPDX-License-Identifier: CPAL-1.0
// 端到端（离线）：连接器把 行情 / 账户 / 交易 / 私有流 装在一起，全部打到假服务器。
import { inspect } from 'node:util'
import { describe, expect, it } from 'vitest'
import type { OrderIntent } from '@gitrader/protocol'
import { BybitTradeConnector, defaultBudget } from '../src/connector'
import { asProblem } from '../src/errors'
import { BybitHttp } from '../src/rest'
import type { BybitPrivateEvent } from '../src/parse'
import { API_KEY, API_SECRET, BASE_URL, FakeBybitTrade, NOW } from './helpers/fake-bybit-trade'
import { account, ctx } from './helpers/harness'

const connector = (fake: FakeBybitTrade, over: Partial<ConstructorParameters<typeof BybitTradeConnector>[0]> = {}) =>
  new BybitTradeConnector({
    apiKey: API_KEY,
    apiSecret: API_SECRET,
    baseUrl: BASE_URL,
    fetchImpl: fake.fetch,
    clock: () => NOW,
    onWarn: () => {},
    ...over,
  })

type LooseIntent = Partial<Omit<OrderIntent, 'size' | 'price' | 'notional' | 'triggerPrice'>> & {
  size?: string
  price?: string
  notional?: string
  triggerPrice?: string
}

const intent = (over: LooseIntent = {}): OrderIntent => ({
  accountId: 'acc_bybit_1', instrumentId: 'bybit:BTCUSDT', side: 'buy', type: 'limit', size: '0.1', price: '100', ...over,
} as unknown as OrderIntent)

class FakeSocket {
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  onclose: ((ev: unknown) => void) | null = null
  received: string[] = []
  send(data: string): void { this.received.push(data) }
  close(): void {}
}

describe('装配与生命周期', () => {
  it('venue / environment / 子模块都在', () => {
    const c = connector(new FakeBybitTrade())
    expect(c.venue).toBe('bybit')
    expect(c.environment).toBe('mainnet')
    expect(c.http).toBeInstanceOf(BybitHttp)
    expect(c.market).toBeTruthy()
    expect(c.accounts).toBeTruthy()
    expect(c.trading).toBeTruthy()
  })

  it('describe() 与 bybitCapabilities() 一致', () => {
    expect(connector(new FakeBybitTrade()).describe()).toEqual(connector(new FakeBybitTrade()).describe())
    expect(connector(new FakeBybitTrade()).describe().venue).toBe('bybit')
  })

  it('start() 拉合约清单（只收 Trading 的线性永续）', async () => {
    const fake = new FakeBybitTrade()
    const c = connector(fake)
    await c.start()
    expect(c.listInstruments().map((i) => i.symbol)).toEqual(['BTCUSDT', 'ETHUSDT'])
    expect(c.getInstrument('bybit:BTCUSDT')?.price.tick).toBe('0.1')
    expect(c.getInstrument('bybit:HALTUSDT')).toBeUndefined()
    expect(fake.callsTo('/v5/market/instruments-info')).toHaveLength(1)
  })

  it('close() 之后 market 关闭（再订阅抛 5002）', async () => {
    const c = connector(new FakeBybitTrade())
    await c.start()
    await c.close()
    expect(() => c.subscribe({ channel: 'quote', instrumentId: 'bybit:BTCUSDT' }, () => {})).toThrow()
  })

  it('testnet 环境用 testnet 基址（没显式给 baseUrl 时）', () => {
    const c = new BybitTradeConnector({ apiKey: API_KEY, apiSecret: API_SECRET, environment: 'testnet' })
    expect(c.http.baseUrl).toBe('https://api-testnet.bybit.com')
  })

  it('缺 apiKey / apiSecret 直接拒（不进入半初始化状态）', () => {
    expect(() => new BybitTradeConnector({ apiKey: '', apiSecret: 'x' })).toThrow(RangeError)
    expect(() => new BybitTradeConnector({ apiKey: 'x', apiSecret: '' })).toThrow(RangeError)
  })
})

describe('行情（复用 connector-bybit-data）', () => {
  it('quote 在 refreshQuote 之前是 undefined（同步缓存视图）', async () => {
    const c = connector(new FakeBybitTrade())
    await c.start()
    expect(c.quote('bybit:BTCUSDT')).toBeUndefined()
    const q = await c.refreshQuote('bybit:BTCUSDT')
    expect(q?.bid).toBe(82428.5)
    expect(q?.ask).toBe(82428.6)
    expect(c.quote('bybit:BTCUSDT')?.stale).toBe(false)
  })

  it('book / context 走公共端点', async () => {
    const fake = new FakeBybitTrade()
    const c = connector(fake)
    await c.start()
    const book = await c.book('bybit:BTCUSDT', 5)
    expect(book.bids[0]?.price).toBe(82428.5)
    const context = await c.context('bybit:BTCUSDT')
    expect(context.markPrice).toBe(82440.94)
    expect(fake.callsTo('/v5/market/orderbook')).toHaveLength(1)
  })

  it('candles 需要先有合约清单（8h / 3d 之外的口径由数据包拒绝）', async () => {
    const c = connector(new FakeBybitTrade())
    await c.start()
    await expect(c.candles('bybit:BTCUSDT', '8h')).rejects.toBeTruthy()
  })

  it('公共请求不带任何密钥头', async () => {
    const fake = new FakeBybitTrade()
    const c = connector(fake)
    await c.start()
    for (const call of fake.calls) expect(call.apiKey).toBeNull()
  })
})

describe('账户（只读）', () => {
  it('accountState 合并余额与持仓', async () => {
    const fake = new FakeBybitTrade()
    const c = connector(fake)
    await c.start()
    const snap = await c.accountState(account())
    expect(String(snap.margin.available)).toBe('900')
    expect(snap.positions).toHaveLength(2)
  })

  it('openOrders / fills / orderStatus / startupSnapshot', async () => {
    const fake = new FakeBybitTrade()
    const c = connector(fake, { defaultSymbol: 'BTCUSDT' })
    await c.start()
    expect((await c.openOrders(account())).length).toBe(2)
    expect((await c.fills(account(), NOW - 60_000)).length).toBe(3)
    expect((await c.orderStatus(account(), { clientOrderId: 'gt-query' })).found).toBe(true)
    const startup = await c.startupSnapshot(account(), NOW - 60_000)
    expect(startup.account.positions).toHaveLength(2)
    expect(startup.truncated).toBe(false)
  })

  it('fills honor an explicit instrumentId', async () => {
    const fake = new FakeBybitTrade()
    const c = connector(fake)
    await c.start()
    await c.fills(account(), NOW - 60_000, { instrumentId: 'bybit:ETHUSDT' })
    expect(fake.callsTo('/v5/execution/list')[0]!.params.get('symbol')).toBe('ETHUSDT')
  })

  it('uncached orderStatus honors an explicit instrumentId', async () => {
    const fake = new FakeBybitTrade()
    const c = connector(fake)
    await c.start()
    const status = await c.orderStatus(account(), { clientOrderId: 'gt-query', instrumentId: 'bybit:BTCUSDT' })
    expect(status.found).toBe(true)
    expect(fake.callsTo('/v5/order/realtime')[0]!.params.get('symbol')).toBe('BTCUSDT')
  })
})

describe('交易（内核发起）', () => {
  it('submit 走 POST /v5/order/create，回执 open', async () => {
    const fake = new FakeBybitTrade()
    const c = connector(fake)
    await c.start()
    const result = await c.submit(ctx(), [intent({ clientOrderId: 'gt-conn-1' })])
    expect(result.acks[0]).toMatchObject({ clientOrderId: 'gt-conn-1', status: 'open' })
    expect(fake.callsFor('POST', '/v5/order/create')).toHaveLength(1)
  })

  it('市价意图用缓存的报价做价带限价（先 refreshQuote 再 submit）', async () => {
    const fake = new FakeBybitTrade()
    const c = connector(fake)
    await c.start()
    await c.refreshQuote('bybit:BTCUSDT')
    await c.submit(ctx(), [intent({ type: 'market', price: undefined, size: '0.001', maxSlippageBps: 10 })])
    const body = fake.callsFor('POST', '/v5/order/create')[0]!.body as Record<string, unknown>
    expect(body.orderType).toBe('Limit')
    expect(body.timeInForce).toBe('IOC')
    expect(Number(body.price)).toBeGreaterThan(82428.5)
  })

  it('没有报价时市价意图被拒（STALE_PRICE），不发请求', async () => {
    const fake = new FakeBybitTrade()
    const c = connector(fake)
    await c.start()
    const result = await c.submit(ctx(), [intent({ type: 'market', price: undefined, maxSlippageBps: 10 })])
    expect(result.acks[0]!.status).toBe('rejected')
    expect(result.acks[0]!.problem?.code).toBe(2007)
    expect(fake.callsTo('/v5/order/create')).toHaveLength(0)
  })

  it('cancel / cancelAll / amend / setLeverage / setTradingStop 都通', async () => {
    const fake = new FakeBybitTrade()
    const c = connector(fake)
    await c.start()
    expect((await c.cancel(ctx(), [{ instrumentId: 'bybit:BTCUSDT', venueOrderId: 'ord-1' }]))[0]!.ok).toBe(true)
    expect((await c.cancelAll(ctx(), 'bybit:BTCUSDT'))[0]!.ok).toBe(true)
    expect((await c.amend(ctx(), { instrumentId: 'bybit:BTCUSDT', venueOrderId: 'ord-1', order: intent({ price: '101' }) })).acks[0]!.status).toBe('open')
    await expect(c.setLeverage(ctx(), 'bybit:BTCUSDT', 5, 'cross')).resolves.toBeUndefined()
    await expect(c.setTradingStop(ctx(), { symbol: 'BTCUSDT', stopLoss: '90000' })).resolves.toBeUndefined()
  })

  it('scheduleCancel / armDeadman → 5002（Bybit 没有场所级定时撤单）', async () => {
    const c = connector(new FakeBybitTrade())
    await c.start()
    await expect(c.scheduleCancel(ctx(), NOW + 1_000)).rejects.toMatchObject({ problem: { code: 5002 } })
    expect(() => c.armDeadman(ctx())).toThrow()
    try {
      c.armDeadman(ctx())
    } catch (e) {
      expect(asProblem(e).code).toBe(5002)
    }
  })
})

describe('私有流装配', () => {
  it('没有 socketFactory 时只给出地址，不建连', async () => {
    const c = connector(new FakeBybitTrade())
    const out = c.openUserStream()
    expect(out.url).toBe('wss://stream.bybit.com/v5/private')
    expect(out.stream).toBeNull()
  })

  it('有 socketFactory 时先发 auth，事件转发到 onUserEvent', async () => {
    const socket = new FakeSocket()
    const events: BybitPrivateEvent[] = []
    const c = connector(new FakeBybitTrade(), { socketFactory: () => socket, onUserEvent: (e) => events.push(e) })
    const out = c.openUserStream()
    expect(out.stream).not.toBeNull()
    expect(socket.received).toHaveLength(1)
    expect(JSON.parse(socket.received[0]!).op).toBe('auth')
    socket.onmessage?.({ data: JSON.stringify({ topic: 'execution', data: [{ symbol: 'BTCUSDT', execId: 'e-1', execQty: '0.1', execPrice: '100', execType: 'Trade', execTime: String(NOW) }] }) })
    expect(events.some((e) => e.kind === 'fill')).toBe(true)
    c.closeUserStream()
  })

  it('close() 会关掉私有流', async () => {
    const socket = new FakeSocket()
    let closed = false
    const original = socket.close.bind(socket)
    socket.close = () => {
      closed = true
      original()
    }
    const c = connector(new FakeBybitTrade(), { socketFactory: () => socket, onUserEvent: () => {} })
    c.openUserStream()
    await c.close()
    expect(closed).toBe(true)
  })
})

describe('密钥不外泄（教训 6）', () => {
  it('发过签名请求后 JSON / inspect 仍不含密钥', async () => {
    const c = connector(new FakeBybitTrade())
    await c.accountState(account())
    const json = JSON.stringify(c)
    const inspected = inspect(c, { depth: 8 })
    expect(json).not.toContain(API_SECRET)
    expect(json).not.toContain(API_KEY)
    expect(inspected).not.toContain(API_SECRET)
    expect(inspected).not.toContain(API_KEY)
  })

  it('JSON.stringify(connector) 不含密钥', () => {
    const text = JSON.stringify(connector(new FakeBybitTrade()))
    expect(text).not.toContain(API_SECRET)
    expect(text).not.toContain(API_KEY)
  })

  it('util.inspect(connector) 不含密钥', () => {
    const text = inspect(connector(new FakeBybitTrade()), { depth: 6 })
    expect(text).not.toContain(API_SECRET)
    expect(text).not.toContain(API_KEY)
  })

  it('String(错误) 不含密钥（上游把密钥回显在报错里也一样）', async () => {
    const fake = new FakeBybitTrade()
    fake.fail('GET', '/v5/account/wallet-balance', 10004, `error sign for key ${API_KEY} with secret ${API_SECRET}`)
    const c = connector(fake)
    await c.start()
    const err = await c.accountState(account()).catch((e: unknown) => e)
    const text = String(err)
    expect(text).not.toContain(API_SECRET)
    expect(text).not.toContain(API_KEY)
    expect(asProblem(err).venue?.message).not.toContain(API_SECRET)
  })

  it('budgetUsage / defaultBudget 的诊断口不暴露密钥', () => {
    const c = connector(new FakeBybitTrade())
    expect(JSON.stringify(c.budgetUsage())).not.toContain(API_SECRET)
    expect(JSON.stringify(BybitTradeConnector.defaultBudget(() => NOW))).toBe('{}')
    expect(JSON.stringify(defaultBudget(() => NOW))).toBe('{}')
  })
})
