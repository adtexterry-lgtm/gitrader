// SPDX-License-Identifier: CPAL-1.0
// KuCoin Futures 公共行情（只读、纯 REST）：合约目录、K 线翻页、盘口、报价轮询、标记价与资金费率。
// 没有 WebSocket：subscribe 按 pollMs 轮询 /api/v1/ticker，status().source 恒为 'rest'。
// 每个请求前先向注入的预算要额度（acquire 为主），成功后 reportOk；预算对象缺省不限。
import type { Book, Candle, CandleInterval, Instrument, InstrumentId, MarketContext, Ms } from '@gitrader/protocol'
import type {
  BudgetUsage, MarketStatus, RateBudget, StampedQuote, SubscriptionSpec, Unsubscribe, VenueEvent,
} from '@gitrader/protocol/connector'
import {
  CANDLE_PAGE, CONTRACTS_PATH, CONTRACTS_WEIGHT, DEFAULT_BASE_URL, DEFAULT_CANDLE_COUNT, DEPTH_WEIGHT, FUNDING_RATE_WEIGHT,
  IP_RATE_LIMIT, IP_RATE_WINDOW_MS, KLINE_PATH, KLINE_WEIGHT, MARK_PRICE_WEIGHT, MAX_CANDLES, MAX_PAGES, ProblemError,
  SUCCESS_CODE, TICKER_PATH, TICKER_WEIGHT, VENUE, depthLimitOf, depthPathOf, fundingRatePath, granularityOf, intervalStepMs,
  markPricePath, parseCandles, parseContext, parseDepth, parseFundingRate, parseInstruments, parseMarkPrice, parseTicker,
  problemError, symbolOf,
} from './parse'
import type { KucoinEnvelope, RawDepth, RawFundingRate, RawMarkPrice, RawTicker } from './parse'

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

export interface KucoinHttpOptions {
  baseUrl: string
  fetchImpl: typeof fetch
  budget: RateBudget | BudgetLike
  timeoutMs: number
}

/** 公共 REST 客户端：只发 GET、不带任何密钥（本连接器不持有凭据）。 */
export class KucoinHttp {
  readonly baseUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly budget: RateBudget | BudgetLike
  private readonly timeoutMs: number

  constructor(o: KucoinHttpOptions) {
    this.baseUrl = o.baseUrl.replace(/\/+$/, '')
    this.fetchImpl = o.fetchImpl
    this.budget = o.budget
    this.timeoutMs = o.timeoutMs
  }

