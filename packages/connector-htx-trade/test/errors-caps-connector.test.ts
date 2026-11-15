// SPDX-License-Identifier: CPAL-1.0
// 错误分类 / 能力声明 / 连接器装配（密钥不外泄、describe 与实际实现一致）。
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inspect } from 'node:util'
import { asDecimal } from '@gitrader/protocol'
import type { OrderIntent } from '@gitrader/protocol'
import { classifyOnly, HTX_ERROR_CLASSES, isAmbiguousVenueCode } from '../src/venue-errors'
import { asProblem, HtxHttpError, redactSecret, VENUE_ID } from '../src/errors'
import { htxCapabilities } from '../src/capabilities'
import { HtxTradeConnector } from '../src/connector'
import { API_KEY, API_SECRET, BASE_URL, FakeHtx, NOW } from './helpers/fake-htx'
import { ctx } from './helpers/harness'

describe('错误分类', () => {
  it('签名 / 权限类文案 → credentials', () => {
    expect(classifyOnly({ text: 'Signature verification failed' })).toBe('credentials')
    expect(classifyOnly({ text: '403 Forbidden: invalid api key' })).toBe('credentials')
  })

  it('时间戳类文案 → clock_skew', () => {
    expect(classifyOnly({ text: 'the timestamp is expired' })).toBe('clock_skew')
  })

  it('频率类文案 → rate_limit（1032 同码）', () => {
    expect(classifyOnly({ text: 'request too frequent, please try later' })).toBe('rate_limit')
    expect(classifyOnly({ text: 'unknown', venueCode: 1032 })).toBe('rate_limit')
  })

  it('合约不存在 → invalid_symbol（1013 / 1014 同码）', () => {
    expect(classifyOnly({ text: 'contract BTC-XYZ does not exist' })).toBe('invalid_symbol')
    expect(classifyOnly({ text: "contract symbol doesn't exist", venueCode: 1013 })).toBe('invalid_symbol')
    expect(classifyOnly({ text: 'unknown', venueCode: 1014 })).toBe('invalid_symbol')
  })

  it('资金不足 → insufficient_funds', () => {
    expect(classifyOnly({ text: 'insufficient margin for this order' })).toBe('insufficient_funds')
  })

  it('数量 / 精度 → order_size', () => {
    expect(classifyOnly({ text: 'order volume is below the min size' })).toBe('order_size')
  })

  it('持仓模式 / 杠杆 → account_configuration（含 1499 / 1500）', () => {
    expect(classifyOnly({ text: 'the account is in hedge mode currently', venueCode: 1499 })).toBe('account_configuration')
    expect(classifyOnly({ text: 'leverage is out of range' })).toBe('account_configuration')
    expect(HTX_ERROR_CLASSES[1500]).toBe('account_configuration')
  })

  it('结算中 / 下线 → market_unavailable', () => {
    expect(classifyOnly({ text: 'contract is in settlement' })).toBe('market_unavailable')
  })

  it('认不出来的落 exchange_rejected（不猜）', () => {
    expect(classifyOnly({ text: 'something entirely unexpected' })).toBe('exchange_rejected')
  })

  it('系统 / 结果未知码：1000 1001 1002 1003 1004 500 6021；1499 不是', () => {
    for (const code of [1000, 1001, 1002, 1003, 1004, 500, 6021]) expect(isAmbiguousVenueCode(code)).toBe(true)
    expect(isAmbiguousVenueCode(1499)).toBe(false)
    expect(isAmbiguousVenueCode(1032)).toBe(false)
  })

  it('分类出来的 Problem 带 venue.id / code / 原文', () => {
    const problem = asProblem(new HtxHttpError(200, '{"err_msg":"insufficient margin"}', 'signed', undefined, 1047))
    expect(problem.code).toBe(3004)
    expect(problem.venue?.id).toBe(VENUE_ID)
    expect(problem.venue?.code).toBe(1047)
    expect(problem.venue?.message).toContain('insufficient margin')
  })

  it('系统错误 1000 在非 GET 上 → 3006（结果未知）', () => {
    const problem = asProblem(new HtxHttpError(200, '{"err_code":1000,"err_msg":"System error"}', 'signed', undefined, 1000, true))
    expect(problem.code).toBe(3006)
  })

  it('脱敏：密钥与它的 base64 形态都替换掉', () => {
    const encoded = Buffer.from('top-secret', 'utf8').toString('base64')
    expect(redactSecret(`key=top-secret b64=${encoded}`, 'top-secret')).toBe('key=<redacted> b64=<redacted>')
    expect(redactSecret('nothing here', '')).toBe('nothing here')
  })

  it('asProblem 保留已携带的 Problem（不重复分类）', () => {
    const original = { code: 1004, name: 'ORDER_TYPE_UNSUPPORTED', category: 'REJECTED', message: 'nope', retryable: false } as const
    expect(asProblem({ problem: original }).name).toBe('ORDER_TYPE_UNSUPPORTED')
  })

  it('任意普通错误 → 4001 INTERNAL', () => {
    expect(asProblem(new Error('boom')).code).toBe(4001)
  })
})

