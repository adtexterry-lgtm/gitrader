// SPDX-License-Identifier: CPAL-1.0
// K 线：真网行形状（[毫秒, o,h,l,c, 张, 成交额]）、升序去重、n 钳到 200、granularity 分钟映射、
// from 游标每页 200 根翻页、to 边界含端点、3m / 3d / 1M 直接拒绝。
import { describe, expect, it } from 'vitest'
import type { CandleInterval } from '@gitrader/protocol'
import { KucoinDataConnector } from '../src/connector'
import { FakeKucoin, FX_NOW, MARK_TS, STEP_MS, candleRows } from './helpers/fake-kucoin'

function make() {
  const fake = new FakeKucoin()
  const connector = new KucoinDataConnector({ baseUrl: 'http://kucoin.example.test', fetchImpl: fake.fetch, clock: () => FX_NOW })
  return { fake, connector }
}

/** 真网 /kline/query?granularity=1 截短 5 根（2026-10-20）。 */
const REAL_1M_ROWS: unknown[][] = [
  [1_792_509_000_000, 82_990.0, 82_995.5, 82_966.1, 82_989.2, 3_747, 310_917.6612],
  [1_792_509_060_000, 82_976.8, 82_976.8, 82_930.8, 82_930.8, 3_288, 272_705.2048],
  [1_792_509_120_000, 82_934.8, 82_944.5, 82_560.9, 82_560.9, 16_957, 1_402_518.6213],
  [1_792_509_180_000, 82_560.9, 82_571.2, 82_233.2, 82_233.2, 17_975, 1_481_290.8588],
  [1_792_509_240_000, 82_243.9, 82_388.7, 82_159.2, 82_388.6, 10_365, 852_747.989],
]

describe('candles', () => {
  it('parses the venue row shape into ascending {t,o,h,l,c,v} with millisecond open time', async () => {
    const { fake, connector } = make()
    fake.kline = () => REAL_1M_ROWS
    const candles = await connector.candles('kucoin:XBTUSDTM', '1m', { n: 5 })

    expect(candles).toHaveLength(5)
    expect(candles[0]).toEqual({ t: 1_792_509_000_000, o: 82_990, h: 82_995.5, l: 82_966.1, c: 82_989.2, v: 3_747 })
    expect(Object.keys(candles[0]!).sort()).toEqual(['c', 'h', 'l', 'o', 't', 'v'])
    for (let i = 1; i < candles.length; i++) expect(candles[i]!.t).toBeGreaterThan(candles[i - 1]!.t)

    const call = fake.callsTo('/api/v1/kline/query')[0]!
    expect(call.params.get('symbol')).toBe('XBTUSDTM')
    expect(call.params.get('granularity')).toBe('1')
    expect(call.params.get('from')).toBeNull()
    expect(call.params.get('to')).toBeNull()
  })

  it('keeps the newest 200 rows when n is larger than the page limit, and defaults to 200', async () => {
    const { fake, connector } = make()
    const from = FX_NOW - 1_000 * STEP_MS
    fake.kline = () => candleRows(from, 250)

    const clamped = await connector.candles('kucoin:XBTUSDTM', '1m', { n: 9_999 })
    expect(clamped).toHaveLength(200)
    expect(clamped[0]!.t).toBe(from + 50 * STEP_MS)
    expect(clamped[199]!.t).toBe(from + 249 * STEP_MS)

    const dflt = await connector.candles('kucoin:XBTUSDTM', '1m')
    expect(dflt).toHaveLength(200)

    const calls = fake.callsTo('/api/v1/kline/query')
    expect(calls[0]!.params.get('from')).toBeNull()
    expect(calls[1]!.params.get('from')).toBeNull()
  })

  it('maps every supported protocol interval onto the venue granularity in minutes', async () => {
    const { fake, connector } = make()
    fake.kline = () => candleRows(MARK_TS, 1)
    const intervals: CandleInterval[] = ['1m', '5m', '15m', '30m', '1h', '2h', '4h', '8h', '12h', '1d', '1w']
    for (const interval of intervals) await connector.candles('kucoin:XBTUSDTM', interval, { n: 1 })

    const sent = fake.callsTo('/api/v1/kline/query').map((c) => c.params.get('granularity'))
    expect(sent).toEqual(['1', '5', '15', '30', '60', '120', '240', '480', '720', '1440', '10080'])
  })

  it('rejects 3m / 3d / 1M without touching HTTP', async () => {
    const { fake, connector } = make()
    for (const interval of ['3m', '3d', '1M'] as CandleInterval[]) {
      await expect(connector.candles('kucoin:XBTUSDTM', interval)).rejects.toMatchObject({
        problem: { name: 'INVALID_PARAMS', retryable: false },
      })
    }
    expect(fake.calls).toHaveLength(0)
  })

  it('pages forwards with a from cursor, 200 rows per page, until the range is exhausted', async () => {
    const { fake, connector } = make()
    const from = FX_NOW - 450 * STEP_MS
    const all = candleRows(from, 450)
    fake.kline = (params) => {
      const start = Number(params.get('from'))
      const toParam = params.get('to')
      const to = toParam === null ? undefined : Number(toParam)
      return all.filter((row) => Number(row[0]) >= start && (to === undefined || Number(row[0]) <= to)).slice(0, 200)
    }

    const candles = await connector.candles('kucoin:XBTUSDTM', '1m', { from })

    expect(candles).toHaveLength(450)
    expect(candles[0]!.t).toBe(from)
    expect(candles[449]!.t).toBe(from + 449 * STEP_MS)
    expect(new Set(candles.map((c) => c.t)).size).toBe(450)
    for (let i = 1; i < candles.length; i++) expect(candles[i]!.t).toBeGreaterThan(candles[i - 1]!.t)

    const calls = fake.callsTo('/api/v1/kline/query')
    expect(calls).toHaveLength(3)
    expect(calls.map((c) => c.params.get('from'))).toEqual([
      String(from), String(from + 200 * STEP_MS), String(from + 400 * STEP_MS),
    ])
  })

  it('stops at the inclusive `to` boundary after a single short page', async () => {
    const { fake, connector } = make()
    const from = FX_NOW - 100 * STEP_MS
    const to = from + 9 * STEP_MS
    const all = candleRows(from, 100)
    fake.kline = (params) => {
      const start = Number(params.get('from'))
      return all.filter((row) => Number(row[0]) >= start && Number(row[0]) <= to)
    }

    const candles = await connector.candles('kucoin:XBTUSDTM', '1m', { from, to })

    expect(candles).toHaveLength(10)
    expect(candles[0]!.t).toBe(from)
    expect(candles[9]!.t).toBe(to)
    const calls = fake.callsTo('/api/v1/kline/query')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.params.get('from')).toBe(String(from))
    expect(calls[0]!.params.get('to')).toBe(String(to))
  })

  it('returns an empty range without HTTP when to precedes from', async () => {
    const { fake, connector } = make()
    await expect(connector.candles('kucoin:XBTUSDTM', '1m', { from: FX_NOW, to: FX_NOW - 1 })).resolves.toEqual([])
    expect(fake.calls).toHaveLength(0)
  })
})
