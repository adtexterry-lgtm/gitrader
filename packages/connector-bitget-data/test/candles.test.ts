// SPDX-License-Identifier: CPAL-1.0
// K 线：7 列解析（毫秒开盘时间）、n 钳到 200、granularity 大写映射（含 2H）、8h 拒绝、
// history-candles 每页 200 根按 startTime 游标推进、越过 to 即停、升序去重。
import { describe, expect, it } from 'vitest'
import type { CandleInterval } from '@gitrader/protocol'
import { BitgetDataConnector } from '../src/connector'
import { FakeBitget, FX_NOW, REAL_CANDLES, STEP_MS, candleRow, candleRows } from './helpers/fake-bitget'

function make() {
  const fake = new FakeBitget()
  const connector = new BitgetDataConnector({ baseUrl: 'http://bitget.example.test', fetchImpl: fake.fetch, clock: () => FX_NOW })
  return { fake, connector }
}

describe('candles', () => {
  it('parses the 7-column payload into ascending {t,o,h,l,c,v} with millisecond open time', async () => {
    const { fake, connector } = make()
    const candles = await connector.candles('bitget:BTCUSDT', '1m', { n: 5 })

    expect(candles).toHaveLength(5)
    expect(candles[0]).toEqual({ t: 1_792_509_840_000, o: 82339.4, h: 82437.2, l: 82300, c: 82429.9, v: 107.8259 })
    expect(Object.keys(candles[0]!).sort()).toEqual(['c', 'h', 'l', 'o', 't', 'v'])
    for (let i = 1; i < candles.length; i++) expect(candles[i]!.t).toBeGreaterThan(candles[i - 1]!.t)

    const call = fake.callsTo('/api/v2/mix/market/candles')[0]!
    expect(call.params.get('productType')).toBe('USDT-FUTURES')
    expect(call.params.get('symbol')).toBe('BTCUSDT')
    expect(call.params.get('granularity')).toBe('1m')
    expect(call.params.get('limit')).toBe('5')
    expect(call.params.get('startTime')).toBeNull()
    expect(call.params.get('endTime')).toBeNull()
  })

  it('flips a descending payload into ascending order', async () => {
    const { fake, connector } = make()
    fake.candleRows = [...REAL_CANDLES].reverse()
    const candles = await connector.candles('bitget:BTCUSDT', '1m', { n: 5 })
    expect(candles.map((c) => c.t)).toEqual([
      1_792_509_840_000, 1_792_509_900_000, 1_792_509_960_000, 1_792_510_020_000, 1_792_510_080_000,
    ])
  })

  it('clamps n to 1..200 and caps the 300 default at 200', async () => {
    const { fake, connector } = make()
    fake.candleRows = candleRows(FX_NOW - 200 * STEP_MS, 200)
    const candles = await connector.candles('bitget:BTCUSDT', '1m', { n: 9999 })

    expect(fake.callsTo('/api/v2/mix/market/candles')[0]!.params.get('limit')).toBe('200')
    expect(candles).toHaveLength(200)
    expect(candles[199]!.t).toBe(FX_NOW - STEP_MS)

    await connector.candles('bitget:BTCUSDT', '1m')
    expect(fake.callsTo('/api/v2/mix/market/candles')[1]!.params.get('limit')).toBe('200')
  })

  it('maps every interval in the work order onto the venue granularity spelling', async () => {
    const { fake, connector } = make()
    fake.candleRows = [candleRow(FX_NOW, 100)]
    const intervals: CandleInterval[] = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '12h', '1d', '3d', '1w', '1M']
    for (const interval of intervals) await connector.candles('bitget:BTCUSDT', interval, { n: 1 })
    const sent = fake.callsTo('/api/v2/mix/market/candles').map((c) => c.params.get('granularity'))
    expect(sent).toEqual(['1m', '3m', '5m', '15m', '30m', '1H', '2H', '4H', '12H', '1D', '3D', '1W', '1M'])
  })

  it('rejects 8h (not in the work-order table) without touching HTTP', async () => {
    const { fake, connector } = make()
    for (const interval of ['8h'] as CandleInterval[]) {
      await expect(connector.candles('bitget:BTCUSDT', interval, { n: 5 })).rejects.toMatchObject({
        problem: { name: 'INVALID_PARAMS', retryable: false },
      })
    }
    expect(fake.calls).toHaveLength(0)
  })

  it('pages history-candles 200 at a time from `from` until the page is short (200+200+50)', async () => {
    const { fake, connector } = make()
    const from = FX_NOW - 450 * STEP_MS
    const total = 450
    fake.historyRows = (params) => {
      const start = Number(params.get('startTime'))
      const index = Math.round((start - from) / STEP_MS)
      const count = Math.max(0, Math.min(200, total - index))
      return candleRows(start, count)
    }

    const candles = await connector.candles('bitget:BTCUSDT', '1m', { from, to: from + (total - 1) * STEP_MS })

    expect(candles).toHaveLength(450)
    expect(candles[0]!.t).toBe(from)
    expect(candles[449]!.t).toBe(from + 449 * STEP_MS)
    expect(new Set(candles.map((c) => c.t)).size).toBe(450)
    for (let i = 1; i < candles.length; i++) expect(candles[i]!.t).toBeGreaterThan(candles[i - 1]!.t)

    const calls = fake.callsTo('/api/v2/mix/market/history-candles')
    expect(calls).toHaveLength(3)
    expect(calls[0]!.params.get('startTime')).toBe(String(from))
    expect(calls[1]!.params.get('startTime')).toBe(String(from + 200 * STEP_MS))
    expect(calls[2]!.params.get('startTime')).toBe(String(from + 400 * STEP_MS))
    expect(calls[0]!.params.get('limit')).toBe('200')
    expect(calls[0]!.params.get('granularity')).toBe('1m')
    expect(calls[0]!.params.get('productType')).toBe('USDT-FUTURES')
    expect(calls[0]!.params.get('endTime')).toBe(String(from + (total - 1) * STEP_MS))
    expect(fake.callsTo('/api/v2/mix/market/candles')).toHaveLength(0)
  })

  it('stops at `to` even when the page came back full', async () => {
    const { fake, connector } = make()
    const from = FX_NOW - 500 * STEP_MS
    fake.historyRows = (params) => {
      const start = Number(params.get('startTime'))
      return candleRows(start, 200)
    }
    const to = from + 250 * STEP_MS
    const candles = await connector.candles('bitget:BTCUSDT', '1m', { from, to })

    expect(candles).toHaveLength(251)
    expect(candles[250]!.t).toBe(to)
    expect(fake.callsTo('/api/v2/mix/market/history-candles')).toHaveLength(2)
  })

  it('returns an empty list when to < from and sends nothing', async () => {
    const { fake, connector } = make()
    const candles = await connector.candles('bitget:BTCUSDT', '1m', { from: FX_NOW, to: FX_NOW - STEP_MS })
    expect(candles).toEqual([])
    expect(fake.calls).toHaveLength(0)
  })
})
