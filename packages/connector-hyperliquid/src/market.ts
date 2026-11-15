// SPDX-License-Identifier: CPAL-1.0
// Hyperliquid 行情：WS 为主、REST 兜底与历史。
// 搬运并改造自 早期 Demo 原型 src/market/hl-market.ts：
//   · 权重预算改为外部注入的 RateBudget（Demo 内置令牌桶 900/分钟）；
//   · 多 dex 动态发现：perpDexs + 每个 dex 的 metaAndAssetCtxs，离线 / 全下架的 dex 自动剔除并定期复查；
//   · 订阅按需、引用计数（allMids / bbo / l2Book / candle / activeAssetCtx / 用户流，含 HIP-3 dex 参数）；
//   · 行情陈旧即标记 stale（quote().stale、status().stale），不替调用方判断能不能用。
import { makeProblem, normalizeDecimal } from '@gitrader/protocol'
import type { Book, Candle, CandleInterval, FundingRatePoint, Instrument, InstrumentId, MarketContext, Ms } from '@gitrader/protocol'
import { HL_ENDPOINTS, HlHttp, HlHttpError, HlNetworkError } from './rest'
import type { Environment, InfoBody, InfoCallOptions } from './rest'
import { CircuitBreaker } from './circuit-breaker'
import { ProblemError, problemFromTransportError } from './errors'
import { HlWsClient } from './ws'
import type { WsMessage } from './ws'
import {
  VENUE, buildInstrumentRecords, coinOf, instrumentIdOf, num, parseBook, parseCandles, parseContext, parseMids, parsePerpDexs,
} from './parse'
import type { InstrumentRecord, PerpDexRef, RawBook, RawCandle, RawCtx, RawMetaAndCtxs } from './parse'
import type { BudgetKind, RateBudget } from './budget'
import type { CandleRecorder, Hex, MarkPrice, MarketStatus, StampedQuote, SubscriptionSpec, Unsubscribe, VenueEvent } from '@gitrader/protocol/connector'

export const INTERVAL_MS: Record<CandleInterval, number> = {
  '1m': 60_000, '3m': 180_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000,
  '1h': 3_600_000, '2h': 7_200_000, '4h': 14_400_000, '8h': 28_800_000, '12h': 43_200_000,
  '1d': 86_400_000, '3d': 259_200_000, '1w': 604_800_000, '1M': 2_592_000_000,
}

/** 官方：candleSnapshot 最近 5000 根；带时间范围的请求每页最多 500（取两者较小的稳妥值翻页）。 */
export const MAX_CANDLES = 5000
export const CANDLE_PAGE = 500
export const FUNDING_PAGE = 500
/** 资金费历史翻页的页间间隔：公开行情只读 <= 2 次/秒。 */
export const FUNDING_PAGE_GAP_MS = 500

interface RawFundingRow { coin: string; fundingRate: string; premium: string; time: number }

export type { FundingRatePoint } from '@gitrader/protocol'

function subscriptionMatches(expected: object, actual: unknown): boolean {
  if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return false
  const left = Object.entries(expected)
  const right = Object.entries(actual)
  if (left.length !== right.length) return false
  return left.every(([key, value]) => {
    if (!Object.prototype.hasOwnProperty.call(actual, key)) return false
    const other = (actual as Record<string, unknown>)[key]
    return key === 'user' && typeof value === 'string' && typeof other === 'string'
      ? value.toLowerCase() === other.toLowerCase()
      : value === other
  })
}

export interface MarketOptions {
  environment: Environment
  http: HlHttp
  budget: RateBudget
  WebSocketImpl?: typeof WebSocket
  clock?: () => number
  /** false = 只走 REST，不建 WS。默认 true。 */
  useWs?: boolean
  /** 行情陈旧阈值，默认 10 s（与 Demo 一致）。风控的 failClosed.stalePriceMs 另算，在内核。 */
  staleMs?: number
  /** 资金费历史翻页的页间间隔，默认 500 ms（公开行情只读 <= 2 次/秒）。 */
  fundingPageGapMs?: number
  /** 场所标记价缓存陈旧阈值，默认 5 s；与公开行情新鲜度独立。 */
  markStaleMs?: number
  /** WS 不可用时 REST 轮询 allMids 的间隔，默认 2000。 */
  pollMs?: number
  /** dex 清单重新发现的间隔，默认 30 分钟；0 = 不自动重发现。 */
  discoveryIntervalMs?: number
  /** 离线 / 全下架的 dex 多久复查一次，默认 10 分钟。 */
  offlineRecheckMs?: number
  /** WS 订阅数上限，默认 900（官方 1000，留余量）。 */
  maxSubscriptions?: number
  recorder?: CandleRecorder
  /** L2 快照多久没更新算陈旧，默认 15 s（l2Book 订阅在清淡的 HIP-3 市场可能几秒才推一次）。 */
  bookStaleMs?: number
  /** 对同一标的的 REST 盘口兜底最小间隔，默认 2 s。 */
  bookRefreshMinMs?: number
  /** info（行情 / 元数据）类 REST 的熔断器；缺省 5 次连续失败 / 30 s 冷却 / half_open 放行 1 次。 */
  circuit?: { failureThreshold?: number; cooldownMs?: number; halfOpenMaxCalls?: number }
}

/** 本地 L2 快照：WS l2Book 订阅维护，带 asOf（最后一次更新）与 stale。 */
export interface BookSnapshot { book: Book; asOf: Ms; stale: boolean }

type DexStatus = 'live' | 'delisted' | 'offline'
interface DexState { name: string; index: number; status: DexStatus; ts: number; failures: number; coins: string[] }

const CTX_TTL_MS = 20_000
const WS_FAILS_TO_FALLBACK = 3
const NOTIFY_GAP_MS = 250
const BOOK_FRESH_MS = 2_000
const CANDLE_TTL_MS = 2_000
/** 取 K 线的单次时限（C8）：超时即以传输错误返回（含预算队列等待），界面不会无限骨架。 */
const CANDLE_TIMEOUT_MS = 10_000 // 单页 K 线请求本身的超时（拿到预算之后才开始计）
const CANDLE_QUEUE_TIMEOUT_MS = 90_000 // 等预算排队的上限（R1-PERF-01：排队不再吃掉那 10 s）
const MARK_WARN_GAP_MS = 10 * 60_000
const MARK_REFRESH_WARN = '持续标记价格后台刷新失败；保留缓存并继续重试'
const MARK_SUBSCRIPTION_WARN = '持续标记价格订阅达到上限；保留 REST 刷新'

interface TrackedMark { refs: number; pinned: boolean; lastPushAt?: number; implicitContext: boolean }
interface MarkFlight { controller: AbortController; promise: Promise<void> }

