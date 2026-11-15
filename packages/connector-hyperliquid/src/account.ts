// SPDX-License-Identifier: CPAL-1.0
// 账户读取（只读，不需要签名）：账户模式感知的余额 / 保证金 / 持仓、挂单、成交、订单状态、启动对账。
// 铁律（知识库「API钱包」「账户模式与保证金」）：
//   · 查询必须用主 / 子账户的真实地址，不是 API 钱包地址（传错得到空结果）；
//   · standard 模式各 dex 余额分开，要逐 dex 读；统一账户 / 组合保证金模式下余额与占用都在现货清算状态里。
// 未对真账户验证过的部分（尤其统一 / 组合保证金下的保证金口径）在 README 与回报里标明。
import { makeProblem, normalizeDecimal } from '@gitrader/protocol'
import { ProblemError } from './errors'
import type { Balance, Decimal, MarginMode, MarginSnapshot, Position, VenueRules } from '@gitrader/protocol'
import { abs, div, fx, mul, str } from '@gitrader/protocol/decimal'
import type { HlHttp } from './rest'
import type { HlMarket } from './market'
import { instrumentIdOf, MARKET_PRICE_BAND_BPS, MIN_ORDER_NOTIONAL, num } from './parse'
import type {
  AccountRef, AccountSnapshot, Hex, StartupSnapshot, VenueFill, VenueOpenOrder, VenueOrderStatus,
} from '@gitrader/protocol/connector'

type Model = AccountSnapshot['accountModel']

interface RawPosition {
  coin: string
  szi: string
  leverage?: { type?: string; value?: number }
  entryPx?: string | null
  positionValue?: string
  unrealizedPnl?: string
  liquidationPx?: string | null
  marginUsed?: string
  cumFunding?: { sinceOpen?: string }
}
interface RawClearinghouse {
  marginSummary?: { accountValue?: string; totalNtlPos?: string; totalMarginUsed?: string }
  crossMaintenanceMarginUsed?: string
  withdrawable?: string
  assetPositions?: Array<{ position: RawPosition }>
  time?: number
}
interface RawSpotState { balances?: Array<{ coin: string; total: string; hold: string }> }
export interface RawFill {
  coin: string; px: string; sz: string; side: 'B' | 'A'; time: number; closedPnl: string; oid: number; tid: number
  crossed?: boolean; fee: string; feeToken?: string; builderFee?: string; cloid?: string; liquidation?: unknown
}
interface RawOpenOrder {
  coin: string; side: 'B' | 'A'; limitPx: string; sz: string; origSz?: string; oid: number; timestamp: number
  reduceOnly?: boolean; isTrigger?: boolean; triggerPx?: string; orderType?: string; cloid?: string
}

const dec = (s: string | undefined | null, fallback = '0'): Decimal => normalizeDecimal(s ?? fallback)
/** 没有行情时的标记价：持仓价值 ÷ 数量（场所给的 positionValue 就是按标记价算的）；取不到返回 undefined。 */
const impliedMark = (p: RawPosition, szi: bigint): Decimal | undefined => {
  if (szi === 0n || p.positionValue === undefined) return undefined
  try { return dec(str(div(abs(fx(p.positionValue)), abs(szi)), 8)) } catch { return undefined }
}
const cloidOut = (c: string | undefined): string | null => (c ? c.replace(/^0x/, '').toLowerCase() : null)

export function mapFill(f: RawFill): VenueFill {
  return {
    venueOrderId: String(f.oid),
    clientOrderId: cloidOut(f.cloid),
    venueFillId: String(f.tid),
    instrumentId: instrumentIdOf(f.coin),
    side: f.side === 'B' ? 'buy' : 'sell',
    price: dec(f.px),
    size: dec(f.sz),
    fee: dec(f.fee),
    feeCcy: f.feeToken ?? 'USDC',
    ...(f.builderFee !== undefined ? { builderFee: dec(f.builderFee) } : {}),
    liquidity: f.crossed ? 'taker' : 'maker',
    realizedPnl: dec(f.closedPnl),
    ...(f.liquidation ? { liquidation: true } : {}),
    ts: f.time,
  }
}

const ORDER_TYPES: Record<string, VenueOpenOrder['type']> = {
  Limit: 'limit', 'Stop Market': 'stop_market', 'Stop Limit': 'stop_limit', 'Take Profit Market': 'take_market', 'Take Profit Limit': 'take_limit',
}

const compareText = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0
export function mapOpenOrder(o: RawOpenOrder, prev?: VenueOpenOrder): VenueOpenOrder {
  const isTrigger = o.isTrigger !== undefined ? o.isTrigger : (prev?.isTrigger ?? false)
  const triggerPrice = o.isTrigger === false
    ? null
    : o.triggerPx !== undefined && o.triggerPx !== '' ? dec(o.triggerPx) : (prev?.triggerPrice ?? null)
  return {
    instrumentId: instrumentIdOf(o.coin),
    venueOrderId: String(o.oid),
    clientOrderId: cloidOut(o.cloid),
    side: o.side === 'B' ? 'buy' : 'sell',
    // WS 的 openOrders 推送不一定带 orderType / 触发信息：认不出来就沿用已知的，再不行标 unknown，不猜
    type: o.orderType !== undefined ? (ORDER_TYPES[o.orderType] ?? 'unknown') : (prev?.type ?? 'unknown'),
    price: o.limitPx ? dec(o.limitPx) : null,
    triggerPrice,
    size: dec(o.sz),
    origSize: dec(o.origSz ?? o.sz),
    reduceOnly: o.reduceOnly !== undefined ? o.reduceOnly : (prev?.reduceOnly ?? false),
    isTrigger,
    createdAt: o.timestamp,
  }
}

