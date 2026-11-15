// SPDX-License-Identifier: CPAL-1.0
// 行情读取：quote 只读缓存、ticker 写入、盘口深度解析与 sz 上限、标记价 + 资金费率上下文。
import { describe, expect, it } from 'vitest'
import { OkxDataConnector } from '../src/connector'
import { FakeOkx, FX_NOW } from './helpers/fake-okx'

function make() {
  const fake = new FakeOkx()
  const t = { now: FX_NOW }
  const connector = new OkxDataConnector({ baseUrl: 'http://okx.example.test', fetchImpl: fake.fetch, clock: () => t.now })
  return { fake, t, connector }
}

describe('quote', () => {
  it('quote() is undefined until refreshQuote() has run, then serves the cached bid/ask/last', async () => {
    const { fake, connector } = make()
    expect(connector.quote('okx:BTC-USDT-SWAP')).toBeUndefined()

    const quote = await connector.refreshQuote('okx:BTC-USDT-SWAP')
    expect(quote).toEqual({
      instrumentId: 'okx:BTC-USDT-SWAP', ts: FX_NOW, bid: 100.1, ask: 100.2, last: 100.15, stale: false, ageMs: 0,
    })
    const calls = fake.callsTo('/api/v5/market/ticker')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.params.get('instId')).toBe('BTC-USDT-SWAP')
    expect(connector.quote('okx:BTC-USDT-SWAP')).toEqual(quote)
  })

  it('marks a cached quote stale once it ages past staleMs, without refetching', async () => {
    const { fake, t, connector } = make()
    await connector.refreshQuote('okx:BTC-USDT-SWAP')
    t.now += 11_000
    const stale = connector.quote('okx:BTC-USDT-SWAP')!
    expect(stale).toMatchObject({ stale: true, ageMs: 11_000, bid: 100.1, ask: 100.2 })
    expect(fake.callsTo('/api/v5/market/ticker')).toHaveLength(1)
  })

  it('returns undefined when the venue sends no usable bid/ask', async () => {
    const { fake, connector } = make()
    fake.ticker = { instId: 'BTC-USDT-SWAP', last: '100', bidPx: '0', askPx: '', ts: String(FX_NOW) }
    await expect(connector.refreshQuote('okx:BTC-USDT-SWAP')).resolves.toBeUndefined()
    expect(connector.quote('okx:BTC-USDT-SWAP')).toBeUndefined()
  })

  it('refuses instrument ids that belong to another venue', async () => {
    const { fake, connector } = make()
    await expect(connector.refreshQuote('binance:BTCUSDT')).rejects.toMatchObject({ problem: { name: 'INVALID_PARAMS' } })
    expect(fake.calls).toHaveLength(0)
  })
})

describe('book', () => {
  it('parses bids descending / asks ascending in base units (size × ctVal), truncated to the requested depth', async () => {
    const { fake, connector } = make()
    const book = await connector.book('okx:BTC-USDT-SWAP', 2)

    expect(book.instrumentId).toBe('okx:BTC-USDT-SWAP')
    expect(book.ts).toBe(FX_NOW)
    // 夹具 ctVal = 0.01（BTC-USDT-SWAP）：1.5 张 → 0.015 BTC
    expect(book.bids).toEqual([{ price: 100, size: 0.015 }, { price: 99.9, size: 0.025 }])
    expect(book.asks).toEqual([{ price: 100.1, size: 0.015 }, { price: 100.2, size: 0.005 }])
    expect(fake.callsTo('/api/v5/market/books')[0]!.params.get('sz')).toBe('2')
  })

  it('defaults to 20 levels and clamps the requested depth to the 400 upper bound', async () => {
    const { fake, connector } = make()
    await connector.book('okx:BTC-USDT-SWAP')
    await connector.book('okx:BTC-USDT-SWAP', 5000)
    const szs = fake.callsTo('/api/v5/market/books').map((c) => c.params.get('sz'))
    expect(szs).toEqual(['20', '400'])
  })
})

describe('context', () => {
  it('merges mark price with the funding rate and uses the venue funding interval', async () => {
    const { fake, connector } = make()
    const context = await connector.context('okx:BTC-USDT-SWAP')

    expect(context).toMatchObject({
      instrumentId: 'okx:BTC-USDT-SWAP', ts: FX_NOW, markPrice: 100.05, fundingRate: 0.0001, fundingIntervalMs: 28_800_000,
    })
    const mark = fake.callsTo('/api/v5/public/mark-price')
    expect(mark[0]!.params.get('instType')).toBe('SWAP')
    expect(mark[0]!.params.get('instId')).toBe('BTC-USDT-SWAP')
    expect(fake.callsTo('/api/v5/public/funding-rate')[0]!.params.get('instId')).toBe('BTC-USDT-SWAP')
  })

  it('falls back to the 8h default when the venue funding window is unusable', async () => {
    const { fake, connector } = make()
    fake.fundingRate = { instId: 'BTC-USDT-SWAP', fundingRate: '', fundingTime: '', nextFundingTime: '' }
    const context = await connector.context('okx:BTC-USDT-SWAP')
    expect(context.fundingRate).toBeUndefined()
    expect(context.fundingIntervalMs).toBe(28_800_000)
    expect(context.markPrice).toBe(100.05)
  })
})
