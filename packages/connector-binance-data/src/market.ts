// SPDX-License-Identifier: CPAL-1.0
// Binance USDⓈ-M 期货行情（只读、纯 REST）：交易所目录、K 线翻页、盘口、报价轮询、资金费率。
// 没有 WebSocket：subscribe 按 pollMs 轮询 /fapi/v1/ticker/bookTicker，status().source 恒为 'rest'。
// 每个请求前先向注入的权重预算要额度；预算对象缺省不限。
import type { Book, Candle, CandleInterval, FundingRatePoint, Instrument, InstrumentId, MarketContext, Ms } from '@gitrader/protocol'
import type {
  BudgetUsage, MarketStatus, RateBudget, StampedQuote, SubscriptionSpec, Unsubscribe, VenueEvent,
} from '@gitrader/protocol/connector'
import {
  BOOK_TICKER_WEIGHT, CANDLE_PAGE, DEFAULT_BASE_URL, DEFAULT_CANDLE_COUNT, EXCHANGE_INFO_WEIGHT, FUNDING_PAGE, FUNDING_PAGE_GAP_MS, FUNDING_RATE_WEIGHT,
  INTERVAL_MS, IP_WEIGHT_LIMIT, IP_WEIGHT_WINDOW_MS, MAX_CANDLES, MAX_PAGES, PREMIUM_INDEX_WEIGHT, ProblemError, VENUE, depthLimitOf, depthWeight, klineWeight,
  parseBookTicker, parseDepth, parseFundingRates, parseInstruments, parseKlines, parsePremiumIndex, problemError, symbolOf,
} from './parse'
import type { RawBookTicker, RawDepth, RawExchangeInfo, RawPremiumIndex } from './parse'

/** 权重预算的最小接口：`take` 优先生效（工单口径），否则退回协议 `RateBudget.acquire`。 */
export interface BudgetLike {
  take?(weight: number): void | Promise<void>
  acquire?(weight: number, opts?: { priority?: 'high' | 'low'; signal?: AbortSignal }): Promise<void>
  charge?(weight: number): void
  penalize?(retryAfterMs?: number): void
  reportOk?(): void
  usage?(): BudgetUsage
}

/** 缺省预算：不限额度（只记录口径，不阻塞）。 */
export function unlimitedBudget(): RateBudget {
  return {
    acquire: async () => {},
    charge: () => {},
    penalize: () => {},
    reportOk: () => {},
    usage: () => ({
      used: 0, target: IP_WEIGHT_LIMIT, limit: IP_WEIGHT_LIMIT, ratio: 0, windowMs: IP_WEIGHT_WINDOW_MS, backoffUntil: 0,
    }),
  }
}

export interface BinanceHttpOptions {
  baseUrl: string
  fetchImpl: typeof fetch
  budget: RateBudget | BudgetLike
  timeoutMs: number
}

/** 公共 REST 客户端：只发 GET、不带任何密钥（本连接器不持有凭据）。 */
export class BinanceHttp {
  readonly baseUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly budget: RateBudget | BudgetLike
  private readonly timeoutMs: number

  constructor(o: BinanceHttpOptions) {
    this.baseUrl = o.baseUrl.replace(/\/+$/, '')
    this.fetchImpl = o.fetchImpl
    this.budget = o.budget
    this.timeoutMs = o.timeoutMs
  }

  async get<T>(path: string, params: Record<string, string | number | undefined>, weight: number): Promise<T> {
    await this.spend(weight)
    const url = this.urlOf(path, params)
    let res: Response
    try {
      res = await this.fetchImpl(url, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (e) {
      throw problemError('VENUE_UNAVAILABLE', `${VENUE} ${path} request failed`, {
        venue: { id: VENUE, message: truncate(e instanceof Error ? e.message : String(e)) },
      })
    }
    if (!res.ok) throw await this.failed(path, res)
    try {
      return (await res.json()) as T
    } catch {
      throw problemError('VENUE_UNAVAILABLE', `${VENUE} ${path} returned invalid JSON`, {
        venue: { id: VENUE, message: 'invalid json' },
      })
    }
  }

  private async spend(weight: number): Promise<void> {
    const b: BudgetLike = this.budget
    if (typeof b.take === 'function') {
      await b.take(weight)
      return
    }
    if (typeof b.acquire === 'function') await b.acquire(weight, { priority: 'high' })
  }

  private urlOf(path: string, params: Record<string, string | number | undefined>): string {
    const url = new URL(`${this.baseUrl}${path}`)
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) url.searchParams.set(key, String(value))
    }
    return url.toString()
  }

