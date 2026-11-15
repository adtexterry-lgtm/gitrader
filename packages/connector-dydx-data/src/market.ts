// SPDX-License-Identifier: CPAL-1.0
// dYdX v4 Indexer 公共行情（只读、纯 REST）：永续目录、K 线倒序翻页、盘口、报价轮询、标记价与资金费率。
// 没有 WebSocket：subscribe 按 pollMs 轮询盘口 + 最近成交，status().source 恒为 'rest'。
// 每个请求前先向注入的预算要额度（acquire 为主），成功后 reportOk；预算对象缺省不限。
import type { Book, Candle, CandleInterval, Instrument, InstrumentId, MarketContext, Ms } from '@gitrader/protocol'
import type {
  BudgetUsage, MarketStatus, RateBudget, StampedQuote, SubscriptionSpec, Unsubscribe, VenueEvent,
} from '@gitrader/protocol/connector'
import {
  CANDLES_WEIGHT, CANDLE_PAGE, DEFAULT_BASE_URL, DEFAULT_CANDLE_COUNT, IP_RATE_LIMIT, IP_RATE_WINDOW_MS, INTERVAL_MS, MARKETS_WEIGHT,
  MAX_CANDLES, MAX_PAGES, ORDERBOOK_WEIGHT, ProblemError, TRADES_WEIGHT, VENUE, depthLimitOf, isoOf, parseCandles,
  parseContext, parseMarkets, parseLastTradePrice, parseOrderbook, parseTopOfBook, problemError, resolutionOf, symbolOf,
} from './parse'
import type { RawMarketsResponse, RawOrderbook, RawPerpetualMarket, RawTradesResponse } from './parse'

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

export interface DydxHttpOptions {
  baseUrl: string
  fetchImpl: typeof fetch
  budget: RateBudget | BudgetLike
  timeoutMs: number
}

/** 公共 REST 客户端：只发 GET、不带任何密钥（本连接器不持有凭据）。 */
export class DydxHttp {
  readonly baseUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly budget: RateBudget | BudgetLike
  private readonly timeoutMs: number

  constructor(o: DydxHttpOptions) {
    this.baseUrl = o.baseUrl.replace(/\/+$/, '')
    this.fetchImpl = o.fetchImpl
    this.budget = o.budget
    this.timeoutMs = o.timeoutMs
  }

  /** GET 一次：非 2xx 或响应里带 `errors` 都算场所不可用；成功时 reportOk。 */
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
        venue: { id: VENUE, code: 'errors', message },
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

  /** 非 2xx → VENUE_UNAVAILABLE（retryable，带上 `errors[0].msg`）；429 带 Retry-After 并让预算整体退避。 */
  private async failed(path: string, res: Response): Promise<ProblemError> {
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
      venue: { id: VENUE, code: res.status, message: messageOf(body) },
    })
  }
}

const truncate = (s: string): string => (s.length > 200 ? `${s.slice(0, 200)}…` : s)

/** Indexer 的错误体是 `{ errors: [{ msg }] }`；取第一条 msg，解析不了就回落到原文。 */
function messageOf(body: string): string {
  if (body === '') return 'empty response'
  try {
    const parsed = JSON.parse(body) as { errors?: { msg?: unknown }[] }
    const first = Array.isArray(parsed.errors) ? parsed.errors[0]?.msg : undefined
    if (typeof first === 'string' && first !== '') return first
  } catch {
    // 不是 JSON：按原文返回
  }
  return body
}

/** 2xx 里也可能带 `errors`（Indexer 偶发）：有非空 msg 就算场所错误。 */
function errorMessageOf(body: unknown): string | undefined {
  const errors = (body as { errors?: unknown } | null | undefined)?.errors
  if (!Array.isArray(errors) || errors.length === 0) return undefined
  const msg = (errors[0] as { msg?: unknown } | undefined)?.msg
  return typeof msg === 'string' && msg !== '' ? msg : 'venue error'
}

