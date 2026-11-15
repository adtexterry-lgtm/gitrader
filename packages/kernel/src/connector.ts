// SPDX-License-Identifier: CPAL-1.0
// 连接器总线（契约 §1.5、§3.6）。直接依赖 protocol 的连接器接口 `VenueConnector`（@gitrader/protocol/connector）：
//   注册场所（含内核模拟场所 kernel-sim）、能力声明、统一精度规则（normalize.ts）、速率预算共享对象、启动对账。
// 方向规则：内核 → 连接器 单向调用。连接器不能主动下单；下单一律先过授权书与风控闸，再由内核调用 submit。
import { supportsScheduleCancel } from '@gitrader/protocol/connector'
import type { GateAction, GateTarget, GateTicket } from '@gitrader/protocol'
import type {
  AccountRef, CancelAck, Hex, SignedEvent, SignerHandle, StartupSnapshot, SubmitResult, TradeContext, VenueConnector, VenueEvent, VenueFill, VenueOpenOrder,
} from '@gitrader/protocol/connector'
import { asDecimal, dec, isDecimal } from '@gitrader/protocol'
import { validateProblem } from '@gitrader/protocol'
import { makeProblem } from './proto'
import type { Account, Book, Candle, CandleInterval, Decimal, GateAccountView, Instrument, InstrumentId, OrderIntent, OrderStatus, Position, Problem, VenueCapabilities, VenueStatus, VenueRules } from './proto'
import { KernelRateBudget } from './budget'
import type { Signer } from './keystore'
import type { TypedData } from './eip712'
import { KernelError } from './util/errors'
import { digestOf } from './util/hash'
import type { Clock } from './util/clock'
import type { GateTicketAuthority } from './risk-gate/tickets'
import { WatchReader, emptyWatchSnapshot, emptyWatchStartup, isWatchAccount } from './watch'
import type { WatchSourceFactory } from './watch'

export type { VenueConnector }

export interface MarkPrice { price: Decimal; ts: number; source?: 'venue_mark' | 'last' | 'mid' }

export class ConnectorOperationError extends KernelError {
  readonly stages: string[]
  constructor(problem: Problem, stages: readonly string[], readonly metadata: { partialCancel?: { cancelled: number; acks: CancelAck[] }; viewFailure?: { problem: Problem; stages: string[] } } = {}) {
    super(problem)
    this.stages = [...new Set(stages)]
  }
  get partialCancel(): { cancelled: number; acks: CancelAck[] } | undefined { return this.metadata.partialCancel }
  get viewFailure(): { problem: Problem; stages: string[] } | undefined { return this.metadata.viewFailure }
}

export function connectorOperationError(error: unknown, stage: string, venueId: string): ConnectorOperationError {
  const stages = error instanceof ConnectorOperationError ? [...error.stages, stage] : [stage]
  const metadata = error instanceof ConnectorOperationError ? error.metadata : {}
  let problem: Problem | undefined
  if (error instanceof KernelError) problem = error.problem
  else if (error && typeof error === 'object' && 'problem' in error) {
    const validated = validateProblem(error.problem)
    if (validated.ok) problem = validated.value
  }
  if (!problem) {
    const message = error instanceof Error ? error.message : String(error)
    problem = makeProblem('VENUE_UNAVAILABLE', message, { retryable: true, venue: { id: venueId, message } })
  }
  return new ConnectorOperationError(problem, stages, metadata)
}

export class ReconcileSnapshotError extends ConnectorOperationError {
  constructor(problem: Problem, readonly last?: { stale: boolean; truncated: boolean }, stages: readonly string[] = ['reconcile']) { super(problem, stages) }
}

/** 内核视角的账户快照：权益 / 可用 / 持仓 / 场所侧挂单。 */
export interface AccountSnapshot {
  accountId: string
  ts: number
  equity: Decimal
  available: Decimal
  positions: Position[]
  openOrders: VenueOpenOrder[]
  asOf?: number
  confirmedAt?: number
  stale?: boolean
  truncated?: boolean
  availableDeductsOpenOrders?: boolean
  stopLossOrderIds?: string[]
  rules?: VenueRules
  gateOpenOrders?: GateAccountView['openOrders']
}

/** 规范化后的意图：size 一定存在，价格已规范，clientOrderId 已分配，市价类带滑点上限。 */
export interface NormalizedIntent extends OrderIntent {
  size: Decimal
  tif: NonNullable<OrderIntent['tif']>
  clientOrderId: string
}

export interface SubmitOutcome {
  /** accepted：场所接受（含已成交）；rejected：场所拒绝（problem.venue.message 为上游原文）；unknown：超时 / 结果未知（3006）。 */
  outcome: 'accepted' | 'rejected' | 'unknown'
  status?: OrderStatus
  venueOrderId?: string
  filledSize?: Decimal
  avgFillPrice?: Decimal | null
  problem?: Problem
  receiptHash?: string
  /** Preserve child receipts; the service owns their local order records. */
  acks?: SubmitResult['acks']
}

/** 内核总线上流出的事件（统一了真实连接器的 VenueEvent 与模拟场所的 PaperEvent）。 */
export type BusEvent =
  | { type: 'fill'; accountId: string; fill: VenueFill }
  | { type: 'orderUpdate'; accountId: string; venueOrderId: string; clientOrderId: string | null; instrumentId: InstrumentId; status: OrderStatus; ts: number }
  | { type: 'position'; accountId: string; instrumentId: InstrumentId; position: Position | null }
  | { type: 'quote'; instrumentId: InstrumentId; ts: number; bid: number; ask: number; last?: number }
  | { type: 'book'; book: Book }
  | { type: 'candle'; instrumentId: InstrumentId; interval: CandleInterval; candle: Candle }
  | { type: 'status'; status: VenueStatus }

