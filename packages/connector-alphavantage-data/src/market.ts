// SPDX-License-Identifier: CPAL-1.0
// Alpha Vantage 美股只读行情（纯 REST）：标的清单（LISTING_STATUS 的 CSV）、K 线（盘中 / 日 / 周 / 月时间序列）、
// 最新价（GLOBAL_QUOTE）。没有 WebSocket：subscribe 按 pollMs 轮询报价，status().source 恒为 'rest'。
// 盘口：Alpha Vantage 免费档不给买卖价（GLOBAL_QUOTE 只有 05. price），所以 book() 抛 CAPABILITY_UNSUPPORTED，
// 不造档位；quote 的 bid / ask 都取最新价，并在 capabilities 的 'x-quote' 里标成 'last-only'。
// 时间口径：盘中时间戳是美东 `YYYY-MM-DD HH:mm:ss`，按美东折成 UTC 毫秒；日线取交易日期美东 00:00，
// 周线取该周周一 00:00，月线取该月 1 日 00:00（README「时间口径」写明）。
import type { Book, Candle, CandleInterval, Instrument, InstrumentId, MarketContext, Ms } from '@gitrader/protocol'
import type { MarketStatus, RateBudget, StampedQuote, SubscriptionSpec, Unsubscribe, VenueEvent } from '@gitrader/protocol/connector'
import { AlphaVantageHttp, unlimitedBudget } from './http'
import type { AlphaVantageHttpOptions, BudgetLike } from './http'
import {
  API_KEY_ENV, CANDLE_PAGE, DEFAULT_BASE_URL, MAX_PAGES, RATE_LIMIT, RATE_WINDOW_MS, REQUEST_WEIGHT, SUPPORTED_INTERVALS,
  VENUE, clampCount, dedupeCandles, etMonthOf, nextMonth, parseGlobalQuote, parseListingCsv, parseSeries, problemError,
  seriesSpecOf, symbolOf,
} from './parse'
import type { GlobalQuote } from './parse'

export { unlimitedBudget } from './http'

export interface AlphaVantageMarketOptions {
  /** API Key；缺省从环境变量读（ALPHAVANTAGE_API_KEY，其次 ALPHA_VANTAGE_API_KEY）。 */
  apiKey?: string
  /** 环境变量来源（缺省 process.env，测试注入假对象）。 */
  env?: Record<string, string | undefined>
  baseUrl?: string
  fetchImpl?: typeof fetch
  budget?: RateBudget | BudgetLike
  clock?: () => number
  /** 报价轮询间隔，缺省 5000 ms。 */
  pollMs?: number
  /** 行情陈旧阈值（quote 的 stale / status 的 stale），缺省 10 s。 */
  staleMs?: number
  httpTimeoutMs?: number
  /** LISTING_STATUS 的 date 参数（缺省不带 = 最新交易日）。 */
  listingDate?: string
}

interface PollSub {
  id: InstrumentId
  cb: (e: VenueEvent) => void
  active: boolean
  inFlight: boolean
  timer?: ReturnType<typeof setInterval>
}

interface CachedQuote {
  ts: Ms
  quote: GlobalQuote
}

export class AlphaVantageMarket {
  readonly http: AlphaVantageHttp

  private readonly budget: RateBudget | BudgetLike
  private readonly clockFn: () => number
  private readonly pollMs: number
  private readonly staleMs: number
  private readonly listingDate: string | undefined

  private records = new Map<InstrumentId, Instrument>()
  private quotes = new Map<InstrumentId, CachedQuote>()
  private subs = new Set<PollSub>()
  private lastMessageTs = 0
  private started = false
  private closed = false

