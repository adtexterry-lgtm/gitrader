// SPDX-License-Identifier: CPAL-1.0
// 行情读取：quote 只读缓存、ticker 写入、盘口张数 → 币数（quanto_multiplier）、limit 上限、
// 标记价 / 资金费率 / 持仓量上下文（funding_interval / funding_next_apply 秒 → 毫秒）。
import { describe, expect, it } from 'vitest'
import { GateioDataConnector } from '../src/connector'
import { FakeGateio, FX_NOW, REAL_CONTRACTS, REAL_TICKER } from './helpers/fake-gateio'

const TICKERS = '/api/v4/futures/usdt/tickers'
const BOOK = '/api/v4/futures/usdt/order_book'

function make() {
  const fake = new FakeGateio()
  const t = { now: FX_NOW }
  const connector = new GateioDataConnector({ baseUrl: 'http://gateio.example.test', fetchImpl: fake.fetch, clock: () => t.now })
  return { fake, t, connector }
}

describe('quote', () => {
  it('quote() is undefined until refreshQuote() has run, then serves the cached best bid / ask / last', async () => {
    const { fake, connector } = make()
    expect(connector.quote('gateio:BTC_USDT')).toBeUndefined()

    const quote = await connector.refreshQuote('gateio:BTC_USDT')
    expect(quote).toEqual({
      instrumentId: 'gateio:BTC_USDT', ts: FX_NOW, bid: 82436.7, ask: 82436.8, last: 82436.7, stale: false, ageMs: 0,
    })
    const calls = fake.callsTo(TICKERS)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.params.get('contract')).toBe('BTC_USDT')
    expect(connector.quote('gateio:BTC_USDT')).toEqual(quote)
  })

  it('marks a cached quote stale once it ages past staleMs, without refetching', async () => {
    const { fake, t, connector } = make()
    await connector.refreshQuote('gateio:BTC_USDT')
    t.now += 11_000
    expect(connector.quote('gateio:BTC_USDT')).toMatchObject({ stale: true, ageMs: 11_000, bid: 82436.7, ask: 82436.8 })
    expect(fake.callsTo(TICKERS)).toHaveLength(1)
  })

  it('returns undefined when the venue sends no usable bid/ask', async () => {
    const { fake, connector } = make()
    fake.ticker = [{ ...REAL_TICKER, highest_bid: '0', lowest_ask: '' }]
    await expect(connector.refreshQuote('gateio:BTC_USDT')).resolves.toBeUndefined()
    expect(connector.quote('gateio:BTC_USDT')).toBeUndefined()
  })

  it('refuses instrument ids that belong to another venue', async () => {
    const { fake, connector } = make()
    await expect(connector.refreshQuote('okx:BTC-USDT-SWAP')).rejects.toMatchObject({ problem: { name: 'INVALID_PARAMS' } })
    expect(fake.calls).toHaveLength(0)
  })
})

describe('book', () => {
  it('converts contract sizes into base-coin sizes via quanto_multiplier, bids desc / asks asc', async () => {
    const { fake, connector } = make()
    await connector.start()
    const book = await connector.book('gateio:BTC_USDT', 3)

    expect(book.instrumentId).toBe('gateio:BTC_USDT')
    expect(book.ts).toBe(1_792_510_162_502)
    expect(book.bids).toEqual([
      { price: 82440.3, size: 3.7812 },
      { price: 82437.4, size: 0.125 },
      { price: 82437.2, size: 1.3233 },
    ])
    expect(book.asks).toEqual([
      { price: 82440.4, size: 0.2443 },
      { price: 82442.9, size: 0.0007 },
      { price: 82443, size: 0.2185 },
    ])
    const call = fake.callsTo(BOOK)[0]!
    expect(call.params.get('contract')).toBe('BTC_USDT')
    expect(call.params.get('limit')).toBe('3')
  })

  it('loads the contract list on a cold cache so sizes are base coins, defaults to 20 and clamps limit to 100', async () => {
    const { fake, connector } = make()
    const cold = await connector.book('gateio:BTC_USDT', 1)
    expect(cold.bids).toEqual([{ price: 82440.3, size: 3.7812 }])
    expect(fake.callsTo('/api/v4/futures/usdt/contracts')).toHaveLength(1)

    await connector.book('gateio:BTC_USDT')
    await connector.book('gateio:BTC_USDT', 5000)
    const limits = fake.callsTo(BOOK).map((c) => c.params.get('limit'))
    expect(limits).toEqual(['1', '20', '100'])
  })
})

describe('context', () => {
  it('reads mark price / funding rate / open interest from the ticker and the funding fields from the contract cache', async () => {
    const { fake, connector } = make()
    await connector.start()
    const context = await connector.context('gateio:BTC_USDT')

    expect(context).toEqual({
      instrumentId: 'gateio:BTC_USDT', ts: FX_NOW, markPrice: 82439.89, fundingRate: 0.000019,
      fundingIntervalMs: 28_800_000, openInterest: 52_915.7, nextFundingTime: 1_792_512_000_000,
    })
    expect(fake.callsTo(TICKERS)[0]!.params.get('contract')).toBe('BTC_USDT')
  })

  it('uses the contract funding_interval / funding_next_apply (seconds -> ms) when the venue publishes them', async () => {
    const fake = new FakeGateio()
    fake.contracts = [{ ...REAL_CONTRACTS[0]!, funding_interval: 14400, funding_next_apply: 1_792_515_600 }]
    const connector = new GateioDataConnector({ baseUrl: 'http://gateio.example.test', fetchImpl: fake.fetch, clock: () => FX_NOW })
    await connector.start()
    const context = await connector.context('gateio:BTC_USDT')
    expect(context.fundingIntervalMs).toBe(14_400_000)
    expect(context.nextFundingTime).toBe(1_792_515_600_000)
    expect(connector.getInstrument('gateio:BTC_USDT')?.fundingIntervalMs).toBe(14_400_000)
  })

  it('loads the contract list first when the cache is still cold, then falls back on unusable ticker fields', async () => {
    const { fake, connector } = make()
    fake.ticker = [{ ...REAL_TICKER, mark_price: '', funding_rate: '', total_size: '0' }]
    const context = await connector.context('gateio:BTC_USDT')
    expect(context).toEqual({
      instrumentId: 'gateio:BTC_USDT', ts: FX_NOW, markPrice: 0, fundingIntervalMs: 28_800_000,
      nextFundingTime: 1_792_512_000_000,
    })
    // 清单未加载：context() 先拉一次 /contracts
    expect(fake.callsTo('/api/v4/futures/usdt/contracts')).toHaveLength(1)
  })
})
