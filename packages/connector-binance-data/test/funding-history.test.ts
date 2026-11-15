// SPDX-License-Identifier: CPAL-1.0
// 资金费历史（/fapi/v1/fundingRate，公开只读）：解析、按 1000 条翻页、坏行跳过、页间隔、上游错误原样抛。
import { describe, expect, it } from 'vitest'
import { BinanceDataConnector } from '../src/connector'
import { FUNDING_PAGE, FUNDING_PAGE_GAP_MS, ProblemError, parseFundingRates } from '../src/parse'
import { FakeBinance, FX_NOW } from './helpers/fake-binance'

const H8 = 28_800_000
const ID = 'binance:BTCUSDT'
const row = (t: number, rate = '0.00010000') => ({ symbol: 'BTCUSDT', fundingTime: t, fundingRate: rate, markPrice: '100.0' })

function make(over: { gap?: number } = {}) {
  const fake = new FakeBinance()
  const connector = new BinanceDataConnector({ baseUrl: 'https://fapi.example.test', fetchImpl: fake.fetch, clock: () => FX_NOW, fundingPageGapMs: over.gap ?? 0 })
  return { fake, connector }
}

describe('fundingHistory', () => {
  it('parses rows into points {instrumentId,t,rate} ascending, and asks the public endpoint with symbol/startTime/endTime/limit', async () => {
    const { fake, connector } = make()
    const from = FX_NOW - 5 * H8
    fake.override.set('/fapi/v1/fundingRate', () => [row(from + 2 * H8, '-0.00020000'), row(from, '0.00010000'), row(from + H8, '0.00005')])

    const points = await connector.fundingHistory(ID, { from, to: FX_NOW })

    expect(points).toEqual([
      { instrumentId: ID, t: from, rate: '0.0001' },
      { instrumentId: ID, t: from + H8, rate: '0.00005' },
      { instrumentId: ID, t: from + 2 * H8, rate: '-0.0002' },
    ])
    const call = fake.callsTo('/fapi/v1/fundingRate')[0]!
    expect(call.params.get('symbol')).toBe('BTCUSDT')
    expect(call.params.get('startTime')).toBe(String(from))
    expect(call.params.get('endTime')).toBe(String(FX_NOW))
    expect(call.params.get('limit')).toBe(String(FUNDING_PAGE))
    expect(fake.calls.every((c) => c.path === '/fapi/v1/fundingRate')).toBe(true)
  })

  it('pages with a last-time + 1 cursor until the page is short (1000 + 250), no duplicates', async () => {
    const { fake, connector } = make()
    const from = 1_700_000_000_000
    const total = FUNDING_PAGE + 250
    fake.override.set('/fapi/v1/fundingRate', (params) => {
      const start = Number(params.get('startTime'))
      const index = Math.ceil((start - from) / H8)
      const count = Math.max(0, Math.min(FUNDING_PAGE, total - index))
      return Array.from({ length: count }, (_, i) => row(from + (index + i) * H8))
    })

    const points = await connector.fundingHistory(ID, { from, to: from + total * H8 })

    expect(points).toHaveLength(total)
    expect(points[0]!.t).toBe(from)
    expect(points[total - 1]!.t).toBe(from + (total - 1) * H8)
    expect(new Set(points.map((p) => p.t)).size).toBe(total)
    expect(fake.callsTo('/fapi/v1/fundingRate')).toHaveLength(2)
  })

  it('keeps only points inside [from, to] and skips rows with a bad time or rate', async () => {
    const { fake, connector } = make()
    const from = FX_NOW - 3 * H8
    fake.override.set('/fapi/v1/fundingRate', () => [
      row(from - H8), row(from), { symbol: 'BTCUSDT', fundingTime: from + H8, fundingRate: 'oops' }, { symbol: 'BTCUSDT', fundingRate: '0.0001' }, row(from + 2 * H8), row(FX_NOW + H8),
    ])
    const points = await connector.fundingHistory(ID, { from, to: FX_NOW })
    expect(points.map((p) => p.t)).toEqual([from, from + 2 * H8])
  })

  it('an empty answer is an empty list, not an error', async () => {
    const { fake, connector } = make()
    fake.override.set('/fapi/v1/fundingRate', () => [])
    expect(await connector.fundingHistory(ID, { from: FX_NOW - H8, to: FX_NOW })).toEqual([])
  })

  it('waits between pages (public market data stays at or under 2 requests per second)', async () => {
    expect(FUNDING_PAGE_GAP_MS).toBeGreaterThanOrEqual(500)
    const { fake, connector } = make({ gap: 80 })
    const from = 1_700_000_000_000
    fake.override.set('/fapi/v1/fundingRate', (params) => {
      const start = Number(params.get('startTime'))
      return start === from ? Array.from({ length: FUNDING_PAGE }, (_, i) => row(from + i * H8)) : [row(start)]
    })
    const started = Date.now()
    const points = await connector.fundingHistory(ID, { from, to: from + (FUNDING_PAGE + 5) * H8 })
    expect(fake.callsTo('/fapi/v1/fundingRate')).toHaveLength(2)
    expect(Date.now() - started).toBeGreaterThanOrEqual(70)
    expect(points).toHaveLength(FUNDING_PAGE + 1)
  })

  it('an upstream failure is thrown as the venue problem (the host then falls back, nothing is invented)', async () => {
    const { fake, connector } = make()
    fake.override.set('/fapi/v1/fundingRate', () => new Response('nope', { status: 500 }))
    await expect(connector.fundingHistory(ID, { from: FX_NOW - H8, to: FX_NOW })).rejects.toBeInstanceOf(ProblemError)
  })

  it('parseFundingRates: non-array input is an empty list', () => {
    expect(parseFundingRates(undefined, ID)).toEqual([])
    expect(parseFundingRates({ code: -1121 }, ID)).toEqual([])
  })
})
