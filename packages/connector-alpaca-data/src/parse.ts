// SPDX-License-Identifier: CPAL-1.0
// Alpaca 响应 → 统一模型（纯函数，无状态；不发请求、不读环境）。
// 出处（官方文档；本机离线，端点为施工时按文档核对，未联网验证）：
//   标的元数据   GET  https://{paper-api|api}.alpaca.markets/v2/assets?status=active&asset_class=us_equity
//                （Alpaca "Assets" 文档：字段 class / symbol / status / tradable / marginable / shortable /
//                 borrow_status / fractionable / exchange / margin_requirement_long / margin_requirement_short；
//                 旧字段 easy_to_borrow / maintenance_margin_requirement 官方 changelog 2026-07-16 宣布
//                 2026-09-22 移除，仅作兼容读取）
//   交易日历     GET  .../v2/calendar?start=YYYY-MM-DD&end=YYYY-MM-DD → [{date, open, close}]（open/close 为 ET 本地 HH:mm）
//   时钟         GET  .../v2/clock → {timestamp, is_open, next_open, next_close}（UTC ISO-8601）
//   K 线         GET  https://data.alpaca.markets/v2/stocks/{symbol}/bars?timeframe=&start=&end=&limit=&feed=&page_token=
//                → {bars:[{t,o,h,l,c,v,vw,n}], symbol, next_page_token}
//   最新快照     GET  https://data.alpaca.markets/v2/stocks/{symbol}/snapshot?feed=
//                → {latestQuote:{t,bp,bs,ap,as}, latestTrade:{t,p,s}, prevDailyBar:{c}, dailyBar:{v,vw}}
// 美股形状照 packages/protocol/src/model/instrument.ts：kind 'spot'、assetClass 'stocks'、quote/settle 'USD'、
// venueSizeUnit 'base'、contractSize '1'；sessions 的交易时段来自 /v2/calendar，不在代码里写死开盘收盘。
// 协议缺字段（碎股 fractionable、可借 shortable / easy_to_borrow、盘前盘后与节假日例外）没有对应字段，
// 本包不自行加字段：碎股 / 可借走 assetFlags()，节假日 / 提前收盘走 tradingCalendar()，并在 REPORT 里登记。
import { asDecimal, makeProblem } from '@gitrader/protocol'
import type {
  Candle, CandleInterval, Instrument, InstrumentPriceRule, InstrumentSizeRule, InstrumentStatus, Ms,
  Problem, ProblemName, TradingSessionWindow,
} from '@gitrader/protocol'

export const VENUE = 'alpaca'
/** 正式（实盘）交易 API 基址；只用于 /v2/assets、/v2/calendar、/v2/clock 这类账户元数据。 */
export const TRADING_LIVE_HOST = 'api.alpaca.markets'
/** 模拟盘交易 API 基址（QD `alpaca_trading/README.md`：`PK*` = paper）。 */
export const TRADING_PAPER_HOST = 'paper-api.alpaca.markets'
/** 行情数据 API 基址（paper / live 共用；源由 feed 决定）。 */
export const DATA_HOST = 'data.alpaca.markets'
/** 纽约时区：交易日历的 open / close 都按它解释。 */
export const NY_TZ = 'America/New_York'

export const ASSETS_PATH = '/v2/assets'
export const CALENDAR_PATH = '/v2/calendar'
export const CLOCK_PATH = '/v2/clock'
export const barsPath = (symbol: string): string => `/v2/stocks/${encodeURIComponent(symbol)}/bars`
export const snapshotPath = (symbol: string): string => `/v2/stocks/${encodeURIComponent(symbol)}/snapshot`

/** 单次 bars 请求上限（Alpaca 文档 limit 缺省 1000、最大 10000）。 */
export const MAX_CANDLES = 10_000
/** 翻页窗口大小：取该所单次上限。 */
export const CANDLE_PAGE = 10_000
/** 区间翻页硬上限，防上游异常时死循环。 */
export const MAX_PAGES = 200
/** 无 from 时的缺省根数。 */
export const DEFAULT_CANDLE_COUNT = 300
/** 一次请求的计次权重（Alpaca 按请求数计，不按权重）。 */
export const REQUEST_WEIGHT = 1
/** Basic 计划：数据 / 交易端点各 200 次每分钟（以官方 Rate Limits 页为准）。 */
export const RATE_LIMIT = 200
export const RATE_WINDOW_MS: Ms = 60_000

