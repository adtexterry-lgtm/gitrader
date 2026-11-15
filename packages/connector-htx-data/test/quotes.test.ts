// SPDX-License-Identifier: CPAL-1.0
// 行情读取：quote 只读缓存、market/detail/merged 写入、盘口张数 → 币、context 的标记价与资金费。
import { describe, expect, it } from 'vitest'
import { HtxDataConnector } from '../src/connector'
import { FakeHtx, FX_NOW, MERGED_EXAMPLE } from './helpers/fake-htx'

const MERGED = '/linear-swap-ex/market/detail/merged'
const DEPTH = '/linear-swap-ex/market/depth'
const FUNDING = '/linear-swap-api/v1/swap_funding_rate'
const MARK = '/index/market/history/linear_swap_mark_price_kline'

function make() {
  const fake = new FakeHtx()
  const t = { now: FX_NOW }
  const connector = new HtxDataConnector({ baseUrl: 'https://htx.example.test', fetchImpl: fake.fetch, clock: () => t.now })
  return { fake, t, connector }
}

describe('quote', () => {
  it('quote() is undefined until refreshQuote() has run, then serves the cached merged tick', async () => {
    const { fake, connector } = make()
    expect(connector.quote('htx:BTC-USDT')).toBeUndefined()

    const quote = await connector.refreshQuote('htx:BTC-USDT')
    expect(quote).toEqual({
      instrumentId: 'htx:BTC-USDT', ts: FX_NOW, bid: MERGED_EXAMPLE.bid[0], ask: MERGED_EXAMPLE.ask[0],
      last: Number(MERGED_EXAMPLE.close), stale: false, ageMs: 0,
    })
    const call = fake.callsTo(MERGED)[0]!
    expect(call.params.get('contract_code')).toBe('BTC-USDT')
    expect(connector.quote('htx:BTC-USDT')).toEqual(quote)
  })

  it('marks a cached quote stale once it ages past staleMs, without refetching', async () => {
    const { fake, t, connector } = make()
    await connector.refreshQuote('htx:BTC-USDT')
    t.now += 11_000
    const stale = connector.quote('htx:BTC-USDT')!
    expect(stale).toMatchObject({ stale: true, ageMs: 11_000, bid: 13082.9, ask: 13084.2 })
    expect(fake.callsTo(MERGED)).toHaveLength(1)
  })

  it('returns undefined when the venue sends no usable bid/ask', async () => {
    const { fake, connector } = make()
    fake.merged = { ...MERGED_EXAMPLE, bid: [0, 0], ask: [], ts: FX_NOW }
    await expect(connector.refreshQuote('htx:BTC-USDT')).resolves.toBeUndefined()
    expect(connector.quote('htx:BTC-USDT')).toBeUndefined()
  })

  it('refuses instrument ids that belong to another venue', async () => {
    const { fake, connector } = make()
    await expect(connector.refreshQuote('binance:BTCUSDT')).rejects.toMatchObject({ problem: { name: 'INVALID_PARAMS' } })
    expect(fake.calls).toHaveLength(0)
  })
})

describe('book', () => {
  it('parses depth into descending bids / ascending asks with contract sizes folded into coin', async () => {
    const { fake, connector } = make()
    fake.depth = {
      ts: FX_NOW,
      bids: [[100, 1000], [99.9, 2000], [99.8, 3000]],
      asks: [[100.2, 500], [100.1, 1500], [100.3, 2500]],
    }
    const book = await connector.book('htx:BTC-USDT', 2)

    expect(book.instrumentId).toBe('htx:BTC-USDT')
    expect(book.ts).toBe(FX_NOW)
    // 一张 = 0.001 BTC
    expect(book.bids).toEqual([{ price: 100, size: 1 }, { price: 99.9, size: 2 }])
    expect(book.asks).toEqual([{ price: 100.1, size: 1.5 }, { price: 100.2, size: 0.5 }])
    const call = fake.callsTo(DEPTH)[0]!
    expect(call.params.get('contract_code')).toBe('BTC-USDT')
    expect(call.params.get('type')).toBe('step6') // ≤20 档用不合并的 step6（官方 20 档）
  })

  it('asks for step0 (150 levels) when more than 20 levels are wanted', async () => {
    const { fake, connector } = make()
    await connector.book('htx:BTC-USDT', 50)
    expect(fake.callsTo(DEPTH)[0]!.params.get('type')).toBe('step0')
    await connector.book('htx:BTC-USDT')
    expect(fake.callsTo(DEPTH)[1]!.params.get('type')).toBe('step6') // 缺省 20
  })

  it('loads the contract catalogue first so contract_size is known', async () => {
    const { fake, connector } = make()
    await connector.book('htx:BTC-USDT', 1)
    expect(fake.callsTo('/linear-swap-api/v1/swap_contract_info')).toHaveLength(1)
    expect(fake.callsTo(DEPTH)).toHaveLength(1)
  })
})

describe('context', () => {
  it('carries mark price, funding rate, next funding time and the 8h interval', async () => {
    const { fake, connector } = make()
    const context = await connector.context('htx:BTC-USDT')

    expect(context).toMatchObject({
      instrumentId: 'htx:BTC-USDT', ts: FX_NOW, markPrice: 31078.68, fundingRate: 0.0001,
      nextFundingTime: 1_603_728_000_000, fundingIntervalMs: 28_800_000,
    })

    const mark = fake.callsTo(MARK)[0]!
    expect(mark.params.get('contract_code')).toBe('BTC-USDT')
    expect(mark.params.get('period')).toBe('1min')
    expect(mark.params.get('size')).toBe('1')
    expect(fake.callsTo(FUNDING)[0]!.params.get('contract_code')).toBe('BTC-USDT')
  })

  it('keeps markPrice at the protocol default 0 when the mark K-line is empty', async () => {
    const { fake, connector } = make()
    fake.markKline = []
    const context = await connector.context('htx:BTC-USDT')
    expect(context.markPrice).toBe(0)
    expect(context.fundingRate).toBe(0.0001)
  })
})
