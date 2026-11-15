// SPDX-License-Identifier: CPAL-1.0
// 美股交易时段（美股八条第 1 条）：**不写死**，以 Alpaca 交易日历 / 时钟接口为准。
//   端点出处：`GET /v2/calendar`（官方 Trading API v2，返回 [{date, open, close, settlement_date}]，时间按 America/New_York）
//             `GET /v2/clock`（官方，返回 {timestamp, is_open, next_open, next_close}）——QD 未调用，见 README 端点表。
// 时段划分（ET）：
//   盘前 04:00–09:30（thin）、常规 09:30–16:00（regular，提前收盘日按日历 close）、盘后 16:00–20:00（thin）；
//   日历里没有的日期 = 休市（周末 / 节假日），提前收盘日 close = 13:00 之类，一律以日历为准。
// 时区换算走 Intl（`America/New_York`，含夏令时），不手算偏移。
import type { Ms } from '@gitrader/protocol'
import type { Instrument, SessionQuality, TradingSessionWindow } from '@gitrader/protocol'
import { MARKET_TZ, POST_MARKET_CLOSE, PRE_MARKET_OPEN, REGULAR_CLOSE, REGULAR_OPEN } from './constants'

/** 日历里的一天（`date` = YYYY-MM-DD，`open` / `close` = 该时区的 HH:mm）。 */
export interface CalendarDay {
  date: string
  open: string
  close: string
  settlementDate?: string
}

/** 交易日历快照（拉一次缓存；`fetchedAt` 只做诊断）。 */
export interface TradingCalendar {
  tz: string
  days: CalendarDay[]
  fetchedAt: Ms
}

export type SessionPhase = 'pre' | 'regular' | 'post' | 'closed'

export interface SessionState {
  /** 当前阶段。 */
  phase: SessionPhase
  /** 现在在纽约是几号（YYYY-MM-DD）。 */
  date: string
  /** 当日是否交易日（日历里有这一天）。 */
  tradingDay: boolean
  /** 当日常规时段的开 / 收盘（分钟数，纽约墙钟）；非交易日为 null。 */
  openMinute: number | null
  closeMinute: number | null
  /** 提前收盘（close 早于 16:00）。 */
  earlyClose: boolean
  /** 现在纽约墙钟的分钟数。 */
  nowMinute: number
  /** 下一次常规开盘的时刻（ms），没有下一个交易日时为 null。 */
  nextOpenMs: Ms | null
  /** 距下一次开盘的毫秒数。 */
  msToNextOpen: number | null
}

export interface SessionOptions {
  tz?: string
  preOpen?: string
  postClose?: string
}

const formatters = new Map<string, Intl.DateTimeFormat>()

function formatterFor(tz: string): Intl.DateTimeFormat {
  const hit = formatters.get(tz)
  if (hit !== undefined) return hit
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  })
  formatters.set(tz, fmt)
  return fmt
}

export interface WallClock { date: string; year: number; month: number; day: number; hour: number; minute: number; second: number; minutes: number }

/** 某时刻在某时区的墙钟。 */
export function wallClock(ms: Ms, tz: string = MARKET_TZ): WallClock {
  const parts = formatterFor(tz).formatToParts(new Date(ms))
  const get = (type: string): number => {
    const part = parts.find((p) => p.type === type)
    return part === undefined ? 0 : Number(part.value)
  }
  const year = get('year')
  const month = get('month')
  const day = get('day')
  const hour = get('hour')
  const minute = get('minute')
  const second = get('second')
  const pad = (n: number): string => String(n).padStart(2, '0')
  return { date: `${String(year).padStart(4, '0')}-${pad(month)}-${pad(day)}`, year, month, day, hour, minute, second, minutes: hour * 60 + minute }
}

/** 该时区在某一时刻的 UTC 偏移（毫秒）。 */
function offsetAt(ms: Ms, tz: string): number {
  const w = wallClock(ms, tz)
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second)
  return asUtc - Math.floor(ms / 1000) * 1000
}

