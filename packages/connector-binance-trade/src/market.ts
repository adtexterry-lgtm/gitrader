// SPDX-License-Identifier: CPAL-1.0
// 行情 / 合约元数据（只读 REST）。解析逻辑 **Copied from packages/connector-binance-data/src/{parse,market}.ts**
// (CPAL-1.0)，以数据包为准；本文件只做「交易连接器需要的部分」：exchangeInfo 刷新、bookTicker 报价、depth 盘口、
// klines K 线、premiumIndex 上下文，外加一个按 pollMs 轮询的 quote / mids 订阅（没有 WebSocket 行情）。
// 与数据包的差异只有一处：subscribe 只支持 quote / mids，其余通道抛 CAPABILITY_UNSUPPORTED（不假装支持）。
import { makeProblem } from '@gitrader/protocol'
import type { Book, Candle, CandleInterval, Instrument, MarketContext, Ms } from '@gitrader/protocol'
import type { MarketStatus, RateBudget, StampedQuote, SubscriptionSpec, Unsubscribe, VenueEvent } from '@gitrader/protocol/connector'
import { BINANCE_WEIGHTS } from './budget'
import { asProblem, ProblemError } from './errors'
import {
  DEFAULT_CANDLE_COUNT, instrumentIdOf, parseBookTicker, parseDepth, parseInstrumentRecords, parseKlines, parsePremiumIndex,
  num, symbolOf,
} from './parse'
import type { InstrumentRecord, RawBookTicker, RawDepth, RawPremiumIndex } from './parse'
import type { BinanceHttp } from './rest'

// Copied from packages/connector-binance-data/src/parse.ts:16-17,26-31,273-274 (CPAL-1.0).
export const MAX_CANDLES = 1_500
export const CANDLE_PAGE = 1_500
export const INTERVAL_MS: Record<CandleInterval, number> = {
  '1m': 60_000, '3m': 180_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000,
  '1h': 3_600_000, '2h': 7_200_000, '4h': 14_400_000, '8h': 28_800_000, '12h': 43_200_000,
  '1d': 86_400_000, '3d': 259_200_000, '1w': 604_800_000, '1M': 2_592_000_000,
}
export const klineWeight = (limit: number): number => (limit <= 100 ? 1 : limit <= 500 ? 2 : limit <= 1_000 ? 5 : 10)
export const depthWeight = (limit: number): number => (limit <= 50 ? 2 : limit <= 100 ? 5 : limit <= 500 ? 10 : 20)
const DEPTH_LIMITS = [5, 10, 20, 50, 100, 500, 1_000] as const
export function depthLimitOf(depth: number | undefined): number {
  const want = Number.isFinite(depth) && (depth as number) > 0 ? Math.ceil(depth as number) : 20
  for (const limit of DEPTH_LIMITS) if (limit >= want) return limit
  return 1_000
}

export interface MarketOptions {
  http: BinanceHttp
  clock?: () => number
  /** 报价陈旧阈值（quote.stale / status.stale），缺省 10 s。 */
  staleMs?: number
  /** 轮询订阅间隔，缺省 5 s。 */
  pollMs?: number
  secrets?: readonly string[]
}

interface PollSub {
  timer: ReturnType<typeof setInterval>
  run: () => Promise<void>
}

export class BinanceMarket {
  readonly http: BinanceHttp
  private readonly clock: () => number
  private readonly staleMs: number
  private readonly pollMs: number
  readonly #secrets: readonly string[]
  private readonly byId = new Map<string, InstrumentRecord>()
  private readonly quotes = new Map<string, StampedQuote>()
  private readonly subs = new Map<number, PollSub>()
  private nextSubId = 1
  private loaded = 0
  private lastMessageAt = 0

  constructor(o: MarketOptions) {
    this.http = o.http
    this.clock = o.clock ?? (() => Date.now())
    this.staleMs = o.staleMs ?? 10_000
    this.pollMs = o.pollMs ?? 5_000
    this.#secrets = o.secrets ?? []
  }

