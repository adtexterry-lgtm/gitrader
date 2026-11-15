// SPDX-License-Identifier: Apache-2.0
// 契约 §2.4 方法清单：方法名、参数 / 返回类型、必选 / 可选与能力位门。
// 约定：宿主调用 EngineMethods（引擎实现），引擎调用 HostMethods（宿主实现，统一前缀 host.）。
import type { Ms } from '../model/decimal'
import type { AccountId, ClientOrderId, InstanceId, InstrumentId, OrderId, Sha256Digest, TakeoverId, VenueId } from '../model/ids'
import type { Book, Candle, MarketContext, Quote, Trade, Instrument, VenueCapabilities, FundingRatePoint } from '../model/instrument'
import type { Balance, MarginSnapshot, Account } from '../model/account'
import type { Order, OrderIntent, Position } from '../model/order'
import type { Origin } from '../model/origin'
import type { Problem } from '../model/problem'
import type { PrecheckResult, RiskPolicy } from '../model/risk'
import type { BacktestResult, BacktestSpec, BacktestState } from './backtest'
import type { Binding, BindResult, EngineDescribe } from './describe'
import type { EventsAckParams, EventsPushParams, GepStream, HeartbeatParams, OverflowParams } from './events'
import type { TakeoverLevel } from '../agent/takeover'
import type { PaperReplayStart, PaperReplayStatus } from '../model/paper-replay'

// ---- 通用 ---------------------------------------------------------------------------

export interface MethodSpec<P, R> { params: P; result: R }
export type Empty = Record<string, never>

export interface OrderResult {
  orderId: OrderId
  clientOrderId: ClientOrderId
  status: Order['status']
  order?: Order
  precheck?: PrecheckResult
  /** 被风控拒绝不是 JSON-RPC 错误：返回成功结果、status = denied 并附 problem。 */
  problem?: Problem
}

export interface AccountSnapshot {
  balances: Balance[]
  margin: MarginSnapshot
  positions: Position[]
  openOrders: Order[]
  ts: Ms
  attestation: 'engine-reported' | 'kernel-observed'
}

export type StrategyInstanceStatus = 'running' | 'stopped' | 'error' | 'starting'
/** 策略实例状态：契约只给了字段名（strategy.start 的参数 + status），其余按此最小集定义（见 OPEN-QUESTIONS）。 */
export interface StrategyInstance {
  instanceId: InstanceId
  strategyId: string
  status: StrategyInstanceStatus
  accountId: AccountId
  instruments: InstrumentId[]
  interval?: string
  params: Record<string, number | boolean | string>
  mandateId: string
  startedAt?: Ms
  error?: Problem
}

export interface StrategyListEntry { id: string; name: string; version: string; kind: string; paramsSchemaRef?: string; sha256?: Sha256Digest }
export interface StrategyListEntryWithParams extends StrategyListEntry { params?: readonly { key: string; label?: string; type?: string; default?: unknown; min?: number; max?: number; help?: string; required?: boolean }[] | Record<string, unknown> }

export interface TakeoverScope { accountIds?: AccountId[]; strategyIds?: string[]; instrumentIds?: InstrumentId[] }

// ---- 引擎实现、宿主调用 ----------------------------------------------------------------

export interface GepHelloParams {
  protocol: 'gep'
  versions: string[]
  host: { name: string; version: string }
  /** 令牌（放在这里，不放 URL）；远程 wss 也可用 mTLS，此时可不带令牌，声明 mtls: true。 */
  auth: { token?: string; mtls?: boolean }
  resume?: { sessionId: string; lastSeq: number }
}
export interface GepHelloResult { version: string; sessionId: string; resumed: boolean; fromSeq?: number; engine: { id: string; version: string } }

