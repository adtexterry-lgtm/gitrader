// SPDX-License-Identifier: CPAL-1.0
// 行情读取：quote 只读缓存、ticker 写入、盘口 depth 上限 / 排序 / 张数折币、context 的标记价 / 资金费率 / 未平仓。
import { describe, expect, it } from 'vitest'
import { DeribitDataConnector } from '../src/connector'
import { BTC_PERP_TICKER, FakeDeribit, FX_NOW } from './helpers/fake-deribit'

const TICKER = '/api/v2/public/ticker'
const BOOK = '/api/v2/public/get_order_book'

function make() {
  const fake = new FakeDeribit()
  const t = { now: FX_NOW }
  const connector = new DeribitDataConnector({ baseUrl: 'http://deribit.example.test', fetchImpl: fake.fetch, clock: () => t.now })
  return { fake, t, connector }
}

describe('quote', () => {
  it('quote() is undefined until refreshQuote() has run, then serves the cached bid/ask/last', async () => {
    const { fake, connector } = make()
    expect(connector.quote('deribit:BTC-PERPETUAL')).toBeUndefined()

    const quote = await connector.refreshQuote('deribit:BTC-PERPETUAL')
    expect(quote).toEqual({
      instrumentId: 'deribit:BTC-PERPETUAL', ts: FX_NOW, bid: 82383, ask: 82383.5, last: 82382.5, stale: false, ageMs: 0,
    })
    const calls = fake.callsTo(TICKER)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.params.get('instrument_name')).toBe('BTC-PERPETUAL')
    expect(connector.quote('deribit:BTC-PERPETUAL')).toEqual(quote)
  })

  it('marks a cached quote stale once it ages past staleMs, without refetching', async () => {
    const { fake, t, connector } = make()
    await connector.refreshQuote('deribit:BTC-PERPETUAL')
    t.now += 11_000
    const stale = connector.quote('deribit:BTC-PERPETUAL')!
    expect(stale).toMatchObject({ stale: true, ageMs: 11_000, bid: 82383, ask: 82383.5 })
    expect(fake.callsTo(TICKER)).toHaveLength(1)
  })

  it('returns undefined when the venue sends null or zero top-of-book prices', async () => {
    const { fake, connector } = make()
    fake.ticker = { ...BTC_PERP_TICKER, best_bid_price: null, best_ask_price: 0 }
    await expect(connector.refreshQuote('deribit:BTC-PERPETUAL')).resolves.toBeUndefined()
    expect(connector.quote('deribit:BTC-PERPETUAL')).toBeUndefined()
  })

  it('refuses instrument ids that belong to another venue', async () => {
    const { fake, connector } = make()
    await expect(connector.refreshQuote('binance:BTCUSDT')).rejects.toMatchObject({ problem: { name: 'INVALID_PARAMS' } })
    expect(fake.calls).toHaveLength(0)
  })
})

describe('book', () => {
  it('folds contract-denominated sizes into base coin and sorts / truncates by depth', async () => {
    const { fake, connector } = make()
    await connector.start()
    const book = await connector.book('deribit:BTC_USDC-PERPETUAL', 2)

    expect(book.instrumentId).toBe('deribit:BTC_USDC-PERPETUAL')
    expect(book.ts).toBe(FX_NOW + 101)
    // 夹具 amount 是张数，BTC_USDC-PERPETUAL 的 contract_size = 0.001 → 6000 张 = 6 BTC
    expect(book.bids).toEqual([{ price: 82379.5, size: 6 }, { price: 82379, size: 6 }])
    expect(book.asks).toEqual([{ price: 82382.5, size: 5 }, { price: 82383, size: 4.77 }])
    const call = fake.callsTo(BOOK)[0]!
    expect(call.params.get('instrument_name')).toBe('BTC_USDC-PERPETUAL')
    expect(call.params.get('depth')).toBe('2')
  })

  it('passes contract-denominated sizes through when the catalogue holds no contract size for the id', async () => {
    const { connector } = make()
    // 不调 start()（也没拉过清单）：拿不到面值，只能按原值透传
    const book = await connector.book('deribit:BTC-PERPETUAL', 2)
    expect(book.bids).toEqual([{ price: 82379.5, size: 6000 }, { price: 82379, size: 6000 }])
  })

  it('defaults to 20 levels and clamps the requested depth to 10000', async () => {
    const { fake, connector } = make()
    await connector.book('deribit:BTC-PERPETUAL')
    await connector.book('deribit:BTC-PERPETUAL', 50_000)
    const depths = fake.callsTo(BOOK).map((c) => c.params.get('depth'))
    expect(depths).toEqual(['20', '10000'])
  })
})

describe('context', () => {
  it('carries mark price, index price, funding rate, the 8h interval and open interest', async () => {
    const { fake, connector } = make()
    const context = await connector.context('deribit:BTC-PERPETUAL')

    expect(context).toEqual({
      instrumentId: 'deribit:BTC-PERPETUAL',
      ts: FX_NOW,
      markPrice: 82389.66,
      oraclePrice: 82368.93,
      fundingRate: 1.67e-06,
      fundingIntervalMs: 28_800_000,
      openInterest: 854682650,
    })
    expect(fake.callsTo(TICKER)[0]!.params.get('instrument_name')).toBe('BTC-PERPETUAL')
  })

  it('converts the contract-denominated open interest into base coin', async () => {
    const { connector } = make()
    await connector.start()
    const context = await connector.context('deribit:BTC_USDC-PERPETUAL')
    // 夹具 open_interest = 854682650 张，BTC_USDC-PERPETUAL 的 contract_size = 0.001 → 854682.65 BTC
    expect(context.openInterest).toBe(854682.65)
    expect(context.fundingRate).toBe(1.67e-06)
  })

  it('falls back to the 8h funding average when current_funding is missing', async () => {
    const { fake, connector } = make()
    fake.ticker = { ...BTC_PERP_TICKER, current_funding: null }
    const context = await connector.context('deribit:BTC-PERPETUAL')
    expect(context.fundingRate).toBe(1.795e-05)
  })

  it('leaves funding out for dated futures that carry no funding fields', async () => {
    const { fake, connector } = make()
    fake.ticker = { instrument_name: 'BTC-30OCT26', timestamp: FX_NOW, mark_price: 82500, index_price: 82480, current_funding: null, funding_8h: null }
    const context = await connector.context('deribit:BTC-30OCT26')
    expect(context).toMatchObject({ markPrice: 82500, oraclePrice: 82480, fundingIntervalMs: 28_800_000 })
    expect(context.fundingRate).toBeUndefined()
  })
})
