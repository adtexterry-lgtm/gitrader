// SPDX-License-Identifier: CPAL-1.0
// 最小内存假连接器（实现 protocol 的 VenueConnector）：既当内核模拟场所（kernel-sim），也当"实盘场所"（hyperliquid，声明 deadman 能力）。
// 市价单按标记价立即成交；成交事件在 submit 返回之前就推出去（模拟场所用 onEvent / PaperEvent，实盘用 userFills），覆盖"成交先于回执"的路径。
// 真正的模拟场所 / HL 连接器由 C 提供；内核测试只依赖这个。
import type {
  AccountRef, AccountSnapshot, AmendRequest, CancelAck, CancelTarget, MarketStatus, OrderAck, StampedQuote, StartupSnapshot, SubmitResult, SubscriptionSpec,
  TradeContext, Unsubscribe, VenueConnector, VenueEvent, VenueFill, VenueOpenOrder, VenueOrderStatus,
} from '@gitrader/protocol/connector'
import type { Book, Candle, CandleInterval, Instrument, MarketContext, OrderIntent, Position, VenueCapabilities } from '../../src/proto'
import * as d from '../../src/util/dec'
import type { Clock } from '../../src/util/clock'

export const BTC = 'hyperliquid:BTC'
export const ETH = 'hyperliquid:ETH'
export const LIVE_ADDR = `0x${'ab'.repeat(20)}`
const ZERO_ADDR = `0x${'0'.repeat(40)}`

const inst = (symbol: string, szDecimals: number, maxLev: number): Instrument => ({
  instrumentId: `hyperliquid:${symbol}`, venue: 'hyperliquid', symbol, displaySymbol: symbol, kind: 'perp', base: symbol, quote: 'USDC', settle: 'USDC', settlement: 'linear',
  contractSize: '1' as never, venueSizeUnit: 'base', assetClass: 'crypto', status: 'trading',
  price: { sigFigs: 5, maxDecimals: 6 - szDecimals }, size: { step: d.str(d.div(d.ONE, d.D(10 ** szDecimals))), decimals: szDecimals, min: d.str(d.div(d.ONE, d.D(10 ** szDecimals))) },
  minNotional: '10' as never, maxLeverage: maxLev, marginModes: ['cross', 'isolated'],
  orderTypes: ['market', 'limit', 'stop_market', 'stop_limit', 'take_market', 'take_limit', 'trailing_stop', 'twap'], tif: ['gtc', 'ioc', 'alo'], triggerPriceTypes: ['mark'],
  fundingIntervalMs: 3_600_000, fees: { maker: '0.00015' as never, taker: '0.00045' as never, source: 'assumed' }, updatedAt: 0,
})

export interface FakeOpts { id: 'kernel-sim' | 'hyperliquid'; clock: Clock; initialEquity?: string; onSubmit?: (intents: OrderIntent[], ctx: TradeContext) => void; accountSnapshotOverrides?: Partial<AccountSnapshot> }

interface FakeOrder { venueOrderId: string; clientOrderId: string; accountId: string; instrumentId: string; side: 'buy' | 'sell'; type: string; size: string; price: string | null; reduceOnly: boolean; isTrigger: boolean; status: 'open' | 'cancelled' | 'filled'; createdAt: number }

