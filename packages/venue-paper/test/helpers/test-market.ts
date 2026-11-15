// SPDX-License-Identifier: CPAL-1.0
// 可手动摆布的行情源：测试里直接改盘口 / 价格 / 资金费，再推进时钟。
import type { Book, Candle, Instrument, InstrumentId, MarketContext, VenueCapabilities } from '@gitrader/protocol'
import type { MarketStatus, StampedQuote, TradeContext } from '@gitrader/protocol/connector'
import type { OrderIntent } from '@gitrader/protocol'
import type { PaperMarket } from '../../src/types'

export const BTC = 'hyperliquid:BTC'
export const ETH = 'hyperliquid:ETH'

export function inst(symbol: string, szDecimals: number, maxLeverage: number): Instrument {
  const step = szDecimals <= 0 ? '1' : `0.${'0'.repeat(szDecimals - 1)}1`
  return {
    instrumentId: `hyperliquid:${symbol}`, venue: 'hyperliquid', symbol, displaySymbol: `${symbol}-PERP`, kind: 'perp', base: symbol, quote: 'USDC', settle: 'USDC',
    settlement: 'linear', contractSize: '1', venueSizeUnit: 'base', assetClass: 'crypto', marketGroup: null, status: 'trading',
    price: { sigFigs: 5, maxDecimals: Math.max(6 - szDecimals, 0) }, size: { step, decimals: szDecimals, min: step }, minNotional: '10', maxLeverage,
    marginModes: ['cross'], orderTypes: ['market', 'limit', 'stop_market', 'stop_limit', 'take_market', 'take_limit'], tif: ['gtc', 'ioc', 'alo'], triggerPriceTypes: ['mark'],
    fundingIntervalMs: 3_600_000, fees: { maker: '0.00015', taker: '0.00045', source: 'assumed' }, updatedAt: 0,
  } as unknown as Instrument
}

export const caps = { venue: 'hyperliquid', environments: ['mainnet'], instrumentKinds: ['perp'], orderTypes: { market: 'emulated', limit: 'native' }, tif: ['gtc', 'ioc', 'alo'], triggerPriceTypes: ['mark'], deadman: { method: 'schedule_cancel', minDelaySec: 5, maxTriggersPerDay: 10 }, signers: { type: 'api-wallet', withdrawCapable: false } } as unknown as VenueCapabilities

export class TestMarket implements PaperMarket {
  readonly venue = 'hyperliquid'
  readonly environment = 'mainnet' as const
  now = 1_791_483_000_000
  quoteTs: Record<string, number> = { [BTC]: this.now, [ETH]: this.now }
  instruments = [inst('BTC', 5, 40), inst('ETH', 4, 25)]
  mark: Record<string, number> = { [BTC]: 80000.5, [ETH]: 3500.5 }
  books: Record<string, { bids: Array<[number, number]>; asks: Array<[number, number]> }> = {
    [BTC]: { bids: [[80000, 1], [79999, 2], [79990, 5]], asks: [[80001, 1], [80002, 2], [80010, 5]] },
    [ETH]: { bids: [[3500, 10], [3499, 20]], asks: [[3501, 10], [3502, 20]] },
  }
  funding: Record<string, number> = { [BTC]: 0, [ETH]: 0 }
  noBook = new Set<string>()
  /** 快照模式（useSnapshots）下每个标的快照的最后更新时刻，并统计 REST 盘口调用。 */
  snapshotAsOf: Record<string, number> = {}
  staleAfterMs = 15_000
  refreshWorks = true
  restBookCalls = 0
  refreshCalls = 0
  subscribed: string[] = []
  quoteSubscribed: string[] = []
  quoteUnsubscribed: string[] = []
  failSubscribeChannels = new Set<string>()
  stale = new Set<string>()