describe('能力声明（与实现一致）', () => {
  const caps = htxCapabilities()
  const v1caps = htxCapabilities({ family: 'v1' })

  it('venue / 环境 / 品种', () => {
    expect(caps.venue).toBe('htx')
    expect(caps.environments).toEqual(['mainnet'])
    expect(caps.instrumentKinds).toEqual(['perp'])
  })

  it('市价是 emulated（ioc_limit），限价是 native，触发单不声明', () => {
    expect(caps.orderTypes.market).toBe('emulated')
    expect(caps.marketEmulation?.method).toBe('ioc_limit')
    expect(caps.orderTypes.limit).toBe('native')
    expect(caps.orderTypes.stop_market).toBe('none')
    expect(caps.orderTypes.take_limit).toBe('none')
    expect(caps.orderTypes.trailing_stop).toBe('none')
    expect(caps.triggerPriceTypes).toEqual([])
  })

  it('tpsl：不随单挂；仓位级只在 v1', () => {
    expect(caps.tpsl?.attachToOrder).toBe(false)
    expect(caps.tpsl?.positionLevel).toBe(false)
    expect(v1caps.tpsl?.positionLevel).toBe(true)
  })

  it('amend=none（HTX 没有改单端点），cancelAll=native', () => {
    expect(caps.amend).toBe('none')
    expect(caps.cancelAll).toBe('native')
  })

  it('marginModes：v5 cross+isolated，v1 只有 cross', () => {
    expect(caps.marginModes).toEqual(['cross', 'isolated'])
    expect(v1caps.marginModes).toEqual(['cross'])
  })

  it('deadman 不声明（v5 cancel-after 未实现）', () => {
    expect(caps.deadman).toBeUndefined()
    expect(String(caps['x-cancelAll'])).toContain('cancel_all_orders')
  })

  it('签名者是 api-key 且不能提现', () => {
    expect(caps.signers?.type).toBe('api-key')
    expect(caps.signers?.withdrawCapable).toBe(false)
  })

  it('clientOrderId 格式声明为 htx-int64', () => {
    expect(caps.clientOrderId?.format).toBe('htx-int64')
  })

  it('能力表里的 tif 与实际发送的 price type 一一对应', () => {
    expect(caps.tif).toEqual(['gtc', 'ioc', 'fok', 'alo'])
  })
})

