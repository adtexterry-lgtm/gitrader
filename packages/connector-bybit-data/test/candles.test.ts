// SPDX-License-Identifier: CPAL-1.0
// K 线：倒序翻转成升序、n 钳到 1000、interval 数字/D/W/M 映射、start+end 窗口翻页、
// 8h 与 3d（Bybit 没有这两个周期）与表外周期拒绝。
import { describe, expect, it } from 'vitest'
import type { CandleInterval } from '@gitrader/protocol'
import { BybitDataConnector } from '../src/connector'
import { FakeBybit, FX_NOW, STEP_MS, candleRows } from './helpers/fake-bybit'

function make() {
  const fake = new FakeBybit()
  const connector = new BybitDataConnector({ baseUrl: 'http://bybit.example.test', fetchImpl: fake.fetch, clock: () => FX_NOW })
  return { fake, connector }
}

describe('candles', () => {
  it('flips the venue descending payload into ascending {t,o,h,l,c,v}', async () => {
    const { fake, connector } = make()
    const from = FX_NOW - 5 * STEP_MS
    fake.candleFrom = from
    fake.candleCount = 5
    const candles = await connector.candles('bybit:BTCUSDT', '1m', { n: 5 })

    expect(candles).toHaveLength(5)
    expect(candles[0]).toEqual({ t: from, o: 100, h: 101, l: 99, c: 100.5, v: 5773.416 })
    expect(Object.keys(candles[0]!).sort()).toEqual(['c', 'h', 'l', 'o', 't', 'v'])
    for (let i = 1; i < candles.length; i++) expect(candles[i]!.t).toBeGreaterThan(candles[i - 1]!.t)

    const call = fake.callsTo('/v5/market/kline')[0]!
    expect(call.params.get('category')).toBe('linear')
    expect(call.params.get('symbol')).toBe('BTCUSDT')
    expect(call.params.get('interval')).toBe('1')
    expect(call.params.get('limit')).toBe('5')
    expect(call.params.get('start')).toBeNull()
    expect(call.params.get('end')).toBeNull()
  })

  it('clamps n to 1..1000 and defaults to 300', async () => {
    const { fake, connector } = make()
    const candles = await connector.candles('bybit:BTCUSDT', '1m', { n: 9999 })
    expect(fake.callsTo('/v5/market/kline')[0]!.params.get('limit')).toBe('1000')
    expect(candles).toHaveLength(1000)
    expect(candles[999]!.t).toBe(FX_NOW - STEP_MS)

    await connector.candles('bybit:BTCUSDT', '1m')
    expect(fake.callsTo('/v5/market/kline')[1]!.params.get('limit')).toBe('300')
  })

  it('pages a from..now range forward in 1000-bar windows', async () => {
    const { fake, connector } = make()
    const from = FX_NOW - 2500 * STEP_MS
    const candles = await connector.candles('bybit:BTCUSDT', '1m', { from })

    expect(candles).toHaveLength(2500)
    expect(candles[0]!.t).toBe(from)
    expect(candles[2499]!.t).toBe(FX_NOW - STEP_MS)
    expect(new Set(candles.map((c) => c.t)).size).toBe(2500)
    for (let i = 1; i < candles.length; i++) expect(candles[i]!.t).toBeGreaterThan(candles[i - 1]!.t)

    const calls = fake.callsTo('/v5/market/kline')
    expect(calls).toHaveLength(3)
    expect(calls.every((c) => c.params.get('limit') === '1000')).toBe(true)
    expect(calls.map((c) => c.params.get('start'))).toEqual([
      String(from), String(from + 1000 * STEP_MS), String(from + 2000 * STEP_MS),
    ])
    expect(calls.map((c) => c.params.get('end'))).toEqual([
      String(from + 1000 * STEP_MS - 1), String(from + 2000 * STEP_MS - 1), String(FX_NOW),
    ])
  })

  it('stops the window at `to` and keeps the boundary bar', async () => {
    const { fake, connector } = make()
    const from = FX_NOW - 100 * STEP_MS
    const to = from + 9 * STEP_MS
    const candles = await connector.candles('bybit:BTCUSDT', '1m', { from, to })

    expect(candles).toHaveLength(10)
    expect(candles[9]!.t).toBe(to)
    const calls = fake.callsTo('/v5/market/kline')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.params.get('start')).toBe(String(from))
    expect(calls[0]!.params.get('end')).toBe(String(to))
  })

  it('returns [] when `to` precedes `from` without touching HTTP', async () => {
    const { fake, connector } = make()
    const candles = await connector.candles('bybit:BTCUSDT', '1m', { from: FX_NOW, to: FX_NOW - STEP_MS })
    expect(candles).toEqual([])
    expect(fake.calls).toHaveLength(0)
  })

  it('maps every supported protocol interval onto the venue spelling', async () => {
    const { fake, connector } = make()
    const intervals: CandleInterval[] = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '12h', '1d', '1w', '1M']
    for (const interval of intervals) await connector.candles('bybit:BTCUSDT', interval, { n: 1 })
    const sent = fake.callsTo('/v5/market/kline').map((c) => c.params.get('interval'))
    expect(sent).toEqual(['1', '3', '5', '15', '30', '60', '120', '240', '720', 'D', 'W', 'M'])
  })

  it('rejects 8h / 3d / unknown intervals with INVALID_PARAMS and no HTTP', async () => {
    const { fake, connector } = make()
    for (const interval of ['8h', '3d', '2m'] as CandleInterval[]) {
      await expect(connector.candles('bybit:BTCUSDT', interval)).rejects.toMatchObject({
        problem: { name: 'INVALID_PARAMS', retryable: false },
      })
    }
    expect(fake.calls).toHaveLength(0)
  })

  it('accepts a hand-built payload as well (shape check without the generator)', async () => {
    const { fake, connector } = make()
    fake.override.set('/v5/market/kline', () =>
      ({ symbol: 'BTCUSDT', category: 'linear', list: candleRows(FX_NOW - 2 * STEP_MS, 2).reverse() }))
    const candles = await connector.candles('bybit:BTCUSDT', '1h', { n: 2 })
    expect(candles.map((c) => c.t)).toEqual([FX_NOW - 2 * STEP_MS, FX_NOW - STEP_MS])
  })
})
