// SPDX-License-Identifier: CPAL-1.0
// 行情：只做下单价带要用的**快照**（工单「最小子集」：行情只做下单价带要用的快照）。
//   · 快照 = reqMktData(snapshot) → tickPrice/tickSize → tickSnapshotEnd；
//   · 无行情权限（IB 354 / 10197）→ 不伪造报价：quote() 返回 undefined，市价意图由上层拒单（八条 3）；
//   · K 线 / L2 / 逐笔都不在本包（返回 5002 CAPABILITY_UNSUPPORTED），不假装支持。
import type { Book, Candle, CandleInterval, MarketContext } from '@gitrader/protocol'
import type { MarketStatus, StampedQuote, SubscriptionSpec, Unsubscribe, VenueEvent } from '@gitrader/protocol/connector'
import { IbError } from './errors'
import type { InstrumentBook } from './contracts'
import { VENUE } from './ids'
import { TICK } from './messages'
import * as M from './messages'
import type { IbSession } from './session'

export interface QuoteSnapshot {
  bid: number
  ask: number
  last: number
  ts: number
}

export interface IbkrMarketOptions {
  session: IbSession
  book: InstrumentBook
  clock?: () => number
  /** 快照的陈旧阈值（ms，缺省 10 s）。 */
  staleMs?: number
  /** 轮询订阅的间隔（ms，缺省 2000）。 */
  pollMs?: number
  snapshotTimeoutMs?: number
  onWarn?: (message: string) => void
}

interface SnapshotAcc {
  bid: number
  ask: number
  last: number
  done: boolean
}

export class IbkrMarket {
  readonly #session: IbSession
  readonly #book: InstrumentBook
  readonly #clock: () => number
  readonly #staleMs: number
  readonly #pollMs: number
  readonly #snapshotTimeoutMs: number
  readonly #onWarn: (message: string) => void
  readonly #quotes = new Map<string, QuoteSnapshot>()
  #lastMessageTs = 0
  #lastMarketErrorCode: number | undefined
  #source: 'ws' | 'rest' | 'none' = 'none'
  readonly #pollers = new Map<string, ReturnType<typeof setInterval>>()