describe('连接器装配', () => {
  const make = (fake: FakeHtx, family: 'v5' | 'v1' = 'v5'): HtxTradeConnector => new HtxTradeConnector({
    baseUrl: BASE_URL,
    apiKey: API_KEY,
    apiSecret: API_SECRET,
    fetchImpl: fake.fetch,
    clock: () => 1_760_000_000_000,
    onWarn: () => {},
    defaultSymbol: 'BTC-USDT',
    family,
  })

  it('describe() 与 capabilities 同源', () => {
    expect(make(new FakeHtx()).describe().venue).toBe('htx')
  })

  it('start() 拉合约清单后能按 instrumentId 取到标的', async () => {
    const connector = make(new FakeHtx())
    await connector.start()
    expect(connector.listInstruments()).toHaveLength(2)
    expect(connector.getInstrument('htx:BTC-USDT')!.symbol).toBe('BTC-USDT')
  })

  it('start() 后对内核口径：contractSize=1、size.step=面值、decimals=3', async () => {
    const connector = make(new FakeHtx())
    await connector.start()
    const btc = connector.getInstrument('htx:BTC-USDT')!
    expect(String(btc.contractSize)).toBe('1')
    expect(String(btc.size.step)).toBe('0.001')
    expect(String(btc.size.min)).toBe('0.001')
    expect(btc.size.decimals).toBe(3)
    expect(btc.venueSizeUnit).toBe('base')
  })

  it('quote() 在没刷新过时是 undefined（同步缓存，不假装有价）', () => {
    expect(make(new FakeHtx()).quote('htx:BTC-USDT')).toBeUndefined()
  })

  it('refreshQuote() 拉聚合行情并缓存', async () => {
    const connector = make(new FakeHtx())
    const quote = await connector.refreshQuote('htx:BTC-USDT')
    expect(quote!.bid).toBe(99.9)
    expect(quote!.ask).toBe(100.1)
    expect(connector.quote('htx:BTC-USDT')!.stale).toBe(false)
  })

  it('book() / candles() 解析官方形状：盘口张→币、K 线 open/close/amount', async () => {
    const connector = make(new FakeHtx())
    await connector.start()
    const book = await connector.book('htx:BTC-USDT', 2)
    expect(book.bids[0]!.price).toBe(99.9)
    expect(book.bids[0]!.size).toBe(5) // 5000 张 × 0.001
    const candles = await connector.candles('htx:BTC-USDT', '1m', { n: 2 })
    expect(candles).toHaveLength(2)
    expect(candles[0]!.t).toBeLessThan(candles[1]!.t) // 升序（HTX 原样是倒序）
    expect(candles[1]!.o).toBe(99)
    expect(candles[1]!.c).toBe(100)
    expect(candles[1]!.v).toBe(1000)
  })

  it('candles()：官方没有的周期 → INVALID_PARAMS 且不发请求', async () => {
    const fake = new FakeHtx()
    const connector = make(fake)
    await expect(connector.candles('htx:BTC-USDT', '3m')).rejects.toMatchObject({ problem: { name: 'INVALID_PARAMS' } })
    expect(fake.seen).toHaveLength(0)
  })

  it('context()：markPrice 取最新成交价，不编 fundingRate', async () => {
    const connector = make(new FakeHtx())
    const context = await connector.context('htx:BTC-USDT')
    expect(context.markPrice).toBe(100)
    expect(context.fundingRate).toBeUndefined()
  })

  it('subscribe() 返回可调用的退订函数（本包没有 WS，不伪装推送）', () => {
    const off = make(new FakeHtx()).subscribe({ channel: 'mids' }, () => {})
    expect(() => off()).not.toThrow()
  })

  it('status() 老实报 ws disconnected / source none', () => {
    const status = make(new FakeHtx()).status()
    expect(status.wsState).toBe('disconnected')
    expect(status.source).toBe('none')
  })

  it('密钥不出现在 JSON.stringify / util.inspect 里', () => {
    const connector = make(new FakeHtx())
    const json = JSON.stringify(connector)
    const text = inspect(connector, { depth: 4 })
    for (const needle of [API_KEY, API_SECRET]) {
      expect(json.includes(needle)).toBe(false)
      expect(text.includes(needle)).toBe(false)
    }
  })

  it('armDeadman 直接 5002（不伪装）', () => {
    expect(() => make(new FakeHtx()).armDeadman(ctx())).toThrow()
  })

  it('端到端：refreshQuote → submit 市价意图（type=limit + time_in_force=ioc）', async () => {
    const fake = new FakeHtx()
    const connector = make(fake)
    await connector.start()
    await connector.refreshQuote('htx:BTC-USDT')
    const intent: OrderIntent = {
      accountId: 'acct_htx_1',
      instrumentId: 'htx:BTC-USDT',
      side: 'buy',
      type: 'market',
      size: asDecimal('0.01'),
      maxSlippageBps: 30,
    }
    const result = await connector.submit(ctx(), [intent])
    expect(result.acks[0]!.status).toBe('open')
    const body = fake.seen.find((r) => r.path === '/v5/trade/order')!.body
    expect(body.type).toBe('limit')
    expect(body.time_in_force).toBe('ioc')
    expect(body.volume).toBe('10')
    expect(Number(body.price)).toBeGreaterThan(99.9)
    expect(Number(body.price)).toBeLessThanOrEqual(100.2)
  })

  it('v1 连接器：setTpsl 可达；v5 连接器 accountState 可达', async () => {
    const fakeV1 = new FakeHtx()
    const v1 = make(fakeV1, 'v1')
    await v1.start()
    await v1.setTpsl(ctx(), { contractCode: 'BTC-USDT', direction: 'sell', volume: 10, stopLoss: { triggerPrice: asDecimal('95') } })
    expect(fakeV1.seen.some((r) => r.path.endsWith('swap_cross_tpsl_order'))).toBe(true)

    const fakeV5 = new FakeHtx()
    fakeV5.positions = [{ contract_code: 'BTC-USDT', direction: 'buy', volume: 10, cost_open: '100', last_price: '101', lever_rate: 3 }]
    const v5 = make(fakeV5)
    await v5.start()
    const snapshot = await v5.accountState({ accountId: 'acc_htx_1' as never, address: 'htx' as never })
    expect(snapshot.positions).toHaveLength(1)
    expect(fakeV5.closeAllCalls).toBe(0)
  })

  it('连接器装配时把 marginMode 传给账户查单参数', async () => {
    const fake = new FakeHtx()
    const connector = new HtxTradeConnector({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      apiSecret: API_SECRET,
      fetchImpl: fake.fetch,
      clock: () => NOW,
      onWarn: () => {},
      defaultSymbol: 'BTC-USDT',
      marginMode: 'isolated',
    })
    await connector.orderStatus({ accountId: 'acc_htx_1' as never, address: 'htx' as never }, { venueOrderId: '1' })
    expect(fake.seen[0]!.query.margin_mode).toBe('isolated')
  })
})

