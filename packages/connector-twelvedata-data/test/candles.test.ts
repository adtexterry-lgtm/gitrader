// SPDX-License-Identifier: CPAL-1.0
// K 线：values[{datetime,open,high,low,close,volume}] 解析、UTC 解释、缺省最新在前的排序、
// outputsize 钳位、start_date / end_date 时间窗分页、interval 映射与不支持的区间。
import { describe, expect, it } from 'vitest'
import type { CandleInterval } from '@gitrader/protocol'
import { TwelveDataDataConnector } from '../src/connector'
import { FakeTwelveData, FX_NOW, STEP_MS, tdMs, timeSeriesValues, vendorDateTime } from './helpers/fake-twelvedata'

function make(o: Record<string, unknown> = {}) {
  const fake = new FakeTwelveData()
  const connector = new TwelveDataDataConnector({
    baseUrl: 'https://twelvedata.example.test', fetchImpl: fake.fetch, clock: () => FX_NOW,
    env: { TWELVEDATA_API_KEY: 'test-twelvedata-key' }, ...o,
  })
  return { fake, connector }
}

const SERIES_PATH = '/time_series'

describe('candles', () => {
  it('parses values[] into protocol candles {t,o,h,l,c,v} and sorts newest-first input ascending', async () => {
    const { fake, connector } = make()
    const candles = await connector.candles('twelvedata:AAPL', '1m', { n: 5 })

    expect(candles).toHaveLength(5)
    expect(Object.keys(candles[0]!).sort()).toEqual(['c', 'h', 'l', 'o', 't', 'v'])
    for (let i = 1; i < candles.length; i++) expect(candles[i]!.t).toBeGreaterThan(candles[i - 1]!.t)
    expect(candles[4]!.t).toBe(FX_NOW)
    expect(candles[4]).toMatchObject({ o: 192, h: 193, l: 191, c: 192.5, v: 1004 })

    const call = fake.callsTo(SERIES_PATH)[0]!
    expect(call.params.get('symbol')).toBe('AAPL')
    expect(call.params.get('interval')).toBe('1min')
    expect(call.params.get('outputsize')).toBe('5')
    expect(call.params.get('timezone')).toBe('UTC')
    expect(call.params.get('start_date')).toBeNull()
  })

  it('interprets the vendor datetime strings as UTC (both intraday and date-only forms)', async () => {
    const fake = new FakeTwelveData()
    fake.timeSeries = {
      meta: { symbol: 'AAPL', interval: '1day', timezone: 'UTC' },
      status: 'ok',
      values: [
        { datetime: '2026-10-20', open: '1', high: '2', low: '0.5', close: '1.5', volume: '10' },
        { datetime: '2026-10-21', open: '1', high: '2', low: '0.5', close: '1.5', volume: '10' },
      ],
    }
    const connector = new TwelveDataDataConnector({
      baseUrl: 'https://twelvedata.example.test', fetchImpl: fake.fetch, clock: () => FX_NOW, env: { TWELVEDATA_API_KEY: 'test-twelvedata-key' },
    })
    const candles = await connector.candles('twelvedata:AAPL', '1d', { n: 2 })
    expect(candles.map((c) => c.t)).toEqual([Date.UTC(2026, 9, 20), Date.UTC(2026, 9, 21)])
  })

  it('clamps n to 1..5000 and forwards it as outputsize', async () => {
    const { fake, connector } = make()
    const candles = await connector.candles('twelvedata:AAPL', '1m', { n: 9999 })
    expect(fake.callsTo(SERIES_PATH)[0]!.params.get('outputsize')).toBe('5000')
    expect(candles).toHaveLength(5000)

    await connector.candles('twelvedata:AAPL', '1m')
    expect(fake.callsTo(SERIES_PATH)[1]!.params.get('outputsize')).toBe('300')
  })

  it('pages from `from` with 5000-bar UTC windows until it passes `to` (5000 + 1000 = 6000)', async () => {
    const { fake, connector } = make()
    const from = FX_NOW - 6000 * STEP_MS
    const to = from + 5999 * STEP_MS

    const candles = await connector.candles('twelvedata:AAPL', '1m', { from, to })

    expect(candles).toHaveLength(6000)
    expect(candles[0]!.t).toBe(from)
    expect(candles[5999]!.t).toBe(to)
    expect(new Set(candles.map((c) => c.t)).size).toBe(6000)

    const calls = fake.callsTo(SERIES_PATH)
    expect(calls).toHaveLength(2)
    expect(calls[0]!.params.get('start_date')).toBe(vendorDateTime(from))
    expect(calls[0]!.params.get('end_date')).toBe(vendorDateTime(from + 4999 * STEP_MS))
    expect(calls[0]!.params.get('outputsize')).toBe('5000')
    expect(calls[0]!.params.get('order')).toBe('asc')
    expect(calls[1]!.params.get('start_date')).toBe(vendorDateTime(from + 4999 * STEP_MS))
    expect(calls[1]!.params.get('end_date')).toBe(vendorDateTime(to))
  })

  it('stops at `to` without a second request when the first window already covers it', async () => {
    const { fake, connector } = make()
    const from = FX_NOW - 100 * STEP_MS
    const candles = await connector.candles('twelvedata:AAPL', '1m', { from, to: from + 9 * STEP_MS })
    expect(candles).toHaveLength(10)
    expect(fake.callsTo(SERIES_PATH)).toHaveLength(1)
  })

  it('returns nothing when `to` is before `from` and never calls HTTP', async () => {
    const { fake, connector } = make()
    await expect(connector.candles('twelvedata:AAPL', '1m', { from: FX_NOW, to: FX_NOW - 1 })).resolves.toEqual([])
    expect(fake.calls).toHaveLength(0)
  })

  it('maps every supported protocol interval onto the official interval spelling', async () => {
    const { fake, connector } = make()
    const expected: Array<[CandleInterval, string]> = [
      ['1m', '1min'], ['5m', '5min'], ['15m', '15min'], ['30m', '30min'],
      ['1h', '1h'], ['2h', '2h'], ['4h', '4h'], ['8h', '8h'], ['1d', '1day'], ['1w', '1week'], ['1M', '1month'],
    ]
    for (const [interval] of expected) await connector.candles('twelvedata:AAPL', interval, { n: 1 })
    expect(fake.callsTo(SERIES_PATH).map((c) => c.params.get('interval'))).toEqual(expected.map(([, v]) => v))
  })

  it('sends the official 8h interval for the protocol 8h interval', async () => {
    const { fake, connector } = make()
    await connector.candles('twelvedata:AAPL', '8h', { n: 2 })
    expect(fake.callsTo(SERIES_PATH)[0]!.params.get('interval')).toBe('8h')
  })

  it('rejects intervals the official table has no spelling for, without touching HTTP', async () => {
    const { fake, connector } = make()
    for (const interval of ['3m', '12h', '3d'] as CandleInterval[]) {
      await expect(connector.candles('twelvedata:AAPL', interval)).rejects.toMatchObject({
        problem: { name: 'INVALID_PARAMS', retryable: false },
      })
    }
    expect(fake.calls).toHaveLength(0)
  })

  it('keeps paging past an empty window when there is no `to` and returns the later rows', async () => {
    const { fake, connector } = make()
    const from = FX_NOW - 20_000 * STEP_MS
    const later = from + 6000 * STEP_MS
    fake.timeSeries = (params: URLSearchParams) => {
      const start = tdMs(params.get('start_date'))
      if (start === from) return { meta: {}, status: 'ok', values: [] }
      return { meta: {}, status: 'ok', values: timeSeriesValues(later - STEP_MS, 2, STEP_MS) }
    }

    const candles = await connector.candles('twelvedata:AAPL', '1m', { from })

    expect(candles.map((c) => c.t)).toEqual([later - STEP_MS, later])
    expect(fake.callsTo(SERIES_PATH).length).toBeGreaterThan(1)
  })

  it('keeps the boundary candle when `from` is off the interval grid (no gap, no duplicate)', async () => {
    const { fake, connector } = make()
    const grid = Math.floor((FX_NOW - 20_000 * STEP_MS) / STEP_MS) * STEP_MS
    const from = grid + 30_000
    const to = from + 5100 * STEP_MS
    fake.timeSeries = (params: URLSearchParams) => {
      const start = tdMs(params.get('start_date'))
      const end = tdMs(params.get('end_date'))
      const values: Array<Record<string, unknown>> = []
      for (let t = Math.ceil(start / STEP_MS) * STEP_MS; t <= end; t += STEP_MS) {
        values.push({ datetime: vendorDateTime(t), open: '1', high: '2', low: '0.5', close: '1.5', volume: '10' })
      }
      return { meta: {}, status: 'ok', values }
    }

    const candles = await connector.candles('twelvedata:AAPL', '1m', { from, to })
    const times = candles.map((c) => c.t)

    expect(fake.callsTo(SERIES_PATH)).toHaveLength(2)
    expect(times).toHaveLength(5100)
    expect(times[0]).toBe(grid + STEP_MS)
    expect(times[times.length - 1]).toBe(grid + 5100 * STEP_MS)
    expect(new Set(times).size).toBe(times.length)
    expect(times).toContain(grid + 5000 * STEP_MS)
  })

  it('skips rows missing any OHLCV field instead of filling zeros', async () => {
    const fake = new FakeTwelveData()
    const rows = timeSeriesValues(FX_NOW - 2 * STEP_MS, 3)
    fake.timeSeries = { meta: {}, status: 'ok', values: [...rows.slice(0, 1), { datetime: vendorDateTime(FX_NOW), open: '1', high: '2', low: '1', close: '2' }] }
    const connector = new TwelveDataDataConnector({
      baseUrl: 'https://twelvedata.example.test', fetchImpl: fake.fetch, clock: () => FX_NOW, env: { TWELVEDATA_API_KEY: 'test-twelvedata-key' },
    })
    const candles = await connector.candles('twelvedata:AAPL', '1m', { n: 3 })
    expect(candles).toHaveLength(1)
  })
})
