// SPDX-License-Identifier: CPAL-1.0
// K 线：12 列解析、n 钳位、有 from 的分页推进（1500 + 300 = 1800 根，升序去重）、非法区间拒绝。
import { describe, expect, it } from 'vitest'
import type { CandleInterval } from '@gitrader/protocol'
import { BinanceDataConnector } from '../src/connector'
import { FakeBinance, FX_NOW, STEP_MS, klineRow, klines } from './helpers/fake-binance'

function make() {
  const fake = new FakeBinance()
  const connector = new BinanceDataConnector({ baseUrl: 'https://fapi.example.test', fetchImpl: fake.fetch, clock: () => FX_NOW })
  return { fake, connector }
}

describe('candles', () => {
  it('parses the 12-column kline payload into {t,o,h,l,c,v}', async () => {
    const { fake, connector } = make()
    fake.klineRows = klines(FX_NOW - 5 * STEP_MS, 5)
    const candles = await connector.candles('binance:BTCUSDT', '1m', { n: 5 })

    expect(candles).toHaveLength(5)
    expect(candles[0]).toEqual({ t: FX_NOW - 5 * STEP_MS, o: 100, h: 101, l: 99, c: 100.5, v: 10 })
    expect(Object.keys(candles[0]!).sort()).toEqual(['c', 'h', 'l', 'o', 't', 'v'])

    const call = fake.callsTo('/fapi/v1/klines')[0]!
    expect(call.params.get('symbol')).toBe('BTCUSDT')
    expect(call.params.get('interval')).toBe('1m')
    expect(call.params.get('limit')).toBe('5')
    expect(call.params.get('startTime')).toBeNull()
  })

  it('clamps n to 1..1500 and returns the most recent candles ascending', async () => {
    const { fake, connector } = make()
    fake.klineRows = klines(FX_NOW - 1500 * STEP_MS, 1500)
    const candles = await connector.candles('binance:BTCUSDT', '1m', { n: 9999 })

    expect(fake.callsTo('/fapi/v1/klines')[0]!.params.get('limit')).toBe('1500')
    expect(candles).toHaveLength(1500)
    expect(candles[1499]!.t).toBe(FX_NOW - STEP_MS)
    for (let i = 1; i < candles.length; i++) expect(candles[i]!.t).toBeGreaterThan(candles[i - 1]!.t)

    await connector.candles('binance:BTCUSDT', '1m')
    expect(fake.callsTo('/fapi/v1/klines')[1]!.params.get('limit')).toBe('300')
  })

  it('pages from `from` with a 1500-candle cursor until the page is short (1500 + 300 = 1800)', async () => {
    const { fake, connector } = make()
    const from = FX_NOW - 1800 * STEP_MS
    const total = 1800
    fake.klineRows = (params) => {
      const start = Number(params.get('startTime'))
      const index = Math.round((start - from) / STEP_MS)
      const count = Math.max(0, Math.min(1500, total - index))
      return klines(start, count)
    }

    const candles = await connector.candles('binance:BTCUSDT', '1m', { from, to: from + total * STEP_MS - 1 })

    expect(candles).toHaveLength(1800)
    expect(candles[0]!.t).toBe(from)
    expect(candles[1799]!.t).toBe(from + 1799 * STEP_MS)
    expect(new Set(candles.map((c) => c.t)).size).toBe(1800)
    for (let i = 1; i < candles.length; i++) expect(candles[i]!.t).toBeGreaterThan(candles[i - 1]!.t)

    const calls = fake.callsTo('/fapi/v1/klines')
    expect(calls).toHaveLength(2)
    expect(calls[0]!.params.get('startTime')).toBe(String(from))
    expect(calls[1]!.params.get('startTime')).toBe(String(from + 1500 * STEP_MS))
    expect(calls[0]!.params.get('endTime')).toBe(String(from + total * STEP_MS - 1))
  })

  it('stops at `to` even when the page came back full', async () => {
    const { fake, connector } = make()
    const from = FX_NOW - 100 * STEP_MS
    fake.klineRows = (params) => {
      const start = Number(params.get('startTime'))
      const end = Number(params.get('endTime'))
      return klines(start, Math.max(0, Math.min(1500, Math.round((end - start) / STEP_MS) + 1)))
    }
    const candles = await connector.candles('binance:BTCUSDT', '1m', { from, to: from + 9 * STEP_MS })
    expect(candles).toHaveLength(10)
    expect(fake.callsTo('/fapi/v1/klines')).toHaveLength(1)
  })

  it('rejects an interval that is not in the protocol table without touching HTTP', async () => {
    const { fake, connector } = make()
    await expect(connector.candles('binance:BTCUSDT', '2m' as CandleInterval)).rejects.toMatchObject({
      problem: { name: 'INVALID_PARAMS', retryable: false },
    })
    expect(fake.calls).toHaveLength(0)
  })

  it('maps every protocol interval onto the venue spelling', async () => {
    const { fake, connector } = make()
    fake.klineRows = [klineRow(FX_NOW, 100)]
    const intervals: CandleInterval[] = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '8h', '12h', '1d', '3d', '1w', '1M']
    for (const interval of intervals) await connector.candles('binance:BTCUSDT', interval, { n: 1 })
    const sent = fake.callsTo('/fapi/v1/klines').map((c) => c.params.get('interval'))
    expect(sent).toEqual(intervals)
  })
})
