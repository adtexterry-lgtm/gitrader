// SPDX-License-Identifier: CPAL-1.0
// 时段（八条 1 / 2）：从 IB 的 tradingHours / liquidHours 生成 sessions，节假日与提前收盘都按日历读。
import { describe, expect, it } from 'vitest'
import { buildSessions, localClock, parseHours, sessionStatus, weekdayOf } from '../src/calendar'
import { CLOSED, HOLIDAY, NOW, POST_MARKET, PRE_MARKET } from './helpers/harness'

const HOURS = '20261021:0400-20261021:2000;20261022:0400-20261022:2000;20261023:0400-20261023:2000;20261024:CLOSED;'
const LIQUID = '20261021:0930-20261021:1600;20261022:0930-20261022:1600;20261023:0930-20261023:1600;'

describe('calendar · 解析场所日历', () => {
  it('解析可交易窗口', () => {
    const days = parseHours('20261021:0400-20261021:2000;')
    expect(days).toEqual([{ date: '20261021', closed: false, startMin: 240, endMin: 1200 }])
  })

  it('CLOSED 日记成休市日', () => {
    expect(parseHours('20261024:CLOSED;')).toEqual([{ date: '20261024', closed: true, startMin: 0, endMin: 0 }])
  })

  it('无法识别的片段跳过（不猜）', () => {
    expect(parseHours('garbage;20261021:2600-20261021:2700;')).toEqual([])
  })

  it('跨交易日窗口丢掉（本包不猜）', () => {
    expect(parseHours('20261021:2000-20261022:0400;')).toEqual([])
  })

  it('weekdayOf：2026-10-21 是周三（3）', () => {
    expect(weekdayOf('20261021')).toBe(3)
    expect(weekdayOf('20261024')).toBe(6)
  })

  it('localClock 用 ICU 换算到 America/New_York（10 月是 EDT）', () => {
    const c = localClock(NOW, 'America/New_York')
    expect(c.minutes).toBe(10 * 60 + 30)
    expect(c.date).toBe('20261021')
    expect(c.weekday).toBe(3)
  })
})

describe('calendar · 生成 sessions', () => {
  const sessions = buildSessions(HOURS, LIQUID, 'America/New_York')

  it('常规时段是液体时段 09:30-16:00', () => {
    const regular = sessions.windows.filter((w) => w.quality === 'regular')
    // 三天的数据：每天一条常规窗口（周三 / 周四 / 周五各一条）
    expect(regular.map((w) => `${w.from}-${w.to}`)).toEqual(['09:30-16:00', '09:30-16:00', '09:30-16:00'])
    expect(new Set(regular.flatMap((w) => w.days)).size).toBe(3)
  })

  it('盘前盘后是 thin 窗口（04:00-09:30 / 16:00-20:00）', () => {
    const thin = sessions.windows.filter((w) => w.quality === 'thin').map((w) => `${w.from}-${w.to}`)
    expect(thin).toContain('04:00-09:30')
    expect(thin).toContain('16:00-20:00')
  })

  it('同一 weekday + 同一窗口只出现一次（三天数据 = 9 条，不重复累积）', () => {
    expect(sessions.windows.length).toBe(9)
    const keys = sessions.windows.map((w) => `${w.days.join(',')}|${w.from}|${w.to}|${w.quality}`)
    expect(new Set(keys).size).toBe(9)
  })

  it('节假日记进 closedDates', () => {
    expect(sessions.closedDates).toEqual(['20261024'])
  })

  it('提前收盘按当天 liquidHours 原样反映（15:00 收）', () => {
    const early = buildSessions('20261125:0400-20261125:2000;', '20261125:0930-20261125:1500;', 'America/New_York')
    const regular = early.windows.find((w) => w.quality === 'regular')
    expect(regular?.to).toBe('15:00')
  })

  it('没有液体时段时整段算 thin', () => {
    const only = buildSessions('20261021:0400-20261021:0800;', '', 'America/New_York')
    expect(only.windows.every((w) => w.quality === 'thin')).toBe(true)
  })
})

describe('calendar · 时段判定（八条 1 / 2 的依据）', () => {
  const sessions = buildSessions(HOURS, LIQUID, 'America/New_York')

  it('常规时段内 → regular', () => {
    expect(sessionStatus(sessions, NOW).state).toBe('regular')
  })

  it('盘前 → extended（thin 窗口）', () => {
    expect(sessionStatus(sessions, PRE_MARKET).state).toBe('extended')
  })

  it('盘后 → extended', () => {
    expect(sessionStatus(sessions, POST_MARKET).state).toBe('extended')
  })

  it('收盘后（21:00）→ closed', () => {
    const s = sessionStatus(sessions, CLOSED)
    expect(s.state).toBe('closed')
  })

  it('场所日历标 CLOSED 的日子 → closed（节假日）', () => {
    const s = sessionStatus(sessions, HOLIDAY)
    expect(s.state).toBe('closed')
    expect(s.reason).toContain('holiday')
  })

  it('状态里带场所本地时间（诊断用）', () => {
    expect(sessionStatus(sessions, NOW).clock.minutes).toBe(630)
  })
})
