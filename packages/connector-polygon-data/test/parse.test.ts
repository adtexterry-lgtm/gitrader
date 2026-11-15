// SPDX-License-Identifier: CPAL-1.0
// 纯函数：cursor 提取（不跟随外部主机）、失败体判定、纳秒 / 毫秒判单位、ticker 页过滤、聚合坏行、
// 「本页可能还有下一页」的判定、interval 映射与根数钳制。
import { describe, expect, it } from 'vitest'
import {
  barMsOf, clampCount, cursorOf, epochMsOf, intervalSpecOf, mayHaveMore, parseAggs, parseSnapshot,
  parseTickerPage, polygonFailureOf,
} from '../src/parse'

describe('cursor and failure bodies', () => {
  it('extracts the cursor from next_url and ignores unusable urls', () => {
    expect(cursorOf('https://api.polygon.io/v3/reference/tickers?cursor=YWJj&limit=1000')).toBe('YWJj')
    expect(cursorOf('https://api.polygon.io/v3/reference/tickers?limit=1000')).toBeUndefined()
    expect(cursorOf('')).toBeUndefined()
    expect(cursorOf(undefined)).toBeUndefined()
    expect(cursorOf('not a url')).toBeUndefined()
  })

  it('recognises the documented error envelopes only', () => {
    expect(polygonFailureOf({ status: 'ERROR', error: 'Unknown API Key' })).toEqual({ status: 'ERROR', message: 'Unknown API Key' })
    expect(polygonFailureOf({ status: 'NOT_AUTHORIZED' })?.status).toBe('NOT_AUTHORIZED')
    expect(polygonFailureOf({ status: 'OK', results: [] })).toBeUndefined()
    expect(polygonFailureOf(null)).toBeUndefined()
    expect(polygonFailureOf([])).toBeUndefined()
  })
})

describe('timestamps', () => {
  it('folds nanosecond, millisecond and second epochs to milliseconds', () => {
    const ms = Date.parse('2026-10-21T13:59:58Z')
    expect(epochMsOf(ms * 1e6)).toBe(ms) // 纳秒
    expect(epochMsOf(ms)).toBe(ms) // 毫秒
    expect(epochMsOf(Math.round(ms / 1000))).toBe(ms) // 秒
    expect(Number.isNaN(epochMsOf(0))).toBe(true)
    expect(Number.isNaN(epochMsOf('x'))).toBe(true)
  })
})

describe('ticker pages', () => {
  it('keeps only stocks/us rows and maps active=false to delisted', () => {
    const now = Date.parse('2026-10-21T14:00:00Z')
    const page = parseTickerPage({
      results: [
        { ticker: 'AAPL', name: 'Apple Inc.', market: 'stocks', locale: 'us', active: true, currency_name: 'usd' },
        { ticker: 'OLD', name: 'Old', market: 'stocks', locale: 'us', active: false },
        { ticker: 'BTCUSD', name: 'Bitcoin', market: 'crypto', locale: 'global', active: true },
        { ticker: 'EURUSD', name: 'Euro', market: 'fx', locale: 'global', active: true },
        { name: 'no ticker', market: 'stocks', locale: 'us' },
      ],
      next_url: 'https://api.polygon.io/v3/reference/tickers?cursor=NEXT',
    }, now)

    expect(page.instruments.map((i) => i.symbol)).toEqual(['AAPL', 'OLD'])
    expect(page.instruments[0]).toMatchObject({ quote: 'USD', settle: 'USD', status: 'trading' })
    expect(page.instruments[1]!.status).toBe('delisted')
    expect(page.cursor).toBe('NEXT')
  })

  it('rejects a payload that is not an object instead of silently returning nothing', () => {
    expect(() => parseTickerPage('nope', 0)).toThrow(/is not an object/)
    expect(parseTickerPage({}, 0)).toEqual({ instruments: [], cursor: undefined })
  })
})

describe('aggregates', () => {
  it('skips malformed rows, sorts ascending and fills vwap when present', () => {
    const candles = parseAggs({
      results: [
        { o: 3, h: 4, l: 2, c: 3.5, v: 10, t: 3000, vw: 3.2 },
        { o: 1, h: 2, l: 0.5, c: 1.5, v: 10, t: 1000 },
        { o: 'x', h: 2, l: 0.5, c: 1.5, v: 10, t: 2000 },
        { o: 1, h: 2, l: 0.5, c: 1.5, v: 10, t: 0 },
      ],
    })
    expect(candles.map((c) => c.t)).toEqual([1000, 3000])
    expect(candles[1]!.vwap).toBe(3.2)
    expect(candles[0]!.vwap).toBeUndefined()
  })

  it('treats a page as possibly having more only when it is full', () => {
    expect(mayHaveMore({ resultsCount: 3 }, 3, 50_000)).toBe(false)
    expect(mayHaveMore({ resultsCount: 50_000 }, 50_000, 50_000)).toBe(true)
    expect(mayHaveMore({}, 50_000, 50_000)).toBe(true)
    expect(mayHaveMore({ resultsCount: 1 }, 1, 50_000)).toBe(false)
  })

  it('returns no candles for an object without results', () => {
    expect(parseAggs({ status: 'OK' })).toEqual([])
    expect(() => parseAggs('nope')).toThrow(/is not an object/)
  })
})

describe('snapshot parsing', () => {
  it('prefers the quote timestamp over the (later) updated field', () => {
    const quoteTs = Date.parse('2026-10-21T13:59:58Z')
    const snap = parseSnapshot({
      ticker: {
        updated: Date.parse('2026-10-21T13:59:59Z') * 1e6,
        lastQuote: { p: 202.5, P: 202.55, s: 2, S: 3, t: quoteTs * 1e6 },
      },
    })
    expect(snap?.ts).toBe(quoteTs)
    expect(snap).toMatchObject({ bid: 202.5, ask: 202.55, bidSize: 2, askSize: 3 })
  })

  it('returns undefined when a side of the book is missing or non-positive', () => {
    expect(parseSnapshot({ ticker: { lastQuote: { p: 0, P: 1, t: 1e18 } } })).toBeUndefined()
    expect(parseSnapshot({ ticker: { lastQuote: { p: 1, t: 1e18 } } })).toBeUndefined()
    expect(parseSnapshot({ ticker: {} })).toBeUndefined()
    expect(parseSnapshot({})).toBeUndefined()
    expect(parseSnapshot(null)).toBeUndefined()
  })
})

describe('interval mapping and counts', () => {
  it('maps every protocol interval and rejects an unknown one', () => {
    expect(intervalSpecOf('3d')).toEqual({ multiplier: 3, timespan: 'day' })
    expect(intervalSpecOf('12h')).toEqual({ multiplier: 12, timespan: 'hour' })
    expect(barMsOf('1m')).toBe(60_000)
    expect(barMsOf('4h')).toBe(4 * 3_600_000)
    expect(barMsOf('1w')).toBe(7 * 86_400_000)
    expect(barMsOf('1M')).toBe(30 * 86_400_000)
    expect(() => intervalSpecOf('2w' as never)).toThrow(/unsupported candle interval for polygon/)
  })

  it('clamps the recent count to 1..50000 with a default of 300', () => {
    expect(clampCount(undefined)).toBe(300)
    expect(clampCount(0)).toBe(1)
    expect(clampCount(1_000_000)).toBe(50_000)
    expect(clampCount(42.7)).toBe(42)
  })
})
