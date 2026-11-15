// SPDX-License-Identifier: CPAL-1.0
// HTX（原火币）USDT 本位永续公共行情（只读、纯 REST）：合约目录、K 线翻页、盘口、报价轮询、标记价与资金费。
// 没有 WebSocket：subscribe 按 pollMs 轮询 /linear-swap-ex/market/detail/merged，status().source 恒为 'rest'。
// 每个请求前先向注入的预算要额度（acquire 为主），成功后 reportOk；预算对象缺省不限。
// 端点与校验规则的出处：HTX 官方 USDT-M 合约 API v1 文档（见 parse.ts 的 DOCS_URL），逐端点注释在下方。
import type { Book, Candle, CandleInterval, Decimal, Instrument, InstrumentId, Ms, ProblemName } from '@gitrader/protocol'
import type {
  BudgetUsage, MarketStatus, RateBudget, StampedQuote, SubscriptionSpec, Unsubscribe, VenueEvent,
} from '@gitrader/protocol/connector'
import {
  BOOK_LEVELS_WIDE, CANDLE_PAGE, DEFAULT_BASE_URL, DEFAULT_CANDLE_COUNT, FUNDING_INTERVAL_MS, INTERVAL_MS, IP_RATE_LIMIT,
  IP_RATE_WINDOW_MS, MAX_CANDLES, MAX_PAGES, ProblemError, VENUE, depthStepOf, num, parseCandles, parseContext, parseDepth,
  parseInstruments, parseMarkPrice, parseMergedQuote, problemError, symbolOf, venueIntervalOf,
} from './parse'
import type { HtxEnvelope, HtxMarketContext, RawFunding } from './parse'

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

export interface HtxHttpOptions {
  baseUrl: string
  fetchImpl: typeof fetch
  budget: RateBudget | BudgetLike
  timeoutMs: number
}

/** 公共 REST 客户端：只发 GET、不带任何密钥（本连接器不持有凭据）。 */
export class HtxHttp {
  readonly baseUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly budget: RateBudget | BudgetLike
  private readonly timeoutMs: number

  constructor(o: HtxHttpOptions) {
    this.baseUrl = o.baseUrl.replace(/\/+$/, '')
    this.fetchImpl = o.fetchImpl
    this.budget = o.budget
    this.timeoutMs = o.timeoutMs
  }

  /**
   * GET 一次并校验 HTX 信封。HTX 的**业务错误是 HTTP 200 + `{status:"error", err_code, err_msg}`**
   * （HTX v1 §Details of Each Error Code），所以只在 `!res.ok` 判错会把「合约不存在」「限频」当成空数据。
   * 非 2xx 与业务错误都必须变成异常；业务错误按 err_code 分类（1013/1014 标的未知、1030/1033 参数错、
   * 1032 访问超限），其余码维持 VENUE_UNAVAILABLE（retryable），`venue.code` 始终带 err_code。
   */
  async get(path: string, params: Record<string, string | number | undefined>, weight: number): Promise<HtxEnvelope> {
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
    if (!body || typeof body !== 'object') {
      throw problemError('VENUE_UNAVAILABLE', `${VENUE} ${path} returned a non-object body`, {
        venue: { id: VENUE, message: 'invalid response' },
      })
    }
    const envelope = body as HtxEnvelope
    if (envelope.status !== 'ok') {
      const code = num(envelope.err_code)
      const venueCode: number | string = Number.isFinite(code) ? code : String(envelope.status ?? 'error')
      const failure = classifyBusinessError(code)
      if (failure.retryAfterMs !== undefined) {
        const b: BudgetLike = this.budget
        b.penalize?.(failure.retryAfterMs)
      }
      throw problemError(failure.name, `${VENUE} ${path} ${String(venueCode)}`, {
        retryable: failure.retryable,
        ...(failure.retryAfterMs !== undefined ? { retryAfterMs: failure.retryAfterMs } : {}),
        venue: { id: VENUE, code: venueCode, message: envelope.err_msg ?? 'venue reported an error' },
      })
    }
    this.budget.reportOk?.()
    return envelope
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
  private async failed(path: string, res: Response): Promise<ProblemError> {
    const text = truncate(await res.text().catch(() => ''))
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
    return problemError('VENUE_UNAVAILABLE', `${VENUE} ${path} HTTP ${String(res.status)}`, {
      retryable: true,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      venue: { id: VENUE, code: res.status, message: text === '' ? 'empty response' : text },
    })
  }
}

const truncate = (s: string): string => (s.length > 200 ? `${s.slice(0, 200)}…` : s)

interface BusinessFailure {
  name: ProblemName
  retryable: boolean
  retryAfterMs?: number
}

/**
 * HTX v1 §Details of Each Error Code 里能确定的业务错误 → 协议问题码；
 * 1013/1014 标的未知、1030/1033 参数错（都不可重试），1032 访问超限（可重试，让预算退避 3 s）。
 * 其它码（1000 System error / 1004 System busy 等）与无码仍是 VENUE_UNAVAILABLE（retryable）。
 */
function classifyBusinessError(code: number): BusinessFailure {
  switch (code) {
    case 1013:
    case 1014:
      return { name: 'INSTRUMENT_UNKNOWN', retryable: false }
    case 1030:
    case 1033:
      return { name: 'INVALID_PARAMS', retryable: false }
    case 1032:
      return { name: 'VENUE_RATE_LIMITED', retryable: true, retryAfterMs: 3000 }
    default:
      return { name: 'VENUE_UNAVAILABLE', retryable: true }
  }
}

/**
 * 端点常量（全部来自 HTX v1；路径大小写与官方示例一致）：
 * - CONTRACTS_PATH：§[General] Query Swap Info
 * - KLINE_PATH：§[General] Get KLine Data
 * - DEPTH_PATH：§[General] Get Market Depth
 * - MERGED_PATH：§[General] Get Market Data Overview
 * - FUNDING_PATH：§[General] Query funding rate
 * - MARK_KLINE_PATH：§[General] Get Kline Data of Mark Price
 */
const CONTRACTS_PATH = '/linear-swap-api/v1/swap_contract_info'
const KLINE_PATH = '/linear-swap-ex/market/history/kline'
const DEPTH_PATH = '/linear-swap-ex/market/depth'
const MERGED_PATH = '/linear-swap-ex/market/detail/merged'
const FUNDING_PATH = '/linear-swap-api/v1/swap_funding_rate'
const MARK_KLINE_PATH = '/index/market/history/linear_swap_mark_price_kline'

export const ENDPOINTS = {
  contracts: CONTRACTS_PATH,
  kline: KLINE_PATH,
  depth: DEPTH_PATH,
  merged: MERGED_PATH,
  funding: FUNDING_PATH,
  markKline: MARK_KLINE_PATH,
} as const

export interface HtxMarketOptions {
  /** 公共 REST 基址，缺省 https://api.hbdm.com。 */
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

export class HtxMarket {
  private readonly http: HtxHttp
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

