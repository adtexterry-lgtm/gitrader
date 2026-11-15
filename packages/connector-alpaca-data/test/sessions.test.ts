// SPDX-License-Identifier: CPAL-1.0
// 时段：sessions 全部来自 /v2/calendar（America/New_York），节假日缺席、提前收盘按接口给的当天时间判定；
// 盘前盘后另列窗口（quality flat = thin）；日历为空就失败，绝不写死开盘收盘。
import { describe, expect, it } from 'vitest'
import { AlpacaDataConnector } from '../src/connector'
import { ProblemError } from '../src/parse'
import { nyTimeString } from '../src/market'
import { nyDateString } from '../src/parse'
import { DATA_HOST, FX_NOW, FakeAlpaca, TRADING_HOST, calendarRows } from './helpers/fake-alpaca'

function make(o: Record<string, unknown> = {}): { fake: FakeAlpaca; connector: AlpacaDataConnector } {
  const fake = new FakeAlpaca()
  const connector = new AlpacaDataConnector({
    tradingBaseUrl: `http://${TRADING_HOST}`,
    dataBaseUrl: `http://${DATA_HOST}`,
    fetchImpl: fake.fetch,
    clock: () => FX_NOW,
    ...o,
  })
  return { fake, connector }
}

const NOV = { start: '2026-11-16', end: '2026-12-04' }

describe('sessions from the venue calendar', () => {
  it('builds regular windows from /v2/calendar in America/New_York (Mon–Fri 09:30–16:00)', async () => {
    const { connector } = make()
    await connector.start()
    const aapl = connector.getInstrument('alpaca:AAPL')!

    expect(aapl.sessions?.tz).toBe('America/New_York')
    const regular = aapl.sessions!.windows.filter((w) => w.quality === 'regular')
    expect(regular.map((w) => [w.days, w.from, w.to])).toEqual([
      [[1], '09:30', '16:00'], [[2], '09:30', '16:00'], [[3], '09:30', '16:00'],
      [[4], '09:30', '16:00'], [[5], '09:30', '16:00'],
    ])
  })

  it('lists pre-market and after-hours as separate thin windows', async () => {
    const { connector } = make()
    await connector.start()
    const windows = connector.getInstrument('alpaca:AAPL')!.sessions!.windows
    const thin = windows.filter((w) => w.quality === 'thin')
    expect(thin.map((w) => [w.from, w.to])).toEqual(
      expect.arrayContaining([['04:00', '09:30'], ['16:00', '20:00']]),
    )
    expect(thin).toHaveLength(10)
    // 周末没有任何窗口
    expect(windows.some((w) => w.days.some((d) => d === 0 || d === 6))).toBe(false)
  })

  it('can omit the extended-hours windows on request', async () => {
    const { connector } = make({ sessions: { extendedHours: false } })
    await connector.start()
    const windows = connector.getInstrument('alpaca:AAPL')!.sessions!.windows
    expect(windows.every((w) => w.quality === 'regular')).toBe(true)
    expect(windows).toHaveLength(5)
  })

  it('follows the calendar even when the venue session is not 09:30–16:00 (sessions are not hardcoded)', async () => {
    const fake = new FakeAlpaca()
    fake.calendar = [{ date: '2026-10-20', open: '08:00', close: '15:00' }, { date: '2026-10-21', open: '08:00', close: '15:00' }]
    const connector = new AlpacaDataConnector({
      tradingBaseUrl: `http://${TRADING_HOST}`, dataBaseUrl: `http://${DATA_HOST}`,
      fetchImpl: fake.fetch, clock: () => FX_NOW,
    })
    await connector.start()
    const windows = connector.getInstrument('alpaca:AAPL')!.sessions!.windows
    expect(windows.filter((w) => w.quality === 'regular').map((w) => [w.days, w.from, w.to])).toEqual([
      [[2], '08:00', '15:00'], [[3], '08:00', '15:00'],
    ])
    expect(connector.isOpenAt(Date.parse('2026-10-21T13:00:00Z'))).toBe(true) // 09:00 ET
  })

  it('refuses to invent sessions when the calendar comes back empty', async () => {
    const { fake, connector } = make()
    fake.calendar = []
    await expect(connector.start()).rejects.toThrow(/calendar is empty/)
  })

  it('skips market holidays because the venue calendar omits them', async () => {
    const { connector } = make()
    await connector.refreshCalendar(NOV)
    const days = connector.tradingCalendar()
    expect(days.some((d) => d.date === '2026-11-26')).toBe(false)
    expect(connector.isOpenAt(Date.parse('2026-11-26T15:00:00Z'))).toBe(false)
    expect(connector.isOpenAt(Date.parse('2026-11-25T15:00:00Z'))).toBe(true)
  })

  it('marks early closes on the calendar and closes the session at the venue close time', async () => {
    const { connector } = make()
    await connector.refreshCalendar(NOV)
    const early = connector.tradingCalendar().find((d) => d.date === '2026-11-27')!
    expect(early).toMatchObject({ open: '09:30', close: '13:00', isEarlyClose: true })

    // 2026-11-27 是 EST（UTC−5）：18:00Z = 13:00 ET（已收盘），17:00Z = 12:00 ET（仍在常规时段）
    expect(connector.isOpenAt(Date.parse('2026-11-27T18:00:00Z'))).toBe(false)
    expect(connector.isOpenAt(Date.parse('2026-11-27T17:00:00Z'))).toBe(true)
    // 周模板仍是常规 16:00 收盘（协议 sessions 装不下日期级例外）
    const friday = connector.sessionsTemplate().windows.find((w) => w.quality === 'regular' && w.days.includes(5))!
    expect(friday.to).toBe('16:00')
  })

  it('throws instead of guessing when the calendar does not cover a date', async () => {
    const { connector } = make()
    await connector.start()
    expect(() => connector.isOpenAt(Date.parse('2027-03-01T15:00:00Z'))).toThrow(/does not cover/)
  })
})

