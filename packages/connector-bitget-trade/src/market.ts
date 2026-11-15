// SPDX-License-Identifier: CPAL-1.0
// 行情 / 合约元数据（只读）。**直接复用 packages/connector-bitget-data 的解析与轮询**（依赖它的 BitgetMarket），
// 本文件只做交易连接器需要的三件事：
//   ① 把数据包的 Instrument 包成 InstrumentRecord（带 tick / step / minSize，供下单规整）；
//   ② 维护一份可注入的报价缓存（测试 seedQuote，交易下单要用 mid 与滑点带）；
//   ③ 只声明数据包真的支持的订阅通道（它只轮询 quote），其它通道抛 CAPABILITY_UNSUPPORTED。
// 数据包源码：packages/connector-bitget-data/src/{parse,market}.ts（CPAL-1.0，只读复用，以包为准）。
import { makeProblem } from '@gitrader/protocol'
import type { Book, Candle, CandleInterval, Instrument, MarketContext, Ms } from '@gitrader/protocol'
import type { MarketStatus, StampedQuote, SubscriptionSpec, Unsubscribe, VenueEvent } from '@gitrader/protocol/connector'
import { BitgetMarket } from '@gitrader/connector-bitget-data'
import type { BudgetLike } from '@gitrader/connector-bitget-data'
import type { BitgetBudget } from './budget'
import type { Environment } from './rest'
import { ProblemError } from './errors'
import { parseInstrumentRecords, recordFromInstrument, symbolOf } from './parse'
import type { InstrumentRecord } from './parse'

export interface BitgetMarketOptions {
  fetchImpl?: typeof fetch
  baseUrl?: string
  clock?: () => number
  /** 内核注入的预算（与 REST 共用一份，行情也计配额）。 */
  budget?: BitgetBudget
  /** 报价陈旧阈值，缺省 10 s。 */
  staleMs?: number
  /** 轮询订阅间隔，缺省 5 s。 */
  pollMs?: number
  httpTimeoutMs?: number
  environment?: Environment
}

/** 交易侧的报价参考（下单要用 bid / ask / mid / stale / ageMs）。 */
export interface QuoteRef { bid?: number; ask?: number; mid?: number; stale?: boolean; ageMs?: number }

export class BitgetTradeMarket {
  readonly data: BitgetMarket
  private readonly clock: () => number
  private readonly staleMs: number
  private readonly environment: Environment
  private records = new Map<string, InstrumentRecord>()
  private quotes = new Map<string, StampedQuote>()
  private lastMessageAt = 0

