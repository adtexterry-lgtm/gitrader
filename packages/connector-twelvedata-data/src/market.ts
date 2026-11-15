// SPDX-License-Identifier: CPAL-1.0
// Twelve Data 只读行情（纯 REST）：标的清单（/stocks）、K 线（/time_series，timezone=UTC）、
// 最新报价（/quote）、市场状态（/market_state）。没有 WebSocket：subscribe 按 pollMs 轮询 /quote，
// status().source 恒为 'rest'。K 线按 5000 × interval 的时间窗分页（官方 outputsize 上限 5000），最多 200 页。
import type { Book, Candle, CandleInterval, Instrument, InstrumentId, MarketContext, Ms, TradingSessionWindow } from '@gitrader/protocol'
import type { MarketStatus, RateBudget, StampedQuote, SubscriptionSpec, Unsubscribe, VenueEvent } from '@gitrader/protocol/connector'
import { TwelveDataHttp, unlimitedBudget } from './http'
import type { BudgetLike } from './http'
import {
  CANDLE_PAGE, DEFAULT_BASE_URL, INTERVAL_MS, MAX_PAGES, REQUEST_WEIGHT, VENUE, buildSessions, clampCount, dedupeCandles,
  intervalOf, parseMarketState, parseQuote, parseStocks, parseTimeSeries, problemError, resolveCredentials, symbolOf,
} from './parse'
import type { MarketState, SessionBuildOptions } from './parse'

export { unlimitedBudget } from './http'

export interface TwelveDataMarketOptions {
  /** 公共 REST 基址，缺省 https://api.twelvedata.com。 */
  baseUrl?: string
  /** API key；缺省读环境变量 TWELVEDATA_API_KEY（测试用 env 注入假环境）。 */
  apiKey?: string
  /** 环境变量来源（缺省 process.env，测试注入假对象）。 */
  env?: Record<string, string | undefined>
  /** 标的清单的交易所代码（官方 /stocks 的 exchange 参数），缺省 NASDAQ。 */
  exchange?: string
  fetchImpl?: typeof fetch
  budget?: RateBudget | BudgetLike
  clock?: () => number
  /** 报价轮询间隔，缺省 5000 ms。 */
  pollMs?: number
  /** 行情陈旧阈值（quote 的 stale / status 的 stale），缺省 10 s。 */
  staleMs?: number
  httpTimeoutMs?: number
  /** sessions 的时区 / 开收盘 / 交易日（Twelve Data 不给开收盘时间，缺省 09:30–16:00 America/New_York）。 */
  sessions?: SessionBuildOptions
}

interface CachedQuote {
  ts: Ms
  bid: number
  ask: number
  last: number
  prevClose?: number
  volume?: number
}

interface PollSub {
  id: InstrumentId
  cb: (e: VenueEvent) => void
  active: boolean
  inFlight: boolean
  timer?: ReturnType<typeof setInterval>
}

export class TwelveDataMarket {
  readonly exchange: string
  readonly http: TwelveDataHttp

  private readonly budget: RateBudget | BudgetLike
  private readonly clockFn: () => number
  private readonly pollMs: number
  private readonly staleMs: number
  private readonly sessionTemplate: { tz: string; windows: TradingSessionWindow[] }

  private records = new Map<InstrumentId, Instrument>()
  private quotes = new Map<InstrumentId, CachedQuote>()
  private subs = new Set<PollSub>()
  private lastMessageTs = 0
  private started = false
  private closed = false

