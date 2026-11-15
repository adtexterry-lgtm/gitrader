// SPDX-License-Identifier: CPAL-1.0
// K 线：ISO 时间 → 开盘毫秒、倒序翻转成升序、n 钳到 1000、resolution 映射、toISO 游标向前翻页、非法周期拒绝。
import { describe, expect, it } from 'vitest'
import type { CandleInterval } from '@gitrader/protocol'
import { DydxDataConnector } from '../src/connector'
import { isoOf } from '../src/parse'
import { CANDLES_FIXTURE, FakeDydx, FX_NOW, STEP_MS, candleRows, pagedCandles } from './helpers/fake-dydx'

const BASE = 'http://dydx.example.test'

function make() {
  const fake = new FakeDydx()
  const connector = new DydxDataConnector({ baseUrl: BASE, fetchImpl: fake.fetch, clock: () => FX_NOW })
  return { fake, connector }
}

describe('candles', () => {
  it('flips the venue descending ISO payload into ascending {t,o,h,l,c,v} with opening ms', async () => {
    const { fake, connector } = make()
    const candles = await connector.candles('dydx:BTC-USD', '1m', { n: 4 })

    expect(candles).toHaveLength(4)
    expect(candles[0]).toEqual({ t: Date.parse('2026-10-20T15:26:00.000Z'), o: 82346, h: 82346, l: 82346, c: 82346, v: 0 })
    expect(candles[3]).toEqual({ t: FX_NOW, o: 82350, h: 82350, l: 82350, c: 82350, v: 0 })
    expect(Object.keys(candles[0]!).sort()).toEqual(['c', 'h', 'l', 'o', 't', 'v'])
    for (let i = 1; i < candles.length; i++) expect(candles[i]!.t).toBeGreaterThan(candles[i - 1]!.t)

    const call = fake.callsOfKind('candles')[0]!
    expect(call.path).toBe('/v4/candles/perpetualMarkets/BTC-USD')
    expect(call.params.get('resolution')).toBe('1MIN')
    expect(call.params.get('limit')).toBe('4')
    expect(call.params.get('fromISO')).toBeNull()
    expect(call.params.get('toISO')).toBeNull()
    expect(CANDLES_FIXTURE.candles[0]!.startedAt).toBe('2026-10-20T15:29:00.000Z')
  })

  it('clamps n to 1..1000 and defaults to 300', async () => {
    const { fake, connector } = make()
    fake.candles = { candles: candleRows(FX_NOW - 300 * STEP_MS, 300).reverse() }

    const candles = await connector.candles('dydx:BTC-USD', '1m', { n: 9999 })
    expect(fake.callsOfKind('candles')[0]!.params.get('limit')).toBe('1000')
    expect(candles).toHaveLength(300)
    expect(candles[299]!.t).toBe(FX_NOW - STEP_MS)

    await connector.candles('dydx:BTC-USD', '1m')
    expect(fake.callsOfKind('candles')[1]!.params.get('limit')).toBe('300')

    await connector.candles('dydx:BTC-USD', '1m', { n: 0 })
    expect(fake.callsOfKind('candles')[2]!.params.get('limit')).toBe('1')
  })

  it('pages backwards with a toISO cursor, 1000 per page, until the range is exhausted', async () => {
    const { fake, connector } = make()
    const from = FX_NOW - 2499 * STEP_MS
    fake.candles = pagedCandles(candleRows(from, 2500))

    const candles = await connector.candles('dydx:BTC-USD', '1m', { from })

    expect(candles).toHaveLength(2500)
    expect(candles[0]!.t).toBe(from)
    expect(candles[2499]!.t).toBe(from + 2499 * STEP_MS)
    expect(new Set(candles.map((c) => c.t)).size).toBe(2500)
    for (let i = 1; i < candles.length; i++) expect(candles[i]!.t).toBeGreaterThan(candles[i - 1]!.t)

    const calls = fake.callsOfKind('candles')
    expect(calls).toHaveLength(3)
    expect(calls.every((c) => c.params.get('limit') === '1000')).toBe(true)
    expect(calls.every((c) => c.params.get('fromISO') === isoOf(from))).toBe(true)
    expect(calls[0]!.params.get('toISO')).toBeNull()
    expect(calls[1]!.params.get('toISO')).toBe(isoOf(from + 1500 * STEP_MS))
    expect(calls[2]!.params.get('toISO')).toBe(isoOf(from + 500 * STEP_MS))
  })

  it('starts the cursor at to + 1 ms so the boundary bar at `to` is included', async () => {
    const { fake, connector } = make()
    const from = FX_NOW - 100 * STEP_MS
    const to = from + 9 * STEP_MS
    fake.candles = pagedCandles(candleRows(from, 100))

    const candles = await connector.candles('dydx:BTC-USD', '1m', { from, to })

    expect(candles).toHaveLength(10)
    expect(candles[9]!.t).toBe(to)
    const calls = fake.callsOfKind('candles')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.params.get('toISO')).toBe(isoOf(to + 1))
    expect(calls[0]!.params.get('fromISO')).toBe(isoOf(from))
  })

  it('returns [] without any request when to is earlier than from', async () => {
    const { fake, connector } = make()
    await expect(connector.candles('dydx:BTC-USD', '1m', { from: FX_NOW, to: FX_NOW - 1 })).resolves.toEqual([])
    expect(fake.calls).toHaveLength(0)
  })

  it('rejects intervals the Indexer does not support without touching HTTP', async () => {
    const { fake, connector } = make()
    for (const interval of ['2m', '3m', '2h', '8h', '1w', '1M'] as CandleInterval[]) {
      await expect(connector.candles('dydx:BTC-USD', interval)).rejects.toMatchObject({
        problem: { name: 'INVALID_PARAMS', retryable: false },
      })
    }
    expect(fake.calls).toHaveLength(0)
  })

  it('maps the seven supported intervals onto Indexer resolutions', async () => {
    const { fake, connector } = make()
    fake.candles = { candles: [] }
    const intervals: CandleInterval[] = ['1m', '5m', '15m', '30m', '1h', '4h', '1d']
    for (const interval of intervals) await connector.candles('dydx:BTC-USD', interval, { n: 1 })
    expect(fake.callsOfKind('candles').map((c) => c.params.get('resolution'))).toEqual([
      '1MIN', '5MINS', '15MINS', '30MINS', '1HOUR', '4HOURS', '1DAY',
    ])
  })

  it('skips malformed rows instead of inventing values', async () => {
    const { fake, connector } = make()
    fake.candles = {
      candles: [
        { startedAt: '2026-10-20T15:29:00.000Z', open: '1', high: '2', low: '0.5', close: '1.5', baseTokenVolume: '7' },
        { startedAt: 'not-a-date', open: '1', high: '2', low: '0.5', close: '1.5', baseTokenVolume: '7' },
        { startedAt: '2026-10-20T15:30:00.000Z', open: '', high: '2', low: '0.5', close: '1.5', baseTokenVolume: '7' },
        null,
      ],
    }
    const candles = await connector.candles('dydx:BTC-USD', '1m', { n: 10 })
    expect(candles).toEqual([{ t: Date.parse('2026-10-20T15:29:00.000Z'), o: 1, h: 2, l: 0.5, c: 1.5, v: 7 }])
  })
})
