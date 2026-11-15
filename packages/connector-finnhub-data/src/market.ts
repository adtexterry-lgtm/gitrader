// SPDX-License-Identifier: CPAL-1.0
// Finnhub 只读行情（纯 REST）：标的清单（/stock/symbol）、K 线（/stock/candle）、最新成交价（/quote）、
// 最优一档（/stock/bidask，付费档）、市场状态（/stock/market-status）、休市与提前收盘（/stock/market-holiday）。
// 没有 WebSocket：subscribe 按 pollMs 轮询 /quote，status().source 恒为 'rest'。
// K 线按时间窗分页（官方未声明单次根数上限，本包每次请求覆盖 5000 × interval），最多 200 页。
import type { Book, Candle, CandleInterval, Instrument, InstrumentId, MarketContext, Ms, TradingSessionWindow } from '@gitrader/protocol'
import type { MarketStatus, RateBudget, StampedQuote, SubscriptionSpec, Unsubscribe, VenueEvent } from '@gitrader/protocol/connector'
import { FinnhubHttp, unlimitedBudget } from './http'
import type { BudgetLike } from './http'
import {
  CANDLE_PAGE, DEFAULT_BASE_URL, INTERVAL_MS, MAX_PAGES, REQUEST_WEIGHT, VENUE, buildSessions, clampCount, dedupeCandles,
  parseBidAsk, parseCandles, parseMarketHolidays, parseMarketStatus, parseQuote, parseSymbols, problemError, resolutionOf,
  resolveCredentials, symbolOf,
} from './parse'
import type { MarketHoliday, MarketState, SessionBuildOptions, TopOfBook } from './parse'

export { unlimitedBudget } from './http'

export interface FinnhubMarketOptions {
  /** 公共 REST 基址，缺省 https://finnhub.io/api/v1。 */
  baseUrl?: string
  /** API key；缺省读环境变量 FINNHUB_API_KEY（测试用 env 注入假环境）。 */
  apiKey?: string
  /** 环境变量来源（缺省 process.env，测试注入假对象）。 */
  env?: Record<string, string | undefined>
  /** 标的清单的市场代码（官方 /stock/symbol 的 exchange 参数），缺省 US。 */
  exchange?: string
  fetchImpl?: typeof fetch
  budget?: RateBudget | BudgetLike
  clock?: () => number
  /** 报价轮询间隔，缺省 5000 ms。 */
  pollMs?: number
  /** 行情陈旧阈值（quote 的 stale / status 的 stale），缺省 10 s。 */
  staleMs?: number
  httpTimeoutMs?: number
  /** sessions 的常规时段与扩展时段（Finnhub 不给时段，缺省 09:30–16:00 纽约本地）。 */
  sessions?: SessionBuildOptions
}

interface CachedQuote {
  ts: Ms
  bid: number
  ask: number
  last?: number
  prevClose?: number
}

interface PollSub {
  id: InstrumentId
  cb: (e: VenueEvent) => void
  active: boolean
  inFlight: boolean
  timer?: ReturnType<typeof setInterval>
}

export class FinnhubMarket {
  readonly exchange: string
  readonly http: FinnhubHttp

  private readonly budget: RateBudget | BudgetLike
  private readonly clockFn: () => number
  private readonly pollMs: number
  private readonly staleMs: number
  private readonly sessionTemplate: { tz: string; windows: TradingSessionWindow[] }

  private records = new Map<InstrumentId, Instrument>()
  private quotes = new Map<InstrumentId, CachedQuote>()
  private topBooks = new Map<InstrumentId, TopOfBook>()
  private subs = new Set<PollSub>()
  private lastMessageTs = 0
  private started = false
  private closed = false

