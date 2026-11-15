// SPDX-License-Identifier: CPAL-1.0
// Alpaca 美股只读行情（纯 REST）：标的（/v2/assets）、K 线（data API v2 bars，缺省免费 IEX 源、源可配）、
// 最新快照（bid/ask/last）、交易日历 + 时钟 → sessions（时区 America/New_York，节假日与提前收盘以接口为准）。
// 没有 WebSocket：subscribe 按 pollMs 轮询快照，status().source 恒为 'rest'。
// 盘口：Alpaca 股票行情没有 L2，book() 只给最优一档（真实 NBBO bid/ask，不是造出来的档位），depth 被忽略。
import type { Book, Candle, CandleInterval, Instrument, InstrumentId, MarketContext, Ms, TradingSessionWindow } from '@gitrader/protocol'
import type { MarketStatus, RateBudget, StampedQuote, SubscriptionSpec, Unsubscribe, VenueEvent } from '@gitrader/protocol/connector'
import { AlpacaHttp, unlimitedBudget } from './http'
import type { AlpacaHttpOptions, BudgetLike } from './http'
import {
  ASSETS_PATH, CALENDAR_PATH, CLOCK_PATH, CANDLE_PAGE, DEFAULT_CANDLE_COUNT, DEFAULT_FEED, MAX_CANDLES, MAX_PAGES,
  NY_TZ, RATE_LIMIT, RATE_WINDOW_MS, REQUEST_WEIGHT, VENUE, addDays, barsPath, buildSessions, clampCount, dedupeCandles,
  assetFlagsOf, environmentOf, feedOf, isTradingDay, markCalendarExceptions, nyDateString, parseAssets, parseBars, parseCalendar,
  parseClock, parseSnapshot, problemError, resolveCredentials, resolveDataBaseUrl, resolveTradingBaseUrl, snapshotPath,
  stampedAt, symbolOf, timeframeOf,
} from './parse'
import type { AlpacaEnvironment, AlpacaFeed, AssetFlags, CalendarDay, MarketClock, RawAsset, SessionBuildOptions, SnapshotQuote } from './parse'

export { unlimitedBudget } from './http'

export interface AlpacaMarketOptions {
  /** 环境由配置显式声明（paper / live），交易主机基址随之决定。 */
  environment?: string
  /** 行情源：iex（缺省，免费）/ sip（需订阅）/ otc / boats。 */
  feed?: string
  keyId?: string
  secretKey?: string
  /** 环境变量来源（缺省 process.env，测试注入假对象）。 */
  env?: Record<string, string | undefined>
  tradingBaseUrl?: string
  dataBaseUrl?: string
  fetchImpl?: typeof fetch
  budget?: RateBudget | BudgetLike
  clock?: () => number
  /** 报价轮询间隔，缺省 5000 ms。 */
  pollMs?: number
  /** 行情陈旧阈值（quote 的 stale / status 的 stale），缺省 10 s。 */
  staleMs?: number
  httpTimeoutMs?: number
  /** sessions 里盘前盘后窗口的开关与起止（纽约本地 HH:mm）。 */
  sessions?: SessionBuildOptions
  /** 拉交易日历时向前 / 向后覆盖的天数，缺省 7 / 30。 */
  calendarLookbackDays?: number
  calendarLookaheadDays?: number
}

interface PollSub {
  id: InstrumentId
  cb: (e: VenueEvent) => void
  active: boolean
  inFlight: boolean
  timer?: ReturnType<typeof setInterval>
}

export class AlpacaMarket {
  readonly environment: AlpacaEnvironment
  readonly feed: AlpacaFeed
  readonly http: AlpacaHttp

  private readonly budget: RateBudget | BudgetLike
  private readonly clockFn: () => number
  private readonly pollMs: number
  private readonly staleMs: number
  private readonly sessionOptions: SessionBuildOptions
  private readonly lookbackDays: number
  private readonly lookaheadDays: number

  private records = new Map<InstrumentId, Instrument>()
  private flags = new Map<InstrumentId, AssetFlags>()
  private rawAssets: RawAsset[] = []
  private quotes = new Map<InstrumentId, SnapshotQuote>()
  private calendarDays: CalendarDay[] = []
  private sessionTemplate: { tz: string; windows: TradingSessionWindow[] } | undefined
  private marketClockCache: MarketClock | undefined
  private subs = new Set<PollSub>()
  private lastMessageTs = 0
  private started = false
  private closed = false