export class FakeConnector implements VenueConnector {
  readonly venue: string
  readonly environment = 'testnet' as const
  readonly submitted: { ctx: TradeContext; intent: OrderIntent; signed: boolean }[] = []
  readonly cancelCalls: CancelTarget[][] = []
  readonly cancelContexts: TradeContext[] = []
  readonly cancelGateCalls: (TradeContext['gate'] | undefined)[] = []
  readonly cancelAllCalls: { instrumentId?: string }[] = []
  readonly cancelAllContexts: TradeContext[] = []
  readonly cancelAllGateCalls: (TradeContext['gate'] | undefined)[] = []
  readonly scheduleCalls: { atMs: number | null; signed: boolean }[] = []
  readonly scheduleGateCalls: { atMs: number | null; signed: boolean; ctxGate?: TradeContext['gate'] }[] = []
  readonly leverageCalls: { ctx: TradeContext; instrumentId: string; leverage: number; marginMode: 'cross' | 'isolated' }[] = []
  readonly amendCalls: { ctx: TradeContext; req: AmendRequest }[] = []
  readonly signatures: string[] = []
  marks = new Map<string, string>([[BTC, '80000'], [ETH, '2400']])
  frozenMarkTs: number | null = null
  equity: d.Dec
  positions = new Map<string, Position[]>()
  orders: FakeOrder[] = []
  /** 下一次 submit 的脚本：'unknown' = 超时无回应；'reject' = 场所拒绝。 */
  script: ('unknown' | 'reject' | 'ok')[] = []
  /** orderStatus 在 'unknown' 之后能否查到。 */
  queryFinds = false
  accountStateCalls = 0
  openOrdersCalls = 0
  startupSnapshotCalls = 0
  orderStatusCalls = 0
  accountSnapshotOverrides?: Partial<AccountSnapshot>
  /** Cached view may be empty while a controlled startup response exposes the remote view. */
  openOrdersOverride?: VenueOpenOrder[]
  startupResponseSequence?: Array<StartupSnapshot | 'hang' | Error>
  /** 平仓是否立刻成交（false = 模拟平不掉，测试重试）。 */
  closeFills = true
  reconcileResult: StartupSnapshot['openOrders'] | 'hang' | 'actual' | Error = 'actual'
  private subs = new Set<{ spec: SubscriptionSpec; cb: (e: VenueEvent) => void }>()
  private paperListeners = new Set<(e: unknown) => void>()
  private n = 0
  readonly instrumentsList = [inst('BTC', 5, 40), inst('ETH', 4, 25)]

  constructor(private o: FakeOpts) {
    this.venue = o.id
    this.equity = d.D(o.initialEquity ?? '10000')
    this.accountSnapshotOverrides = o.accountSnapshotOverrides
  }

  describe(): VenueCapabilities {
    return {
      venue: 'hyperliquid', environments: ['mainnet', 'testnet'], instrumentKinds: ['perp'], orderTypes: { market: 'emulated', limit: 'native' }, tif: ['gtc', 'ioc', 'alo'], triggerPriceTypes: ['mark'],
      ...(this.o.id === 'hyperliquid' ? { deadman: { method: 'schedule_cancel', minDelaySec: 5, maxTriggersPerDay: 10 }, rateLimits: [{ scope: 'ip', model: 'weight', limit: 1200, windowMs: 60_000 }] } : {}),
    } as VenueCapabilities
  }
  listInstruments(): Instrument[] { return this.instrumentsList }
  getInstrument(id: string): Instrument | undefined { return this.instrumentsList.find((i) => i.instrumentId === id) }
  quote(id: string): StampedQuote | undefined {
    const p = this.marks.get(id)
    if (!p) return undefined
    const px = Number(p)
    return { instrumentId: id, ts: this.frozenMarkTs ?? this.o.clock.now(), bid: px, ask: px, last: px, stale: false, ageMs: 0 }
  }
  setMark(id: string, p: string): void { this.marks.set(id, p) }
  async book(id: string): Promise<Book> { return { instrumentId: id, ts: this.o.clock.now(), bids: [], asks: [] } }
  /** 夹具 K 线（按标的）。history 按 from/to/n 切。 */
  candleData = new Map<string, Candle[]>()
  async candles(id: string, _i: CandleInterval, o: { n?: number; from?: number; to?: number } = {}): Promise<Candle[]> {
    let cs = this.candleData.get(id) ?? []
    if (o.from !== undefined) cs = cs.filter((c) => c.t >= o.from!)
    if (o.to !== undefined) cs = cs.filter((c) => c.t <= o.to!)
    return o.n !== undefined ? cs.slice(-o.n) : cs
  }
  async context(id: string): Promise<MarketContext> { return { instrumentId: id, ts: this.frozenMarkTs ?? this.o.clock.now(), markPrice: Number(this.marks.get(id) ?? 0) } }
  subscribe(spec: SubscriptionSpec, cb: (e: VenueEvent) => void): Unsubscribe { const s = { spec, cb }; this.subs.add(s); return () => { this.subs.delete(s) } }
  status(): MarketStatus { return { venue: 'hyperliquid', environment: 'testnet', ts: this.o.clock.now(), wsState: 'connected', stale: false, source: 'ws', lastMessageTs: this.o.clock.now() } }
  /** 模拟场所风格的事件出口（内核总线对 kernel-sim 用它订阅成交 / 订单更新）。 */
  onEvent(cb: (e: unknown) => void): Unsubscribe { this.paperListeners.add(cb); return () => { this.paperListeners.delete(cb) } }
  createAccount(): void { /* 假场所不需要 */ }
  hasAccount(): boolean { return true }

