// SPDX-License-Identifier: CPAL-1.0
// 回放模式：按时间戳重放夹具（fixtures/hl/replay/*.json），给 PaperVenue 当行情源。
// 时钟由回放驱动（clock()），不读真实时间——同一份夹具、同一串指令，结果逐位一致。
import type { Book, Candle, CandleInterval, Instrument, InstrumentId, MarketContext, Ms, VenueCapabilities, VenueId } from '@gitrader/protocol'
import type { MarketStatus, StampedQuote, SubscriptionSpec, Unsubscribe, VenueEvent } from '@gitrader/protocol/connector'
import type { PaperMarket } from './types'
import type { PaperVenue } from './venue'

export interface ReplayFrame {
  ts: number
  marks: Record<InstrumentId, number>
  funding?: Record<InstrumentId, number>
  /** [价格, 数量]，bids 降序、asks 升序。 */
  books: Record<InstrumentId, { bids: Array<[number, number]>; asks: Array<[number, number]> }>
}
export interface ReplayFixture { instrument: InstrumentId; interval: string; source: string; frames: ReplayFrame[] }

export class ReplayMarket implements PaperMarket {
  readonly venue: VenueId
  readonly environment = 'mainnet' as const
  private i = 0
  constructor(private readonly instruments: Instrument[], readonly frames: ReplayFrame[], private readonly capabilities: VenueCapabilities, venue: VenueId = 'hyperliquid') {
    if (frames.length === 0) throw new Error('replay fixture has no frames')
    this.venue = venue
  }

  /** 当前回放时间（喂给 PaperVenue 的 clock）。 */
  now(): number { return this.frames[this.i]!.ts }
  get position(): number { return this.i }
  /** 推进到第 i 帧。 */
  seek(i: number): void { this.i = Math.max(0, Math.min(this.frames.length - 1, i)) }
  private frame(): ReplayFrame { return this.frames[this.i]! }

  describe(): VenueCapabilities { return this.capabilities }
  listInstruments(): Instrument[] { return this.instruments }
  getInstrument(id: InstrumentId): Instrument | undefined { return this.instruments.find((x) => x.instrumentId === id) }
  quote(id: InstrumentId): StampedQuote | undefined {
    const f = this.frame()
    const b = f.books[id]
    const mark = f.marks[id]
    if (!b && mark === undefined) return undefined
    const bid = b?.bids[0]?.[0] ?? mark!
    const ask = b?.asks[0]?.[0] ?? mark!
    return { instrumentId: id, ts: f.ts, bid, ask, last: mark ?? (bid + ask) / 2, stale: false, ageMs: 0 }
  }
  async book(id: InstrumentId, depth = 20): Promise<Book> {
    const f = this.frame()
    const b = f.books[id]
    if (!b) throw new Error(`no replay book for ${id}`)
    return {
      instrumentId: id, ts: f.ts,
      bids: b.bids.slice(0, depth).map(([price, size]) => ({ price, size })),
      asks: b.asks.slice(0, depth).map(([price, size]) => ({ price, size })),
    }
  }
  async candles(_id: InstrumentId, _interval: CandleInterval, _opts?: { n?: number; from?: Ms; to?: Ms }): Promise<Candle[]> { return [] }
  async context(id: InstrumentId): Promise<MarketContext> {
    const f = this.frame()
    const mark = f.marks[id]
    if (mark === undefined) throw new Error(`no replay mark for ${id}`)
    return { instrumentId: id, ts: f.ts, markPrice: mark, midPrice: mark, ...(f.funding?.[id] !== undefined ? { fundingRate: f.funding[id]! } : {}), fundingIntervalMs: 3_600_000 }
  }
  subscribe(_spec: SubscriptionSpec, _cb: (e: VenueEvent) => void): Unsubscribe { return () => {} }
  status(): MarketStatus {
    return { venue: this.venue, environment: 'mainnet', ts: this.now(), wsState: 'connected', stale: false, source: 'ws', lastMessageTs: this.now() }
  }
}

/** 逐帧推进并 tick。onFrame 可在每帧开头插入指令（下单 / 撤单），返回后再 tick。 */
export async function runReplay(venue: PaperVenue, market: ReplayMarket, opts: { from?: number; onFrame?: (i: number, ts: number) => void | Promise<void> } = {}): Promise<void> {
  for (let i = opts.from ?? 0; i < market.frames.length; i++) {
    market.seek(i)
    await opts.onFrame?.(i, market.now())
    await venue.tick()
  }
}