export class HlMarket {
  readonly environment: Environment
  private readonly http: HlHttp
  private readonly budget: RateBudget
  private readonly clock: () => number
  private readonly staleMs: number
  private readonly fundingPageGapMs: number
  private readonly markStaleMs: number
  private readonly markRefreshMs: number
  private readonly pollMs: number
  private readonly discoveryIntervalMs: number
  private readonly offlineRecheckMs: number
  private readonly maxSubs: number
  private readonly bookStaleMs: number
  /** 本地 L2 快照的陈旧阈值（describe() 的 bookSnapshot.staleAfterMs 用；集成修补 H v3）。 */
  get bookStaleAfterMs(): number { return this.bookStaleMs }
  private readonly bookRefreshMinMs: number
  private readonly breaker: CircuitBreaker
  private readonly circuitCooldownMs: number
  private bookRefreshAt = new Map<InstrumentId, number>()
  private readonly recorder: CandleRecorder | undefined
  private readonly ws: HlWsClient | null

  private started = false
  private closed = false
  private restMode = false
  private restRound = 0
  private pollTimer: ReturnType<typeof setTimeout> | null = null
  private discoveryTimer: ReturnType<typeof setTimeout> | null = null
  private discoveryInflight: Promise<void> | null = null
  private loaded = false
  /** 最近一次 dex 清单发现失败的原因（成功则清空）；默认 dex 仍会加载。 */
  discoveryError: string | null = null

  private records = new Map<InstrumentId, InstrumentRecord>()
  private coinToId = new Map<string, InstrumentId>()
  private dexes = new Map<string, DexState>()
  private mids = new Map<InstrumentId, { px: number; ts: number }>()
  private marks = new Map<InstrumentId, MarkPrice>()
  private trackedMarks = new Map<InstrumentId, TrackedMark>()
  private markFlights = new Map<string, MarkFlight>()
  private markAttemptedAt = new Map<string, number>()
  private markWarningsAt = new Map<string, number>()
  private markTimer: ReturnType<typeof setInterval> | null = null
  private bbo = new Map<InstrumentId, { bid: number; ask: number; ts: number }>()
  private ctx = new Map<InstrumentId, { ctx: MarketContext; ts: number }>()
  private books = new Map<InstrumentId, { book: Book; ts: number }>()
  private candleCache = new Map<string, { candles: Candle[]; ts: number }>()
  private lastMsgTs = 0
  private wsGeneration = 0
  private lastRestOkTs = 0
  private restLatencyMs = 0

  private listeners = new Map<string, { spec: SubscriptionSpec; cbs: Set<(e: VenueEvent) => void> }>()
  private wsRefs = new Map<string, { sub: object; refs: number }>()
  private wsDexMids = new Set<string>()
  private midsTimer: ReturnType<typeof setTimeout> | null = null
  private lastMidsNotify = 0
  private pendingMidIds = new Set<InstrumentId>()

  constructor(o: MarketOptions) {
    this.environment = o.environment
    this.http = o.http
    this.budget = o.budget
    this.clock = o.clock ?? (() => Date.now())
    this.staleMs = o.staleMs ?? 10_000
    this.fundingPageGapMs = Math.max(0, o.fundingPageGapMs ?? FUNDING_PAGE_GAP_MS)
    this.markStaleMs = o.markStaleMs ?? 5_000
    this.markRefreshMs = Math.max(1, Math.floor(this.markStaleMs / 2))
    this.pollMs = o.pollMs ?? 2000
    this.discoveryIntervalMs = o.discoveryIntervalMs ?? 30 * 60_000
    this.offlineRecheckMs = o.offlineRecheckMs ?? 10 * 60_000
    this.maxSubs = o.maxSubscriptions ?? 900
    this.bookStaleMs = o.bookStaleMs ?? 15_000
    this.bookRefreshMinMs = o.bookRefreshMinMs ?? 2_000
    this.circuitCooldownMs = o.circuit?.cooldownMs ?? 30_000
    this.breaker = new CircuitBreaker({
      failureThreshold: o.circuit?.failureThreshold ?? 5,
      cooldownMs: this.circuitCooldownMs,
      halfOpenMaxCalls: o.circuit?.halfOpenMaxCalls ?? 1,
      clock: this.clock,
    })
    this.recorder = o.recorder
    const WS = o.WebSocketImpl ?? (typeof WebSocket === 'function' ? WebSocket : undefined)
    this.ws =
      o.useWs !== false && WS
        ? new HlWsClient({
            url: HL_ENDPOINTS[o.environment].ws,
            WebSocketImpl: WS,
            clock: this.clock,
            onMessage: (m, ts) => this.onWsMessage(m, ts),
            onLive: () => this.onWsLive(),
            onDown: (reason, failures) => this.onWsDown(reason, failures),
          })
        : null
  }

  // ───────────── 生命周期 ─────────────

  /** 启动：发现标的、连 WS、订阅各 dex 的 allMids。可重复调用。 */
  async start(): Promise<void> {
    if (this.closed) throw new Error('market closed')
    this.ensureStarted()
    await this.refreshInstruments()
  }

  private ensureStarted(): void {
    if (this.started || this.closed) return
    this.started = true
    if (this.ws) {
      this.ws.start()
      this.ws.subscribe({ type: 'allMids' })
    } else {
      this.enterRestMode()
    }
  }

  async close(): Promise<void> {
    this.closed = true
    this.ws?.stop()
    for (const t of [this.pollTimer, this.discoveryTimer, this.midsTimer]) if (t) clearTimeout(t)
    if (this.markTimer) clearInterval(this.markTimer)
    this.markTimer = null
    for (const flight of this.markFlights.values()) flight.controller.abort()
    this.markFlights.clear()
    this.markAttemptedAt.clear()
    this.markWarningsAt.clear()
    this.trackedMarks.clear()
    this.pollTimer = this.discoveryTimer = this.midsTimer = null
    this.listeners.clear()
    this.wsRefs.clear()
  }

  // ───────────── 标的发现 ─────────────

  private dexNamesDiscovered = false

  /** 轻量 dex 名单发现：只打一次 perpDexs，不打 metaAndAssetCtxs。watch source 首读用；失败时清缓存、下次重试。 */
  async discoverDexNames(): Promise<void> {
    if (this.dexNamesDiscovered) return
    try {
      const refs = parsePerpDexs(await this.info({ type: 'perpDexs' }, { kind: 'background' }))
      const now = this.clock()
      for (const r of refs) {
        if (!this.dexes.has(r.name)) {
          this.dexes.set(r.name, { name: r.name, index: r.index, status: 'live', ts: now, failures: 0, coins: [] })
        }
      }
      this.dexNamesDiscovered = true
    } catch (e) {
      this.dexNamesDiscovered = false
      throw e
    }
  }

  /** 全量重新发现：perpDexs → 每个 dex 的 metaAndAssetCtxs。离线 / 全下架的 dex 剔除并降频复查。 */
  refreshInstruments(): Promise<void> {
    if (this.discoveryInflight) return this.discoveryInflight
    const p = this.discover().finally(() => { this.discoveryInflight = null })
    this.discoveryInflight = p
    return p
  }