  private posOf(accountId: string): Position[] { return this.positions.get(accountId) ?? [] }

  async accountState(ref: AccountRef): Promise<AccountSnapshot> {
    this.accountStateCalls++
    const ps = this.posOf(ref.accountId).map((p) => ({ ...p, markPrice: (this.marks.get(p.instrumentId) ?? p.markPrice) as never, notional: d.str(d.mul(d.D(p.size), d.D(this.marks.get(p.instrumentId) ?? p.markPrice))) as never }))
    const ts = this.o.clock.now()
    const openOrders = await this.openOrders(ref)
    const aggregates = new Map<string, { instrumentId: string; side: 'buy' | 'sell'; notional: string; count: number }>()
    for (const order of openOrders) {
      if (order.reduceOnly) continue
      const instrument = this.getInstrument(order.instrumentId)
      const price = order.price ?? (this.marks.get(order.instrumentId) as never)
      if (!instrument || price === null || price === undefined) continue
      const notional = d.mul(d.mul(d.D(order.size), d.D(price)), d.D(instrument.contractSize))
      const key = `${order.instrumentId}\u0000${order.side}`
      const prior = aggregates.get(key)
      aggregates.set(key, { instrumentId: order.instrumentId, side: order.side, notional: d.str(prior ? d.add(d.D(prior.notional), notional) : notional), count: (prior?.count ?? 0) + 1 })
    }
    const stopLossOrderIds = this.orders.filter((order) => order.accountId === ref.accountId && order.status === 'open' && (order.type === 'stop_market' || order.type === 'stop_limit')).map((order) => order.venueOrderId)
    return {
      accountModel: 'standard', balances: [], ts, positions: ps,
      margin: { accountId: ref.accountId, model: 'standard', valuationCcy: 'USDC', equity: d.str(this.equity), initialMargin: '0' as never, maintenanceMargin: '0' as never, available: d.str(this.equity), marginRatio: '0' as never, leverage: 1, ts },
      asOf: ts, confirmedAt: this.o.clock.now(), stale: false, availableDeductsOpenOrders: false,
      openOrders: [...aggregates.values()] as NonNullable<AccountSnapshot['openOrders']>, stopLossOrderIds,
      ...this.accountSnapshotOverrides,
    }
  }
  async openOrders(ref: AccountRef): Promise<VenueOpenOrder[]> {
    this.openOrdersCalls++
    if (this.openOrdersOverride !== undefined) return structuredClone(this.openOrdersOverride)
    return this.orders.filter((o) => o.accountId === ref.accountId && o.status === 'open').map((o) => ({
      instrumentId: o.instrumentId, venueOrderId: o.venueOrderId, clientOrderId: o.clientOrderId, side: o.side,
      type: (['limit', 'stop_market', 'stop_limit', 'take_market', 'take_limit'].includes(o.type) ? o.type : 'unknown') as VenueOpenOrder['type'], price: o.price as never, triggerPrice: null,
      size: o.size as never, origSize: o.size as never, reduceOnly: o.reduceOnly, isTrigger: o.isTrigger, createdAt: o.createdAt,
    }))
  }
  async fills(): Promise<VenueFill[]> { return [] }
  async orderStatus(ref: AccountRef, key: { clientOrderId?: string; venueOrderId?: string }): Promise<VenueOrderStatus> {
    this.orderStatusCalls++
    const known = this.orders.find((o) => o.accountId === ref.accountId && (key.venueOrderId ? o.venueOrderId === key.venueOrderId : o.clientOrderId === key.clientOrderId))
    if (known?.status === 'cancelled') return { found: true, status: known.status, venueOrderId: known.venueOrderId, filledSize: '0' as never }
    if (!this.queryFinds) return { found: false }
    const s = this.submitted.find((x) => x.intent.clientOrderId === key.clientOrderId)
    return s ? { found: true, status: 'open', venueOrderId: 'vo-found' } : { found: false }
  }
  async startupSnapshot(ref: AccountRef, since: number): Promise<StartupSnapshot> {
    this.startupSnapshotCalls++
    const sequence = this.startupResponseSequence
    if (sequence?.length) {
      const response = sequence[Math.min(this.startupSnapshotCalls - 1, sequence.length - 1)]!
      if (response === 'hang') return new Promise(() => undefined)
      if (response instanceof Error) throw response
      return structuredClone(response)
    }
    const r = this.reconcileResult
    if (r === 'hang') return new Promise(() => undefined)
    if (r instanceof Error) throw r
    const account = await this.accountState(ref)
    return { account, openOrders: r === 'actual' ? await this.openOrders(ref) : r, fills: [], fillsSince: since, truncated: false }
  }