  /** 非 2xx → VENUE_UNAVAILABLE（retryable）；429 / 418 带 Retry-After 并让预算整体退避。 */
  private async failed(path: string, res: Response): Promise<ProblemError> {
    const body = truncate(await res.text().catch(() => ''))
    let retryAfterMs: number | undefined
    if (res.status === 429 || res.status === 418) {
      const header = res.headers.get('retry-after')
      const seconds = header === null ? NaN : Number(header)
      retryAfterMs = Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : 60_000
    }
    if (retryAfterMs !== undefined) {
      const b: BudgetLike = this.budget
      b.penalize?.(retryAfterMs)
    }
    return problemError('VENUE_UNAVAILABLE', `${VENUE} ${path} HTTP ${res.status}`, {
      retryable: true,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      venue: { id: VENUE, code: res.status, message: body === '' ? 'empty response' : body },
    })
  }
}

const truncate = (s: string): string => (s.length > 200 ? `${s.slice(0, 200)}…` : s)

export interface BinanceMarketOptions {
  /** 公共 REST 基址，缺省 https://fapi.binance.com。 */
  baseUrl?: string
  fetchImpl?: typeof fetch
  budget?: RateBudget | BudgetLike
  clock?: () => number
  /** 报价轮询间隔，缺省 5000 ms。 */
  pollMs?: number
  /** 行情陈旧阈值（quote 的 stale / status 的 stale），缺省 10 s。 */
  staleMs?: number
  httpTimeoutMs?: number
  /** 资金费历史翻页的页间间隔，缺省 500 ms（公开行情 <= 2 次/秒）；测试里可设 0。 */
  fundingPageGapMs?: number
}

interface PollSub {
  id: InstrumentId
  cb: (e: VenueEvent) => void
  active: boolean
  inFlight: boolean
  timer?: ReturnType<typeof setInterval>
}

export class BinanceMarket {
  private readonly http: BinanceHttp
  private readonly budget: RateBudget | BudgetLike
  private readonly clock: () => number
  private readonly pollMs: number
  private readonly staleMs: number
  private readonly fundingPageGapMs: number

  private records = new Map<InstrumentId, Instrument>()
  private quotes = new Map<InstrumentId, { ts: Ms; bid: number; ask: number }>()
  private subs = new Set<PollSub>()
  private lastMessageTs = 0
  private started = false
  private closed = false

