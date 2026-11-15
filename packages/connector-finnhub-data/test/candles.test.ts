// SPDX-License-Identifier: CPAL-1.0
// K 线：列式 {c,h,l,o,s,t,v} 解析、秒 → 毫秒、n 钳位、按时间窗分页、interval → resolution 映射。
import { describe, expect, it } from 'vitest'
import type { CandleInterval } from '@gitrader/protocol'
import { FinnhubDataConnector } from '../src/connector'
import { FakeFinnhub, FX_NOW, STEP_MS, STEP_SEC, candleSeries } from './helpers/fake-finnhub'

function make(o: Record<string, unknown> = {}) {
  const fake = new FakeFinnhub()
  const connector = new FinnhubDataConnector({
    baseUrl: 'https://finnhub.example.test/v1', fetchImpl: fake.fetch, clock: () => FX_NOW,
    env: { FINNHUB_API_KEY: 'test-finnhub-key' }, ...o,
  })
  return { fake, connector }
}

const CANDLE_PATH = '/stock/candle'
const DAY_MS = 86_400_000

describe('candles', () => {
  it('parses the columnar {c,h,l,o,s,t,v} payload into protocol candles {t,o,h,l,c,v}', async () => {
    const { fake, connector } = make()
    const candles = await connector.candles('finnhub:AAPL', '1m', { n: 5 })

    expect(candles).toHaveLength(5)
    expect(Object.keys(candles[0]!).sort()).toEqual(['c', 'h', 'l', 'o', 't', 'v'])
    // 假服务器按 [from, to] 闭区间生成 6 根，连接器留最近 5 根
    expect(candles[0]).toEqual({ t: FX_NOW - 4 * STEP_MS, o: 101, h: 102, l: 100, c: 101.5, v: 11 })

    const call = fake.callsTo(CANDLE_PATH)[0]!
    expect(call.params.get('symbol')).toBe('AAPL')
    expect(call.params.get('resolution')).toBe('1')
  })

  it('converts the upstream second timestamps into millisecond open times', async () => {
    const fake = new FakeFinnhub()
    // 官方 t 是秒：1700000000 → 开盘毫秒 1700000000000
    fake.candles = candleSeries(1_700_000_000, 3)
    const connector = new FinnhubDataConnector({
      baseUrl: 'https://finnhub.example.test/v1', fetchImpl: fake.fetch, clock: () => FX_NOW,
      env: { FINNHUB_API_KEY: 'test-finnhub-key' },
    })
    const candles = await connector.candles('finnhub:AAPL', '1m', { n: 3 })
    expect(candles.map((c) => c.t)).toEqual([1_700_000_000_000, 1_700_000_060_000, 1_700_000_120_000])
  })

  it('clamps n to 1..5000 and returns the most recent candles ascending', async () => {
    const { fake, connector } = make()
    const candles = await connector.candles('finnhub:AAPL', '1m', { n: 9999 })

    const call = fake.callsTo(CANDLE_PATH)[0]!
    expect(call.params.get('from')).toBe(String((FX_NOW - 5000 * STEP_MS) / 1000))
    expect(call.params.get('to')).toBe(String(FX_NOW / 1000))
    expect(candles).toHaveLength(5000)
    for (let i = 1; i < candles.length; i++) expect(candles[i]!.t).toBeGreaterThan(candles[i - 1]!.t)

    await connector.candles('finnhub:AAPL', '1m')
    expect(fake.callsTo(CANDLE_PATH)[1]!.params.get('from')).toBe(String((FX_NOW - 300 * STEP_MS) / 1000))
  })

  it('pages from `from` with 5000-bar time windows until it passes `to` (5000 + 1000 = 6000)', async () => {
    const { fake, connector } = make()
    const from = FX_NOW - 6000 * STEP_MS
    const to = from + 5999 * STEP_MS

    const candles = await connector.candles('finnhub:AAPL', '1m', { from, to })

    expect(candles).toHaveLength(6000)
    expect(candles[0]!.t).toBe(from)
    expect(candles[5999]!.t).toBe(to)
    expect(new Set(candles.map((c) => c.t)).size).toBe(6000)

    const calls = fake.callsTo(CANDLE_PATH)
    expect(calls).toHaveLength(2)
    expect(calls[0]!.params.get('from')).toBe(String(from / 1000))
    expect(calls[0]!.params.get('to')).toBe(String((from + 4999 * STEP_MS) / 1000))
    // 第二页从上一窗口的最后一根重新开始（重叠 1 根，按 t 去重）：cursor = windowEnd + 1 ms
    expect(calls[1]!.params.get('from')).toBe(String((from + 4999 * STEP_MS) / 1000))
    expect(calls[1]!.params.get('to')).toBe(String(to / 1000))
  })

  it('keeps paging past an empty window when only `from` is given (no silent truncation)', async () => {
    const { fake, connector } = make()
    const from = FX_NOW - 6000 * DAY_MS
    let page = 0
    fake.candles = (params: URLSearchParams) => {
      page += 1
      if (page === 1) return { s: 'no_data' }
      return candleSeries(Number(params.get('from')), 2, 86400)
    }
    const candles = await connector.candles('finnhub:AAPL', '1d', { from })
    expect(candles).toHaveLength(2)
    expect(candles.map((c) => c.t)).toEqual([from + 4999 * DAY_MS, from + 5000 * DAY_MS])
    expect(fake.callsTo(CANDLE_PATH).length).toBeGreaterThanOrEqual(2)
  })

  it('does not skip the boundary candle when `from` sits off the candle grid', async () => {
    const { fake, connector } = make()
    const gridFrom = Math.floor(FX_NOW / STEP_MS) * STEP_MS - 6000 * STEP_MS
    const from = gridFrom + 30_000 // 某分钟 +30 s，不在 K 线网格上
    fake.candles = (params: URLSearchParams) => {
      const fromSec = Number(params.get('from'))
      const toSec = Number(params.get('to'))
      const firstGridSec = Math.ceil(fromSec / STEP_SEC) * STEP_SEC
      const count = Math.max(0, Math.floor((toSec - firstGridSec) / STEP_SEC) + 1)
      return candleSeries(firstGridSec, count)
    }
    const candles = await connector.candles('finnhub:AAPL', '1m', { from })
    const boundary = gridFrom + 5000 * STEP_MS
    expect(fake.callsTo(CANDLE_PATH)).toHaveLength(2)
    expect(candles.some((c) => c.t === boundary)).toBe(true)
    expect(new Set(candles.map((c) => c.t)).size).toBe(candles.length)
  })

  it('stops at `to` without a second request when the first window already covers it', async () => {
    const { fake, connector } = make()
    const from = FX_NOW - 100 * STEP_MS
    const candles = await connector.candles('finnhub:AAPL', '1m', { from, to: from + 9 * STEP_MS })
    expect(candles).toHaveLength(10)
    expect(fake.callsTo(CANDLE_PATH)).toHaveLength(1)
  })

  it('returns nothing when `to` is before `from` and never calls HTTP', async () => {
    const { fake, connector } = make()
    await expect(connector.candles('finnhub:AAPL', '1m', { from: FX_NOW, to: FX_NOW - 1 })).resolves.toEqual([])
    expect(fake.calls).toHaveLength(0)
  })

  it('maps every supported protocol interval onto the official resolution spelling', async () => {
    const { fake, connector } = make()
    const expected: Array<[CandleInterval, string]> = [
      ['1m', '1'], ['5m', '5'], ['15m', '15'], ['30m', '30'], ['1h', '60'], ['1d', 'D'], ['1w', 'W'], ['1M', 'M'],
    ]
    for (const [interval] of expected) await connector.candles('finnhub:AAPL', interval, { n: 1 })
    expect(fake.callsTo(CANDLE_PATH).map((c) => c.params.get('resolution'))).toEqual(expected.map(([, r]) => r))
  })

  it('rejects intervals the official resolution table has no spelling for, without touching HTTP', async () => {
    const { fake, connector } = make()
    for (const interval of ['3m', '2h', '4h', '8h', '12h', '3d'] as CandleInterval[]) {
      await expect(connector.candles('finnhub:AAPL', interval)).rejects.toMatchObject({
        problem: { name: 'INVALID_PARAMS', retryable: false },
      })
    }
    expect(fake.calls).toHaveLength(0)
  })

  it('treats s = "no_data" as an empty series instead of guessing candles', async () => {
    const { fake, connector } = make()
    fake.candles = { s: 'no_data' }
    await expect(connector.candles('finnhub:AAPL', '1d', { n: 10 })).resolves.toEqual([])
  })

  it('drops rows whose columns disagree in length rather than emitting half candles', async () => {
    const fake = new FakeFinnhub()
    fake.candles = { c: [1, 2, 3], h: [1, 2], l: [1, 2], o: [1, 2], s: 'ok', t: [1_700_000_000, 1_700_000_060], v: [5, 6, 7] }
    const connector = new FinnhubDataConnector({
      baseUrl: 'https://finnhub.example.test/v1', fetchImpl: fake.fetch, clock: () => FX_NOW,
      env: { FINNHUB_API_KEY: 'test-finnhub-key' },
    })
    const candles = await connector.candles('finnhub:AAPL', '1m', { n: 5 })
    expect(candles).toHaveLength(2)
  })
})
