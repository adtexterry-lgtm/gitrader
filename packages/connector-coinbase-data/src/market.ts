// SPDX-License-Identifier: CPAL-1.0
// Coinbase Advanced Trade 公共行情（只读、纯 REST）：现货目录、K 线翻页、盘口、报价轮询。
// 没有 WebSocket：subscribe 按 pollMs 轮询 ticker，status().source 恒为 'rest'。
// 每个请求前先向注入的预算要额度（acquire 为主），成功后 reportOk；预算对象缺省不限。
import type { Book, Candle, CandleInterval, Instrument, InstrumentId, MarketContext, Ms } from '@gitrader/protocol'
import type {
  BudgetUsage, MarketStatus, RateBudget, StampedQuote, SubscriptionSpec, Unsubscribe, VenueEvent,
} from '@gitrader/protocol/connector'
import {
  CANDLE_PAGE, DEFAULT_BASE_URL, INTERVAL_MS, IP_RATE_LIMIT, IP_RATE_WINDOW_MS, MAX_PAGES,
  REQUEST_WEIGHT, VENUE, clampCount, depthLimitOf, granularityOf, parseBook, parseCandles, parseContext, parseProducts,
  parseTicker, problemError, symbolOf,
} from './parse'
import type { RawCandles, RawPricebook, RawProducts, RawTicker } from './parse'

/** 预算接口的最小形状：优先 `acquire`（协议 RateBudget），其次 `take`；成功回调 `reportOk`。 */
export interface BudgetLike {
  acquire?(weight: number, opts?: { priority?: 'high' | 'low'; signal?: AbortSignal }): Promise<void>
  take?(weight: number): void | Promise<void>
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
      used: 0, target: IP_RATE_LIMIT, limit: IP_RATE_LIMIT, ratio: 0, windowMs: IP_RATE_WINDOW_MS, backoffUntil: 0,
    }),
  }
}

export interface CoinbaseHttpOptions {
  baseUrl: string
  fetchImpl: typeof fetch
  budget: RateBudget | BudgetLike
  timeoutMs: number
}

/** 公共 REST 客户端：只发 GET、不带任何密钥（本连接器不持有凭据）。 */
export class CoinbaseHttp {
  readonly baseUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly budget: RateBudget | BudgetLike
  private readonly timeoutMs: number

  constructor(o: CoinbaseHttpOptions) {
    this.baseUrl = o.baseUrl.replace(/\/+$/, '')
    this.fetchImpl = o.fetchImpl
    this.budget = o.budget
    this.timeoutMs = o.timeoutMs
  }

  /** GET 一次并解析 JSON；非 2xx / 业务错误 / 坏 JSON 一律 VENUE_UNAVAILABLE；成功时回 reportOk。 */
  async getJson<T>(path: string, params: Record<string, string | number | undefined>, weight: number): Promise<T> {
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
    let body: unknown
    try {
      body = await res.json()
    } catch {
      throw problemError('VENUE_UNAVAILABLE', `${VENUE} ${path} returned invalid JSON`, {
        venue: { id: VENUE, message: 'invalid json' },
      })
    }
    const message = errorMessageOf(body)
    if (message !== undefined) {
      throw problemError('VENUE_UNAVAILABLE', `${VENUE} ${path} error`, {
        retryable: true,
        venue: { id: VENUE, message },
      })
    }
    this.budget.reportOk?.()
    return body as T
  }

  private async spend(weight: number): Promise<void> {
    const b: BudgetLike = this.budget
    if (typeof b.acquire === 'function') {
      await b.acquire(weight, { priority: 'high' })
      return
    }
    if (typeof b.take === 'function') await b.take(weight)
  }