  /** exchangeInfo → 标的地图（覆盖式刷新；已下架条目保留，状态为 delisted）。 */
  async refresh(): Promise<void> {
    const now = this.clock()
    let raw: unknown
    try {
      raw = await this.http.publicGet<unknown>('/fapi/v1/exchangeInfo', {}, BINANCE_WEIGHTS.exchangeInfo)
    } catch (e) {
      throw new ProblemError(asProblem(e, { secrets: this.#secrets, endpoint: 'public' }))
    }
    const records = parseInstrumentRecords(raw, now)
    this.byId.clear()
    for (const r of records) this.byId.set(r.instrument.instrumentId, r)
    this.loaded = now
    this.lastMessageAt = now
  }

  /** 已加载的标的（调用方应先 await refresh()；没加载就是空数组）。 */
  listInstruments(opts: { includeDelisted?: boolean } = {}): Instrument[] {
    const out: Instrument[] = []
    for (const r of this.byId.values()) {
      if (r.instrument.status === 'delisted' && opts.includeDelisted !== true) continue
      out.push(r.instrument)
    }
    return out.sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0))
  }

  getInstrument(id: string): Instrument | undefined {
    return this.byId.get(id)?.instrument
  }

  getRecord(id: string): InstrumentRecord | undefined {
    return this.byId.get(id)
  }

  requireRecord(id: string): InstrumentRecord {
    const rec = this.byId.get(id)
    if (!rec) throw new ProblemError(makeProblem('INSTRUMENT_UNKNOWN', `unknown instrument ${id}; call refresh() first`))
    return rec
  }

  /** 最近一次报价（同步，不打网络）；年龄 / stale 按当前时钟现算。 */
  quoteCached(id: string): StampedQuote | undefined {
    const q = this.quotes.get(id)
    if (!q) return undefined
    const ageMs = Math.max(0, this.clock() - q.ts)
    return { ...q, ageMs, stale: ageMs > this.staleMs }
  }

  async quote(id: string): Promise<StampedQuote> {
    const symbol = symbolOf(id)
    let raw: RawBookTicker
    try {
      raw = await this.http.publicGet<RawBookTicker>('/fapi/v1/ticker/bookTicker', { symbol }, BINANCE_WEIGHTS.bookTicker)
    } catch (e) {
      throw new ProblemError(asProblem(e, { secrets: this.#secrets, endpoint: 'public' }))
    }
    const now = this.clock()
    const parsed = parseBookTicker(raw, now)
    if (!parsed) throw new ProblemError(makeProblem('STALE_PRICE', `no book ticker for ${id}`, { retryable: true }))
    const quote: StampedQuote = {
      instrumentId: id,
      ts: parsed.ts,
      bid: parsed.bid,
      ask: parsed.ask,
      stale: now - parsed.ts > this.staleMs,
      ageMs: Math.max(0, now - parsed.ts),
    }
    this.quotes.set(id, quote)
    this.lastMessageAt = now
    return quote
  }

  async book(id: string, depth = 20): Promise<Book> {
    const symbol = symbolOf(id)
    const limit = depthLimitOf(depth)
    let raw: RawDepth
    try {
      raw = await this.http.publicGet<RawDepth>('/fapi/v1/depth', { symbol, limit }, depthWeight(limit))
    } catch (e) {
      throw new ProblemError(asProblem(e, { secrets: this.#secrets, endpoint: 'public' }))
    }
    this.lastMessageAt = this.clock()
    return parseDepth(raw, id, limit, this.clock())
  }

  async candles(id: string, interval: CandleInterval, opts: { n?: number; from?: Ms; to?: Ms } = {}): Promise<Candle[]> {
    const symbol = symbolOf(id)
    const limit = Math.min(Math.max(1, opts.n ?? DEFAULT_CANDLE_COUNT), MAX_CANDLES)
    const params: Record<string, string | number | undefined> = { symbol, interval, limit }
    if (opts.from !== undefined) params.startTime = Math.round(opts.from)
    if (opts.to !== undefined) params.endTime = Math.round(opts.to)
    try {
      const raw = await this.http.publicGet<unknown>('/fapi/v1/klines', params, klineWeight(limit), { kind: 'background' })
      return parseKlines(raw)
    } catch (e) {
      throw new ProblemError(asProblem(e, { secrets: this.#secrets, endpoint: 'public' }))
    }
  }

  async context(id: string): Promise<MarketContext> {
    const symbol = symbolOf(id)
    try {
      const raw = await this.http.publicGet<RawPremiumIndex>('/fapi/v1/premiumIndex', { symbol }, BINANCE_WEIGHTS.premiumIndex)
      return parsePremiumIndex(raw, id, this.clock())
    } catch (e) {
      throw new ProblemError(asProblem(e, { secrets: this.#secrets, endpoint: 'public' }))
    }
  }

  /** 只支持 quote / mids（轮询）；其它通道 CAPABILITY_UNSUPPORTED。 */
  subscribe(spec: SubscriptionSpec, cb: (e: VenueEvent) => void): Unsubscribe {
    if (spec.channel !== 'quote' && spec.channel !== 'mids') {
      throw new ProblemError(makeProblem('CAPABILITY_UNSUPPORTED', `${spec.channel} subscriptions are not available on this connector`))
    }
    const id = this.nextSubId++
    const run = async (): Promise<void> => {
      try {
        if (spec.channel === 'quote') {
          const q = await this.quote(spec.instrumentId)
          cb({ channel: 'quote', quote: q })
          return
        }
        const mids: Record<string, number> = {}
        for (const rec of this.byId.values()) mids[rec.instrument.instrumentId] = Number((await this.quote(rec.instrument.instrumentId)).ask)
        cb({ channel: 'mids', mids, ts: this.clock() })
      } catch {
        // 轮询失败不抛：status() 会体现陈旧
      }
    }
    const timer = setInterval(() => { void run() }, this.pollMs)
    timer.unref?.()
    this.subs.set(id, { timer, run })
    return () => {
      const sub = this.subs.get(id)
      if (sub) {
        clearInterval(sub.timer)
        this.subs.delete(id)
      }
    }
  }

  status(): MarketStatus {
    const now = this.clock()
    const usage = this.http.usage()
    return {
      venue: 'binance',
      environment: this.http.environment,
      ts: now,
      wsState: 'disconnected',
      stale: this.lastMessageAt === 0 ? true : now - this.lastMessageAt > this.staleMs,
      source: this.lastMessageAt === 0 ? 'none' : 'rest',
      lastMessageTs: this.lastMessageAt,
      rateBudget: { used: usage.used, limit: usage.limit, windowMs: usage.windowMs },
    }
  }

  /** 诊断：预算占用（透传，便于内核观察）。 */
  usage(): ReturnType<RateBudget['usage']> {
    return this.http.usage()
  }

  /** 元数据加载时刻（0 = 还没加载）。 */
  get loadedAt(): number {
    return this.loaded
  }

  async close(): Promise<void> {
    for (const sub of this.subs.values()) clearInterval(sub.timer)
    this.subs.clear()
  }

  /** 测试 / 诊断：包一层报价（不联网），用于把固定盘口喂给 buildOrderParams。 */
  seedQuote(id: string, bid: number, ask: number, ts?: number): void {
    const at = ts ?? this.clock()
    this.quotes.set(id, { instrumentId: id, ts: at, bid, ask, stale: this.clock() - at > this.staleMs, ageMs: Math.max(0, this.clock() - at) })
  }

  /** 把 exchangeInfo 响应直接栽进地图（离线测试与启动预热用）。 */
  seedInstruments(raw: unknown): void {
    const records = parseInstrumentRecords(raw, this.clock())
    for (const r of records) this.byId.set(r.instrument.instrumentId, r)
    this.loaded = this.clock()
  }

  /** 诊断：报价条数。 */
  get quoteCount(): number {
    return this.quotes.size
  }

  /** instrumentId → symbol 的便捷映射（未知时抛 INVALID_PARAMS）。 */
  symbolOf(id: string): string {
    return this.byId.get(id)?.symbol ?? symbolOf(id)
  }

  /** 原始数字工具（与数据包同口径）：字符串 / 数字 → number。 */
  static num = num
  /** instrumentId 构造（与数据包同口径）。 */
  static idOf = instrumentIdOf
}