/** 账户快照 + 新鲜度标记。TODO(protocol): asOf / stale / source 是追加字段，protocol 的 AccountSnapshot 里还没有。 */
export type CachedAccountSnapshot = AccountSnapshot & {
  /** 这份数据最后一次被场所确认 / 更新的时刻（ms）。账户没动静时 WS 不推，所以它可以比 now 老很多——是否可信看 stale。 */
  asOf: number
  confirmedAt?: number
  /** true = 现在不能当实时数据用：WS 断了且 REST 兜底也过期，或还没拿到首批快照。 */
  stale: boolean
  source: 'ws' | 'rest'
}

export interface AccountView {
  snapshot: CachedAccountSnapshot
  openOrders: VenueOpenOrder[]
  fills: VenueFill[]
  asOf: number
  stale: boolean
  source: 'ws' | 'rest'
}

export interface AccountsOptions {
  /** true（默认）：账户 / 持仓 / 挂单 / 成交走 WS 用户流增量维护；false：禁用账户 WS，仍读本地缓存并后台刷新。 */
  stream?: boolean
  /** @deprecated 保留兼容；账户视图不再等待首批 WS 快照。 */
  readyTimeoutMs?: number
  /** WS 不可用时 REST 兜底的最小刷新间隔，默认 10 s。 */
  restFallbackMs?: number
  /** 同时跟踪的账户数上限（官方：用户级订阅涉及的不同用户 ≤10 / IP），默认 10。 */
  maxTracked?: number
  /** 账户模式缓存时间，默认 1 小时。 */
  modelTtlMs?: number
  /** 账户视图里动态规则使用的市价带宽，默认场所能力值。 */
  marketPriceBandBps?: number
}

interface RestFlight { controller: AbortController; promise: Promise<void>; attemptedAt: number }
interface ModelFlight { controller: AbortController; promise: Promise<void> }
interface HistoryCoverage { sinceMs: number; fills: VenueFill[]; truncated: boolean; completedAt: number }
interface HistoryFlight { controller: AbortController; promise: Promise<void>; sinceMs: number }

interface Tracked {
  ref: AccountRef
  user: string
  model: Model
  modelKnown: boolean
  clearing: Map<string, RawClearinghouse>
  spot: RawSpotState | null
  orders: Map<string, VenueOpenOrder[]>
  fills: VenueFill[]
  fillIds: Set<string>
  trackedSince: number
  seen: { clearing: number; spot: number; orders: Map<string, number>; fills: number }
  wsWriteSeq: number
  lastWsWrite: Map<string, number>
  source: 'ws' | 'rest'
  restAt: number | null
  confirmedAt?: number
  wsConfirmedConnection?: number
  wsEvidenceAt?: number
  version: number
  built: { version: number; liveKey: string; snapshot: AccountSnapshot } | null
  unsubs: Array<() => void>
  ordersUnsubs: Map<string, () => void>
  isReady: boolean
  restFlight?: RestFlight
  lastRestAttemptAt: number | null
  modelFlight?: ModelFlight
  modelAttemptedAt: number | null
  history?: HistoryCoverage
  historyFlight?: HistoryFlight
  historyAttemptedAt: number | null
  historyPendingSinceMs?: number
}

const FILL_KEEP = 2000
const USER_RATE_LIMIT_TTL_MS = 60_000
const WARNING_RATE_LIMIT_MS = 10 * 60_000

function capFromCumVlm(value: unknown): number | undefined {
  if (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value)) return undefined
  const [whole, fraction = ''] = value.split('.')
  const scale = 10n ** BigInt(fraction.length)
  const volume = BigInt(whole!) * scale + BigInt(fraction || '0')
  const increments = volume / (scale * 5_000_000n)
  const cap = 1000n + increments
  return Number(cap > 5000n ? 5000n : cap)
}

export class HlAccounts {
  private readonly tracked = new Map<string, Tracked>()
  private readonly models = new Map<string, { model: Model; at: number }>()
  private readonly userOpenOrderCaps = new Map<string, { attemptedAt: number; cap?: number }>()
  private readonly userOpenOrderCapInflight = new Map<string, { promise: Promise<number | undefined>; controller: AbortController }>()
  private readonly warningAt = new Map<string, number>()
  private closed = false
  private readonly o: Required<AccountsOptions>
  private unsubInstruments: (() => void) | null = null

  constructor(private readonly http: HlHttp, private readonly market: HlMarket, private readonly clock: () => number = () => Date.now(), opts: AccountsOptions = {}) {
    this.o = { stream: opts.stream ?? true, readyTimeoutMs: opts.readyTimeoutMs ?? 5000, restFallbackMs: opts.restFallbackMs ?? 10_000, maxTracked: opts.maxTracked ?? 10, modelTtlMs: opts.modelTtlMs ?? 3_600_000, marketPriceBandBps: opts.marketPriceBandBps ?? MARKET_PRICE_BAND_BPS }
  }

  get streaming(): boolean { return this.o.stream }

  // ───────────── 账户模式 / builder 授权 ─────────────

  /** userAbstraction → 账户模式（带缓存：模式几乎不变，不值得每次花 20 权重）。 */
  async detectModel(address: Hex, force = false): Promise<Model> {
    const key = address.toLowerCase()
    const hit = this.models.get(key)
    if (!force && hit && this.clock() - hit.at < this.o.modelTtlMs) return hit.model
    const raw = await this.http.info<unknown>({ type: 'userAbstraction', user: key })
    const model = modelOf(raw)
    this.models.set(key, { model, at: this.clock() })
    return model
  }

