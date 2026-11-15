// SPDX-License-Identifier: CPAL-1.0
// K 线：data API v2 stocks bars（缺省免费 IEX 源，源可配）、timeframe 映射、next_page_token 翻页、
// 区间过滤、升序去重、坏行跳过、未知周期直接 INVALID_PARAMS 且不发请求。
import { describe, expect, it } from 'vitest'
import { AlpacaDataConnector } from '../src/connector'
import { ProblemError } from '../src/parse'
import { DATA_HOST, FX_NOW, FakeAlpaca, TRADING_HOST, barRow, barSeries } from './helpers/fake-alpaca'

const ID = 'alpaca:AAPL'
const BARS_PATH = '/v2/stocks/AAPL/bars'

function make(o: Record<string, unknown> = {}): { fake: FakeAlpaca; connector: AlpacaDataConnector } {
  const fake = new FakeAlpaca()
  const connector = new AlpacaDataConnector({
    tradingBaseUrl: `http://${TRADING_HOST}`,
    dataBaseUrl: `http://${DATA_HOST}`,
    fetchImpl: fake.fetch,
    clock: () => FX_NOW,
    ...o,
  })
  return { fake, connector }
}

describe('candles', () => {
  it('defaults to the free IEX feed and asks for the most recent page in descending order', async () => {
    const { fake, connector } = make()
    const candles = await connector.candles(ID, '1m', { n: 300 })

    const call = fake.callsTo(DATA_HOST, BARS_PATH)[0]!
    expect(call.params.get('timeframe')).toBe('1Min')
    expect(call.params.get('feed')).toBe('iex')
    expect(call.params.get('limit')).toBe('300')
    expect(call.params.get('adjustment')).toBe('raw')
    expect(call.params.get('sort')).toBe('desc')
    // 夹具按 sort=desc 倒序返回，本地翻成升序
    expect(candles.map((c) => c.t)).toEqual([
      Date.parse('2026-10-21T13:30:00Z'), Date.parse('2026-10-21T13:31:00Z'), Date.parse('2026-10-21T13:32:00Z'),
      Date.parse('2026-10-21T13:33:00Z'), Date.parse('2026-10-21T13:34:00Z'),
    ])
    expect(candles[0]).toEqual({
      t: Date.parse('2026-10-21T13:30:00Z'), o: 200, h: 201.5, l: 198.5, c: 200.5, v: 12_345, vwap: 200.25,
    })
  })

  it('switches to the configured SIP feed on both bars and snapshot requests', async () => {
    const { fake, connector } = make({ feed: 'sip', environment: 'live', keyId: 'AKFAKE', secretKey: 's' })
    await connector.candles(ID, '1m', { n: 5 })
    await connector.refreshQuote(ID)

    expect(fake.callsTo(DATA_HOST, BARS_PATH)[0]!.params.get('feed')).toBe('sip')
    expect(fake.callsTo(DATA_HOST, '/v2/stocks/AAPL/snapshot')[0]!.params.get('feed')).toBe('sip')
    expect(fake.callsTo(DATA_HOST, BARS_PATH)[0]!.headers['apca-api-key-id']).toBe('AKFAKE')
  })

  it('maps protocol intervals onto Alpaca timeframes', async () => {
    const { fake, connector } = make()
    await connector.candles(ID, '1h', { n: 5 })
    await connector.candles(ID, '4h', { n: 5 })
    await connector.candles(ID, '1d', { n: 5 })
    await connector.candles(ID, '1w', { n: 5 })
    await connector.candles(ID, '1M', { n: 5 })

    expect(fake.callsTo(DATA_HOST, BARS_PATH).map((c) => c.params.get('timeframe')))
      .toEqual(['1Hour', '4Hour', '1Day', '1Week', '1Month'])
  })

  it('rejects an interval Alpaca has no timeframe for, without touching the network', async () => {
    const { fake, connector } = make()
    await expect(connector.candles(ID, '3d', { n: 10 })).rejects.toThrow(/unsupported candle interval/)
    expect(fake.calls).toHaveLength(0)
  })

  it('clamps the recent count to 1..10000 (default 300)', async () => {
    const { fake, connector } = make()
    await connector.candles(ID, '1m', { n: 99_999 })
    await connector.candles(ID, '1m')
    await connector.candles(ID, '1m', { n: 0 })
    const limits = fake.callsTo(DATA_HOST, BARS_PATH).map((c) => c.params.get('limit'))
    expect(limits).toEqual(['10000', '300', '1'])
  })

  it('returns only the last n bars when the venue ignores sort=desc', async () => {
    const { fake, connector } = make()
    fake.bars = barSeries('2026-10-21T13:30:00Z', 6)
    const candles = await connector.candles(ID, '1m', { n: 2 })
    expect(candles.map((c) => c.t)).toEqual([
      Date.parse('2026-10-21T13:34:00Z'), Date.parse('2026-10-21T13:35:00Z'),
    ])
  })

  it('pages through next_page_token, filters to [from, to] and de-duplicates boundary bars', async () => {
    const { fake, connector } = make()
    const page1 = barSeries('2026-10-21T13:30:00Z', 3)
    const page2 = [barRow('2026-10-21T13:32:00Z', 300), ...barSeries('2026-10-21T13:33:00Z', 2)]
    fake.bars = (params: URLSearchParams) => (
      params.get('page_token') === 'p2'
        ? { bars: page2, symbol: 'AAPL', next_page_token: null }
        : { bars: page1, symbol: 'AAPL', next_page_token: 'p2' }
    )

    const from = Date.parse('2026-10-21T13:30:00Z')
    const to = Date.parse('2026-10-21T13:34:00Z')
    const candles = await connector.candles(ID, '1m', { from, to })

    expect(candles.map((c) => c.t)).toEqual([
      Date.parse('2026-10-21T13:30:00Z'), Date.parse('2026-10-21T13:31:00Z'), Date.parse('2026-10-21T13:32:00Z'),
      Date.parse('2026-10-21T13:33:00Z'), Date.parse('2026-10-21T13:34:00Z'),
    ])
    // 页边界重复的 13:32 只保留最后一次解析结果（page2 的 price 300）
    expect(candles[2]!.o).toBe(300)
    const calls = fake.callsTo(DATA_HOST, BARS_PATH)
    expect(calls).toHaveLength(2)
    expect(calls[0]!.params.get('start')).toBe('2026-10-21T13:30:00.000Z')
    expect(calls[0]!.params.get('end')).toBe('2026-10-21T13:34:00.000Z')
    expect(calls[0]!.params.get('limit')).toBe('10000')
    expect(calls[0]!.params.get('page_token')).toBeNull()
    expect(calls[1]!.params.get('page_token')).toBe('p2')
  })

  it('returns an empty list without a request when to is before from', async () => {
    const { fake, connector } = make()
    const candles = await connector.candles(ID, '1m', { from: FX_NOW, to: FX_NOW - 60_000 })
    expect(candles).toEqual([])
    expect(fake.calls).toHaveLength(0)
  })

  it('skips malformed bars instead of emitting NaN candles', async () => {
    const { fake, connector } = make()
    fake.bars = [
      { t: 'nonsense', o: 1, h: 1, l: 1, c: 1, v: 1 },
      { t: '2026-10-21T13:30:00Z', o: 1, h: 2, l: 0.5, c: 1.5, v: 10 },
      { t: '2026-10-21T13:31:00Z', o: 1, h: 2, l: 0.5, c: 'x', v: 10 },
    ]
    const candles = await connector.candles(ID, '1m', { n: 10 })
    expect(candles).toHaveLength(1)
    expect(candles[0]!.c).toBe(1.5)
    expect(candles[0]!.vwap).toBeUndefined()
  })

  it('rejects instrument ids from another venue', async () => {
    const { fake, connector } = make()
    try {
      await connector.candles('nasdaq:AAPL', '1m', { n: 5 })
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(ProblemError)
      expect((e as ProblemError).problem.name).toBe('INVALID_PARAMS')
    }
    expect(fake.calls).toHaveLength(0)
  })
})