/** 墙钟（日期 + 当日分钟数）→ epoch ms；含夏令时（迭代两次定偏移）。 */
export function zonedToUtc(date: string, minutes: number, tz: string = MARKET_TZ): Ms {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim())
  if (m === null) throw new RangeError(`bad calendar date: ${date}`)
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) throw new RangeError(`bad calendar date: ${date}`)
  const naive = Date.UTC(y, mo - 1, d) + minutes * 60_000
  const first = offsetAt(naive, tz)
  let out = naive - first
  const second = offsetAt(out, tz)
  if (second !== first) out = naive - second
  return out
}

/** "HH:mm" → 分钟数；非法返回 null。 */
export function parseClock(text: string | undefined | null): number | null {
  if (text === undefined || text === null) return null
  const m = /^(\d{1,2}):(\d{2})$/.exec(text.trim())
  if (m === null) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (!Number.isFinite(h) || !Number.isFinite(min) || h > 23 || min > 59) return null
  return h * 60 + min
}

/** 分钟数 → "HH:mm"。 */
export function formatClock(minutes: number): string {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

/** 解析 `GET /v2/calendar` 的响应；缺字段的行走错（不当作空日历，教训 8 的同一口径：宁可报错不猜）。 */
export function parseCalendar(payload: unknown, tz: string = MARKET_TZ, fetchedAt: Ms = 0): TradingCalendar {
  if (!Array.isArray(payload)) throw new TypeError('alpaca calendar response is not an array')
  const days: CalendarDay[] = []
  for (const raw of payload) {
    if (raw === null || typeof raw !== 'object') throw new TypeError('alpaca calendar row is not an object')
    const row = raw as Record<string, unknown>
    const date = String(row['date'] ?? '')
    const open = String(row['open'] ?? '')
    const close = String(row['close'] ?? '')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new TypeError(`alpaca calendar row has no usable date: ${JSON.stringify(row)}`)
    if (parseClock(open) === null || parseClock(close) === null) {
      throw new TypeError(`alpaca calendar row ${date} has an unusable open/close: ${open} / ${close}`)
    }
    days.push({
      date, open, close,
      ...(row['settlement_date'] !== undefined ? { settlementDate: String(row['settlement_date']) } : {}),
    })
  }
  days.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  return { tz, days, fetchedAt }
}

/** 生成一个空日历（没有日历数据时：任何时刻都按休市处理，fail closed，不猜「大概开着吧」）。 */
export function emptyCalendar(tz: string = MARKET_TZ): TradingCalendar {
  return { tz, days: [], fetchedAt: 0 }
}

function dayOf(calendar: TradingCalendar, date: string): CalendarDay | undefined {
  return calendar.days.find((d) => d.date === date)
}

/** 当前时段状态（唯一的时间判断入口：交易 / 下单 / 测试都用它）。 */
export function sessionStateAt(now: Ms, calendar: TradingCalendar, opts: SessionOptions = {}): SessionState {
  const tz = opts.tz ?? calendar.tz ?? MARKET_TZ
  const preOpen = parseClock(opts.preOpen ?? PRE_MARKET_OPEN) ?? 240
  const postClose = parseClock(opts.postClose ?? POST_MARKET_CLOSE) ?? 1200
  const w = wallClock(now, tz)
  const today = dayOf(calendar, w.date)
  const openMinute = today === undefined ? null : parseClock(today.open)
  const closeMinute = today === undefined ? null : parseClock(today.close)
  const regularOpen = openMinute ?? (parseClock(REGULAR_OPEN) ?? 570)
  const regularClose = closeMinute ?? (parseClock(REGULAR_CLOSE) ?? 960)

  let phase: SessionPhase = 'closed'
  if (today !== undefined) {
    if (w.minutes >= regularOpen && w.minutes < regularClose) phase = 'regular'
    else if (w.minutes >= preOpen && w.minutes < regularOpen) phase = 'pre'
    else if (w.minutes >= regularClose && w.minutes < postClose) phase = 'post'
    else phase = 'closed'
  }

  // 下一个开盘：从今天开始往后找（今天的开盘已过就找下一个交易日）。
  let nextOpenMs: Ms | null = null
  if (today !== undefined && w.minutes < regularOpen) {
    nextOpenMs = zonedToUtc(today.date, regularOpen, tz)
  } else {
    const later = calendar.days.filter((d) => d.date > w.date)
    const next = later[0]
    if (next !== undefined) {
      const minutes = parseClock(next.open)
      if (minutes !== null) nextOpenMs = zonedToUtc(next.date, minutes, tz)
    }
  }
  return {
    phase,
    date: w.date,
    tradingDay: today !== undefined,
    openMinute,
    closeMinute,
    earlyClose: closeMinute !== null && closeMinute < (parseClock(REGULAR_CLOSE) ?? 960),
    nowMinute: w.minutes,
    nextOpenMs,
    msToNextOpen: nextOpenMs === null ? null : Math.max(0, nextOpenMs - now),
  }
}

/** 是否常规时段（市价意图唯一的合法窗口）。 */
export function isRegularSession(state: SessionState): boolean {
  return state.phase === 'regular'
}

/** 是否扩展时段（盘前 / 盘后）。 */
export function isExtendedSession(state: SessionState): boolean {
  return state.phase === 'pre' || state.phase === 'post'
}

/**
 * 由交易日历生成 `Instrument.sessions`（协议 v0.1.3 的窗口表）：盘前 / 常规 / 盘后三段，
 * days 取日历里出现过的星期（0–6，周日 = 0），窗口端点按日历的中位开盘 / 收盘给（提前收盘日由 sessionStateAt 逐日处理）。
 */
export function buildSessions(calendar: TradingCalendar, opts: SessionOptions = {}): NonNullable<Instrument['sessions']> {
  const tz = opts.tz ?? calendar.tz ?? MARKET_TZ
  const preOpen = parseClock(opts.preOpen ?? PRE_MARKET_OPEN) ?? 240
  const postClose = parseClock(opts.postClose ?? POST_MARKET_CLOSE) ?? 1200
  const weekdays = new Set<number>()
  const openCounts = new Map<number, number>()
  const closeCounts = new Map<number, number>()
  for (const day of calendar.days) {
    const [ys, ms_, ds] = day.date.split('-')
    const y = Number(ys)
    const mo = Number(ms_)
    const d = Number(ds)
    if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) continue
    const utcNoon = Date.UTC(y, mo - 1, d, 12)
    weekdays.add(new Date(utcNoon).getUTCDay())
    const open = parseClock(day.open)
    const close = parseClock(day.close)
    if (open !== null) openCounts.set(open, (openCounts.get(open) ?? 0) + 1)
    if (close !== null) closeCounts.set(close, (closeCounts.get(close) ?? 0) + 1)
  }
  // 取「最常见的开 / 收盘」（提前收盘日是少数，不能把它的 13:00 平均成常规收盘）。
  const modeOf = (counts: Map<number, number>, fallback: number): number => {
    let best = fallback
    let bestCount = 0
    for (const [minute, count] of counts) {
      if (count > bestCount || (count === bestCount && minute > best)) {
        best = minute
        bestCount = count
      }
    }
    return best
  }
  const openMinute = modeOf(openCounts, parseClock(REGULAR_OPEN) ?? 570)
  const closeMinute = modeOf(closeCounts, parseClock(REGULAR_CLOSE) ?? 960)
  const days = weekdays.size === 0 ? [1, 2, 3, 4, 5] : [...weekdays].sort((a, b) => a - b)
  const windows: TradingSessionWindow[] = [
    { days, from: formatClock(preOpen), to: formatClock(openMinute), quality: 'thin' as SessionQuality },
    { days, from: formatClock(openMinute), to: formatClock(closeMinute), quality: 'regular' as SessionQuality },
    { days, from: formatClock(closeMinute), to: formatClock(postClose), quality: 'thin' as SessionQuality },
  ]
  return { tz, windows }
}

/** 诊断：一句话描述当前时段（错误 hint 用；不承诺「什么时候一定成交」）。 */
export function describeSession(state: SessionState): string {
  const next = state.nextOpenMs === null ? 'no next trading day in the calendar snapshot' : new Date(state.nextOpenMs).toISOString()
  return `${state.phase} session on ${state.date} (ET); next regular open ${next}`
}