  /** builder 授权状态：maxBuilderFee（单位 = 十分之一基点）≥ 10（1 bp）才算已授权。 */
  async builderStatus(address: Hex, builder: Hex): Promise<{ status: 'approved' | 'not_approved'; maxFeeTenthBps: number }> {
    const raw = await this.http.info<unknown>({ type: 'maxBuilderFee', user: address.toLowerCase(), builder: builder.toLowerCase() })
    const n = num(raw)
    const max = Number.isNaN(n) ? 0 : n
    return { status: max >= 10 ? 'approved' : 'not_approved', maxFeeTenthBps: max }
  }

  private liveDexes(): string[] {
    return ['', ...this.market.dexStatus().filter((d) => d.dex !== '' && d.status === 'live').map((d) => d.dex)]
  }

  // ───────────── 对外读取（读本地快照，不打 REST）─────────────

  async view(ref: AccountRef): Promise<AccountView> {
    const t = this.track(ref)
    const view = this.viewOf(t)
    this.startModelDetection(t)
    if (!t.isReady || !this.accountWsHealthy(t)) this.requestRestRefresh(t)
    return view
  }

  async snapshot(ref: AccountRef): Promise<CachedAccountSnapshot> { return (await this.view(ref)).snapshot }
  async openOrders(ref: AccountRef): Promise<VenueOpenOrder[]> { return (await this.view(ref)).openOrders }

  /**
   * 直接问场所要挂单（REST，按交易动作记权重）。撤全部这种安全相关的动作不能信本地快照：宁可多花一点权重。
   */
  async openOrdersFresh(ref: AccountRef): Promise<VenueOpenOrder[]> {
    const user = ref.address.toLowerCase()
    const out: VenueOpenOrder[] = []
    for (const dex of this.liveDexes()) {
      const raw = await this.http.info<RawOpenOrder[]>(dex === '' ? { type: 'frontendOpenOrders', user } : { type: 'frontendOpenOrders', user, dex }, { kind: 'trade' })
      for (const o of raw ?? []) out.push(mapOpenOrder(o))
    }
    return out
  }

  /** 成交：请求的起点不早于开始跟踪的时刻就读本地；更早的是历史回补，走 REST 分页。 */
  async fills(ref: AccountRef, sinceMs: number): Promise<VenueFill[]> {
    if (this.o.stream) {
      const t = this.track(ref)
      if (sinceMs >= t.trackedSince) return (await this.view(ref)).fills.filter((f) => f.ts >= sinceMs)
    }
    return (await this.fillsPaged(ref, sinceMs)).fills
  }

  private viewOf(t: Tracked): AccountView {
    const cap = this.userOpenOrderCap(t.ref.address)
    const now = this.clock()
    const live = this.liveDexes()
    const liveKey = live.join(',')
    if (!t.built || t.built.version !== t.version || t.built.liveKey !== liveKey) {
      const perDex = live.filter((d) => t.clearing.has(d)).map((dex) => ({ dex, st: t.clearing.get(dex)! }))
      t.built = { version: t.version, liveKey, snapshot: this.build(t.ref, t.model, perDex, t.spot ?? { balances: [] }, this.asOfOf(t)) }
    }
    const asOf = this.asOfOf(t)
    const wsHealthy = this.accountWsHealthy(t)
    const restFresh = t.restAt !== null && now - t.restAt <= this.o.restFallbackMs * 2
    const stale = !t.isReady || !t.modelKnown || (!wsHealthy && !restFresh)
    const complete = t.isReady && t.modelKnown
    if (complete && wsHealthy) t.confirmedAt = Math.max(t.confirmedAt ?? Number.NEGATIVE_INFINITY, now)
    if (complete && t.restAt !== null) t.confirmedAt = Math.max(t.confirmedAt ?? Number.NEGATIVE_INFINITY, t.restAt)
    const openOrders = live.flatMap((d) => t.orders.get(d) ?? [])
    const derived = this.snapshotFields(openOrders, cap)
    return {
      snapshot: { ...t.built.snapshot, ...derived, ts: asOf, asOf, ...(t.confirmedAt !== undefined ? { confirmedAt: t.confirmedAt } : {}), stale, source: t.source },
      openOrders: openOrders.map((o) => ({ ...o })),
      fills: t.fills.map((f) => ({ ...f })),
      asOf, stale, source: t.source,
    }
  }

  private accountWsHealthy(t: Tracked): boolean {
    return this.market.wsHealthy
      && t.wsConfirmedConnection === this.market.wsConnectionGeneration
      && t.wsEvidenceAt !== undefined
      && this.clock() - t.wsEvidenceAt <= this.o.restFallbackMs * 2
  }

  private warn(message: string): void {
    const now = this.clock()
    const last = this.warningAt.get(message)
    if (last !== undefined && now - last < WARNING_RATE_LIMIT_MS) return
    this.warningAt.set(message, now)
    this.http.warn(message)
  }

  private asOfOf(t: Tracked): number {
    return Math.max(t.seen.clearing, t.seen.spot, t.seen.fills, ...t.seen.orders.values(), t.trackedSince)
  }

