// SPDX-License-Identifier: CPAL-1.0
// 模拟场所 kernel-sim（契约 §1.5.3）：吃真实 L2（HL 连接器或回放夹具）做纸面撮合，实现与真连接器同一个 VenueConnector 接口。
// 搬运并改造自 早期 Demo 原型 src/sim/engine.ts：
//   · 全部用十进制定点数（不再用浮点）；风控不在这里——风控闸在内核，模拟场所只做撮合与记账；
//   · 多账户（每个账户独立现金 / 持仓 / 订单 / 成交）；
//   · 订单类型扩到 限价 / 市价 / IOC / ALO / 触发单 / 止盈止损父子单；
//   · 强平改成账户级（权益 < 维持保证金，大仓位先平），强平价按全仓公式估算（带 estimated: true）。
// 撮合假设逐条写在 ASSUMPTIONS.md，对外声明见 declaration.ts。
import { createHash, randomBytes } from 'node:crypto'
import { asDecimal, makeProblem } from '@gitrader/protocol'
import type {
  AccountSnapshot, AmendRequest, CancelAck, CancelTarget, MarkPrice, OrderAck, StartupSnapshot, SubmitResult, TradeContext, Unsubscribe,
  VenueConnector, VenueEvent, VenueFill, VenueOpenOrder, VenueOrderStatus, SubscriptionSpec, AccountRef,
} from '@gitrader/protocol/connector'
import type {
  AccountId, Balance, Book, Candle, CandleInterval, Decimal, Instrument, InstrumentId, MarginSnapshot, MarketContext, Ms, OrderIntent, Position, Problem, Side, VenueCapabilities, VenueRules,
} from '@gitrader/protocol'
import { div, fx, max, min, mul, roundFx, str } from '@gitrader/protocol/decimal'
import type { Fx } from '@gitrader/protocol/decimal'
import { limitCrosses, walkBook } from './book'
import { DEFAULT_FEES, simDeclaration } from './declaration'
import { isValidPrice, snapPrice, truncSize } from './rules'
import type { PaperAccountSpec, PaperEvent, PaperMarket, PaperOrderView, PaperRebuildFacts, PaperVenueOptions } from './types'

const SIM = 'kernel-sim'
const HOUR_MS = 3_600_000
const KEEP_ORDERS = 500
const KEEP_FILLS = 2000
const MM_DIVISOR = 2n // 维持保证金率 = 1 / (2 × 最大杠杆)
const compareText = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0

type OStatus = PaperOrderView['status']
interface POrder {
  venueOrderId: string
  clientOrderId: string
  instrumentId: InstrumentId
  side: Side
  type: PaperOrderView['type']
  tif: 'gtc' | 'ioc' | 'alo'
  size: Fx
  filled: Fx
  price: Fx | null
  triggerPrice: Fx | null
  triggerMarket: boolean
  avgPx: Fx
  fee: Fx
  reduceOnly: boolean
  leverage: number
  status: OStatus
  role: 'parent' | 'tp' | 'sl'
  /** v0.1.3：归属的子仓位，只透传（订单视图与成交事件带上，撮合不看它）。 */
  legId?: string
  parentId?: string
  /** 子单：父单还没全部成交时处于「待父单」状态，不参与触发判断。 */
  waitingParent: boolean
  slippageCap: Fx | null
  reason?: string
  createdAt: number
  updatedAt: number
  closedAt?: number
}
interface PPos {
  side: 'long' | 'short'
  size: Fx
  entry: Fx
  leverage: number
  mark: Fx
  markTs?: number
  openedAt: number
  fundingSinceOpen: Fx
  realized: Fx
  lastFundingTs: number
  pendingFunding: Fx
}
interface PAcct {
  id: AccountId
  ccy: string
  initial: Fx
  cash: Fx
  realized: Fx
  fees: Fx
  funding: Fx
  leverage: Map<InstrumentId, number>
  positions: Map<InstrumentId, PPos>
  orders: POrder[]
  fills: VenueFill[]
  createdAt: number
  confirmedAt?: number
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')
const dec = (x: Fx, dp = 10): Decimal => asDecimal(str(x, dp))
const simProblem = (msg: string, name: 'VENUE_REJECTED' | 'VENUE_INSUFFICIENT_MARGIN' = 'VENUE_REJECTED'): Problem =>
  makeProblem(name, msg, { venue: { id: SIM, message: msg } })

export class PaperVenue implements VenueConnector {
  readonly venue = SIM
  readonly environment: PaperMarket['environment']
  private readonly market: PaperMarket
  private readonly clock: () => number
  private readonly fees: { maker: Fx; taker: Fx }
  private readonly defaultLeverage: number
  private readonly onWarn: (message: string) => void
  private readonly markStaleMs: number
  private readonly accounts = new Map<string, PAcct>()
  private readonly unpriceableWarnAt = new Map<string, Map<string, number>>()
  private readonly markSubscribeFailedAt = new Map<InstrumentId, number>()
  private readonly markSubs = new Map<InstrumentId, Unsubscribe>()
  private readonly listeners = new Set<(e: PaperEvent) => void>()
  private chain: Promise<unknown> = Promise.resolve()
  private orderSeq = 0
  private fillSeq = 0
  private timer: ReturnType<typeof setInterval> | null = null
  private closed = false

  constructor(o: PaperVenueOptions) {
    this.market = o.market
    this.environment = o.market.environment
    this.clock = o.clock ?? (() => Date.now())
    this.fees = { maker: fx((o.fees ?? DEFAULT_FEES).maker), taker: fx((o.fees ?? DEFAULT_FEES).taker) }
    this.defaultLeverage = o.defaultLeverage ?? 1
    this.onWarn = o.onWarn ?? ((message) => console.warn(message))
    this.markStaleMs = o.markStaleMs ?? 5_000
  }

  // ───────────── 账户 / 事件 / 生命周期 ─────────────

  createAccount(spec: PaperAccountSpec): void {
    if (this.accounts.has(spec.accountId)) throw new Error(`paper account already exists: ${spec.accountId}`)
    const initial = fx(spec.initialBalance)
    if (initial < 0n) throw new RangeError('initialBalance must not be negative')
    const createdAt = this.clock()
    this.accounts.set(spec.accountId, {
      id: spec.accountId as AccountId, ccy: spec.ccy ?? 'USDC', initial, cash: initial, realized: 0n, fees: 0n, funding: 0n,
      leverage: new Map(), positions: new Map(), orders: [], fills: [], createdAt,
    })
  }

  hasAccount(accountId: string): boolean {
    return this.accounts.has(accountId)
  }

  /** 显式重置单个模拟账户；全局订单 / 成交序号永不回退。 */
  async resetAccount(spec: PaperAccountSpec): Promise<void> {
    await this.lock(async () => {
      const a = this.accounts.get(spec.accountId)
      if (a) {
        for (const o of a.orders.filter(isLive)) this.finish(a, o, 'cancelled', this.clock(), 'paper account reset')
        const instruments = [...a.positions.keys()]
        this.accounts.delete(spec.accountId)
        this.createAccount(spec)
        for (const instrumentId of instruments) this.emit({ kind: 'position', accountId: spec.accountId, instrumentId, position: null })
      } else this.createAccount(spec)
    })
  }

  /** 订阅订单 / 成交 / 持仓 / 资金费 / 强平事件。返回取消函数。 */
  onEvent(cb: (e: PaperEvent) => void): Unsubscribe {
    this.listeners.add(cb)
    return () => { this.listeners.delete(cb) }
  }

  private emit(e: PaperEvent): void {
    for (const cb of [...this.listeners]) {
      try { cb(e) } catch { /* 订阅者异常不影响撮合 */ }
    }
  }

  /** 每 intervalMs 推进一次（触发单、挂单、资金费、强平）。回放时不要开，由回放循环调用 tick。 */
  start(intervalMs = 1000): void {
    if (this.timer) return
    this.timer = setInterval(() => { void this.tick().catch(() => {}) }, intervalMs)
    this.timer.unref?.()
  }