export interface EngineHealth { status: 'ok' | 'degraded' | 'down'; metrics: Record<string, number>; ts: Ms }
export interface EngineSnapshot {
  seq: number
  strategies: StrategyInstance[]
  orders: Order[]
  /** 模式 B 必填。 */
  positions?: Position[]
  accounts?: AccountSnapshot[]
}
export interface HaltParams { takeoverId: TakeoverId; level: TakeoverLevel; scope: TakeoverScope; reason: string; deadlineMs: number }
export interface ResumeParams { takeoverId: TakeoverId; scope: TakeoverScope; approvedBy: string }

/**
 * v0.1.5：策略实例的仓位参数（可选，缺省由引擎的默认值补）。数值属引擎配置（分析级），用 number。
 * 宿主的风控闸与授权书额度仍然是上限：sizing 只决定引擎想要多大，不决定能下多大。
 */
export interface StrategySizing {
  /** 占权益的比例（分数，0.1 = 10%），(0, 1]。 */
  allocRatio: number
  /** 单次目标名义上限（计价币），> 0。 */
  allocCapNotional: number
  /** 杠杆，[1, 50]。 */
  leverage: number
  /** 市价类允许的最大滑点（基点）。 */
  maxSlippageBps: number
  /** 低于此名义的调仓不做（计价币）。 */
  minStepNotional: number
}

export interface StrategyStartParams {
  strategyId: string
  instanceId?: InstanceId
  accountId: AccountId
  instruments: InstrumentId[]
  interval?: string
  params: Record<string, number | boolean | string>
  mandateId: string
  /** v0.1.5：仓位参数，部分字段缺省。 */
  sizing?: Partial<StrategySizing>
}

export interface ReplayState { replayId: string; state: 'running' | 'paused' | 'done' | 'stopped'; clock: Ms }

export interface EngineOrderParams {
  accountId: AccountId
  intent?: OrderIntent
  orderRef?: { orderId?: OrderId; clientOrderId?: ClientOrderId }
  clientOrderId?: ClientOrderId
  takeoverId?: TakeoverId
  origin: Origin
}

export type MarketChannelType = 'quote' | 'book' | 'trades' | 'candles' | 'context'
export interface MarketChannel { type: MarketChannelType; instrumentId: InstrumentId; interval?: string; depth?: number }
export interface MarketSubscribeParams { channels: MarketChannel[]; maxHz?: number }
export type MarketSnapshotResult = Quote | Book | { candles: Candle[] } | { trades: Trade[] } | MarketContext
export interface MarketHistoryParams { instrumentId: InstrumentId; interval: string; from?: Ms; to?: Ms; limit?: number }
export interface MarketHistoryResult { candles: Candle[]; source: string; complete: boolean }