describe('clock', () => {
  it('parses /v2/clock into integer milliseconds and keeps the venue is_open flag', async () => {
    const { connector } = make()
    await connector.start()
    const clock = connector.marketClock()
    expect(clock).toEqual({
      ts: Date.parse('2026-10-21T14:00:05.123Z'),
      isOpen: true,
      nextOpen: Date.parse('2026-10-22T13:30:00Z'),
      nextClose: Date.parse('2026-10-21T20:00:00Z'),
    })
  })

  it('rejects an unloaded clock rather than returning a made-up state', () => {
    const { connector } = make()
    expect(() => connector.marketClock()).toThrow(ProblemError)
    try {
      connector.marketClock()
    } catch (e) {
      expect((e as ProblemError).problem.name).toBe('VENUE_UNAVAILABLE')
      expect((e as ProblemError).problem.retryable).toBe(true)
    }
  })

  it('rejects a clock payload with unparsable timestamps', async () => {
    const { fake, connector } = make()
    fake.clock = { timestamp: 'not-a-time', is_open: true, next_open: 'x', next_close: 'y' }
    await expect(connector.refreshMarketClock()).rejects.toThrow(/unparsable timestamps/)
  })
})

describe('New York date arithmetic', () => {
  it('attributes a UTC timestamp to the New York calendar date and local time', () => {
    expect(nyDateString(Date.parse('2026-11-27T03:00:00Z'))).toBe('2026-11-26')
    expect(nyDateString(Date.parse('2026-10-21T14:00:00Z'))).toBe('2026-10-21')
    expect(nyTimeString(Date.parse('2026-10-21T14:00:00Z'))).toBe('10:00')
    expect(nyTimeString(Date.parse('2026-11-27T18:30:00Z'))).toBe('13:30')
  })

  it('every fixture calendar row is a weekday with a plausible session', () => {
    for (const row of calendarRows()) {
      const weekday = new Date(Date.parse(`${row.date}T00:00:00Z`)).getUTCDay()
      expect(weekday, row.date).toBeGreaterThan(0)
      expect(weekday, row.date).toBeLessThan(6)
      expect(row.open < row.close, row.date).toBe(true)
    }
  })
})
