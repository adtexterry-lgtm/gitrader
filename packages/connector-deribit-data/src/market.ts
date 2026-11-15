// SPDX-License-Identifier: CPAL-1.0
// Deribit v2 公共行情（只读、纯 REST）：合约目录、K 线翻页、盘口、报价轮询、标记价与资金费率。
// 没有 WebSocket：subscribe 按 pollMs 轮询 /api/v2/public/ticker，status().source 恒为 'rest'。
// 每个请求前先向注入的预算要额度（计数模型，一请求一次）；响应信封里的 error 一律当场所不可用。
import type { Book, Candle, CandleInterval, Instrument, InstrumentId, MarketContext, Ms } from '@gitrader/protocol'
import type {
  BudgetUsage, MarketStatus, RateBudget, StampedQuote, SubscriptionSpec, Unsubscribe, VenueEvent,
} from '@gitrader/protocol/connector'
import {
  CANDLE_PAGE, DEFAULT_BASE_URL, DEFAULT_CANDLE_COUNT, INTERVAL_MS, IP_RATE_LIMIT, IP_RATE_WINDOW_MS,
  MAX_CANDLES, MAX_PAGES, REQUEST_COST, VENUE, depthLimitOf, parseChart, parseContext, parseInstruments,
  parseOrderBook, parseTicker, problemError, resolutionOf, symbolOf,
} from './parse'
import type { DeribitEnvelope, RawChart, RawInstrument, RawOrderBook, RawTicker } from './parse'

/** 预算接口的最小形状：优先 `acquire`（协议 RateBudget），其次 `take`；成功后 `reportOk`。 */
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

export interface DeribitHttpOptions {
  baseUrl: string
  fetchImpl: typeof fetch
  budget: RateBudget | BudgetLike
  timeoutMs: number
}

/** 公共 REST 客户端：只发 GET、不带任何密钥（本连接器不持有凭据）。 */
export class DeribitHttp {
  readonly baseUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly budget: RateBudget | BudgetLike
  private readonly timeoutMs: number

  constructor(o: DeribitHttpOptions) {
    this.baseUrl = o.baseUrl.replace(/\/+$/, '')
    this.fetchImpl = o.fetchImpl
    this.budget = o.budget
    this.timeoutMs = o.timeoutMs
  }

  /** GET 一次并拆信封：`error` 存在即 VENUE_UNAVAILABLE（消息带 error.code / error.message），成功时回 reportOk。 */
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

    const text = await res.text().catch(() => '')
    let body: unknown
    try {
      body = text === '' ? undefined : (JSON.parse(text) as unknown)
    } catch {
      body = undefined
    }
    const envelope = (body ?? {}) as DeribitEnvelope<unknown>
    const retryAfterMs = retryAfterOf(res)
    if (retryAfterMs !== undefined) this.budget.penalize?.(retryAfterMs)

    const error = envelope.error
    if (error !== undefined && error !== null && typeof error === 'object') {
      // Deribit 的业务错误码（如 -32602）也走这里：HTTP 可能是 400 / 500，也可能是 200
      throw problemError('VENUE_UNAVAILABLE', `${VENUE} ${path} error ${String(error.code)}`, {
        retryable: true,
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
        venue: {
          id: VENUE,
          code: typeof error.code === 'number' || typeof error.code === 'string' ? error.code : res.status,
          message: typeof error.message === 'string' && error.message !== '' ? error.message : 'no message',
        },
      })
    }
    if (!res.ok) {
      throw problemError('VENUE_UNAVAILABLE', `${VENUE} ${path} HTTP ${res.status}`, {
        retryable: true,
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
        venue: { id: VENUE, code: res.status, message: text === '' ? 'empty response' : truncate(text) },
      })
    }
    if (body === undefined) {
      throw problemError('VENUE_UNAVAILABLE', `${VENUE} ${path} returned invalid JSON`, {
        venue: { id: VENUE, message: 'invalid json' },
      })
    }
    this.budget.reportOk?.()
    return envelope.result as T
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
}

