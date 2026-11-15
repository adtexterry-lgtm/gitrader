// SPDX-License-Identifier: CPAL-1.0
// K 线：14 个协议周期 → multiplier / timespan、路径里的 from / to 用毫秒、sort=asc&limit=50000、
// 无 from 的回看窗口、按最后一根推进的分页、区间过滤、坏行跳过、升序去重。
import { describe, expect, it } from 'vitest'
import { PolygonDataConnector } from '../src/connector'
import { API_KEY, FX_NOW, FakePolygon, HOST, aggRow, aggSeries, json } from './helpers/fake-polygon'

const ID = 'polygon:AAPL'
const AGG_PREFIX = '/v2/aggs/ticker/AAPL/range'

function make(o: Record<string, unknown> = {}): { fake: FakePolygon; connector: PolygonDataConnector } {
  const fake = new FakePolygon()
  const connector = new PolygonDataConnector({
    apiKey: API_KEY,
    baseUrl: `http://${HOST}`,
    fetchImpl: fake.fetch,
    clock: () => FX_NOW,
    ...o,
  })
  return { fake, connector }
}

/** 从路径里拆出 multiplier / timespan / from / to。 */
function aggPathOf(path: string): { multiplier: string; timespan: string; from: number; to: number } {
  const m = new RegExp(`^${AGG_PREFIX}/(\\d+)/([a-z]+)/(\\d+)/(\\d+)$`).exec(path)
  if (!m) throw new Error(`unexpected aggregates path: ${path}`)
  return { multiplier: m[1]!, timespan: m[2]!, from: Number(m[3]), to: Number(m[4]) }
}

