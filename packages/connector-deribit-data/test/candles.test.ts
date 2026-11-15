// SPDX-License-Identifier: CPAL-1.0
// K 线：列式解析、毫秒时间窗、n 钳位、有 from 的 1000 根窗口翻页与不满一页提前停、resolution 映射、无对应周期的拒绝。
import { describe, expect, it } from 'vitest'
import type { CandleInterval } from '@gitrader/protocol'
import { DeribitDataConnector } from '../src/connector'
import { BTC_PERP_CHART, FakeDeribit, FX_NOW, STEP_MS, chartSeries } from './helpers/fake-deribit'

const CHART = '/api/v2/public/get_tradingview_chart_data'

function make() {
  const fake = new FakeDeribit()
  const connector = new DeribitDataConnector({ baseUrl: 'http://deribit.example.test', fetchImpl: fake.fetch, clock: () => FX_NOW })
  return { fake, connector }
}

describe('candles', () => {
  it('turns the columnar payload into {t,o,h,l,c,v} rows with millisecond open times', async () => {
    const { fake, connector } = make()
    const candles = await connector.candles('deribit:BTC-PERPETUAL', '1m', { n: 12 })

    expect(candles).toHaveLength(12)
    expect(candles[0]).toEqual({ t: 1792509420000, o: 82495.5, h: 82561, l: 82465, c: 82512.5, v: 39.85276459 })
    expect(candles[11]).toEqual({
      t: 1792510080000, o: 82376.5, h: 82415, l: 82349.5, c: 82372.5, v: 14.14670739,
    })
    expect(Object.keys(candles[0]!).sort()).toEqual(['c', 'h', 'l', 'o', 't', 'v'])
    expect(candles.map((c) => c.t)).toEqual(BTC_PERP_CHART.ticks)

    const call = fake.callsTo(CHART)[0]!
    expect(call.params.get('instrument_name')).toBe('BTC-PERPETUAL')
    expect(call.params.get('resolution')).toBe('1')
    expect(call.params.get('start_timestamp')).toBe(String(FX_NOW - 12 * STEP_MS))
    expect(call.params.get('end_timestamp')).toBe(String(FX_NOW))
  })

  it('clamps n to 1..1000 and defaults to 300 in a single request', async () => {
    const { fake, connector } = make()
    fake.chart = chartSeries(FX_NOW - 1000 * STEP_MS, 1000)

    const candles = await connector.candles('deribit:BTC-PERPETUAL', '1m', { n: 9999 })
    expect(fake.callsTo(CHART)[0]!.params.get('start_timestamp')).toBe(String(FX_NOW - 1000 * STEP_MS))
    expect(candles).toHaveLength(1000)
    expect(candles[0]!.t).toBe(FX_NOW - 1000 * STEP_MS)
    expect(candles[999]!.t).toBe(FX_NOW - STEP_MS)
    for (let i = 1; i < candles.length; i++) expect(candles[i]!.t).toBeGreaterThan(candles[i - 1]!.t)

    await connector.candles('deribit:BTC-PERPETUAL', '1m')
    expect(fake.callsTo(CHART)[1]!.params.get('start_timestamp')).toBe(String(FX_NOW - 300 * STEP_MS))
  })

  it('pages from `from` in 1000-candle windows until `to` (1800 rows over two requests)', async () => {
    const { fake, connector } = make()
    const from = FX_NOW - 1800 * STEP_MS
    const to = from + 1800 * STEP_MS - 1
    fake.chart = chartSeries(from, 1800)

    const candles = await connector.candles('deribit:BTC-PERPETUAL', '1m', { from, to })

    expect(candles).toHaveLength(1800)
    expect(candles[0]!.t).toBe(from)
    expect(candles[1799]!.t).toBe(from + 1799 * STEP_MS)
    expect(new Set(candles.map((c) => c.t)).size).toBe(1800)
    for (let i = 1; i < candles.length; i++) expect(candles[i]!.t).toBeGreaterThan(candles[i - 1]!.t)

    const calls = fake.callsTo(CHART)
    expect(calls).toHaveLength(2)
    expect(calls[0]!.params.get('start_timestamp')).toBe(String(from))
    expect(calls[0]!.params.get('end_timestamp')).toBe(String(from + 999 * STEP_MS))
    expect(calls[1]!.params.get('start_timestamp')).toBe(String(from + 1000 * STEP_MS))
    expect(calls[1]!.params.get('end_timestamp')).toBe(String(to))
  })

  it('stops paging as soon as a window comes back short of a full page', async () => {
    const { fake, connector } = make()
    const from = FX_NOW - 5000 * STEP_MS
    fake.chart = chartSeries(from, 500)

    const candles = await connector.candles('deribit:BTC-PERPETUAL', '1m', { from, to: FX_NOW })

    expect(candles).toHaveLength(500)
    expect(candles[0]!.t).toBe(from)
    expect(candles[499]!.t).toBe(from + 499 * STEP_MS)
    // 第一页只有 500 根（< 1000）→ 提前停，不把 MAX_PAGES 跑满
    expect(fake.callsTo(CHART)).toHaveLength(1)
  })

  it('stops at `to` after a single window and reports no data as an empty list', async () => {
    const { fake, connector } = make()
    const from = FX_NOW - 100 * STEP_MS
    fake.chart = chartSeries(from, 1800)
    const candles = await connector.candles('deribit:BTC-PERPETUAL', '1m', { from, to: from + 9 * STEP_MS })
    expect(candles).toHaveLength(10)
    expect(fake.callsTo(CHART)).toHaveLength(1)

    fake.chart = { ticks: [], open: [], high: [], low: [], close: [], volume: [], status: 'no_data' }
    await expect(connector.candles('deribit:BTC-PERPETUAL', '1m', { n: 10 })).resolves.toEqual([])
  })

  it('rejects intervals Deribit has no resolution for, without touching HTTP', async () => {
    const { fake, connector } = make()
    for (const interval of ['8h', '3d', '1w', '1M'] as CandleInterval[]) {
      await expect(connector.candles('deribit:BTC-PERPETUAL', interval, { n: 1 })).rejects.toMatchObject({
        problem: { name: 'INVALID_PARAMS', retryable: false },
      })
    }
    await expect(connector.candles('deribit:BTC-PERPETUAL', '2m' as CandleInterval, { n: 1 })).rejects.toMatchObject({
      problem: { name: 'INVALID_PARAMS' },
    })
    expect(fake.calls).toHaveLength(0)
  })

  it('maps every supported protocol interval onto a tradingview resolution', async () => {
    const { fake, connector } = make()
    const intervals: CandleInterval[] = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '12h', '1d']
    for (const interval of intervals) await connector.candles('deribit:BTC-PERPETUAL', interval, { n: 1 })
    const sent = fake.callsTo(CHART).map((c) => c.params.get('resolution'))
    expect(sent).toEqual(['1', '3', '5', '15', '30', '60', '120', '240', '720', '1D'])
  })
})
