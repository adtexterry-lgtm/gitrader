// SPDX-License-Identifier: CPAL-1.0
// 时段（美股八条第 1、2 条）：日历驱动、时区换算、提前收盘、休市 / 节假日、下一开盘。
// 期望的 epoch 全部手算：2026-10-21 09:30 America/New_York（EDT，UTC-4）= 2026-10-21T13:30Z = 1792589400000。
import { describe, expect, it } from 'vitest'
import {
  buildSessions, describeSession, emptyCalendar, formatClock, parseCalendar, parseClock, sessionStateAt, wallClock, zonedToUtc,
} from '../src/sessions'
import { calendarRows } from './helpers/fake-alpaca'

const NOW = 1_792_591_200_000 // 2026-10-21T14:00Z = 10:00 ET
const OPEN_21 = 1_792_589_400_000 // 2026-10-21T13:30Z = 09:30 ET
const PRE_21 = 1_792_587_600_000 // 13:00Z = 09:00 ET
const POST_21 = 1_792_614_600_000 // 20:30Z = 16:30 ET
const CLOSED_21 = 1_792_627_200_000 // 2026-10-22T00:00Z = 20:00 ET（收盘后）
const OPEN_22 = 1_792_675_800_000 // 2026-10-22T13:30Z = 09:30 ET
const SATURDAY = 1_792_850_400_000 // 2026-10-24T14:00Z = 10:00 ET 周六
const MONDAY_OPEN = 1_793_021_400_000 // 2026-10-26T13:30Z = 09:30 ET
const WINTER_OPEN = 1_793_629_800_000 // 2026-11-02T14:30Z = 09:30 EST（标准时）

const calendar = () => parseCalendar(calendarRows(), 'America/New_York', NOW)

describe('时区换算（America/New_York，含夏令时）', () => {
  it('常规时段的墙钟（EDT）', () => {
    const w = wallClock(NOW)
    expect(w.date).toBe('2026-10-21')
    expect(w.hour).toBe(10)
    expect(w.minute).toBe(0)
    expect(w.minutes).toBe(600)
  })
  it('盘前 09:00 的墙钟', () => {
    expect(wallClock(PRE_21).minutes).toBe(540)
  })
  it('收盘 16:00 的墙钟', () => {
    expect(wallClock(1_792_612_800_000).minutes).toBe(960)
  })
  it('夏令时结束那一小时：01:30 EDT 与 01:30 EST 都读成 01:30', () => {
    expect(wallClock(1_793_511_000_000).minutes).toBe(90)
    expect(wallClock(1_793_514_600_000).minutes).toBe(90)
  })
  it('标准时的 09:30（EST，UTC-5）', () => {
    expect(wallClock(WINTER_OPEN).date).toBe('2026-11-02')
    expect(wallClock(WINTER_OPEN).minutes).toBe(570)
  })
  it('zonedToUtc：夏令时日的 09:30 → 13:30Z', () => {
    expect(zonedToUtc('2026-10-21', 570)).toBe(OPEN_21)
  })
  it('zonedToUtc：标准时日的 09:30 → 14:30Z', () => {
    expect(zonedToUtc('2026-11-02', 570)).toBe(WINTER_OPEN)
  })
  it('zonedToUtc 拒绝坏日期', () => {
    expect(() => zonedToUtc('21-10-2026', 570)).toThrow(/bad calendar date/)
  })
})

describe('时钟字符串', () => {
  it('parseClock 正常值', () => {
    expect(parseClock('09:30')).toBe(570)
    expect(parseClock('4:00')).toBe(240)
    expect(parseClock('20:00')).toBe(1200)
  })
  it('parseClock 拒绝越界 / 空值 / 乱码', () => {
    expect(parseClock('24:00')).toBeNull()
    expect(parseClock('09:60')).toBeNull()
    expect(parseClock('')).toBeNull()
    expect(parseClock(null)).toBeNull()
    expect(parseClock('9:5')).toBeNull()
  })
  it('formatClock 与 parseClock 互逆', () => {
    expect(formatClock(570)).toBe('09:30')
    expect(formatClock(1200)).toBe('20:00')
    expect(parseClock(formatClock(931))).toBe(931)
  })
})

describe('交易日历解析', () => {
  it('按日期排序并带上时区', () => {
    const cal = calendar()
    expect(cal.tz).toBe('America/New_York')
    expect(cal.days[0]?.date).toBe('2026-10-19')
    expect(cal.days[cal.days.length - 1]?.date).toBe('2026-10-26')
  })
  it('提前收盘日原样保留 13:00', () => {
    const cal = calendar()
    expect(cal.days.find((d) => d.date === '2026-10-22')?.close).toBe('13:00')
  })
  it('不是数组 → 抛（不把坏响应当成空日历）', () => {
    expect(() => parseCalendar({ calendar: [] })).toThrow(/not an array/)
  })
  it('坏日期行 → 抛', () => {
    expect(() => parseCalendar([{ date: '2026/10/21', open: '09:30', close: '16:00' }])).toThrow(/no usable date/)
  })
  it('坏时间行 → 抛', () => {
    expect(() => parseCalendar([{ date: '2026-10-21', open: '9:30am', close: '16:00' }])).toThrow(/unusable open\/close/)
  })
})