  private async discover(): Promise<void> {
    const before = new Set(this.visibleIds())
    const now = this.clock()
    let refs: PerpDexRef[] = []
    let dexListOk = true
    try {
      refs = parsePerpDexs(await this.info({ type: 'perpDexs' }, { kind: 'background' }))
    } catch (e) {
      dexListOk = false
      if (!this.loaded) {
        // 冷启动拿不到 dex 清单：至少加载默认 dex，其余等下次发现
        this.ensureStartedTimers()
        await this.loadDex('', 0)
        this.loaded = true
        this.afterDiscovery(before)
        this.discoveryError = e instanceof Error ? e.message : String(e)
        return
      }
    }
    if (dexListOk) {
      this.discoveryError = null
      const names = new Set(refs.map((r) => r.name))
      for (const [name, st] of [...this.dexes]) {
        if (name !== '' && !names.has(name)) this.dropDex(name, st)
      }
    }
    const targets: Array<{ name: string; index: number }> = [{ name: '', index: 0 }, ...(dexListOk ? refs : [...this.dexes.values()].filter((d) => d.name !== ''))]
    for (const t of targets) {
      if (this.closed) return
      const cur = this.dexes.get(t.name)
      // 离线 / 全下架的 dex 降频复查，省权重
      if (cur && cur.status !== 'live' && now - cur.ts < this.offlineRecheckMs) continue
      try {
        await this.loadDex(t.name, t.index)
      } catch {
        // loadDex 已把失败记进 dexes；其余 dex 继续
      }
    }
    this.loaded = true
    this.afterDiscovery(before)
    this.ensureStartedTimers()
  }

  private ensureStartedTimers(): void {
    if (this.discoveryIntervalMs <= 0 || this.discoveryTimer || this.closed) return
    const tick = () => {
      this.discoveryTimer = setTimeout(async () => {
        this.discoveryTimer = null
        if (this.closed) return
        try { await this.refreshInstruments() } catch { /* 下一轮重试 */ }
        tick()
      }, this.discoveryIntervalMs)
      this.discoveryTimer.unref?.()
    }
    tick()
  }

  /** 加载一个 dex 的 meta + 上下文（一个请求，权重 20）。失败会累计失败次数并在 2 次后标离线。 */
  private async loadDex(name: string, index: number, kind: BudgetKind = 'background'): Promise<void> {
    try {
      const raw = (await this.info<RawMetaAndCtxs>(name === '' ? { type: 'metaAndAssetCtxs' } : { type: 'metaAndAssetCtxs', dex: name }, { kind }))
      const now = this.clock()
      const recs = buildInstrumentRecords(raw, name, index, now)
      const [, ctxs] = raw
      const prepared = recs.map((record, i) => {
        const contextRaw = ctxs[i]
        const context = contextRaw && record.instrument.status !== 'delisted'
          ? parseContext(record.instrument.instrumentId, contextRaw, now)
          : undefined
        return { record, contextRaw, context }
      })
      // 替换该 dex 的旧记录
      const old = this.dexes.get(name)
      for (const c of old?.coins ?? []) {
        const id = this.coinToId.get(c)
        if (id) { this.records.delete(id); this.marks.delete(id) }
        this.coinToId.delete(c)
      }
      prepared.forEach(({ record: r, contextRaw: c, context: pc }) => {
        this.records.set(r.instrument.instrumentId, r)
        this.coinToId.set(r.coin, r.instrument.instrumentId)
        this.updateMark(r.instrument.instrumentId, c?.markPx, now)
        if (pc) {
          this.ctx.set(r.instrument.instrumentId, { ctx: pc, ts: now })
          // 目录响应自带 midPx：mids 里还没有时先垫上（WS allMids 到达后会覆盖）
          if (pc.midPrice && pc.midPrice > 0 && !this.mids.has(r.instrument.instrumentId)) this.mids.set(r.instrument.instrumentId, { px: pc.midPrice, ts: now })
        }
        if (r.instrument.status === 'delisted') this.removeTrackedMark(r.instrument.instrumentId)
      })
      const live = recs.some((r) => r.instrument.status !== 'delisted')
      this.dexes.set(name, { name, index, status: live ? 'live' : 'delisted', ts: now, failures: 0, coins: recs.map((r) => r.coin) })
    } catch (e) {
      const cur = this.dexes.get(name)
      const failures = (cur?.failures ?? 0) + 1
      // 默认 dex 不剔除（它是行情根）；构建者 dex 连续 2 次失败（或从未加载成功）视为离线
      const status: DexStatus = name === '' ? (cur?.status ?? 'live') : failures >= 2 || !cur ? 'offline' : cur.status
      this.dexes.set(name, { name, index, status, ts: this.clock(), failures, coins: cur?.coins ?? [] })
      throw e
    }
  }

  private dropDex(name: string, st: DexState): void {
    for (const c of st.coins) {
      const id = this.coinToId.get(c)
      if (id) {
        this.removeTrackedMark(id)
        this.records.delete(id)
        this.mids.delete(id)
        this.marks.delete(id)
        this.bbo.delete(id)
        this.ctx.delete(id)
        this.books.delete(id)
      }
      this.coinToId.delete(c)
    }
    this.dexes.delete(name)
    this.unsubscribeDexMids(name)
  }

  private visibleIds(): InstrumentId[] {
    const out: InstrumentId[] = []
    for (const r of this.records.values()) {
      const d = this.dexes.get(r.dex)
      if (r.instrument.status !== 'delisted' && d?.status === 'live') out.push(r.instrument.instrumentId)
    }
    return out
  }

  private afterDiscovery(before: Set<InstrumentId>): void {
    // 离线 dex 的订阅退掉、在线 dex 的 allMids 订上
    for (const [name, d] of this.dexes) {
      if (name === '') continue
      if (d.status === 'live') this.subscribeDexMids(name)
      else this.unsubscribeDexMids(name)
    }
    const after = new Set(this.visibleIds())
    const added = [...after].filter((x) => !before.has(x))
    const removed = [...before].filter((x) => !after.has(x))
    if (added.length || removed.length) this.emit({ channel: 'instruments' }, { channel: 'instruments', added, removed })
  }

  private subscribeDexMids(dex: string): void {
    if (!this.ws || this.closed || this.wsDexMids.has(dex)) return
    this.wsDexMids.add(dex)
    this.ws.subscribe({ type: 'allMids', dex })
  }

  private unsubscribeDexMids(dex: string): void {
    if (!this.wsDexMids.delete(dex)) return
    this.ws?.unsubscribe({ type: 'allMids', dex })
  }

  listInstruments(opts: { includeDelisted?: boolean } = {}): Instrument[] {
    const out: Instrument[] = []
    for (const r of this.records.values()) {
      const d = this.dexes.get(r.dex)
      if (opts.includeDelisted) { out.push(r.instrument); continue }
      if (r.instrument.status !== 'delisted' && d?.status === 'live') out.push(r.instrument)
    }
    return out
  }

  getInstrument(id: InstrumentId): Instrument | undefined {
    return this.records.get(id)?.instrument
  }

