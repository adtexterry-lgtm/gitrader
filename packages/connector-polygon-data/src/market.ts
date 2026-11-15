// SPDX-License-Identifier: CPAL-1.0
// Polygon 美股只读行情（纯 REST）：标的清单（/v3/reference/tickers 按 cursor 翻页）、
// 聚合 K 线（/v2/aggs/ticker/{ticker}/range/…）、快照（/v2/snapshot/…：真实 NBBO bid/ask + 最新成交）。
// 没有 WebSocket：subscribe 按 pollMs 轮询快照，status().source 恒为 'rest'。
// 盘口：快照给的是 lastQuote（NBBO 一档），book() 只返回这一档，depth 被忽略 —— 不造档位。
// 分页口径：聚合端点单次 limit 最大 50000；本包不写死「各 interval 的最长区间」（Polygon 文档按 multiplier 给上限，
// 施工时离线没核到确切表），改成「本页取满 limit 就用最后一根的下一毫秒作为新 from 继续」，上游若拒绝过长区间按错误码返回。
import type { Book, Candle, CandleInterval, Instrument, InstrumentId, MarketContext, Ms } from '@gitrader/protocol'
import type { MarketStatus, RateBudget, StampedQuote, SubscriptionSpec, Unsubscribe, VenueEvent } from '@gitrader/protocol/connector'
import { PolygonHttp, unlimitedBudget } from './http'
import type { PolygonHttpOptions, BudgetLike } from './http'
import {
  API_KEY_ENV, CANDLE_PAGE, DEFAULT_BASE_URL, DEFAULT_INSTRUMENT_PAGES, MAX_PAGES, RATE_LIMIT, RATE_WINDOW_MS,
  REQUEST_WEIGHT, TICKERS_PATH, VENUE, aggsPath, barMsOf, clampCount, intervalSpecOf, mayHaveMore, parseAggs,
  parseSnapshot, parseTickerPage, problemError, snapshotPath, symbolOf,
} from './parse'
import type { SnapshotQuote, TickerPage } from './parse'

export { unlimitedBudget } from './http'

export interface PolygonMarketOptions {
  /** API Key；缺省从环境变量 POLYGON_API_KEY 读。 */
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
  /** 标的清单最多翻多少页（每页 1000 支就停），缺省 100。 */
  instrumentPages?: number
  /** 只拉 active 标的（官方 active 参数），缺省 true。 */
  activeOnly?: boolean
}

interface PollSub {
  id: InstrumentId
  cb: (e: VenueEvent) => void
  active: boolean
  inFlight: boolean
  timer?: ReturnType<typeof setInterval>
}

export class PolygonMarket {
  readonly http: PolygonHttp

  private readonly budget: RateBudget | BudgetLike
  private readonly clockFn: () => number
  private readonly pollMs: number
  private readonly staleMs: number
  private readonly instrumentPages: number
  private readonly activeOnly: boolean

  private records = new Map<InstrumentId, Instrument>()
  private quotes = new Map<InstrumentId, { ts: Ms; quote: SnapshotQuote }>()
  private subs = new Set<PollSub>()
  private lastMessageTs = 0
  private started = false
  private closed = false

