// SPDX-License-Identifier: CPAL-1.0
// 交易时段：从场所日历取，不写死（工单「美股八条」第 1 条）。
// 来源 = IB contractDetails 的 tradingHours / liquidHours / timeZoneId 字段——这就是场所日历接口：
//   · tradingHours：可交易窗口（含盘前盘后），格式 `YYYYMMDD:HHMM-YYYYMMDD:HHMM;...;YYYYMMDD:CLOSED;`
//   · liquidHours：常规流动性窗口（09:30-16:00），同格式
//   · 节假日 = 当天 tradingHours 为 CLOSED；提前收盘 = liquidHours 的结束时刻当天更短（两者都照原样读，不写死）
// 时区换算用 Intl（America/New_York），夏令时由 ICU 负责，不做手工偏移。
import type { TradingSessionWindow } from '@gitrader/protocol'

export interface SessionDay {
  /** YYYYMMDD。 */
  date: string
  closed: boolean
  /** 当天窗口的分钟数（从 00:00 起算）；跨夜窗口按两段处理（IB 极少见，本包按 [start,end) 处理）。 */
  startMin: number
  endMin: number
}

const DAY_RE = /^(\d{4})(\d{2})(\d{2})$/
const SPAN_RE = /^(\d{8}):(\d{2})(\d{2})-(\d{8}):(\d{2})(\d{2})$/

/** 解析 IB 的 hours 串。无法识别的片段跳过（不猜），CLOSED 记成 closed 日。 */
export function parseHours(text: string): SessionDay[] {
  const out: SessionDay[] = []
  for (const raw of text.split(';')) {
    const part = raw.trim()
    if (part === '') continue
    const closed = /^(\d{8}):CLOSED$/.exec(part)
    if (closed !== null) {
      if (DAY_RE.test(closed[1]!)) out.push({ date: closed[1]!, closed: true, startMin: 0, endMin: 0 })
      continue
    }
    const m = SPAN_RE.exec(part)
    if (m === null) continue
    if (m[1] !== m[4]) continue // 跨交易日窗口：本包不猜，丢掉并在 status 里表现为 closed
    const sh = Number(m[2])
    const sm = Number(m[3])
    const eh = Number(m[5])
    const em = Number(m[6])
    // 时 / 分越界的片段视为无法识别（不猜）
    if (sh > 23 || eh > 23 || sm > 59 || em > 59) continue
    const startMin = sh * 60 + sm
    const endMin = eh * 60 + em
    if (!Number.isFinite(startMin) || !Number.isFinite(endMin) || endMin <= startMin) continue
    out.push({ date: m[1]!, closed: false, startMin, endMin })
  }
  return out
}

/** YYYYMMDD → 周几（0 = 周日，与协议 TradingSessionWindow.days 一致）。 */
export function weekdayOf(date: string): number {
  const y = Number(date.slice(0, 4))
  const mo = Number(date.slice(4, 6))
  const d = Number(date.slice(6, 8))
  return new Date(Date.UTC(y, mo - 1, d)).getUTCDay()
}