describe('HTX 没有官方测试网', () => {
  const opts = { apiKey: API_KEY, apiSecret: API_SECRET, onWarn: () => {} }

  it("environment:'testnet' 且不传 baseUrl → 构造即抛配置错误", () => {
    let thrown: unknown
    try { new HtxTradeConnector({ ...opts, environment: 'testnet' }) } catch (e) { thrown = e }
    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toContain('没有官方测试网')
    expect((thrown as { problem: { name: string } }).problem.name).toBe('INVALID_PARAMS')
  })

  it("environment:'testnet' + 显式 baseUrl（离线假服务器）→ 照常", () => {
    const c = new HtxTradeConnector({ ...opts, environment: 'testnet', baseUrl: BASE_URL, fetchImpl: new FakeHtx().fetch })
    expect(c.http.baseUrl).toBe(BASE_URL)
  })

  it('全包不再出现备用域名字样', () => {
    const needle = ['hbdm', 'vip'].join('.')
    const root = fileURLToPath(new URL('..', import.meta.url))
    const hits: string[] = []
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name === 'dist') continue
        const path = join(dir, name)
        if (statSync(path).isDirectory()) walk(path)
        else if (readFileSync(path, 'utf8').includes(needle)) hits.push(path)
      }
    }
    walk(root)
    expect(hits).toEqual([])
  })
})