export interface EngineMethods {
  'gep.hello': MethodSpec<GepHelloParams, GepHelloResult>
  'engine.describe': MethodSpec<Empty, EngineDescribe>
  'engine.bind': MethodSpec<Binding, BindResult>
  'engine.health': MethodSpec<Empty, EngineHealth>
  'engine.snapshot': MethodSpec<{ accountIds?: AccountId[] }, EngineSnapshot>
  'engine.halt': MethodSpec<HaltParams, { ack: true; appliedAt: Ms }>
  /** 只由宿主在人面确认后调用，引擎不得自行恢复。 */
  'engine.resume': MethodSpec<ResumeParams, { resumedAt: Ms }>
  'engine.shutdown': MethodSpec<{ graceMs: number }, { ok: true }>
  'events.subscribe': MethodSpec<{ streams: GepStream[]; accountIds?: AccountId[]; fromSeq?: number }, { subscriptionId: string; fromSeq: number }>
  'events.unsubscribe': MethodSpec<{ subscriptionId: string }, { ok: true }>
  /** 引擎只能据此收紧自身行为。 */
  'risk.policy.push': MethodSpec<{ policies: RiskPolicy[]; effectiveAt: Ms }, { acceptedVersions: number[] }>
  'strategy.list': MethodSpec<Empty, { strategies: StrategyListEntry[] }>
  'strategy.params': MethodSpec<{ strategyId: string }, { schema: Record<string, unknown>; defaults: Record<string, unknown> }>
  'strategy.start': MethodSpec<StrategyStartParams, { instanceId: InstanceId; status: StrategyInstanceStatus }>
  /** 停止不平仓。 */
  'strategy.stop': MethodSpec<{ instanceId: InstanceId; flatten?: false }, { status: StrategyInstanceStatus }>
  'strategy.update': MethodSpec<{ instanceId: InstanceId; params: Record<string, number | boolean | string> }, { status: StrategyInstanceStatus; appliedAt: Ms }>
  'strategy.status': MethodSpec<{ instanceId?: InstanceId }, { instances: StrategyInstance[] }>
  /** 立即返回，长任务不阻塞调用。 */
  'backtest.run': MethodSpec<{ spec: BacktestSpec }, { jobId: string }>
  'backtest.status': MethodSpec<{ jobId: string }, { state: BacktestState; progress: number }>
  'backtest.result': MethodSpec<{ jobId: string }, BacktestResult>
  'backtest.cancel': MethodSpec<{ jobId: string }, { state: BacktestState }>
  /** 回放规格与回测规格同形（契约未单列，见 OPEN-QUESTIONS）。 */
  'replay.start': MethodSpec<{ spec: BacktestSpec }, { replayId: string }>
  'replay.stop': MethodSpec<{ replayId: string }, { state: ReplayState['state'] }>
  'replay.status': MethodSpec<{ replayId: string }, ReplayState>
  'order.place': MethodSpec<EngineOrderParams, OrderResult>
  'order.amend': MethodSpec<EngineOrderParams, OrderResult>
  'order.cancel': MethodSpec<EngineOrderParams, OrderResult>
  'order.cancelAll': MethodSpec<EngineOrderParams, OrderResult>
  'account.snapshot': MethodSpec<{ accountId: AccountId }, AccountSnapshot>
  'market.subscribe': MethodSpec<MarketSubscribeParams, { subscriptionId: string }>
  'market.snapshot': MethodSpec<{ type: MarketChannelType; instrumentId: InstrumentId; depth?: number }, MarketSnapshotResult>
  'market.history': MethodSpec<MarketHistoryParams, MarketHistoryResult>
}
export type EngineMethodName = keyof EngineMethods

// ---- 宿主实现、引擎调用 ----------------------------------------------------------------

export interface HostAccountSummary { accountId: AccountId; alias: string; venue: VenueId; environment: Account['environment']; mode: Account['mode'] }
/**
 * v0.1.5：引擎随订单带的来源提示。契约 §1.6：行为人不能自报 actor，宿主必须覆盖 actor / actorType / via / requestId，
 * 只采信 tool 与 causation（引擎可以填，用于全链追溯；T26 要求引擎发出的订单 100% 带 tool 与 causation.instanceId）。
 * 引擎多发的其他 Origin 字段一律忽略，不报错。
 */
export interface OriginHint { tool: string; causation?: Origin['causation'] }
export interface HostOrderPlaceParams { accountId: AccountId; intent: OrderIntent; clientOrderId: ClientOrderId; strategyId?: string; instanceId?: InstanceId; origin?: OriginHint & Partial<Origin> }

/**
 * v0.1.5：`host.proposal.create`，引擎主动提交提案（工作流 act.propose；以及授权书额度不足、需要人批准时）。
 * 与 `host.order.place` 的关系：
 *   host.order.place 是"我想下这单"：宿主过授权书 + 风控闸，够级别就下，不够就自动转提案
 *     （返回 OrderResult：status = denied、problem = 2009 NEEDS_APPROVAL，并带新票号）；
 *   host.proposal.create 是"我要人批这单"：不论授权书额度多大，一定创建一条 pending 提案
 *     （预检 deny 则直接 status = denied），不直接下单。
 * 提案的 origin.actor 由宿主盖章为 engine:<engineId>；批准仍是人面专属。
 */