const MARKETS_PATH = '/v4/perpetualMarkets'
const ORDERBOOK_PATH = '/v4/orderbooks/perpetualMarket'
const TRADES_PATH = '/v4/trades/perpetualMarket'
const CANDLES_PATH = '/v4/candles/perpetualMarkets'

export interface DydxMarketOptions {
  /** Indexer 公共基址，缺省 https://indexer.dydx.trade（路径前缀 /v4 在客户端拼接）。 */
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

export class DydxMarket {
  private readonly http: DydxHttp
  private readonly budget: RateBudget | BudgetLike
  private readonly clock: () => number
  private readonly pollMs: number
  private readonly staleMs: number

  private records = new Map<InstrumentId, Instrument>()
  private markets = new Map<string, RawPerpetualMarket>()
  private quotes = new Map<InstrumentId, { ts: Ms; bid: number; ask: number; last?: number }>()
  private subs = new Set<PollSub>()
  private lastMessageTs = 0
  private marketsTs = 0
  private started = false
  private closed = false

  constructor(o: DydxMarketOptions = {}) {
    this.clock = o.clock ?? (() => Date.now())
    this.budget = o.budget ?? unlimitedBudget()
    this.pollMs = Math.max(1, Math.floor(o.pollMs ?? 5000))
    this.staleMs = Math.max(1, Math.floor(o.staleMs ?? 10_000))
    this.http = new DydxHttp({
      baseUrl: o.baseUrl ?? DEFAULT_BASE_URL,
      fetchImpl: o.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args)),
      budget: this.budget,
      timeoutMs: o.httpTimeoutMs ?? 10_000,
    })
  }

  // ───────────── 生命周期 ─────────────

  /** 拉一次永续合约清单并缓存（重复调用不会重复拉）。 */
  async start(): Promise<void> {
    if (this.closed) throw problemError('CAPABILITY_UNSUPPORTED', 'dydx data connector is closed')
    if (this.started) return
    await this.refreshMarkets()
    this.started = true
  }

  /** 强制重新发现标的（start 只拉一次；这里是显式刷新入口）。 */
  async refreshMarkets(): Promise<void> {
    if (this.closed) throw problemError('CAPABILITY_UNSUPPORTED', 'dydx data connector is closed')
    const raw = await this.http.get<RawMarketsResponse>(MARKETS_PATH, {}, MARKETS_WEIGHT)
    const now = this.clock()
    const parsed = parseMarkets(raw, now)
    const next = new Map<InstrumentId, Instrument>()
    for (const instrument of parsed.instruments) next.set(instrument.instrumentId, instrument)
    this.records = next
    this.markets = parsed.markets
    this.lastMessageTs = now
    this.marketsTs = now
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

  /**
   * Indexer 不给 ticker 快照：盘口最优档作 bid/ask，最近一笔成交价作 last（两次请求）。
   * 成交这一次失败不当成整体失败 —— last 是可选字段，盘口到手就先回。
   */
  async refreshQuote(id: InstrumentId): Promise<StampedQuote | undefined> {
    const ticker = symbolOf(id)
    const book = await this.http.get<RawOrderbook>(`${ORDERBOOK_PATH}/${encodeURIComponent(ticker)}`, {}, ORDERBOOK_WEIGHT)
    const now = this.clock()
    this.lastMessageTs = now
    const top = parseTopOfBook(book)
    if (!top) {
      this.quotes.delete(id)
      return undefined
    }
    let last: number | undefined
    try {
      const trades = await this.http.get<RawTradesResponse>(
        `${TRADES_PATH}/${encodeURIComponent(ticker)}`, { limit: 1 }, TRADES_WEIGHT,
      )
      last = parseLastTradePrice(trades)
    } catch {
      // 最近成交取不到就不给 last，盘口照常返回
    }
    this.quotes.set(id, { ts: now, bid: top.bid, ask: top.ask, ...(last !== undefined ? { last } : {}) })
    return this.quote(id)
  }

  /** 盘口：Indexer 一次给整本，本地截断到 depth（钳到 1..500）。 */
  async book(id: InstrumentId, depth = 20): Promise<Book> {
    const ticker = symbolOf(id)
    const raw = await this.http.get<RawOrderbook>(`${ORDERBOOK_PATH}/${encodeURIComponent(ticker)}`, {}, ORDERBOOK_WEIGHT)
    const now = this.clock()
    this.lastMessageTs = now
    return parseOrderbook(raw, id, depthLimitOf(depth), now)
  }

  /**
   * K 线。Indexer 整页**倒序**（最新在前）、时间是 ISO 字符串。
   * 无 from：取最近 n 根（n 钳到 1..1000，缺省 300）。
   * 有 from：从 to（缺省最新）按 `toISO` 游标向更早翻页，每页 1000 根，直到越过 from 或不满一页，最多 200 页；
   * `toISO` 是开区间（不含该时刻那根），所以带 to 时首游标 = to + 1 ms。
   * 返回升序、按 t 去重。
   */
  async candles(id: InstrumentId, interval: CandleInterval, opts: { n?: number; from?: Ms; to?: Ms } = {}): Promise<Candle[]> {
    const resolution = resolutionOf(interval)
    const step = INTERVAL_MS[interval]
    if (!step) throw problemError('INVALID_PARAMS', `unsupported candle interval: ${String(interval)}`)
    const ticker = encodeURIComponent(symbolOf(id))
    const path = `${CANDLES_PATH}/${ticker}`

    if (opts.from === undefined) {
      const n = clampCount(opts.n)
      const raw = await this.http.get<unknown>(path, { resolution, limit: n }, CANDLES_WEIGHT)
      this.lastMessageTs = this.clock()
      return dedupe(parseCandles(raw)).slice(-n)
    }

    const from = Math.floor(opts.from)
    const to = opts.to === undefined ? undefined : Math.floor(opts.to)
    if (to !== undefined && to < from) return []
    const seen = new Map<Ms, Candle>()
    let cursor: Ms | undefined = to === undefined ? undefined : to + 1
    for (let page = 0; page < MAX_PAGES; page++) {
      const raw = await this.http.get<unknown>(
        path,
        { resolution, limit: CANDLE_PAGE, fromISO: isoOf(from), ...(cursor !== undefined ? { toISO: isoOf(cursor) } : {}) },
        CANDLES_WEIGHT,
      )
      this.lastMessageTs = this.clock()
      const rows = parseCandles(raw)
      if (rows.length === 0) break
      let oldest = rows[0]!.t
      for (const candle of rows) {
        if (candle.t < oldest) oldest = candle.t
        if (candle.t >= from && (to === undefined || candle.t <= to)) seen.set(candle.t, candle)
      }
      if (rows.length < CANDLE_PAGE) break
      if (oldest <= from) break
      if (cursor !== undefined && oldest >= cursor) break
      cursor = oldest
    }
    return [...seen.values()].sort((a, b) => a.t - b.t)
  }

  /** 标记价 / 资金费率 / 持仓来自 /v4/perpetualMarkets 的缓存（未 start 时先拉一次）。 */
  async context(id: InstrumentId): Promise<MarketContext> {
    const ticker = symbolOf(id)
    if (this.markets.size === 0) await this.refreshMarkets()
    const now = this.clock()
    const ts = this.marketsTs > 0 ? this.marketsTs : now
    return parseContext(this.markets.get(ticker), id, ts)
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

  /** 只支持 quote 频道：按 pollMs 轮询盘口 + 最近成交，用 VenueEvent quote 回调。返回退订函数。 */
  subscribe(spec: SubscriptionSpec, cb: (e: VenueEvent) => void): Unsubscribe {
    if (this.closed) throw problemError('CAPABILITY_UNSUPPORTED', 'dydx data connector is closed')
    if (spec.channel !== 'quote') {
      throw problemError('CAPABILITY_UNSUPPORTED', `dydx data connector polls quote subscriptions only (got ${spec.channel})`)
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
