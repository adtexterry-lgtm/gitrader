// SPDX-License-Identifier: CPAL-1.0
// Gate.io v4 USDT 永续公共行情（只读、纯 REST）：合约目录、K 线翻页、盘口、报价轮询、标记价与资金费率。
// 没有 WebSocket：subscribe 按 pollMs 轮询 /tickers，status().source 恒为 'rest'。
// 每个请求前先向注入的预算要额度（acquire 为主），成功后 reportOk；预算对象缺省不限。
import type { Book, Candle, CandleInterval, Decimal, Instrument, InstrumentId, Ms } from '@gitrader/protocol'
import type {
  BudgetUsage, MarketStatus, RateBudget, StampedQuote, SubscriptionSpec, Unsubscribe, VenueEvent,
} from '@gitrader/protocol/connector'
import {
  API_PREFIX, BOOK_WEIGHT, CANDLE_PAGE, CANDLES_WEIGHT, DEFAULT_BASE_URL, DEFAULT_CANDLE_COUNT, FUNDING_INTERVAL_MS,
  INSTRUMENTS_WEIGHT, INTERVAL_MS, IP_RATE_LIMIT, IP_RATE_WINDOW_MS, MAX_CANDLES, MAX_PAGES, ProblemError, TICKER_WEIGHT, VENUE,
  depthLimitOf, fundingNextApplyMs, instrumentIdOf, parseBook, parseCandles, parseContext, parseInstruments, parseTicker,
  problemError, toBaseSize, symbolOf, venueIntervalOf, num,
} from './parse'
import type { GateErrorBody, GateioMarketContext, RawBook, RawContract, RawTicker } from './parse'

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

export interface GateHttpOptions {
  baseUrl: string
  fetchImpl: typeof fetch
  budget: RateBudget | BudgetLike
  timeoutMs: number
}

/** 公共 REST 客户端：只发 GET、不带任何密钥（本连接器不持有凭据）。 */
export class GateHttp {
  readonly baseUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly budget: RateBudget | BudgetLike
  private readonly timeoutMs: number

  constructor(o: GateHttpOptions) {
    this.baseUrl = o.baseUrl.replace(/\/+$/, '')
    this.fetchImpl = o.fetchImpl
    this.budget = o.budget
    this.timeoutMs = o.timeoutMs
  }

  /** GET 一次并返回整个响应体（Gate.io 有的端点返回数组、有的返回对象，所以不做信封拆解）。 */
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

  /**
   * 非 2xx → VENUE_UNAVAILABLE（retryable）。Gate.io 的业务错误也用非 2xx + `{ label, message }` 表达
   * （如 400 `CONTRACT_NOT_FOUND`），所以 label 一并带进 venue.code，消息里保留 label。
   * 429 带 Retry-After 并让预算整体退避。
   */
  private async failed(path: string, res: Response): Promise<ProblemError> {
    const text = await res.text().catch(() => '')
    const body = parseErrorBody(text)
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
    const code = body.label ?? res.status
    const detail = body.message ?? body.label ?? (text === '' ? 'empty response' : truncate(text))
    return problemError('VENUE_UNAVAILABLE', `${VENUE} ${path} HTTP ${res.status} ${String(code)}`, {
      retryable: true,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      venue: { id: VENUE, code, message: detail },
    })
  }
}

function parseErrorBody(text: string): GateErrorBody {
  if (text.trim() === '') return {}
  try {
    const body = JSON.parse(text) as unknown
    if (!body || typeof body !== 'object') return {}
    const row = body as GateErrorBody
    const out: GateErrorBody = {}
    if (typeof row.label === 'string') out.label = row.label
    if (typeof row.message === 'string') out.message = row.message
    return out
  } catch {
    return {}
  }
}

const truncate = (s: string): string => (s.length > 200 ? `${s.slice(0, 200)}…` : s)

const CONTRACTS_PATH = `${API_PREFIX}/contracts`
const TICKERS_PATH = `${API_PREFIX}/tickers`
const ORDER_BOOK_PATH = `${API_PREFIX}/order_book`
const CANDLES_PATH = `${API_PREFIX}/candlesticks`

export interface GateioMarketOptions {
  /** 公共 REST 基址，缺省 https://api.gateio.ws。 */
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

export class GateioMarket {
  private readonly http: GateHttp
  private readonly budget: RateBudget | BudgetLike
  private readonly clock: () => number
  private readonly pollMs: number
  private readonly staleMs: number