  private emitFill(ref: AccountRef, f: VenueFill & { orderId: string }): void {
    const { orderId: _o, ...vf } = f
    for (const s of this.subs) if (s.spec.channel === 'userFills' && s.spec.address === ref.address) s.cb({ channel: 'userFills', address: ref.address, fills: [vf as VenueFill], isSnapshot: false })
    for (const l of this.paperListeners) l({ kind: 'fill', accountId: ref.accountId, venueOrderId: f.venueOrderId, fillId: f.venueFillId, instrumentId: f.instrumentId, side: f.side, price: f.price, size: f.size, fee: f.fee, liquidity: f.liquidity, realizedPnl: f.realizedPnl, liquidation: false, ts: f.ts })
  }

  async submit(ctx: TradeContext, intents: OrderIntent[]): Promise<SubmitResult> {
    this.o.onSubmit?.(intents, ctx)
    const acks: OrderAck[] = []
    for (const [idx, i] of intents.entries()) {
      const signed = ctx.signer.address !== ZERO_ADDR
      this.submitted.push({ ctx, intent: i, signed })
      if (signed) this.signatures.push(await ctx.signer.signTypedData({ domain: { name: 'Exchange', version: '1', chainId: 1337, verifyingContract: ZERO_ADDR as never }, types: { Agent: [{ name: 'source', type: 'string' }, { name: 'connectionId', type: 'bytes32' }] }, primaryType: 'Agent', message: { source: 'a', connectionId: '0x' + '11'.repeat(32) } }))
      const cloid = i.clientOrderId as string
      const step = this.script.shift() ?? 'ok'
      if (step === 'unknown') { acks.push({ intentIndex: idx, clientOrderId: cloid, venueOrderId: null, status: 'unknown', filledSize: '0' as never, avgFillPrice: null, builder: { attached: false }, problem: { code: 3006, name: 'VENUE_OUTCOME_UNKNOWN', category: 'VENUE', message: 'timeout', retryable: false } }); continue }
      if (step === 'reject') { acks.push({ intentIndex: idx, clientOrderId: cloid, venueOrderId: null, status: 'rejected', filledSize: '0' as never, avgFillPrice: null, builder: { attached: false }, problem: { code: 3001, name: 'VENUE_REJECTED', category: 'VENUE', message: 'rejected', retryable: false, venue: { id: 'hyperliquid', message: 'Order has invalid size.' } } }); continue }
      const mark = d.D(this.marks.get(i.instrumentId) ?? '0')
      const vo = `vo-${++this.n}`
      if (i.type === 'market' && (!i.reduceOnly || this.closeFills)) {
        const px = i.price ? d.D(i.price) : mark
        const fee = d.str(d.mul(d.mul(d.D(i.size!), px), d.D('0.00045')))
        this.applyPosition(ctx.account.accountId, i.instrumentId, i.side, d.D(i.size!), px, i.leverage ?? 1)
        // 成交事件先于回执
        this.emitFill(ctx.account, { orderId: vo, venueOrderId: vo, clientOrderId: cloid, venueFillId: `vf-${vo}`, instrumentId: i.instrumentId, side: i.side, price: d.str(px), size: i.size!, fee: fee as never, feeCcy: 'USDC', liquidity: 'taker', realizedPnl: '0' as never, ts: this.o.clock.now() } as VenueFill & { orderId: string })
        acks.push({ intentIndex: idx, clientOrderId: cloid, venueOrderId: vo, status: 'filled', filledSize: i.size!, avgFillPrice: d.str(px) as never, builder: { attached: false } })
      } else {
        const isTrigger = ['stop_market', 'stop_limit', 'take_market', 'take_limit', 'trailing_stop'].includes(i.type)
        this.orders.push({ venueOrderId: vo, clientOrderId: cloid, accountId: ctx.account.accountId, instrumentId: i.instrumentId, side: i.side, type: i.type, size: i.size!, price: i.price ?? null, reduceOnly: i.reduceOnly === true, isTrigger, status: 'open', createdAt: this.o.clock.now() })
        acks.push({ intentIndex: idx, clientOrderId: cloid, venueOrderId: vo, status: isTrigger ? 'untriggered' : 'open', filledSize: '0' as never, avgFillPrice: null, builder: { attached: false } })
      }
    }
    return { acks, receiptHash: 'ab'.repeat(32), requestWeight: 1 }
  }