  mark(id: InstrumentId, options: { allowStale?: boolean } = {}): MarkPrice | undefined {
    this.pinMark(id)
    const mark = this.marks.get(id)
    const instrument = this.records.get(id)?.instrument
    return mark && (options.allowStale === true || this.clock() - mark.ts <= this.markStaleMs) && instrument && instrument.status !== 'delisted' ? { ...mark } : undefined
  }

  private pinMark(id: InstrumentId): void {
    const record = this.records.get(id)
    if (!record || record.instrument.status === 'delisted' || this.closed) return
    this.ensureStarted()
    let tracked = this.trackedMarks.get(id)
    if (!tracked) {
      tracked = { refs: 0, pinned: true, implicitContext: false }
      this.trackedMarks.set(id, tracked)
      this.acquireImplicitContext(id, tracked)
      this.ensureMarkTimer()
      if (!this.isMarkFresh(id)) this.requestMarkRefresh(record.dex)
    } else {
      tracked.pinned = true
    }
  }

  private retainMark(id: InstrumentId): void {
    const record = this.records.get(id)
    if (!record || record.instrument.status === 'delisted' || this.closed) return
    let tracked = this.trackedMarks.get(id)
    if (!tracked) {
      tracked = { refs: 0, pinned: false, implicitContext: false }
      this.trackedMarks.set(id, tracked)
      this.acquireImplicitContext(id, tracked)
      this.ensureMarkTimer()
      if (!this.isMarkFresh(id)) this.requestMarkRefresh(record.dex)
    }
    tracked.refs += 1
  }

  private releaseMark(id: InstrumentId): void {
    const tracked = this.trackedMarks.get(id)
    if (!tracked) return
    tracked.refs = Math.max(0, tracked.refs - 1)
    if (!tracked.pinned && tracked.refs === 0) this.removeTrackedMark(id)
  }

  private removeTrackedMark(id: InstrumentId): void {
    const tracked = this.trackedMarks.get(id)
    if (!tracked) return
    this.trackedMarks.delete(id)
    if (tracked.implicitContext) this.releaseWs({ channel: 'context', instrumentId: id })
    if (this.trackedMarks.size === 0 && this.markTimer) {
      clearInterval(this.markTimer)
      this.markTimer = null
    }
  }

  private acquireImplicitContext(id: InstrumentId, tracked: TrackedMark): void {
    if (!this.ws) return
    try {
      this.acquireWs({ channel: 'context', instrumentId: id })
      tracked.implicitContext = true
    } catch {
      this.http.warn(MARK_SUBSCRIPTION_WARN)
    }
  }

  private ensureMarkTimer(): void {
    if (this.markTimer || this.closed || this.trackedMarks.size === 0) return
    this.markTimer = setInterval(() => this.refreshTrackedMarks(), this.markRefreshMs)
    this.markTimer.unref?.()
  }

  private isMarkFresh(id: InstrumentId): boolean {
    const mark = this.marks.get(id)
    return !!mark && this.clock() - mark.ts <= this.markStaleMs
  }

  private refreshTrackedMarks(): void {
    if (this.closed) return
    const dexes = new Set<string>()
    for (const [id, tracked] of this.trackedMarks) {
      const record = this.records.get(id)
      if (!record || record.instrument.status === 'delisted') {
        this.removeTrackedMark(id)
        continue
      }
      const pushAge = tracked.lastPushAt === undefined ? Number.POSITIVE_INFINITY : this.clock() - tracked.lastPushAt
      if (!this.wsHealthy || pushAge >= this.markRefreshMs) dexes.add(record.dex)
    }
    for (const dex of dexes) this.requestMarkRefresh(dex)
  }

  private requestMarkRefresh(dex: string): void {
    if (this.closed || this.markFlights.has(dex)) return
    const now = this.clock()
    const attemptedAt = this.markAttemptedAt.get(dex)
    if (attemptedAt !== undefined && now - attemptedAt < this.markRefreshMs) return
    const controller = new AbortController()
    let promise!: Promise<void>
    promise = (async () => {
      try {
        const raw = await this.info<RawMetaAndCtxs>(dex === '' ? { type: 'metaAndAssetCtxs' } : { type: 'metaAndAssetCtxs', dex }, { kind: 'background', signal: controller.signal })
        if (this.closed || controller.signal.aborted || this.markFlights.get(dex)?.promise !== promise) return
        const completedAt = this.clock()
        const records = buildInstrumentRecords(raw, dex, this.dexes.get(dex)?.index ?? 0, completedAt)
        const [, ctxs] = raw
        const prepared: Array<{ id: InstrumentId; markPx: string | null | undefined; context: MarketContext }> = []
        for (let i = 0; i < records.length; i++) {
          const row = records[i]!
          const id = this.coinToId.get(row.coin)
          const tracked = id ? this.trackedMarks.get(id) : undefined
          const record = id ? this.records.get(id) : undefined
          const ctx = ctxs[i]
          if (!id || !tracked || !record || record.instrument.status === 'delisted' || record.dex !== dex || !ctx) continue
          prepared.push({ id, markPx: ctx.markPx, context: parseContext(id, ctx, completedAt) })
        }
        for (const { id, markPx, context } of prepared) {
          this.updateMark(id, markPx, completedAt)
          this.ctx.set(id, { ctx: context, ts: completedAt })
          if (context.midPrice !== undefined && context.midPrice > 0) {
            this.mids.set(id, { px: context.midPrice, ts: completedAt })
            this.pendingMidIds.add(id)
            this.emitQuote(id)
          }
        }
        if (this.pendingMidIds.size) this.scheduleNotify(completedAt)
      } catch {
        if (!controller.signal.aborted) this.warnMarkRefresh(MARK_REFRESH_WARN)
      } finally {
        if (this.markFlights.get(dex)?.promise === promise) this.markFlights.delete(dex)
      }
    })()
    this.markAttemptedAt.set(dex, now)
    this.markFlights.set(dex, { controller, promise })
  }

  private warnMarkRefresh(message: string): void {
    const now = this.clock()
    const warnedAt = this.markWarningsAt.get(message)
    if (warnedAt !== undefined && now - warnedAt < MARK_WARN_GAP_MS) return
    this.markWarningsAt.set(message, now)
    this.http.warn(message)
  }

  private updateMark(id: InstrumentId, raw: string | null | undefined, ts: number): void {
    if (typeof raw !== 'string' || !/^\d+(?:\.\d+)?$/.test(raw) || !/[1-9]/.test(raw)) {
      this.marks.delete(id)
      return
    }
    try {
      this.marks.set(id, { price: normalizeDecimal(raw), ts, source: 'venue_mark' })
    } catch {
      this.marks.delete(id)
    }
  }

  /** 交易侧要用：资产 ID、szDecimals、最大杠杆。 */
  getRecord(id: InstrumentId): InstrumentRecord | undefined {
    return this.records.get(id)
  }

  /** 各 dex 的发现状态（诊断 / 界面「行情源」用）。 */
  dexStatus(): Array<{ dex: string; status: DexStatus; markets: number; live: number; updatedAt: Ms }> {
    return [...this.dexes.values()].map((d) => {
      const live = d.coins.filter((c) => this.records.get(this.coinToId.get(c) ?? '')?.instrument.status !== 'delisted').length
      return { dex: d.name, status: d.status, markets: d.coins.length, live, updatedAt: d.ts }
    })
  }

