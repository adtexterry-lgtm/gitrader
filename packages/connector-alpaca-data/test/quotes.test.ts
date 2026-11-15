// SPDX-License-Identifier: CPAL-1.0
// 报价：快照（/v2/stocks/{symbol}/snapshot）→ StampedQuote；book 只有最优一档（Alpaca 股票无 L2）；
// context 用最新成交价 / 中价代理标记价，资金费字段一律缺省。
import { describe, expect, it } from 'vitest'
import { AlpacaDataConnector } from '../src/connector'
import { ProblemError } from '../src/parse'
import { DATA_HOST, FX_NOW, FakeAlpaca, TRADING_HOST } from './helpers/fake-alpaca'

const ID = 'alpaca:AAPL'
const SNAPSHOT_PATH = '/v2/stocks/AAPL/snapshot'

function make(o: Record<string, unknown> = {}): {
  fake: FakeAlpaca
  connector: AlpacaDataConnector
  advance: (ms: number) => void
} {
  const fake = new FakeAlpaca()
  let now = FX_NOW
  const connector = new AlpacaDataConnector({
    tradingBaseUrl: `http://${TRADING_HOST}`,
    dataBaseUrl: `http://${DATA_HOST}`,
    fetchImpl: fake.fetch,
    clock: () => now,
    ...o,
  })
  return { fake, connector, advance: (ms: number) => { now += ms } }
}

describe('quotes', () => {
  it('has no quote before the first refresh (quote() never goes to the network)', () => {
    const { fake, connector } = make()
    expect(connector.quote(ID)).toBeUndefined()
    expect(fake.calls).toHaveLength(0)
  })

  it('maps the snapshot NBBO + last trade onto StampedQuote with the venue timestamp', async () => {
    const { fake, connector } = make()
    const quote = await connector.refreshQuote(ID)

    expect(quote).toEqual({
      instrumentId: ID,
      ts: Date.parse('2026-10-21T13:59:58.123Z'),
      bid: 202.5,
      ask: 202.55,
      last: 202.52,
      stale: false,
      ageMs: FX_NOW - Date.parse('2026-10-21T13:59:58.123Z'),
    })
    expect(fake.callsTo(DATA_HOST, SNAPSHOT_PATH)[0]!.params.get('feed')).toBe('iex')
    // 缓存后再读不联网
    const cached = connector.quote(ID)!
    expect(cached).toEqual(quote)
    expect(fake.calls).toHaveLength(1)
  })

  it('marks a quote stale once it is older than staleMs', async () => {
    const { connector, advance } = make()
    await connector.refreshQuote(ID)
    expect(connector.quote(ID)!.stale).toBe(false)
    advance(60_000)
    const stale = connector.quote(ID)!
    expect(stale).toMatchObject({ stale: true, ageMs: 61_877 })
  })

  it('drops the cache when the venue returns no usable bid/ask', async () => {
    const { fake, connector } = make()
    await connector.refreshQuote(ID)
    fake.snapshot = { latestQuote: { t: '2026-10-21T13:59:58Z', bp: 0, ap: null }, latestTrade: { t: '2026-10-21T13:59:59Z', p: 202 } }
    expect(await connector.refreshQuote(ID)).toBeUndefined()
    expect(connector.quote(ID)).toBeUndefined()
  })

  it('returns a one-level top-of-book and ignores the requested depth', async () => {
    const { connector } = make()
    const book = await connector.book(ID, 50)
    expect(book.instrumentId).toBe(ID)
    expect(book.bids).toEqual([{ price: 202.5, size: 200 }])
    expect(book.asks).toEqual([{ price: 202.55, size: 300 }])
    expect(book.ts).toBe(Date.parse('2026-10-21T13:59:58.123Z'))
  })

  it('does not invent a level when the venue gives no size on that side', async () => {
    const { fake, connector } = make()
    fake.snapshot = { latestQuote: { t: '2026-10-21T13:59:58Z', bp: 202.5, ap: 202.55 }, latestTrade: { t: '2026-10-21T13:59:59Z', p: 202.52 } }
    const book = await connector.book(ID)
    expect(book).toMatchObject({ bids: [], asks: [] })
  })

  it('fails loudly when there is no quote to build a book from', async () => {
    const { fake, connector } = make()
    fake.snapshot = { latestQuote: {} }
    await expect(connector.book(ID)).rejects.toThrow(/no top-of-book quote/)
  })

  it('builds context from the last trade (falling back to the mid) and the previous close', async () => {
    const { connector } = make()
    const ctx = await connector.context(ID)
    expect(ctx).toMatchObject({
      instrumentId: ID, ts: FX_NOW, markPrice: 202.52, midPrice: 202.525, prevDayPrice: 201.05,
    })
    expect(ctx.fundingRate).toBeUndefined()
    expect(ctx.fundingIntervalMs).toBeUndefined()

    const noLast = make()
    noLast.fake.snapshot = {
      latestQuote: { t: '2026-10-21T13:59:58Z', bp: 100, ap: 101 },
      prevDailyBar: { c: 99.5 },
    }
    const ctx2 = await noLast.connector.context(ID)
    expect(ctx2).toMatchObject({ markPrice: 100.5, midPrice: 100.5, prevDayPrice: 99.5 })
  })

  it('rejects context when the venue cannot give any usable quote', async () => {
    const { fake, connector } = make()
    fake.snapshot = { latestQuote: { bp: null, ap: null } }
    try {
      await connector.context(ID)
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(ProblemError)
      expect((e as ProblemError).problem).toMatchObject({ name: 'VENUE_UNAVAILABLE', retryable: true })
    }
  })
})