  private snapshotFields(orders: VenueOpenOrder[], cap: number | undefined): Pick<AccountSnapshot, 'availableDeductsOpenOrders' | 'openOrders' | 'stopLossOrderIds' | 'rules'> {
    const groups = new Map<string, { instrumentId: VenueOpenOrder['instrumentId']; side: VenueOpenOrder['side']; notional: bigint; count: number }>()
    for (const order of orders) {
      if (order.reduceOnly) continue
      const record = this.market.getRecord(order.instrumentId)
      const quote = this.market.quote(order.instrumentId)
      const price = order.price ?? order.triggerPrice ?? (quote?.last !== undefined ? String(quote.last) : undefined)
      if (price === undefined) throw new ProblemError(makeProblem('STALE_PRICE', 'cannot derive open-order exposure without a known price'))
      const contractSize = record?.instrument.contractSize ?? '1'
      const lineNotional = mul(mul(fx(order.size), fx(price)), fx(contractSize))
      const key = `${order.instrumentId}\u0000${order.side}`
      const group = groups.get(key) ?? { instrumentId: order.instrumentId, side: order.side, notional: 0n, count: 0 }
      group.notional += lineNotional
      group.count++
      groups.set(key, group)
    }
    const openOrders = [...groups.values()]
      .sort((a, b) => compareText(a.instrumentId, b.instrumentId) || compareText(a.side, b.side))
      .map((g) => ({ instrumentId: g.instrumentId, side: g.side, notional: normalizeDecimal(str(g.notional)), count: g.count }))
    const stopLossOrderIds = orders
      .filter((o) => o.reduceOnly && (o.type === 'stop_market' || o.type === 'stop_limit' || (o.type === 'unknown' && o.isTrigger)))
      .sort((a, b) => compareText(a.instrumentId, b.instrumentId) || compareText(a.venueOrderId, b.venueOrderId))
      .map((o) => o.venueOrderId)
    const rules: VenueRules = {
      marketPriceBandBps: this.o.marketPriceBandBps,
      minOrderNotional: normalizeDecimal(MIN_ORDER_NOTIONAL),
      ...(cap !== undefined ? { maxOpenOrders: { cap, current: orders.length } } : {}),
    }
    return { availableDeductsOpenOrders: true, openOrders, stopLossOrderIds, rules }
  }

  private userOpenOrderCap(address: Hex): number | undefined {
    const user = address.toLowerCase()
    const cached = this.userOpenOrderCaps.get(user)
    const now = this.clock()
    if (this.closed) return cached?.cap
    if (cached && now - cached.attemptedAt < USER_RATE_LIMIT_TTL_MS) return cached.cap
    if (this.userOpenOrderCapInflight.has(user)) return cached?.cap
    const attemptedAt = now
    const controller = new AbortController()
    let request!: Promise<number | undefined>
    request = (async () => {
      let cap: number | undefined
      try {
        const raw = await this.http.info<{ cumVlm?: unknown }>({ type: 'userRateLimit', user }, { kind: 'background', signal: controller.signal })
        cap = capFromCumVlm(raw?.cumVlm)
        if (cap === undefined) this.warn('挂单限额响应无效；保留已缓存限额')
      } catch {
        if (!controller.signal.aborted) this.warn('挂单限额刷新失败；保留已缓存限额')
      }
      if (this.userOpenOrderCapInflight.get(user)?.promise === request) {
        const nextCap = cap ?? cached?.cap
        this.userOpenOrderCaps.set(user, { attemptedAt, ...(nextCap !== undefined ? { cap: nextCap } : {}) })
        this.userOpenOrderCapInflight.delete(user)
      }
      return cap
    })()
    this.userOpenOrderCaps.set(user, { attemptedAt, ...(cached?.cap !== undefined ? { cap: cached.cap } : {}) })
    this.userOpenOrderCapInflight.set(user, { promise: request, controller })
    return cached?.cap
  }

  // ───────────── 跟踪（WS 用户流）─────────────

  /** 同步登记账户并立即挂订阅；模型探测与账户引导都在后台执行。 */
  private track(ref: AccountRef): Tracked {
    const user = ref.address.toLowerCase()
    const existing = this.tracked.get(user)
    if (existing) {
      existing.ref = { ...existing.ref, ...ref } // builder 状态等会变
      if (ref.accountModel) {
        existing.model = ref.accountModel
        existing.modelKnown = true
        existing.version += 1
      }
      return existing
    }
    if (this.tracked.size >= this.o.maxTracked) {
      throw new ProblemError(makeProblem('BUSY', `at most ${this.o.maxTracked} accounts can be tracked per connection (venue limit: 10 distinct users in user subscriptions per IP)`))
    }
    const modelCache = this.models.get(user)
    const modelKnown = ref.accountModel !== undefined || (!!modelCache && this.clock() - modelCache.at < this.o.modelTtlMs)
    const model = ref.accountModel ?? (modelKnown ? modelCache!.model : 'standard')
    const now = this.clock()
    const t: Tracked = {
      ref, user, model, modelKnown, clearing: new Map(), spot: null, orders: new Map(), fills: [], fillIds: new Set(), trackedSince: now,
      seen: { clearing: 0, spot: 0, orders: new Map(), fills: 0 }, wsWriteSeq: 0, lastWsWrite: new Map(), source: 'ws', restAt: null, version: 0, built: null,
      unsubs: [], ordersUnsubs: new Map(), isReady: false, lastRestAttemptAt: null, modelAttemptedAt: null, historyAttemptedAt: null,
    }
    this.tracked.set(user, t)
    if (this.o.stream && this.market.hasWs) this.attach(t)
    if (this.o.stream && !this.unsubInstruments) {
      this.unsubInstruments = this.market.subscribe({ channel: 'instruments' }, () => { for (const x of this.tracked.values()) this.syncOrderSubs(x) })
    }
    return t
  }