  constructor(o: FinnhubMarketOptions = {}) {
    this.exchange = o.exchange === undefined || o.exchange.trim() === '' ? 'US' : o.exchange.trim().toUpperCase()
    this.clockFn = o.clock ?? (() => Date.now())
    this.budget = o.budget ?? unlimitedBudget()
    this.pollMs = Math.max(1, Math.floor(o.pollMs ?? 5000))
    this.staleMs = Math.max(1, Math.floor(o.staleMs ?? 10_000))
    this.sessionTemplate = buildSessions(o.sessions ?? {})
    this.http = new FinnhubHttp({
      baseUrl: o.baseUrl ?? DEFAULT_BASE_URL,
      // 构造期就校验密钥：没有 key 直接拒绝（Finnhub 无匿名行情），错误信息不含密钥
      credentials: resolveCredentials({ apiKey: o.apiKey, env: o.env }),
      fetchImpl: o.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args)),
      budget: this.budget,
      timeoutMs: o.httpTimeoutMs ?? 10_000,
    })
  }

  // ───────────── 生命周期 ─────────────

  /** 拉一次标的清单并缓存（重复调用不会重复拉）。 */
  async start(): Promise<void> {
    if (this.closed) throw problemError('CAPABILITY_UNSUPPORTED', 'finnhub data connector is closed')
    if (this.started) return
    await this.refreshInstruments()
    this.started = true
  }

  /** 强制重新发现标的（start 只拉一次；这里是显式刷新入口）。 */
  async refreshInstruments(): Promise<void> {
    if (this.closed) throw problemError('CAPABILITY_UNSUPPORTED', 'finnhub data connector is closed')
    const raw = await this.http.get<unknown>('/stock/symbol', { exchange: this.exchange }, REQUEST_WEIGHT)
    const now = this.clockFn()
    const next = new Map<InstrumentId, Instrument>()
    for (const instrument of parseSymbols(raw, now, this.sessionTemplate)) next.set(instrument.instrumentId, instrument)
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

  /** 协议 sessions（周模板）：美股常规时段，来自 buildSessions()，日期级例外见 marketHolidays()。 */
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
      instrumentId: id, ts: hit.ts, bid: hit.bid, ask: hit.ask,
      ...(hit.last !== undefined ? { last: hit.last } : {}),
      stale: ageMs > this.staleMs, ageMs,
    }
  }

  /**
   * GET /quote 并写入报价缓存。
   * 官方 /quote 只给最新成交价，不给买卖盘：`bid = ask = last`（价差未知），README 与 REPORT 都写明；
   * 真实 NBBO 走 bidAsk()（付费档端点）。
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
    this.quotes.set(id, cached)
    return this.quote(id)
  }

  /** GET /stock/bidask → 真实最优一档（付费档端点；免费 key 拿到 403 → VENUE_AUTH）。同时写入缓存供 book/context 用。 */
  async bidAsk(id: InstrumentId): Promise<TopOfBook | undefined> {
    const symbol = symbolOf(id)
    const raw = await this.http.get<unknown>('/stock/bidask', { symbol }, REQUEST_WEIGHT)
    this.lastMessageTs = this.clockFn()
    const parsed = parseBidAsk(raw)
    if (!parsed) {
      this.topBooks.delete(id)
      return undefined
    }
    this.topBooks.set(id, parsed)
    return { ...parsed }
  }

  /**
   * 最优一档盘口：Finnhub REST 只有 NBBO（没有 L2 深度），depth 被忽略，最多一档。
   * 上游未给挂单量时 size 记 0 表示**未知**（不猜），回测不得把 0 量当成可成交量。
   */
  async book(id: InstrumentId, _depth?: number): Promise<Book> {
    const top = await this.bidAsk(id)
    if (!top) {
      throw problemError('VENUE_UNAVAILABLE', `${VENUE} ${id} has no top-of-book quote`, {
        retryable: true,
        venue: { id: VENUE, message: 'no bid/ask' },
      })
    }
    const ts = top.ts > 0 ? top.ts : this.clockFn()
    return {
      instrumentId: id,
      ts,
      bids: [{ price: top.bid, size: top.bidSize ?? 0 }],
      asks: [{ price: top.ask, size: top.askSize ?? 0 }],
    }
  }

  /**
   * K 线。无 from：取最近 n 根（n 钳到 1..5000，缺省 300），一次请求。
   * 有 from：每次请求覆盖 5000 × interval 的时间窗，窗口尾 + 1 ms 继续推进（重叠按 t 去重，
   * from 不在 K 线网格上时也不会漏边界那根），直到越过 to（无 to 时推进到当前时刻），最多 200 页；
   * 返回升序、按 t 去重。空窗口不提前结束（from 早于上市日或落在长假里时继续往后翻）。
   * interval 不在官方 resolution 表里 → INVALID_PARAMS（不发请求）。
   */
  async candles(id: InstrumentId, interval: CandleInterval, opts: { n?: number; from?: Ms; to?: Ms } = {}): Promise<Candle[]> {
    const symbol = symbolOf(id)
    const resolution = resolutionOf(interval)
    const step = INTERVAL_MS[interval]

    if (opts.from === undefined) {
      const n = clampCount(opts.n)
      const nowMs = this.clockFn()
      const raw = await this.http.get<unknown>(
        '/stock/candle',
        { symbol, resolution, from: toSeconds(nowMs - n * step), to: toSeconds(nowMs) },
        REQUEST_WEIGHT,
      )
      this.lastMessageTs = this.clockFn()
      return dedupeCandles(parseCandles(raw)).slice(-n)
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
        '/stock/candle',
        { symbol, resolution, from: toSeconds(cursor), to: toSeconds(windowEnd) },
        REQUEST_WEIGHT,
      )
      this.lastMessageTs = this.clockFn()
      const rows = parseCandles(raw).filter((c) => c.t >= from && (to === undefined || c.t <= to))
      for (const candle of rows) seen.set(candle.t, candle)
      if (to !== undefined) {
        if (windowEnd >= to) break
      } else {
        if (windowEnd >= this.clockFn()) break
      }
      // +1 ms 而不是 +step：from 带偏移（如某分钟 +30 s）时，+step 会跳过边界那根；重叠由 seen 去重
      cursor = windowEnd + 1
    }
    return [...seen.values()].sort((a, b) => a.t - b.t)
  }

  /**
   * 美股没有标记价 / 资金费：markPrice 取最新成交价（没有则已缓存的一档中价），
   * midPrice 只在真实买卖盘（bidAsk）缓存过时给出，prevDayPrice 取 /quote 的昨收。
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
    const top = this.topBooks.get(id)
    const context: MarketContext = {
      instrumentId: id,
      ts: this.clockFn(),
      markPrice: hit.last !== undefined && hit.last > 0 ? hit.last : (hit.bid + hit.ask) / 2,
    }
    if (top) context.midPrice = (top.bid + top.ask) / 2
    if (hit.prevClose !== undefined) context.prevDayPrice = hit.prevClose
    return context
  }

  // ───────────── 市场状态 / 休市 ─────────────

  /** GET /stock/market-status（官方权威的开市判断：isOpen + session，含盘前盘后）。 */
  async marketStatus(): Promise<MarketState> {
    const raw = await this.http.get<unknown>('/stock/market-status', { exchange: this.exchange }, REQUEST_WEIGHT)
    this.lastMessageTs = this.clockFn()
    return parseMarketStatus(raw)
  }

  /** GET /stock/market-holiday：休市与提前收盘（tradingHour 形如 "09:30-13:00"）。协议 sessions 装不下，单独暴露。 */
  async marketHolidays(): Promise<MarketHoliday[]> {
    const raw = await this.http.get<unknown>('/stock/market-holiday', { exchange: this.exchange }, REQUEST_WEIGHT)
    this.lastMessageTs = this.clockFn()
    return parseMarketHolidays(raw)
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
    if (this.closed) throw problemError('CAPABILITY_UNSUPPORTED', 'finnhub data connector is closed')
    if (spec.channel !== 'quote') {
      throw problemError('CAPABILITY_UNSUPPORTED', `finnhub data connector polls quote subscriptions only (got ${spec.channel})`)
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

/** 毫秒 → 秒（Finnhub 的 from / to 是秒）。 */
const toSeconds = (ms: number): number => Math.floor(ms / 1000)