  constructor(o: AlphaVantageMarketOptions = {}) {
    const apiKey = resolveApiKey(o)
    this.clockFn = o.clock ?? (() => Date.now())
    this.budget = o.budget ?? unlimitedBudget()
    this.pollMs = Math.max(1, Math.floor(o.pollMs ?? 5000))
    this.staleMs = Math.max(1, Math.floor(o.staleMs ?? 10_000))
    this.listingDate = o.listingDate
    const httpOptions: AlphaVantageHttpOptions = {
      baseUrl: o.baseUrl ?? DEFAULT_BASE_URL,
      apiKey,
      fetchImpl: o.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args)),
      budget: this.budget,
      timeoutMs: o.httpTimeoutMs ?? 10_000,
    }
    this.http = new AlphaVantageHttp(httpOptions)
  }

  // ───────────── 生命周期 ─────────────

  /** 拉一次标的清单并缓存；重复调用不重复拉。 */
  async start(): Promise<void> {
    if (this.closed) throw problemError('CAPABILITY_UNSUPPORTED', `${VENUE} data connector is closed`)
    if (this.started) return
    await this.refreshInstruments()
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

  // ───────────── 目录 ─────────────

  /** GET /query?function=LISTING_STATUS（CSV）→ 缓存标的（按 symbol 升序）。 */
  async refreshInstruments(): Promise<Instrument[]> {
    if (this.closed) throw problemError('CAPABILITY_UNSUPPORTED', `${VENUE} data connector is closed`)
    const text = await this.http.queryText(
      { function: 'LISTING_STATUS', ...(this.listingDate !== undefined ? { date: this.listingDate } : {}), datatype: 'csv' },
      REQUEST_WEIGHT,
    )
    const now = this.clockFn()
    const records = new Map<InstrumentId, Instrument>()
    for (const instrument of parseListingCsv(text, now)) records.set(instrument.instrumentId, instrument)
    if (records.size === 0) {
      throw problemError('VENUE_UNAVAILABLE', `${VENUE} LISTING_STATUS returned no instruments`, {
        retryable: true, venue: { id: VENUE, message: 'empty listing' },
      })
    }
    this.records = records
    this.lastMessageTs = now
    return this.listInstruments()
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

  // ───────────── K 线 ─────────────

  /**
   * 无 from：取最近 n 根（n 钳到 1..MAX_CANDLES，缺省 100）；日线 n ≤ 100 用 compact（官方：最近 100 根），
   * 否则用 full（官方：只有付费 key 给 full）。周线 / 月线只有 datatype 参数（没有 outputsize），直接取全历史。
   * 有 from：盘中按月切片（`month=YYYY-MM`，美东自然月）推进，日线一次 full 拉回，周 / 月线一次全历史拉回，
   * 再本地按 [from, to] 过滤；升序去重，最多 MAX_PAGES 页。interval 不在映射表里直接 INVALID_PARAMS（不发请求）。
   */
  async candles(id: InstrumentId, interval: CandleInterval, opts: { n?: number; from?: Ms; to?: Ms } = {}): Promise<Candle[]> {
    if (this.closed) throw problemError('CAPABILITY_UNSUPPORTED', `${VENUE} data connector is closed`)
    const symbol = symbolOf(id)
    const spec = seriesSpecOf(interval)
    const withOutputsize = spec.kind === 'intraday' || spec.period === 'day'

    if (opts.from === undefined) {
      const n = clampCount(opts.n)
      const outputsize = n <= CANDLE_PAGE ? 'compact' : 'full'
      const raw = await this.http.queryJson(
        {
          function: spec.kind === 'intraday' ? 'TIME_SERIES_INTRADAY' : spec.fn,
          symbol,
          ...(spec.kind === 'intraday' ? { interval: spec.avInterval } : {}),
          ...(withOutputsize ? { outputsize } : {}),
          datatype: 'json',
        },
        REQUEST_WEIGHT,
      )
      this.lastMessageTs = this.clockFn()
      const key = spec.kind === 'intraday' ? `Time Series (${spec.avInterval})` : spec.key
      const period = spec.kind === 'intraday' ? 'day' : spec.period
      return dedupeCandles(parseSeries(raw, key, period)).slice(-n)
    }

    const from = Math.floor(opts.from)
    const to = opts.to === undefined ? undefined : Math.floor(opts.to)
    if (to !== undefined && to < from) return []
    const seen = new Map<Ms, Candle>()

    if (spec.kind === 'intraday') {
      const lastMonth = etMonthOf(to ?? this.clockFn())
      let month = etMonthOf(from)
      for (let page = 0; page < MAX_PAGES; page++) {
        if (month > lastMonth) break
        const raw = await this.http.queryJson(
          {
            function: 'TIME_SERIES_INTRADAY', symbol, interval: spec.avInterval,
            outputsize: 'full', month, datatype: 'json',
          },
          REQUEST_WEIGHT,
        )
        this.lastMessageTs = this.clockFn()
        for (const candle of parseSeries(raw, `Time Series (${spec.avInterval})`)) {
          if (candle.t >= from && (to === undefined || candle.t <= to)) seen.set(candle.t, candle)
        }
        if (month === lastMonth) break
        month = nextMonth(month)
      }
    } else {
      const raw = await this.http.queryJson(
        { function: spec.fn, symbol, ...(withOutputsize ? { outputsize: 'full' } : {}), datatype: 'json' },
        REQUEST_WEIGHT,
      )
      this.lastMessageTs = this.clockFn()
      for (const candle of parseSeries(raw, spec.key, spec.period)) {
        if (candle.t >= from && (to === undefined || candle.t <= to)) seen.set(candle.t, candle)
      }
    }
    return [...seen.values()].sort((a, b) => a.t - b.t)
  }

  // ───────────── 报价 ─────────────

  /** 最近一次 refreshQuote 的结果（同步、不联网）；没拉过就 undefined。 */
  quote(id: InstrumentId): StampedQuote | undefined {
    const hit = this.quotes.get(id)
    if (!hit) return undefined
    const now = this.clockFn()
    const ageMs = Math.max(0, now - hit.ts)
    // 免费档没有买卖价：两侧都用最新价，别当真实价差用（capabilities 里 'x-quote': 'last-only'）
    return {
      instrumentId: id, ts: hit.ts, bid: hit.quote.price, ask: hit.quote.price,
      last: hit.quote.price, stale: ageMs > this.staleMs, ageMs,
    }
  }

  /** 最近一次 GLOBAL_QUOTE 的原始字段（昨收 / 成交量 / 交易日），协议没有对应字段，只供展示。 */
  quoteDetail(id: InstrumentId): GlobalQuote | undefined {
    const hit = this.quotes.get(id)
    return hit ? { ...hit.quote } : undefined
  }

  /** GET /query?function=GLOBAL_QUOTE：写缓存并返回；`{"Global Quote": {}}`（未知标的）→ 清缓存并返回 undefined。 */
  async refreshQuote(id: InstrumentId): Promise<StampedQuote | undefined> {
    if (this.closed) throw problemError('CAPABILITY_UNSUPPORTED', `${VENUE} data connector is closed`)
    const symbol = symbolOf(id)
    const raw = await this.http.queryJson({ function: 'GLOBAL_QUOTE', symbol, datatype: 'json' }, REQUEST_WEIGHT)
    const now = this.clockFn()
    this.lastMessageTs = now
    const parsed = parseGlobalQuote(raw)
    if (!parsed) {
      this.quotes.delete(id)
      return undefined
    }
    this.quotes.set(id, { ts: now, quote: parsed })
    return this.quote(id)
  }

  /** 免费档没有盘口：不造档位，直接拒绝（capabilities 的 'x-book': 'none'）。 */
  async book(id: InstrumentId, _depth?: number): Promise<Book> {
    symbolOf(id)
    throw problemError(
      'CAPABILITY_UNSUPPORTED',
      `${VENUE} free tier publishes no bid/ask; order book is unavailable (use quote() for the last price)`,
    )
  }

  /**
   * 美股没有标记价 / 资金费：markPrice 与 midPrice 都取最新价（midPrice = 最新价，不是真实中价，因为无买卖价），
   * prevDayPrice 取 GLOBAL_QUOTE 的 08. previous close。没有缓存先拉一次。
   */
  async context(id: InstrumentId): Promise<MarketContext> {
    let hit = this.quotes.get(id)
    if (!hit) {
      await this.refreshQuote(id)
      hit = this.quotes.get(id)
    }
    if (!hit) {
      throw problemError('VENUE_UNAVAILABLE', `${VENUE} ${id} has no price for context`, {
        retryable: true, venue: { id: VENUE, message: 'no usable quote' },
      })
    }
    return {
      instrumentId: id,
      ts: this.clockFn(),
      markPrice: hit.quote.price,
      midPrice: hit.quote.price,
      ...(hit.quote.prevClose !== undefined ? { prevDayPrice: hit.quote.prevClose } : {}),
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

  /** 只支持 quote 频道：按 pollMs 轮询 GLOBAL_QUOTE，用 VenueEvent quote 回调。返回退订函数。 */
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

/** API Key：构造参数优先，其次环境变量（两个常见写法）。都没有 → VENUE_AUTH（不打印、不回落成无 key 请求）。 */
export function resolveApiKey(o: { apiKey?: string; env?: Record<string, string | undefined> }): string {
  const direct = typeof o.apiKey === 'string' ? o.apiKey.trim() : ''
  if (direct !== '') return direct
  const env = o.env ?? (process.env as Record<string, string | undefined>)
  for (const name of API_KEY_ENV) {
    const value = (env[name] ?? '').trim()
    if (value !== '') return value
  }
  throw problemError('VENUE_AUTH', `${VENUE} needs an API key in ${API_KEY_ENV.join(' or ')}`)
}

/** 供调用方诊断用的常量表（不含密钥）。 */
export const ALPHAVANTAGE_LIMITS = {
  rateLimit: RATE_LIMIT,
  rateWindowMs: RATE_WINDOW_MS,
  pageSize: CANDLE_PAGE,
  maxPages: MAX_PAGES,
  intervals: SUPPORTED_INTERVALS,
} as const