describe('candles', () => {
  it('requests the documented aggregates path with sort=asc, adjusted and the 50000 limit', async () => {
    const { fake, connector } = make()
    const candles = await connector.candles(ID, '1m')

    const call = fake.callsTo(AGG_PREFIX)[0]!
    expect(call.params.get('sort')).toBe('asc')
    expect(call.params.get('adjusted')).toBe('true')
    expect(call.params.get('limit')).toBe('50000')
    expect(call.headers.authorization).toBe(`Bearer ${API_KEY}`)
    expect(aggPathOf(call.path)).toMatchObject({ multiplier: '1', timespan: 'minute' })

    expect(candles.map((c) => c.t)).toEqual([
      Date.parse('2026-10-21T13:30:00Z'), Date.parse('2026-10-21T13:31:00Z'), Date.parse('2026-10-21T13:32:00Z'),
    ])
    expect(candles[0]).toEqual({ t: Date.parse('2026-10-21T13:30:00Z'), o: 202, h: 203.5, l: 200.5, c: 202.5, v: 12_345, vwap: 202.25 })
  })

  it('maps all 14 protocol intervals onto multiplier / timespan', async () => {
    const { fake, connector } = make()
    const intervals = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '8h', '12h', '1d', '3d', '1w', '1M'] as const
    for (const interval of intervals) await connector.candles(ID, interval)

    const specs = fake.callsTo(AGG_PREFIX).map((c) => {
      const p = aggPathOf(c.path)
      return `${p.multiplier}${p.timespan}`
    })
    expect(specs).toEqual([
      '1minute', '3minute', '5minute', '15minute', '30minute', '1hour', '2hour', '4hour', '8hour', '12hour',
      '1day', '3day', '1week', '1month',
    ])
  })

  it('passes the requested window as millisecond epoch bounds', async () => {
    const { fake, connector } = make()
    const from = Date.parse('2026-09-01T13:30:00Z')
    const to = Date.parse('2026-09-02T20:00:00Z')
    await connector.candles(ID, '5m', { from, to })

    const p = aggPathOf(fake.callsTo(AGG_PREFIX)[0]!.path)
    expect(p.from).toBe(from)
    expect(p.to).toBe(to)
  })

  it('looks back roughly n × bar × 4 + 7 days when no from is given, then keeps the tail n bars', async () => {
    const { fake, connector } = make()
    await connector.candles(ID, '1d', { n: 10 })
    const p = aggPathOf(fake.callsTo(AGG_PREFIX)[0]!.path)
    const expectedLookback = 10 * 86_400_000 * 4 + 7 * 86_400_000
    expect(p.to).toBe(FX_NOW)
    expect(p.to - p.from).toBe(expectedLookback)

    const tail = await connector.candles(ID, '1m', { n: 2 })
    expect(tail.map((c) => c.t)).toEqual([Date.parse('2026-10-21T13:31:00Z'), Date.parse('2026-10-21T13:32:00Z')])
  })

  it('uses n × 1h × 4 + 7 days as the window for intraday intervals', async () => {
    const { fake, connector } = make()
    await connector.candles(ID, '1h', { n: 300 })
    const p = aggPathOf(fake.callsTo(AGG_PREFIX)[0]!.path)
    expect(p.to).toBe(FX_NOW)
    expect(p.from).toBe(FX_NOW - (300 * 3_600_000 * 4 + 7 * 86_400_000))
  })

  it('pages by advancing from to the last bar + 1 ms while the page is full', async () => {
    const { fake, connector } = make()
    const page = aggSeries('2026-10-21T13:30:00Z', 50_000, 1)
    const lastOfPage = page[page.length - 1]!.t as number
    const tail = [aggRow(new Date(lastOfPage + 1).toISOString(), 300), aggRow(new Date(lastOfPage + 2).toISOString(), 301)]
    fake.override.set(AGG_PREFIX, () => {
      // 第一次给满一页（50000 根），第二次给两根收尾
      const already = fake.callsTo(AGG_PREFIX).length
      return json({
        status: 'OK',
        resultsCount: already === 1 ? page.length : tail.length,
        results: already === 1 ? page : tail,
      })
    })

    const from = Date.parse('2026-10-21T13:30:00Z')
    const candles = await connector.candles(ID, '1m', { from, to: FX_NOW })
    const calls = fake.callsTo(AGG_PREFIX)
    expect(calls).toHaveLength(2)
    expect(aggPathOf(calls[1]!.path).from).toBe(lastOfPage + 1)
    expect(candles).toHaveLength(50_002)
    expect(candles[candles.length - 1]!.t).toBe(lastOfPage + 2)
  })

  it('stops paging when the page is empty', async () => {
    const { fake, connector } = make()
    fake.override.set(AGG_PREFIX, () => json({ status: 'OK', resultsCount: 0, results: [] }))
    expect(await connector.candles(ID, '1m', { from: FX_NOW - 60_000 })).toEqual([])
    expect(fake.callsTo(AGG_PREFIX)).toHaveLength(1)
  })

  it('returns an empty list when to < from, without any request', async () => {
    const { fake, connector } = make()
    expect(await connector.candles(ID, '1d', { from: FX_NOW, to: FX_NOW - 1 })).toEqual([])
    expect(fake.calls).toHaveLength(0)
  })

  it('filters out bars outside the requested window and dedupes repeated timestamps', async () => {
    const { fake, connector } = make()
    fake.override.set(AGG_PREFIX, () => json({
      status: 'OK',
      results: [
        aggRow('2026-10-21T13:30:00Z', 202),
        aggRow('2026-10-21T13:31:00Z', 203),
        aggRow('2026-10-21T13:31:00Z', 204), // 同一根（翻页边界）后到的覆盖先到的
        aggRow('2026-10-21T15:00:00Z', 205), // 窗口外
      ],
    }))
    const from = Date.parse('2026-10-21T13:30:00Z')
    const to = Date.parse('2026-10-21T13:45:00Z')
    const candles = await connector.candles(ID, '1m', { from, to })
    expect(candles.map((c) => c.c)).toEqual([202.5, 204.5])
  })

  it('drops malformed rows instead of inventing zeros', async () => {
    const { fake, connector } = make()
    fake.override.set(AGG_PREFIX, () => json({
      status: 'OK',
      results: [
        aggRow('2026-10-21T13:30:00Z', 202),
        { o: 1, h: 2, l: 0.5, c: 1.5, v: 10, t: 0 },
        { o: 'x', h: 2, l: 0.5, c: 1.5, v: 10, t: Date.parse('2026-10-21T13:31:00Z') },
        null,
      ],
    }))
    const candles = await connector.candles(ID, '1m')
    expect(candles).toHaveLength(1)
  })

  it('clamps the recent count to 1..50000 and rejects a foreign instrument id before any request', async () => {
    const { fake, connector } = make()
    await connector.candles(ID, '1m', { n: 0 })
    await connector.candles(ID, '1m', { n: 9_999_999 })
    const windows = fake.callsTo(AGG_PREFIX).map((c) => {
      const p = aggPathOf(c.path)
      return p.to - p.from
    })
    expect(windows[0]).toBe(1 * 60_000 * 4 + 7 * 86_400_000)
    expect(windows[1]).toBe(50_000 * 60_000 * 4 + 7 * 86_400_000)

    await expect(connector.candles('alphavantage:AAPL', '1m')).rejects.toThrow(/not a polygon instrument id/)
  })
})