  // ───────────── 行情读取 ─────────────

  quote(id: InstrumentId): StampedQuote | undefined {
    const now = this.clock()
    const b = this.bbo.get(id)
    const m = this.mids.get(id)
    const c = this.ctx.get(id)
    if (b && now - b.ts <= this.staleMs) {
      return { instrumentId: id, ts: b.ts, bid: b.bid, ask: b.ask, last: (b.bid + b.ask) / 2, stale: false, ageMs: Math.max(0, now - b.ts) }
    }
    // bbo 过期后退回 mid / 上下文里的 midPx
    const mid = m ?? (c?.ctx.midPrice ? { px: c.ctx.midPrice, ts: c.ts } : undefined)
    const best = b && (!mid || b.ts >= mid.ts) ? { px: (b.bid + b.ask) / 2, ts: b.ts, bid: b.bid, ask: b.ask } : mid ? { px: mid.px, ts: mid.ts, bid: mid.px, ask: mid.px } : undefined
    if (!best) return undefined
    const age = Math.max(0, now - best.ts)
    return { instrumentId: id, ts: best.ts, bid: best.bid, ask: best.ask, last: best.px, stale: age > this.staleMs, ageMs: age }
  }

  allMids(): Record<InstrumentId, number> {
    const out: Record<InstrumentId, number> = {}
    for (const id of this.visibleIds()) {
      const m = this.mids.get(id)
      if (m) out[id] = m.px
    }
    return out
  }

  /** 已缓存的上下文（同步，不联网）；纸面场所算资金费用它。 */
  cachedContext(id: InstrumentId): MarketContext | undefined {
    return this.ctx.get(id)?.ctx
  }

  async context(id: InstrumentId): Promise<MarketContext> {
    this.ensureStarted()
    const rec = this.records.get(id)
    if (!rec) throw new ProblemError(makeProblem('INSTRUMENT_UNKNOWN', 'unknown or delisted instrument'))
    const hit = this.ctx.get(id)
    if (hit && this.clock() - hit.ts < CTX_TTL_MS) return hit.ctx
    try {
      await this.loadDex(rec.dex, this.dexes.get(rec.dex)?.index ?? 0, 'query') // 调用方要这个数，是用户查询，不是后台任务
    } catch (e) {
      if (!hit) throw e // 刷新失败但有旧数据：沿用旧的
    }
    const fresh = this.ctx.get(id)
    if (!fresh) throw new ProblemError(makeProblem('DATA_UNAVAILABLE', 'unknown or unavailable market context'))
    return fresh.ctx
  }

  async book(id: InstrumentId, depth = 20): Promise<Book> {
    this.ensureStarted()
    const rec = this.records.get(id)
    const coin = rec?.coin ?? coinOf(id)
    const hit = this.books.get(id)
    if (hit && this.clock() - hit.ts < BOOK_FRESH_MS && this.wsRefs.has(JSON.stringify({ type: 'l2Book', coin }))) return cut(hit.book, depth)
    const raw = await this.info<unknown>({ type: 'l2Book', coin })
    const book = parseBook(raw, 50)
    this.books.set(id, { book, ts: this.clock() })
    return cut(book, depth)
  }

  /** 本地 L2 快照（同步，不联网）。没有快照返回 undefined；stale = 距上次更新超过 bookStaleMs。 */
  bookSnapshot(id: InstrumentId): BookSnapshot | undefined {
    const b = this.books.get(id)
    if (!b) return undefined
    return { book: b.book, asOf: b.ts, stale: this.clock() - b.ts > this.bookStaleMs }
  }

  /**
   * 快照缺失或陈旧时的 REST 兜底：同一标的最少间隔 bookRefreshMinMs、最长等待 maxWaitMs（默认 1 s，预算不够就放弃，不排队阻塞）。
   * 失败 / 被限频时原样返回现有快照（可能 stale 或 undefined），由调用方决定拒绝。
   */
  async refreshBook(id: InstrumentId, o: { maxWaitMs?: number } = {}): Promise<BookSnapshot | undefined> {
    this.ensureStarted()
    const now = this.clock()
    if (now - (this.bookRefreshAt.get(id) ?? -Infinity) < this.bookRefreshMinMs) return this.bookSnapshot(id)
    this.bookRefreshAt.set(id, now)
    try {
      const coin = this.records.get(id)?.coin ?? coinOf(id)
      const raw = await this.info<RawBook | null>({ type: 'l2Book', coin }, { kind: 'query', signal: AbortSignal.timeout(o.maxWaitMs ?? 1000) })
      if (raw && raw.levels) this.books.set(id, { book: { ...parseBook(raw, 50), instrumentId: id }, ts: this.clock() })
    } catch { /* 兜底失败：沿用现有快照 */ }
    return this.bookSnapshot(id)
  }

  /**
   * K 线。默认取最近 n 根（≤5000）；给 from / to 时翻页取全区间。
   * 每一页（已解析）都会交给注入的 recorder（录制器接口：落盘由外部实现）。
   */
  async candles(id: InstrumentId, interval: CandleInterval, opts: { n?: number; from?: Ms; to?: Ms } = {}): Promise<Candle[]> {
    this.ensureStarted()
    const step = INTERVAL_MS[interval]
    if (!step) throw new Error(`unsupported candle interval: ${interval}`)
    const coin = this.records.get(id)?.coin ?? coinOf(id)
    const end = opts.to ?? this.clock()
    if (opts.from === undefined) {
      const n = Math.max(1, Math.min(MAX_CANDLES, Math.floor(opts.n ?? 300)))
      const key = `${id}|${interval}`
      const hit = this.candleCache.get(key)
      if (hit && hit.candles.length >= n && this.clock() - hit.ts < CANDLE_TTL_MS) return hit.candles.slice(-n)
      // fix-r4 C8 → R1-PERF-01：请求本身 10 s 超时，等预算排队另算（最多 90 s），不再无限挂起也不再被后台发现流程的排队拖垮
      // GQ-01：显式写 query，不靠 HlHttp.info 的默认值（默认值一改又漏）
      const raw = await this.info<unknown>({ type: 'candleSnapshot', req: { coin, interval, startTime: end - (n + 2) * step, endTime: end } }, { kind: 'query', timeoutMs: CANDLE_TIMEOUT_MS, queueTimeoutMs: CANDLE_QUEUE_TIMEOUT_MS })
      const candles = parseCandles(raw)
      this.candleCache.set(key, { candles, ts: this.clock() })
      await this.recorder?.record(id, interval, candles)
      return candles.slice(-n)
    }
    // 区间翻页
    const out: Candle[] = []
    let cursor = opts.from
    for (let guard = 0; guard < 200 && cursor <= end; guard++) {
      const raw = await this.info<unknown>({ type: 'candleSnapshot', req: { coin, interval, startTime: cursor, endTime: end } }, { kind: 'query', timeoutMs: CANDLE_TIMEOUT_MS, queueTimeoutMs: CANDLE_QUEUE_TIMEOUT_MS }) // GQ-01：用户触发的历史请求走交互档，不与 dex 发现共用后台桶
      const page = parseCandles(raw).filter((c) => c.t >= cursor && c.t <= end)
      if (page.length === 0) break
      await this.recorder?.record(id, interval, page)
      out.push(...page)
      const next = page[page.length - 1]!.t + step
      if (page.length < CANDLE_PAGE || next <= cursor) break
      cursor = next
    }
    return out
  }