// Extended with QuantDinger v5.6.5 (Apache-2.0) status table: backend_api_python/app/services/pending_orders/sent_order_recovery.py:9-19
// HL Info endpoint orderStatus list; verified against the installed SDK's orderUpdates declarations.
// waitingForTrigger / waitingForFill also occur in connector-hyperliquid/src/trading.ts.
/** 上游订单状态字符串 → 内核订单状态（大小写 / 空格 / 下划线不敏感；未知返回 undefined，不乱猜）。 */
export function mapVenueStatus(s: string | undefined): OrderStatus | undefined {
  switch ((s ?? '').trim().toLowerCase().replace(/[\s_]/g, '')) {
    case 'open': case 'resting': case 'triggered': case 'submitted': case 'presubmitted': case 'pendingsubmit': case 'pendingcancel': case 'new': case 'modified': case 'waitingforfill':
    case 'live': case 'created': case 'active': case 'trigger': case 'inprogress': case 'accepted': case 'pendingnew': case 'acceptedforbidding': case 'pendingreplace': case 'apipending': return 'open'
    case 'filled': case 'complete': case 'completed': case 'executed': return 'filled'
    case 'partiallyfilled': case 'partial': case 'partialfill': case 'partialfilled': return 'partially_filled'
    case 'canceled': case 'cancelled': case 'margincanceled': case 'apicancelled': case 'inactive':
    case 'siblingfilledcanceled': case 'reduceonlycanceled': case 'liquidatedcanceled': case 'selftradecanceled':
    case 'vaultwithdrawalcanceled': case 'openinterestcapcanceled': case 'delistedcanceled': case 'internalcancel': case 'outcomesettledcanceled':
    case 'cancel': case 'deactivated': case 'partiallyfilledcanceled': case 'mmpcanceled': return 'cancelled'
    case 'untriggered': case 'waitingfortrigger': case 'nottriggered': case 'pause': return 'untriggered'
    case 'rejected': case 'badalopx': case 'reduceonlyrejected': case 'insufficientspotbalancerejected': case 'failexecute': case 'failed': case 'orderfailed': case 'denied':
    case 'badtriggerpxrejected': case 'marketordernoliquidityrejected': case 'tickrejected': case 'mintradentlrejected':
    case 'perpmarginrejected': case 'positionincreaseatopeninterestcaprejected': case 'positionflipatopeninterestcaprejected':
    case 'oraclerejected': case 'badalopxrejected': case 'ioccancelrejected': case 'tooaggressiveatopeninterestcaprejected':
    case 'openinterestincreaserejected': case 'perpmaxpositionrejected': case 'toomanyopenordersrejected': return 'rejected'
    case 'expired': case 'scheduledcancel': case 'expiredinmatch': case 'expire': return 'expired'
    default: return undefined
  }
}

const ZERO_ADDR = `0x${'0'.repeat(40)}` as Hex
const NO_SIGNER: SignerHandle = { address: ZERO_ADDR, signTypedData: async () => { throw new KernelError(makeProblem('VENUE_AUTH', 'this account has no signer')) } }

export interface ConnectorRegistrationOptions {
  supportsOrderExpiry?: boolean
  unverified?: boolean
  pollOrders?: boolean
  deadman?: boolean
}
const EMPTY_REGISTRATION_OPTIONS: Readonly<ConnectorRegistrationOptions> = Object.freeze({})

/** 内核签名器 → 连接器要的 SignerHandle（signTypedData 形状）。 */
export function toSignerHandle(s: Signer): SignerHandle {
  return { address: s.address as Hex, signTypedData: async (p) => (await s.signTypedData(p as unknown as TypedData)) as Hex }
}

export class ConnectorBus {
  private connectors = new Map<string, VenueConnector>()
  private registrations = new Map<string, Readonly<ConnectorRegistrationOptions>>()
  private marketSources = new Map<string, VenueConnector>()
  private marketRegistrations = new Map<string, Readonly<ConnectorRegistrationOptions>>()
  private budgets = new Map<string, KernelRateBudget>()
  private watchers: (() => void)[] = []
  private handlers = new Set<(venue: string, e: BusEvent) => void>()
  private unknownStatuses = new Set<string>()
  private onUnknownStatus?: (event: { accountId: string; venue: string; rawStatus: string; venueOrderId?: string; clientOrderId?: string | null }) => void
  private onQueriedOrder?: (accountId: string, update: { venueOrderId: string; clientOrderId: string; status: OrderStatus }) => void

  setOrderStatusCallbacks(onUnknown: NonNullable<ConnectorBus['onUnknownStatus']>, onQueried: NonNullable<ConnectorBus['onQueriedOrder']>): void {
    this.onUnknownStatus = onUnknown
    this.onQueriedOrder = onQueried
  }
  private gateAuthority?: GateTicketAuthority
  private gateViolation?: (v: { accountId: string; action: GateAction; problem: Problem; ticketId?: string }) => void
  /** 模拟场所的连接器标识。 */
  static readonly SIM_ID = 'kernel-sim'
  /** 允许旧值取价时，先等连接器刷出新鲜标记的最长等待（内部选项，不入协议）。 */
  freshMarkWaitMs = 3_000

  /** R3-20：观察账户的只读读取器（只在 agent 的 account 工具里用；交易侧永远看到空账户）。 */
  private readonly watchReader = new WatchReader((venue) => this.connectors.get(venue) ?? this.marketSources.get(venue), () => this.clock.now())
  readWatch(a: Account): ReturnType<WatchReader['read']> { return this.watchReader.read(a) }
  /** R3-20：装配只读源工厂（观察账户所在网与场所连的网不一致时用；不登记进 connectors / marketSources，下单路由拿不到）。--offline 不装配。 */
  setWatchSourceFactory(factory: WatchSourceFactory): void { this.watchReader.setSourceFactory(factory) }

  constructor(private clock: Clock, private log?: (message: string) => void) {}

  private venueStatus(venue: string, raw: string | undefined, identity?: { accountId: string; venueOrderId?: string; clientOrderId?: string | null }): OrderStatus | undefined {
    const status = mapVenueStatus(raw)
    if (status) return status
    const key = JSON.stringify([venue, raw ?? ''])
    if (!this.unknownStatuses.has(key)) {
      this.unknownStatuses.add(key)
      // Logs deduplicate by venue/status; local-order audit deduplicates in TradingService.
      this.log?.(`warning: order.status_unknown ${JSON.stringify({ venue: venue.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80), status: (raw ?? '').replace(/[^a-zA-Z0-9_ -]/g, '').slice(0, 100) })}`)
    }
    if (identity) this.onUnknownStatus?.({ ...identity, venue, rawStatus: raw ?? '' })
    return undefined
  }

  setGateAuthority(authority: GateTicketAuthority, onViolation?: (v: { accountId: string; action: GateAction; problem: Problem; ticketId?: string }) => void): void {
    if (this.gateAuthority) throw new KernelError(makeProblem('INVALID_PARAMS', 'gate authority already installed'))
    this.gateAuthority = authority
    this.gateViolation = onViolation
  }

  private consumeGate(ticket: GateTicket | undefined, a: Account, action: GateAction, target: GateTarget): NonNullable<TradeContext['gate']> {
    try {
      if (!this.gateAuthority) throw new KernelError(makeProblem('GATE_TICKET_INVALID', 'gate ticket validation failed'))
      return this.gateAuthority.consume(ticket, a.accountId, action, target)
    } catch (error) {
      return this.raiseGateFailure(a, action, ticket, error)
    }
  }