export interface HostProposalCreateParams {
  accountId: AccountId
  /** 1-10 条，可多腿。 */
  intents: OrderIntent[]
  /** 理由必填，1-2,000 字。 */
  reason: string
  evidence?: { type: 'signal' | 'decision' | 'note' | 'backtest' | 'experiment'; id: string }[]
  strategyId?: string
  instanceId?: InstanceId
  origin?: OriginHint & Partial<Origin>
}
export interface HostProposalCreateResult {
  proposalId: string
  /** `T-YYYYMMDD-NNNN`。 */
  ticket: string
  status: 'pending' | 'denied'
  precheck: PrecheckResult
  /** status = denied 时的原因。 */
  problem?: Problem
  expiresAt: Ms
}
export interface HostOrderRefParams { orderId?: OrderId; clientOrderId?: ClientOrderId }
export interface HostOrderAmendParams extends HostOrderRefParams { price?: string; size?: string; triggerPrice?: string }
export type LedgerAppendType = 'signal' | 'decision' | 'note' | 'log'
export type ArtifactKind = 'tearsheet' | 'trades' | 'equity'

export interface HostMethods {
  'host.describe': MethodSpec<Empty, { host: { name: string; version: string }; venues: VenueCapabilities[]; accounts: HostAccountSummary[] }>
  'host.instruments': MethodSpec<{ venue?: VenueId; ids?: InstrumentId[] }, { instruments: Instrument[] }>
  'host.market.subscribe': MethodSpec<MarketSubscribeParams, { subscriptionId: string }>
  'host.market.unsubscribe': MethodSpec<{ subscriptionId: string }, { ok: true }>
  'host.market.snapshot': MethodSpec<{ type: MarketChannelType; instrumentId: InstrumentId; depth?: number }, MarketSnapshotResult>
  'host.market.history': MethodSpec<MarketHistoryParams, MarketHistoryResult>
  'host.account.snapshot': MethodSpec<{ accountId: AccountId }, AccountSnapshot>
  'host.order.place': MethodSpec<HostOrderPlaceParams, OrderResult>
  'host.order.amend': MethodSpec<HostOrderAmendParams, OrderResult>
  'host.order.cancel': MethodSpec<HostOrderRefParams, OrderResult>
  'host.order.cancelAll': MethodSpec<{ accountId: AccountId; instrumentId?: InstrumentId; keepProtective: boolean }, { cancelled: number }>
  /** 单批 ≤ 场所 batch.maxOrders。 */
  'host.order.batch': MethodSpec<{ orders: HostOrderPlaceParams[] }, { results: OrderResult[] }>
  'host.order.status': MethodSpec<HostOrderRefParams, Order>
  /** v0.1.5：见 HostProposalCreateParams。 */
  'host.proposal.create': MethodSpec<HostProposalCreateParams, HostProposalCreateResult>
  'host.risk.precheck': MethodSpec<{ accountId: AccountId; intent: OrderIntent }, PrecheckResult>
  'host.events.subscribe': MethodSpec<{ streams: GepStream[]; accountIds: AccountId[] }, { subscriptionId: string }>
  'host.ledger.append': MethodSpec<{ entries: { type: LedgerAppendType; data: Record<string, unknown> }[] }, { seqs: number[] }>
  'host.artifact.put': MethodSpec<{ path: string; sha256: Sha256Digest; mediaType: string; sizeBytes: number; kind: ArtifactKind }, { artifactId: string }>
  /** 可选；METHOD_NOT_FOUND 时引擎降级为 assumptions.funding=false 并给 warning。 */
  'host.market.fundingHistory': MethodSpec<{ instrumentId: InstrumentId; from: Ms; to?: Ms }, { points: FundingRatePoint[]; complete: boolean }>
  'paper.replay.start': MethodSpec<PaperReplayStart, { runId: string }>
  'paper.replay.status': MethodSpec<Empty, PaperReplayStatus>
  'paper.replay.stop': MethodSpec<{ runId: string }, PaperReplayStatus>
}
export type HostMethodName = keyof HostMethods


