// SPDX-License-Identifier: CPAL-1.0
// 行情读取：quote 只读缓存、ticker 写入、merge-depth 档位与深度解析、context 的标记价 / 资金费率 / 持仓量。
import { describe, expect, it } from 'vitest'
import { BitgetDataConnector } from '../src/connector'
import { FakeBitget, FX_NOW } from './helpers/fake-bitget'

function make() {
  const fake = new FakeBitget()
  const t = { now: FX_NOW }
  const connector = new BitgetDataConnector({ baseUrl: 'http://bitget.example.test', fetchImpl: fake.fetch, clock: () => t.now })
  return { fake, t, connector }
}

describe('quote', () => {
  it('quote() is undefined until refreshQuote() has run, then serves the cached bid/ask/last', async () => {
    const { fake, connector } = make()
    expect(connector.quote('bitget:BTCUSDT')).toBeUndefined()

    const quote = await connector.refreshQuote('bitget:BTCUSDT')
    expect(quote).toEqual({
      instrumentId: 'bitget:BTCUSDT', ts: 1_792_510_096_957, bid: 82396.1, ask: 82396.2, last: 82396.2, stale: false, ageMs: 0,
    })
    const call = fake.callsTo('/api/v2/mix/market/ticker')[0]!
    expect(call.params.get('productType')).toBe('USDT-FUTURES')
    expect(call.params.get('symbol')).toBe('BTCUSDT')
    expect(connector.quote('bitget:BTCUSDT')).toEqual(quote)
  })

  it('marks a cached quote stale once it ages past staleMs, without refetching', async () => {
    const { fake, t, connector } = make()
    await connector.refreshQuote('bitget:BTCUSDT')
    t.now += 11_000
    const stale = connector.quote('bitget:BTCUSDT')!
    expect(stale).toMatchObject({ stale: true, bid: 82396.1, ask: 82396.2 })
    // 缓存 ts 取上游 ticker 的 ts（比注入的 clock 晚 2ms），所以 ageMs 略小于 11s
    expect(stale.ageMs).toBeGreaterThan(10_000)
    expect(fake.callsTo('/api/v2/mix/market/ticker')).toHaveLength(1)
  })

  it('returns undefined when the venue sends no usable bid/ask', async () => {
    const { fake, connector } = make()
    fake.ticker = { symbol: 'BTCUSDT', lastPr: '82396.2', bidPr: '0', askPr: '', ts: String(FX_NOW) }
    await expect(connector.refreshQuote('bitget:BTCUSDT')).resolves.toBeUndefined()
    expect(connector.quote('bitget:BTCUSDT')).toBeUndefined()
  })

  it('refuses instrument ids that belong to another venue', async () => {
    const { fake, connector } = make()
    await expect(connector.refreshQuote('binance:BTCUSDT')).rejects.toMatchObject({ problem: { name: 'INVALID_PARAMS' } })
    expect(fake.calls).toHaveLength(0)
  })
})

describe('book', () => {
  it('parses merge-depth into descending bids and ascending asks, truncated to the requested depth', async () => {
    const { fake, connector } = make()
    const book = await connector.book('bitget:BTCUSDT', 2)

    expect(book.instrumentId).toBe('bitget:BTCUSDT')
    expect(book.ts).toBe(1_792_510_097_120)
    expect(book.bids).toEqual([{ price: 82402.7, size: 7.7387 }, { price: 82401.5, size: 1.2375 }])
    expect(book.asks).toEqual([{ price: 82402.8, size: 2.8471 }, { price: 82403.2, size: 0.495 }])
    const call = fake.callsTo('/api/v2/mix/market/merge-depth')[0]!
    expect(call.params.get('limit')).toBe('5') // 官方只允许 1/5/15/50/max
    expect(call.params.get('productType')).toBe('USDT-FUTURES')
    expect(call.params.get('symbol')).toBe('BTCUSDT')
  })

  it('buckets the requested depth onto the venue ladder (20 → 50, 100 → max)', async () => {
    const { fake, connector } = make()
    await connector.book('bitget:BTCUSDT')
    await connector.book('bitget:BTCUSDT', 100)
    const limits = fake.callsTo('/api/v2/mix/market/merge-depth').map((c) => c.params.get('limit'))
    expect(limits).toEqual(['50', 'max'])
  })
})

describe('context', () => {
  it('carries mark price, index price, funding rate, funding interval, open interest and 24h notional', async () => {
    const { fake, connector } = make()
    const context = await connector.context('bitget:BTCUSDT')

    expect(context).toMatchObject({
      instrumentId: 'bitget:BTCUSDT',
      ts: 1_792_510_096_957,
      markPrice: 82405.8,
      oraclePrice: 82448.5535,
      fundingRate: 0.000073,
      fundingIntervalMs: 28_800_000,
      openInterest: 33967.4455999999845,
      dayNotionalVolume: 2816260673.22247,
      prevDayPrice: 82397.2,
    })
    expect(context.midPrice).toBeCloseTo(82396.15, 6)
    expect(fake.callsTo('/api/v2/mix/market/ticker')[0]!.params.get('symbol')).toBe('BTCUSDT')
    expect(fake.callsTo('/api/v2/mix/market/current-fund-rate')[0]!.params.get('symbol')).toBe('BTCUSDT')
  })

  it('falls back to the ticker funding rate and the 8h interval when current-fund-rate is silent', async () => {
    const { fake, connector } = make()
    fake.funding = { symbol: 'BTCUSDT', fundingRate: '', fundingRateInterval: '' }
    const context = await connector.context('bitget:BTCUSDT')
    expect(context.fundingRate).toBe(0.000073)
    expect(context.fundingIntervalMs).toBe(28_800_000)
  })

  it('keeps the mark price when the ticker has no markPrice field', async () => {
    const { fake, connector } = make()
    fake.ticker = { symbol: 'BTCUSDT', lastPr: '82100', bidPr: '82099.9', askPr: '82100.1', ts: String(FX_NOW) }
    const context = await connector.context('bitget:BTCUSDT')
    expect(context.markPrice).toBe(82100)
    expect(context.fundingRate).toBe(0.000073)
  })
})