  private raiseGateFailure(a: Account, action: GateAction, ticket: GateTicket | undefined, error?: unknown): never {
    const problem = error instanceof KernelError ? error.problem : makeProblem('GATE_TICKET_INVALID', 'gate ticket validation failed')
    try { this.gateViolation?.({ accountId: a.accountId, action, problem, ...(ticket?.ticketId ? { ticketId: ticket.ticketId } : {}) }) } catch { /* observer errors do not change authorization */ }
    throw error instanceof KernelError ? error : new KernelError(problem)
  }

  /** Bound one ticket-authorized connector call and every signature made within it. */
  private async runGateWrite<T>(a: Account, gate: NonNullable<TradeContext['gate']>, signer: Signer | undefined, run: (ctx: TradeContext) => Promise<T>): Promise<T> {
    const remainingMs = Math.min(30_000, gate.expiresAt - this.clock.now())
    if (remainingMs <= 0) throw new KernelError(makeProblem('GATE_TICKET_EXPIRED', 'gate ticket expired'))
    const controller = new AbortController()
    let alive = true
    const assertAlive = (): void => {
      if (!alive) throw new KernelError(makeProblem('GATE_TICKET_INVALID', 'gate call window is closed'))
      if (this.clock.now() >= gate.expiresAt) throw new KernelError(makeProblem('GATE_TICKET_EXPIRED', 'gate ticket expired'))
    }
    const boundedSigner: Signer | undefined = signer ? {
      walletId: signer.walletId, address: signer.address,
      signTypedData: async (typedData) => {
        assertAlive()
        const signature = await signer.signTypedData(typedData)
        assertAlive()
        return signature
      },
    } : undefined
    const ctx = this.tradeCtx(a, boundedSigner, undefined, controller.signal, gate)
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        alive = false
        controller.abort()
        reject(new KernelError(makeProblem('VENUE_OUTCOME_UNKNOWN', 'ticket-authorized connector call timed out')))
      }, remainingMs)
    })
    try {
      assertAlive()
      const operation = Promise.resolve().then(() => run(ctx)).then((result) => { assertAlive(); return result })
      return await Promise.race([operation, timeout])
    } finally {
      alive = false
      controller.abort()
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  /**
   * 创建（或取回）某场所共用的速率预算。创建连接器时注入：`new HyperliquidConnector({ budget: bus.budgetFor('hyperliquid') })`。
   * 同一台机器上该场所的所有连接共用一份。
   */
  budgetFor(venue: string, limit = 1200, windowMs = 60_000): KernelRateBudget {
    let b = this.budgets.get(venue)
    if (!b) { b = new KernelRateBudget({ limit, windowMs, clock: this.clock }); this.budgets.set(venue, b) }
    return b
  }
  budget(venue: string): KernelRateBudget | undefined { return this.budgets.get(venue) }
  /** 事后补记某场所的权重消耗。 */
  reportWeight(venue: string, weight: number): void { this.budgets.get(venue)?.charge(weight) }

  register(c: VenueConnector, options: ConnectorRegistrationOptions = {}): void {
    if (this.connectors.has(c.venue)) throw new KernelError(makeProblem('INVALID_PARAMS', `connector already registered: ${c.venue}`))
    this.connectors.set(c.venue, c)
    this.registrations.set(c.venue, Object.freeze({ ...options }))
    const rl = c.describe().rateLimits?.find((r) => r.model === 'weight' && r.limit && r.windowMs)
    if (rl) this.budgetFor(c.venue, rl.limit as number, rl.windowMs as number)
  }

  registerMarketSource(c: VenueConnector, options: ConnectorRegistrationOptions = {}): void {
    if (this.marketSources.has(c.venue)) throw new KernelError(makeProblem('INVALID_PARAMS', `market source already registered: ${c.venue}`))
    this.marketSources.set(c.venue, c)
    this.marketRegistrations.set(c.venue, Object.freeze({ ...options }))
    const rl = c.describe().rateLimits?.find((r) => r.model === 'weight' && r.limit && r.windowMs)
    if (rl) this.budgetFor(c.venue, rl.limit as number, rl.windowMs as number)
  }

  registrationOptions(venue: string): Readonly<ConnectorRegistrationOptions> { return this.registrations.get(venue) ?? this.marketRegistrations.get(venue) ?? EMPTY_REGISTRATION_OPTIONS }

  readStatus(venue: string) {
    const connector = this.connectors.get(venue) ?? this.marketSources.get(venue)
    if (!connector) return undefined
    const status = connector.status()
    const connectorBudget = (status as typeof status & { rateBudget?: VenueStatus['rateBudget'] | null }).rateBudget
    return {
      ...status,
      ...(this.registrationOptions(venue).unverified === true ? { unverified: true as const } : {}),
      rateBudget: connectorBudget ?? this.budget(venue)?.usage() ?? null,
    }
  }

  get(id: string): VenueConnector | undefined { return this.connectors.get(id) }
  list(): VenueConnector[] {
    const sources = new Map(this.marketSources)
    for (const [venue, connector] of this.connectors) sources.set(venue, connector)
    return [...sources.values()]
  }

  /** 下单路由：paper / shadow 账户一律走内核模拟场所；live 走真实场所。 */
  routeFor(account: Account): VenueConnector {
    // 观察账户没有任何下单路由：写、撤、杠杆、死人开关一律走到这里被拒（fail-closed）
    if (isWatchAccount(account)) throw new KernelError(makeProblem('CAPABILITY_UNSUPPORTED', `account ${account.alias} is a read-only watch account: it has no trading route`))
    const id = account.mode === 'live' ? account.venue : ConnectorBus.SIM_ID
    const c = this.connectors.get(id)
    if (!c) throw new KernelError(makeProblem(account.mode === 'live' ? 'VENUE_UNAVAILABLE' : 'ACCOUNT_NOT_BOUND', `no connector registered for ${id}`))
    return c
  }

  /** 行情与标的元数据来源：账户所属场所的连接器（纸面账户也用被模拟场所的行情）；没有就退回模拟场所。 */
  marketSource(venue: string): VenueConnector | undefined { return this.marketSources.get(venue) ?? this.connectors.get(venue) ?? this.connectors.get(ConnectorBus.SIM_ID) }

  instrument(id: InstrumentId): Instrument | undefined {
    const venue = id.slice(0, Math.max(0, id.indexOf(':')))
    const instrument = this.connectors.get(venue)?.getInstrument(id) ?? this.marketSources.get(venue)?.getInstrument(id) ?? this.connectors.get(ConnectorBus.SIM_ID)?.getInstrument(id)
    if (!instrument || instrument.venueSizeUnit !== 'base') return instrument
    return { ...instrument, contractSize: asDecimal('1') }
  }
  /** fix-r3 ADR-23：该标的所属场所的标的目录还在加载（有行情来源，但来源的标的列表全是空的）。没有任何来源返回 false。 */
  catalogLoading(id: InstrumentId): boolean {
    const venue = id.slice(0, Math.max(0, id.indexOf(':')))
    const sources = [this.connectors.get(venue), this.marketSources.get(venue)].filter((c): c is VenueConnector => c !== undefined)
    if (sources.length === 0) return false
    return sources.every((source) => {
      try { return source.listInstruments().length === 0 } catch { return true }
    })
  }
  /** 该场所的行情来源报告「连不上」（info 类 REST 熔断打开）。只读诊断，不参与任何判定。 */
  venueUnreachable(venue: string): boolean {
    return [this.connectors.get(venue), this.marketSources.get(venue)].some((c) => {
      try { return (c as { circuit?: () => { state: string } } | undefined)?.circuit?.().state === 'open' } catch { return false }
    })
  }
  /** 最近价（last，没有就取买卖中间价）。取不到返回 undefined——风控按"失败即拒"处理。 */
  mark(id: InstrumentId): MarkPrice | undefined {
    const venue = id.slice(0, Math.max(0, id.indexOf(':')))
    const q = this.marketSource(venue)?.quote(id) ?? this.connectors.get(ConnectorBus.SIM_ID)?.quote(id)
    if (!q) return undefined
    const px = q.last ?? (q.bid + q.ask) / 2
    if (!Number.isFinite(px) || px <= 0) return undefined
    return { price: dec.roundDec(String(px), 12) as Decimal, ts: q.ts, source: q.last !== undefined ? 'last' : 'mid' }
  }
  async gateMark(id: InstrumentId, options: { deadline?: number; maxAgeMs?: number; allowStale?: boolean; cacheOnly?: boolean } = {}): Promise<MarkPrice | undefined> {
    try {
      const venue = id.slice(0, Math.max(0, id.indexOf(':')))
      const source = this.marketSource(venue)
      const markedSource = source as (VenueConnector & { mark?: (instrumentId: InstrumentId, options?: { allowStale?: boolean }) => MarkPrice | undefined }) | undefined
      if (typeof markedSource?.mark === 'function') {
        const maxAgeMs = options.maxAgeMs ?? 5_000
        const readMark = (allowStale: boolean): MarkPrice | undefined => {
          try {
            const mark = markedSource.mark!(id, allowStale ? { allowStale: true } : {})
            if (!mark || mark.source !== 'venue_mark' || !isDecimal(mark.price) || mark.price === '0' || mark.price.startsWith('-')) return undefined
            const now = this.clock.now()
            if (!Number.isInteger(mark.ts) || mark.ts < 0 || mark.ts > now || (!allowStale && now - mark.ts > maxAgeMs)) return undefined
            return mark
          } catch { return undefined }
        }
        const readFresh = (): MarkPrice | undefined => readMark(false)
        if (options.allowStale !== true) {
          let mark = readFresh()
          while (!mark && !options.cacheOnly && options.deadline !== undefined && performance.now() < options.deadline) {
            const remaining = options.deadline - performance.now()
            await new Promise<void>((resolve) => setTimeout(resolve, Math.min(50, remaining)))
            mark = readFresh()
          }
          return mark
        }
        // 允许旧值时先等连接器刷出新鲜标记；等不到才退回旧值（fail-closed 判定不放宽）。
        // cacheOnly 没有等待窗口，单次旧值读取与「先新鲜、再旧值」等价，且保持只读一次契约。
        if (options.cacheOnly) return readMark(true)
        let mark = readFresh()
        if (!mark && options.deadline !== undefined) {
          const waitUntil = Math.min(options.deadline, performance.now() + this.freshMarkWaitMs)
          while (!mark && performance.now() < waitUntil) {
            const remaining = waitUntil - performance.now()
            await new Promise<void>((resolve) => setTimeout(resolve, Math.min(50, remaining)))
            mark = readFresh()
          }
        }
        return mark ?? readMark(true)
      }
      if (options.cacheOnly) return undefined
      const contextPromise = source?.context(id)
      let context: Awaited<typeof contextPromise>
      if (options.deadline !== undefined) {
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          context = await Promise.race([
            Promise.resolve(contextPromise),
            new Promise<undefined>((resolve) => {
              timer = setTimeout(() => resolve(undefined), Math.max(0, options.deadline! - performance.now()))
            }),
          ])
        } finally {
          if (timer !== undefined) clearTimeout(timer)
        }
      } else context = await contextPromise
      const price = context?.markPrice
      const now = this.clock.now()
      if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0 || !context || !Number.isInteger(context.ts) || context.ts < 0 || context.ts > now) return undefined
      return { price: dec.roundDec(String(price), 12) as Decimal, ts: context.ts, source: 'venue_mark' }
    } catch { return undefined }
  }
  instruments(): Instrument[] {
    const byId = new Map<InstrumentId, Instrument>()
    const add = (connector: VenueConnector): void => {
      for (const instrument of connector.listInstruments()) if (!byId.has(instrument.instrumentId)) byId.set(instrument.instrumentId, instrument)
    }
    for (const connector of this.connectors.values()) add(connector)
    for (const connector of this.marketSources.values()) add(connector)
    return [...byId.values()].map((instrument) => instrument.venueSizeUnit === 'base' ? { ...instrument, contractSize: asDecimal('1') } : instrument)
  }

  capabilities(venue: string): VenueCapabilities | undefined { return this.connectors.get(venue)?.describe() }
  hasDeadman(account: Account): boolean {
    const c = this.connectors.get(account.venue)
    return !!c && account.mode === 'live' && this.registrationOptions(account.venue).deadman !== false && supportsScheduleCancel(c.describe())
  }
  supportsOrderExpiry(account: Account): boolean { return this.registrationOptions(this.routeFor(account).venue).supportsOrderExpiry ?? false }

  // ---- 账户引用 / 调用上下文 -------------------------------------------------------------
  accountRef(a: Account): AccountRef {
    return {
      accountId: a.accountId, address: (a.owner.address ?? ZERO_ADDR) as Hex,
      ...(a.vault?.address ? { vaultAddress: a.vault.address as Hex } : {}),
      ...(['standard', 'unified', 'portfolio'].includes(a.accountModel) ? { accountModel: a.accountModel as 'standard' } : {}),
      ...(a.builder ? { builder: { status: a.builder.status } } : {}),
    }
  }
  tradeCtx(a: Account, signer?: Signer, onSigned?: (e: SignedEvent) => void, signal?: AbortSignal, gate?: TradeContext['gate']): TradeContext {
    return { account: this.accountRef(a), signer: signer ? toSignerHandle(signer) : NO_SIGNER, ...(onSigned ? { onSigned } : {}), ...(signal ? { signal } : {}), ...(gate ? { gate } : {}) }
  }

  // ---- 读 -------------------------------------------------------------------------------
  /**
   * 账户快照。集成修补（H）：实盘账户一次快照在 Hyperliquid 上要 ~110 权重（每个 dex 一次 clearinghouseState + frontendOpenOrders），
   * 工作台三块同时挂载会并发查 9 次，5 秒内把 60% 权重预算吃满，之后批准的实盘单要排队近一分钟。
   * 所以：同一账户正在进行中的快照一律合并（并发调用拿同一个结果，不影响新鲜度）；只读查询可以再接受 maxAgeMs 内的上一次结果。
   * 风控预检 / 接管走默认 maxAgeMs = 0（只合并在途，不吃旧值）。该账户的成交 / 订单 / 持仓事件到来即作废缓存。
   */
  snapshot(a: Account, o: { maxAgeMs?: number } = {}): Promise<AccountSnapshot> {
    if (isWatchAccount(a)) return Promise.resolve(emptyWatchSnapshot(a.accountId, this.clock.now())) // 交易侧：观察账户是空账户（真实持仓只经 readWatch）
    const routeKey = this.snapshotRouteKey(a)
    const fetch = async (): Promise<AccountSnapshot> => {
      const vc = this.routeFor(a)
      const ref = this.accountRef(a)
      const [s, oo] = await Promise.all([vc.accountState(ref), vc.openOrders(ref)])
      if ((s as typeof s & { ok?: boolean }).ok === false) throw new KernelError(makeProblem('DATA_UNAVAILABLE', 'account snapshot is unavailable'))
      return {
        accountId: a.accountId, ts: s.ts, equity: s.margin.equity, available: s.margin.available, positions: s.positions, openOrders: oo,
        asOf: s.asOf ?? s.ts,
        ...(s.confirmedAt === undefined ? {} : { confirmedAt: s.confirmedAt }),
        ...(s.stale === undefined ? {} : { stale: s.stale }),
        ...((s as typeof s & { truncated?: boolean }).truncated === undefined ? {} : { truncated: (s as typeof s & { truncated?: boolean }).truncated }),
        ...(s.availableDeductsOpenOrders === undefined ? {} : { availableDeductsOpenOrders: s.availableDeductsOpenOrders }),
        ...(s.stopLossOrderIds === undefined ? {} : { stopLossOrderIds: s.stopLossOrderIds }),
        ...(s.rules === undefined ? {} : { rules: s.rules }),
        ...(s.openOrders === undefined ? {} : { gateOpenOrders: s.openOrders }),
      }
    }
    if (a.mode !== 'live') return fetch() // 模拟场所在进程内，没有权重成本
    const hit = this.snaps.get(a.accountId)
    const now = this.clock.now()
    const maxAgeMs = o.maxAgeMs ?? 0
    if (hit?.routeKey === routeKey && hit.doneAt === undefined) return hit.p
    if (hit?.routeKey === routeKey && maxAgeMs > 0 && hit.doneAt !== undefined && now - hit.doneAt <= maxAgeMs) return hit.p
    const entry: { routeKey: string; p: Promise<AccountSnapshot>; doneAt?: number } = { routeKey, p: fetch() }
    this.snaps.set(a.accountId, entry)
    entry.p.then(() => { entry.doneAt = this.clock.now() }, () => { if (this.snaps.get(a.accountId) === entry) this.snaps.delete(a.accountId) })
    return entry.p
  }
  invalidateSnapshot(accountId: string): void { this.snaps.delete(accountId) }
  private snaps = new Map<string, { routeKey: string; p: Promise<AccountSnapshot>; doneAt?: number }>()
  snapshotRouteKey(a: Account): string { return digestOf({ mode: a.mode, venue: a.venue, environment: a.environment ?? null, account: this.accountRef(a) }) }
  /** 读查询（工作台块 / Agent 只读工具）可接受的快照年龄。 */
  static readonly READ_SNAPSHOT_MAX_AGE_MS = 3000

  /** 启动对账（超时 = 结果未知）：在单一总时限内等到账户与成交视图新鲜完整。 */
  async reconcile(a: Account, timeoutMs = 10_000, fillsSinceMs = this.clock.now() - 24 * 3600_000, options: { maxRequests?: number } = {}): Promise<StartupSnapshot> {
    const maxRequests = options.maxRequests
    if (maxRequests !== undefined && (!Number.isInteger(maxRequests) || maxRequests <= 0)) throw new KernelError(makeProblem('INVALID_PARAMS', 'maxRequests must be a positive integer'))
    if (isWatchAccount(a)) return emptyWatchStartup(a.accountId, this.clock.now(), fillsSinceMs)
    const vc = this.routeFor(a)
    const ref = this.accountRef(a), deadline = performance.now() + Math.max(0, timeoutMs)
    let last: StartupSnapshot | undefined
    let requests = 0
    const lastState = () => last ? { stale: last.account.stale === true, truncated: last.truncated === true } : undefined
    const timedOut = () => new ReconcileSnapshotError(makeProblem('VENUE_OUTCOME_UNKNOWN', `reconcile timed out after ${timeoutMs} ms`, { venue: { id: vc.venue, message: 'startup snapshot query timed out' } }), lastState())
    while (true) {
      const remaining = deadline - performance.now()
      if (remaining <= 0) throw timedOut()
      let timer: ReturnType<typeof setTimeout> | undefined
      let snapshot: StartupSnapshot
      try {
        requests++
        snapshot = await Promise.race([
          vc.startupSnapshot(ref, fillsSinceMs),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(timedOut()), remaining) }),
        ])
      } catch (error) {
        if (error instanceof ReconcileSnapshotError) throw error
        const operation = connectorOperationError(error, 'reconcile', vc.venue)
        throw new ReconcileSnapshotError(operation.problem, lastState(), operation.stages)
      } finally { if (timer) clearTimeout(timer) }
      if (performance.now() >= deadline) throw timedOut()
      last = snapshot
      if (snapshot.account.stale !== true && snapshot.truncated !== true) return snapshot
      if (maxRequests !== undefined && requests >= maxRequests) {
        throw new ReconcileSnapshotError(makeProblem('VENUE_OUTCOME_UNKNOWN', `reconcile request limit ${maxRequests} reached before a fresh complete view`, { retryable: true, venue: { id: vc.venue, message: 'reconcile request limit reached' } }), lastState())
      }
      const waitMs = Math.min(100, deadline - performance.now())
      if (waitMs <= 0) throw timedOut()
      let sleepTimer: ReturnType<typeof setTimeout> | undefined
      try {
        await new Promise<void>((resolve) => { sleepTimer = setTimeout(resolve, waitMs) })
      } finally { if (sleepTimer) clearTimeout(sleepTimer) }
      if (performance.now() >= deadline) throw timedOut()
    }
  }

  /** 按 clientOrderId 查订单状态（结果未知时先查再动）。查不到返回 null。 */
  observeSnapshot(a: Account, sinceMs: number): Promise<StartupSnapshot> {
    if (isWatchAccount(a)) return Promise.resolve(emptyWatchStartup(a.accountId, this.clock.now(), sinceMs))
    const connector = this.routeFor(a)
    return connector.startupSnapshot(this.accountRef(a), sinceMs)
  }

  async lookup(a: Account, clientOrderId: string, options: { instrumentId?: InstrumentId; venueOrderId?: string; sinceMs?: number; signal?: AbortSignal; observeOnly?: boolean } = {}): Promise<{ status: OrderStatus; venueOrderId?: string; filledSize?: Decimal; avgFillPrice?: Decimal } | null> {
    if (options.signal?.aborted) return null
    const vc = this.routeFor(a), ref = this.accountRef(a)
    const r = await vc.orderStatus(ref, { clientOrderId, ...(options.venueOrderId ? { venueOrderId: options.venueOrderId } : {}), ...(options.instrumentId ? { instrumentId: options.instrumentId } : {}) })
    if (options.signal?.aborted) return null
    if (!r.found) return null
    const status = this.venueStatus(vc.venue, r.status, { accountId: a.accountId, clientOrderId, venueOrderId: r.venueOrderId ?? options.venueOrderId })
    if (!status) return null
    // Only local-order lookups supply a fill cursor. Identity refresh and foreign orders are status-only.
    if (!options.observeOnly && options.sinceMs !== undefined) {
      const fills = await vc.fills(ref, options.sinceMs, options.instrumentId ? { instrumentId: options.instrumentId } : undefined)
      if (options.signal?.aborted) return null
      for (const fill of fills) {
        if (options.signal?.aborted) return null
        if (fill.venueOrderId === (r.venueOrderId ?? options.venueOrderId) || !!clientOrderId && fill.clientOrderId === clientOrderId) this.emit(vc.venue, { type: 'fill', accountId: a.accountId, fill })
      }
    }
    if (options.signal?.aborted) return null
    if (!options.observeOnly) this.onQueriedOrder?.(a.accountId, { venueOrderId: r.venueOrderId ?? options.venueOrderId ?? '', clientOrderId, status })
    return {
      status,
      ...(r.venueOrderId ? { venueOrderId: r.venueOrderId } : {}),
      ...(r.filledSize ? { filledSize: r.filledSize } : {}),
      ...(r.avgFillPrice !== undefined && isDecimal(r.avgFillPrice) ? { avgFillPrice: r.avgFillPrice } : {}),
    }
  }

  /** Poll venue fills and emit them through the same bus path used by connector events. */
  async pollFills(a: Account, sinceMs: number, options: { instrumentId: InstrumentId; signal?: AbortSignal }): Promise<VenueFill[]> {
    if (options.signal?.aborted) return []
    const vc = this.routeFor(a), ref = this.accountRef(a)
    const fills = await vc.fills(ref, sinceMs, { instrumentId: options.instrumentId })
    if (options.signal?.aborted) return fills
    for (const fill of fills) {
      if (options.signal?.aborted) break
      this.emit(vc.venue, { type: 'fill', accountId: a.accountId, fill })
    }
    return fills
  }

  // ---- 写（内核发起）---------------------------------------------------------------------
  async submit(a: Account, intent: NormalizedIntent, o: { signer?: Signer; onSigned?: (e: SignedEvent) => void; ticket?: GateTicket } = {}): Promise<SubmitOutcome> {
    const action: GateAction = intent.reduceOnly === true ? 'reduce' : 'open'
    const gate = this.consumeGate(o.ticket, a, action, { kind: 'order', intent })
    return this.runGateWrite(a, gate, o.signer, async (ctx) => {
      const r = await this.routeFor(a).submit({ ...ctx, ...(o.onSigned ? { onSigned: o.onSigned } : {}) }, [intent])
      const ack = r.acks.find((x) => x.role === undefined || x.role === 'parent') ?? r.acks[0]
      if (!ack) return { outcome: 'unknown', problem: makeProblem('VENUE_OUTCOME_UNKNOWN', 'connector returned no acknowledgement'), receiptHash: r.receiptHash, acks: r.acks }
      if (ack.status === 'rejected') return { outcome: 'rejected', ...(ack.problem ? { problem: ack.problem } : {}), receiptHash: r.receiptHash, acks: r.acks }
      if (ack.status === 'unknown') return { outcome: 'unknown', problem: ack.problem ?? makeProblem('VENUE_OUTCOME_UNKNOWN', 'outcome unknown'), receiptHash: r.receiptHash, acks: r.acks }
      const filled = dec.cmpDec(ack.filledSize, '0') > 0
      const status: OrderStatus = ack.status === 'filled' ? 'filled' : ack.status === 'untriggered' ? 'untriggered' : filled ? 'partially_filled' : 'open'
      return { outcome: 'accepted', status, ...(ack.venueOrderId ? { venueOrderId: ack.venueOrderId } : {}), filledSize: ack.filledSize, avgFillPrice: ack.avgFillPrice, receiptHash: r.receiptHash, acks: r.acks }
    })
  }

  async cancel(a: Account, t: { instrumentId: InstrumentId; orderId?: string; clientOrderId?: string; tpslRole?: 'sl' | 'tp'; venueOrderId?: string | null }, o: { signer?: Signer; ticket?: GateTicket } = {}): Promise<CancelAck> {
    const action: GateAction = t.tpslRole === 'sl' ? 'cancel_protective' : 'cancel'
    if (!t.orderId?.trim() || !t.clientOrderId?.trim()) return this.raiseGateFailure(a, action, o.ticket)
    const gate = this.consumeGate(o.ticket, a, action, { kind: 'cancel', targets: [{ orderId: t.orderId, clientOrderId: t.clientOrderId, ...(t.tpslRole ? { tpslRole: t.tpslRole } : {}) }] })
    return this.runGateWrite(a, gate, o.signer, async (ctx) => {
      const acks = await this.routeFor(a).cancel(ctx, [{ instrumentId: t.instrumentId, clientOrderId: t.clientOrderId, ...(t.venueOrderId ? { venueOrderId: t.venueOrderId } : {}) }])
      return acks[0] ?? { target: { instrumentId: t.instrumentId }, ok: false }
    })
  }

  /** 全撤。keepProtective（默认 true）：保留已知止损与无法证明不是止损的触发单；已知止盈可撤。 */
  async cancelAll(a: Account, o: { instrumentId?: InstrumentId; keepProtective?: boolean; signer?: Signer; ticket?: GateTicket } = {}): Promise<{ cancelled: number; acks: CancelAck[]; viewFailure?: { problem: Problem; stages: string[] } }> {
    if (isWatchAccount(a)) return { cancelled: 0, acks: [] } // 观察账户上没有我们的挂单，全撤是空操作（接管遇到它不报错）
    const keepProtective = o.keepProtective ?? true
    const gate = this.consumeGate(o.ticket, a, keepProtective ? 'cancel' : 'cancel_protective', { kind: 'cancel_all', ...(o.instrumentId ? { instrumentId: o.instrumentId } : {}), keepProtective })
    return this.runGateWrite(a, gate, o.signer, async (ctx) => {
      const vc = this.routeFor(a)
      const ref = this.accountRef(a)
      const [accountResult, ordersResult] = await Promise.allSettled([vc.accountState(ref), vc.openOrders(ref)])
      const cachedAccount = accountResult.status === 'fulfilled' ? accountResult.value : undefined
      const cachedOrders = ordersResult.status === 'fulfilled' ? ordersResult.value : undefined
      let snapshot = cachedAccount
      let orders = cachedOrders
      let viewError: ConnectorOperationError | undefined
      if (accountResult.status === 'rejected' || ordersResult.status === 'rejected') {
        const firstFailure = accountResult.status === 'rejected' ? accountResult.reason : (ordersResult as PromiseRejectedResult).reason
        viewError = connectorOperationError(firstFailure, 'cancel_all.cached_view', vc.venue)
      } else if (cachedAccount!.stale === true || (cachedAccount as typeof cachedAccount & { truncated?: boolean }).truncated === true) {
        try {
          const remote = await this.reconcile(a, 10_000, this.clock.now(), { maxRequests: 3 })
          snapshot = remote.account
          orders = remote.openOrders
        } catch (error) { viewError = connectorOperationError(error, 'cancel_all', vc.venue) }
      }
      if (viewError) {
        const viewFailure = { problem: viewError.problem, stages: viewError.stages }
        if (o.keepProtective === false) {
          ctx.signal?.throwIfAborted()
          try {
            const acks = await vc.cancelAll(ctx, o.instrumentId)
            return { cancelled: acks.filter((x) => x.ok).length, acks, viewFailure }
          } catch (error) {
            const operation = connectorOperationError(error, 'cancel_all', vc.venue)
            throw new ConnectorOperationError(operation.problem, operation.stages, { viewFailure })
          }
        }
        if (cachedAccount && cachedOrders) {
          const slIds = new Set(cachedAccount.stopLossOrderIds ?? [])
          const ordinaryTypes: readonly string[] = ['limit', 'market']
          const candidates = cachedOrders.filter((order) => {
            if (o.instrumentId && order.instrumentId !== o.instrumentId) return false
            if (typeof order.instrumentId !== 'string' || !order.instrumentId.trim()) return false
            if (!order.venueOrderId?.trim() && !order.clientOrderId?.trim()) return false
            if (slIds.has(order.venueOrderId) || (!!order.clientOrderId && slIds.has(order.clientOrderId))) return false
            return ordinaryTypes.includes(order.type) && order.reduceOnly === false && order.isTrigger === false
          })
          if (candidates.length) {
            ctx.signal?.throwIfAborted()
            const targets = candidates.map((order) => ({ instrumentId: order.instrumentId, ...(order.venueOrderId ? { venueOrderId: order.venueOrderId } : {}), ...(order.clientOrderId ? { clientOrderId: order.clientOrderId } : {}) }))
            try {
              const acks = await vc.cancel(ctx, targets)
              throw new ConnectorOperationError(viewError.problem, viewError.stages, { partialCancel: { cancelled: acks.filter((ack) => ack.ok).length, acks }, viewFailure })
            } catch (error) {
              if (error instanceof ConnectorOperationError && error.problem === viewError.problem) throw error
              const operation = connectorOperationError(error, 'cancel_all', vc.venue)
              throw new ConnectorOperationError(operation.problem, operation.stages, { viewFailure })
            }
          }
        }
        throw viewError
      }
      const usedIncompleteCache = cachedAccount!.stale === true || (cachedAccount as typeof cachedAccount & { truncated?: boolean }).truncated === true
      if (!usedIncompleteCache && !keepProtective) {
        try {
          ctx.signal?.throwIfAborted()
          const acks = await vc.cancelAll(ctx, o.instrumentId)
          return { cancelled: acks.filter((x) => x.ok).length, acks }
        } catch (error) { throw connectorOperationError(error, 'cancel_all', vc.venue) }
      }
      // 缓存视图已 fulfilled，或 bounded reconcile 已返回 snapshot/orders。
      const slIds = new Set(snapshot!.stopLossOrderIds ?? [])
      const open = orders!.filter((x) => {
        if (o.instrumentId && x.instrumentId !== o.instrumentId) return false
        if (!keepProtective) return true
        const knownSl = slIds.has(x.venueOrderId) || (!!x.clientOrderId && slIds.has(x.clientOrderId))
        const stop = x.type === 'stop_market' || x.type === 'stop_limit'
        const unknownTrigger = x.isTrigger === true && !stop && !x.type.startsWith('take_')
        return !(knownSl || (x.reduceOnly && stop) || unknownTrigger)
      })
      if (!open.length) return { cancelled: 0, acks: [] }
      try {
        ctx.signal?.throwIfAborted()
        const acks = await vc.cancel(ctx, open.map((x) => ({ instrumentId: x.instrumentId, venueOrderId: x.venueOrderId, ...(x.clientOrderId ? { clientOrderId: x.clientOrderId } : {}) })))
        return { cancelled: acks.filter((x) => x.ok).length, acks }
      } catch (error) { throw connectorOperationError(error, 'cancel_all', vc.venue) }
    })
  }

  /** 场所级死人开关：atMs 到点全撤；null = 解除。 */
  async scheduleCancel(a: Account, atMs: number | null, signer?: Signer, ticket?: GateTicket): Promise<{ ok: boolean; problem?: Problem }> {
    const action: GateAction = atMs === null ? 'deadman_disarm' : 'deadman_arm'
    const gate = this.consumeGate(ticket, a, action, { kind: 'deadman', atMs })
    return this.runGateWrite(a, gate, signer, async (ctx) => {
      try { await this.routeFor(a).scheduleCancel(ctx, atMs); return { ok: true } } catch (e) {
        return { ok: false, problem: connectorOperationError(e, 'deadman.schedule', this.routeFor(a).venue).problem }
      }
    })
  }

  async setLeverage(a: Account, instrumentId: InstrumentId, leverage: number, marginMode: 'cross' | 'isolated', o: { signer?: Signer; ticket?: GateTicket } = {}): Promise<void> {
    const gate = this.consumeGate(o.ticket, a, 'leverage', { kind: 'leverage', instrumentId, leverage, marginMode })
    return this.runGateWrite(a, gate, o.signer, async (ctx) => this.routeFor(a).setLeverage(ctx, instrumentId, leverage, marginMode))
  }

  async amend(a: Account, intent: NormalizedIntent, o: { signer?: Signer; ticket?: GateTicket; venueOrderId?: string } = {}): Promise<SubmitResult> {
    const gate = this.consumeGate(o.ticket, a, 'amend', { kind: 'order', intent })
    return this.runGateWrite(a, gate, o.signer, async (ctx) => this.routeFor(a).amend(ctx, { instrumentId: intent.instrumentId, clientOrderId: intent.clientOrderId, ...(o.venueOrderId ? { venueOrderId: o.venueOrderId } : {}), order: intent }))
  }

  // ---- 事件 -----------------------------------------------------------------------------
  /** 统一的事件出口：真实连接器的 VenueEvent、模拟场所的 PaperEvent 都从这里流出。 */
  onEvent(h: (venue: string, e: BusEvent) => void): () => void { this.handlers.add(h); return () => { this.handlers.delete(h) } }
  private emit(venue: string, e: BusEvent): void {
    if ('accountId' in e && typeof e.accountId === 'string') this.snaps.delete(e.accountId) // 账户有变化：快照缓存作废
    for (const h of this.handlers) { try { h(venue, e) } catch { /* 订阅者异常不影响总线 */ } }
  }

  /** 订阅某账户的成交 / 订单更新（实盘：userFills + orderUpdates；模拟场所：onEvent）。 */
  watchAccount(a: Account): void {
    if (isWatchAccount(a)) return // 观察账户没有成交 / 订单流可订阅
    const vc = this.routeFor(a)
    const paper = vc as VenueConnector & { onEvent?: (cb: (e: any) => void) => () => void } // eslint-disable-line @typescript-eslint/no-explicit-any
    if (a.mode !== 'live' && typeof paper.onEvent === 'function') {
      this.watchers.push(paper.onEvent((e) => {
        if (e.accountId !== a.accountId) return
        if (e.kind === 'fill') this.emit(vc.venue, { type: 'fill', accountId: a.accountId, fill: { venueOrderId: e.venueOrderId, clientOrderId: e.clientOrderId ?? null, venueFillId: e.fillId, instrumentId: e.instrumentId, side: e.side, price: e.price, size: e.size, fee: e.fee, feeCcy: a.paper?.ccy ?? 'USDC', liquidity: e.liquidity, realizedPnl: e.realizedPnl, ...(e.liquidation ? { liquidation: true } : {}), ts: e.ts } as VenueFill })
        else if (e.kind === 'order') { const st = this.venueStatus(vc.venue, e.order.status, { accountId: a.accountId, venueOrderId: e.order.venueOrderId, clientOrderId: e.order.clientOrderId }); if (st) this.emit(vc.venue, { type: 'orderUpdate', accountId: a.accountId, venueOrderId: e.order.venueOrderId, clientOrderId: e.order.clientOrderId, instrumentId: e.order.instrumentId, status: st, ts: e.order.updatedAt }) }
        else if (e.kind === 'position') this.emit(vc.venue, { type: 'position', accountId: a.accountId, instrumentId: e.instrumentId, position: e.position })
      }))
      return
    }
    if (a.mode === 'live' && a.signer.type !== 'gateway-session' && (a.owner.address || a.signer.type === 'api-key')) {
      const address = (a.owner.address ?? ZERO_ADDR) as Hex
      const cb = (e: VenueEvent): void => {
        if (e.channel === 'userFills') for (const f of e.fills) this.emit(vc.venue, { type: 'fill', accountId: a.accountId, fill: f })
        else if (e.channel === 'orderUpdates') for (const u of e.updates) { const st = this.venueStatus(vc.venue, u.status, { accountId: a.accountId, venueOrderId: u.venueOrderId, clientOrderId: u.clientOrderId }); if (st) this.emit(vc.venue, { type: 'orderUpdate', accountId: a.accountId, venueOrderId: u.venueOrderId, clientOrderId: u.clientOrderId, instrumentId: u.instrumentId, status: st, ts: u.ts }) }
      }
      this.watchers.push(vc.subscribe({ channel: 'userFills', address }, cb), vc.subscribe({ channel: 'orderUpdates', address }, cb))
    }
  }

  /** 行情订阅（按标的）。market.trades 连接器接口没有对应通道，忽略。返回取消函数。 */
  watchMarket(instrumentId: InstrumentId, channel: 'quote' | 'book' | 'candles', interval: CandleInterval = '1m'): (() => void) | undefined {
    const venue = instrumentId.slice(0, Math.max(0, instrumentId.indexOf(':')))
    const vc = this.marketSource(venue)
    if (!vc) return undefined
    const forward = (e: VenueEvent): void => {
      if (e.channel === 'quote') this.emit(vc.venue, { type: 'quote', instrumentId: e.quote.instrumentId, ts: e.quote.ts, bid: e.quote.bid, ask: e.quote.ask, ...(e.quote.last !== undefined ? { last: e.quote.last } : {}) })
      else if (e.channel === 'book') this.emit(vc.venue, { type: 'book', book: e.book })
      else if (e.channel === 'candle') this.emit(vc.venue, { type: 'candle', instrumentId: e.instrumentId, interval: e.interval, candle: e.candle })
    }
    const spec = channel === 'candles' ? ({ channel: 'candle', instrumentId, interval } as const) : ({ channel, instrumentId } as const)
    return vc.subscribe(spec, forward)
  }

  async close(): Promise<void> {
    for (const w of this.watchers.splice(0)) { try { w() } catch { /* 已断 */ } }
    const connectors = new Set([...this.connectors.values(), ...this.marketSources.values()])
    await Promise.all([...connectors].map((connector) => connector.close().catch(() => undefined)))
    await this.watchReader.close()
  }
}
