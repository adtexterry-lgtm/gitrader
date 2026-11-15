// SPDX-License-Identifier: CPAL-1.0
// K 线：官方 9 个 period 的映射、秒 → 开盘毫秒、amount（币）优先与 vol（张）回落、
// n 钳位、有 from 的窗口翻页（官方不允许 from/to 与 size 同用，一页 ≤2000 根）、非法区间拒绝。
import { describe, expect, it } from 'vitest'
import type { CandleInterval } from '@gitrader/protocol'
import { HtxDataConnector } from '../src/connector'
import { FakeHtx, FX_NOW, FX_SECOND, KLINE_EXAMPLE, STEP_MS, klineRow, klineRows } from './helpers/fake-htx'

const KLINE = '/linear-swap-ex/market/history/kline'

function make() {
  const fake = new FakeHtx()
  const connector = new HtxDataConnector({ baseUrl: 'https://htx.example.test', fetchImpl: fake.fetch, clock: () => FX_NOW })
  return { fake, connector }
}

describe('candles', () => {
  it('parses the documented kline row and converts the id from seconds to open milliseconds', async () => {
    const { fake, connector } = make()
    fake.klineSource = () => [KLINE_EXAMPLE]
    const candles = await connector.candles('htx:BTC-USDT', '1m', { n: 1 })

    expect(candles).toEqual([{ t: KLINE_EXAMPLE.id * 1000, o: 13076.8, h: 13076.8, l: 13076.8, c: 13076.8, v: 0.004 }])

    const call = fake.callsTo(KLINE)[0]!
    expect(call.params.get('contract_code')).toBe('BTC-USDT')
    expect(call.params.get('period')).toBe('1min')
    expect(call.params.get('size')).toBe('1')
    expect(call.params.get('from')).toBeNull()
    expect(call.params.get('to')).toBeNull()
  })

  it('falls back to vol (contracts) × contract_size when the coin amount is missing', async () => {
    const { fake, connector } = make()
    // BTC-USDT 一张 = 0.001；ETH-USDT 一张 = 0.01
    fake.klineSource = () => [{ ...KLINE_EXAMPLE, amount: undefined, vol: 4 }]
    const btc = await connector.candles('htx:BTC-USDT', '1m', { n: 1 })
    const eth = await connector.candles('htx:ETH-USDT', '1m', { n: 1 })
    expect(btc[0]!.v).toBe(0.004)
    expect(eth[0]!.v).toBe(0.04)
  })

  it('defaults to 300 candles and clamps n into 1..2000', async () => {
    const { fake, connector } = make()
    const series = klineRows(FX_SECOND - 2100 * 60, 2100)
    fake.klineSource = (params) => series.slice(-Number(params.get('size')))

    const big = await connector.candles('htx:BTC-USDT', '1m', { n: 9999 })
    const dflt = await connector.candles('htx:BTC-USDT', '1m')
    const zero = await connector.candles('htx:BTC-USDT', '1m', { n: 0 })

    expect(fake.callsTo(KLINE).map((c) => c.params.get('size'))).toEqual(['2000', '300', '1'])
    expect(big).toHaveLength(2000)
    expect(dflt).toHaveLength(300)
    expect(zero).toHaveLength(1)
    expect(big[big.length - 1]!.t).toBe(FX_SECOND * 1000 - 60_000)
  })

  it('sorts ascending and de-duplicates by open time', async () => {
    const { fake, connector } = make()
    const t1 = FX_SECOND - 120
    const t2 = FX_SECOND - 60
    fake.klineSource = () => [
      klineRow(t2, 200),
      klineRow(t1, 100),
      { ...klineRow(t2, 200), close: 201 },
    ]
    const candles = await connector.candles('htx:BTC-USDT', '1m', { n: 3 })
    expect(candles.map((c) => c.t)).toEqual([t1 * 1000, t2 * 1000])
    expect(candles[1]!.c).toBe(201)
  })

  it('pages a from/to range in ≤2000-candle windows without sending size', async () => {
    const { fake, connector } = make()
    const total = 2500
    const fromSec = FX_SECOND - total * 60
    const from = fromSec * 1000
    const to = (fromSec + (total - 1) * 60) * 1000 + 59_999
    fake.klineSource = (params) => {
      const start = Math.floor(Number(params.get('from')))
      const end = Math.floor(Number(params.get('to')))
      return klineRows(start, Math.min(2000, Math.floor((end - start) / 60) + 1))
    }

    const candles = await connector.candles('htx:BTC-USDT', '1m', { from, to })

    expect(candles).toHaveLength(total)
    expect(candles[0]!.t).toBe(from)
    expect(candles[total - 1]!.t).toBe(fromSec * 1000 + (total - 1) * 60_000)
    expect(new Set(candles.map((c) => c.t)).size).toBe(total)
    for (let i = 1; i < candles.length; i++) expect(candles[i]!.t).toBeGreaterThan(candles[i - 1]!.t)

    const calls = fake.callsTo(KLINE)
    expect(calls).toHaveLength(2)
    expect(calls[0]!.params.get('from')).toBe(String(fromSec))
    expect(calls[0]!.params.get('to')).toBe(String(fromSec + 1999 * 60))
    expect(calls[1]!.params.get('from')).toBe(String(fromSec + 2000 * 60))
    // to 是毫秒，客户端按秒向下取整（官方要求 from/to 用秒）
    expect(calls[1]!.params.get('to')).toBe(String(Math.floor(to / 1000)))
    for (const call of calls) {
      expect(call.params.get('size')).toBeNull() // 官方：size 与 from/to 同用时 from/to 会被忽略
      expect(call.params.get('period')).toBe('1min')
    }
  })

  it('stops at `to` within a single window and filters rows past it', async () => {
    const { fake, connector } = make()
    const fromSec = FX_SECOND - 600 * 60
    const toSec = fromSec + 99 * 60
    fake.klineSource = (params) => {
      const start = Math.floor(Number(params.get('from')))
      // 故意多给 10 根，客户端必须按 to 过滤
      return klineRows(start, 110)
    }
    const candles = await connector.candles('htx:BTC-USDT', '1m', { from: fromSec * 1000, to: toSec * 1000 })
    expect(candles).toHaveLength(100)
    expect(candles[candles.length - 1]!.t).toBe(toSec * 1000)
    expect(fake.callsTo(KLINE)).toHaveLength(1)
  })

  it('fills `to` with the clock when only `from` is given (venue requires from and to together)', async () => {
    const { fake, connector } = make()
    fake.klineSource = () => []
    await connector.candles('htx:BTC-USDT', '1m', { from: (FX_SECOND - 60) * 1000 })
    const call = fake.callsTo(KLINE)[0]!
    expect(call.params.get('from')).toBe(String(FX_SECOND - 60))
    expect(call.params.get('to')).toBe(String(FX_SECOND))
    expect(call.params.get('size')).toBeNull()
  })

  it('returns [] without HTTP when from is after to', async () => {
    const { fake, connector } = make()
    await expect(connector.candles('htx:BTC-USDT', '1m', { from: FX_NOW, to: FX_NOW - STEP_MS })).resolves.toEqual([])
    expect(fake.calls).toHaveLength(0)
  })

  it('rejects intervals outside the documented period list without touching HTTP', async () => {
    const { fake, connector } = make()
    for (const interval of ['3m', '2h', '8h', '12h', '3d', '1w'] as CandleInterval[]) {
      await expect(connector.candles('htx:BTC-USDT', interval)).rejects.toMatchObject({
        problem: { name: 'INVALID_PARAMS', retryable: false },
      })
    }
    expect(fake.calls).toHaveLength(0)
  })

  it('maps every supported protocol interval onto the documented HTX period spelling', async () => {
    const { fake, connector } = make()
    fake.klineSource = () => [KLINE_EXAMPLE]
    const intervals: CandleInterval[] = ['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1M']
    for (const interval of intervals) await connector.candles('htx:BTC-USDT', interval, { n: 1 })
    const sent = fake.callsTo(KLINE).map((c) => c.params.get('period'))
    expect(sent).toEqual(['1min', '5min', '15min', '30min', '60min', '4hour', '1day', '1mon'])
  })
})