  // ───────────── 状态 ─────────────

  /** 资金费率历史。给 from（必填）/ to（默认当前时间）时按页拉取全区间。 */
  async fundingHistory(id: InstrumentId, opts: { from: Ms; to?: Ms }): Promise<FundingRatePoint[]> {
    this.ensureStarted()
    const coin = this.records.get(id)?.coin ?? coinOf(id)
    const end = opts.to ?? this.clock()
    const out: FundingRatePoint[] = []
    const seen = new Set<Ms>()
    let cursor = opts.from
    for (let guard = 0; guard < 200 && cursor <= end; guard++) {
      if (guard > 0 && this.fundingPageGapMs > 0) await new Promise((resolve) => setTimeout(resolve, this.fundingPageGapMs))
      // GQ-01：资金费历史翻页同样是用户触发的查询，走交互档
      const raw = await this.info<RawFundingRow[]>({ type: 'fundingHistory', coin, startTime: cursor, endTime: end }, { kind: 'query' })
      const page = raw
        .filter((r) => r.time >= cursor && r.time <= end)
        .sort((a, b) => a.time - b.time)
        .map((r) => ({ instrumentId: id, t: r.time as Ms, rate: normalizeDecimal(r.fundingRate), premium: normalizeDecimal(r.premium) }))
      if (page.length === 0) break
      for (const p of page) {
        if (seen.has(p.t)) continue
        seen.add(p.t)
        out.push(p)
      }
      const last = page[page.length - 1]!.t
      const next = last + 1
      if (page.length < FUNDING_PAGE || next <= cursor || next > end) break
      cursor = next
    }
    return out
  }

  /** 诊断：info 类 REST 的熔断器状态（MarketStatus 受协议约束，不往里加字段）。 */
  circuit(): { state: 'closed' | 'open' | 'half_open'; failures: number; opens: number; openedAt: number | null } {
    const s = this.breaker.stats()
    return { state: this.breaker.state(), failures: s.failures, opens: s.opens, openedAt: s.openedAt }
  }

  /**
   * 就绪度（R2-REL-02）：主 dex 标的是否已知、全部目录（含构建者 dex）是否完成过一轮。
   * 主 dex 约 3 s 就位，全部目录可能慢得多；内核据此在 start() 还没返回时就放行连接状态与启动对账。
   * 主 dex 刷新失败不会把它退回 false：记录保留在 coins 里。
   */
  readiness(): { primaryInstruments: boolean; catalogComplete: boolean } {
    const primaryInstruments = (this.dexes.get('')?.coins.length ?? 0) > 0
    return { primaryInstruments, catalogComplete: primaryInstruments && this.loaded && this.discoveryError === null }
  }

  status(): MarketStatus {
    const now = this.clock()
    const wsLive = !!this.ws?.live
    const restOk = this.restMode && this.lastRestOkTs > 0 && now - this.lastRestOkTs < Math.max(this.staleMs, this.pollMs * 3)
    const source: MarketStatus['source'] = wsLive ? 'ws' : restOk ? 'rest' : 'none'
    const last = Math.max(this.lastMsgTs, this.lastRestOkTs)
    const u = this.budget.usage()
    return {
      venue: VENUE,
      environment: this.environment,
      ts: now,
      wsState: wsLive ? 'connected' : this.ws && this.started ? 'connecting' : 'disconnected',
      ...(wsLive ? { latencyMs: { p50: this.ws!.rttMs, p95: this.ws!.rttMs } } : source === 'rest' ? { latencyMs: { p50: this.restLatencyMs, p95: this.restLatencyMs } } : {}),
      rateBudget: { used: u.used, limit: u.limit, windowMs: u.windowMs },
      stale: last === 0 || now - last > this.staleMs,
      source,
      lastMessageTs: last,
    }
  }

  // ───────────── 订阅 ─────────────

  subscribe(spec: SubscriptionSpec, cb: (e: VenueEvent) => void): Unsubscribe {
    if (this.closed) throw new Error('market closed')
    const instrumentId = 'instrumentId' in spec ? spec.instrumentId : undefined
    const record = instrumentId ? this.records.get(instrumentId) : undefined
    const knownInstrument = !instrumentId || (!!record && record.instrument.status !== 'delisted')
    if (knownInstrument) this.ensureStarted()
    const key = JSON.stringify(spec)
    let l = this.listeners.get(key)
    if (!l) { l = { spec, cbs: new Set() }; this.listeners.set(key, l) }
    if (l.cbs.size === 0 && knownInstrument) this.acquireWs(spec)
    l.cbs.add(cb)
    if (instrumentId && knownInstrument) this.retainMark(instrumentId)
    let released = false
    return () => {
      if (released) return
      released = true
      if (instrumentId && knownInstrument) this.releaseMark(instrumentId)
      const cur = this.listeners.get(key)
      if (!cur || !cur.cbs.delete(cb)) return
      if (cur.cbs.size === 0) { this.listeners.delete(key); this.releaseWs(spec) }
    }
  }

  private wsSubFor(spec: SubscriptionSpec): object | null {
    switch (spec.channel) {
      case 'quote': return { type: 'bbo', coin: this.coinFor(spec.instrumentId) }
      case 'book': return { type: 'l2Book', coin: this.coinFor(spec.instrumentId) }
      case 'candle': return { type: 'candle', coin: this.coinFor(spec.instrumentId), interval: spec.interval }
      case 'context': return { type: 'activeAssetCtx', coin: this.coinFor(spec.instrumentId) }
      case 'userFills': return { type: 'userFills', user: spec.address.toLowerCase() }
      case 'orderUpdates': return { type: 'orderUpdates', user: spec.address.toLowerCase() }
      default: return null // mids / instruments 不需要额外 WS 订阅
    }
  }

  private coinFor(id: InstrumentId): string {
    return this.records.get(id)?.coin ?? coinOf(id)
  }

  private acquireWs(spec: SubscriptionSpec): void {
    const sub = this.wsSubFor(spec)
    if (!sub || !this.ws) return
    const k = JSON.stringify(sub)
    const cur = this.wsRefs.get(k)
    if (cur) { cur.refs += 1; return }
    if (this.ws.subscriptionCount >= this.maxSubs) throw new Error(`websocket subscription limit reached (${this.maxSubs})`)
    this.wsRefs.set(k, { sub, refs: 1 })
    this.ws.subscribe(sub)
  }