/** 行情源：`iex` 是免费源（缺省），`sip` 需付费订阅，`otc` / `boats` 只在特定权限下可用。 */
export const FEEDS = ['iex', 'sip', 'otc', 'boats'] as const
export type AlpacaFeed = (typeof FEEDS)[number]
export const DEFAULT_FEED: AlpacaFeed = 'iex'

/** 环境由配置显式声明；基址随之决定（美股八条第 7 条：模拟 / 实盘不许混）。 */
export const ENVIRONMENTS = ['paper', 'live'] as const
export type AlpacaEnvironment = (typeof ENVIRONMENTS)[number]

/** 协议区间 → Alpaca timeframe。上游没有 3d（只有 1Day / 1Week / 1Month 及更长的月档）。 */
export const TIMEFRAME_OF: Partial<Record<CandleInterval, string>> = {
  '1m': '1Min', '3m': '3Min', '5m': '5Min', '15m': '15Min', '30m': '30Min',
  '1h': '1Hour', '2h': '2Hour', '4h': '4Hour', '8h': '8Hour', '12h': '12Hour',
  '1d': '1Day', '1w': '1Week', '1M': '1Month',
}

export const instrumentIdOf = (symbol: string): string => `${VENUE}:${symbol}`

/** `alpaca:AAPL` → 场所原生 symbol（原样保留大小写，BRK.B 不改成 BRK/B）；不是本场所的 id 就拒绝。 */
export function symbolOf(instrumentId: string): string {
  const i = instrumentId.indexOf(':')
  if (i <= 0 || i === instrumentId.length - 1 || instrumentId.slice(0, i) !== VENUE) {
    throw problemError('INVALID_PARAMS', `not a ${VENUE} instrument id: ${JSON.stringify(instrumentId)}`)
  }
  return instrumentId.slice(i + 1)
}

/** 带 Problem 的错误：内核按 problem.name / retryable 决定是否重试。 */
export class ProblemError extends Error {
  readonly problem: Problem

  constructor(problem: Problem) {
    super(problem.message)
    this.name = 'ProblemError'
    this.problem = problem
  }
}

export function problemError(name: ProblemName, message: string, extra: Partial<Problem> = {}): ProblemError {
  return new ProblemError(makeProblem(name, message, extra))
}

// ---- 环境 / 行情源 / 基址 ------------------------------------------------------

/** 行情源白名单：不认识的源直接 INVALID_PARAMS（不静默回落到 iex）。 */
export function feedOf(feed: string | undefined): AlpacaFeed {
  if (feed === undefined) return DEFAULT_FEED
  if ((FEEDS as readonly string[]).includes(feed)) return feed as AlpacaFeed
  throw problemError('INVALID_PARAMS', `unsupported alpaca market-data feed: ${JSON.stringify(feed)} (expected iex|sip|otc|boats)`)
}

export function environmentOf(environment: string | undefined): AlpacaEnvironment {
  if (environment === undefined) return 'paper'
  if ((ENVIRONMENTS as readonly string[]).includes(environment)) return environment as AlpacaEnvironment
  throw problemError('INVALID_PARAMS', `unsupported alpaca environment: ${JSON.stringify(environment)} (expected paper|live)`)
}

/**
 * 交易 API 基址：显式覆盖优先，但覆盖到「另一个环境」的官方主机就拒绝（照 QD `alpaca_trading/client.py:229-234`
 * 的 host 校验，避免声明 paper 却把请求打到实盘主机）。
 */