  describe() { return caps }
  listInstruments() { return this.instruments }
  getInstrument(id: InstrumentId) { return this.instruments.find((i) => i.instrumentId === id) }
  quote(id: InstrumentId): StampedQuote | undefined {
    const b = this.books[id]
    const ts = this.quoteTs[id]
    if (!b || ts === undefined) return undefined
    const mk = this.mark[id]!
    return { instrumentId: id, ts, bid: b.bids[0]?.[0] ?? mk, ask: b.asks[0]?.[0] ?? mk, last: mk, stale: this.stale.has(id), ageMs: Math.max(0, this.now - ts) }
  }
  async book(id: InstrumentId, depth = 20): Promise<Book> {
    this.restBookCalls += 1
    const b = this.books[id]
    if (!b || this.noBook.has(id)) throw new Error('no book')
    return this.toBook(id, b, depth)
  }
  bookSnapshot?: (id: InstrumentId) => { book: Book; asOf: number; stale: boolean } | undefined
  refreshBook?: (id: InstrumentId) => Promise<{ book: Book; asOf: number; stale: boolean } | undefined>
  /** 打开快照模式：之后 PaperVenue 只读本地快照，REST 盘口只在快照缺失 / 陈旧时兜底。 */
  useSnapshots(): this {
    const at0 = this.now
    for (const id of Object.keys(this.books)) this.snapshotAsOf[id] = at0
    this.bookSnapshot = (id) => {
      const b = this.books[id]
      const at = this.snapshotAsOf[id]
      if (!b || at === undefined) return undefined
      return { book: this.toBook(id, b, 20), asOf: at, stale: this.now - at > this.staleAfterMs }
    }
    this.refreshBook = async (id) => {
      this.refreshCalls += 1
      if (this.refreshWorks && this.books[id]) this.snapshotAsOf[id] = this.now
      return this.bookSnapshot!(id)
    }
    return this
  }
  private toBook(id: InstrumentId, b: { bids: Array<[number, number]>; asks: Array<[number, number]> }, depth: number): Book {
    return { instrumentId: id, ts: this.now, bids: b.bids.slice(0, depth).map(([price, size]) => ({ price, size })), asks: b.asks.slice(0, depth).map(([price, size]) => ({ price, size })) }
  }
  async candles(): Promise<Candle[]> { return [] }
  async context(id: InstrumentId): Promise<MarketContext> {
    return { instrumentId: id, ts: this.now, markPrice: this.mark[id]!, fundingRate: this.funding[id] ?? 0, fundingIntervalMs: 3_600_000 }
  }
  subscribe(spec: { channel: string; instrumentId?: string }) {
    if (this.failSubscribeChannels.has(spec.channel)) throw new Error('subscription unavailable')
    if (spec.channel === 'book' && spec.instrumentId) this.subscribed.push(spec.instrumentId)
    if (spec.channel === 'quote' && spec.instrumentId) this.quoteSubscribed.push(spec.instrumentId)
    let active = true
    return () => {
      if (!active) return
      active = false
      if (spec.channel === 'quote' && spec.instrumentId) this.quoteUnsubscribed.push(spec.instrumentId)
    }
  }
  status(): MarketStatus { return { venue: 'hyperliquid', environment: 'mainnet', ts: this.now, wsState: 'connected', stale: false, source: 'ws', lastMessageTs: this.now } }
  /** 同时挪动标记价和盘口（价差 1，一档 1000 个）。 */
  setPrice(id: InstrumentId, px: number) {
    this.mark[id] = px
    this.books[id] = { bids: [[px - 0.5, 1000]], asks: [[px + 0.5, 1000]] }
    this.quoteTs[id] = this.now
  }
}

export const ctx = (accountId: string): TradeContext => ({ account: { accountId, address: '0x2222222222222222222222222222222222222222' }, signer: { address: '0x1111111111111111111111111111111111111111', signTypedData: async () => { throw new Error('paper never signs') } } } as unknown as TradeContext)
export const intent = (accountId: string, over: Record<string, unknown> = {}): OrderIntent => ({
  accountId, instrumentId: BTC, side: 'buy', type: 'limit', size: '1', price: '80000', ...over,
}) as unknown as OrderIntent