// ---- 通知（无 id）-------------------------------------------------------------------

/** 宿主 → 引擎。 */
export interface HostToEngineNotifications {
  'events.push': EventsPushParams
  'gep.heartbeat': HeartbeatParams
  /** 规范名：宿主确认引擎事件（v0.1.5：两个方向统一用 host.events.ack）。 */
  'host.events.ack': EventsAckParams
  /** 已弃用别名（契约 §2.4 的引擎一侧 events.ack）：必须继续接受，不应再发。 */
  'events.ack': EventsAckParams
}
/** 引擎 → 宿主。 */
export interface EngineToHostNotifications {
  'events.push': EventsPushParams
  'gep.heartbeat': HeartbeatParams
  /** 无损流缓冲溢出，宿主必须随后调用 engine.snapshot。 */
  'gep.overflow': OverflowParams
  /** 规范名：引擎确认宿主事件。 */
  'host.events.ack': EventsAckParams
}

// ---- 方法元数据 ------------------------------------------------------------------------

export type MethodSide = 'engine' | 'host'
/** always = 所有引擎必实现；modeA / modeB = 声明该模式时必实现；optional = 按能力位。 */
export type MethodRequirement = 'always' | 'modeA' | 'modeB' | 'optional'

export interface MethodMeta { side: MethodSide; requirement: MethodRequirement; capability?: string; notification?: boolean }

const eng = (requirement: MethodRequirement, capability?: string, notification = false): MethodMeta => ({ side: 'engine', requirement, ...(capability ? { capability } : {}), ...(notification ? { notification } : {}) })
const host = (requirement: MethodRequirement, notification = false): MethodMeta => ({ side: 'host', requirement, ...(notification ? { notification } : {}) })

export const GEP_METHODS: Record<EngineMethodName | HostMethodName | 'events.ack' | 'events.push' | 'gep.heartbeat' | 'gep.overflow' | 'host.events.ack', MethodMeta> = {
  'gep.hello': eng('always'),
  'engine.describe': eng('always'),
  'engine.bind': eng('always'),
  'engine.health': eng('always'),
  'engine.snapshot': eng('always'),
  'engine.halt': eng('always'),
  'engine.resume': eng('always'),
  'engine.shutdown': eng('always'),
  'events.subscribe': eng('always'),
  'events.unsubscribe': eng('always'),
  /** 已弃用别名，保留接受。 */
  'events.ack': eng('always', undefined, true),
  'risk.policy.push': eng('always'),
  'strategy.list': eng('optional', 'strategy'),
  'strategy.params': eng('optional', 'strategy'),
  'strategy.start': eng('optional', 'strategy'),
  'strategy.stop': eng('optional', 'strategy'),
  'strategy.update': eng('optional', 'strategy.hotUpdate'),
  'strategy.status': eng('optional', 'strategy'),
  'backtest.run': eng('optional', 'backtest'),
  'backtest.status': eng('optional', 'backtest'),
  'backtest.result': eng('optional', 'backtest'),
  'backtest.cancel': eng('optional', 'backtest'),
  'replay.start': eng('optional', 'replay'),
  'replay.stop': eng('optional', 'replay'),
  'replay.status': eng('optional', 'replay'),
  'order.place': eng('modeB', 'execution.modeB'),
  'order.amend': eng('modeB', 'execution.modeB'),
  'order.cancel': eng('modeB', 'execution.modeB'),
  'order.cancelAll': eng('modeB', 'execution.modeB'),
  'account.snapshot': eng('modeB', 'execution.modeB'),
  'market.subscribe': eng('optional', 'market.own'),
  'market.snapshot': eng('optional', 'market.own'),
  'market.history': eng('optional', 'market.own'),
  // 通知：events.push / gep.heartbeat 双向，gep.overflow 引擎 → 宿主
  'events.push': eng('always', undefined, true),
  'gep.heartbeat': eng('always', undefined, true),
  'gep.overflow': host('always', true),
  'host.events.ack': host('always', true),

  'host.describe': host('always'),
  'host.instruments': host('always'),
  'host.market.subscribe': host('always'),
  'host.market.unsubscribe': host('always'),
  'host.market.snapshot': host('always'),
  'host.market.history': host('always'),
  'host.account.snapshot': host('always'),
  'host.order.place': host('modeA'),
  'host.order.amend': host('modeA'),
  'host.order.cancel': host('modeA'),
  'host.order.cancelAll': host('modeA'),
  'host.order.batch': host('optional'),
  'host.order.status': host('always'),
  'host.proposal.create': host('optional'),
  'host.risk.precheck': host('always'),
  'host.events.subscribe': host('always'),
  'host.ledger.append': host('optional'),
  'host.artifact.put': host('optional'),
  'host.market.fundingHistory': host('optional'),
  'paper.replay.start': host('optional'),
  'paper.replay.status': host('optional'),
  'paper.replay.stop': host('optional'),
}