  async close(): Promise<void> {
    this.closed = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    for (const u of this.bookSubs.values()) u()
    this.bookSubs.clear()
    for (const u of this.markSubs.values()) u()
    this.markSubs.clear()
    this.markSubscribeFailedAt.clear()
    await this.chain.catch(() => {})
  }

  private lock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn)
    this.chain = run.then(() => undefined, () => undefined)
    return run
  }

  private acct(ref: { accountId: string }): PAcct {
    const a = this.accounts.get(ref.accountId)
    if (!a) throw new PaperProblemError(makeProblem('ACCOUNT_NOT_BOUND', `no paper account ${ref.accountId}`))
    return a
  }

  // ───────────── VenueConnector：行情（透传被模拟场所的行情） ─────────────

  describe(): VenueCapabilities {
    const mirrored = this.market.describe()
    const { deadman: _d, signers: _s, bookSnapshot: _b, ...rest } = mirrored // 模拟场所自己不提供本地快照接口，不镜像这个能力位
    return { ...rest, 'x-kernelSim': simDeclaration([this.market.venue]) }
  }
  listInstruments(opts?: { includeDelisted?: boolean }): Instrument[] { return this.market.listInstruments(opts) }
  getInstrument(id: InstrumentId): Instrument | undefined { return this.market.getInstrument(id) }
  quote(id: InstrumentId) { return this.market.quote(id) }
  mark(id: InstrumentId): MarkPrice | undefined {
    const instrument = this.market.getInstrument(id)
    if (!instrument || instrument.status === 'delisted') return undefined
    if (!this.closed && !this.markSubs.has(id)) {
      const failedAt = this.markSubscribeFailedAt.get(id)
      const now = this.clock()
      if (failedAt === undefined || now >= failedAt + 600_000) {
        try {
          this.markSubs.set(id, this.market.subscribe({ channel: 'quote', instrumentId: id }, () => {}))
          this.markSubscribeFailedAt.delete(id)
        } catch {
          this.markSubscribeFailedAt.set(id, now)
          this.onWarn('纸面场所行情订阅失败；仅使用本地报价')
        }
      }
    }
    const q = this.market.quote(id)
    if (!q || q.stale || this.clock() - q.ts > this.markStaleMs) return undefined
    const px = q.last ?? (q.bid + q.ask) / 2
    if (!Number.isFinite(px) || px <= 0) return undefined
    return { price: asDecimal(str(fx(px))), ts: q.ts, source: 'venue_mark' }
  }
  book(id: InstrumentId, depth?: number): Promise<Book> { return this.market.book(id, depth) }
  candles(id: InstrumentId, interval: CandleInterval, opts?: { n?: number; from?: Ms; to?: Ms }): Promise<Candle[]> { return this.market.candles(id, interval, opts) }
  context(id: InstrumentId): Promise<MarketContext> { return this.market.context(id) }
  status() { return this.market.status() }
  subscribe(spec: SubscriptionSpec, cb: (e: VenueEvent) => void): Unsubscribe {
    if (spec.channel === 'userFills' || spec.channel === 'orderUpdates') {
      throw new PaperProblemError(makeProblem('CAPABILITY_UNSUPPORTED', 'paper accounts publish through onEvent(), not user streams'))
    }
    return this.market.subscribe(spec, cb)
  }

  // ───────────── VenueConnector：账户读取 ─────────────

  async accountState(ref: AccountRef): Promise<AccountSnapshot> {
    const a = this.acct(ref)
    const ts = this.clock()
    const liveOrders = a.orders.filter(isLive)
    let stale = this.markAll(a)
    const m = this.metrics(a)
    const balances: Balance[] = [{
      accountId: a.id, asset: a.ccy, total: dec(m.equity), available: dec(max(m.equity - m.im, 0n)), hold: dec(m.im), ts,
    }]
    const margin: MarginSnapshot = {
      accountId: a.id, model: 'standard', valuationCcy: a.ccy, equity: dec(m.equity), initialMargin: dec(m.im), maintenanceMargin: dec(m.mm),
      available: dec(m.equity - m.im), marginRatio: dec(m.equity > 0n ? div(m.mm, m.equity) : 0n, 8),
      leverage: m.equity > 0n ? Number(str(div(m.notional, m.equity), 4)) : 0, ts,
    }
    const groups = new Map<string, { instrumentId: InstrumentId; side: 'buy' | 'sell'; notional: Fx; count: number }>()
    const warnedOrders = this.unpriceableWarnAt.get(a.id)
    if (warnedOrders) {
      const liveIds = new Set(liveOrders.map((order) => order.venueOrderId))
      for (const orderId of warnedOrders.keys()) if (!liveIds.has(orderId)) warnedOrders.delete(orderId)
      if (warnedOrders.size === 0) this.unpriceableWarnAt.delete(a.id)
    }
    for (const o of liveOrders) {
      if (o.reduceOnly) continue
      let notional: Fx
      try {
        const instrument = this.market.getInstrument(o.instrumentId)
        if (!instrument) throw new Error('missing instrument')
        const price = o.price ?? o.triggerPrice ?? this.markOf(o.instrumentId)
        if (price === undefined || price <= 0n) throw new Error('missing price')
        notional = mul(mul(o.size - o.filled, price), fx(instrument.contractSize))
      } catch {
        stale = true
        this.warnUnpriceableOrder(a.id, o.venueOrderId, ts)
        continue
      }
      const key = `${o.instrumentId}\u0000${o.side}`
      const group = groups.get(key)
      if (group) { group.notional += notional; group.count++ }
      else groups.set(key, { instrumentId: o.instrumentId, side: o.side, notional, count: 1 })
    }
    const openOrders = [...groups.values()]
      .sort((a, b) => compareText(a.instrumentId, b.instrumentId) || compareText(a.side, b.side))
      .map((g) => ({ instrumentId: g.instrumentId, side: g.side, notional: asDecimal(str(g.notional)), count: g.count }))
    const declaredRules = this.describe().rules ?? {}
    const rules: VenueRules = {}
    if (declaredRules.marketPriceBandBps !== undefined) rules.marketPriceBandBps = declaredRules.marketPriceBandBps
    if (declaredRules.minOrderNotional !== undefined) rules.minOrderNotional = declaredRules.minOrderNotional
    if (declaredRules.maxOpenOrders !== undefined) rules.maxOpenOrders = { cap: declaredRules.maxOpenOrders.cap, current: liveOrders.length }
    const stopLossOrderIds = liveOrders
      .filter((o) => o.reduceOnly && (o.type === 'stop_market' || o.type === 'stop_limit'))
      .map((o) => o.venueOrderId)
      .sort()
    if (!stale) a.confirmedAt = a.confirmedAt === undefined ? ts : Math.max(a.confirmedAt, ts)
    return {
      accountModel: 'standard', balances, margin, positions: [...a.positions.keys()].map((id) => this.positionView(a, id, ts)), ts,
      asOf: ts, ...(a.confirmedAt !== undefined ? { confirmedAt: a.confirmedAt } : {}), stale, availableDeductsOpenOrders: false, openOrders, stopLossOrderIds, rules,
    }
  }

  private warnUnpriceableOrder(accountId: string, orderId: string, now: number): void {
    let orders = this.unpriceableWarnAt.get(accountId)
    if (!orders) { orders = new Map(); this.unpriceableWarnAt.set(accountId, orders) }
    const lastWarnAt = orders.get(orderId)
    if (lastWarnAt === undefined || now >= lastWarnAt + 600_000) {
      this.onWarn('纸面账户挂单无法估值；已跳过该单')
      orders.set(orderId, now)
    }
  }

  async openOrders(ref: AccountRef): Promise<VenueOpenOrder[]> {
    const a = this.acct(ref)
    return a.orders.filter(isLive).map((o) => ({
      instrumentId: o.instrumentId, venueOrderId: o.venueOrderId, clientOrderId: o.clientOrderId, side: o.side,
      type: o.type === 'market' ? 'unknown' : (o.type as VenueOpenOrder['type']),
      price: o.price === null ? null : dec(o.price), triggerPrice: o.triggerPrice === null ? null : dec(o.triggerPrice),
      size: dec(o.size - o.filled), origSize: dec(o.size), reduceOnly: o.reduceOnly, isTrigger: o.triggerPrice !== null, createdAt: o.createdAt,
      ...(o.parentId ? { parentVenueOrderId: o.parentId } : {}),
    }))
  }

  async fills(ref: AccountRef, sinceMs: Ms): Promise<VenueFill[]> {
    return this.acct(ref).fills.filter((f) => f.ts >= sinceMs).map((f) => ({ ...f }))
  }

  async orderStatus(ref: AccountRef, key: { clientOrderId?: string; venueOrderId?: string }): Promise<VenueOrderStatus> {
    const o = this.find(this.acct(ref), key)
    if (!o) return { found: false }
    return { found: true, status: o.status, venueOrderId: o.venueOrderId, filledSize: dec(o.filled), raw: orderView(this.acct(ref).id, o) }
  }

  async startupSnapshot(ref: AccountRef, fillsSinceMs: Ms): Promise<StartupSnapshot> {
    return { account: await this.accountState(ref), openOrders: await this.openOrders(ref), fills: await this.fills(ref, fillsSinceMs), fillsSince: fillsSinceMs, truncated: false }
  }

  /** 订单视图（含已结束的，最近 500 条）。 */
  orders(accountId: string, filter?: { live?: boolean }): PaperOrderView[] {
    const a = this.acct({ accountId })
    return a.orders.filter((o) => !filter?.live || isLive(o)).map((o) => orderView(a.id, o))
  }

  // ───────────── VenueConnector：交易 ─────────────

  submit(ctx: TradeContext, intents: OrderIntent[]): Promise<SubmitResult> {
    return this.lock(async () => {
      const a = this.acct(ctx.account)
      const acks: OrderAck[] = []
      for (let i = 0; i < intents.length; i++) acks.push(...(await this.submitOne(a, intents[i]!, i)))
      return { acks, receiptHash: sha256(JSON.stringify(acks)), requestWeight: 0 }
    })
  }

  cancel(ctx: TradeContext, targets: CancelTarget[]): Promise<CancelAck[]> {
    return this.lock(async () => {
      const a = this.acct(ctx.account)
      const now = this.clock()
      return targets.map((t): CancelAck => {
        const o = this.find(a, t)
        if (!o || !isLive(o)) return { target: t, ok: false, problem: simProblem('kernel-sim: order unknown (never placed, already canceled, or filled)') }
        this.finish(a, o, 'cancelled', now, 'canceled by request')
        this.cascadeCancel(a, o, now)
        return { target: t, ok: true }
      })
    })
  }

  cancelAll(ctx: TradeContext, instrumentId?: InstrumentId): Promise<CancelAck[]> {
    return this.lock(async () => {
      const a = this.acct(ctx.account)
      const now = this.clock()
      const out: CancelAck[] = []
      for (const o of a.orders.filter((x) => isLive(x) && (!instrumentId || x.instrumentId === instrumentId))) {
        this.finish(a, o, 'cancelled', now, 'canceled by cancelAll')
        out.push({ target: { instrumentId: o.instrumentId, venueOrderId: o.venueOrderId }, ok: true })
      }
      return out
    })
  }

  amend(ctx: TradeContext, req: AmendRequest): Promise<SubmitResult> {
    return this.lock(async () => {
      const a = this.acct(ctx.account)
      const o = this.find(a, req)
      const base = { intentIndex: 0, role: 'parent' as const, clientOrderId: o?.clientOrderId ?? req.clientOrderId ?? '' }
      const fail = (p: Problem): SubmitResult => ({ acks: [this.ack(base, null, 'rejected', 0n, 0n, p)], receiptHash: sha256(p.message), requestWeight: 0 })
      if (!o || !isLive(o) || o.type === 'market') return fail(simProblem('kernel-sim: order unknown (never placed, already canceled, or filled)'))
      const v = await this.validate(a, req.order)
      if (!('inst' in v)) return fail(v)
      if (v.size < o.filled) return fail(simProblem('kernel-sim: new size is below the already filled size'))
      const now = this.clock()
      o.size = v.size
      if (v.price !== null) o.price = v.price
      if (v.triggerPrice !== null) o.triggerPrice = v.triggerPrice
      o.updatedAt = now
      if (o.status === 'open' || o.status === 'partially_filled') await this.matchResting(a, o, now, true) // 改价后可能已经穿价
      this.emitOrder(a, o)
      return { acks: [this.ack(base, o.venueOrderId, o.status === 'untriggered' ? 'untriggered' : 'open', o.filled, o.avgPx)], receiptHash: sha256(JSON.stringify(orderView(a.id, o))), requestWeight: 0 }
    })
  }

  async setLeverage(ctx: TradeContext, instrumentId: InstrumentId, leverage: number, _marginMode: 'cross' | 'isolated'): Promise<void> {
    return this.lock(async () => {
      const a = this.acct(ctx.account)
      const inst = this.market.getInstrument(instrumentId)
      if (!inst) throw new PaperProblemError(makeProblem('INSTRUMENT_UNKNOWN', `unknown instrument ${instrumentId}`))
      if (!Number.isInteger(leverage) || leverage < 1 || (inst.maxLeverage !== undefined && leverage > inst.maxLeverage)) {
        throw new PaperProblemError(simProblem(`kernel-sim: leverage must be an integer between 1 and ${inst.maxLeverage ?? 'the venue maximum'}`))
      }
      const p = a.positions.get(instrumentId)
      if (p) {
        this.markAll(a)
        const m = this.metrics(a)
        const delta = div(mul(p.size, p.mark), fx(leverage)) - div(mul(p.size, p.mark), fx(p.leverage))
        if (delta > 0n && delta > m.equity - m.im) throw new PaperProblemError(simProblem('kernel-sim: insufficient margin to raise leverage on the open position', 'VENUE_INSUFFICIENT_MARGIN'))
        p.leverage = leverage
      }
      a.leverage.set(instrumentId, leverage)
    })
  }

  async scheduleCancel(): Promise<void> {
    throw new PaperProblemError(makeProblem('CAPABILITY_UNSUPPORTED', 'kernel-sim has no venue-level dead-man switch (it lives inside the kernel process)'))
  }

  // ───────────── 下单：校验 ─────────────

  private async validate(a: PAcct, intent: OrderIntent): Promise<{
    inst: Instrument; size: Fx; price: Fx | null; triggerPrice: Fx | null; tif: 'gtc' | 'ioc' | 'alo'; leverage: number
  } | Problem> {
    const inst = this.market.getInstrument(intent.instrumentId)
    if (!inst || inst.status === 'delisted') return makeProblem('INSTRUMENT_UNKNOWN', `unknown instrument ${intent.instrumentId}`)
    if (!inst.orderTypes.includes(intent.type)) return makeProblem('ORDER_TYPE_UNSUPPORTED', `order type ${intent.type} is not supported for ${inst.symbol}`)
    if (intent.triggerType && intent.triggerType !== 'mark') return makeProblem('ORDER_TYPE_UNSUPPORTED', `trigger price type ${intent.triggerType} is not supported`)
    const trigger = ['stop_market', 'stop_limit', 'take_market', 'take_limit'].includes(intent.type)
    let tif: 'gtc' | 'ioc' | 'alo'
    if (intent.type === 'market') tif = 'ioc'
    else if (intent.postOnly || intent.tif === 'alo') {
      if (intent.tif === 'ioc') return makeProblem('ORDER_TYPE_UNSUPPORTED', 'postOnly cannot be combined with tif ioc')
      tif = 'alo'
    } else {
      const t = intent.tif ?? 'gtc'
      if (t !== 'gtc' && t !== 'ioc') return makeProblem('ORDER_TYPE_UNSUPPORTED', `time in force ${t} is not supported`)
      tif = t
    }
    if (tif !== 'ioc' && intent.type !== 'market' && !inst.tif.includes(tif)) return makeProblem('ORDER_TYPE_UNSUPPORTED', `time in force ${tif} is not supported for ${inst.symbol}`)
    if (inst.status === 'halted') return simProblem(`kernel-sim: ${inst.symbol} is halted`)
    if (inst.status === 'reduce_only' && !intent.reduceOnly) return simProblem(`kernel-sim: ${inst.symbol} only accepts reduce-only orders`)

    const parse = (label: string, raw: string): Fx | Problem => {
      try {
        const v = fx(raw)
        if (v <= 0n) return makeProblem('INVALID_PARAMS', `${label} must be greater than zero`)
        if (isValidPrice(inst.price, v)) return v
        if ((intent.rounding ?? 'reject') === 'reject') return makeProblem('PRECISION', `${label} ${raw} violates the price rule of ${inst.symbol}`)
        return snapPrice(inst.price, v, intent.side === 'buy' ? 'down' : 'up')
      } catch { return makeProblem('INVALID_PARAMS', `${label} is not a decimal number: ${JSON.stringify(raw)}`) }
    }
    let price: Fx | null = null
    let triggerPrice: Fx | null = null
    if (intent.type === 'limit' || intent.type === 'stop_limit' || intent.type === 'take_limit') {
      if (intent.price === undefined) return makeProblem('INVALID_PARAMS', `${intent.type} orders need price`)
      const p = parse('price', intent.price)
      if (typeof p !== 'bigint') return p
      price = p
    }
    if (trigger) {
      if (intent.triggerPrice === undefined) return makeProblem('INVALID_PARAMS', `${intent.type} orders need triggerPrice`)
      const p = parse('triggerPrice', intent.triggerPrice)
      if (typeof p !== 'bigint') return p
      triggerPrice = p
    }
    if (intent.type === 'market' && intent.maxSlippageBps === undefined) return makeProblem('INVALID_PARAMS', 'market orders need maxSlippageBps (no implicit default slippage)')

    // 数量
    let size: Fx
    if (intent.size !== undefined) {
      try { size = fx(intent.size) } catch { return makeProblem('INVALID_PARAMS', `size is not a decimal number: ${JSON.stringify(intent.size)}`) }
    } else if (intent.notional !== undefined) {
      const q = this.market.quote(intent.instrumentId)
      const ref = q?.last ?? (q ? (q.bid + q.ask) / 2 : undefined)
      if (ref === undefined || !(ref > 0)) return makeProblem('STALE_PRICE', `no price to convert notional for ${intent.instrumentId}`, { retryAfterMs: 1000 })
      size = div(fx(intent.notional), fx(ref))
    } else return makeProblem('INVALID_PARAMS', 'order needs size or notional')
    if (size <= 0n) return makeProblem('INVALID_PARAMS', 'size must be greater than zero')
    size = truncSize(inst, size)
    if (size <= 0n || size < fx(inst.size.min)) return makeProblem('PRECISION', `size is below the lot size ${inst.size.min} for ${inst.symbol} (sizes truncate toward zero)`)
    const leverage = intent.leverage ?? a.leverage.get(inst.instrumentId) ?? this.defaultLeverage
    if (!Number.isInteger(leverage) || leverage < 1 || (inst.maxLeverage !== undefined && leverage > inst.maxLeverage)) {
      return simProblem(`kernel-sim: leverage ${leverage} is outside 1..${inst.maxLeverage ?? '?'}`)
    }
    return { inst, size, price, triggerPrice, tif, leverage }
  }

  // ───────────── L2 盘口：读本地快照，不逐单打 REST ─────────────

  private bookSubs = new Map<InstrumentId, Unsubscribe>()

  /**
   * 取撮合用的盘口。行情源提供本地快照（HL 连接器：WS l2Book 订阅维护）时：订阅一次、之后只读缓存；
   * 快照缺失或 stale 才走有界、限频的 REST 兜底；兜底也拿不到就返回 reason，由调用方拒单（可读错误，不阻塞）。
   * 行情源没有快照接口（回放夹具）时直接 await book()。
   */
  private async l2(id: InstrumentId): Promise<{ book?: Book; reason?: string }> {
    const m = this.market
    if (!m.bookSnapshot) {
      try { return { book: await m.book(id, 20) } } catch (e) { return { reason: `kernel-sim: no L2 book for ${id} (${e instanceof Error ? e.message : String(e)}); order not matched` } }
    }
    if (!this.bookSubs.has(id)) {
      try { this.bookSubs.set(id, m.subscribe({ channel: 'book', instrumentId: id }, () => {})) } catch { /* 订阅失败（上限等）：只靠兜底 */ }
    }
    let s = m.bookSnapshot(id)
    if (!s || s.stale) s = (await m.refreshBook?.(id, { maxWaitMs: 1000 })) ?? s
    if (!s || s.stale) {
      const age = s ? `last update ${Math.max(0, this.clock() - s.asOf)} ms ago` : 'none received yet'
      return { reason: `kernel-sim: no fresh L2 snapshot for ${id} (${age}); order not matched — retry once the order book stream is up` }
    }
    return { book: s.book }
  }

  // ───────────── 下单：执行 ─────────────

  private async submitOne(a: PAcct, intent: OrderIntent, intentIndex: number): Promise<OrderAck[]> {
    const clientOrderId = intent.clientOrderId ?? randomBytes(16).toString('hex')
    const base = { intentIndex, role: 'parent' as const, clientOrderId }
    const rejected = (p: Problem) => [this.ack(base, null, 'rejected', 0n, 0n, p)]
    const v = await this.validate(a, intent)
    if (!('inst' in v)) return rejected(v)
    const { inst } = v
    const now = this.clock()

    const q = this.market.quote(inst.instrumentId)
    if (!q || q.stale) return rejected(makeProblem('STALE_PRICE', `no fresh price for ${inst.instrumentId}`, { retryAfterMs: 1000 }))
    const mid = fx((q.bid + q.ask) / 2)
    const trigger = v.triggerPrice !== null

    // 市价单的滑点上限（与连接器一致：买单向下取整，卖单向上取整，永不越过上限）
    let cap: Fx | null = null
    if (intent.type === 'market') {
      const slip = div(fx(intent.maxSlippageBps!), fx(10000))
      cap = snapPrice(inst.price, intent.side === 'buy' ? mid + mul(mid, slip) : mid - mul(mid, slip), intent.side === 'buy' ? 'down' : 'up')
    }

    // reduceOnly：没有可减的反向持仓直接拒（场所行为）
    const pos = a.positions.get(inst.instrumentId)
    const opposite = !!pos && ((intent.side === 'buy' && pos.side === 'short') || (intent.side === 'sell' && pos.side === 'long'))
    if (intent.reduceOnly && !opposite && !trigger) return rejected(simProblem('kernel-sim: reduce only order would increase position'))

    // 最小名义额
    const refPx = v.price ?? v.triggerPrice ?? mid
    if (!intent.reduceOnly && inst.minNotional !== undefined && mul(v.size, refPx) < fx(inst.minNotional)) {
      return rejected(makeProblem('MIN_NOTIONAL', `order value ${str(mul(v.size, refPx), 4)} is below the venue minimum of ${inst.minNotional}`))
    }

    // 保证金（只检查会加仓的部分）
    if (!intent.reduceOnly) {
      this.markAll(a)
      const need = this.marginNeeded(a, inst, intent.side, v.size, mid, v.leverage)
      const m = this.metrics(a)
      if (need > 0n && need > m.equity - m.im) {
        return rejected(simProblem(`kernel-sim: insufficient margin to place order (need ${str(need, 4)}, available ${str(max(m.equity - m.im, 0n), 4)} ${a.ccy})`, 'VENUE_INSUFFICIENT_MARGIN'))
      }
    }

    const order = this.newOrder(a, {
      ...(intent.legId ? { legId: intent.legId } : {}),
      clientOrderId, instrumentId: inst.instrumentId, side: intent.side, type: intent.type, tif: v.tif, size: v.size, price: v.price,
      triggerPrice: v.triggerPrice, triggerMarket: intent.type === 'stop_market' || intent.type === 'take_market',
      reduceOnly: !!intent.reduceOnly, leverage: v.leverage, role: 'parent', slippageCap: cap, now,
    })

    // 子单：normalTpsl 等父单全部成交后才激活；positionTpsl 立即生效
    const children: POrder[] = []
    if (intent.tpsl && !trigger) {
      const wait = intent.tpsl.grouping !== 'position'
      const mk = (role: 'tp' | 'sl', leg: { triggerPrice: string; price?: string }): POrder | Problem => {
        const tp = fx(leg.triggerPrice)
        if (tp <= 0n || !isValidPrice(inst.price, tp)) return makeProblem('PRECISION', `${role} triggerPrice ${leg.triggerPrice} violates the price rule of ${inst.symbol}`)
        const px = leg.price !== undefined ? fx(leg.price) : null
        if (px !== null && (px <= 0n || !isValidPrice(inst.price, px))) return makeProblem('PRECISION', `${role} price ${leg.price} violates the price rule of ${inst.symbol}`)
        return this.newOrder(a, {
          clientOrderId: '', instrumentId: inst.instrumentId, side: intent.side === 'buy' ? 'sell' : 'buy', type: role === 'tp' ? (px ? 'take_limit' : 'take_market') : (px ? 'stop_limit' : 'stop_market'),
          tif: 'gtc', size: v.size, price: px, triggerPrice: tp, triggerMarket: px === null, reduceOnly: true, leverage: v.leverage, role, parentId: order.venueOrderId,
          ...(intent.legId ? { legId: intent.legId } : {}), waitingParent: wait, slippageCap: null, now, silent: true,
        })
      }
      for (const [role, leg] of [['tp', intent.tpsl.takeProfit], ['sl', intent.tpsl.stopLoss]] as const) {
        if (!leg) continue
        const c = mk(role, leg)
        if ('venueOrderId' in c) children.push(c)
        else { this.dropOrder(a, order); for (const k of children) this.dropOrder(a, k); return rejected(c) }
      }
    }

    // 触发单：只登记，等 tick 判断
    if (trigger) {
      this.emitOrder(a, order)
      return [this.ack(base, order.venueOrderId, 'untriggered', 0n, 0n)]
    }

    const l2 = await this.l2(inst.instrumentId)
    if (l2.reason) {
      this.dropOrder(a, order)
      for (const k of children) this.dropOrder(a, k)
      return rejected(makeProblem('STALE_PRICE', l2.reason, { retryAfterMs: 1000 }))
    }
    const book = l2.book
    const crosses = intent.type === 'market' || (v.price !== null && limitCrosses(order.side, v.price, book))
    if (v.tif === 'alo' && crosses) {
      this.dropOrder(a, order)
      for (const k of children) this.dropOrder(a, k)
      const bb = book?.bids[0]?.price
      const ba = book?.asks[0]?.price
      return rejected(simProblem(`kernel-sim: post only order would have immediately matched, bbo was ${bb ?? '?'}@${ba ?? '?'}`))
    }
    const rests = intent.type !== 'market' && v.tif !== 'ioc' // GTC / ALO 的剩余量挂单；IOC / 市价不挂
    if (crosses) {
      const limit = v.price ?? cap
      const want = this.clip(a, order, order.size) // reduceOnly 先按持仓裁剪，再去吃盘口
      const walk = want > 0n ? walkBook(order.side, want, book, mid, { ...(limit !== null ? { cap: limit } : {}), allowTail: intent.type === 'market' }) : { filled: 0n, avgPx: 0n }
      const sz = walk.filled
      if (sz > 0n) this.applyFill(a, order, walk.avgPx, sz, 'taker', now)
    }
    if (order.filled === 0n && !rests) {
      // IOC / 市价一笔都没吃到：和场所一样当作拒绝
      this.dropOrder(a, order)
      for (const k of children) this.dropOrder(a, k)
      return rejected(simProblem('kernel-sim: order could not immediately match against any resting orders'))
    }
    if (order.filled < order.size && !rests) {
      // IOC / 市价部分成交：残量作废（场所回执仍是 filled，数量小于下单量）
      this.finish(a, order, 'cancelled', now, 'unfilled remainder canceled (IOC / market cap)')
    } else {
      this.emitOrder(a, order)
    }
    this.activateChildren(a, order)
    this.cascadeCancel(a, order, now)
    const done = order.filled > 0n && (order.filled >= order.size || order.status === 'cancelled')
    const acks: OrderAck[] = [this.ack(base, order.venueOrderId, done ? 'filled' : 'open', order.filled, order.avgPx)]
    for (const k of children) {
      if (isLive(k)) acks.push(this.ack({ intentIndex, role: k.role as 'tp' | 'sl', clientOrderId: '' }, k.venueOrderId, 'untriggered', 0n, 0n))
    }
    return acks
  }

  private ack(base: { intentIndex: number; role: 'parent' | 'tp' | 'sl'; clientOrderId: string }, venueOrderId: string | null, status: OrderAck['status'], filled: Fx, avg: Fx, problem?: Problem): OrderAck {
    return {
      ...base, venueOrderId, status, filledSize: dec(filled), avgFillPrice: avg > 0n ? dec(avg) : null, builder: { attached: false },
      ...(problem ? { problem } : {}),
    }
  }

  private newOrder(a: PAcct, p: {
    clientOrderId: string; instrumentId: string; side: Side; type: POrder['type']; tif: POrder['tif']; size: Fx; price: Fx | null; triggerPrice: Fx | null
    triggerMarket: boolean; reduceOnly: boolean; leverage: number; role: POrder['role']; legId?: string; parentId?: string; waitingParent?: boolean; slippageCap: Fx | null; now: number; silent?: boolean
  }): POrder {
    const id = `sim-${String(++this.orderSeq).padStart(6, '0')}`
    const o: POrder = {
      venueOrderId: id, clientOrderId: p.clientOrderId || id, instrumentId: p.instrumentId, side: p.side, type: p.type, tif: p.tif, size: p.size, filled: 0n,
      price: p.price, triggerPrice: p.triggerPrice, triggerMarket: p.triggerMarket, avgPx: 0n, fee: 0n, reduceOnly: p.reduceOnly, leverage: p.leverage,
      status: p.triggerPrice !== null ? 'untriggered' : 'open', role: p.role, ...(p.legId ? { legId: p.legId } : {}), ...(p.parentId ? { parentId: p.parentId } : {}), waitingParent: !!p.waitingParent,
      slippageCap: p.slippageCap, createdAt: p.now, updatedAt: p.now,
    }
    a.orders.push(o)
    if (a.orders.length > KEEP_ORDERS) {
      // 只丢最老的已结束订单
      const idx = a.orders.findIndex((x) => !isLive(x))
      if (idx >= 0) a.orders.splice(idx, 1)
    }
    return o
  }

  private dropOrder(a: PAcct, o: POrder): void {
    const i = a.orders.indexOf(o)
    if (i >= 0) a.orders.splice(i, 1)
  }

  private find(a: PAcct, key: { clientOrderId?: string | undefined; venueOrderId?: string | undefined }): POrder | undefined {
    return a.orders.find((o) => (key.venueOrderId !== undefined && o.venueOrderId === key.venueOrderId) || (key.venueOrderId === undefined && key.clientOrderId !== undefined && o.clientOrderId === key.clientOrderId))
  }

  private finish(a: PAcct, o: POrder, status: 'cancelled' | 'filled', now: number, reason?: string): void {
    o.status = status
    o.updatedAt = now
    o.closedAt = now
    if (reason) o.reason = `kernel-sim: ${reason}`
    this.emitOrder(a, o)
  }

  /** 父单没成交完就结束 → 还在等父单的子单一并撤销。 */
  private cascadeCancel(a: PAcct, parent: POrder, now: number): void {
    if (parent.status !== 'cancelled') return
    for (const c of a.orders) {
      if (c.parentId === parent.venueOrderId && isLive(c) && c.waitingParent) this.finish(a, c, 'cancelled', now, 'parent order canceled')
    }
  }

  private activateChildren(a: PAcct, parent: POrder): void {
    if (parent.filled < parent.size) return
    for (const c of a.orders) {
      if (c.parentId === parent.venueOrderId && c.waitingParent) { c.waitingParent = false; c.updatedAt = this.clock(); this.emitOrder(a, c) }
    }
  }

  /** reduceOnly 单按当前反向持仓裁剪；没有可减的持仓返回 0。 */
  private clip(a: PAcct, o: POrder, want: Fx): Fx {
    const remaining = o.size - o.filled
    let sz = min(want, remaining)
    if (o.reduceOnly) {
      const pos = a.positions.get(o.instrumentId)
      const opposite = !!pos && ((o.side === 'buy' && pos.side === 'short') || (o.side === 'sell' && pos.side === 'long'))
      sz = opposite ? min(sz, pos!.size) : 0n
    }
    return sz
  }

  // ───────────── 成交记账 ─────────────

  private rates(inst: Instrument | undefined): { maker: Fx; taker: Fx } {
    return inst?.fees ? { maker: fx(inst.fees.maker), taker: fx(inst.fees.taker) } : this.fees
  }

  /** 一笔成交的持仓与现金记账（成交与 fix-r2 的「按账本重建」共用同一套算法）。返回已实现盈亏。 */
  private bookFill(a: PAcct, instrumentId: InstrumentId, side: Side, leverage: number, px: Fx, sz: Fx, fee: Fx, now: number): Fx {
    const inst = this.market.getInstrument(instrumentId)
    const dec0 = inst?.size.decimals ?? 8
    const dir: 'long' | 'short' = side === 'buy' ? 'long' : 'short'
    let realized = 0n
    const cur = a.positions.get(instrumentId)
    const open = (size: Fx, carry?: { realized: Fx; funding: Fx }) => {
      a.positions.set(instrumentId, {
        side: dir, size, entry: px, leverage, mark: px, openedAt: now, fundingSinceOpen: carry?.funding ?? 0n, realized: carry?.realized ?? 0n,
        lastFundingTs: now, pendingFunding: 0n,
      })
    }
    if (!cur) open(sz)
    else if (cur.side === dir) {
      cur.entry = div(mul(cur.size, cur.entry) + mul(sz, px), cur.size + sz)
      cur.size = roundFx(cur.size + sz, dec0, 'half')
      cur.leverage = leverage
    } else {
      const closing = min(sz, cur.size)
      realized = mul(px - cur.entry, closing) * (cur.side === 'long' ? 1n : -1n)
      cur.size = roundFx(cur.size - closing, dec0, 'half')
      cur.realized += realized
      const rest = roundFx(sz - closing, dec0, 'half')
      if (cur.size <= 0n) {
        a.positions.delete(instrumentId)
        if (rest > 0n) open(rest)
      }
    }
    a.cash += realized - fee
    a.realized += realized
    a.fees += fee
    return realized
  }

  /**
   * fix-r2 S1（ADR-16）：按账本重建纸面状态（账本是真源）。每个账户从初始资金起，按账本成交逐笔走 bookFill（与真实成交同一套算法，
   * 手续费取账本记录值），资金费按账本加减；内核仍认为在挂的单原样重建成场所挂单；序号取已用过的最大号。返回 exportState() 同格式的串。
   */
  rebuildFromLedgerFacts(facts: PaperRebuildFacts): string {
    this.accounts.clear()
    this.orderSeq = facts.orderSeq
    this.fillSeq = facts.fillSeq
    for (const f of facts.accounts) {
      this.createAccount({ accountId: f.accountId, initialBalance: f.initialBalance, ...(f.ccy ? { ccy: f.ccy } : {}) })
      const a = this.accounts.get(f.accountId)!
      a.createdAt = f.createdAt
      for (const x of f.fills) this.bookFill(a, x.instrumentId, x.side, x.leverage, fx(x.price), fx(x.size), fx(x.fee), x.ts)
      for (const x of f.funding) { const amount = fx(x.amount); a.cash += amount; a.funding -= amount }
      for (const o of f.openOrders) {
        a.orders.push({
          venueOrderId: o.venueOrderId, clientOrderId: o.clientOrderId, instrumentId: o.instrumentId, side: o.side, type: o.type, tif: o.tif,
          size: fx(o.size), filled: fx(o.filledSize), price: o.price === null ? null : fx(o.price), triggerPrice: o.triggerPrice === null ? null : fx(o.triggerPrice),
          triggerMarket: o.type === 'stop_market' || o.type === 'take_market', avgPx: 0n, fee: 0n, reduceOnly: o.reduceOnly, leverage: o.leverage,
          status: o.triggerPrice !== null && o.status === 'untriggered' ? 'untriggered' : o.status === 'partially_filled' ? 'partially_filled' : o.triggerPrice !== null ? 'untriggered' : 'open',
          role: o.role, ...(o.parentVenueOrderId ? { parentId: o.parentVenueOrderId } : {}), waitingParent: o.waitingParent, slippageCap: null, createdAt: o.createdAt, updatedAt: o.createdAt,
        })
      }
    }
    return this.exportState()
  }

  private applyFill(a: PAcct, o: POrder, px: Fx, sz: Fx, liquidity: 'maker' | 'taker', now: number, liquidation = false): VenueFill {
    const inst = this.market.getInstrument(o.instrumentId)
    const dec0 = inst?.size.decimals ?? 8
    const fee = mul(mul(sz, px), liquidity === 'taker' ? this.rates(inst).taker : this.rates(inst).maker)
    const realized = this.bookFill(a, o.instrumentId, o.side, o.leverage, px, sz, fee, now)
    o.avgPx = o.filled > 0n ? div(mul(o.avgPx, o.filled) + mul(px, sz), o.filled + sz) : px
    o.filled = roundFx(o.filled + sz, dec0, 'half')
    o.fee += fee
    o.updatedAt = now
    if (o.filled >= o.size) { o.status = 'filled'; o.closedAt = now } else o.status = 'partially_filled'
    this.markAll(a)

    const fill: VenueFill = {
      venueOrderId: o.venueOrderId, clientOrderId: o.clientOrderId, venueFillId: `simf-${String(++this.fillSeq).padStart(6, '0')}`, instrumentId: o.instrumentId,
      side: o.side, price: dec(px), size: dec(sz), fee: dec(fee), feeCcy: a.ccy, liquidity, realizedPnl: dec(realized), ...(liquidation ? { liquidation: true } : {}), ts: now,
    }
    a.fills.push(fill)
    if (a.fills.length > KEEP_FILLS) a.fills.splice(0, a.fills.length - KEEP_FILLS)
    this.emit({ kind: 'fill', accountId: a.id, ...(o.legId ? { legId: o.legId } : {}), venueOrderId: o.venueOrderId, clientOrderId: o.clientOrderId, fillId: fill.venueFillId, instrumentId: o.instrumentId, side: o.side, price: dec(px), size: dec(sz), fee: dec(fee), liquidity, realizedPnl: dec(realized), liquidation, ts: now })
    this.emitOrder(a, o)
    this.emit({ kind: 'position', accountId: a.id, instrumentId: o.instrumentId, position: a.positions.has(o.instrumentId) ? this.positionView(a, o.instrumentId, now) : null })
    return fill
  }

  private emitOrder(a: PAcct, o: POrder): void {
    this.emit({ kind: 'order', accountId: a.id, order: orderView(a.id, o) })
  }

  // ───────────── 保证金 / 权益 / 强平价 ─────────────

  private markSampleOf(id: InstrumentId): { price: Fx; ts?: number } | undefined {
    const q = this.market.quote(id)
    if (!q || q.stale || this.clock() - q.ts > this.markStaleMs) return undefined
    const px = q.last ?? (q.bid + q.ask) / 2
    return Number.isFinite(px) && px > 0
      ? { price: fx(px), ...(Number.isSafeInteger(q.ts) && q.ts >= 0 ? { ts: q.ts } : {}) }
      : undefined
  }

  private markOf(id: InstrumentId): Fx | undefined {
    return this.markSampleOf(id)?.price
  }

  private markAll(a: PAcct): boolean {
    let stale = false
    for (const [id, p] of a.positions) {
      const sample = this.markSampleOf(id)
      if (sample !== undefined) {
        p.mark = sample.price
        if (sample.ts !== undefined) p.markTs = sample.ts
        else delete p.markTs
      }
      else stale = true
    }
    return stale
  }

  private mmRate(id: InstrumentId): Fx {
    const lev = this.market.getInstrument(id)?.maxLeverage
    return lev && lev > 0 ? div(fx(1), fx(lev) * MM_DIVISOR) : div(fx(1), fx(40) * MM_DIVISOR)
  }

  private metrics(a: PAcct): { equity: Fx; im: Fx; mm: Fx; notional: Fx; upnl: Fx } {
    let upnl = 0n
    let im = 0n
    let mm = 0n
    let notional = 0n
    for (const [id, p] of a.positions) {
      const n = mul(p.size, p.mark)
      upnl += mul(p.mark - p.entry, p.size) * (p.side === 'long' ? 1n : -1n)
      im += div(n, fx(p.leverage))
      mm += mul(n, this.mmRate(id))
      notional += n
    }
    return { equity: a.cash + upnl, im, mm, notional, upnl }
  }

  /** 新开 / 加仓需要的额外初始保证金（减仓为 0）。 */
  private marginNeeded(a: PAcct, inst: Instrument, side: Side, size: Fx, mark: Fx, leverage: number): Fx {
    const p = a.positions.get(inst.instrumentId)
    const dir = side === 'buy' ? 'long' : 'short'
    let resulting: Fx
    if (!p) resulting = mul(size, mark)
    else if (p.side === dir) resulting = mul(p.size + size, mark)
    else if (size <= p.size) return 0n
    else resulting = mul(size - p.size, mark)
    const have = p && p.side === dir ? div(mul(p.size, mark), fx(p.leverage)) : 0n
    return div(resulting, fx(leverage)) - have
  }

  /** 全仓强平价估算：其它持仓不动，只让这一个标的价格移动到 权益 = 维持保证金。 */
  private liquidationPrice(a: PAcct, id: InstrumentId): Fx | null {
    const p = a.positions.get(id)
    if (!p) return null
    const m = this.metrics(a)
    const mmSelf = mul(mul(p.size, p.mark), this.mmRate(id))
    const mo = m.mm - mmSelf
    const rate = this.mmRate(id)
    const one = fx(1)
    const px = p.side === 'long'
      ? div(mo - m.equity + mul(p.size, p.mark), mul(p.size, one - rate))
      : div(m.equity + mul(p.size, p.mark) - mo, mul(p.size, one + rate))
    return px > 0n ? px : null
  }

  private positionView(a: PAcct, id: InstrumentId, ts: number): Position {
    const p = a.positions.get(id)!
    const n = mul(p.size, p.mark)
    const liq = this.liquidationPrice(a, id)
    return {
      accountId: a.id, instrumentId: id, side: p.side, size: dec(p.size), entryPrice: dec(p.entry), markPrice: dec(p.mark), notional: dec(n),
      unrealizedPnl: dec(mul(p.mark - p.entry, p.size) * (p.side === 'long' ? 1n : -1n)), realizedPnl: dec(p.realized), leverage: p.leverage, marginMode: 'cross',
      initialMargin: dec(div(n, fx(p.leverage))), maintenanceMargin: dec(mul(n, this.mmRate(id))), liquidationPrice: liq === null ? null : dec(liq), estimated: true,
      fundingSinceOpen: dec(p.fundingSinceOpen), openedAt: p.openedAt, updatedAt: ts,
      ...(p.markTs !== undefined ? { markTs: p.markTs } : {}),
    }
  }

  // ───────────── tick：资金费 → 强平 → 触发单 → 挂单 ─────────────

  tick(): Promise<void> {
    return this.lock(async () => {
      const now = this.clock()
      for (const a of this.accounts.values()) {
        this.markAll(a)
        await this.accrueFunding(a, now)
        await this.liquidate(a, now)
        await this.runTriggers(a, now)
        await this.runResting(a, now)
        this.cleanup(a, now)
      }
    })
  }

  private async accrueFunding(a: PAcct, now: number): Promise<void> {
    for (const [id, p] of a.positions) {
      const dt = now - p.lastFundingTs
      if (dt <= 0) continue
      let rate: number | undefined
      try { rate = (await this.market.context(id)).fundingRate } catch { continue } // 取不到费率就不推进时间戳，下个 tick 补算
      if (rate === undefined || !Number.isFinite(rate)) continue
      // 多头在费率为正时付出：payment 为正 = 付出
      const payment = mul(mul(mul(p.size, p.mark), fx(rate)), div(fx(dt), fx(HOUR_MS))) * (p.side === 'long' ? 1n : -1n)
      a.cash -= payment
      a.funding += payment
      p.fundingSinceOpen -= payment // 现金流符号：收到为正
      p.pendingFunding -= payment
      // 跨过整点就出一条资金费记录（累计金额）
      if (Math.floor(now / HOUR_MS) > Math.floor(p.lastFundingTs / HOUR_MS)) {
        this.emit({
          kind: 'funding', accountId: a.id, instrumentId: id, ts: now, rate: str(fx(rate), 10), intervalMs: HOUR_MS,
          positionSize: (p.side === 'long' ? '' : '-') + str(p.size, 10), amount: str(p.pendingFunding, 10),
        })
        p.pendingFunding = 0n
      }
      p.lastFundingTs = now
    }
  }

  private async liquidate(a: PAcct, now: number): Promise<void> {
    for (let guard = 0; guard < 50 && a.positions.size > 0; guard++) {
      this.markAll(a)
      const m = this.metrics(a)
      if (m.equity >= m.mm) return
      // 先平名义额最大的
      const [id, p] = [...a.positions.entries()].sort((x, y) => (mul(y[1].size, y[1].mark) > mul(x[1].size, x[1].mark) ? 1 : -1))[0]!
      const o = this.newOrder(a, {
        clientOrderId: '', instrumentId: id, side: p.side === 'long' ? 'sell' : 'buy', type: 'market', tif: 'ioc', size: p.size, price: null, triggerPrice: null, triggerMarket: false,
        reduceOnly: true, leverage: p.leverage, role: 'parent', slippageCap: null, now,
      })
      o.reason = 'kernel-sim: liquidation'
      this.applyFill(a, o, p.mark, p.size, 'taker', now, true)
      this.emit({ kind: 'liquidation', accountId: a.id, instrumentId: id, size: str(p.size, 10), price: str(p.mark, 10), ts: now })
    }
  }

  private async runTriggers(a: PAcct, now: number): Promise<void> {
    for (const o of a.orders.filter((x) => x.status === 'untriggered' && !x.waitingParent && x.triggerPrice !== null)) {
      const mark = this.markOf(o.instrumentId)
      if (mark === undefined) continue
      const isStop = o.type === 'stop_market' || o.type === 'stop_limit'
      // 止损：买单价格涨到触发价、卖单跌到触发价；止盈相反
      const hit = isStop ? (o.side === 'buy' ? mark >= o.triggerPrice! : mark <= o.triggerPrice!) : (o.side === 'buy' ? mark <= o.triggerPrice! : mark >= o.triggerPrice!)
      if (!hit) continue
      const sz0 = this.clip(a, o, o.size - o.filled)
      if (sz0 <= 0n) { this.finish(a, o, 'cancelled', now, 'trigger fired with nothing to reduce'); continue }
      const book = (await this.l2(o.instrumentId)).book
      if (o.triggerMarket && !book) continue // 没有新鲜盘口：这一轮不触发，下个 tick 再试
      if (o.triggerMarket) {
        const walk = walkBook(o.side, sz0, book, mark, { allowTail: true })
        if (walk.filled > 0n) this.applyFill(a, o, walk.avgPx, walk.filled, 'taker', now)
        if (o.filled < o.size) this.finish(a, o, o.filled > 0n ? 'filled' : 'cancelled', now, 'trigger market order finished')
      } else {
        // 触发后变限价单：穿价部分当场吃，剩余挂单
        o.status = 'open'
        o.triggerPrice = null
        await this.matchResting(a, o, now, true)
      }
      this.emitOrder(a, o)
    }
  }

  private async runResting(a: PAcct, now: number): Promise<void> {
    for (const o of a.orders.filter((x) => (x.status === 'open' || x.status === 'partially_filled') && x.type !== 'market')) await this.matchResting(a, o, now)
  }

  /**
   * 挂单撮合。tick 时碰到限价：按限价整笔成交（maker，无排队，见 ASSUMPTIONS.md）；
   * immediate = 改价 / 触发转限价那一刻就穿价：先当 taker 吃盘口（不越过限价），剩余挂单。
   */
  private async matchResting(a: PAcct, o: POrder, now: number, immediate = false): Promise<void> {
    if (o.price === null) return
    const book = (await this.l2(o.instrumentId)).book
    if (!book) return // 没有新鲜盘口：不撮合，下个 tick 再试
    const want = this.clip(a, o, o.size - o.filled)
    if (want <= 0n) {
      if (o.reduceOnly) this.finish(a, o, 'cancelled', now, 'no position left to reduce')
      return
    }
    if (!limitCrosses(o.side, o.price, book)) return
    if (immediate) {
      const walk = walkBook(o.side, want, book, o.price, { cap: o.price, allowTail: false })
      if (walk.filled > 0n) this.applyFill(a, o, walk.avgPx, walk.filled, 'taker', now)
      return
    }
    if (!o.reduceOnly) {
      this.markAll(a)
      const m = this.metrics(a)
      const inst = this.market.getInstrument(o.instrumentId)
      const need = inst ? this.marginNeeded(a, inst, o.side, want, this.markOf(o.instrumentId) ?? o.price, o.leverage) : 0n
      if (need > 0n && need > m.equity - m.im) { this.finish(a, o, 'cancelled', now, 'insufficient margin when the resting order was touched'); return }
    }
    this.applyFill(a, o, o.price, want, 'maker', now)
    if (o.filled >= o.size) this.activateChildren(a, o)
  }

  private cleanup(a: PAcct, now: number): void {
    // 持仓没了，遗留的只减仓挂单 / 触发单没有意义，场所会撤掉
    for (const o of a.orders.filter((x) => isLive(x) && x.reduceOnly && !x.waitingParent)) {
      const pos = a.positions.get(o.instrumentId)
      const opposite = !!pos && ((o.side === 'buy' && pos.side === 'short') || (o.side === 'sell' && pos.side === 'long'))
      if (!opposite) this.finish(a, o, 'cancelled', now, 'no position left to reduce')
    }
  }

  // ───────────── 状态导出 / 导入（内核重启后恢复纸面账户） ─────────────

  exportState(): string {
    const replacer = (_k: string, v: unknown) => (typeof v === 'bigint' ? { $b: v.toString() } : v instanceof Map ? { $m: [...v.entries()] } : v)
    return JSON.stringify({ v: 1, orderSeq: this.orderSeq, fillSeq: this.fillSeq, accounts: [...this.accounts.values()] }, replacer)
  }

  importState(json: string): void {
    const reviver = (_k: string, v: unknown): unknown => {
      if (v && typeof v === 'object') {
        const o = v as { $b?: string; $m?: unknown }
        if (typeof o.$b === 'string') return BigInt(o.$b)
        if (Array.isArray(o.$m)) return new Map(o.$m as Array<[unknown, unknown]>)
      }
      return v
    }
    const s = JSON.parse(json, reviver) as { v: number; orderSeq: number; fillSeq: number; accounts: PAcct[] }
    if (!s || typeof s !== 'object') throw new Error('paper state is not an object')
    if (s.v !== 1) throw new Error(`unsupported paper state version ${s.v}`)
    // fix-r2 S1：字段合法才导入（坏文件不得变成「空场所」或怪数）；序号只增不减由内核对照账本另查。
    if (!Number.isSafeInteger(s.orderSeq) || s.orderSeq < 0 || !Number.isSafeInteger(s.fillSeq) || s.fillSeq < 0) throw new Error('paper state sequence numbers are invalid')
    if (!Array.isArray(s.accounts)) throw new Error('paper state accounts are missing')
    const ids = new Set<string>()
    for (const a of s.accounts) {
      if (!a || typeof a.id !== 'string' || !a.id || ids.has(a.id)) throw new Error('paper state account id is invalid or duplicated')
      ids.add(a.id)
      for (const k of ['initial', 'cash', 'realized', 'fees', 'funding'] as const) if (typeof a[k] !== 'bigint') throw new Error(`paper state account ${a.id} field ${k} is invalid`)
      if (a.initial < 0n) throw new Error(`paper state account ${a.id} initial balance is negative`)
      if (!(a.positions instanceof Map) || !(a.leverage instanceof Map) || !Array.isArray(a.orders) || !Array.isArray(a.fills)) throw new Error(`paper state account ${a.id} structure is invalid`)
      for (const [id, p] of a.positions) if (!p || typeof p.size !== 'bigint' || p.size <= 0n || typeof p.entry !== 'bigint' || p.entry <= 0n || (p.side !== 'long' && p.side !== 'short')) throw new Error(`paper state position ${a.id}/${String(id)} is invalid`)
      for (const o of a.orders) if (!o || typeof o.venueOrderId !== 'string' || typeof o.size !== 'bigint' || typeof o.filled !== 'bigint' || o.filled < 0n || o.filled > o.size) throw new Error(`paper state order in ${a.id} is invalid`)
    }
    this.orderSeq = s.orderSeq
    this.fillSeq = s.fillSeq
    this.accounts.clear()
    for (const a of s.accounts) this.accounts.set(a.id, a)
    // fix-r2 K1：落盘可能停在「父单已成交、子单还在等父单」或「父单已撤、子单还在等」的半个事务上——导入时补完（静默，不发事件）。
    const now = this.clock()
    for (const a of this.accounts.values()) {
      for (const c of a.orders) {
        if (!c.waitingParent || !c.parentId || !isLive(c)) continue
        const parent = a.orders.find((o) => o.venueOrderId === c.parentId)
        if (parent && parent.filled >= parent.size) { c.waitingParent = false; c.updatedAt = now }
        else if (!parent || (!isLive(parent) && parent.filled < parent.size)) { c.status = 'cancelled'; c.updatedAt = now; c.closedAt = now; c.reason = 'kernel-sim: parent order canceled' }
      }
    }
  }
}

