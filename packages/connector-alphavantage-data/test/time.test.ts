// SPDX-License-Identifier: CPAL-1.0
// 纯函数：美东挂钟 → UTC 毫秒（独立手算期望值，夏令时两侧各一例）、美东日期 / 月份键、日 / 月推进、
// 周期映射与根数钳制、上游失败体判定。这些期望值都是按「美东 = UTC−4（EDT）/ UTC−5（EST）」手算的。
import { describe, expect, it } from 'vitest'
import {
  avFailureOf, clampCount, etDayOf, etMonthOf, etMsOf, nextDay, nextMonth, seriesSpecOf,
} from '../src/parse'

describe('eastern time conversion', () => {
  it('reads the documented intraday wall clock as EDT (UTC−4) in summer', () => {
    expect(etMsOf('2026-10-21 09:35:00')).toBe(Date.parse('2026-10-21T13:35:00Z'))
    expect(etMsOf('2026-07-01 16:00:00')).toBe(Date.parse('2026-07-01T20:00:00Z'))
  })

  it('reads the same wall clock as EST (UTC−5) after the autumn switch', () => {
    expect(etMsOf('2026-11-10 09:35:00')).toBe(Date.parse('2026-11-10T14:35:00Z'))
    expect(etMsOf('2026-01-15 09:35:00')).toBe(Date.parse('2026-01-15T14:35:00Z'))
  })

  it('treats a date-only key as midnight eastern (day / week / month series)', () => {
    expect(etMsOf('2026-10-20')).toBe(Date.parse('2026-10-20T04:00:00Z'))
    expect(etMsOf('2026-12-24')).toBe(Date.parse('2026-12-24T05:00:00Z'))
  })

  it('accepts a T separator and seconds-less input', () => {
    expect(etMsOf('2026-10-21T09:35')).toBe(Date.parse('2026-10-21T13:35:00Z'))
  })

  it('rejects a timestamp that is not a date at all', () => {
    expect(() => etMsOf('not-a-date')).toThrow(/is not a date/)
  })

  it('formats eastern day / month keys for the intraday month slice', () => {
    // 2026-10-20T03:30:00Z = 美东 2026-10-19 23:30 → 属于 10 月 19 日
    expect(etDayOf(Date.parse('2026-10-20T03:30:00Z'))).toBe('2026-10-19')
    expect(etMonthOf(Date.parse('2026-10-20T03:30:00Z'))).toBe('2026-10')
    expect(etMonthOf(Date.parse('2026-11-01T04:30:00Z'))).toBe('2026-11')
  })

  it('advances days and months across year boundaries', () => {
    expect(nextDay('2026-12-31')).toBe('2027-01-01')
    expect(nextDay('2026-02-28')).toBe('2026-03-01')
    expect(nextMonth('2026-12')).toBe('2027-01')
    expect(nextMonth('2026-01')).toBe('2026-02')
  })
})

describe('interval mapping and counts', () => {
  it('maps the eight supported intervals and rejects the rest', () => {
    expect(seriesSpecOf('5m')).toEqual({ kind: 'intraday', avInterval: '5min' })
    expect(seriesSpecOf('1h')).toEqual({ kind: 'intraday', avInterval: '60min' })
    expect(seriesSpecOf('1d')).toEqual({ kind: 'series', fn: 'TIME_SERIES_DAILY', key: 'Time Series (Daily)', period: 'day' })
    expect(seriesSpecOf('1w')).toMatchObject({ key: 'Weekly Time Series' })
    expect(seriesSpecOf('1M')).toMatchObject({ key: 'Monthly Time Series' })
    expect(() => seriesSpecOf('12h')).toThrow(/unsupported candle interval for alphavantage/)
  })

  it('clamps the recent count to 1..20000 with a default of 100', () => {
    expect(clampCount(undefined)).toBe(100)
    expect(clampCount(0)).toBe(1)
    expect(clampCount(-5)).toBe(1)
    expect(clampCount(12.9)).toBe(12)
    expect(clampCount(1_000_000)).toBe(20_000)
    expect(clampCount(Number.NaN)).toBe(100)
  })
})

describe('upstream failure bodies', () => {
  it('recognises the three documented 200-with-error bodies', () => {
    expect(avFailureOf({ 'Error Message': 'Invalid API call.' })).toEqual({ kind: 'api-error', message: 'Invalid API call.' })
    expect(avFailureOf({ Information: 'frequency is limited' })?.kind).toBe('rate-limit')
    expect(avFailureOf({ Note: 'premium only' })?.kind).toBe('rate-limit')
  })

  it('returns undefined for a normal payload, an empty object or a non-object', () => {
    expect(avFailureOf({ 'Time Series (Daily)': {} })).toBeUndefined()
    expect(avFailureOf({})).toBeUndefined()
    expect(avFailureOf(null)).toBeUndefined()
    expect(avFailureOf('ok')).toBeUndefined()
    expect(avFailureOf({ Information: '   ' })).toBeUndefined()
  })
})