  untrack(address: Hex): void {
    const user = address.toLowerCase()
    const t = this.tracked.get(user)
    if (t) {
      t.restFlight?.controller.abort()
      t.modelFlight?.controller.abort()
      t.historyFlight?.controller.abort()
      for (const u of t.unsubs) u()
      for (const u of t.ordersUnsubs.values()) u()
      this.tracked.delete(t.user)
    }
    this.userOpenOrderCaps.delete(user)
    const inflight = this.userOpenOrderCapInflight.get(user)
    inflight?.controller.abort()
    this.userOpenOrderCapInflight.delete(user)
  }

  close(): void {
    this.closed = true
    for (const t of [...this.tracked.values()]) this.untrack(t.ref.address)
    for (const inflight of this.userOpenOrderCapInflight.values()) inflight.controller.abort()
    this.userOpenOrderCapInflight.clear()
    this.userOpenOrderCaps.clear()
    this.warningAt.clear()
    this.unsubInstruments?.()
    this.unsubInstruments = null
  }

  private attach(t: Tracked): void {
    // 聚合 allDexsAssetCtxs 订阅优化留 r1.2；本轮 mark 已由 market 的 activeAssetCtx 常驻，账户确认仍来自匹配的账户回执或有效账户推送。
    const mine = (d: { user?: string } | undefined) => (d?.user ?? '').toLowerCase() === t.user
    const onClearingAck = () => this.confirmWs(t)
    t.unsubs.push(
      this.market.subscribeRaw({ type: 'allDexsClearinghouseState', user: t.user }, 'allDexsClearinghouseState', (d: { user?: string; clearinghouseStates?: Array<[string, RawClearinghouse]> }, ts) => {
        if (!mine(d) || !Array.isArray(d.clearinghouseStates)) return
        const seq = ++t.wsWriteSeq
        for (const [dex, st] of d.clearinghouseStates) {
          const key = `clearing:${dex ?? ''}`
          t.clearing.set(dex ?? '', st)
          t.lastWsWrite.set(key, seq)
        }
        t.seen.clearing = Math.max(t.seen.clearing, ts)
        this.touch(t)
        this.confirmWs(t)
      }, onClearingAck),
      this.market.subscribeRaw({ type: 'spotState', user: t.user }, 'spotState', (d: { user?: string; spotState?: RawSpotState }, ts) => {
        if (!mine(d) || !d.spotState) return
        t.lastWsWrite.set('spot', ++t.wsWriteSeq)
        t.spot = d.spotState
        t.seen.spot = ts
        this.touch(t)
      }),
      this.market.subscribeRaw({ type: 'userFills', user: t.user }, 'userFills', (d: { user?: string; isSnapshot?: boolean; fills?: RawFill[] }, ts) => {
        if (!mine(d) || !Array.isArray(d.fills)) return
        for (const f of d.fills) this.addFill(t, mapFill(f))
        t.seen.fills = ts
        this.touch(t)
      }),
    )
    this.syncOrderSubs(t)
  }

  /** 挂单按 dex 订阅（每个在线 dex 一条，推送整张列表）；dex 增减时对齐。 */
  private syncOrderSubs(t: Tracked): void {
    if (!this.market.hasWs) return
    const want = new Set(this.liveDexes())
    for (const dex of want) {
      if (t.ordersUnsubs.has(dex)) continue
      const sub = dex === '' ? { type: 'openOrders', user: t.user } : { type: 'openOrders', user: t.user, dex }
      t.ordersUnsubs.set(dex, this.market.subscribeRaw(sub, 'openOrders', (d: { user?: string; dex?: string; orders?: RawOpenOrder[] }, ts) => {
        if ((d?.user ?? '').toLowerCase() !== t.user || (d.dex ?? '') !== dex || !Array.isArray(d.orders)) return
        t.lastWsWrite.set(`orders:${dex}`, ++t.wsWriteSeq)
        const prev = new Map((t.orders.get(dex) ?? []).map((o) => [o.venueOrderId, o]))
        t.orders.set(dex, d.orders.map((o) => mapOpenOrder(o, prev.get(String(o.oid)))))
        t.seen.orders.set(dex, ts)
        this.touch(t)
      }))
    }
    for (const [dex, un] of [...t.ordersUnsubs]) {
      if (want.has(dex)) continue
      un()
      t.ordersUnsubs.delete(dex)
      t.orders.delete(dex)
      t.seen.orders.delete(dex)
      t.lastWsWrite.delete(`clearing:${dex}`)
      t.lastWsWrite.delete(`orders:${dex}`)
    }
  }

  private touch(t: Tracked): void {
    t.version += 1
    t.source = 'ws'
    if (!t.isReady && t.spot && t.clearing.size > 0 && this.liveDexes().every((d) => t.orders.has(d))) {
      t.isReady = true
    }
  }

  private confirmWs(t: Tracked): void {
    t.wsConfirmedConnection = this.market.wsConnectionGeneration
    t.wsEvidenceAt = this.clock()
    if (t.isReady && t.modelKnown) t.confirmedAt = Math.max(t.confirmedAt ?? Number.NEGATIVE_INFINITY, this.clock())
  }

  private addFill(t: Tracked, f: VenueFill): void {
    if (t.fillIds.has(f.venueFillId)) return
    t.fillIds.add(f.venueFillId)
    t.fills.push(f)
    if (t.fills.length > FILL_KEEP) {
      const drop = t.fills.splice(0, t.fills.length - FILL_KEEP)
      for (const d of drop) t.fillIds.delete(d.venueFillId)
    }
  }

