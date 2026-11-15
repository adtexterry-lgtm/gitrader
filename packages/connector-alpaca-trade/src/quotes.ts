// SPDX-License-Identifier: CPAL-1.0
// 参考价来源（市价意图的价带基准，美股八条第 3 条）。
// 端点出处：数据 API v2 `GET /v2/stocks/{symbol}/snapshot?feed=iex`（官方 Market Data API；
//   Alpaca 免费档默认只有 IEX 源，所以 feed 缺省 iex、可配）。QD 没有这一层（它只在 UI 里查报价），
//   所以「拿不到参考价就不发裸市价」这条完全由本连接器把关。
// 没有参考价（无行情权限 / 标的无报价 / 报价陈旧）→ 返回 undefined，由 orders.ts 拒单（STALE_PRICE + hint）。
import type { Ms } from '@gitrader/protocol'
import { DEFAULT_REF_PRICE_MAX_AGE_MS } from './constants'
import type { PriceRef } from './orders'
import type { AlpacaHttp } from './rest'

export interface QuoteSource {
  /** 最新二元报价；拿不到就 undefined（不编价格）。 */
  latest(symbol: string, opts?: { signal?: AbortSignal }): Promise<PriceRef | undefined>
}

export interface AlpacaQuoteOptions {
  /** 数据源：免费档 iex；有全市场权限时可配 sip。 */
  feed?: 'iex' | 'sip' | 'delayed_sip' | 'otc'
  /** 参考价最大年龄（毫秒）；超过就当陈旧（orders.ts 也会再判一次）。 */
  maxAgeMs?: number
  clock?: () => number
}

/** 官方 snapshot 响应里与本连接器有关的部分。 */
interface SnapshotRow {
  latestQuote?: { t?: string; ap?: number; bp?: number; as?: number; bs?: number }
  latestTrade?: { t?: string; p?: number; s?: number }
  latestBar?: { t?: string; c?: number }
}

export class AlpacaQuotes implements QuoteSource {
  readonly #feed: string
  readonly #maxAgeMs: number
  readonly #clock: () => number
  /** 最近一次拿到的报价（诊断 / 同步 quote() 用）。 */
  readonly #last = new Map<string, PriceRef & { ts: Ms }>()

  constructor(private readonly http: AlpacaHttp, opts: AlpacaQuoteOptions = {}) {
    this.#feed = opts.feed ?? 'iex'
    this.#maxAgeMs = opts.maxAgeMs ?? DEFAULT_REF_PRICE_MAX_AGE_MS
    this.#clock = opts.clock ?? (() => Date.now())
  }

  /** 同步读上次报价（stale / ageMs 现算；没有就 undefined）。 */
  cached(symbol: string): PriceRef | undefined {
    const hit = this.#last.get(symbol.toUpperCase())
    if (hit === undefined) return undefined
    const ageMs = Math.max(0, this.#clock() - hit.ts)
    return { ...hit, ageMs, stale: ageMs > this.#maxAgeMs }
  }

  async latest(symbol: string, opts: { signal?: AbortSignal } = {}): Promise<PriceRef | undefined> {
    const upper = symbol.trim().toUpperCase()
    const path = `/v2/stocks/${encodeURIComponent(upper)}/snapshot`
    let payload: SnapshotRow
    try {
      payload = await this.http.dataGet<SnapshotRow>(path, { feed: this.#feed }, { ...(opts.signal ? { signal: opts.signal } : {}) })
    } catch {
      // 行情权限缺失 / 主机不可达：不抛（报价不是交易路径的硬依赖），由调用方按「没有参考价」拒单。
      return undefined
    }
    const quote = payload?.latestQuote
    const trade = payload?.latestTrade
    const ap = quote?.ap !== undefined && quote.ap > 0 ? quote.ap : undefined
    const bp = quote?.bp !== undefined && quote.bp > 0 ? quote.bp : undefined
    const last = trade?.p !== undefined && trade.p > 0 ? trade.p : undefined
    const mid = ap !== undefined && bp !== undefined ? (ap + bp) / 2 : last
    if (ap === undefined && bp === undefined && last === undefined) return undefined
    const stampText = quote?.t ?? trade?.t
    const stamp = stampText === undefined ? this.#clock() : Date.parse(stampText)
    const ts = Number.isFinite(stamp) ? stamp : this.#clock()
    const ageMs = Math.max(0, this.#clock() - ts)
    const ref: PriceRef & { ts: Ms } = {
      ...(ap !== undefined ? { bid: bp, ask: ap } : {}),
      ...(mid !== undefined ? { mid } : {}),
      ...(last !== undefined ? { source: 'alpaca_snapshot' } : { source: 'alpaca_trade' }),
      ts,
      ageMs,
      stale: ageMs > this.#maxAgeMs,
    }
    this.#last.set(upper, ref)
    return { ...ref }
  }
}