  private releaseWs(spec: SubscriptionSpec): void {
    const sub = this.wsSubFor(spec)
    if (!sub || !this.ws) return
    const k = JSON.stringify(sub)
    const cur = this.wsRefs.get(k)
    if (!cur) return
    cur.refs -= 1
    if (cur.refs <= 0) { this.wsRefs.delete(k); this.ws.unsubscribe(sub) }
  }

  private emit(spec: SubscriptionSpec, e: VenueEvent): void {
    const l = this.listeners.get(JSON.stringify(spec))
    if (!l) return
    for (const cb of [...l.cbs]) {
      try { cb(e) } catch { /* 订阅者异常不影响别人 */ }
    }
  }

  // ───────────── WS 消息 ─────────────

  private onWsLive(): void {
    this.wsGeneration += 1
    this.restMode = false
    if (this.pollTimer) { clearTimeout(this.pollTimer); this.pollTimer = null }
  }

  private onWsDown(reason: string, failures: number): void {
    if (this.closed) return
    if (reason === 'stale' || failures >= WS_FAILS_TO_FALLBACK) this.enterRestMode()
  }

  private onWsMessage(msg: WsMessage, ts: number): void {
    switch (msg.channel) {
      case 'allMids': {
        const raw = msg.data?.mids as Record<string, string> | undefined
        if (!raw) return
        try { this.applyMids(raw, ts) } catch { return }
        this.lastMsgTs = ts
        return
      }
      case 'bbo': {
        const d = msg.data as { coin?: string; bbo?: Array<{ px?: string } | null> } | undefined
        if (!d?.coin || !Array.isArray(d.bbo)) return
        const bid = num(d.bbo[0]?.px)
        const ask = num(d.bbo[1]?.px)
        if (!(bid > 0) || !(ask > 0)) return
        this.lastMsgTs = ts
        const id = this.coinToId.get(d.coin) ?? instrumentIdOf(d.coin)
        this.bbo.set(id, { bid, ask, ts })
        this.emitQuote(id)
        return
      }
      case 'l2Book': {
        const d = msg.data as RawBook | undefined
        if (!d?.coin || !d.levels) return
        let book: Book
        try { book = parseBook(d, 50) } catch { return }
        this.lastMsgTs = ts
        const id = this.coinToId.get(d.coin) ?? book.instrumentId
        book.instrumentId = id
        this.books.set(id, { book, ts })
        this.emit({ channel: 'book', instrumentId: id }, { channel: 'book', book })
        return
      }
      case 'candle': {
        const d = msg.data as RawCandle | undefined
        if (!d?.s || !d.i) return
        let candle: Candle | undefined
        try { [candle] = parseCandles([d]) } catch { return }
        if (!candle) return
        this.lastMsgTs = ts
        const id = this.coinToId.get(d.s) ?? instrumentIdOf(d.s)
        const interval = d.i as CandleInterval
        this.emit({ channel: 'candle', instrumentId: id, interval }, { channel: 'candle', instrumentId: id, interval, candle })
        return
      }
      case 'activeAssetCtx': {
        const d = msg.data as { coin?: string; ctx?: RawCtx } | undefined
        if (!d?.coin || !d.ctx) return
        const id = this.coinToId.get(d.coin) ?? instrumentIdOf(d.coin)
        let context: MarketContext
        try { context = parseContext(id, d.ctx, ts) } catch { return }
        this.lastMsgTs = ts
        this.updateMark(id, d.ctx.markPx, ts)
        this.ctx.set(id, { ctx: context, ts })
        const tracked = this.trackedMarks.get(id)
        if (tracked) {
          tracked.lastPushAt = ts
          if (context.midPrice !== undefined && context.midPrice > 0) {
            this.mids.set(id, { px: context.midPrice, ts })
            this.pendingMidIds.add(id)
            this.scheduleNotify(ts)
            this.emitQuote(id)
          }
        }
        this.emit({ channel: 'context', instrumentId: id }, { channel: 'context', context })
        return
      }
      case 'userFills':
      case 'orderUpdates':
        this.lastMsgTs = ts
        this.onUserMessage?.(msg, ts)
        this.dispatchRaw(msg, ts)
        return
      case 'allDexsClearinghouseState':
      case 'spotState':
      case 'openOrders':
        this.lastMsgTs = ts
        this.dispatchRaw(msg, ts)
        return
      case 'subscriptionResponse': {
        const response = msg.data as { method?: string; subscription?: object } | undefined
        this.dispatchRaw(msg, ts)
        if (response?.method !== 'subscribe') return
        for (const entry of [...this.rawAckHandlers]) {
          if (!subscriptionMatches(entry.sub, response.subscription)) continue
          try { entry.handler() } catch { /* 确认回调异常不影响其它订阅 */ }
        }
        return
      }
      default:
        // pong 等：只用于存活判断
        return
    }
  }

  // ───────────── 账户流（账户模块用）─────────────

  private rawHandlers = new Map<string, Set<(data: any, ts: number) => void>>()
  private rawAckHandlers = new Set<{ sub: object; handler: () => void }>()

  private dispatchRaw(msg: WsMessage, ts: number): void {
    for (const h of [...(this.rawHandlers.get(msg.channel) ?? [])]) {
      try { h(msg.data, ts) } catch { /* 处理器异常不影响行情 */ }
    }
  }

  /**
   * 订阅一条原始 WS 订阅并接收它的推送（引用计数，和其它订阅共用同一条连接与订阅表）。
   * channel 是推送里的 channel 名；账户模块用它订 allDexsClearinghouseState / spotState / openOrders / userFills。
   */
  subscribeRaw(wsSub: object, channel: string, handler: (data: any, ts: number) => void, onAck?: () => void): Unsubscribe {
    if (this.closed) throw new Error('market closed')
    this.ensureStarted()
    let set = this.rawHandlers.get(channel)
    if (!set) { set = new Set(); this.rawHandlers.set(channel, set) }
    set.add(handler)
    const ack = onAck ? { sub: wsSub, handler: onAck } : undefined
    if (ack) this.rawAckHandlers.add(ack)
    const key = JSON.stringify(wsSub)
    if (this.ws) {
      const cur = this.wsRefs.get(key)
      if (cur) cur.refs += 1
      else {
        if (this.ws.subscriptionCount >= this.maxSubs) { set.delete(handler); if (ack) this.rawAckHandlers.delete(ack); throw new Error(`websocket subscription limit reached (${this.maxSubs})`) }
        this.wsRefs.set(key, { sub: wsSub, refs: 1 })
        this.ws.subscribe(wsSub)
      }
    }
    return () => {
      this.rawHandlers.get(channel)?.delete(handler)
      if (ack) this.rawAckHandlers.delete(ack)
      if (!this.ws) return
      const c = this.wsRefs.get(key)
      if (!c) return
      c.refs -= 1
      if (c.refs <= 0) { this.wsRefs.delete(key); this.ws.unsubscribe(wsSub) }
    }
  }

