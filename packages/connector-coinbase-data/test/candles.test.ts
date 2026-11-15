// SPDX-License-Identifier: CPAL-1.0
// K 线：秒 → 毫秒、倒序翻成升序、n 钳到 350、granularity 映射、start 秒游标按 350 根一窗翻页、非法周期拒绝。
import { describe, expect, it } from 'vitest'
import type { CandleInterval } from '@gitrader/protocol'
import { CoinbaseDataConnector } from '../src/connector'
import { FakeCoinbase, FX_NOW, STEP_MS, STEP_SEC, candleSeries } from './helpers/fake-coinbase'

const CANDLES_PATH = '/api/v3/brokerage/market/products/BTC-USD/candles'

function make() {
  const fake = new FakeCoinbase()
  const connector = new CoinbaseDataConnector({
    baseUrl: 'http://coinbase.example.test', fetchImpl: fake.fetch, clock: () => FX_NOW,
  })
  return { fake, connector }
}

describe('candles', () => {
  it('parses the real payload shape: start in seconds, descending rows flipped to ascending ms', async () => {
    const { fake, connector } = make()
    const candles = await connector.candles('coinbase:BTC-USD', '1m', { n: 3 })

    expect(candles).toHaveLength(3)
    expect(candles[0]).toEqual({ t: 1_792_509_960_000, o: 82436.3, h: 82444.85, l: 82325.18, c: 82344.43, v: 10.81785432 })
    expect(Object.keys(candles[0]!).sort()).toEqual(['c', 'h', 'l', 'o', 't', 'v'])
    expect(candles.map((c) => c.t)).toEqual([1_792_509_960_000, 1_792_510_020_000, 1_792_510_080_000])

    const call = fake.callsTo(CANDLES_PATH)[0]!
    expect(call.params.get('granularity')).toBe('ONE_MINUTE')
    expect(call.params.get('limit')).toBe('3')
    expect(call.params.get('start')).toBeNull()
    expect(call.params.get('end')).toBeNull()
  })

  it('clamps n to 1..350 and defaults to 300', async () => {
    const { fake, connector } = make()
    const fromSec = FX_NOW / 1000 - 400 * STEP_SEC
    fake.candles = () => candleSeries(fromSec, 400).reverse()

    const many = await connector.candles('coinbase:BTC-USD', '1m', { n: 9999 })
    expect(fake.callsTo(CANDLES_PATH)[0]!.params.get('limit')).toBe('350')
    expect(many).toHaveLength(350)
    expect(many[349]!.t).toBe((fromSec + 399 * STEP_SEC) * 1000)

    await connector.candles('coinbase:BTC-USD', '1m')
    expect(fake.callsTo(CANDLES_PATH)[1]!.params.get('limit')).toBe('300')
  })

  it('maps the supported protocol intervals onto Coinbase granularity', async () => {
    const { fake, connector } = make()
    fake.candles = () => candleSeries(FX_NOW / 1000, 1)
    const intervals: CandleInterval[] = ['1m', '5m', '15m', '30m', '1h', '2h', '1d']
    for (const interval of intervals) await connector.candles('coinbase:BTC-USD', interval, { n: 1 })
    const sent = fake.callsTo(CANDLES_PATH).map((c) => c.params.get('granularity'))
    expect(sent).toEqual(['ONE_MINUTE', 'FIVE_MINUTE', 'FIFTEEN_MINUTE', 'THIRTY_MINUTE', 'ONE_HOUR', 'TWO_HOUR', 'ONE_DAY'])
  })

  it('rejects intervals the venue cannot serve without touching HTTP', async () => {
    const { fake, connector } = make()
    for (const interval of ['3m', '4h', '8h', '1w', '1M'] as CandleInterval[]) {
      await expect(connector.candles('coinbase:BTC-USD', interval, { n: 10 })).rejects.toMatchObject({
        problem: { name: 'INVALID_PARAMS', retryable: false },
      })
    }
    expect(fake.calls).toHaveLength(0)
  })

  it('pages forward with a start cursor in seconds, 350 bars per window', async () => {
    const { fake, connector } = make()
    const from = FX_NOW - 800 * STEP_MS
    const fromSec = from / 1000
    fake.candles = (params: URLSearchParams) => {
      const start = Number(params.get('start'))
      const end = Number(params.get('end'))
      const limit = Number(params.get('limit') ?? 350)
      const all = candleSeries(fromSec, 800)
      return all.filter((row) => Number(row.start) >= start && Number(row.start) <= end).slice(0, limit).reverse()
    }

    const candles = await connector.candles('coinbase:BTC-USD', '1m', { from })

    expect(candles).toHaveLength(800)
    expect(candles[0]!.t).toBe(from)
    expect(candles[799]!.t).toBe(from + 799 * STEP_MS)
    expect(new Set(candles.map((c) => c.t)).size).toBe(800)
    for (let i = 1; i < candles.length; i++) expect(candles[i]!.t).toBeGreaterThan(candles[i - 1]!.t)

    const calls = fake.callsTo(CANDLES_PATH)
    expect(calls).toHaveLength(3)
    expect(calls.map((c) => c.params.get('start'))).toEqual([
      String(fromSec), String(fromSec + 350 * STEP_SEC), String(fromSec + 700 * STEP_SEC),
    ])
    expect(calls.map((c) => c.params.get('end'))).toEqual([
      String(fromSec + 349 * STEP_SEC), String(fromSec + 699 * STEP_SEC), String(fromSec + 1049 * STEP_SEC),
    ])
    expect(calls.every((c) => c.params.get('granularity') === 'ONE_MINUTE')).toBe(true)
  })

  it('stops at `to` in the first window and keeps the boundary bar', async () => {
    const { fake, connector } = make()
    const from = FX_NOW - 100 * STEP_MS
    const to = from + 9 * STEP_MS
    fake.candles = (params: URLSearchParams) => {
      const start = Number(params.get('start'))
      const end = Number(params.get('end'))
      return candleSeries(from / 1000, 200)
        .filter((row) => Number(row.start) >= start && Number(row.start) <= end)
        .reverse()
    }

    const candles = await connector.candles('coinbase:BTC-USD', '1m', { from, to })

    expect(candles).toHaveLength(10)
    expect(candles[9]!.t).toBe(to)
    const calls = fake.callsTo(CANDLES_PATH)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.params.get('start')).toBe(String(from / 1000))
    expect(calls[0]!.params.get('end')).toBe(String(to / 1000))
  })

  it('dedupes overlapping rows and skips malformed candles', async () => {
    const { fake, connector } = make()
    const base = 1_792_509_900
    fake.candles = () => [
      { start: String(base + 60), open: '1', high: '2', low: '0.5', close: '1.5', volume: '3' },
      { start: String(base + 60), open: '1', high: '2', low: '0.5', close: '1.5', volume: '3' },
      { start: String(base), open: '1', high: '2', low: '0.5', close: '1.5', volume: '3' },
      { start: String(base + 120), open: '1', high: '2', low: '0.5', close: '', volume: '3' },
      { start: 'not-a-number', open: '1', high: '2', low: '0.5', close: '1.5', volume: '3' },
    ]
    const candles = await connector.candles('coinbase:BTC-USD', '1m', { n: 10 })
    expect(candles.map((c) => c.t)).toEqual([base * 1000, (base + 60) * 1000])
  })
})
