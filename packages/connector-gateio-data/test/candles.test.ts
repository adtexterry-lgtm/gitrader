// SPDX-License-Identifier: CPAL-1.0
// K 线：秒 → 毫秒、真网行解析、n 钳到 2000、interval 映射（1w → 7d）、
// from/to 翻页（Gate.io 禁止 limit 与 from/to 同用）、越过 to / 不满一页即停、非法区间拒绝。
import { describe, expect, it } from 'vitest'
import type { CandleInterval } from '@gitrader/protocol'
import { GateioDataConnector } from '../src/connector'
import { FakeGateio, FX_NOW, candleRows } from './helpers/fake-gateio'

/** 1800 s 对齐的起点（1792510020 / 60 = 29875167）。 */
const T0 = 1_792_510_020
const FROM_MS = T0 * 1000

function make() {
  const fake = new FakeGateio()
  const connector = new GateioDataConnector({ baseUrl: 'http://gateio.example.test', fetchImpl: fake.fetch, clock: () => FX_NOW })
  return { fake, connector }
}

function series(count: number, fromSeconds = T0): number[][] {
  const out: number[][] = []
  for (let i = 0; i < count; i++) out.push([fromSeconds + i * 60, 100 + i])
  return out
}

describe('candles', () => {
  it('parses the real 1m payload: t is seconds upstream and becomes the bar open in ms', async () => {
    const { fake, connector } = make()
    const candles = await connector.candles('gateio:BTC_USDT', '1m', { n: 3 })

    expect(candles).toEqual([
      { t: 1_792_510_020_000, o: 82403.4, h: 82418.5, l: 82346.9, c: 82412.2, v: 100.7717 },
      { t: 1_792_510_080_000, o: 82409.9, h: 82447.1, l: 82390.1, c: 82446.6, v: 77.8495 },
      { t: 1_792_510_140_000, o: 82446.6, h: 82454.5, l: 82427.3, c: 82437.2, v: 20.5911 },
    ])
    // 上游 `v` 是「张」，按 quanto_multiplier（BTC 0.0001 币 / 张）折成币数
    expect(candles[0]!.v).toBe(100.7717)
    expect(Object.keys(candles[0]!).sort()).toEqual(['c', 'h', 'l', 'o', 't', 'v'])

    const call = fake.callsTo('/api/v4/futures/usdt/candlesticks')[0]!
    expect(call.params.get('contract')).toBe('BTC_USDT')
    expect(call.params.get('interval')).toBe('1m')
    expect(call.params.get('limit')).toBe('3')
    expect(call.params.get('from')).toBeNull()
    expect(call.params.get('to')).toBeNull()
  })

  it('converts the paged bars from contracts to base coins with the same quanto_multiplier', async () => {
    const { fake, connector } = make()
    fake.candleSeries = series(3)

    const candles = await connector.candles('gateio:BTC_USDT', '1m', { from: FROM_MS })
    expect(candles.map((c) => c.v)).toEqual([0.001, 0.001, 0.001])
    // 冷缓存也要折成币：先拉一次 /contracts 取 quanto_multiplier
    expect(fake.callsTo('/api/v4/futures/usdt/contracts')).toHaveLength(1)
  })

  it('clamps n to 1..2000 and defaults to 300', async () => {
    const { fake, connector } = make()
    fake.candleRows = candleRows(FROM_MS, 2000)
    const candles = await connector.candles('gateio:BTC_USDT', '1m', { n: 99_999 })
    expect(fake.callsTo('/api/v4/futures/usdt/candlesticks')[0]!.params.get('limit')).toBe('2000')
    expect(candles).toHaveLength(2000)

    await connector.candles('gateio:BTC_USDT', '1m')
    expect(fake.callsTo('/api/v4/futures/usdt/candlesticks')[1]!.params.get('limit')).toBe('300')
  })

  it('pages with a from cursor, never sending limit (Gate.io rejects limit + from/to)', async () => {
    const { fake, connector } = make()
    fake.candleSeries = series(2500)

    const candles = await connector.candles('gateio:BTC_USDT', '1m', { from: FROM_MS })

    expect(candles).toHaveLength(2500)
    expect(candles[0]!.t).toBe(FROM_MS)
    expect(candles[2499]!.t).toBe(FROM_MS + 2499 * 60_000)
    expect(new Set(candles.map((c) => c.t)).size).toBe(2500)
    for (let i = 1; i < candles.length; i++) expect(candles[i]!.t).toBeGreaterThan(candles[i - 1]!.t)

    const calls = fake.callsTo('/api/v4/futures/usdt/candlesticks')
    expect(calls).toHaveLength(2)
    expect(calls.every((c) => c.params.get('limit') === null)).toBe(true)
    expect(calls[0]!.params.get('from')).toBe(String(T0))
    expect(calls[1]!.params.get('from')).toBe(String(T0 + 2000 * 60))
    expect(calls[0]!.params.get('to')).toBeNull()
  })

  it('stops at `to`, keeps the boundary bar and drops the bar that contains an unaligned `from`', async () => {
    const { fake, connector } = make()
    fake.candleSeries = series(2500)

    const to = FROM_MS + 9 * 60_000
    const aligned = await connector.candles('gateio:BTC_USDT', '1m', { from: FROM_MS, to })
    expect(aligned).toHaveLength(10)
    expect(aligned[9]!.t).toBe(to)
    const first = fake.callsTo('/api/v4/futures/usdt/candlesticks')[0]!
    expect(first.params.get('to')).toBe(String(T0 + 9 * 60))
    expect(fake.callsTo('/api/v4/futures/usdt/candlesticks')).toHaveLength(1)

    // from 落在 K 线中间：上游会先给「包含 from 的那根」，必须被丢掉
    const mid = await connector.candles('gateio:BTC_USDT', '1m', { from: FROM_MS + 30_000 })
    expect(mid[0]!.t).toBe(FROM_MS + 60_000)
    expect(mid).toHaveLength(2499)
  })

  it('returns [] when to is earlier than from, and on an empty page', async () => {
    const { fake, connector } = make()
    await expect(connector.candles('gateio:BTC_USDT', '1m', { from: FROM_MS, to: FROM_MS - 1 })).resolves.toEqual([])
    expect(fake.calls).toHaveLength(0)

    await expect(connector.candles('gateio:BTC_USDT', '1m', { from: FROM_MS })).resolves.toEqual([])
    expect(fake.callsTo('/api/v4/futures/usdt/candlesticks')).toHaveLength(1)
  })

  it('rejects intervals Gate.io does not serve (3m / 2h / 12h / 3d / 1M) without touching HTTP', async () => {
    const { fake, connector } = make()
    for (const interval of ['3m', '2h', '12h', '3d', '1M'] as CandleInterval[]) {
      await expect(connector.candles('gateio:BTC_USDT', interval)).rejects.toMatchObject({
        problem: { name: 'INVALID_PARAMS', retryable: false },
      })
    }
    await expect(connector.candles('gateio:BTC_USDT', '2m' as CandleInterval)).rejects.toMatchObject({
      problem: { name: 'INVALID_PARAMS' },
    })
    expect(fake.calls).toHaveLength(0)
  })

  it('maps every served protocol interval onto the Gate.io spelling (1w -> 7d)', async () => {
    const { fake, connector } = make()
    fake.candleRows = candleRows(FROM_MS, 1)
    const intervals: CandleInterval[] = ['1m', '5m', '15m', '30m', '1h', '4h', '8h', '1d', '1w']
    for (const interval of intervals) await connector.candles('gateio:BTC_USDT', interval, { n: 1 })
    const sent = fake.callsTo('/api/v4/futures/usdt/candlesticks').map((c) => c.params.get('interval'))
    expect(sent).toEqual(['1m', '5m', '15m', '30m', '1h', '4h', '8h', '1d', '7d'])
  })
})