  /** GET 一次并拆信封：`code !== "200000"` 视为场所不可用；成功时回 reportOk。 */
  async getData<T>(path: string, params: Record<string, string | number | undefined>, weight: number): Promise<T> {
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
    const envelope = (body ?? {}) as KucoinEnvelope<unknown>
    const code = envelope.code
    if (String(code) !== SUCCESS_CODE) {
      // KuCoin 的业务错误也走 HTTP 200：code / msg 在信封里，例如 200003 Invalid symbol.
      throw problemError('VENUE_UNAVAILABLE', `${VENUE} ${path} error ${String(code)}`, {
        retryable: true,
        venue: {
          id: VENUE,
          code: String(code),
          message: typeof envelope.msg === 'string' && envelope.msg !== '' ? envelope.msg : 'no message',
        },
      })
    }
    this.budget.reportOk?.()
    return (envelope.data ?? null) as T
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

export interface KucoinMarketOptions {
  /** 公共 REST 基址，缺省 https://api-futures.kucoin.com。 */
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

export class KucoinMarket {
  private readonly http: KucoinHttp
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

  constructor(o: KucoinMarketOptions = {}) {
    this.clock = o.clock ?? (() => Date.now())
    this.budget = o.budget ?? unlimitedBudget()
    this.pollMs = Math.max(1, Math.floor(o.pollMs ?? 5000))
    this.staleMs = Math.max(1, Math.floor(o.staleMs ?? 10_000))
    this.http = new KucoinHttp({
      baseUrl: o.baseUrl ?? DEFAULT_BASE_URL,
      fetchImpl: o.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args)),
      budget: this.budget,
      timeoutMs: o.httpTimeoutMs ?? 10_000,
    })
  }

  // ───────────── 生命周期 ─────────────

  /** 拉一次合约清单并缓存（重复调用不会重复拉）。 */
  async start(): Promise<void> {
    if (this.closed) throw problemError('CAPABILITY_UNSUPPORTED', 'kucoin data connector is closed')
    if (this.started) return
    await this.refreshInstruments()
    this.started = true
  }

  /** 强制重新发现标的（start 只拉一次；这里是显式刷新入口）。 */
  async refreshInstruments(): Promise<void> {
    if (this.closed) throw problemError('CAPABILITY_UNSUPPORTED', 'kucoin data connector is closed')
    const rows = await this.http.getData<unknown>(CONTRACTS_PATH, {}, CONTRACTS_WEIGHT)
    const now = this.clock()
    const next = new Map<InstrumentId, Instrument>()
    for (const instrument of parseInstruments(rows, now)) next.set(instrument.instrumentId, instrument)
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

  /** GET /api/v1/ticker?symbol= 并写入缓存。 */
  async refreshQuote(id: InstrumentId): Promise<StampedQuote | undefined> {
    const symbol = symbolOf(id)
    const raw = await this.http.getData<RawTicker>(TICKER_PATH, { symbol }, TICKER_WEIGHT)
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

  /** GET /api/v1/level2/depth20|depth100?symbol=（深度钳到 1..100，张 → 币按 multiplier 折）。 */
  async book(id: InstrumentId, depth = 20): Promise<Book> {
    const symbol = symbolOf(id)
    const limit = depthLimitOf(depth)
    const raw = await this.http.getData<RawDepth>(depthPathOf(limit), { symbol }, DEPTH_WEIGHT)
    const now = this.clock()
    this.lastMessageTs = now
    return parseDepth(raw, id, Math.max(1, Math.floor(depth)), now, this.contractSizeOf(id))
  }

  /** 每张对应的标的币数（合约清单未加载时按 1 处理，口径见 README）。 */
  private contractSizeOf(id: InstrumentId): number {
    const declared = Number(this.records.get(id)?.contractSize ?? '1')
    return Number.isFinite(declared) && declared > 0 ? declared : 1
  }

  /**
   * K 线。无 from：请求最新一页（上游固定最多 200 根），取末尾 n 根（n 钳到 1..200，缺省 300）。
   * 有 from：from 起每页 200 根，游标 = 末根开盘时间 + 周期，直到越过 to 或不满一页，最多 200 页。
   * 上游升序返回，本方法仍做升序排序与按 t 去重。
   */
  async candles(id: InstrumentId, interval: CandleInterval, opts: { n?: number; from?: Ms; to?: Ms } = {}): Promise<Candle[]> {
    const granularity = granularityOf(interval)
    const step = intervalStepMs(interval)
    const symbol = symbolOf(id)

    if (opts.from === undefined) {
      const n = clampCount(opts.n)
      const rows = await this.http.getData<unknown>(KLINE_PATH, { symbol, granularity }, KLINE_WEIGHT)
      this.lastMessageTs = this.clock()
      return dedupe(parseCandles(rows)).slice(-n)
    }

    const from = Math.floor(opts.from)
    const to = opts.to === undefined ? undefined : Math.floor(opts.to)
    if (to !== undefined && to < from) return []
    const seen = new Map<Ms, Candle>()
    let cursor = from
    for (let page = 0; page < MAX_PAGES; page++) {
      const rows = await this.http.getData<unknown>(
        KLINE_PATH,
        { symbol, granularity, from: cursor, ...(to !== undefined ? { to } : {}) },
        KLINE_WEIGHT,
      )
      this.lastMessageTs = this.clock()
      const pageRows = parseCandles(rows).filter((c) => c.t >= from && (to === undefined || c.t <= to))
      if (pageRows.length === 0) break
      for (const candle of pageRows) seen.set(candle.t, candle)
      const last = pageRows[pageRows.length - 1]!
      const next = last.t + step
      if ((Array.isArray(rows) ? rows.length : 0) < CANDLE_PAGE) break
      if (next <= cursor) break
      if (to !== undefined && next > to) break
      cursor = next
    }
    return [...seen.values()].sort((a, b) => a.t - b.t)
  }

  /** GET /mark-price/{symbol}/current + GET /funding-rate/{symbol}/current。 */
  async context(id: InstrumentId): Promise<MarketContext> {
    const symbol = symbolOf(id)
    const mark = await this.http.getData<RawMarkPrice>(markPricePath(symbol), {}, MARK_PRICE_WEIGHT)
    const funding = await this.http.getData<RawFundingRate>(fundingRatePath(symbol), {}, FUNDING_RATE_WEIGHT)
    const now = this.clock()
    this.lastMessageTs = now
    return parseContext(parseMarkPrice(mark, now), parseFundingRate(funding, now), id)
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
    if (this.closed) throw problemError('CAPABILITY_UNSUPPORTED', 'kucoin data connector is closed')
    if (spec.channel !== 'quote') {
      throw problemError('CAPABILITY_UNSUPPORTED', `kucoin data connector polls quote subscriptions only (got ${spec.channel})`)
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