  // ───────────── REST（启动对账 / 断线恢复 / 对比基准）─────────────

  private startModelDetection(t: Tracked): void {
    if (t.modelKnown || t.modelFlight || this.closed) return
    const cached = this.models.get(t.user)
    if (cached && this.clock() - cached.at < this.o.modelTtlMs) {
      t.model = cached.model
      t.modelKnown = true
      t.version += 1
      return
    }
    if (t.modelAttemptedAt !== null && this.clock() - t.modelAttemptedAt < this.o.restFallbackMs) return
    const controller = new AbortController()
    t.modelAttemptedAt = this.clock()
    let promise!: Promise<void>
    promise = (async () => {
      try {
        const raw = await this.http.info<unknown>({ type: 'userAbstraction', user: t.user }, { kind: 'background', signal: controller.signal })
        if (this.tracked.get(t.user) !== t || this.closed || controller.signal.aborted) return
        const model = modelOf(raw)
        const at = this.clock()
        this.models.set(t.user, { model, at })
        t.model = model
        t.modelKnown = true
        t.version += 1
      } catch {
        if (!controller.signal.aborted) this.warn('账户模式后台检测失败；保留暂定模式')
      } finally {
        if (t.modelFlight?.promise === promise) t.modelFlight = undefined
      }
    })()
    t.modelFlight = { controller, promise }
  }

  /** 按账户单飞后台刷新；读取路径只安排工作，不等待预算或 HTTP。 */
  private requestRestRefresh(t: Tracked): void {
    if (this.closed || this.tracked.get(t.user) !== t || t.restFlight) return
    const attemptedAt = this.clock()
    if (t.lastRestAttemptAt !== null && attemptedAt - t.lastRestAttemptAt < this.o.restFallbackMs) return
    const controller = new AbortController()
    const startSeq = t.wsWriteSeq
    let promise!: Promise<void>
    promise = (async () => {
      try {
        const raw = await this.fetchRest(t.ref, controller.signal)
        if (this.tracked.get(t.user) !== t || this.closed || controller.signal.aborted) return
        const now = this.clock()
        const dexes = this.liveDexes()
        let preservedWs = false
        let restClearingWritten = false
        let restSpotWritten = false
        const clearing = new Map(t.clearing)
        const orders = new Map(t.orders)
        const seenOrders = new Map(t.seen.orders)
        for (const { dex, st } of raw.perDex) {
          if (!dexes.includes(dex)) continue
          if ((t.lastWsWrite.get(`clearing:${dex}`) ?? 0) > startSeq) {
            preservedWs = true
            continue
          }
          clearing.set(dex, st)
          restClearingWritten = true
        }
        for (const dex of dexes) {
          if ((t.lastWsWrite.get(`orders:${dex}`) ?? 0) > startSeq) {
            preservedWs = true
            continue
          }
          orders.set(dex, raw.ordersByDex.get(dex) ?? [])
          seenOrders.set(dex, Math.max(seenOrders.get(dex) ?? Number.NEGATIVE_INFINITY, now))
        }
        const spot = (t.lastWsWrite.get('spot') ?? 0) > startSeq ? t.spot : raw.spot
        if ((t.lastWsWrite.get('spot') ?? 0) > startSeq) preservedWs = true
        else restSpotWritten = true
        t.clearing = clearing
        t.spot = spot
        t.orders = orders
        t.seen.orders = seenOrders
        if (restClearingWritten) t.seen.clearing = Math.max(t.seen.clearing, now)
        if (restSpotWritten) t.seen.spot = Math.max(t.seen.spot, now)
        t.restAt = now
        if (t.modelKnown) t.confirmedAt = Math.max(t.confirmedAt ?? Number.NEGATIVE_INFINITY, now)
        t.source = preservedWs ? 'ws' : 'rest'
        t.version += 1
        t.isReady = true
      } catch {
        if (!controller.signal.aborted) {
          this.warn('账户 REST 后台刷新失败；保留最后快照')
          controller.abort()
        }
      } finally {
        if (t.restFlight?.promise === promise) t.restFlight = undefined
      }
    })()
    t.lastRestAttemptAt = attemptedAt
    t.restFlight = { controller, promise, attemptedAt }
  }

  private async fetchRest(ref: AccountRef, signal: AbortSignal): Promise<{ perDex: Array<{ dex: string; st: RawClearinghouse }>; spot: RawSpotState; orders: VenueOpenOrder[]; ordersByDex: Map<string, VenueOpenOrder[]> }> {
    const user = ref.address.toLowerCase()
    const dexes = this.liveDexes()
    const options = { kind: 'background' as const, signal }
    const perDex = await Promise.all(dexes.map(async (dex) => ({ dex, st: await this.http.info<RawClearinghouse>(dex === '' ? { type: 'clearinghouseState', user } : { type: 'clearinghouseState', user, dex }, options) })))
    const spot = await this.http.info<RawSpotState>({ type: 'spotClearinghouseState', user }, options)
    const ordersByDex = new Map<string, VenueOpenOrder[]>()
    for (const dex of dexes) {
      const raw = await this.http.info<RawOpenOrder[]>(dex === '' ? { type: 'frontendOpenOrders', user } : { type: 'frontendOpenOrders', user, dex }, options)
      ordersByDex.set(dex, (raw ?? []).map((o) => mapOpenOrder(o)))
    }
    return { perDex, spot, orders: [...ordersByDex.values()].flat(), ordersByDex }
  }

