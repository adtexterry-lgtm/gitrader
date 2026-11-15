// SPDX-License-Identifier: CPAL-1.0
// K 线：倒序翻转成升序、n 钳到 300、bar 大写映射、history-candles 按 100/页 + after 游标向前翻页、非法区间拒绝。
// v 一律是币数量：vol（张）× ctVal 折成币；拿不到 ctVal 才回落 volCcy（上游的币数量列）。
import { describe, expect, it } from 'vitest'
import type { CandleInterval } from '@gitrader/protocol'
import { OkxDataConnector } from '../src/connector'
import { FakeOkx, FX_NOW, STEP_MS, candleRows } from './helpers/fake-okx'

function make() {
  const fake = new FakeOkx()
  const connector = new OkxDataConnector({ baseUrl: 'http://okx.example.test', fetchImpl: fake.fetch, clock: () => FX_NOW })
  return { fake, connector }
}

describe('candles', () => {
  it('flips the venue descending payload into ascending {t,o,h,l,c,v} with v in base units', async () => {
    const { fake, connector } = make()
    const from = FX_NOW - 5 * STEP_MS
    fake.candleRows = candleRows(from, 5).reverse() // OKX 返回最新在前
    const candles = await connector.candles('okx:BTC-USDT-SWAP', '1m', { n: 5 })

    expect(candles).toHaveLength(5)
    // 夹具：10 张 × ctVal 0.01 = 0.1 BTC（不是 10 张）
    expect(candles[0]).toEqual({ t: from, o: 100, h: 101, l: 99, c: 100.5, v: 0.1 })
    expect(Object.keys(candles[0]!).sort()).toEqual(['c', 'h', 'l', 'o', 't', 'v'])
    for (let i = 1; i < candles.length; i++) expect(candles[i]!.t).toBeGreaterThan(candles[i - 1]!.t)

    const call = fake.callsTo('/api/v5/market/candles')[0]!
    expect(call.params.get('instId')).toBe('BTC-USDT-SWAP')
    expect(call.params.get('bar')).toBe('1m')
    expect(call.params.get('limit')).toBe('5')
    expect(call.params.get('after')).toBeNull()
  })

  it("folds 张 into base with each contract's own ctVal, ignoring the volCcy column", async () => {
    const { fake, connector } = make()
    // ETH-USDT-SWAP 的 ctVal = 0.1：10 张 → 1 ETH；BTC 的 ctVal = 0.01：10 张 → 0.1 BTC
    fake.candleRows = [
      [String(FX_NOW), '100', '101', '99', '100.5', '10', '9999', '999900', '1'],
      [String(FX_NOW - STEP_MS), '100', '101', '99', '100.5', '10', '9999', '999900', '1'],
    ]
    const btc = await connector.candles('okx:BTC-USDT-SWAP', '1m', { n: 2 })
    const eth = await connector.candles('okx:ETH-USDT-SWAP', '1m', { n: 2 })

    // volCcy 列故意写成 9999：折币只看 ctVal，证明没有照抄 volCcy
    expect(btc.map((c) => c.v)).toEqual([0.1, 0.1])
    expect(eth.map((c) => c.v)).toEqual([1, 1])
  })

  it('falls back to the venue volCcy column when the instrument (ctVal) is unknown', async () => {
    const { fake, connector } = make()
    fake.candleRows = [[String(FX_NOW), '100', '101', '99', '100.5', '10', '1234', '123400', '1']]
    const candles = await connector.candles('okx:NOPE-USDT-SWAP', '1m', { n: 1 })

    expect(candles).toHaveLength(1)
    expect(candles[0]!.v).toBe(1234)
  })

  it('clamps n to 1..300 and defaults to 300', async () => {
    const { fake, connector } = make()
    fake.candleRows = candleRows(FX_NOW - 300 * STEP_MS, 300)
    const candles = await connector.candles('okx:BTC-USDT-SWAP', '1m', { n: 9999 })

    expect(fake.callsTo('/api/v5/market/candles')[0]!.params.get('limit')).toBe('300')
    expect(candles).toHaveLength(300)
    expect(candles[299]!.t).toBe(FX_NOW - STEP_MS)

    await connector.candles('okx:BTC-USDT-SWAP', '1m')
    expect(fake.callsTo('/api/v5/market/candles')[1]!.params.get('limit')).toBe('300')
  })

  it('pages history-candles backwards with an `after` cursor, 100 per page', async () => {
    const { fake, connector } = make()
    const from = FX_NOW - 250 * STEP_MS
    const total = 250
    fake.historyRows = (params) => {
      const after = params.get('after')
      const limit = Number(params.get('limit'))
      const cutoff = after === null ? Number.POSITIVE_INFINITY : Number(after)
      const asc = candleRows(from, total)
      const older = asc.filter((row) => Number(row[0]) < cutoff)
      return older.slice(-limit).reverse()
    }

    const candles = await connector.candles('okx:BTC-USDT-SWAP', '1m', { from })

    expect(candles).toHaveLength(250)
    expect(candles[0]!.t).toBe(from)
    expect(candles[249]!.t).toBe(from + 249 * STEP_MS)
    expect(new Set(candles.map((c) => c.t)).size).toBe(250)
    for (let i = 1; i < candles.length; i++) expect(candles[i]!.t).toBeGreaterThan(candles[i - 1]!.t)
    expect(candles.every((c) => c.v === 0.1)).toBe(true)

    const calls = fake.callsTo('/api/v5/market/history-candles')
    expect(calls).toHaveLength(3)
    expect(calls.every((c) => c.params.get('limit') === '100')).toBe(true)
    expect(calls[0]!.params.get('after')).toBeNull()
    expect(calls[1]!.params.get('after')).toBe(String(from + 150 * STEP_MS))
    expect(calls[2]!.params.get('after')).toBe(String(from + 50 * STEP_MS))
  })

  it('stops at `to` without paging further and keeps the boundary bar', async () => {
    const { fake, connector } = make()
    const from = FX_NOW - 100 * STEP_MS
    const to = from + 9 * STEP_MS
    fake.historyRows = (params) => {
      const cutoff = Number(params.get('after'))
      return candleRows(from, 100).filter((row) => Number(row[0]) < cutoff).reverse()
    }
    const candles = await connector.candles('okx:BTC-USDT-SWAP', '1m', { from, to })

    expect(candles).toHaveLength(10)
    expect(candles[9]!.t).toBe(to)
    const calls = fake.callsTo('/api/v5/market/history-candles')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.params.get('after')).toBe(String(to + 1))
  })

  it('rejects an interval that is not in the protocol table without touching HTTP', async () => {
    const { fake, connector } = make()
    await expect(connector.candles('okx:BTC-USDT-SWAP', '2m' as CandleInterval)).rejects.toMatchObject({
      problem: { name: 'INVALID_PARAMS', retryable: false },
    })
    expect(fake.calls).toHaveLength(0)
  })

  it('maps every protocol interval onto the venue bar spelling (H / D / W / M uppercase)', async () => {
    const { fake, connector } = make()
    fake.candleRows = candleRows(FX_NOW, 1)
    const intervals: CandleInterval[] = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '8h', '12h', '1d', '3d', '1w', '1M']
    for (const interval of intervals) await connector.candles('okx:BTC-USDT-SWAP', interval, { n: 1 })
    const sent = fake.callsTo('/api/v5/market/candles').map((c) => c.params.get('bar'))
    expect(sent).toEqual(['1m', '3m', '5m', '15m', '30m', '1H', '2H', '4H', '8H', '12H', '1D', '3D', '1W', '1M'])
  })
})