  /** WebSocket 当前是否在线（账户缓存据此决定要不要用 REST 兜底）。 */
  get wsLive(): boolean { return !!this.ws?.live }
  get wsHealthy(): boolean { return !!this.ws?.live && this.clock() - this.ws.lastMsgTs <= this.staleMs }
  get wsConnectionGeneration(): number { return this.wsGeneration }
  get hasWs(): boolean { return this.ws !== null }

  /** 用户流由 account 模块挂接（映射成交 / 订单更新需要账户语境）。 */
  onUserMessage: ((msg: WsMessage, ts: number) => void) | null = null

  /** 当前订阅了某用户流的地址（orderUpdates 的推送里没有 user 字段，按订阅地址转发）。 */
  userAddresses(channel: 'userFills' | 'orderUpdates'): Hex[] {
    const out: Hex[] = []
    for (const l of this.listeners.values()) if (l.spec.channel === channel && l.cbs.size > 0) out.push((l.spec as { address: Hex }).address)
    return out
  }

  /** 把用户流映射后的事件发给订阅者。 */
  emitUser(spec: Extract<SubscriptionSpec, { channel: 'userFills' | 'orderUpdates' }>, e: VenueEvent): void {
    this.emit(spec, e)
  }

  private applyMids(raw: Record<string, string>, ts: number): void {
    const names = this.loaded ? new Set(this.coinToId.keys()) : undefined
    const parsed = parseMids(raw, names)
    for (const [id, px] of Object.entries(parsed)) {
      this.mids.set(id, { px, ts })
      this.pendingMidIds.add(id)
    }
    this.scheduleNotify(ts)
  }

  private emitQuote(id: InstrumentId): void {
    const q = this.quote(id)
    if (q) this.emit({ channel: 'quote', instrumentId: id }, { channel: 'quote', quote: q })
  }

  /** mids 通知节流 ≤ 4 次 / 秒；每次把这段时间内变动的 quote 也各发一条。 */
  private scheduleNotify(ts: number): void {
    const now = this.clock()
    const wait = this.lastMidsNotify + NOTIFY_GAP_MS - now
    if (wait <= 0) { this.flushNotify(ts); return }
    if (this.midsTimer) return
    this.midsTimer = setTimeout(() => { this.midsTimer = null; this.flushNotify(this.clock()) }, wait)
    this.midsTimer.unref?.()
  }

  private flushNotify(ts: number): void {
    if (this.closed) return
    this.lastMidsNotify = this.clock()
    const ids = [...this.pendingMidIds]
    this.pendingMidIds.clear()
    if (this.listeners.has(JSON.stringify({ channel: 'mids' }))) {
      this.emit({ channel: 'mids' }, { channel: 'mids', mids: this.allMids(), ts })
    }
    for (const id of ids) {
      if (this.listeners.has(JSON.stringify({ channel: 'quote', instrumentId: id }))) this.emitQuote(id)
    }
  }

  // ───────────── REST 兜底 ─────────────

  /**
   * info（行情 / 元数据）类 REST 的汇聚点：熔断开启时不联网、不扣预算，直接抛 VENUE_UNAVAILABLE。
   * 2xx 且解析成功记成功；传输错误 / 超时 / 5xx / 429 记失败；其余 4xx 属于请求本身的问题，不计失败
   * （half_open 时也不计失败的错误会把在途许可归还给熔断器，避免半开许可泄漏）。
   */
  private async info<T>(body: InfoBody, o: InfoCallOptions = {}): Promise<T> {
    if (!this.breaker.allow()) {
      if (this.breaker.state() === 'half_open') {
        throw new ProblemError(makeProblem('VENUE_UNAVAILABLE', 'hyperliquid info circuit half-open; a probe request is in flight', { retryable: true }))
      }
      const { openedAt } = this.breaker.stats()
      const remaining = openedAt === null ? this.circuitCooldownMs : Math.max(0, openedAt + this.circuitCooldownMs - this.clock())
      throw new ProblemError(makeProblem('VENUE_UNAVAILABLE', `hyperliquid info circuit open; retry after ${remaining} ms（网络不通 / 连不上交易所）`, { retryable: true }))
    }
    try {
      const out = await this.http.info<T>(body, o)
      this.breaker.onSuccess()
      return out
    } catch (e) {
      if (countsAsCircuitFailure(e)) this.breaker.onFailure()
      else this.breaker.release()
      if (e instanceof ProblemError) throw e
      if (e instanceof HlHttpError && e.status >= 200 && e.status < 300) {
        throw new ProblemError(makeProblem('DATA_UNAVAILABLE', 'market data is unavailable'))
      }
      if (e instanceof HlHttpError || e instanceof HlNetworkError) {
        const wrapped = new ProblemError(problemFromTransportError(e, 'info'))
        wrapped.message = e.message
        throw wrapped
      }
      throw new ProblemError(makeProblem('DATA_UNAVAILABLE', 'market data is unavailable'))
    }
  }

  private enterRestMode(): void {
    if (this.closed) return
    if (this.restMode && this.pollTimer) return
    this.restMode = true
    this.schedulePoll(0)
  }

  private schedulePoll(delay: number): void {
    if (this.closed || !this.restMode) return
    if (this.pollTimer) clearTimeout(this.pollTimer)
    this.pollTimer = setTimeout(async () => {
      this.pollTimer = null
      if (this.closed || !this.restMode) return
      try { await this.pollMids() } catch { /* 下一轮重试；status() 会因 lastRestOkTs 过期而显示 none */ }
      this.schedulePoll(this.pollMs)
    }, delay)
    this.pollTimer.unref?.()
  }

  /** 每轮：默认 dex 必取，构建者 dex 轮流取一个（总请求量压在预算之内）。 */
  private async pollMids(): Promise<void> {
    const live = [...this.dexes.values()].filter((d) => d.name !== '' && d.status === 'live')
    const dexName = live.length ? live[this.restRound++ % live.length]!.name : null
    const t0 = this.clock()
    const jobs: Array<Promise<Record<string, string>>> = [this.info<Record<string, string>>({ type: 'allMids' })]
    if (dexName) jobs.push(this.info<Record<string, string>>({ type: 'allMids', dex: dexName }, { kind: 'background' }))
    const settled = await Promise.allSettled(jobs)
    const first = settled[0]!
    if (first.status === 'rejected') throw first.reason
    const now = this.clock()
    this.restLatencyMs = Math.max(0, now - t0)
    this.lastRestOkTs = now
    for (const r of settled) if (r.status === 'fulfilled') this.applyMids(r.value, now)
  }
}

/** 熔断只统计「没拿到可用响应」：传输错误 / 超时 / 5xx / 429；4xx（除 429）是请求本身的问题。 */
function countsAsCircuitFailure(e: unknown): boolean {
  if (e instanceof HlNetworkError) return true
  if (e instanceof HlHttpError) return e.status === 429 || e.status >= 500
  return false
}

function cut(b: Book, depth: number): Book {
  return { instrumentId: b.instrumentId, ts: b.ts, bids: b.bids.slice(0, depth), asks: b.asks.slice(0, depth) }
}