export const ENGINE_METHOD_NAMES = (Object.keys(GEP_METHODS) as (keyof typeof GEP_METHODS)[]).filter((m) => GEP_METHODS[m].side === 'engine' && !GEP_METHODS[m].notification) as EngineMethodName[]
export const HOST_METHOD_NAMES = (Object.keys(GEP_METHODS) as (keyof typeof GEP_METHODS)[]).filter((m) => GEP_METHODS[m].side === 'host' && !GEP_METHODS[m].notification) as HostMethodName[]

/** 前缀 `x-<vendor>.` 的厂商扩展方法。 */
export function isExtensionMethod(name: string): boolean {
  return /^x-[a-z0-9-]+\./.test(name)
}

/**
 * 在给定 describe 能力位下，某个引擎方法是否应被支持。
 * 未声明的可选方法调用应返回 5002（或 -32601）；always 恒真。
 */
export function engineMethodSupported(method: EngineMethodName, caps: EngineDescribe['capabilities']): boolean {
  const meta = GEP_METHODS[method]
  if (meta.requirement === 'always') return true
  if (meta.capability) return caps[meta.capability as keyof typeof caps] === true
  return false
}

// ---- v0.1.5 厂商扩展方法约定（§2.9：`x-<vendor>.` 前缀，不得改变标准方法语义）----------------------------

/**
 * Gitrader Core 的扩展方法（工作流 JSON 运行器、策略文件夹）。契约 §2.4 没有工作流方法，所以走扩展命名空间，
 * 且只有引擎在 engine.describe.capabilities 里声明了对应的 x- 能力位才可调用，否则回 5002。
 * 形状（params / result）由声明方负责，不进 Gitrader 一致性套件；宿主（kernel / MCP 的 workflow 工具）按能力位探测后转发。
 */
export const X_GITRADER_METHODS = {
  'x-gitrader.workflow.nodes': { capability: 'x-gitrader.workflow', note: '工作流节点库' },
  'x-gitrader.workflow.blank': { capability: 'x-gitrader.workflow', note: '空白工作流模板' },
  'x-gitrader.workflow.validate': { capability: 'x-gitrader.workflow', note: '校验（图无环、端口类型、参数引用 ...）' },
  'x-gitrader.workflow.run': { capability: 'x-gitrader.workflow', note: '运行 / 停止；act.order 走 host.order.place，act.propose 走 host.proposal.create' },
  'x-gitrader.workflow.values': { capability: 'x-gitrader.workflow', note: '运行时各节点的最新值' },
  'x-gitrader.strategy.files': { capability: 'x-gitrader.strategy-folder', note: '策略文件夹（文件即安装）的加载报告' },
} as const
export type XGitraderMethodName = keyof typeof X_GITRADER_METHODS
export const X_GITRADER_CAPABILITIES = ['x-gitrader.workflow', 'x-gitrader.strategy-folder'] as const