  private records = new Map<InstrumentId, Instrument>()
  /** 合约清单里的 funding_next_apply（已换成毫秒），供 context() 补 nextFundingTime。 */
  private fundingNext = new Map<InstrumentId, Ms>()
  private quotes = new Map<InstrumentId, { ts: Ms; bid: number; ask: number; last?: number }>()
  private subs = new Set<PollSub>()
  private lastMessageTs = 0
  private started = false
  private closed = false

  constructor(o: GateioMarketOptions = {}) {
    this.clock = o.clock ?? (() => Date.now())
    this.budget = o.budget ?? unlimitedBudget()
    this.pollMs = Math.max(1, Math.floor(o.pollMs ?? 5000))
    this.staleMs = Math.max(1, Math.floor(o.staleMs ?? 10_000))
    this.http = new GateHttp({
      baseUrl: o.baseUrl ?? DEFAULT_BASE_URL,
      fetchImpl: o.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args)),
      budget: this.budget,
      timeoutMs: o.httpTimeoutMs ?? 10_000,
    })
  }

  // ───────────── 生命周期 ─────────────

  /** 拉一次合约清单并缓存（重复调用不会重复拉）。 */
  async start(): Promise<void> {
    if (this.closed) throw problemError('CAPABILITY_UNSUPPORTED', 'gateio data connector is closed')
    if (this.started) return
    await this.refreshInstruments()
    this.started = true
  }

  /** 强制重新发现标的（start 只拉一次；这里是显式刷新入口）。 */
  async refreshInstruments(): Promise<void> {
    if (this.closed) throw problemError('CAPABILITY_UNSUPPORTED', 'gateio data connector is closed')
    const rows = await this.http.get<RawContract[]>(CONTRACTS_PATH, {}, INSTRUMENTS_WEIGHT)
    const now = this.clock()
    const next = new Map<InstrumentId, Instrument>()
    const nextFunding = new Map<InstrumentId, Ms>()
    for (const instrument of parseInstruments(rows, now)) next.set(instrument.instrumentId, instrument)
    for (const row of Array.isArray(rows) ? rows : []) {
      if (!row || typeof row !== 'object') continue
      const c = row as RawContract
      const nextApplyMs = fundingNextApplyMs(c)
      if (typeof c.name !== 'string' || c.name === '' || nextApplyMs === undefined) continue
      nextFunding.set(instrumentIdOf(c.name), nextApplyMs)
    }
    this.records = next
    this.fundingNext = nextFunding
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

  /** GET /tickers?contract= 并写入缓存（Gate.io ticker 无时间戳，ts 用注入时钟）。 */
  async refreshQuote(id: InstrumentId): Promise<StampedQuote | undefined> {
    const contract = symbolOf(id)
    const rows = await this.http.get<RawTicker[]>(TICKERS_PATH, { contract }, TICKER_WEIGHT)
    const now = this.clock()
    const parsed = parseTicker(Array.isArray(rows) ? rows[0] : undefined, now)
    this.lastMessageTs = now
    if (!parsed) {
      this.quotes.delete(id)
      return undefined
    }
    this.quotes.set(id, parsed)
    return this.quote(id)
  }

  /**
   * GET /order_book?contract=&limit=（limit 钳到 1..100）。
   * 上游的 `s` 是张数，按合约缓存里的 quanto_multiplier 折成币数；缓存为空时先拉一次清单。
   */
  async book(id: InstrumentId, depth = 20): Promise<Book> {
    const contract = symbolOf(id)
    const limit = depthLimitOf(depth)
    await this.ensureInstruments()
    const rows = await this.http.get<RawBook>(ORDER_BOOK_PATH, { contract, limit }, BOOK_WEIGHT)
    const now = this.clock()
    this.lastMessageTs = now
    return parseBook(rows, id, Math.max(1, Math.floor(depth)), this.contractSizeOf(id), now)
  }

  /**
   * K 线。无 from：`limit=n` 取最近 n 根（n 钳到 1..2000，缺省 300），上游升序。
   * 有 from：Gate.io **不允许 limit 与 from/to 同时出现**（400 INVALID_PARAM_VALUE），
   * 所以按 `from=cursor`（+ `to`）翻页，每页最多 2000 根，游标推到本页最新一根 + 一个周期，
   * 直到越过 to、不满一页、无进展或满 200 页。返回升序、按 t 去重。
   */
  async candles(id: InstrumentId, interval: CandleInterval, opts: { n?: number; from?: Ms; to?: Ms } = {}): Promise<Candle[]> {
    const stepMs = INTERVAL_MS[interval]
    if (!stepMs) throw problemError('INVALID_PARAMS', `unsupported candle interval: ${String(interval)}`)
    const bar = venueIntervalOf(interval)
    const contract = symbolOf(id)

    if (opts.from === undefined) {
      const n = clampCount(opts.n)
      await this.ensureInstruments()
      const rows = await this.http.get<unknown>(CANDLES_PATH, { contract, interval: bar, limit: n }, CANDLES_WEIGHT)
      this.lastMessageTs = this.clock()
      return dedupe(parseCandles(rows, this.contractSizeOf(id))).slice(-n)
    }

    const from = Math.floor(opts.from)
    const to = opts.to === undefined ? undefined : Math.floor(opts.to)
    if (to !== undefined && to < from) return []
    await this.ensureInstruments()
    const contractSize = this.contractSizeOf(id)
    const stepSec = Math.max(1, Math.floor(stepMs / 1000))
    const toSec = to === undefined ? undefined : Math.floor(to / 1000)
    const seen = new Map<Ms, Candle>()
    let cursor = Math.floor(from / 1000)

    for (let page = 0; page < MAX_PAGES; page++) {
      const rows = await this.http.get<unknown>(
        CANDLES_PATH,
        { contract, interval: bar, from: cursor, ...(toSec !== undefined ? { to: toSec } : {}) },
        CANDLES_WEIGHT,
      )
      this.lastMessageTs = this.clock()
      const pageRows = parseCandles(rows, contractSize)
      if (pageRows.length === 0) break
      let newest = pageRows[0]!.t
      for (const candle of pageRows) {
        if (candle.t > newest) newest = candle.t
        if (candle.t >= from && (to === undefined || candle.t <= to)) seen.set(candle.t, candle)
      }
      if (pageRows.length < CANDLE_PAGE) break
      if (to !== undefined && newest >= to) break
      const next = Math.floor(newest / 1000) + stepSec
      if (next <= cursor) break
      cursor = next
    }
    return [...seen.values()].sort((a, b) => a.t - b.t)
  }

  /**
   * GET /tickers?contract= → 标记价 / 资金费率 / 持仓量（total_size 张 → 币）。
   * fundingIntervalMs 取合约缓存（funding_interval 秒 → 毫秒），nextFundingTime 取 funding_next_apply；
   * 清单未加载时先拉一次清单。
   */
  async context(id: InstrumentId): Promise<GateioMarketContext> {
    await this.ensureInstruments()
    const contract = symbolOf(id)
    const rows = await this.http.get<RawTicker[]>(TICKERS_PATH, { contract }, TICKER_WEIGHT)
    const now = this.clock()
    this.lastMessageTs = now
    const record = this.records.get(id)
    const raw = Array.isArray(rows) ? rows[0] : undefined
    // 合约缓存没有面值时回落到 ticker 自带的 quanto_multiplier；两者都没有就按 1（原样张数）
    const tickerMultiplier = num(raw?.quanto_multiplier)
    return parseContext(
      raw,
      {
        instrumentId: id,
        fundingIntervalMs: record?.fundingIntervalMs ?? FUNDING_INTERVAL_MS,
        contractSize: record?.contractSize
          ?? (Number.isFinite(tickerMultiplier) && tickerMultiplier > 0 ? tickerMultiplier : undefined),
        nextFundingTime: this.fundingNext.get(id),
      },
      now,
    )
  }

  private contractSizeOf(id: InstrumentId): Decimal | undefined {
    return this.records.get(id)?.contractSize
  }

  /** 合约缓存为空时先拉一次清单：K 线 `v` / 盘口 `size` / 持仓量都要 quanto_multiplier 才能折成币。 */
  private async ensureInstruments(): Promise<void> {
    if (this.records.size > 0) return
    await this.start()
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

  /** 只支持 quote 频道：按 pollMs 轮询 /tickers，用 VenueEvent quote 回调。返回退订函数。 */
  subscribe(spec: SubscriptionSpec, cb: (e: VenueEvent) => void): Unsubscribe {
    if (this.closed) throw problemError('CAPABILITY_UNSUPPORTED', 'gateio data connector is closed')
    if (spec.channel !== 'quote') {
      throw problemError('CAPABILITY_UNSUPPORTED', `gateio data connector polls quote subscriptions only (got ${spec.channel})`)
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

// 保留导出，便于上层按同一口径聚合（张数 → 币数）
export const sizeInBase = (contracts: number, contractSize: Decimal | number | undefined): number =>
  toBaseSize(contracts, contractSize)