  constructor(o: TwelveDataMarketOptions = {}) {
    this.exchange = o.exchange === undefined || o.exchange.trim() === '' ? 'NASDAQ' : o.exchange.trim().toUpperCase()
    this.clockFn = o.clock ?? (() => Date.now())
    this.budget = o.budget ?? unlimitedBudget()
    this.pollMs = Math.max(1, Math.floor(o.pollMs ?? 5000))
    this.staleMs = Math.max(1, Math.floor(o.staleMs ?? 10_000))
    this.sessionTemplate = buildSessions(o.sessions ?? {})
    this.http = new TwelveDataHttp({
      baseUrl: o.baseUrl ?? DEFAULT_BASE_URL,
      // 构造期就校验密钥：没有 key 直接拒绝（Twelve Data 无匿名行情），错误信息不含密钥
      credentials: resolveCredentials({ apiKey: o.apiKey, env: o.env }),
      fetchImpl: o.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args)),
      budget: this.budget,
      timeoutMs: o.httpTimeoutMs ?? 10_000,
    })
  }

  // ───────────── 生命周期 ─────────────

  /** 拉一次标的清单并缓存（重复调用不会重复拉）。 */
  async start(): Promise<void> {
    if (this.closed) throw problemError('CAPABILITY_UNSUPPORTED', 'twelvedata data connector is closed')
    if (this.started) return
    await this.refreshInstruments()
    this.started = true
  }

  /** 强制重新发现标的（start 只拉一次；这里是显式刷新入口）。 */
  async refreshInstruments(): Promise<void> {
    if (this.closed) throw problemError('CAPABILITY_UNSUPPORTED', 'twelvedata data connector is closed')
    const raw = await this.http.get<unknown>('/stocks', { exchange: this.exchange }, REQUEST_WEIGHT)
    const now = this.clockFn()
    const next = new Map<InstrumentId, Instrument>()
    for (const instrument of parseStocks(raw, now, this.sessionTemplate)) next.set(instrument.instrumentId, instrument)
    this.records = next
    this.lastMessageTs = now
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

  // ───────────── 目录 ─────────────

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

  /** 协议 sessions（周模板）：时段惯例生成的常规窗口，权威开市判断见 marketState()。 */
  sessionsTemplate(): { tz: string; windows: TradingSessionWindow[] } {
    return { tz: this.sessionTemplate.tz, windows: this.sessionTemplate.windows.map((w) => ({ ...w, days: [...w.days] })) }
  }

  // ───────────── 行情读取 ─────────────

  /** 最近一次 refreshQuote 的结果（同步、不联网）；没拉过就 undefined。 */
  quote(id: InstrumentId): StampedQuote | undefined {
    const hit = this.quotes.get(id)
    if (!hit) return undefined
    const now = this.clockFn()
    const ageMs = Math.max(0, now - hit.ts)
    return {
      instrumentId: id, ts: hit.ts, bid: hit.bid, ask: hit.ask, last: hit.last,
      stale: ageMs > this.staleMs, ageMs,
    }
  }

  /**
   * GET /quote 并写入报价缓存。
   * 官方 /quote 只有 `close`（最新成交价），没有买卖盘：`bid = ask = last`（价差未知），README 与 REPORT 写明。
   */
  async refreshQuote(id: InstrumentId): Promise<StampedQuote | undefined> {
    const symbol = symbolOf(id)
    const raw = await this.http.get<unknown>('/quote', { symbol }, REQUEST_WEIGHT)
    const now = this.clockFn()
    this.lastMessageTs = now
    const parsed = parseQuote(raw)
    if (!parsed) {
      this.quotes.delete(id)
      return undefined
    }
    const cached: CachedQuote = { ts: parsed.ts > 0 ? parsed.ts : now, bid: parsed.last, ask: parsed.last, last: parsed.last }
    if (parsed.prevClose !== undefined) cached.prevClose = parsed.prevClose
    if (parsed.volume !== undefined) cached.volume = parsed.volume
    this.quotes.set(id, cached)
    return this.quote(id)
  }

  /** Twelve Data 的 REST 没有盘口（无 L2、也无最优一档）：老实拒绝，不拿成交价编一档。 */
  book(_id: InstrumentId, _depth?: number): Promise<Book> {
    return Promise.reject(problemError(
      'CAPABILITY_UNSUPPORTED',
      'twelvedata data connector has no order book (REST quotes carry no bid/ask)',
    ))
  }

  /**
   * K 线。无 from：取最近 n 根（n 钳到 1..5000，缺省 300），一次请求。
   * 有 from：每次请求覆盖 5000 × interval 的时间窗（UTC 的 start_date / end_date），
   * 向后推进直到越过 to（无 to 时推进到当前时刻），最多 200 页；返回升序、按 t 去重。
   * interval 不在官方表里 → INVALID_PARAMS（不发请求）。
   */
  async candles(id: InstrumentId, interval: CandleInterval, opts: { n?: number; from?: Ms; to?: Ms } = {}): Promise<Candle[]> {
    const symbol = symbolOf(id)
    const vendorInterval = intervalOf(interval)
    const step = INTERVAL_MS[interval]

    if (opts.from === undefined) {
      const n = clampCount(opts.n)
      const raw = await this.http.get<unknown>(
        '/time_series',
        { symbol, interval: vendorInterval, outputsize: n, order: 'desc', timezone: 'UTC' },
        REQUEST_WEIGHT,
      )
      this.lastMessageTs = this.clockFn()
      return dedupeCandles(parseTimeSeries(raw)).slice(-n)
    }

    const from = Math.floor(opts.from)
    const to = opts.to === undefined ? undefined : Math.floor(opts.to)
    if (to !== undefined && to < from) return []
    const windowMs = step * CANDLE_PAGE
    const seen = new Map<Ms, Candle>()
    let cursor = from
    for (let page = 0; page < MAX_PAGES; page++) {
      const lastOfWindow = cursor + windowMs - step
      const windowEnd = to === undefined ? lastOfWindow : Math.min(to, lastOfWindow)
      const raw = await this.http.get<unknown>(
        '/time_series',
        {
          symbol,
          interval: vendorInterval,
          start_date: utcDateTime(cursor),
          end_date: utcDateTime(windowEnd),
          outputsize: CANDLE_PAGE,
          order: 'asc',
          timezone: 'UTC',
        },
        REQUEST_WEIGHT,
      )
      this.lastMessageTs = this.clockFn()
      const rows = parseTimeSeries(raw).filter((c) => c.t >= from && (to === undefined || c.t <= to))
      for (const candle of rows) seen.set(candle.t, candle)
      if (to !== undefined) {
        if (windowEnd >= to) break
      } else {
        if (windowEnd >= this.clockFn()) break
      }
      cursor = windowEnd + 1
    }
    return [...seen.values()].sort((a, b) => a.t - b.t)
  }

  /** 股票没有标记价 / 资金费：markPrice 取最新成交价，prevDayPrice 取 /quote 的 previous_close。 */
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
    const context: MarketContext = { instrumentId: id, ts: this.clockFn(), markPrice: hit.last }
    if (hit.prevClose !== undefined) context.prevDayPrice = hit.prevClose
    return context
  }

  // ───────────── 市场状态 ─────────────

  /** GET /market_state：官方权威开市判断（is_market_open + 到开盘 / 收盘的倒计时）。 */
  async marketState(): Promise<MarketState> {
    const raw = await this.http.get<unknown>('/market_state', { exchange: this.exchange }, REQUEST_WEIGHT)
    this.lastMessageTs = this.clockFn()
    return parseMarketState(raw, this.exchange)
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

  /** 只支持 quote 频道：按 pollMs 轮询 /quote，用 VenueEvent quote 回调。返回退订函数。 */
  subscribe(spec: SubscriptionSpec, cb: (e: VenueEvent) => void): Unsubscribe {
    if (this.closed) throw problemError('CAPABILITY_UNSUPPORTED', 'twelvedata data connector is closed')
    if (spec.channel !== 'quote') {
      throw problemError('CAPABILITY_UNSUPPORTED', `twelvedata data connector polls quote subscriptions only (got ${spec.channel})`)
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

/** 毫秒 → `YYYY-MM-DD HH:mm:ss`（UTC，官方 start_date / end_date 的写法）。 */
export function utcDateTime(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
}
