// SPDX-License-Identifier: CPAL-1.0
// K 线：盘中 / 日 / 周 / 月四条时间序列、美东挂钟 → UTC 毫秒（手算期望值）、compact / full 档切换、
// 按月切片翻页、区间过滤、升序去重、坏行跳过、未知周期直接 INVALID_PARAMS 且不发请求。
import { describe, expect, it } from 'vitest'
import { AlphaVantageDataConnector } from '../src/connector'
import { API_KEY, FX_NOW, FakeAlphaVantage, HOST, respond, seriesRow } from './helpers/fake-alphavantage'

const ID = 'alphavantage:AAPL'

function make(o: Record<string, unknown> = {}): { fake: FakeAlphaVantage; connector: AlphaVantageDataConnector } {
  const fake = new FakeAlphaVantage()
  const connector = new AlphaVantageDataConnector({
    apiKey: API_KEY,
    baseUrl: `http://${HOST}`,
    fetchImpl: fake.fetch,
    clock: () => FX_NOW,
    ...o,
  })
  return { fake, connector }
}

describe('candles', () => {
  it('asks for the intraday series with the documented interval and a compact page by default', async () => {
    const { fake, connector } = make()
    const candles = await connector.candles(ID, '5m')

    const call = fake.callsOf('TIME_SERIES_INTRADAY')[0]!
    expect(call.params.get('symbol')).toBe('AAPL')
    expect(call.params.get('interval')).toBe('5min')
    expect(call.params.get('outputsize')).toBe('compact')
    expect(call.params.get('datatype')).toBe('json')
    expect(call.params.get('apikey')).toBe(API_KEY)

    // 美东 09:35 / 09:40（EDT = UTC−4）→ 13:35Z / 13:40Z；成交量取字符串数值
    expect(candles.map((c) => c.t)).toEqual([
      Date.parse('2026-10-21T13:35:00Z'),
      Date.parse('2026-10-21T13:40:00Z'),
    ])
    expect(candles[0]).toEqual({ t: Date.parse('2026-10-21T13:35:00Z'), o: 202, h: 203.5, l: 200.5, c: 202.5, v: 12_345 })
  })

  it('switches to the full output size when more than one compact page is asked for', async () => {
    const { fake, connector } = make()
    await connector.candles(ID, '5m', { n: 100 })
    await connector.candles(ID, '5m', { n: 101 })

    expect(fake.callsOf('TIME_SERIES_INTRADAY').map((c) => c.params.get('outputsize'))).toEqual(['compact', 'full'])
  })

  it('maps day / week / month onto their own functions and keys', async () => {
    const { fake, connector } = make()
    const daily = await connector.candles(ID, '1d')
    const weekly = await connector.candles(ID, '1w')
    const monthly = await connector.candles(ID, '1M')

    expect(fake.callsOf('TIME_SERIES_DAILY')).toHaveLength(1)
    expect(fake.callsOf('TIME_SERIES_WEEKLY')).toHaveLength(1)
    expect(fake.callsOf('TIME_SERIES_MONTHLY')).toHaveLength(1)
    // 日线取交易日期美东 00:00（EDT = UTC−4）；周线取该周周一 2026-10-12；月线取该月 1 日 2026-09-01
    expect(daily.map((c) => c.t)).toEqual([
      Date.parse('2026-10-19T04:00:00Z'), Date.parse('2026-10-20T04:00:00Z'),
    ])
    expect(weekly[0]!.t).toBe(Date.parse('2026-10-12T04:00:00Z'))
    expect(monthly[0]!.t).toBe(Date.parse('2026-09-01T04:00:00Z'))
    expect(daily[1]).toEqual({ t: Date.parse('2026-10-20T04:00:00Z'), o: 202, h: 203.5, l: 200.5, c: 202.5, v: 12_345 })
  })

  it('sends outputsize only for the daily and intraday series (weekly / monthly have no such parameter)', async () => {
    const { fake, connector } = make()
    await connector.candles(ID, '1d')
    await connector.candles(ID, '1d', { from: Date.parse('2026-01-01T00:00:00Z') })
    await connector.candles(ID, '1w')
    await connector.candles(ID, '1M')
    await connector.candles(ID, '1w', { from: Date.parse('2026-01-01T00:00:00Z') })
    await connector.candles(ID, '1M', { from: Date.parse('2026-01-01T00:00:00Z') })

    expect(fake.callsOf('TIME_SERIES_DAILY').map((c) => c.params.has('outputsize'))).toEqual([true, true])
    for (const fn of ['TIME_SERIES_WEEKLY', 'TIME_SERIES_MONTHLY']) {
      expect(fake.callsOf(fn)).toHaveLength(2)
      expect(fake.callsOf(fn).every((c) => !c.params.has('outputsize'))).toBe(true)
    }
  })

  it('uses the month start as the open time for a monthly candle in EST', async () => {
    const { fake, connector } = make()
    fake.override.set('TIME_SERIES_MONTHLY', () => ({
      'Monthly Time Series': { '2026-01-30': seriesRow(190) },
    }))
    const monthly = await connector.candles(ID, '1M')
    expect(monthly.map((c) => c.t)).toEqual([Date.parse('2026-01-01T05:00:00Z')])
  })

  it('converts the same wall clock differently across the DST switch (EST = UTC−5)', async () => {
    const { fake, connector } = make()
    fake.override.set('TIME_SERIES_INTRADAY', () => ({
      'Meta Data': { '6. Time Zone': 'US/Eastern' },
      'Time Series (60min)': {
        '2026-12-15 09:30:00': seriesRow(205),
        '2026-11-03 09:30:00': seriesRow(204),
      },
    }))
    const candles = await connector.candles(ID, '1h')
    expect(candles.map((c) => new Date(c.t).toISOString())).toEqual([
      '2026-11-03T14:30:00.000Z', // 秋季切换之后（EST）
      '2026-12-15T14:30:00.000Z', // EST
    ])
  })

  it('pages an intraday range month by month and filters the window locally', async () => {
    const { fake, connector } = make()
    const from = Date.parse('2026-08-10T13:30:00Z')
    const to = Date.parse('2026-10-21T20:00:00Z')
    const candles = await connector.candles(ID, '5m', { from, to })

    const months = fake.callsOf('TIME_SERIES_INTRADAY').map((c) => c.params.get('month'))
    expect(months).toEqual(['2026-08', '2026-09', '2026-10'])
    expect(fake.callsOf('TIME_SERIES_INTRADAY').every((c) => c.params.get('outputsize') === 'full')).toBe(true)
    // 假服务器每个月给该月 10 日的两根（09:35 / 09:40 美东，EDT → 13:35Z / 13:40Z），窗口覆盖三个月 → 六根升序
    expect(candles.map((c) => new Date(c.t).toISOString())).toEqual([
      '2026-08-10T13:35:00.000Z', '2026-08-10T13:40:00.000Z',
      '2026-09-10T13:35:00.000Z', '2026-09-10T13:40:00.000Z',
      '2026-10-10T13:35:00.000Z', '2026-10-10T13:40:00.000Z',
    ])
  })

  it('stops at the last month of the range instead of walking to the current month', async () => {
    const { fake, connector } = make()
    await connector.candles(ID, '1h', {
      from: Date.parse('2026-08-10T13:30:00Z'),
      to: Date.parse('2026-08-11T20:00:00Z'),
    })
    expect(fake.callsOf('TIME_SERIES_INTRADAY').map((c) => c.params.get('month'))).toEqual(['2026-08'])
  })

  it('returns an empty list when to < from, without any request', async () => {
    const { fake, connector } = make()
    const candles = await connector.candles(ID, '1d', { from: FX_NOW, to: FX_NOW - 1 })
    expect(candles).toEqual([])
    expect(fake.calls).toHaveLength(0)
  })

  it('drops malformed rows instead of inventing zeros', async () => {
    const { fake, connector } = make()
    fake.override.set('TIME_SERIES_DAILY', () => ({
      'Time Series (Daily)': {
        '2026-10-20': seriesRow(202),
        '2026-10-19': { '1. open': '', '2. high': 'x', '3. low': '1', '4. close': '1', '5. volume': '1' },
        '2026-10-18': { ...seriesRow(200), '5. volume': 'n/a' },
        'not-a-date': seriesRow(199),
      },
    }))
    const candles = await connector.candles(ID, '1d')
    expect(candles).toHaveLength(1)
    expect(candles[0]!.t).toBe(Date.parse('2026-10-20T04:00:00Z'))
  })

  it('sorts ascending and dedupes even when the upstream answers descending', async () => {
    const { fake, connector } = make()
    fake.override.set('TIME_SERIES_DAILY', () => ({
      'Time Series (Daily)': {
        '2026-10-20': seriesRow(202),
        '2026-10-19': seriesRow(200),
        '2026-10-20 ': seriesRow(202),
      },
    }))
    const candles = await connector.candles(ID, '1d')
    expect(candles.map((c) => c.c)).toEqual([200.5, 202.5])
  })

  it('clamps the recent count to 1..20000 (default 100) and slices the tail', async () => {
    const { fake, connector } = make()
    const tail = await connector.candles(ID, '5m', { n: 1 })
    expect(tail).toHaveLength(1)
    expect(tail[0]!.t).toBe(Date.parse('2026-10-21T13:40:00Z'))

    await connector.candles(ID, '5m', { n: 0 })
    await connector.candles(ID, '5m', { n: 999_999 })
    const limits = fake.callsOf('TIME_SERIES_INTRADAY').map((c) => c.params.get('outputsize'))
    expect(limits).toEqual(['compact', 'compact', 'full'])
  })

  it('rejects an interval Alpha Vantage has no series for, without touching the network', async () => {
    const { fake, connector } = make()
    for (const interval of ['3m', '2h', '4h', '8h', '12h', '3d'] as const) {
      await expect(connector.candles(ID, interval, { n: 5 })).rejects.toThrow(/unsupported candle interval for alphavantage/)
    }
    expect(fake.calls).toHaveLength(0)
  })

  it('rejects a foreign instrument id before any request', async () => {
    const { fake, connector } = make()
    await expect(connector.candles('polygon:AAPL', '1d')).rejects.toThrow(/not a alphavantage instrument id/)
    expect(fake.calls).toHaveLength(0)
  })

  it('surfaces an empty series as an empty list, not an error', async () => {
    const { fake, connector } = make()
    fake.override.set('TIME_SERIES_DAILY', () => respond({ 'Meta Data': {} }))
    expect(await connector.candles(ID, '1d')).toEqual([])
  })
})