export function resolveTradingBaseUrl(environment: AlpacaEnvironment, override?: string): string {
  const expected = environment === 'paper' ? TRADING_PAPER_HOST : TRADING_LIVE_HOST
  if (override === undefined || override.trim() === '') return `https://${expected}`
  const url = new URL(override.trim())
  const host = url.hostname.toLowerCase()
  const other = environment === 'paper' ? TRADING_LIVE_HOST : TRADING_PAPER_HOST
  if (host === other) {
    throw problemError(
      'INVALID_PARAMS',
      `alpaca environment is ${environment} but tradingBaseUrl points at ${other} (paper / live must not be mixed)`,
    )
  }
  return override.trim().replace(/\/+$/, '')
}

export function resolveDataBaseUrl(override?: string): string {
  if (override === undefined || override.trim() === '') return `https://${DATA_HOST}`
  return override.trim().replace(/\/+$/, '')
}

// ---- 密钥（前缀校验；只比前缀，不打印、不落盘、不进断言） ----------------------

export interface AlpacaCredentialInput {
  keyId?: string
  secretKey?: string
  environment?: AlpacaEnvironment
  /** 环境变量来源（缺省 process.env；测试注入假对象，不读真环境）。 */
  env?: Record<string, string | undefined>
}

export interface AlpacaCredentials {
  keyId?: string
  secretKey?: string
}

/** 由密钥前缀判断环境：`PK` = 模拟、`AK` = 实盘（QD `alpaca_trading/README.md`）。 */
export function environmentOfKeyPrefix(keyId: string): AlpacaEnvironment {
  if (keyId.startsWith('PK')) return 'paper'
  if (keyId.startsWith('AK')) return 'live'
  throw problemError('INVALID_PARAMS', 'alpaca key id prefix is neither PK (paper) nor AK (live)')
}

/**
 * 取密钥：构造参数优先，其次环境变量 `ALPACA_API_KEY_ID` / `ALPACA_API_SECRET_KEY`。
 * 有 key 就必须有 secret；前缀与显式声明的 environment 不符 → 构造时拒绝（美股八条第 7 条）。
 * 错误信息里只出现前缀结论，不出现任何密钥内容。
 */
export function resolveCredentials(o: AlpacaCredentialInput = {}): AlpacaCredentials {
  const environment = environmentOf(o.environment)
  const env = o.env ?? (typeof process === 'undefined' ? {} : process.env)
  const keyId = firstNonEmpty(o.keyId, env.ALPACA_API_KEY_ID)
  const secretKey = firstNonEmpty(o.secretKey, env.ALPACA_API_SECRET_KEY)
  if (keyId !== undefined && secretKey === undefined) {
    throw problemError('INVALID_PARAMS', 'alpaca data connector needs both keyId and secretKey (got keyId only)')
  }
  if (secretKey !== undefined && keyId === undefined) {
    throw problemError('INVALID_PARAMS', 'alpaca data connector needs both keyId and secretKey (got secretKey only)')
  }
  if (keyId === undefined || secretKey === undefined) return {}
  const actual = environmentOfKeyPrefix(keyId)
  if (actual !== environment) {
    throw problemError(
      'INVALID_PARAMS',
      `alpaca key prefix says ${actual} but environment is ${environment} (paper / live must not be mixed)`,
    )
  }
  return { keyId, secretKey }
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return undefined
}

/** 鉴权请求头（Alpaca REST：APCA-API-KEY-ID / APCA-API-SECRET-KEY）；无密钥返回空对象。 */
export function authHeaders(c: AlpacaCredentials): Record<string, string> {
  if (c.keyId === undefined || c.secretKey === undefined) return {}
  return { 'APCA-API-KEY-ID': c.keyId, 'APCA-API-SECRET-KEY': c.secretKey }
}

// ---- 小工具 --------------------------------------------------------------------

export const num = (v: unknown): number => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN
  if (typeof v !== 'string' || v.trim() === '') return NaN
  const n = Number(v)
  return Number.isFinite(n) ? n : NaN
}