  /** 启动对账：同步返回缓存；REST 快照与请求区间历史由后台补齐。 */
  async startupSnapshot(ref: AccountRef, fillsSinceMs: number): Promise<StartupSnapshot> {
    const t = this.track(ref)
    const view = this.viewOf(t)
    this.startModelDetection(t)
    this.requestRestRefresh(t)
    this.requestHistory(t, fillsSinceMs)
    const now = this.clock()
    const restFresh = t.restAt !== null && now - t.restAt <= this.o.restFallbackMs * 2
    const historyFresh = t.history !== undefined && t.history.sinceMs <= fillsSinceMs && now - t.history.completedAt <= this.o.restFallbackMs * 2
    const history = historyFresh ? t.history : undefined
    const historyFills = history ? new Map(history.fills.map((f) => [f.venueFillId, f])) : new Map<string, VenueFill>()
    for (const fill of t.fills) if (fill.ts >= fillsSinceMs) historyFills.set(fill.venueFillId, fill)
    const fills = [...historyFills.values()].filter((f) => f.ts >= fillsSinceMs).sort((a, b) => a.ts - b.ts)
    const account = { ...view.snapshot, stale: view.snapshot.stale || !restFresh || !history || history.truncated }
    return {
      account,
      openOrders: view.openOrders,
      fills: fills.map((f) => ({ ...f })),
      fillsSince: fillsSinceMs,
      truncated: !history || history.truncated,
    }
  }

  // ───────────── 快照计算（纯函数）─────────────

  private build(ref: AccountRef, model: Model, perDex: Array<{ dex: string; st: RawClearinghouse }>, spot: RawSpotState, ts: number): AccountSnapshot {
    const positions: Position[] = []
    for (const { st } of perDex) for (const ap of st.assetPositions ?? []) positions.push(this.mapPosition(ref, ap.position, ts))

    const balances: Balance[] = []
    let equity = fx(0)
    let hold = fx(0)
    let available = fx(0)
    let maintenance = fx(0)
    let initial = fx(0)
    for (const { st } of perDex) {
      maintenance += fx(st.crossMaintenanceMarginUsed ?? '0')
      initial += fx(st.marginSummary?.totalMarginUsed ?? '0')
    }
    const spotRows = (spot.balances ?? []).filter((b) => fx(b.total) !== 0n)
    if (model === 'standard') {
      for (const { st } of perDex) {
        equity += fx(st.marginSummary?.accountValue ?? '0')
        hold += fx(st.marginSummary?.totalMarginUsed ?? '0')
        available += fx(st.withdrawable ?? '0')
      }
      balances.push({ accountId: ref.accountId, asset: 'USDC', total: dec(str(equity)), available: dec(str(available)), hold: dec(str(hold)), ts })
    } else {
      // 统一 / 组合保证金：余额与占用都在现货清算状态里；权益 = 现货稳定币总额 + 各 dex 未实现盈亏
      const usdc = spotRows.find((b) => b.coin === 'USDC')
      const total = fx(usdc?.total ?? '0')
      const h = fx(usdc?.hold ?? '0')
      let upnl = fx(0)
      for (const p of positions) upnl += fx(p.unrealizedPnl)
      equity = total + upnl
      hold = h
      available = total - h
    }
    for (const b of spotRows) {
      if (model === 'standard' || b.coin !== 'USDC') {
        balances.push({ accountId: ref.accountId, asset: b.coin, total: dec(b.total), available: dec(str(fx(b.total) - fx(b.hold))), hold: dec(b.hold), ts })
      } else {
        balances.push({ accountId: ref.accountId, asset: 'USDC', total: dec(b.total), available: dec(str(available)), hold: dec(str(hold)), ts })
      }
    }

    let notional = fx(0)
    for (const p of positions) notional += abs(fx(p.notional))
    const margin: MarginSnapshot = {
      accountId: ref.accountId,
      model,
      valuationCcy: 'USDC',
      equity: dec(str(equity)),
      initialMargin: dec(str(initial)),
      maintenanceMargin: dec(str(maintenance)),
      available: dec(str(available)),
      marginRatio: dec(equity > 0n ? str(div(maintenance, equity), 8) : '0'),
      leverage: equity > 0n ? Number(str(div(notional, equity), 4)) : 0,
      ts,
    }
    return { accountModel: model, balances, margin, positions, ts }
  }

  private mapPosition(ref: AccountRef, p: RawPosition, ts: number): Position {
    const id = instrumentIdOf(p.coin)
    const szi = fx(p.szi)
    const rec = this.market.getRecord(id)
    const q = this.market.quote(id)
    const entry = dec(p.entryPx ?? '0')
    const only = rec?.instrument.marginModes?.length === 1 ? rec.instrument.marginModes[0] : undefined
    const marginMode: MarginMode = only ?? (p.leverage?.type === 'isolated' ? 'isolated' : 'cross')
    return {
      accountId: ref.accountId,
      instrumentId: id,
      side: szi >= 0n ? 'long' : 'short',
      size: dec(str(abs(szi))),
      entryPrice: entry,
      markPrice: q ? dec(String(q.last ?? (q.bid + q.ask) / 2)) : impliedMark(p, szi) ?? entry, // 没有行情时用持仓价值 ÷ 数量，比开仓价更接近标记价
      notional: dec(p.positionValue ?? '0'),
      unrealizedPnl: dec(p.unrealizedPnl ?? '0'),
      // 场所不提供按持仓的累计已实现盈亏与开仓时间：已实现盈亏留 0、openedAt 用快照时间，由内核按账本回填
      realizedPnl: dec('0'),
      leverage: p.leverage?.value ?? 1,
      marginMode,
      initialMargin: dec(p.marginUsed ?? '0'),
      liquidationPrice: p.liquidationPx ? dec(p.liquidationPx) : null,
      // HL 的 cumFunding.sinceOpen 正数 = 用户付出；契约 fundingSinceOpen 用现金流符号（收到为正）→ 取反
      fundingSinceOpen: dec(p.cumFunding?.sinceOpen !== undefined ? str(-fx(p.cumFunding.sinceOpen)) : '0'),
      openedAt: ts,
      updatedAt: ts,
    }
  }