  constructor(o: IbkrMarketOptions) {
    this.#session = o.session
    this.#book = o.book
    this.#clock = o.clock ?? (() => Date.now())
    this.#staleMs = o.staleMs ?? 10_000
    this.#pollMs = o.pollMs ?? 2_000
    this.#snapshotTimeoutMs = o.snapshotTimeoutMs ?? 5_000
    this.#onWarn = o.onWarn ?? (() => {})
    this.#session.on({
      tickPrice: (t) => {
        this.#lastMessageTs = this.#clock()
        const id = this.#tickerIds.get(t.tickerId)
        if (id === undefined) return
        const prev = this.#quotes.get(id) ?? { bid: 0, ask: 0, last: 0, ts: 0 }
        if (t.tickType === TICK.BID) prev.bid = t.price
        else if (t.tickType === TICK.ASK) prev.ask = t.price
        else if (t.tickType === TICK.LAST) prev.last = t.price
        prev.ts = this.#clock()
        this.#quotes.set(id, prev)
      },
      error: (ev) => {
        if (ev.info) return
        if (ev.code === 354 || ev.code === 10197) {
          this.#lastMarketErrorCode = ev.code
          this.#onWarn(`market data unavailable (IB ${String(ev.code)}): ${ev.message}`)
        }
      },
    })
  }

  /** tickerId → instrumentId（快照结束即清理）。 */
  readonly #tickerIds = new Map<number, string>()

  /** 最近一次行情不可用的 IB 码（八条 3：无权限时拒市价意图要能说清原因）。 */
  get lastMarketErrorCode(): number | undefined {
    return this.#lastMarketErrorCode
  }

  /** 拉一次快照（每个标的独立 tickerId）。无权限 / 超时 → undefined（不抛给上层，让拒单路径解释）。 */
  async snapshot(instrumentId: string): Promise<StampedQuote | undefined> {
    const record = this.#book.get(instrumentId)
    if (record === undefined) {
      this.#onWarn(`snapshot skipped for unknown instrument ${instrumentId} (qualify it first)`)
      return undefined
    }
    const id = record.instrument.instrumentId
    const tickerId = this.#session.allocateReqId()
    this.#tickerIds.set(tickerId, id)
    const acc: SnapshotAcc = { bid: 0, ask: 0, last: 0, done: false }
    try {
      await this.#session.request<SnapshotAcc>({
        label: `marketSnapshot(${id})`,
        build: M.reqMarketData(tickerId, record.contractDetails.contract),
        initial: acc,
        timeoutMs: this.#snapshotTimeoutMs,
        matchError: (reqId) => reqId === tickerId,
        onFrame: (fields, a) => {
          const msgId = Number(fields[0])
          if (msgId === M.IN.TICK_PRICE) {
            const tick = M.decodeTickPrice(fields)
            if (tick.tickerId !== tickerId || tick.price === undefined) return false
            const price = Number(tick.price)
            if (tick.tickType === TICK.BID) a.bid = price
            else if (tick.tickType === TICK.ASK) a.ask = price
            else if (tick.tickType === TICK.LAST) a.last = price
            return false
          }
          if (msgId === M.IN.TICK_SIZE) return false
          if (msgId === M.IN.TICK_SNAPSHOT_END) return Number(fields[2] ?? '') === tickerId
          return false
        },
      })
      if (acc.bid <= 0 && acc.ask <= 0 && acc.last <= 0) return undefined
      const snap: QuoteSnapshot = { bid: acc.bid, ask: acc.ask, last: acc.last, ts: this.#clock() }
      this.#quotes.set(id, snap)
      this.#source = 'rest'
      return this.#stamped(id, snap)
    } catch (e) {
      if (e instanceof IbError) this.#onWarn(`snapshot failed for ${id}: ${e.message}`)
      return undefined
    } finally {
      this.#tickerIds.delete(tickerId)
    }
  }

  #stamped(id: string, snap: QuoteSnapshot): StampedQuote {
    const ageMs = Math.max(0, this.#clock() - snap.ts)
    const mid = snap.bid > 0 && snap.ask > 0 ? (snap.bid + snap.ask) / 2 : snap.last
    return {
      instrumentId: id,
      ts: snap.ts,
      bid: snap.bid,
      ask: snap.ask,
      last: snap.last > 0 ? snap.last : mid,
      stale: ageMs > this.#staleMs,
      ageMs,
    }
  }

  /** 同步读缓存（不联网）；缺失返回 undefined。 */
  quote(instrumentId: string): StampedQuote | undefined {
    const id = this.#book.get(instrumentId)?.instrument.instrumentId ?? instrumentId
    const snap = this.#quotes.get(id)
    if (snap === undefined) return undefined
    return this.#stamped(id, snap)
  }

  async refreshQuote(instrumentId: string): Promise<StampedQuote | undefined> {
    return this.snapshot(instrumentId)
  }

  /** 参考价（价带用）：优先 mid，其次 last；无 → undefined。 */
  referencePrice(instrumentId: string): number | undefined {
    const q = this.quote(instrumentId)
    if (q === undefined) return undefined
    if (q.bid > 0 && q.ask > 0) return (q.bid + q.ask) / 2
    return q.last !== undefined && q.last > 0 ? q.last : undefined
  }

  context(instrumentId: string): Promise<MarketContext> {
    const q = this.quote(instrumentId)
    if (q === undefined) {
      return Promise.reject(
        IbError.of('DATA_UNAVAILABLE', `no quote snapshot for ${instrumentId}`, '先 refreshQuote(id) 拉一次快照；无行情权限时本包不伪造价格'),
      )
    }
    const mid = q.bid > 0 && q.ask > 0 ? (q.bid + q.ask) / 2 : q.last
    return Promise.resolve({
      instrumentId: q.instrumentId,
      ts: q.ts,
      markPrice: mid ?? 0,
      ...(mid !== undefined ? { midPrice: mid } : {}),
      ...(q.last !== undefined ? { prevDayPrice: q.last } : {}),
    } as MarketContext)
  }

  /** K 线不在最小子集里：明说 5002，不回假数据。 */
  candles(instrumentId: string, _interval: CandleInterval): Promise<Candle[]> {
    return Promise.reject(
      IbError.of(
        'CAPABILITY_UNSUPPORTED',
        `IBKR trade connector does not provide candles (${instrumentId})`,
        'K 线请用只读行情连接器；本包只做下单需要的快照价格',
      ),
    )
  }

  book(instrumentId: string): Promise<Book> {
    return Promise.reject(
      IbError.of('CAPABILITY_UNSUPPORTED', `IBKR trade connector does not provide L2 books (${instrumentId})`, '本包只做快照报价，不下发深层行情请求'),
    )
  }

  status(): MarketStatus {
    const now = this.#clock()
    return {
      venue: VENUE,
      environment: this.#session.environment,
      ts: now,
      wsState: this.#session.connected ? 'connected' : 'disconnected',
      stale: this.#lastMessageTs === 0 ? true : now - this.#lastMessageTs > this.#staleMs * 3,
      source: this.#source,
      lastMessageTs: this.#lastMessageTs,
    }
  }

  /** 只支持 quote 订阅（轮询快照）；其余通道不假装支持。 */
  subscribe(spec: SubscriptionSpec, cb: (e: VenueEvent) => void): Unsubscribe {
    if (spec.channel !== 'quote') {
      this.#onWarn(`subscription channel ${spec.channel} is not supported by the IBKR trade connector`)
      return () => {}
    }
    const id = spec.instrumentId
    const existing = this.#pollers.get(id)
    if (existing !== undefined) clearInterval(existing)
    const timer = setInterval(() => {
      void this.snapshot(id).then((q) => {
        if (q !== undefined) cb({ channel: 'quote', quote: q })
      })
    }, this.#pollMs)
    timer.unref?.()
    this.#pollers.set(id, timer)
    return () => {
      const t = this.#pollers.get(id)
      if (t !== undefined) clearInterval(t)
      this.#pollers.delete(id)
    }
  }

  close(): void {
    for (const timer of this.#pollers.values()) clearInterval(timer)
    this.#pollers.clear()
  }
}