/** ISO-8601 → 毫秒；小数秒超过 3 位时截断（Alpaca 的 `t` 是带纳秒的 UTC 时刻）。非法返回 NaN。 */
export function isoMs(v: unknown): number {
  if (typeof v !== 'string' || v.trim() === '') return NaN
  const s = v.trim().replace(/(\.\d{3})\d+/, '$1')
  const t = Date.parse(s)
  return Number.isFinite(t) ? t : NaN
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/

/** `HH:mm`（24 小时制、纽约本地时间）：不合法直接拒绝，免得把坏日历写进 sessions。 */
export function hhmmOf(v: unknown): string {
  if (typeof v !== 'string' || !HHMM.test(v.trim())) {
    throw problemError('VENUE_UNAVAILABLE', `${VENUE} calendar returned an invalid time: ${JSON.stringify(v)}`, {
      retryable: true,
      venue: { id: VENUE, message: 'invalid calendar time' },
    })
  }
  return v.trim()
}

// ---- 交易日历 / 时钟 -----------------------------------------------------------

/** 一个交易日：date 是纽约本地日期（YYYY-MM-DD），open / close 是纽约本地 HH:mm。 */
export interface CalendarDay {
  date: string
  open: string
  close: string
  /** 该日按星期几的常规收盘时间判定为提前收盘（协议 sessions 是周模板，装不下例外）。 */
  isEarlyClose?: boolean
  /** 该日开盘早于常规开盘（例如半日市前的特殊安排）。 */
  isLateOpen?: boolean
}

export interface RawCalendarRow {
  date?: unknown
  open?: unknown
  close?: unknown
}

/** /v2/calendar → CalendarDay[]（按日期升序；坏行跳过，时间格式非法则整体失败）。 */
export function parseCalendar(raw: unknown): CalendarDay[] {
  if (!Array.isArray(raw)) {
    throw problemError('VENUE_UNAVAILABLE', `${VENUE} calendar returned no array`, {
      retryable: true,
      venue: { id: VENUE, message: 'invalid calendar payload' },
    })
  }
  const out: CalendarDay[] = []
  for (const row of raw as unknown[]) {
    if (!row || typeof row !== 'object') continue
    const r = row as RawCalendarRow
    if (typeof r.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(r.date)) continue
    out.push({ date: r.date, open: hhmmOf(r.open), close: hhmmOf(r.close) })
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
}

export interface MarketClock {
  ts: Ms
  isOpen: boolean
  nextOpen: Ms
  nextClose: Ms
}

/** /v2/clock → { ts, isOpen, nextOpen, nextClose }（时间统一成毫秒）。 */
export function parseClock(raw: unknown): MarketClock {
  if (!raw || typeof raw !== 'object') {
    throw problemError('VENUE_UNAVAILABLE', `${VENUE} clock returned no object`, {
      retryable: true,
      venue: { id: VENUE, message: 'invalid clock payload' },
    })
  }
  const r = raw as { timestamp?: unknown; is_open?: unknown; next_open?: unknown; next_close?: unknown }
  const ts = isoMs(r.timestamp)
  const nextOpen = isoMs(r.next_open)
  const nextClose = isoMs(r.next_close)
  if (!Number.isFinite(ts) || !Number.isFinite(nextOpen) || !Number.isFinite(nextClose)) {
    throw problemError('VENUE_UNAVAILABLE', `${VENUE} clock payload has unparsable timestamps`, {
      retryable: true,
      venue: { id: VENUE, message: 'invalid clock timestamps' },
    })
  }
  return { ts, isOpen: r.is_open === true, nextOpen, nextClose }
}

/** 纽约本地日期字符串（YYYY-MM-DD）；用于给 /v2/calendar 算 start / end。 */
export function nyDateString(ms: Ms): string {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: NY_TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
  return fmt.format(new Date(ms))
}

/** 在 YYYY-MM-DD 上加天数（纯日期算术，不经过本地时区）。 */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map((p) => Number.parseInt(p, 10))
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) {
    throw problemError('INVALID_PARAMS', `not a YYYY-MM-DD date: ${JSON.stringify(date)}`)
  }
  const t = Date.UTC(y!, m! - 1, d!) + days * 86_400_000
  const out = new Date(t)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${out.getUTCFullYear()}-${pad(out.getUTCMonth() + 1)}-${pad(out.getUTCDate())}`
}

/** 星期几（0 = 周日），按日历日期本身算，不受本机时区影响。 */
export function weekdayOf(date: string): number {
  const [y, m, d] = date.split('-').map((p) => Number.parseInt(p, 10))
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) {
    throw problemError('INVALID_PARAMS', `not a YYYY-MM-DD date: ${JSON.stringify(date)}`)
  }
  return new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay()
}

// ---- 时段（sessions） ----------------------------------------------------------

export interface SessionBuildOptions {
  /** 盘前盘后是否单独列窗口（缺省 true）。 */
  extendedHours?: boolean
  /** 盘前窗口起点（纽约本地 HH:mm），缺省 04:00（QD `alpaca_trading/README.md`：盘前 4:00–9:30 ET）。 */
  preOpen?: string
  /** 盘后窗口终点（纽约本地 HH:mm），缺省 20:00（同上：盘后 16:00–20:00 ET）。 */
  postClose?: string
}

/**
 * 日历 → 协议周模板。规则：
 * - 每个星期几取该窗口内**出现次数最多**的 (open, close)（多数交易日就是常规时段）；平票取较早开盘 / 较早收盘，保证确定性。
 * - 没有交易日出现的星期几不生成窗口（周末自然消失）。
 * - 盘前 / 盘后窗口另列（quality 'thin'）：`/v2/calendar` 行里有 `session_open` / `session_close`，但官方未定义其语义
 *   （社区实例 0700 / 1900 与扩展时段不符），本包不采用；窗口取官方 Orders 文档的扩展时段
 *   04:00–09:30 / 16:00–20:00 ET，可配。
 * - 提前收盘 / 延迟开盘是**日期级例外**，协议周模板装不下：由 tradingCalendar() 原样暴露，并在 REPORT 登记为协议缺口。
 */
export function buildSessions(days: CalendarDay[], opts: SessionBuildOptions = {}): { tz: string; windows: TradingSessionWindow[] } {
  if (days.length === 0) {
    throw problemError('VENUE_UNAVAILABLE', `${VENUE} calendar is empty; refusing to invent trading sessions`, {
      retryable: true,
      venue: { id: VENUE, message: 'empty calendar' },
    })
  }
  const modes = weekdayModes(days)
  const preOpen = opts.preOpen ?? '04:00'
  const postClose = opts.postClose ?? '20:00'
  const extended = opts.extendedHours !== false
  const windows: TradingSessionWindow[] = []
  for (const [weekday, mode] of [...modes.entries()].sort((a, b) => a[0] - b[0])) {
    if (extended && preOpen < mode.open) {
      windows.push({ days: [weekday], from: preOpen, to: mode.open, quality: 'thin' })
    }
    windows.push({ days: [weekday], from: mode.open, to: mode.close, quality: 'regular' })
    if (extended && postClose > mode.close) {
      windows.push({ days: [weekday], from: mode.close, to: postClose, quality: 'thin' })
    }
  }
  return { tz: NY_TZ, windows }
}

interface DayMode {
  open: string
  close: string
}

/** 每个星期几的常规 (open, close)：出现次数最多的那组；平票取较早开盘、再取较早收盘。 */
export function weekdayModes(days: CalendarDay[]): Map<number, DayMode> {
  const counts = new Map<number, Map<string, { mode: DayMode; count: number }>>()
  for (const day of days) {
    const weekday = weekdayOf(day.date)
    const key = `${day.open}|${day.close}`
    const perDay = counts.get(weekday) ?? new Map<string, { mode: DayMode; count: number }>()
    const hit = perDay.get(key)
    if (hit) hit.count += 1
    else perDay.set(key, { mode: { open: day.open, close: day.close }, count: 1 })
    counts.set(weekday, perDay)
  }
  const out = new Map<number, DayMode>()
  for (const [weekday, perDay] of counts) {
    let best: { mode: DayMode; count: number } | undefined
    for (const candidate of perDay.values()) {
      if (
        best === undefined ||
        candidate.count > best.count ||
        (candidate.count === best.count &&
          (candidate.mode.open < best.mode.open ||
            (candidate.mode.open === best.mode.open && candidate.mode.close < best.mode.close)))
      ) {
        best = candidate
      }
    }
    if (best) out.set(weekday, best.mode)
  }
  return out
}

/** 把日期级例外（提前收盘 / 延迟开盘）标到日历行上：按同日期的常规时段比较。 */
export function markCalendarExceptions(days: CalendarDay[]): CalendarDay[] {
  const modes = weekdayModes(days)
  return days.map((day) => {
    const mode = modes.get(weekdayOf(day.date))
    if (!mode) return { ...day }
    return {
      ...day,
      isEarlyClose: day.close < mode.close,
      isLateOpen: day.open > mode.open,
    }
  })
}

/** 某日期是否是交易日（日历里有这一天）；日历没覆盖到该日期就返回 undefined（不猜）。 */
export function isTradingDay(days: CalendarDay[], date: string): boolean | undefined {
  if (days.length === 0) return undefined
  const first = days[0]!.date
  const last = days[days.length - 1]!.date
  if (date < first || date > last) return undefined
  return days.some((d) => d.date === date)
}

// ---- 标的（/v2/assets） ---------------------------------------------------------

export interface RawAsset {
  id?: unknown
  class?: unknown
  exchange?: unknown
  symbol?: unknown
  name?: unknown
  status?: unknown
  tradable?: unknown
  marginable?: unknown
  shortable?: unknown
  /** `easy_to_borrow` | `hard_to_borrow`；非美股省略（官方 2026-06 新增，取代 easy_to_borrow）。 */
  borrow_status?: unknown
  /** 旧字段：2026-09-22 起移除，仅兼容。 */
  easy_to_borrow?: unknown
  fractionable?: unknown
  /** 保证金要求百分比（十进制字符串，仅美股）。 */
  margin_requirement_long?: unknown
  margin_requirement_short?: unknown
  /** 旧字段：2026-09-22 起移除，仅兼容。 */
  maintenance_margin_requirement?: unknown
}

/**
 * 协议没有的标的属性（碎股 / 可借 / 保证金 / 交易所）：单独暴露，不往 Instrument 上塞协议外字段。
 * 美股八条第 4、5 条要用它们判断「能不能碎股 / 能不能开空」。
 */
export interface AssetFlags {
  symbol: string
  exchange: string | null
  tradable: boolean
  marginable: boolean
  shortable: boolean
  /** 借券状态；两个字段都没有 = null（不可得，不当作可借）。 */
  borrowStatus: 'easy_to_borrow' | 'hard_to_borrow' | null
  /** 只有明确 easy_to_borrow 才为 true；未知 = false（fail-closed）。 */
  easyToBorrow: boolean
  fractionable: boolean
  /** 多头 / 空头保证金要求百分比；缺 = null（不可得）。 */
  marginRequirementLong: number | null
  marginRequirementShort: number | null
  /** 旧字段兼容；新响应里没有，恒为 null。 */
  maintenanceMarginRequirement: number | null
}

/** borrow_status 优先；没有时回落旧布尔 easy_to_borrow；都没有或值不认识 = null。 */
export function borrowStatusOf(a: Pick<RawAsset, 'borrow_status' | 'easy_to_borrow'>): AssetFlags['borrowStatus'] {
  if (a.borrow_status === 'easy_to_borrow' || a.borrow_status === 'hard_to_borrow') return a.borrow_status
  if (a.borrow_status !== undefined && a.borrow_status !== null) return null
  if (a.easy_to_borrow === true) return 'easy_to_borrow'
  if (a.easy_to_borrow === false) return 'hard_to_borrow'
  return null
}

export function assetFlagsOf(a: RawAsset): AssetFlags | undefined {
  const symbol = typeof a.symbol === 'string' && a.symbol.trim() !== '' ? a.symbol.trim() : undefined
  if (!symbol) return undefined
  const mmr = num(a.maintenance_margin_requirement)
  const mrl = num(a.margin_requirement_long)
  const mrs = num(a.margin_requirement_short)
  const borrowStatus = borrowStatusOf(a)
  return {
    symbol,
    exchange: typeof a.exchange === 'string' && a.exchange.trim() !== '' ? a.exchange.trim() : null,
    tradable: a.tradable === true,
    marginable: a.marginable === true,
    shortable: a.shortable === true,
    borrowStatus,
    easyToBorrow: borrowStatus === 'easy_to_borrow',
    fractionable: a.fractionable === true,
    marginRequirementLong: Number.isFinite(mrl) ? mrl : null,
    marginRequirementShort: Number.isFinite(mrs) ? mrs : null,
    maintenanceMarginRequirement: Number.isFinite(mmr) ? mmr : null,
  }
}

function statusOfAsset(a: RawAsset): InstrumentStatus {
  if (a.status === 'inactive') return 'delisted'
  if (a.status !== 'active') return 'halted'
  return a.tradable === true ? 'trading' : 'halted'
}

/**
 * 单个资产 → Instrument。
 * - 只收 `class === 'us_equity'`（加密资产不在本包范围，B6 只做美股）。
 * - 整数股为默认：step '1' / decimals 0 / min '1'；碎股能力在 assetFlags 里，协议没有对应字段。
 * - 美股最小报价单位随价格档位变化（协议没有分档字段）→ 只填 maxDecimals 4，不写死 tick。
 */
export function parseAsset(a: RawAsset, now: Ms, sessions: { tz: string; windows: TradingSessionWindow[] }): Instrument | undefined {
  if (a.class !== 'us_equity') return undefined
  const flags = assetFlagsOf(a)
  if (!flags) return undefined
  const symbol = flags.symbol
  const price: InstrumentPriceRule = { maxDecimals: 4 }
  const size: InstrumentSizeRule = { step: asDecimal('1'), decimals: 0, min: asDecimal('1') }
  return {
    instrumentId: instrumentIdOf(symbol),
    venue: VENUE,
    symbol,
    displaySymbol: symbol,
    kind: 'spot',
    base: symbol,
    quote: 'USD',
    settle: 'USD',
    settlement: 'linear',
    contractSize: asDecimal('1'),
    venueSizeUnit: 'base',
    assetClass: 'stocks',
    marketGroup: null,
    ...(typeof a.name === 'string' && a.name.trim() !== '' ? { underlying: { description: a.name.trim(), synthetic: false } } : {}),
    status: statusOfAsset(a),
    price,
    size,
    orderTypes: [],
    tif: [],
    triggerPriceTypes: [],
    sessions,
    updatedAt: now,
  }
}

/** /v2/assets 数组 → 标的（按 symbol 升序；非 us_equity / 无 symbol 的行丢弃）。 */
export function parseAssets(raw: unknown, now: Ms, sessions: { tz: string; windows: TradingSessionWindow[] }): Instrument[] {
  if (!Array.isArray(raw)) {
    throw problemError('VENUE_UNAVAILABLE', `${VENUE} assets returned no array`, {
      retryable: true,
      venue: { id: VENUE, message: 'invalid assets payload' },
    })
  }
  const out: Instrument[] = []
  for (const row of raw as unknown[]) {
    if (!row || typeof row !== 'object') continue
    const instrument = parseAsset(row as RawAsset, now, sessions)
    if (instrument) out.push(instrument)
  }
  return out.sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0))
}

// ---- K 线（data API v2 stocks bars） -------------------------------------------

export interface RawBar {
  t?: unknown
  o?: unknown
  h?: unknown
  l?: unknown
  c?: unknown
  v?: unknown
  vw?: unknown
}

export interface RawBars {
  bars?: unknown
  next_page_token?: unknown
}

/**
 * bars → Candle[]：`t` 是 ISO-8601 UTC（日线是当日 04:00Z，即纽约零点），统一成毫秒；
 * 字段是 t/o/h/l/c/v（vw = 成交量加权均价，有就填 vwap）。缺字段 / 非数值的行跳过。
 */
export function parseBars(raw: unknown): Candle[] {
  const rows = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as RawBars).bars)
      ? (raw as RawBars).bars
      : []
  const out: Candle[] = []
  for (const row of rows as unknown[]) {
    if (!row || typeof row !== 'object') continue
    const r = row as RawBar
    const t = isoMs(r.t)
    const o = num(r.o)
    const h = num(r.h)
    const l = num(r.l)
    const c = num(r.c)
    const v = num(r.v)
    if (![t, o, h, l, c, v].every((x) => Number.isFinite(x))) continue
    if (t <= 0) continue
    const vwap = num(r.vw)
    const candle: Candle = { t, o, h, l, c, v }
    if (Number.isFinite(vwap) && vwap > 0) candle.vwap = vwap
    out.push(candle)
  }
  return out
}

/** 升序去重（同一根 K 线在翻页边界可能重复）。 */
export function dedupeCandles(candles: Candle[]): Candle[] {
  const seen = new Map<Ms, Candle>()
  for (const candle of candles) seen.set(candle.t, candle)
  return [...seen.values()].sort((a, b) => a.t - b.t)
}

/** 无 from 时的根数：1..10000，缺省 300。 */
export function clampCount(n: number | undefined): number {
  const raw = typeof n === 'number' && Number.isFinite(n) ? Math.floor(n) : DEFAULT_CANDLE_COUNT
  return Math.max(1, Math.min(MAX_CANDLES, raw))
}

export function timeframeOf(interval: CandleInterval): string {
  const timeframe = TIMEFRAME_OF[interval]
  if (!timeframe) throw problemError('INVALID_PARAMS', `unsupported candle interval: ${String(interval)}`)
  return timeframe
}

// ---- 快照（quote / top-of-book / context） -------------------------------------

export interface RawSnapshot {
  latestQuote?: { t?: unknown; bp?: unknown; bs?: unknown; ap?: unknown; as?: unknown }
  latestTrade?: { t?: unknown; p?: unknown; s?: unknown }
  prevDailyBar?: { c?: unknown }
  dailyBar?: { v?: unknown; vw?: unknown }
}

export interface SnapshotQuote {
  ts: Ms
  bid: number
  ask: number
  bidSize?: number
  askSize?: number
  last?: number
  prevDayClose?: number
  dayVolume?: number
}

/**
 * /v2/stocks/{symbol}/snapshot → 报价缓存。买卖价缺一或非正（盘前冷门标的常见）视为没有报价。
 * `last` 取最新成交价；`prevDayClose` 取昨日日线收盘；`dayVolume` 取当日日线成交量。
 */
export function parseSnapshot(raw: unknown): SnapshotQuote | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const s = raw as RawSnapshot
  const bid = num(s.latestQuote?.bp)
  const ask = num(s.latestQuote?.ap)
  if (!(bid > 0) || !(ask > 0)) return undefined
  const ts = isoMs(s.latestQuote?.t)
  const tradeTs = isoMs(s.latestTrade?.t)
  const quote: SnapshotQuote = {
    ts: Number.isFinite(ts) && ts > 0 ? ts : Number.isFinite(tradeTs) && tradeTs > 0 ? tradeTs : 0,
    bid,
    ask,
  }
  const bidSize = num(s.latestQuote?.bs)
  const askSize = num(s.latestQuote?.as)
  if (bidSize > 0) quote.bidSize = bidSize
  if (askSize > 0) quote.askSize = askSize
  const last = num(s.latestTrade?.p)
  if (last > 0) quote.last = last
  const prevDayClose = num(s.prevDailyBar?.c)
  if (prevDayClose > 0) quote.prevDayClose = prevDayClose
  const dayVolume = num(s.dailyBar?.v)
  if (dayVolume > 0) quote.dayVolume = dayVolume
  return quote
}

/** 快照里没有时间戳（极少见）时用注入时钟兜底，保证 quote.ts 恒为整数毫秒。 */
export function stampedAt(quote: SnapshotQuote, now: Ms): SnapshotQuote {
  return quote.ts > 0 ? quote : { ...quote, ts: now }
}