/** 工作流动作节点与宿主方法的对应（v0.1.5 定稿）。 */
export const WORKFLOW_ACTION_HOST_METHOD = {
  'act.order': 'host.order.place',
  'act.close': 'host.order.place',
  'act.propose': 'host.proposal.create',
} as const

/** 扩展方法需要的能力位；不是已登记的扩展方法返回 undefined。 */
export function extensionCapabilityOf(method: string): string | undefined {
  return (X_GITRADER_METHODS as Record<string, { capability: string }>)[method]?.capability
}

// ---- 第六轮 C 包：研究作业（寻优 / 滚动验证 / 因子报告）-----------------------------------------------------
// 同样走 x-gitrader.* 扩展命名空间（不进 X_GITRADER_METHODS：那张表的键由 v015 测试逐个钉死），引擎在
// engine.describe.capabilities 里声明 RESEARCH_CAPABILITY 才可调用。形态照 backtest.*：run 立即返回 jobId，
// status 看进度，result 取摘要或分页的明细，cancel 取消。研究只读：不碰账户、不下单，产物不进前向账本。

export const RESEARCH_CAPABILITY = 'x-gitrader.research'
export const RESEARCH_KINDS = ['optimize', 'walk_forward', 'factor_report'] as const
export type ResearchKind = (typeof RESEARCH_KINDS)[number]
export const RESEARCH_STATES = ['queued', 'running', 'done', 'failed', 'cancelled'] as const
export type ResearchState = (typeof RESEARCH_STATES)[number]
/** summary = 默认摘要；其余三个是分页的完整序列（trials / folds 属寻优，factors 属因子报告）。 */
export const RESEARCH_PARTS = ['summary', 'trials', 'folds', 'factors'] as const
export type ResearchPart = (typeof RESEARCH_PARTS)[number]

export const X_GITRADER_RESEARCH_METHODS = {
  'x-gitrader.research.run': { capability: RESEARCH_CAPABILITY, note: '起作业（optimize / walk_forward / factor_report）；立即返回 jobId' },
  'x-gitrader.research.status': { capability: RESEARCH_CAPABILITY, note: '作业状态与进度' },
  'x-gitrader.research.result': { capability: RESEARCH_CAPABILITY, note: '摘要（part = summary）或分页明细（trials / folds / factors）' },
  'x-gitrader.research.cancel': { capability: RESEARCH_CAPABILITY, note: '取消作业' },
} as const
export type XGitraderResearchMethodName = keyof typeof X_GITRADER_RESEARCH_METHODS

/** 研究的硬性口径（引擎、内核、MCP、CLI 共用）。 */
export const RESEARCH_LIMITS = {
  /** 网格组合数 / 随机试验数上限；超过在起作业之前回 INVALID_PARAMS。 */
  maxTrials: 500,
  /** 摘要 JSON 序列化后的字节上限。 */
  summaryMaxBytes: 8000,
  /** 一页明细序列化后的字符上限（MCP 单次结果上限 60,000 字符，留出外壳余量）；服务端少给几条并带 next，不截断。 */
  pageMaxChars: 48_000,
  defaultLimit: 500,
  maxLimit: 1000,
  /** backtest_report 的回包字节上限与 markdown 字符上限。 */
  reportMaxBytes: 8000,
  reportMarkdownMaxChars: 6000,
} as const

export interface ResearchRunParams { kind: ResearchKind; spec: Record<string, unknown> }
export interface ResearchJobRef { jobId: string; kind: ResearchKind; state: ResearchState }
export interface ResearchStatusResult extends ResearchJobRef { progress: { done: number; total: number } }
export interface ResearchResultParams { jobId: string; part?: ResearchPart; limit?: number; cursor?: string }
/** 分页明细：total 必给且等于摘要 counts 里的对应项；最后一页不带 next。 */
export interface ResearchPage<T = unknown> { items: T[]; total: number; next?: string }