  private urlOf(path: string, params: Record<string, string | number | undefined>): string {
    const url = new URL(`${this.baseUrl}${path}`)
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) url.searchParams.set(key, String(value))
    }
    return url.toString()
  }

  /** 非 2xx → VENUE_UNAVAILABLE（retryable）；429 带 Retry-After 并让预算整体退避。 */
  private async failed(path: string, res: Response): Promise<ReturnType<typeof problemError>> {
    const body = truncate(await res.text().catch(() => ''))
    let retryAfterMs: number | undefined
    if (res.status === 429) {
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

/** 公共端点偶发 200 带 `{ error, message }`；有它就算业务错误，交给 VENUE_UNAVAILABLE。 */
function errorMessageOf(body: unknown): string | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined
  const e = (body as { error?: unknown }).error
  if (typeof e !== 'string' || e.trim() === '') return undefined
  const m = (body as { message?: unknown }).message
  return typeof m === 'string' && m.trim() !== '' ? `${e.trim()}: ${truncate(m.trim())}` : truncate(e.trim())
}

const truncate = (s: string): string => (s.length > 200 ? `${s.slice(0, 200)}…` : s)

const PRODUCTS_PATH = '/api/v3/brokerage/market/products'
const BOOK_PATH = '/api/v3/brokerage/market/product_book'
const tickerPath = (productId: string): string => `/api/v3/brokerage/market/products/${encodeURIComponent(productId)}/ticker`
const candlesPath = (productId: string): string => `/api/v3/brokerage/market/products/${encodeURIComponent(productId)}/candles`

export interface CoinbaseMarketOptions {
  /** 公共 REST 基址，缺省 https://api.coinbase.com。 */
  baseUrl?: string
  fetchImpl?: typeof fetch
  budget?: RateBudget | BudgetLike
  clock?: () => number
  /** 报价轮询间隔，缺省 5000 ms。 */
  pollMs?: number
  /** 行情陈旧阈值（quote 的 stale / status 的 stale），缺省 10 s。 */
  staleMs?: number
  httpTimeoutMs?: number
}

interface PollSub {
  id: InstrumentId
  cb: (e: VenueEvent) => void
  active: boolean
  inFlight: boolean
  timer?: ReturnType<typeof setInterval>
}

export class CoinbaseMarket {
  private readonly http: CoinbaseHttp
  private readonly budget: RateBudget | BudgetLike
  private readonly clock: () => number
  private readonly pollMs: number
  private readonly staleMs: number

  private records = new Map<InstrumentId, Instrument>()
  private quotes = new Map<InstrumentId, { ts: Ms; bid: number; ask: number; last?: number }>()
  private subs = new Set<PollSub>()
  private lastMessageTs = 0
  private started = false
  private closed = false

  constructor(o: CoinbaseMarketOptions = {}) {
    this.clock = o.clock ?? (() => Date.now())
    this.budget = o.budget ?? unlimitedBudget()
    this.pollMs = Math.max(1, Math.floor(o.pollMs ?? 5000))
    this.staleMs = Math.max(1, Math.floor(o.staleMs ?? 10_000))
    this.http = new CoinbaseHttp({
      baseUrl: o.baseUrl ?? DEFAULT_BASE_URL,
      fetchImpl: o.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args)),
      budget: this.budget,
      timeoutMs: o.httpTimeoutMs ?? 10_000,
    })
  }

  // ───────────── 生命周期 ─────────────

  /** 拉一次现货清单并缓存（重复调用不会重复拉）。 */
  async start(): Promise<void> {
    if (this.closed) throw problemError('CAPABILITY_UNSUPPORTED', 'coinbase data connector is closed')
    if (this.started) return
    await this.refreshInstruments()
    this.started = true
  }

  /** 强制重新发现标的（start 只拉一次；这里是显式刷新入口）。 */
  async refreshInstruments(): Promise<void> {
    if (this.closed) throw problemError('CAPABILITY_UNSUPPORTED', 'coinbase data connector is closed')
    const body = await this.http.getJson<RawProducts>(PRODUCTS_PATH, { product_type: 'SPOT' }, REQUEST_WEIGHT)
    const now = this.clock()
    const next = new Map<InstrumentId, Instrument>()
    for (const instrument of parseProducts(body, now)) next.set(instrument.instrumentId, instrument)
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
    return {
      instrumentId: id, ts: hit.ts, bid: hit.bid, ask: hit.ask,
      ...(hit.last !== undefined ? { last: hit.last } : {}),
      stale: ageMs > this.staleMs, ageMs,
    }
  }

  /** GET /market/products/{id}/ticker?limit=1 并写入缓存。 */
  async refreshQuote(id: InstrumentId): Promise<StampedQuote | undefined> {
    const productId = symbolOf(id)
    const body = await this.http.getJson<RawTicker>(tickerPath(productId), { limit: 1 }, REQUEST_WEIGHT)
    const now = this.clock()
    const parsed = parseTicker(body, now)
    this.lastMessageTs = now
    if (!parsed) {
      this.quotes.delete(id)
      return undefined
    }
    this.quotes.set(id, parsed)
    return this.quote(id)
  }

  /** GET /market/product_book?product_id=&limit=（limit 钳到 1..250）。 */
  async book(id: InstrumentId, depth = 20): Promise<Book> {
    const productId = symbolOf(id)
    const limit = depthLimitOf(depth)
    const body = await this.http.getJson<RawPricebook>(BOOK_PATH, { product_id: productId, limit }, REQUEST_WEIGHT)
    const now = this.clock()
    this.lastMessageTs = now
    return parseBook(body, id, Math.max(1, Math.floor(depth)), now)
  }

  /**
   * K 线。无 from：取最近 n 根（n 钳到 1..350，缺省 300），上游倒序 → 翻成升序。
   * 有 from：以 start 秒游标按 350 根一窗向前推进（end = start + 349 步，或 to），直到越过 to、
   * 空页、不满一页或到 200 页上限；返回升序、按开盘毫秒去重。
   */
  async candles(id: InstrumentId, interval: CandleInterval, opts: { n?: number; from?: Ms; to?: Ms } = {}): Promise<Candle[]> {
    const step = INTERVAL_MS[interval]
    if (!step) throw problemError('INVALID_PARAMS', `unsupported candle interval: ${String(interval)}`)
    const granularity = granularityOf(interval)
    const productId = symbolOf(id)
    const stepSec = Math.round(step / 1000)

    if (opts.from === undefined) {
      const n = clampCount(opts.n)
      const body = await this.http.getJson<RawCandles>(candlesPath(productId), { granularity, limit: n }, REQUEST_WEIGHT)
      this.lastMessageTs = this.clock()
      return dedupe(parseCandles(body)).slice(-n)
    }

    const from = Math.floor(opts.from)
    const to = opts.to === undefined ? undefined : Math.floor(opts.to)
    if (to !== undefined && to < from) return []
    const toSec = to === undefined ? undefined : Math.floor(to / 1000)

    const seen = new Map<Ms, Candle>()
    let cursor = Math.floor(from / 1000)
    for (let page = 0; page < MAX_PAGES; page++) {
      if (toSec !== undefined && cursor > toSec) break
      const windowEnd = cursor + (CANDLE_PAGE - 1) * stepSec
      const end = toSec === undefined ? windowEnd : Math.min(toSec, windowEnd)
      if (end < cursor) break
      const body = await this.http.getJson<RawCandles>(
        candlesPath(productId),
        { granularity, start: cursor, end },
        REQUEST_WEIGHT,
      )
      this.lastMessageTs = this.clock()
      const rows = parseCandles(body)
      for (const candle of rows) {
        if (candle.t >= from && (to === undefined || candle.t <= to)) seen.set(candle.t, candle)
      }
      if (rows.length === 0) break
      // 本窗已覆盖到 to：不再往后翻
      if (toSec !== undefined && end >= toSec) break
      // 不满一页 = 已到最新（现货上市时间前的窗口会怎样？空页已在上面挡住）
      if (rows.length < CANDLE_PAGE) break
      let newest = rows[0]!.t
      for (const candle of rows) if (candle.t > newest) newest = candle.t
      const next = Math.floor(newest / 1000) + stepSec
      if (next <= cursor) break
      cursor = next
    }
    return [...seen.values()].sort((a, b) => a.t - b.t)
  }

  /**
   * 现货上下文：Coinbase 公共现货没有标记价 / 资金费 / 下次资金时间。
   * 现货无标记价，以最新成交价代：markPrice 取缓存报价的 last（没有则 bid/ask 中价）；
   * 没有缓存先 refreshQuote 一次，仍拿不到 → VENUE_UNAVAILABLE（retryable）。
   * 资金费相关键不写；有报价时顺带补 midPrice。
   */
  async context(id: InstrumentId): Promise<MarketContext> {
    symbolOf(id)
    let quote = this.quotes.get(id)
    if (!quote) {
      await this.refreshQuote(id)
      quote = this.quotes.get(id)
    }
    if (!quote) {
      throw problemError('VENUE_UNAVAILABLE', `${VENUE} ${id} has no quote for context`, {
        retryable: true,
        venue: { id: VENUE, message: 'no usable quote' },
      })
    }
    return parseContext(quote, id, this.clock())
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

  /** 只支持 quote 频道：按 pollMs 轮询 ticker，用 VenueEvent quote 回调。返回退订函数。 */
  subscribe(spec: SubscriptionSpec, cb: (e: VenueEvent) => void): Unsubscribe {
    if (this.closed) throw problemError('CAPABILITY_UNSUPPORTED', 'coinbase data connector is closed')
    if (spec.channel !== 'quote') {
      throw problemError('CAPABILITY_UNSUPPORTED', `coinbase data connector polls quote subscriptions only (got ${spec.channel})`)
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

function dedupe(candles: Candle[]): Candle[] {
  const seen = new Map<Ms, Candle>()
  for (const candle of candles) seen.set(candle.t, candle)
  return [...seen.values()].sort((a, b) => a.t - b.t)
}