describe('时段判定', () => {
  const cal = calendar()
  it('10:00 ET → regular', () => {
    const state = sessionStateAt(NOW, cal)
    expect(state.phase).toBe('regular')
    expect(state.tradingDay).toBe(true)
    expect(state.openMinute).toBe(570)
    expect(state.closeMinute).toBe(960)
  })
  it('09:00 ET → pre', () => {
    expect(sessionStateAt(PRE_21, cal).phase).toBe('pre')
  })
  it('04:00 ET 刚开盘前时段', () => {
    expect(sessionStateAt(1_792_569_600_000, cal).phase).toBe('pre')
  })
  it('03:59 ET → closed（盘前还没开始）', () => {
    expect(sessionStateAt(1_792_569_600_000 - 60_000, cal).phase).toBe('closed')
  })
  it('16:30 ET → post', () => {
    expect(sessionStateAt(POST_21, cal).phase).toBe('post')
  })
  it('20:00 ET → closed（盘后结束）', () => {
    expect(sessionStateAt(CLOSED_21, cal).phase).toBe('closed')
  })
  it('周六 → closed 且不是交易日', () => {
    const state = sessionStateAt(SATURDAY, cal)
    expect(state.phase).toBe('closed')
    expect(state.tradingDay).toBe(false)
    expect(state.openMinute).toBeNull()
  })
  it('日历里没有的日期（节假日）→ closed', () => {
    const state = sessionStateAt(1_793_511_000_000, cal)
    expect(state.phase).toBe('closed')
    expect(state.tradingDay).toBe(false)
  })
  it('提前收盘日：13:30 → post 且 earlyClose=true', () => {
    const state = sessionStateAt(1_792_690_200_000, cal) // 2026-10-22T17:30Z = 13:30 ET
    expect(state.phase).toBe('post')
    expect(state.earlyClose).toBe(true)
  })
  it('下一开盘：常规时段内指向次日 09:30', () => {
    expect(sessionStateAt(NOW, cal).nextOpenMs).toBe(OPEN_22)
  })
  it('下一开盘：盘前指向当日 09:30（含距离）', () => {
    const state = sessionStateAt(PRE_21, cal)
    expect(state.nextOpenMs).toBe(OPEN_21)
    expect(state.msToNextOpen).toBe(OPEN_21 - PRE_21)
  })
  it('下一开盘：周五之后跳到周一', () => {
    expect(sessionStateAt(SATURDAY, cal).nextOpenMs).toBe(MONDAY_OPEN)
  })
  it('空日历 → 任何时刻都 closed（fail closed）', () => {
    const state = sessionStateAt(NOW, emptyCalendar())
    expect(state.phase).toBe('closed')
    expect(state.tradingDay).toBe(false)
    expect(state.nextOpenMs).toBeNull()
  })
  it('describeSession 说清阶段与下一次开盘', () => {
    const text = describeSession(sessionStateAt(NOW, cal))
    expect(text).toContain('regular')
    expect(text).toContain('2026-10-21')
    expect(text).toContain('next regular open')
  })
})

describe('sessions 窗口（Instrument.sessions）', () => {
  it('三段窗口：盘前 / 常规 / 盘后', () => {
    const sessions = buildSessions(calendar())
    expect(sessions.tz).toBe('America/New_York')
    expect(sessions.windows).toHaveLength(3)
    expect(sessions.windows[0]?.from).toBe('04:00')
    expect(sessions.windows[0]?.quality).toBe('thin')
    expect(sessions.windows[1]?.from).toBe('09:30')
    expect(sessions.windows[1]?.to).toBe('16:00')
    expect(sessions.windows[1]?.quality).toBe('regular')
    expect(sessions.windows[2]?.to).toBe('20:00')
  })
  it('提前收盘日不把常规收盘平均成 15:30（取最常见值）', () => {
    expect(buildSessions(calendar()).windows[1]?.to).toBe('16:00')
  })
  it('星期集合来自日历（周一至周五）', () => {
    expect(buildSessions(calendar()).windows[0]?.days).toEqual([1, 2, 3, 4, 5])
  })
  it('空日历退化为周一至周五 + 09:30-16:00（仍不写死交易日）', () => {
    const sessions = buildSessions(emptyCalendar())
    expect(sessions.windows[1]?.from).toBe('09:30')
    expect(sessions.windows[0]?.days).toEqual([1, 2, 3, 4, 5])
  })
})