const isLive = (o: POrder): boolean => o.status === 'open' || o.status === 'untriggered' || o.status === 'partially_filled'

function orderView(accountId: string, o: POrder): PaperOrderView {
  return {
    venueOrderId: o.venueOrderId, clientOrderId: o.clientOrderId, accountId, instrumentId: o.instrumentId, side: o.side, type: o.type, tif: o.tif,
    size: str(o.size, 10), filledSize: str(o.filled, 10), price: o.price === null ? null : str(o.price, 10), triggerPrice: o.triggerPrice === null ? null : str(o.triggerPrice, 10),
    avgFillPrice: o.filled > 0n ? str(o.avgPx, 10) : null, fee: str(o.fee, 10), reduceOnly: o.reduceOnly, leverage: o.leverage, status: o.status, role: o.role,
    ...(o.legId ? { legId: o.legId } : {}), ...(o.parentId ? { parentVenueOrderId: o.parentId } : {}), ...(o.reason ? { reason: o.reason } : {}), createdAt: o.createdAt, updatedAt: o.updatedAt, ...(o.closedAt ? { closedAt: o.closedAt } : {}),
  }
}

/** 携带 Problem 的错误（与连接器的 ProblemError 同形：有 .problem）。 */
export class PaperProblemError extends Error {
  constructor(readonly problem: Problem) {
    super(problem.venue?.message ?? problem.message)
    this.name = 'ProblemError'
  }
}