  constructor(o: HtxMarketOptions = {}) {
    this.clock = o.clock ?? (() => Date.now())
    this.budget = o.budget ?? unlimitedBudget()
    this.pollMs = Math.max(1, Math.floor(o.pollMs ?? 5000))
    this.staleMs = Math.max(1, Math.floor(o.staleMs ?? 10_000))
    this.http = new HtxHttp({
      baseUrl: o.baseUrl ?? DEFAULT_BASE_URL,
      fetchImpl: o.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args)),
      budget: this.budget,
      timeoutMs: o.httpTimeoutMs ?? 10_000,
    })
  }

  // ───────────── 生命周期 ─────────────

  /** 拉一次合约清单并缓存（重复调用不会重复拉）。 */
  async start(): Promise<void> {
    if (this.closed) throw problemError('CAPABILITY_UNSUPPORTED', 'htx data connector is closed')
    if (this.started) return
    await this.refreshInstruments()
    this.started = true
  }

  /**
   * GET /linear-swap-api/v1/swap_contract_info?business_type=swap&contract_type=swap
   * 强制重新发现标的（start 只拉一次；这里是显式刷新入口）。
   * 显式带 business_type/contract_type 是官方推荐用法（business_type 缺省是 swap），免得混进期货条目。
   */
  async refreshInstruments(): Promise<void> {
    if (this.closed) throw problemError('CAPABILITY_UNSUPPORTED', 'htx data connector is closed')
    const envelope = await this.http.get(CONTRACTS_PATH, { business_type: 'swap', contract_type: 'swap' }, 1)
    const now = this.clock()
    const next = new Map<InstrumentId, Instrument>()
    for (const instrument of parseInstruments(envelope.data, now)) next.set(instrument.instrumentId, instrument)
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

  /** GET /linear-swap-ex/market/detail/merged?contract_code= 并写入缓存。 */
  async refreshQuote(id: InstrumentId): Promise<StampedQuote | undefined> {
    const contract = symbolOf(id)
    const envelope = await this.http.get(MERGED_PATH, { contract_code: contract }, 1)
    const now = this.clock()
    const parsed = parseMergedQuote(envelope.tick, now)
    this.lastMessageTs = now
    if (!parsed) {
      this.quotes.delete(id)
      return undefined
    }
    this.quotes.set(id, parsed)
    return this.quote(id)
  }

  /**
   * GET /linear-swap-ex/market/depth?contract_code=&type=（HTX v1 §[General] Get Market Depth）。
   * type：≤20 档用 step6，更多用 step0（150 档）；上游 `vol` 是张数，按合约面值折成币数。
   * 合约缓存为空时先拉一次清单（面值只在 swap_contract_info 里）。
   */
  async book(id: InstrumentId, depth = 20): Promise<Book> {
    const contract = symbolOf(id)
    await this.ensureInstruments()
    const envelope = await this.http.get(DEPTH_PATH, { contract_code: contract, type: depthStepOf(depth) }, 1)
    const now = this.clock()
    this.lastMessageTs = now
    return parseDepth(envelope.tick, id, Math.max(1, Math.min(BOOK_LEVELS_WIDE, Math.floor(depth))), this.contractSizeOf(id), now)
  }

  /**
   * K 线（HTX v1 §[General] Get KLine Data）。无 from：`size=n` 取最近 n 根（n 钳到 1..2000，缺省 300）。
   * 有 from：官方**要求 from 与 to 同时给**，且「from、to、size 三者都填时 from/to 会被忽略」「单次最多 2000 根」，
   * 所以区间模式不带 size，而是把 [from, to] 切成每段 ≤2000 根的窗口，逐段请求（最多 200 页）。
   * 官方注明该接口大致只能取最近两年；更早的区间会返回空页，这里按空页结束。
   * 返回升序、按 t 去重。
   */
  async candles(id: InstrumentId, interval: CandleInterval, opts: { n?: number; from?: Ms; to?: Ms } = {}): Promise<Candle[]> {
    const stepMs = INTERVAL_MS[interval]
    if (!stepMs) throw problemError('INVALID_PARAMS', `unsupported candle interval: ${String(interval)}`)
    const period = venueIntervalOf(interval)
    const contract = symbolOf(id)

    if (opts.from === undefined) {
      const n = clampCount(opts.n)
      await this.ensureInstruments()
      const envelope = await this.http.get(KLINE_PATH, { contract_code: contract, period, size: n }, 1)
      this.lastMessageTs = this.clock()
      return dedupe(parseCandles(envelope.data, this.contractSizeOf(id))).slice(-n)
    }

    const from = Math.floor(opts.from)
    const to = opts.to === undefined ? this.clock() : Math.floor(opts.to)
    if (to < from) return []
    await this.ensureInstruments()
    const contractSize = this.contractSizeOf(id)
    const stepSec = Math.max(1, Math.floor(stepMs / 1000))
    const fromSec = Math.floor(from / 1000)
    const toSec = Math.floor(to / 1000)
    const seen = new Map<Ms, Candle>()
    let cursor = fromSec

    for (let page = 0; page < MAX_PAGES; page++) {
      if (cursor > toSec) break
      // 一页最多 CANDLE_PAGE 根：窗口末端 = cursor + (CANDLE_PAGE-1) 个周期，且不越过 to
      const windowEnd = Math.min(toSec, cursor + (CANDLE_PAGE - 1) * stepSec)
      const envelope = await this.http.get(
        KLINE_PATH,
        { contract_code: contract, period, from: cursor, to: windowEnd },
        1,
      )
      this.lastMessageTs = this.clock()
      const rows = parseCandles(envelope.data, contractSize).filter((c) => c.t >= from && c.t <= to)
      for (const candle of rows) seen.set(candle.t, candle)
      if (windowEnd >= toSec) break
      const next = windowEnd + stepSec
      if (next <= cursor) break
      cursor = next
    }
    return [...seen.values()].sort((a, b) => a.t - b.t)
  }

  /**
   * context：标记价 + 资金费（HTX v1 §[General] Get Kline Data of Mark Price / §[General] Query funding rate）。
   * HTX 没有公开的 REST 实时标记价端点，标记价取最新 1 分钟标记价 K 线的收盘（最多落后 1 分钟，README 已写）。
   * 两个请求；fundingIntervalMs 固定 8 h（官方示例 funding_time → next_funding_time 差 8 h）。
   */
  async context(id: InstrumentId): Promise<HtxMarketContext> {
    const contract = symbolOf(id)
    const markEnvelope = await this.http.get(MARK_KLINE_PATH, { contract_code: contract, period: '1min', size: 1 }, 1)
    const fundingEnvelope = await this.http.get(FUNDING_PATH, { contract_code: contract }, 1)
    const now = this.clock()
    this.lastMessageTs = now
    const mark = parseMarkPrice(markEnvelope.data, now)
    return parseContext(fundingEnvelope.data as RawFunding | undefined, mark, {
      instrumentId: id,
      fundingIntervalMs: this.records.get(id)?.fundingIntervalMs ?? FUNDING_INTERVAL_MS,
    }, now)
  }

  private contractSizeOf(id: InstrumentId): Decimal | undefined {
    return this.records.get(id)?.contractSize
  }

  /** 合约缓存为空时先拉一次清单：盘口张数与 K 线 vol 回落都要面值才能折成币。 */
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

  /** 只支持 quote 频道：按 pollMs 轮询 market/detail/merged，用 VenueEvent quote 回调。返回退订函数。 */
  subscribe(spec: SubscriptionSpec, cb: (e: VenueEvent) => void): Unsubscribe {
    if (this.closed) throw problemError('CAPABILITY_UNSUPPORTED', 'htx data connector is closed')
    if (spec.channel !== 'quote') {
      throw problemError('CAPABILITY_UNSUPPORTED', `htx data connector polls quote subscriptions only (got ${spec.channel})`)
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