  private applyPosition(accountId: string, instrumentId: string, side: 'buy' | 'sell', size: d.Dec, px: d.Dec, lev: number): void {
    const list = this.posOf(accountId).filter((p) => p.instrumentId !== instrumentId)
    const cur = this.posOf(accountId).find((p) => p.instrumentId === instrumentId)
    const signed = (cur ? (cur.side === 'long' ? 1 : -1) * Number(cur.size) : 0) + (side === 'buy' ? 1 : -1) * Number(d.str(size))
    if (Math.abs(signed) > 1e-12) {
      const sz = d.D(Math.abs(signed).toFixed(8))
      list.push({ accountId: accountId as never, instrumentId, side: signed > 0 ? 'long' : 'short', size: d.str(sz), entryPrice: d.str(px), markPrice: d.str(px), notional: d.str(d.mul(sz, px)), unrealizedPnl: '0' as never, realizedPnl: '0' as never, leverage: lev, marginMode: 'cross', liquidationPrice: null, fundingSinceOpen: '0' as never, openedAt: 0, updatedAt: 0 })
    }
    this.positions.set(accountId, list)
  }

  async cancel(ctx: TradeContext, targets: CancelTarget[]): Promise<CancelAck[]> {
    this.cancelCalls.push(targets)
    this.cancelContexts.push(ctx)
    this.cancelGateCalls.push(ctx.gate)
    return targets.map((t) => {
      const o = this.orders.find((x) => x.status === 'open' && (x.venueOrderId === t.venueOrderId || x.clientOrderId === t.clientOrderId))
      if (o) o.status = 'cancelled'
      return { target: t, ok: !!o }
    })
  }
  async cancelAll(ctx: TradeContext, instrumentId?: string): Promise<CancelAck[]> {
    this.cancelAllCalls.push({ ...(instrumentId ? { instrumentId } : {}) })
    this.cancelAllContexts.push(ctx)
    this.cancelAllGateCalls.push(ctx.gate)
    const out: CancelAck[] = []
    for (const o of this.orders) if (o.status === 'open' && (!instrumentId || o.instrumentId === instrumentId)) { o.status = 'cancelled'; out.push({ target: { instrumentId: o.instrumentId, venueOrderId: o.venueOrderId }, ok: true }) }
    return out
  }
  async amend(ctx: TradeContext, req: AmendRequest): Promise<SubmitResult> { this.amendCalls.push({ ctx, req }); return { acks: [], receiptHash: 'ab'.repeat(32), requestWeight: 1 } }
  async setLeverage(ctx: TradeContext, instrumentId: string, leverage: number, marginMode: 'cross' | 'isolated'): Promise<void> { this.leverageCalls.push({ ctx, instrumentId, leverage, marginMode }) }
  async scheduleCancel(ctx: TradeContext, atMs: number | null): Promise<void> {
    const signed = ctx.signer.address !== ZERO_ADDR
    this.scheduleCalls.push({ atMs, signed })
    this.scheduleGateCalls.push({ atMs, signed, ...(ctx.gate ? { ctxGate: ctx.gate } : {}) })
  }
  async close(): Promise<void> { /* 假场所不需要 */ }
}