/** 429 / 418 的 Retry-After（秒）→ 毫秒；没有就 undefined。 */
function retryAfterOf(res: Response): number | undefined {
  if (res.status !== 429 && res.status !== 418) return undefined
  const header = res.headers.get('retry-after')
  const seconds = header === null ? NaN : Number(header)
  return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : 60_000
}

const truncate = (s: string): string => (s.length > 200 ? `${s.slice(0, 200)}…` : s)

const INSTRUMENTS_PATH = '/api/v2/public/get_instruments'
const TICKER_PATH = '/api/v2/public/ticker'
const ORDER_BOOK_PATH = '/api/v2/public/get_order_book'
const CHART_PATH = '/api/v2/public/get_tradingview_chart_data'
/** 工单口径：合约清单按币种逐次拉取；USDC 用于取线性（USDC 结算）合约，BTC / ETH 只用于兼容同名清单。 */
const INSTRUMENT_CURRENCIES = ['BTC', 'ETH', 'USDC'] as const

export interface DeribitMarketOptions {
  /** 公共 REST 基址，缺省 https://www.deribit.com。 */
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

export class DeribitMarket {
  private readonly http: DeribitHttp
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

  constructor(o: DeribitMarketOptions = {}) {
    this.clock = o.clock ?? (() => Date.now())
    this.budget = o.budget ?? unlimitedBudget()
    this.pollMs = Math.max(1, Math.floor(o.pollMs ?? 5000))
    this.staleMs = Math.max(1, Math.floor(o.staleMs ?? 10_000))
    this.http = new DeribitHttp({
      baseUrl: o.baseUrl ?? DEFAULT_BASE_URL,
      fetchImpl: o.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args)),
      budget: this.budget,
      timeoutMs: o.httpTimeoutMs ?? 10_000,
    })
  }

  // ───────────── 生命周期 ─────────────

  /** 拉一次合约清单并缓存（BTC + ETH + USDC 三次请求合并，只留 USDC 结算的线性合约；重复调用不会重复拉）。 */
  async start(): Promise<void> {
    if (this.closed) throw problemError('CAPABILITY_UNSUPPORTED', 'deribit data connector is closed')
    if (this.started) return
    await this.refreshInstruments()
    this.started = true
  }

  /** 强制重新发现标的（start 只拉一次；这里是显式刷新入口）。 */
  async refreshInstruments(): Promise<void> {
    if (this.closed) throw problemError('CAPABILITY_UNSUPPORTED', 'deribit data connector is closed')
    const rows: RawInstrument[] = []
    for (const currency of INSTRUMENT_CURRENCIES) {
      const got = await this.http.get<RawInstrument[]>(INSTRUMENTS_PATH, { currency, kind: 'future' }, REQUEST_COST)
      if (Array.isArray(got)) rows.push(...got)
    }
    const now = this.clock()
    const next = new Map<InstrumentId, Instrument>()
    for (const instrument of parseInstruments(rows, now)) {
      if (!next.has(instrument.instrumentId)) next.set(instrument.instrumentId, instrument)
    }
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

  /** GET /api/v2/public/ticker?instrument_name= 并写入缓存。 */
  async refreshQuote(id: InstrumentId): Promise<StampedQuote | undefined> {
    const name = symbolOf(id)
    const raw = await this.http.get<RawTicker>(TICKER_PATH, { instrument_name: name }, REQUEST_COST)
    const now = this.clock()
    const parsed = parseTicker(raw, now)
    this.lastMessageTs = now
    if (!parsed) {
      this.quotes.delete(id)
      return undefined
    }
    this.quotes.set(id, parsed)
    return this.quote(id)
  }

  /** GET /api/v2/public/get_order_book?instrument_name=&depth=（depth 钳到 1..10000；size 折成币）。 */
  async book(id: InstrumentId, depth = 20): Promise<Book> {
    const name = symbolOf(id)
    const levels = depthLimitOf(depth)
    const raw = await this.http.get<RawOrderBook>(ORDER_BOOK_PATH, { instrument_name: name, depth: levels }, REQUEST_COST)
    const now = this.clock()
    this.lastMessageTs = now
    // 盘口 size 是张数：清单已缓存时按该标的的 contractSize 折成币；未 start() 时拿不到面值，按原值透传。
    return parseOrderBook(raw, id, Math.max(1, Math.floor(depth)), now, this.records.get(id)?.contractSize)
  }

  /**
   * K 线。Deribit 是列式 + 显式毫秒时间窗：单次最多 1000 根。
   * 无 from：取最近 n 根（n 钳到 1..1000，缺省 300），窗口 = 现在往前 n × 周期，只发一次请求。
   * 有 from：按 1000 根 × 周期的窗口从 from 推进到 to（缺省现在），最多 200 页；
   * 一页不满 1000 根就提前停（后面没有更多数据，避免固定 200 次请求）。
   * 返回升序、按 t 去重。`v` 是基础币数量（见 parseChart）。
   */
  async candles(id: InstrumentId, interval: CandleInterval, opts: { n?: number; from?: Ms; to?: Ms } = {}): Promise<Candle[]> {
    const resolution = resolutionOf(interval)
    const step = INTERVAL_MS[interval]
    const name = symbolOf(id)
    const to = opts.to === undefined ? undefined : Math.floor(opts.to)

    if (opts.from === undefined) {
      const n = clampCount(opts.n)
      const end = to ?? this.clock()
      const start = end - n * step
      const raw = await this.http.get<RawChart>(
        CHART_PATH,
        { instrument_name: name, resolution, start_timestamp: start, end_timestamp: end },
        REQUEST_COST,
      )
      this.lastMessageTs = this.clock()
      return dedupe(parseChart(raw)).slice(-n)
    }

    const from = Math.floor(opts.from)
    if (to !== undefined && to < from) return []
    const hardEnd = to ?? this.clock()
    const span = CANDLE_PAGE * step
    const seen = new Map<Ms, Candle>()
    let cursor = from
    for (let page = 0; page < MAX_PAGES; page++) {
      if (cursor > hardEnd) break
      const windowEnd = Math.min(cursor + span - step, hardEnd)
      const raw = await this.http.get<RawChart>(
        CHART_PATH,
        { instrument_name: name, resolution, start_timestamp: cursor, end_timestamp: windowEnd },
        REQUEST_COST,
      )
      this.lastMessageTs = this.clock()
      const rows = parseChart(raw)
      for (const candle of rows) {
        if (candle.t >= from && candle.t <= hardEnd) seen.set(candle.t, candle)
      }
      // 不满一页 = 上游已无更多数据：提前停，不把 MAX_PAGES 跑满
      if (rows.length < CANDLE_PAGE) break
      if (windowEnd >= hardEnd) break
      cursor = windowEnd + step
    }
    return [...seen.values()].sort((a, b) => a.t - b.t)
  }

  /** GET /api/v2/public/ticker：标记价、指数价、资金费率、未平仓数量（张数折成币）。 */
  async context(id: InstrumentId): Promise<MarketContext> {
    const name = symbolOf(id)
    const raw = await this.http.get<RawTicker>(TICKER_PATH, { instrument_name: name }, REQUEST_COST)
    const now = this.clock()
    this.lastMessageTs = now
    return parseContext(raw, id, now, this.records.get(id)?.contractSize)
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
    if (this.closed) throw problemError('CAPABILITY_UNSUPPORTED', 'deribit data connector is closed')
    if (spec.channel !== 'quote') {
      throw problemError('CAPABILITY_UNSUPPORTED', `deribit data connector polls quote subscriptions only (got ${spec.channel})`)
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