  constructor(o: BinanceMarketOptions = {}) {
    this.clock = o.clock ?? (() => Date.now())
    this.budget = o.budget ?? unlimitedBudget()
    this.pollMs = Math.max(1, Math.floor(o.pollMs ?? 5000))
    this.staleMs = Math.max(1, Math.floor(o.staleMs ?? 10_000))
    this.fundingPageGapMs = Math.max(0, Math.floor(o.fundingPageGapMs ?? FUNDING_PAGE_GAP_MS))
    this.http = new BinanceHttp({
      baseUrl: o.baseUrl ?? DEFAULT_BASE_URL,
      fetchImpl: o.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args)),
      budget: this.budget,
      timeoutMs: o.httpTimeoutMs ?? 10_000,
    })
  }

  // ───────────── 生命周期 ─────────────

  /** 拉一次 exchangeInfo 并缓存（重复调用不会重复拉）。 */
  async start(): Promise<void> {
    if (this.closed) throw problemError('CAPABILITY_UNSUPPORTED', 'binance data connector is closed')
    if (this.started) return
    await this.refreshInstruments()
    this.started = true
  }

  /** 强制重新发现标的（start 只拉一次；这里是显式刷新入口）。 */
  async refreshInstruments(): Promise<void> {
    if (this.closed) throw problemError('CAPABILITY_UNSUPPORTED', 'binance data connector is closed')
    const raw = await this.http.get<RawExchangeInfo>('/fapi/v1/exchangeInfo', {}, EXCHANGE_INFO_WEIGHT)
    const now = this.clock()
    const next = new Map<InstrumentId, Instrument>()
    for (const instrument of parseInstruments(raw, now)) next.set(instrument.instrumentId, instrument)
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

  // ───────────── 行情读取 ─────────────

  /** 最近一次 refreshQuote 的结果（同步、不联网）；没拉过就 undefined。 */
  quote(id: InstrumentId): StampedQuote | undefined {
    const hit = this.quotes.get(id)
    if (!hit) return undefined
    const now = this.clock()
    const ageMs = Math.max(0, now - hit.ts)
    return { instrumentId: id, ts: hit.ts, bid: hit.bid, ask: hit.ask, stale: ageMs > this.staleMs, ageMs }
  }

  /** GET /fapi/v1/ticker/bookTicker 并写入缓存。 */
  async refreshQuote(id: InstrumentId): Promise<StampedQuote | undefined> {
    const symbol = symbolOf(id)
    const raw = await this.http.get<RawBookTicker>('/fapi/v1/ticker/bookTicker', { symbol }, BOOK_TICKER_WEIGHT)
    const now = this.clock()
    const parsed = parseBookTicker(raw, now)
    this.lastMessageTs = now
    if (!parsed) {
      this.quotes.delete(id)
      return undefined
    }
    this.quotes.set(id, parsed)
    return this.quote(id)
  }

  /** GET /fapi/v1/depth?limit=；深度向上取官方允许的档位。 */
  async book(id: InstrumentId, depth = 20): Promise<Book> {
    const symbol = symbolOf(id)
    const limit = depthLimitOf(depth)
    const raw = await this.http.get<RawDepth>('/fapi/v1/depth', { symbol, limit }, depthWeight(limit))
    const now = this.clock()
    this.lastMessageTs = now
    return parseDepth(raw, id, Math.max(1, Math.floor(depth)), now)
  }

  /**
   * K 线。无 from：取最近 n 根（n 钳到 1..1500，缺省 300）。
   * 有 from：从 from 起每页 1500 根推进，游标 = 末根开盘时间 + 周期，直到越过 to 或不满一页，最多 200 页。
   * 返回升序、按 t 去重。
   */
  async candles(id: InstrumentId, interval: CandleInterval, opts: { n?: number; from?: Ms; to?: Ms } = {}): Promise<Candle[]> {
    const step = INTERVAL_MS[interval]
    if (!step) throw problemError('INVALID_PARAMS', `unsupported candle interval: ${String(interval)}`)
    const symbol = symbolOf(id)

    if (opts.from === undefined) {
      const n = clampCount(opts.n)
      const raw = await this.http.get<unknown>('/fapi/v1/klines', { symbol, interval, limit: n }, klineWeight(n))
      this.lastMessageTs = this.clock()
      return dedupe(parseKlines(raw)).slice(-n)
    }

    const from = Math.floor(opts.from)
    const to = opts.to === undefined ? undefined : Math.floor(opts.to)
    if (to !== undefined && to < from) return []
    const seen = new Map<Ms, Candle>()
    let cursor = from
    for (let page = 0; page < MAX_PAGES; page++) {
      const raw = await this.http.get<unknown>(
        '/fapi/v1/klines',
        { symbol, interval, startTime: cursor, ...(to !== undefined ? { endTime: to } : {}), limit: CANDLE_PAGE },
        klineWeight(CANDLE_PAGE),
      )
      this.lastMessageTs = this.clock()
      const rows = parseKlines(raw).filter((c) => c.t >= from && (to === undefined || c.t <= to))
      for (const candle of rows) seen.set(candle.t, candle)
      const last = rows[rows.length - 1]
      if (!last) break
      const next = last.t + step
      if ((Array.isArray(raw) ? raw.length : 0) < CANDLE_PAGE) break
      if (next <= cursor) break
      if (to !== undefined && next > to) break
      cursor = next
    }
    return [...seen.values()].sort((a, b) => a.t - b.t)
  }

  /** GET /fapi/v1/premiumIndex：标记价、指数价、资金费率、资金间隔。 */
  async context(id: InstrumentId): Promise<MarketContext> {
    const symbol = symbolOf(id)
    const raw = await this.http.get<RawPremiumIndex>('/fapi/v1/premiumIndex', { symbol }, PREMIUM_INDEX_WEIGHT)
    const now = this.clock()
    this.lastMessageTs = now
    return parsePremiumIndex(raw, id, now)
  }

  /**
   * GET /fapi/v1/fundingRate（公开、不需要密钥）：从 from 到 to（缺省当前时间）的资金费结算历史，升序、按结算时间去重。
   * 每页 1000 条，游标 = 末条结算时间 + 1；页间隔至少 fundingPageGapMs（公开行情 <= 2 次/秒）；最多 MAX_PAGES 页。
   */
  async fundingHistory(id: InstrumentId, opts: { from: Ms; to?: Ms }): Promise<FundingRatePoint[]> {
    const symbol = symbolOf(id)
    const from = Math.floor(opts.from)
    const end = opts.to === undefined ? this.clock() : Math.floor(opts.to)
    const seen = new Map<Ms, FundingRatePoint>()
    let cursor = from
    for (let page = 0; page < MAX_PAGES && cursor <= end; page++) {
      if (page > 0 && this.fundingPageGapMs > 0) await new Promise((resolve) => setTimeout(resolve, this.fundingPageGapMs))
      const raw = await this.http.get<unknown>('/fapi/v1/fundingRate', { symbol, startTime: cursor, endTime: end, limit: FUNDING_PAGE }, FUNDING_RATE_WEIGHT)
      this.lastMessageTs = this.clock()
      const rows = parseFundingRates(raw, id).filter((p) => p.t >= from && p.t <= end)
      for (const p of rows) seen.set(p.t, p)
      const last = rows[rows.length - 1]
      if (!last || (Array.isArray(raw) ? raw.length : 0) < FUNDING_PAGE || last.t + 1 <= cursor) break
      cursor = last.t + 1
    }
    return [...seen.values()].sort((a, b) => a.t - b.t)
  }

  status(): MarketStatus {
    const now = this.clock()
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

  /** 只支持 quote 频道：按 pollMs 轮询 bookTicker，用 VenueEvent quote 回调。返回退订函数。 */
  subscribe(spec: SubscriptionSpec, cb: (e: VenueEvent) => void): Unsubscribe {
    if (this.closed) throw problemError('CAPABILITY_UNSUPPORTED', 'binance data connector is closed')
    if (spec.channel !== 'quote') {
      throw problemError('CAPABILITY_UNSUPPORTED', `binance data connector polls quote subscriptions only (got ${spec.channel})`)
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
      // 本轮失败：保持轮询，下一轮重试（lastMessageTs 不前进，status() 自然会显示陈旧）
    } finally {
      sub.inFlight = false
    }
  }
}

function clampCount(n: number | undefined): number {
  const raw = typeof n === 'number' && Number.isFinite(n) ? Math.floor(n) : DEFAULT_CANDLE_COUNT
  return Math.max(1, Math.min(MAX_CANDLES, raw))
}

function dedupe(candles: Candle[]): Candle[] {
  const seen = new Map<Ms, Candle>()
  for (const candle of candles) seen.set(candle.t, candle)
  return [...seen.values()].sort((a, b) => a.t - b.t)
}
