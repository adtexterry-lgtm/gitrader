// SPDX-License-Identifier: CPAL-1.0
// 只读行情：直接复用 packages/connector-bybit-data 的 BybitMarket（公共 REST：合约清单 / K 线 / 报价 / 盘口）。
// Copied from packages/connector-bybit-data/src/market.ts (CPAL-1.0); 本文件只做「同一份 fetch / 时钟 / 预算」的装配，
// 不重复实现行情逻辑，也不改那个包。行情端点与本连接器的私有端点共用 baseUrl 与 fetchImpl，
// 但**公共请求永不携带密钥**（BybitHttp 里就是纯 GET，没有 header）。
import { BybitMarket, unlimitedBudget } from '@gitrader/connector-bybit-data'
import type { Book, Candle, CandleInterval, Instrument, InstrumentId, MarketContext, Ms } from '@gitrader/protocol'
import type { MarketStatus, RateBudget, StampedQuote, SubscriptionSpec, Unsubscribe, VenueEvent } from '@gitrader/protocol/connector'

export interface MarketOptions {
  /** 公共 REST 基址，缺省 https://api.bybit.com（与私有端点同一个 host）。 */
  baseUrl?: string
  fetchImpl?: typeof fetch
  clock?: () => number
  /** 报价轮询间隔，缺省 5000 ms。 */
  pollMs?: number
  /** 行情陈旧阈值（quote 的 stale），缺省 10 s。 */
  staleMs?: number
  httpTimeoutMs?: number
  /** 行情自己的预算对象（Bybit 公共端点按 IP 120 次 / 5 s；缺省不限）。 */
  budget?: RateBudget
}

/** 交易连接器的行情半边：薄封装，行为完全来自数据包。 */
export class BybitTradeMarket {
  readonly data: BybitMarket
  private readonly clock: () => number

  constructor(o: MarketOptions = {}) {
    this.clock = o.clock ?? (() => Date.now())
    this.data = new BybitMarket({
      ...(o.baseUrl !== undefined ? { baseUrl: o.baseUrl } : {}),
      ...(o.fetchImpl !== undefined ? { fetchImpl: o.fetchImpl } : {}),
      ...(o.pollMs !== undefined ? { pollMs: o.pollMs } : {}),
      ...(o.staleMs !== undefined ? { staleMs: o.staleMs } : {}),
      ...(o.httpTimeoutMs !== undefined ? { httpTimeoutMs: o.httpTimeoutMs } : {}),
      budget: o.budget ?? unlimitedBudget(),
      clock: this.clock,
    })
  }

  /** 拉一次合约清单并缓存（连接器 start() 调它）。 */
  start(): Promise<void> {
    return this.data.start()
  }

  close(): Promise<void> {
    return this.data.close()
  }

  listInstruments(opts: { includeDelisted?: boolean } = {}): Instrument[] {
    return this.data.listInstruments(opts)
  }

  getInstrument(id: InstrumentId): Instrument | undefined {
    return this.data.getInstrument(id)
  }

  /** 同步缓存的报价（不联网）；没拉过就 undefined。 */
  quote(id: InstrumentId): StampedQuote | undefined {
    return this.data.quote(id)
  }

  refreshQuote(id: InstrumentId): Promise<StampedQuote | undefined> {
    return this.data.refreshQuote(id)
  }

  book(id: InstrumentId, depth?: number): Promise<Book> {
    return this.data.book(id, depth)
  }

  candles(id: InstrumentId, interval: CandleInterval, opts: { n?: number; from?: Ms; to?: Ms } = {}): Promise<Candle[]> {
    return this.data.candles(id, interval, opts)
  }

  context(id: InstrumentId): Promise<MarketContext> {
    return this.data.context(id)
  }

  subscribe(spec: SubscriptionSpec, cb: (e: VenueEvent) => void): Unsubscribe {
    return this.data.subscribe(spec, cb)
  }

  status(): MarketStatus {
    return this.data.status()
  }

}