const hhmm = (min: number): string => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`

export interface VenueSessions {
  tz: string
  windows: TradingSessionWindow[]
  /** YYYYMMDD 的休市日（节假日 / 停市）。 */
  closedDates: string[]
  /** 每个日期的实际窗口（提前收盘时可查）。 */
  byDate: Record<string, SessionDay[]>
}

/**
 * 由 tradingHours + liquidHours 生成协议 sessions：常规窗口取液体时段的并集（quality regular），
 * 液体时段之外的可交易部分（盘前 / 盘后）记 thin；同一 weekday + 同一时刻的窗口去重。
 */
export function buildSessions(tradingHours: string, liquidHours: string, tz: string): VenueSessions {
  const trading = parseHours(tradingHours)
  const liquid = parseHours(liquidHours)
  const liquidByDate = new Map<string, SessionDay[]>()
  for (const d of liquid) {
    if (d.closed) continue
    const list = liquidByDate.get(d.date) ?? []
    list.push(d)
    liquidByDate.set(d.date, list)
  }
  const closedDates: string[] = []
  const byDate: Record<string, SessionDay[]> = {}
  const seen = new Set<string>()
  const windows: TradingSessionWindow[] = []

  const push = (date: string, from: number, to: number, quality: 'regular' | 'thin'): void => {
    if (to <= from) return
    const day = weekdayOf(date)
    const key = `${day}|${from}|${to}|${quality}`
    if (seen.has(key)) return
    seen.add(key)
    windows.push({ days: [day], from: hhmm(from), to: hhmm(to), quality })
  }

  for (const d of trading) {
    const list = byDate[d.date] ?? []
    list.push(d)
    byDate[d.date] = list
    if (d.closed) {
      closedDates.push(d.date)
      continue
    }
    const liquidForDay = liquidByDate.get(d.date) ?? []
    if (liquidForDay.length === 0) {
      // 没有液体时段（例如盘前盘后专用日）：整段算 thin。
      push(d.date, d.startMin, d.endMin, 'thin')
      continue
    }
    let cursor = d.startMin
    for (const l of [...liquidForDay].sort((a, b) => a.startMin - b.startMin)) {
      const from = Math.max(l.startMin, d.startMin)
      const to = Math.min(l.endMin, d.endMin)
      if (from > cursor) push(d.date, cursor, from, 'thin')
      push(d.date, from, to, 'regular')
      cursor = Math.max(cursor, to)
    }
    if (cursor < d.endMin) push(d.date, cursor, d.endMin, 'thin')
  }

  return { tz, windows: dedupeWindows(windows), closedDates, byDate }
}

/** 同一 weekday 的相邻同质量窗口合并（多天数据下窗口表保持紧凑）。 */
function dedupeWindows(list: TradingSessionWindow[]): TradingSessionWindow[] {
  const map = new Map<string, TradingSessionWindow>()
  for (const w of list) {
    const key = `${w.days.join(',')}|${w.from}|${w.to}|${w.quality}`
    const prev = map.get(key)
    if (prev === undefined) map.set(key, { ...w, days: [...w.days] })
  }
  return [...map.values()].sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0))
}

/** 某个时刻在 tz 的本地时间（分钟 + 周几 + YYYYMMDD）。 */
export interface LocalClock {
  minutes: number
  weekday: number
  date: string
}

export function localClock(atMs: number, tz: string): LocalClock {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
  })
  const parts = fmt.formatToParts(new Date(atMs))
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? ''
  const year = get('year')
  const month = get('month')
  const day = get('day')
  const hour = Number(get('hour')) % 24
  const minute = Number(get('minute'))
  const weekdayName = get('weekday')
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(weekdayName)
  return {
    minutes: hour * 60 + minute,
    weekday: weekday < 0 ? 0 : weekday,
    date: `${year}${month}${day}`,
  }
}

export type SessionState = 'regular' | 'extended' | 'closed'

export interface SessionStatus {
  state: SessionState
  /** 命中的窗口（closed 时为 undefined）。 */
  window?: TradingSessionWindow
  /** 场所本地时间（诊断用）。 */
  clock: LocalClock
  reason: string
}

const toMin = (hhmmText: string): number => {
  const [h, m] = hhmmText.split(':')
  return Number(h) * 60 + Number(m ?? 0)
}

/** 判断某时刻的时段状态：closed（休市 / 节假 / 窗口外）、regular（常规）、extended（盘前盘后 thin）。 */
export function sessionStatus(sessions: VenueSessions, atMs: number): SessionStatus {
  const clock = localClock(atMs, sessions.tz)
  if (sessions.closedDates.includes(clock.date)) {
    return { state: 'closed', clock, reason: `${clock.date} is a venue holiday / closed day` }
  }
  const dayWindows = sessions.byDate[clock.date]
  if (dayWindows !== undefined) {
    const trading = dayWindows.filter((d) => !d.closed)
    if (trading.length === 0) return { state: 'closed', clock, reason: `${clock.date} has no trading window` }
    if (!trading.some((d) => clock.minutes >= d.startMin && clock.minutes < d.endMin)) {
      return { state: 'closed', clock, reason: `${clock.date} ${hhmm(clock.minutes)} is outside the venue window` }
    }
  }
  for (const w of sessions.windows) {
    if (!w.days.includes(clock.weekday)) continue
    if (clock.minutes >= toMin(w.from) && clock.minutes < toMin(w.to)) {
      return { state: w.quality === 'regular' ? 'regular' : 'extended', window: w, clock, reason: `${w.quality} window ${w.from}-${w.to}` }
    }
  }
  return { state: 'closed', clock, reason: `no session window covers ${String(clock.minutes)} min on weekday ${String(clock.weekday)}` }
}
