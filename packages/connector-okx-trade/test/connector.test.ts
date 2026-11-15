// SPDX-License-Identifier: CPAL-1.0
// 连接器装配与只读复用（全离线）：describe() 过协议校验、start() 拉目录后 settleCcy 过滤生效、
// 行情方法复用数据包、私有流没有工厂时明确拒绝（不做假连接）。
import { describe, expect, it } from 'vitest'
import { inspect } from 'node:util'
import { validateVenueCapabilities } from '@gitrader/protocol'
import { DEADMAN_MAX_DELAY_SEC, defaultBudget, OkxTradeConnector } from '../src/connector'
import { API_KEY, API_SECRET, BASE_URL, FakeOkxTrade, NOW, PASSPHRASE } from './helpers/fake-okx-trade'

function connector(fake: FakeOkxTrade, opts: { withSocket?: boolean } = {}): OkxTradeConnector {
  return new OkxTradeConnector({
    apiKey: API_KEY,
    apiSecret: API_SECRET,
    passphrase: PASSPHRASE,
    baseUrl: BASE_URL,
    fetchImpl: fake.fetch,
    clock: () => NOW,
    budget: defaultBudget(() => NOW),
    onWarn: () => {},
    ...(opts.withSocket === true ? { socketFactory: () => ({ send() {}, close() {}, onmessage: null }) } : {}),
  })
}

describe('assembly', () => {
  it('describe() passes the protocol schema and names okx', () => {
    const c = connector(new FakeOkxTrade())
    const caps = c.describe()
    expect(caps.venue).toBe('okx')
    expect(validateVenueCapabilities(caps).ok).toBe(true)
  })

  it('start() loads the SWAP catalogue and drops coin-margined / FUTURES entries', async () => {
    const fake = new FakeOkxTrade()
    const c = connector(fake)
    await c.start()
    expect(c.listInstruments().map((i) => i.symbol).sort()).toEqual(['BTC-USDC-SWAP', 'BTC-USDT-SWAP', 'ETH-USDT-SWAP'])
    expect(c.getInstrument('okx:BTC-USD-SWAP')).toBeUndefined()
    expect(fake.callsFor('GET', '/api/v5/public/instruments')[0]!.params.get('instType')).toBe('SWAP')
  })

  it('records carry ctVal so orders can fold base size into contracts', async () => {
    const c = connector(new FakeOkxTrade())
    await c.start()
    expect(c.records().find((r) => r.symbol === 'BTC-USDT-SWAP')?.ctVal).toBe('0.01')
    expect(c.recordOf('okx:BTC-USDT-SWAP')?.lotContracts).toBe('0.01')
    expect(c.recordOf('okx:BTC-USDT-SWAP')?.ctVal).toBe('0.01')
  })

  it('exposes the trading view with contractSize = 1 and the real order capabilities', async () => {
    const c = connector(new FakeOkxTrade())
    await c.start()
    const btc = c.getInstrument('okx:BTC-USDT-SWAP')!
    expect(btc.contractSize).toBe('1')
    expect(btc.orderTypes).toContain('market')
    expect(btc.orderTypes).toContain('limit')
    expect(btc.triggerPriceTypes).toEqual(['mark'])
    expect(btc.size.step).toBe('0.0001')
    expect(c.listInstruments().every((i) => i.contractSize === '1')).toBe(true)
  })

  it('never serializes or inspects credentials', async () => {
    const c = connector(new FakeOkxTrade())
    await c.start()
    const text = JSON.stringify(c)
    expect(text).not.toContain(API_SECRET)
    expect(text).not.toContain(PASSPHRASE)
    expect(text).not.toContain(API_KEY)
    const inspected = inspect(c, { depth: 10 })
    expect(inspected).not.toContain(API_SECRET)
    expect(inspected).not.toContain(PASSPHRASE)
    expect(inspected).not.toContain(API_KEY)
  })

  it('armDeadman clamps the delay to 10..120 and disarms on stop', async () => {
    const fake = new FakeOkxTrade()
    const c = connector(fake)
    const handle = c.armDeadman({ account: { accountId: 'acct_test', address: '0x0' } } as never, { delaySec: 5 })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const first = fake.callsFor('POST', '/api/v5/trade/cancel-all-after')[0]!
    expect(JSON.parse(first.body).timeOut).toBe('10')
    await handle.stop()
    const calls = fake.callsFor('POST', '/api/v5/trade/cancel-all-after')
    expect(JSON.parse(calls[calls.length - 1]!.body).timeOut).toBe('0')
    expect(handle.stats().refreshes).toBeGreaterThan(0)
  })

  it('read-only market calls reuse the data package', async () => {
    const c = connector(new FakeOkxTrade())
    await c.start()
    const candles = await c.candles('okx:BTC-USDT-SWAP', '1m', { n: 1 })
    expect(candles).toHaveLength(1)
    expect(candles[0]!.c).toBe(100.5)
    const book = await c.book('okx:BTC-USDT-SWAP', 5)
    expect(book.bids[0]!.price).toBe(100)
    const ctx = await c.context('okx:BTC-USDT-SWAP')
    expect(ctx.markPrice).toBe(100.05)
    const quote = await c.refreshQuote('okx:BTC-USDT-SWAP')
    expect(quote?.bid).toBe(100.1)
    expect(c.quote('okx:BTC-USDT-SWAP')?.ask).toBe(100.2)
  })

  it('account reads go through the connector surface', async () => {
    const c = connector(new FakeOkxTrade())
    await c.start()
    const snap = await c.accountState({ accountId: 'acct_test', address: '0x0' })
    expect(snap.margin.equity).toBe('1000.5')
    expect(await c.openOrders({ accountId: 'acct_test', address: '0x0' })).toHaveLength(3)
    expect((await c.startupSnapshot({ accountId: 'acct_test', address: '0x0' }, NOW - 60_000)).fills).toHaveLength(2)
  })

  it('fills honor an explicit instrumentId', async () => {
    const fake = new FakeOkxTrade()
    const c = connector(fake)
    await c.start()
    await c.fills({ accountId: 'acct_test', address: '0x0' }, NOW - 60_000, { instrumentId: 'okx:ETH-USDT-SWAP' })
    expect(fake.callsFor('GET', '/api/v5/trade/fills')[0]!.params.get('instId')).toBe('ETH-USDT-SWAP')
  })

  it('uncached orderStatus honors an explicit instrumentId', async () => {
    const fake = new FakeOkxTrade()
    const c = connector(fake)
    await c.start()
    const status = await c.orderStatus({ accountId: 'acct_test', address: '0x0' }, {
      venueOrderId: '3122698', instrumentId: 'okx:BTC-USDT-SWAP',
    })
    expect(status.found).toBe(true)
    expect(fake.callsFor('GET', '/api/v5/trade/order')[0]!.params.get('instId')).toBe('BTC-USDT-SWAP')
  })

  it('refuses to open a private stream without an injected socket factory', () => {
    const c = connector(new FakeOkxTrade())
    expect(() => c.openUserStream()).toThrow(/no socketFactory/)
  })

  it('exposes the deadman cap and the ping interval it documents', () => {
    expect(DEADMAN_MAX_DELAY_SEC).toBe(120)
    expect(OkxTradeConnector.pingIntervalMs()).toBe(25_000)
  })
})