  // ───────────── 历史成交 / 订单状态（显式查询，走 REST）─────────────

  private requestHistory(t: Tracked, sinceMs: number): void {
    if (this.closed || this.tracked.get(t.user) !== t) return
    const now = this.clock()
    if (t.history && t.history.sinceMs <= sinceMs && !t.history.truncated && now - t.history.completedAt <= this.o.restFallbackMs * 2) return
    if (t.historyFlight) {
      if (sinceMs < t.historyFlight.sinceMs) t.historyPendingSinceMs = Math.min(t.historyPendingSinceMs ?? sinceMs, sinceMs)
      return
    }
    const pendingEarlier = t.historyPendingSinceMs !== undefined && t.historyPendingSinceMs < (t.history?.sinceMs ?? Number.POSITIVE_INFINITY)
    const needsEarlier = sinceMs < (t.history?.sinceMs ?? Number.POSITIVE_INFINITY)
    if (t.historyAttemptedAt !== null && this.clock() - t.historyAttemptedAt < this.o.restFallbackMs && !pendingEarlier && !needsEarlier) return
    const requestedSince = Math.min(sinceMs, t.historyPendingSinceMs ?? sinceMs)
    const fetchSinceMs = t.history && t.history.sinceMs < requestedSince ? t.history.sinceMs : requestedSince
    t.historyPendingSinceMs = undefined
    const controller = new AbortController()
    let promise!: Promise<void>
    promise = (async () => {
      try {
        const result = await this.fillsPaged(t.ref, fetchSinceMs, { kind: 'background', signal: controller.signal })
        if (this.tracked.get(t.user) !== t || this.closed || controller.signal.aborted) return
        const earlier = t.history && t.history.sinceMs < fetchSinceMs ? t.history : undefined
        const byId = new Map((earlier?.fills ?? []).map((f) => [f.venueFillId, f]))
        for (const fill of result.fills) byId.set(fill.venueFillId, fill)
        const fills = [...byId.values()].sort((a, b) => a.ts - b.ts)
        t.history = { sinceMs: earlier?.sinceMs ?? fetchSinceMs, fills, truncated: result.truncated || (earlier?.truncated ?? false), completedAt: this.clock() }
      } catch {
        if (!controller.signal.aborted) this.warn('账户历史成交后台回补失败；保留已缓存历史')
      } finally {
        if (t.historyFlight?.promise === promise) t.historyFlight = undefined
      }
    })()
    t.historyAttemptedAt = this.clock()
    t.historyFlight = { controller, promise, sinceMs: fetchSinceMs }
  }

  private async fillsPaged(ref: AccountRef, sinceMs: number, options?: { kind: 'query' | 'background'; signal?: AbortSignal }): Promise<{ fills: VenueFill[]; truncated: boolean }> {
    const user = ref.address.toLowerCase()
    const seen = new Set<string>()
    const out: VenueFill[] = []
    let start = sinceMs
    let truncated = false
    for (let page = 0; ; page++) {
      if (page >= 20) { truncated = true; break }
      const raw = await this.http.info<RawFill[]>({ type: 'userFillsByTime', user, startTime: start }, options)
      const rows = raw ?? []
      for (const f of rows) {
        const m = mapFill(f)
        if (seen.has(m.venueFillId)) continue
        seen.add(m.venueFillId)
        out.push(m)
      }
      // 每页上限 500 / 2000（口径不一），页满就继续翻；多翻一页最多是一次空查询
      if (rows.length < 500) break
      const last = rows[rows.length - 1]!.time
      if (last < start) break
      start = last + 1
    }
    out.sort((a, b) => a.ts - b.ts)
    return { fills: out, truncated }
  }

  async orderStatus(ref: AccountRef, key: { clientOrderId?: string; venueOrderId?: string }): Promise<VenueOrderStatus> {
    const oid = key.venueOrderId !== undefined ? Number(key.venueOrderId) : key.clientOrderId ? `0x${key.clientOrderId}` : undefined
    if (oid === undefined) throw new TypeError('orderStatus needs venueOrderId or clientOrderId')
    const raw = await this.http.info<{ status?: string; order?: { status?: string; order?: { oid?: number; sz?: string; origSz?: string } } }>({ type: 'orderStatus', user: ref.address.toLowerCase(), oid })
    if (raw?.status !== 'order' || !raw.order) return { found: false, raw }
    const o = raw.order.order
    const filled = o?.origSz !== undefined && o.sz !== undefined ? str(fx(o.origSz) - fx(o.sz)) : undefined
    return {
      found: true,
      ...(raw.order.status ? { status: raw.order.status } : {}),
      ...(o?.oid !== undefined ? { venueOrderId: String(o.oid) } : {}),
      ...(filled !== undefined ? { filledSize: dec(filled) } : {}),
      raw,
    }
  }
}


function modelOf(raw: unknown): Model {
  const s = typeof raw === 'string' ? raw : ''
  if (s === 'unifiedAccount') return 'unified'
  if (s === 'portfolioMargin') return 'portfolio'
  return 'standard' // default / disabled / dexAbstraction（已弃用）都按 standard 读
}
