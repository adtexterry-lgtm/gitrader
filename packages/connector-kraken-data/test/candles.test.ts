// SPDX-License-Identifier: CPAL-1.0
// K 线：真网格式解析（毫秒 time、字符串 OHLCV）、升序去重、n 钳位、resolution 映射、
// from 秒级游标 + more_candles 向前翻页、to 边界、非法周期拒绝。
import { describe, expect, it } from 'vitest'
import type { CandleInterval } from '@gitrader/protocol'
import { KrakenDataConnector } from '../src/connector'
import { FakeKraken, STEP_MS, FX_NOW, REAL_CANDLES, candleRows, perpEntry } from './helpers/fake-kraken'

/** 对齐到整分钟的起点，保证 /1000 之后仍落在 K 线开盘上。 */
const BASE = FX_NOW - (FX_NOW % STEP_MS)

function make() {
  const fake = new FakeKraken()
  const connector = new KrakenDataConnector({ baseUrl: 'http://kraken.example.test', fetchImpl: fake.fetch, clock: () => FX_NOW })
  return { fake, connector }
}

describe('candles', () => {
  it('parses the venue payload (ms time, string OHLCV) into ascending {t,o,h,l,c,v}', async () => {
    const { fake, connector } = make()
    fake.chart = REAL_CANDLES
    const candles = await connector.candles('kraken:PF_XBTUSD', '1h', { n: 4 })

    expect(candles).toHaveLength(4)
    expect(candles[0]).toEqual({ t: 1785312000000, o: 64482, h: 64508, l: 64203, c: 64350, v: 129.9969 })
    expect(Object.keys(candles[0]!).sort()).toEqual(['c', 'h', 'l', 'o', 't', 'v'])
    for (let i = 1; i < candles.length; i++) expect(candles[i]!.t).toBeGreaterThan(candles[i - 1]!.t)

    const call = fake.lastChart()!
    expect(call.symbol).toBe('PF_XBTUSD')
    expect(call.resolution).toBe('1h')
    // charts 端点没有 limit 参数，也不该凭空带上 from / to
    expect(call.params.get('limit')).toBeNull()
    expect(call.params.get('from')).toBeNull()
    expect(call.params.get('to')).toBeNull()
  })

  it('flips and dedupes an out-of-order payload', async () => {
    const { fake, connector } = make()
    fake.chart = [
      { time: 1785315600000, open: '2', high: '2', low: '2', close: '2', volume: '1' },
      { time: 1785312000000, open: '1', high: '1', low: '1', close: '1', volume: '1' },
      { time: 1785315600000, open: '3', high: '3', low: '3', close: '3', volume: '1' },
    ]
    const candles = await connector.candles('kraken:PF_XBTUSD', '1m', { n: 10 })
    expect(candles.map((c) => c.t)).toEqual([1785312000000, 1785315600000])
    // 同一 t 以后出现的为准
    expect(candles[1]!.c).toBe(3)
  })

  it('clamps n to 1..5000, defaults to 300, and keeps the newest bars', async () => {
    const { fake, connector } = make()
    const served = 5100
    fake.chart = candleRows(BASE, served)

    const many = await connector.candles('kraken:PF_XBTUSD', '1m', { n: 99_999 })
    expect(many).toHaveLength(5000)
    expect(many[0]!.t).toBe(BASE + 100 * STEP_MS)
    expect(many[4999]!.t).toBe(BASE + (served - 1) * STEP_MS)

    const byDefault = await connector.candles('kraken:PF_XBTUSD', '1m')
    expect(byDefault).toHaveLength(300)
    expect(byDefault[299]!.t).toBe(BASE + (served - 1) * STEP_MS)
    expect(fake.chartCalls()).toHaveLength(2)
  })

  it('maps every supported protocol interval onto its Kraken resolution', async () => {
    const { fake, connector } = make()
    fake.chart = candleRows(BASE, 1)
    const intervals: CandleInterval[] = ['1m', '5m', '15m', '30m', '1h', '4h', '12h', '1d', '1w']
    for (const interval of intervals) await connector.candles('kraken:PF_XBTUSD', interval, { n: 1 })
    expect(fake.chartCalls().map((c) => c.path.split('/')[6])).toEqual(intervals)
  })

  it('rejects intervals Kraken has no resolution for, without touching HTTP', async () => {
    const { fake, connector } = make()
    for (const interval of ['3m', '2h', '8h', '3d', '1M'] as CandleInterval[]) {
      await expect(connector.candles('kraken:PF_XBTUSD', interval)).rejects.toMatchObject({
        problem: { name: 'INVALID_PARAMS', retryable: false },
      })
    }
    expect(fake.calls).toHaveLength(0)
  })

  it('pages forward with a seconds `from` cursor while more_candles is true', async () => {
    const { fake, connector } = make()
    const total = 250
    const page = 100
    fake.chart = ({ params }) => {
      const fromSec = Number(params.get('from'))
      const rows = candleRows(BASE, total).filter((row) => Number(row.time) >= fromSec * 1000)
      const slice = rows.slice(0, page)
      return { candles: slice, more_candles: rows.length > slice.length }
    }

    const candles = await connector.candles('kraken:PF_XBTUSD', '1m', { from: BASE })

    expect(candles).toHaveLength(total)
    expect(candles[0]!.t).toBe(BASE)
    expect(candles[total - 1]!.t).toBe(BASE + (total - 1) * STEP_MS)
    expect(new Set(candles.map((c) => c.t)).size).toBe(total)
    for (let i = 1; i < candles.length; i++) expect(candles[i]!.t).toBeGreaterThan(candles[i - 1]!.t)

    const calls = fake.chartCalls()
    expect(calls).toHaveLength(3)
    expect(calls.map((c) => c.params.get('from'))).toEqual([
      String(BASE / 1000), String((BASE + page * STEP_MS) / 1000), String((BASE + 2 * page * STEP_MS) / 1000),
    ])
    expect(calls.every((c) => c.params.get('to') === null)).toBe(true)
  })

  it('stops at `to`: keeps the boundary bar and never pages past it', async () => {
    const { fake, connector } = make()
    const to = BASE + 9 * STEP_MS
    fake.chart = ({ params }) => {
      const fromSec = Number(params.get('from'))
      const toSec = Number(params.get('to'))
      const rows = candleRows(BASE, 40).filter((row) => {
        const t = Number(row.time)
        return t >= fromSec * 1000 && t <= toSec * 1000
      })
      // 上游哪怕声称还有更多，越过 to 也不该继续翻页
      return { candles: rows, more_candles: true }
    }

    const candles = await connector.candles('kraken:PF_XBTUSD', '1m', { from: BASE, to })

    expect(candles).toHaveLength(10)
    expect(candles[9]!.t).toBe(to)
    const calls = fake.chartCalls()
    expect(calls).toHaveLength(1)
    expect(calls[0]!.params.get('from')).toBe(String(BASE / 1000))
    expect(calls[0]!.params.get('to')).toBe(String(to / 1000))
  })

  it('normalises second-precision timestamps and returns [] for an inverted range', async () => {
    const { fake, connector } = make()
    fake.chart = [{ time: 1785312000, open: '1', high: '2', low: '0.5', close: '1.5', volume: '3' }]
    const candles = await connector.candles('kraken:PF_XBTUSD', '1h', { n: 1 })
    expect(candles[0]).toEqual({ t: 1785312000000, o: 1, h: 2, l: 0.5, c: 1.5, v: 3 })

    const before = fake.chartCalls().length
    await expect(connector.candles('kraken:PF_XBTUSD', '1h', { from: BASE + STEP_MS, to: BASE })).resolves.toEqual([])
    expect(fake.chartCalls()).toHaveLength(before)
  })

  it('converts candle volume to base quantity using contractSize', async () => {
    const fake = new FakeKraken()
    fake.instruments = [perpEntry({ symbol: 'PF_XBTUSD', contractSize: 10, base: 'BTC', quote: 'USD', pair: 'BTC:USD' })]
    fake.chart = REAL_CANDLES
    const connector = new KrakenDataConnector({ baseUrl: 'http://kraken.example.test', fetchImpl: fake.fetch, clock: () => FX_NOW })
    await connector.start()

    const candles = await connector.candles('kraken:PF_XBTUSD', '1h', { n: 1 })
    expect(candles[0]).toEqual({ t: 1785322800000, o: 64401, h: 64528, l: 64339, c: 64439, v: 1002.433 })
  })
})