  constructor(o: AlpacaMarketOptions = {}) {
    this.environment = environmentOf(o.environment)
    this.feed = feedOf(o.feed)
    // 构造期就校验密钥：前缀与声明环境不符 / 只有一半 → 直接拒绝（不打印密钥）
    const credentials = resolveCredentials({
      environment: this.environment,
      keyId: o.keyId,
      secretKey: o.secretKey,
      env: o.env,
    })
    this.clockFn = o.clock ?? (() => Date.now())
    this.budget = o.budget ?? unlimitedBudget()
    this.pollMs = Math.max(1, Math.floor(o.pollMs ?? 5000))
    this.staleMs = Math.max(1, Math.floor(o.staleMs ?? 10_000))
    this.sessionOptions = o.sessions ?? {}
    this.lookbackDays = Math.max(0, Math.floor(o.calendarLookbackDays ?? 7))
    this.lookaheadDays = Math.max(1, Math.floor(o.calendarLookaheadDays ?? 30))
    const httpOptions: AlpacaHttpOptions = {
      tradingBaseUrl: resolveTradingBaseUrl(this.environment, o.tradingBaseUrl),
      dataBaseUrl: resolveDataBaseUrl(o.dataBaseUrl),
      fetchImpl: o.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args)),
      budget: this.budget,
      timeoutMs: o.httpTimeoutMs ?? 10_000,
      credentials,
    }
    this.http = new AlpacaHttp(httpOptions)
  }

  // ───────────── 生命周期 ─────────────

  /** 拉交易日历（先）、标的清单、时钟；重复调用不重复拉。 */
  async start(): Promise<void> {
    if (this.closed) throw problemError('CAPABILITY_UNSUPPORTED', `${VENUE} data connector is closed`)
    if (this.started) return
    await this.refreshCalendar()
    await this.refreshAssets()
    await this.refreshMarketClock()
    this.started = true
  }

  async close(): Promise<void> {
    this.closed = true
    for (const sub of this.subs) {
      sub.active = false
      if (sub.timer) clearInterval(sub.timer)
    }
    this.subs.clear()
  }

  get closedState(): boolean { return this.closed }
  get hasInstruments(): boolean { return this.records.size > 0 }

  // ───────────── 日历 / 时钟（sessions 的来源） ─────────────

  /**
   * GET /v2/calendar?start=&end=（start / end 用纽约本地日期）。默认窗口 = 今天 − 7 天 … 今天 + 30 天。
   * 日历为空 → VENUE_UNAVAILABLE：宁可失败，也不写死开盘收盘。
   */
  async refreshCalendar(range?: { start?: string; end?: string }): Promise<CalendarDay[]> {
    if (this.closed) throw problemError('CAPABILITY_UNSUPPORTED', `${VENUE} data connector is closed`)
    const today = nyDateString(this.clockFn())
    const start = range?.start ?? addDays(today, -this.lookbackDays)
    const end = range?.end ?? addDays(today, this.lookaheadDays)
    const raw = await this.http.getJson<unknown>('trading', CALENDAR_PATH, { start, end }, REQUEST_WEIGHT)
    const days = markCalendarExceptions(parseCalendar(raw))
    const template = buildSessions(days, this.sessionOptions)
    this.calendarDays = days
    this.sessionTemplate = template
    this.lastMessageTs = this.clockFn()
    if (this.rawAssets.length > 0) this.rebuildInstruments()
    return this.tradingCalendar()
  }

  /** 已缓存的交易日历（标好提前收盘 / 延迟开盘），不联网。 */
  tradingCalendar(): CalendarDay[] {
    return this.calendarDays.map((d) => ({ ...d }))
  }

  /** 协议 sessions（周模板）：来自日历的常规时段 + 盘前盘后窗口。 */
  sessionsTemplate(): { tz: string; windows: TradingSessionWindow[] } {
    if (!this.sessionTemplate) {
      throw problemError('VENUE_UNAVAILABLE', `${VENUE} trading calendar is not loaded; call start() or refreshCalendar() first`, {
        retryable: true,
        venue: { id: VENUE, message: 'calendar not loaded' },
      })
    }
    return { tz: this.sessionTemplate.tz, windows: this.sessionTemplate.windows.map((w) => ({ ...w, days: [...w.days] })) }
  }

  /** GET /v2/clock：is_open / next_open / next_close（所里给的是权威值）。 */
  async refreshMarketClock(): Promise<MarketClock> {
    if (this.closed) throw problemError('CAPABILITY_UNSUPPORTED', `${VENUE} data connector is closed`)
    const raw = await this.http.getJson<unknown>('trading', CLOCK_PATH, {}, REQUEST_WEIGHT)
    const parsed = parseClock(raw)
    this.marketClockCache = parsed
    this.lastMessageTs = this.clockFn()
    return { ...parsed }
  }

  marketClock(): MarketClock {
    if (!this.marketClockCache) {
      throw problemError('VENUE_UNAVAILABLE', `${VENUE} clock is not loaded; call start() or refreshMarketClock() first`, {
        retryable: true,
        venue: { id: VENUE, message: 'clock not loaded' },
      })
    }
    return { ...this.marketClockCache }
  }

  /**
   * 是否在常规交易时段内：按**日历里的那一天**的 open / close 判断（节假日不在日历里 → 休市；
   * 提前收盘日按当天 close 判断），不看星期几。日期不在日历覆盖范围内 → 抛 VENUE_UNAVAILABLE（不猜）。
   */
  isOpenAt(ms: Ms = this.clockFn()): boolean {
    const date = nyDateString(ms)
    const known = isTradingDay(this.calendarDays, date)
    if (known === undefined) {
      throw problemError('VENUE_UNAVAILABLE', `${VENUE} trading calendar does not cover ${date}`, {
        retryable: true,
        venue: { id: VENUE, message: 'date outside calendar window' },
      })
    }
    if (known === false) return false
    const day = this.calendarDays.find((d) => d.date === date)
    if (!day) return false
    const time = nyTimeString(ms)
    return time >= day.open && time < day.close
  }

  // ───────────── 目录 ─────────────

  /** GET /v2/assets?status=active&asset_class=us_equity，缓存后按 sessions 组装标的。 */
  async refreshAssets(): Promise<void> {
    if (this.closed) throw problemError('CAPABILITY_UNSUPPORTED', `${VENUE} data connector is closed`)
    const template = this.sessionsTemplate()
    const raw = await this.http.getJson<unknown>('trading', ASSETS_PATH, { status: 'active', asset_class: 'us_equity' }, REQUEST_WEIGHT)
    if (!Array.isArray(raw)) {
      throw problemError('VENUE_UNAVAILABLE', `${VENUE} assets returned no array`, {
        retryable: true,
        venue: { id: VENUE, message: 'invalid assets payload' },
      })
    }
    this.rawAssets = raw as RawAsset[]
    this.sessionTemplate = template
    this.rebuildInstruments()
    this.lastMessageTs = this.clockFn()
  }

  private rebuildInstruments(): void {
    const template = this.sessionsTemplate()
    const now = this.clockFn()
    const records = new Map<InstrumentId, Instrument>()
    const flags = new Map<InstrumentId, AssetFlags>()
    for (const instrument of parseAssets(this.rawAssets, now, template)) records.set(instrument.instrumentId, instrument)
    for (const raw of this.rawAssets) {
      const f = assetFlagsOf(raw)
      if (f) flags.set(`${VENUE}:${f.symbol}`, f)
    }
    this.records = records
    this.flags = flags
  }

  listInstruments(opts: { includeDelisted?: boolean } = {}): Instrument[] {
    const out: Instrument[] = []
    for (const instrument of this.records.values()) {
      if (opts.includeDelisted === true || instrument.status !== 'delisted') out.push(instrument)
    }
    return out.sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0))
  }

  getInstrument(id: InstrumentId): Instrument | undefined {
    return this.records.get(id)
  }

  /** 协议没有的标的属性（碎股 fractionable、可借 shortable / easy_to_borrow 等），美股八条第 4、5 条要用。 */
  assetFlags(id: InstrumentId): AssetFlags | undefined {
    symbolOf(id)
    const hit = this.flags.get(id)
    return hit ? { ...hit } : undefined
  }

  // ───────────── 行情读取 ─────────────

  /** 最近一次 refreshQuote 的结果（同步、不联网）；没拉过就 undefined。 */
  quote(id: InstrumentId): StampedQuote | undefined {
    const hit = this.quotes.get(id)
    if (!hit) return undefined
    const now = this.clockFn()
    const ageMs = Math.max(0, now - hit.ts)
    return {
      instrumentId: id, ts: hit.ts, bid: hit.bid, ask: hit.ask,
      ...(hit.last !== undefined ? { last: hit.last } : {}),
      stale: ageMs > this.staleMs, ageMs,
    }
  }

  /** GET /v2/stocks/{symbol}/snapshot?feed= 并写入报价缓存；没有有效买卖价 → 清掉缓存并返回 undefined。 */
  async refreshQuote(id: InstrumentId): Promise<StampedQuote | undefined> {
    const symbol = symbolOf(id)
    const raw = await this.http.getJson<unknown>('data', snapshotPath(symbol), { feed: this.feed }, REQUEST_WEIGHT)
    const now = this.clockFn()
    this.lastMessageTs = now
    const parsed = parseSnapshot(raw)
    if (!parsed) {
      this.quotes.delete(id)
      return undefined
    }
    this.quotes.set(id, stampedAt(parsed, now))
    return this.quote(id)
  }

  /**
   * 最优一档盘口：Alpaca 股票行情没有 L2 深度，这里用快照的 NBBO bid / ask（真实价，不是造档位）；
   * depth 参数被忽略（只可能返回 1 档）。某一侧没有数量就不编造，留空。
   */
  async book(id: InstrumentId, _depth?: number): Promise<Book> {
    const quote = await this.refreshQuote(id)
    if (!quote) {
      throw problemError('VENUE_UNAVAILABLE', `${VENUE} ${id} has no top-of-book quote`, {
        retryable: true,
        venue: { id: VENUE, message: 'no quote' },
      })
    }
    const hit = this.quotes.get(id)
    const ts = hit && hit.ts > 0 ? hit.ts : this.clockFn()
    const bids = hit?.bidSize !== undefined ? [{ price: hit.bid, size: hit.bidSize }] : []
    const asks = hit?.askSize !== undefined ? [{ price: hit.ask, size: hit.askSize }] : []
    return { instrumentId: id, ts, bids, asks }
  }

  /**
   * 无 from：取最近 n 根（n 钳到 1..10000，缺省 300）。上游按 `sort=desc` 取最近一页，本地再排成升序去重。
   * 有 from：以 start / end 区间按 next_page_token 翻页（每页最多 10000 根，最多 200 页），
   * 按 [from, to] 过滤、升序去重；interval 不在映射表里直接 INVALID_PARAMS（不发请求）。
   */
  async candles(id: InstrumentId, interval: CandleInterval, opts: { n?: number; from?: Ms; to?: Ms } = {}): Promise<Candle[]> {
    const symbol = symbolOf(id)
    const timeframe = timeframeOf(interval)

    if (opts.from === undefined) {
      const n = clampCount(opts.n)
      const raw = await this.http.getJson<unknown>(
        'data',
        barsPath(symbol),
        { timeframe, limit: n, adjustment: 'raw', feed: this.feed, sort: 'desc' },
        REQUEST_WEIGHT,
      )
      this.lastMessageTs = this.clockFn()
      return dedupeCandles(parseBars(raw)).slice(-n)
    }

    const from = Math.floor(opts.from)
    const to = opts.to === undefined ? undefined : Math.floor(opts.to)
    if (to !== undefined && to < from) return []
    const seen = new Map<Ms, Candle>()
    let token: string | undefined
    for (let page = 0; page < MAX_PAGES; page++) {
      const raw = await this.http.getJson<unknown>(
        'data',
        barsPath(symbol),
        {
          timeframe,
          start: new Date(from).toISOString(),
          ...(to !== undefined ? { end: new Date(to).toISOString() } : {}),
          limit: CANDLE_PAGE,
          adjustment: 'raw',
          feed: this.feed,
          ...(token !== undefined ? { page_token: token } : {}),
        },
        REQUEST_WEIGHT,
      )
      this.lastMessageTs = this.clockFn()
      const rows = parseBars(raw)
      for (const candle of rows) {
        if (candle.t >= from && (to === undefined || candle.t <= to)) seen.set(candle.t, candle)
      }
      const next = (raw as { next_page_token?: unknown }).next_page_token
      token = typeof next === 'string' && next !== '' ? next : undefined
      if (token === undefined || rows.length === 0) break
    }
    return [...seen.values()].sort((a, b) => a.t - b.t)
  }

  /**
   * 美股没有标记价 / 资金费：markPrice 取最新成交价（没有则 bid/ask 中价），midPrice 一并给；
   * prevDayPrice 取快照里昨日日线的收盘。资金费相关键一律不写。没有缓存先拉一次快照。
   */
  async context(id: InstrumentId): Promise<MarketContext> {
    symbolOf(id)
    let hit = this.quotes.get(id)
    if (!hit) {
      await this.refreshQuote(id)
      hit = this.quotes.get(id)
    }
    if (!hit) {
      throw problemError('VENUE_UNAVAILABLE', `${VENUE} ${id} has no quote for context`, {
        retryable: true,
        venue: { id: VENUE, message: 'no usable quote' },
      })
    }
    const midPrice = (hit.bid + hit.ask) / 2
    return {
      instrumentId: id,
      ts: this.clockFn(),
      markPrice: hit.last !== undefined && hit.last > 0 ? hit.last : midPrice,
      midPrice,
      ...(hit.prevDayClose !== undefined ? { prevDayPrice: hit.prevDayClose } : {}),
    }
  }

  status(): MarketStatus {
    const now = this.clockFn()
    const last = this.lastMessageTs
    const usage = (this.budget as BudgetLike).usage?.()
    return {
      venue: VENUE,
      environment: 'mainnet',
      ts: now,
      wsState: 'disconnected',
      ...(usage ? { rateBudget: { used: usage.used, limit: usage.limit, windowMs: usage.windowMs } } : {}),
      stale: last === 0 || now - last > this.staleMs,
      source: 'rest',
      lastMessageTs: last,
    }
  }

  // ───────────── 订阅（轮询） ─────────────

  /** 只支持 quote 频道：按 pollMs 轮询快照，用 VenueEvent quote 回调。返回退订函数。 */
  subscribe(spec: SubscriptionSpec, cb: (e: VenueEvent) => void): Unsubscribe {
    if (this.closed) throw problemError('CAPABILITY_UNSUPPORTED', `${VENUE} data connector is closed`)
    if (spec.channel !== 'quote') {
      throw problemError('CAPABILITY_UNSUPPORTED', `${VENUE} data connector polls quote subscriptions only (got ${spec.channel})`)
    }
    const sub: PollSub = { id: spec.instrumentId, cb, active: true, inFlight: false }
    const timer = setInterval(() => { void this.poll(sub) }, this.pollMs)
    timer.unref?.()
    sub.timer = timer
    this.subs.add(sub)
    void this.poll(sub)
    return () => {
      if (!sub.active) return
      sub.active = false
      clearInterval(timer)
      this.subs.delete(sub)
    }
  }

  private async poll(sub: PollSub): Promise<void> {
    if (!sub.active || this.closed || sub.inFlight) return
    sub.inFlight = true
    try {
      const quote = await this.refreshQuote(sub.id)
      if (quote && sub.active) {
        try {
          sub.cb({ channel: 'quote', quote })
        } catch {
          // 订阅者异常不影响其它订阅
        }
      }
    } catch {
      // 本轮失败：保持轮询，下一轮重试（lastMessageTs 不前进，status() 自然显示陈旧）
    } finally {
      sub.inFlight = false
    }
  }
}

/** 纽约本地 HH:mm（判断 isOpenAt 用）。 */
export function nyTimeString(ms: Ms): string {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: NY_TZ, hour: '2-digit', minute: '2-digit', hour12: false,
  })
  const parts = fmt.formatToParts(new Date(ms))
  const hour = parts.find((p) => p.type === 'hour')?.value ?? '00'
  const minute = parts.find((p) => p.type === 'minute')?.value ?? '00'
  // en-GB 的 24 时制在 00:xx 会给出 "00"；个别 ICU 版本给 "24"（午夜），统一折成 "00"
  return `${hour === '24' ? '00' : hour}:${minute}`
}

/** 重导出：测试与调用方常用的常量（不额外掏实现细节）。 */
export const ALPACA_LIMITS = {
  maxCandles: MAX_CANDLES,
  pageLimit: CANDLE_PAGE,
  maxPages: MAX_PAGES,
  defaultCandleCount: DEFAULT_CANDLE_COUNT,
  rateLimit: RATE_LIMIT,
  rateWindowMs: RATE_WINDOW_MS,
  defaultFeed: DEFAULT_FEED,
} as const