  constructor(o: PolygonMarketOptions = {}) {
    const apiKey = resolveApiKey(o)
    this.clockFn = o.clock ?? (() => Date.now())
    this.budget = o.budget ?? unlimitedBudget()
    this.pollMs = Math.max(1, Math.floor(o.pollMs ?? 5000))
    this.staleMs = Math.max(1, Math.floor(o.staleMs ?? 10_000))
    this.instrumentPages = Math.max(1, Math.floor(o.instrumentPages ?? DEFAULT_INSTRUMENT_PAGES))
    this.activeOnly = o.activeOnly !== false
    const httpOptions: PolygonHttpOptions = {
      baseUrl: o.baseUrl ?? DEFAULT_BASE_URL,
      apiKey,
      fetchImpl: o.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args)),
      budget: this.budget,
      timeoutMs: o.httpTimeoutMs ?? 10_000,
    }
    this.http = new PolygonHttp(httpOptions)
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

  /**
   * GET /v3/reference/tickers?market=stocks&active=true&limit=1000&cursor=… 按 cursor 翻页，
   * 最多 instrumentPages 页；每页结果合并进缓存（不清空已有，避免中途失败把清单打空）。
   */
  async refreshInstruments(): Promise<Instrument[]> {
    if (this.closed) throw problemError('CAPABILITY_UNSUPPORTED', `${VENUE} data connector is closed`)
    const now = this.clockFn()
    const merged = new Map<InstrumentId, Instrument>(this.records)
    let cursor: string | undefined
    let pages = 0
    for (let page = 0; page < this.instrumentPages; page++) {
      const raw = await this.http.getJson<unknown>(TICKERS_PATH, {
        market: 'stocks',
        ...(this.activeOnly ? { active: 'true' } : {}),
        limit: 1000,
        ...(cursor !== undefined ? { cursor } : {}),
      }, REQUEST_WEIGHT)
      const parsed: TickerPage = parseTickerPage(raw, now)
      for (const instrument of parsed.instruments) merged.set(instrument.instrumentId, instrument)
      pages += 1
      cursor = parsed.cursor
      if (cursor === undefined) break
    }
    this.records = merged
    this.lastMessageTs = this.clockFn()
    if (this.records.size === 0) {
      throw problemError('VENUE_UNAVAILABLE', `${VENUE} tickers returned no instruments after ${pages} page(s)`, {
        retryable: true, venue: { id: VENUE, message: 'empty ticker list' },
      })
    }
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
   * 无 from：按「n × 周期 × 4 + 7 天」的回看窗口取（节假日 / 停牌占掉一些，窗口留四倍余量），再取尾部 n 根；
   * 想精确要历史就显式给 from。有 from：从 from 起按页推进（本页取满 limit 就用最后一根 + 1 ms 作为新 from），
   * 每页再按 [from, to] 过滤，升序去重，最多 MAX_PAGES 页。
   */
  async candles(id: InstrumentId, interval: CandleInterval, opts: { n?: number; from?: Ms; to?: Ms } = {}): Promise<Candle[]> {
    if (this.closed) throw problemError('CAPABILITY_UNSUPPORTED', `${VENUE} data connector is closed`)
    const symbol = symbolOf(id)
    const spec = intervalSpecOf(interval)

    if (opts.from === undefined) {
      const n = clampCount(opts.n)
      const to = opts.to === undefined ? this.clockFn() : Math.floor(opts.to)
      const lookback = n * barMsOf(interval) * 4 + 7 * 86_400_000
      const from = Math.max(0, to - lookback)
      const raw = await this.http.getJson<unknown>(
        aggsPath(symbol, spec.multiplier, spec.timespan, from, to),
        { adjusted: 'true', sort: 'asc', limit: CANDLE_PAGE },
        REQUEST_WEIGHT,
      )
      this.lastMessageTs = this.clockFn()
      const candles = parseAggs(raw)
      return (opts.to === undefined ? candles : candles.filter((c) => c.t <= to)).slice(-n)
    }

    const from = Math.floor(opts.from)
    const to = opts.to === undefined ? undefined : Math.floor(opts.to)
    if (to !== undefined && to < from) return []
    const seen = new Map<Ms, Candle>()
    let cursorFrom = from
    for (let page = 0; page < MAX_PAGES; page++) {
      const windowTo = to ?? this.clockFn()
      const raw = await this.http.getJson<unknown>(
        aggsPath(symbol, spec.multiplier, spec.timespan, cursorFrom, windowTo),
        { adjusted: 'true', sort: 'asc', limit: CANDLE_PAGE },
        REQUEST_WEIGHT,
      )
      this.lastMessageTs = this.clockFn()
      const rows = parseAggs(raw)
      for (const candle of rows) {
        if (candle.t >= from && (to === undefined || candle.t <= to)) seen.set(candle.t, candle)
      }
      if (!mayHaveMore(raw, rows.length, CANDLE_PAGE) || rows.length === 0) break
      const last = rows[rows.length - 1]!
      const nextFrom = last.t + 1
      if (nextFrom <= cursorFrom) break
      cursorFrom = nextFrom
      if (to !== undefined && cursorFrom > to) break
    }
    return [...seen.values()].sort((a, b) => a.t - b.t)
  }

  // ───────────── 报价 / 盘口 ─────────────

  /** 最近一次 refreshQuote 的结果（同步、不联网）；没拉过就 undefined。 */
  quote(id: InstrumentId): StampedQuote | undefined {
    const hit = this.quotes.get(id)
    if (!hit) return undefined
    const now = this.clockFn()
    const ageMs = Math.max(0, now - hit.ts)
    return {
      instrumentId: id,
      ts: hit.quote.ts,
      bid: hit.quote.bid,
      ask: hit.quote.ask,
      ...(hit.quote.last !== undefined ? { last: hit.quote.last } : {}),
      stale: ageMs > this.staleMs,
      ageMs,
    }
  }

  /** 快照里协议没有的字段（一档买卖量、昨收、当日量与 VWAP），只供展示。 */
  quoteDetail(id: InstrumentId): SnapshotQuote | undefined {
    const hit = this.quotes.get(id)
    return hit ? { ...hit.quote } : undefined
  }

  /** GET /v2/snapshot/locale/us/markets/stocks/tickers/{symbol}；没有有效 bid/ask → 清缓存并返回 undefined。 */
  async refreshQuote(id: InstrumentId): Promise<StampedQuote | undefined> {
    if (this.closed) throw problemError('CAPABILITY_UNSUPPORTED', `${VENUE} data connector is closed`)
    const symbol = symbolOf(id)
    const raw = await this.http.getJson<unknown>(snapshotPath(symbol), {}, REQUEST_WEIGHT)
    const now = this.clockFn()
    this.lastMessageTs = now
    const parsed = parseSnapshot(raw)
    if (!parsed) {
      this.quotes.delete(id)
      return undefined
    }
    this.quotes.set(id, { ts: now, quote: parsed })
    return this.quote(id)
  }

  /**
   * 最优一档：快照的 lastQuote（NBBO 的 bid p / ask P 与 size s / S）。美股没有 L2 深度，depth 被忽略；
   * 某一侧没有数量就不编造，留空。
   */
  async book(id: InstrumentId, _depth?: number): Promise<Book> {
    const quote = await this.refreshQuote(id)
    if (!quote) {
      throw problemError('VENUE_UNAVAILABLE', `${VENUE} ${id} has no top-of-book quote`, {
        retryable: true, venue: { id: VENUE, message: 'no quote' },
      })
    }
    const hit = this.quotes.get(id)
    const bids = hit?.quote.bidSize !== undefined ? [{ price: hit.quote.bid, size: hit.quote.bidSize }] : []
    const asks = hit?.quote.askSize !== undefined ? [{ price: hit.quote.ask, size: hit.quote.askSize }] : []
    return { instrumentId: id, ts: hit?.quote.ts ?? this.clockFn(), bids, asks }
  }

  /**
   * 美股没有标记价 / 资金费：markPrice 取最新成交价（没有则买卖中价），midPrice 一并给；
   * prevDayPrice 取快照的 prevDay.c；dayNotionalVolume = 当日成交量 × 当日 VWAP（Polygon 的 day.v / day.vw）。
   */
  async context(id: InstrumentId): Promise<MarketContext> {
    let hit = this.quotes.get(id)
    if (!hit) {
      await this.refreshQuote(id)
      hit = this.quotes.get(id)
    }
    if (!hit) {
      throw problemError('VENUE_UNAVAILABLE', `${VENUE} ${id} has no quote for context`, {
        retryable: true, venue: { id: VENUE, message: 'no usable quote' },
      })
    }
    const midPrice = (hit.quote.bid + hit.quote.ask) / 2
    const notional = hit.quote.dayVolume !== undefined && hit.quote.dayVwap !== undefined
      ? hit.quote.dayVolume * hit.quote.dayVwap
      : undefined
    return {
      instrumentId: id,
      ts: this.clockFn(),
      markPrice: hit.quote.last !== undefined && hit.quote.last > 0 ? hit.quote.last : midPrice,
      midPrice,
      ...(hit.quote.prevClose !== undefined ? { prevDayPrice: hit.quote.prevClose } : {}),
      ...(notional !== undefined ? { dayNotionalVolume: notional } : {}),
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

/** API Key：构造参数优先，其次环境变量 POLYGON_API_KEY。都没有 → VENUE_AUTH（不打印、不回落成无 key 请求）。 */
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
export const POLYGON_LIMITS = {
  rateLimit: RATE_LIMIT,
  rateWindowMs: RATE_WINDOW_MS,
  pageSize: CANDLE_PAGE,
  maxPages: MAX_PAGES,
  defaultInstrumentPages: DEFAULT_INSTRUMENT_PAGES,
} as const