  constructor(o: BitgetMarketOptions = {}) {
    this.clock = o.clock ?? (() => Date.now())
    this.staleMs = o.staleMs ?? 10_000
    this.environment = o.environment ?? 'mainnet'
    this.data = new BitgetMarket({
      ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}),
      ...(o.baseUrl ? { baseUrl: o.baseUrl } : {}),
      clock: this.clock,
      ...(o.budget ? { budget: o.budget as unknown as BudgetLike } : {}),
      staleMs: this.staleMs,
      ...(o.pollMs !== undefined ? { pollMs: o.pollMs } : {}),
      ...(o.httpTimeoutMs !== undefined ? { httpTimeoutMs: o.httpTimeoutMs } : {}),
    })
  }

  /** 拉合约清单并重建记录（数据包 start() 只拉一次；本方法每次强制刷新）。 */
  async refresh(): Promise<void> {
    await this.data.refreshInstruments()
    this.rebuildFromData()
  }

  /** 启动：数据包 start()（幂等）后建记录。 */
  async start(): Promise<void> {
    await this.data.start()
    this.rebuildFromData()
  }

  private rebuildFromData(): void {
    const next = new Map<string, InstrumentRecord>()
    for (const instrument of this.data.listInstruments({ includeDelisted: true })) {
      next.set(instrument.instrumentId, recordFromInstrument(instrument))
    }
    this.records = next
    this.lastMessageAt = this.clock()
  }

  listInstruments(opts: { includeDelisted?: boolean } = {}): Instrument[] {
    const out: Instrument[] = []
    for (const record of this.records.values()) {
      if (record.instrument.status === 'delisted' && opts.includeDelisted !== true) continue
      out.push(record.instrument)
    }
    return out
  }

  getInstrument(id: string): Instrument | undefined {
    return this.records.get(id)?.instrument
  }

  getRecord(id: string): InstrumentRecord | undefined {
    return this.records.get(id)
  }

  requireRecord(id: string): InstrumentRecord {
    const record = this.records.get(id)
    if (!record) throw new ProblemError(makeProblem('INSTRUMENT_UNKNOWN', `unknown instrument ${id}; call refresh() first`))
    return record
  }

  /** 同步读缓存（不联网）。 */
  quote(id: string): StampedQuote | undefined {
    const own = this.quotes.get(id)
    if (own) return this.withAge(own)
    // 数据包自己按 staleMs 算 stale / ageMs：原样透传，绝不把陈旧报价标成新鲜（市价模拟靠它拒单）。
    return this.data.quote(id)
  }

  private withAge(quote: StampedQuote): StampedQuote {
    const ageMs = Math.max(0, this.clock() - quote.ts)
    return { ...quote, ageMs, stale: ageMs > this.staleMs }
  }

  /** 拉一次行情报价并写缓存。 */
  async refreshQuote(id: string): Promise<StampedQuote | undefined> {
    const parsed = await this.data.refreshQuote(id)
    if (!parsed) {
      this.quotes.delete(id)
      return undefined
    }
    this.quotes.set(id, parsed)
    this.lastMessageAt = this.clock()
    return this.withAge(parsed)
  }

  /** 下单用的参考价（没有缓存 / 陈旧时 stale=true，让 orders.ts 自己决定拒绝；ageMs 供参考价年龄判断）。 */
  refOf(id: string): QuoteRef | undefined {
    const quote = this.quote(id)
    if (!quote) return undefined
    return {
      bid: quote.bid,
      ask: quote.ask,
      mid: (quote.bid + quote.ask) / 2,
      stale: quote.stale === true,
      ...(quote.ageMs !== undefined ? { ageMs: quote.ageMs } : {}),
    }
  }

  book(id: string, depth?: number): Promise<Book> {
    return this.data.book(id, depth)
  }

  candles(id: string, interval: CandleInterval, opts: { n?: number; from?: Ms; to?: Ms } = {}): Promise<Candle[]> {
    return this.data.candles(id, interval, opts)
  }

  context(id: string): Promise<MarketContext> {
    return this.data.context(id)
  }

  subscribe(spec: SubscriptionSpec, cb: (e: VenueEvent) => void): Unsubscribe {
    return this.data.subscribe(spec, cb)
  }

  status(): MarketStatus {
    const base = this.data.status()
    const now = this.clock()
    return {
      ...base,
      environment: this.environment,
      ts: now,
      stale: this.lastMessageAt === 0 || now - this.lastMessageAt > this.staleMs,
      lastMessageTs: this.lastMessageAt,
    }
  }

  /** 测试 / 诊断：喂一条报价（不联网）。 */
  seedQuote(id: string, bid: number, ask: number, ts?: number): void {
    const at = ts ?? this.clock()
    this.quotes.set(id, { instrumentId: id, ts: at, bid, ask, stale: this.clock() - at > this.staleMs, ageMs: Math.max(0, this.clock() - at) })
    this.lastMessageAt = at
  }

  /** 测试 / 诊断：直接栽合约清单（原始 contracts 行，解析仍走数据包）。 */
  seedContracts(rows: unknown, now?: Ms): void {
    const at = now ?? this.clock()
    for (const record of parseInstrumentRecords(rows, at)) this.records.set(record.instrument.instrumentId, record)
    this.lastMessageAt = at
  }

  /** instrumentId → 原生 symbol（未知时按 id 规则解析）。 */
  symbolOf(id: string): string {
    return this.records.get(id)?.symbol ?? symbolOf(id)
  }

  async close(): Promise<void> {
    await this.data.close()
  }
}
