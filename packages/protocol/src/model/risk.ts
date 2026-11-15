// SPDX-License-Identifier: Apache-2.0
// 契约 §1.4.10 RiskPolicy / Protector / TradingState / 数字预设；§2.7 PrecheckResult。
import { asDecimal, type Decimal, type Ms } from './decimal'
import type { AccountId, InstrumentId, PolicyId, PrecheckId, ProtectorId, Sha256Digest, VenueId } from './ids'
import type { RuleCode, RuleHit } from './problem'
import type { Order, OrderIntent, Position, Side } from './order'
import type { Origin } from './origin'
import type { Instrument } from './instrument'
import type { Mandate, MandateLevel, MandateStatus } from '../agent/mandate'

export const GATE_SCHEMA = 'gitrader-risk-gate/1' as const
export const GATE_ACTIONS = ['open', 'reduce', 'cancel', 'cancel_protective', 'amend', 'leverage', 'deadman_arm', 'deadman_disarm'] as const
export type GateAction = (typeof GATE_ACTIONS)[number]
export const GATE_ACCOUNT_MODES = ['paper', 'live'] as const
export type GateAccountMode = (typeof GATE_ACCOUNT_MODES)[number]
export const PROTECTOR_PAUSE_SCOPES = ['account', 'instrument'] as const
export type ProtectorPauseScope = (typeof PROTECTOR_PAUSE_SCOPES)[number]
export const ACTOR_CLASSES = ['agent', 'human', 'system'] as const
export type ActorClass = (typeof ACTOR_CLASSES)[number]
export const GATE_STAGES = [
  'SYS', 'KILL', 'STATE', 'MANDATE', 'LLM', 'ALLOWLIST', 'CONST', 'EXPOSURE', 'BUYING_POWER', 'LOSS', 'RATE', 'PROTECTOR', 'APPROVAL',
  'PROTECTOR:skipped',
] as const
export type GateStage = (typeof GATE_STAGES)[number]
export const GATE_DECISIONS = ['ALLOW', 'LIMIT', 'BLOCK'] as const
export type GateDecisionKind = (typeof GATE_DECISIONS)[number]
export const GATE_TARGET_KINDS = ['order', 'cancel', 'cancel_all', 'leverage', 'deadman'] as const
export type GateTargetKind = (typeof GATE_TARGET_KINDS)[number]
export const GATE_PATHS = ['direct', 'proposal', 'approved'] as const
export type GatePath = (typeof GATE_PATHS)[number]
export const GATE_KILL_SOURCES = ['manual', 'file', 'deadman', 'auto'] as const
export type GateKillSource = (typeof GATE_KILL_SOURCES)[number]
export const GATE_IRREVERSIBILITIES = ['high', 'low'] as const
export type GateIrreversibility = (typeof GATE_IRREVERSIBILITIES)[number]
export const GATE_ADJUSTMENT_FIELDS = ['size', 'leverage', 'maxSlippageBps', 'reduceOnly', 'markPrice'] as const
export type GateAdjustmentField = (typeof GATE_ADJUSTMENT_FIELDS)[number]
export const PROTECTOR_PRE_ACTIONS = ['pass', 'block', 'limit', 'pause'] as const
export type ProtectorPreAction = (typeof PROTECTOR_PRE_ACTIONS)[number]
export const PRECHECK_VERDICTS = ['allow', 'deny', 'review'] as const
export type PrecheckVerdict = (typeof PRECHECK_VERDICTS)[number]
export const PROTECTOR_MODES = ['enforce', 'monitor'] as const
export type ProtectorMode = (typeof PROTECTOR_MODES)[number]

/** 在场证明方式（§5.1）。passkey / wallet / pin 为强签名；session / system 为本机安装密钥签的收紧类版本。 */
export const ATTESTATION_METHODS = ['passkey', 'wallet', 'pin', 'session', 'system'] as const
export type AttestationMethod = (typeof ATTESTATION_METHODS)[number]
export const STRONG_ATTESTATION_METHODS = ['passkey', 'wallet', 'pin'] as const satisfies readonly AttestationMethod[]

export interface Attestation {
  method: AttestationMethod
  by: string
  at: Ms
  digest: Sha256Digest
  /** base64。 */
  sig: string
}

export const POLICY_SCOPE_TYPES = ['org', 'group', 'account', 'mandate', 'strategy'] as const
export type PolicyScopeType = (typeof POLICY_SCOPE_TYPES)[number]

export interface RiskLimits {
  maxLeverage?: number
  maxOrderNotional?: Decimal
  /** 单标的持仓名义 / 权益。 */
  maxPositionNotionalRatio?: Decimal
  /** 全部持仓名义 / 权益。 */
  maxTotalNotionalRatio?: Decimal
  maxOpenPositions?: number
  /** 当日权益回撤（基线时点 dailyResetAt）。 */
  maxDailyLossRatio?: Decimal
  maxDailyNotional?: Decimal
  /** 市价类默认滑点上限。必填。 */
  maxSlippageBps: number
  /** 交易速率预算（防刷单与场所限流），不是 Agent 步数闸。 */
  maxOrdersPerMinute?: number
  /** v0.1.4：单日下单笔数上限（交易速率预算的日维度，不是 Agent 步数闸）。 */
  maxDailyOrders?: number
  /** v0.1.4：每分钟撤单次数上限（防撤单风暴与场所限流）。 */
  maxCancelsPerMinute?: number
  /** v0.1.4：重复意图窗口（秒）：窗口内同账户同标的同方向同数量同价格的意图视为重复并拒绝。 */
  duplicateIntentWindowSec?: number
  /** 空数组 = 不限。 */
  instrumentAllowlist?: InstrumentId[]
  venueAllowlist?: string[]
}

export const PROTECTOR_KINDS = ['cooldown', 'stoploss_guard', 'drawdown_pause', 'low_profit_lock', 'max_consecutive_failures'] as const
export type ProtectorKind = (typeof PROTECTOR_KINDS)[number]

export interface CooldownProtector { kind: 'cooldown'; afterOpenSec: number }
export interface StoplossGuardProtector { kind: 'stoploss_guard'; windowMin: number; maxStoplosses: number; pauseMin: number; scope: ProtectorPauseScope }
export interface DrawdownPauseProtector { kind: 'drawdown_pause'; windowHours: number; maxDrawdownRatio: Decimal; pauseMin: number }
export interface LowProfitLockProtector { kind: 'low_profit_lock'; windowHours: number; minProfitRatio: Decimal; lockMin: number }
export interface MaxConsecutiveFailuresProtector { kind: 'max_consecutive_failures'; count: number; pauseMin: number }
/** 插件提供的保护器，参数按其清单；只能产生拒绝或收紧，不能放宽。 */
export interface PluginProtector { kind: 'plugin'; pluginId: string; params?: Record<string, unknown> }

export type ProtectorSpec =
  | CooldownProtector | StoplossGuardProtector | DrawdownPauseProtector | LowProfitLockProtector
  | MaxConsecutiveFailuresProtector | PluginProtector

/** 保护器实例：同一风控策略内可叠加、按 order 执行。 */
export type Protector = ProtectorSpec & {
  protectorId?: ProtectorId
  order?: number
  mode?: ProtectorMode
  source?: 'builtin' | { pluginId: string; version: string }
}

export interface TemporaryRelax {
  /** 被放宽的字段及新值（形如 RiskLimits 的子集）。 */
  fields: Partial<RiskLimits>
  from: Ms
  /** 必须带 until（≤24 小时），到期由内核自动回收。 */
  until: Ms
  revertToVersion: number
}

export interface RiskPolicy {
  policyId: PolicyId
  /** 单调递增。 */
  version: number
  scope: { type: PolicyScopeType; id: string }
  limits: RiskLimits
  protectors?: Protector[]
  limitMode?: { size?: boolean; leverage?: boolean; maxSlippageBps?: boolean }
  killSwitch?: { file?: boolean; onTrip?: { cancelAll: boolean; keepStopLoss: boolean; closeAll: boolean } }
  failClosed: { stalePriceMs: number; onMissingPrice: 'deny'; staleAccountMs?: number }
  /**
   * v0.1.2：缺省 = true（默认开启）。LLM 来源的实盘开仓一律拒绝；减仓 / 撤单 / 提案不受限。人可有意关闭（放宽类动作，须在场证明）。
   * 对 LLM 钥匙而言："限额自动"档 = 纸面自动 + 实盘仅减仓与撤单自动，实盘开仓仍走"需确认"，直到人在人面 + PIN 下关闭本开关。
   * 引擎型执行者（actorType = engine）不受影响。
   */
  denyLlmLiveEntries?: boolean
  /**
   * ADR-3：缺省 = false（字段缺省 = 不受约束，老策略行为不变）。为 true 时，Agent（actorClass = agent）开仓必须带 tpsl.stopLoss，
   * 纸面与实盘同一规则；human / engine 不受约束。关闭本要求属于放宽类动作（须在场证明）。
   */
  requireStopOnAgentOpen?: boolean
  temporaryRelax?: TemporaryRelax | null
  /** 如 "00:00Z"。 */
  dailyResetAt: string
  valuationCcy: string
  attestation: Attestation
}

/** §1.4.10 数字预设：id 由数字拼成，显示文案由数字生成，不用标签。 */
export interface RiskPreset {
  id: string
  maxLeverage: number
  maxOrderNotional: Decimal
  maxPositionNotionalRatio: Decimal
  maxTotalNotionalRatio: Decimal
  maxOpenPositions: number
  maxDailyLossRatio: Decimal
  cooldownSec: number
  /** 由数字生成的显示文案，例：杠杆≤3× · 单笔≤2,000 · 日亏≤3%。 */
  display: string
}

export const TRADING_STATES = ['ACTIVE', 'REDUCING', 'HALTED'] as const

/**
 * TRADING_STATE_ALLOWS 保留兼容形状与布尔值；HALTED 的 reduceOnly 仅 human(PIN)/system 可下行，agent 转 proposal。
 * 具体 actor 门禁由 kernel 执行；REDUCING 允许只减仓单、撤单、查询，ACTIVE 允许一切经风控闸放行的单。
 */
export const TRADING_STATE_ALLOWS = {
  ACTIVE: { query: true, cancel: true, reduceOnly: true, openOrIncrease: true },
  REDUCING: { query: true, cancel: true, reduceOnly: true, openOrIncrease: false },
  HALTED: { query: true, cancel: true, reduceOnly: true, openOrIncrease: false },
} as const satisfies Record<'ACTIVE' | 'REDUCING' | 'HALTED', { query: boolean; cancel: boolean; reduceOnly: boolean; openOrIncrease: boolean }>
export type TradingState = (typeof TRADING_STATES)[number]

/** 严格程度：越大越严。生效状态取所有适用作用域里最严的一个。 */
export const TRADING_STATE_SEVERITY: Record<TradingState, number> = { ACTIVE: 0, REDUCING: 1, HALTED: 2 }
export function strictestTradingState(states: readonly TradingState[]): TradingState {
  return states.reduce<TradingState>((a, b) => (TRADING_STATE_SEVERITY[b] > TRADING_STATE_SEVERITY[a] ? b : a), 'ACTIVE')
}

export const TRADING_STATE_SCOPE_TYPES = ['org', 'group', 'account', 'mandate', 'instrument'] as const
export type TradingStateScopeType = (typeof TRADING_STATE_SCOPE_TYPES)[number]
export interface TradingScope { type: TradingStateScopeType; id: string }

export interface PrecheckEstimates {
  notional?: Decimal
  marginRequired?: Decimal
  liquidationPrice?: Decimal | null
  slippageBps?: number
  feeEstimate?: Decimal
  /** 附带止损时的最大亏损估算（数量 × 合约面值 × 参考价到止损价距离 + 手续费）。 */
  maxLoss?: Decimal
  positionNotionalRatioAfter?: Decimal
  totalNotionalRatioAfter?: Decimal
  rateBudgetRemaining?: number
}

export interface PrecheckResult {
  precheckId: PrecheckId
  verdict: PrecheckVerdict
  policyVersion: number
  ruleHits: RuleHit[]
  estimates: PrecheckEstimates
  priceRef?: { markPrice: Decimal; ts: Ms }
  expiresAt?: Ms
}

export interface NormalizedIntentLike extends OrderIntent {
  size: Decimal
  tif: NonNullable<OrderIntent['tif']>
  clientOrderId: string
}

export type GateTarget =
  | { kind: typeof GATE_TARGET_KINDS[0]; intent: NormalizedIntentLike }
  | { kind: typeof GATE_TARGET_KINDS[1]; targets: Array<{ orderId: string; clientOrderId: string; tpslRole?: Order['tpslRole'] }> }
  | { kind: typeof GATE_TARGET_KINDS[2]; instrumentId?: InstrumentId; keepProtective: boolean }
  | { kind: typeof GATE_TARGET_KINDS[3]; instrumentId: InstrumentId; leverage: number; marginMode?: OrderIntent['marginMode'] }
  | { kind: typeof GATE_TARGET_KINDS[4]; atMs: Ms | null }

/** 进程内预留视图；零预留时 Decimal 为 "0"、计数为 0，byInstrument 为空对象。 */
export interface ReservedView {
  account: { margin: Decimal; notional: Decimal; count: number }
  byInstrument: Record<InstrumentId, {
    long: { notional: Decimal; count: number }
    short: { notional: Decimal; count: number }
  }>
  today: { notional: Decimal; count: number }
  lastMinute: { count: number }
}

type GateInputBase = {
  precheckId: PrecheckId
  dryRun: boolean
  action: GateAction
  actorClass: ActorClass
  originActorType: Origin['actorType']
  originalTargetDigest?: Sha256Digest
  account: { accountId: AccountId; venue: VenueId; mode: GateAccountMode; groupIds: string[] }
  snapshot: GateAccountView
  mark?: { price: Decimal; ts: Ms; source: 'venue_mark' }
  cancelPriceChecks?: Array<{ instrumentId: InstrumentId; quote?: string; mark?: { price: Decimal; ts: Ms; source: 'venue_mark' } }>
  last?: { price: Decimal; ts: Ms }
  mandate: Mandate | null
  mandateIntegrity: { ok: boolean; problems: string[] }
  policy: RiskPolicy | null
  policyIntegrity: { ok: boolean; problems: string[] }
  path: GatePath
  now: Ms
  stats: PrecheckStats
  rate?: { used: number; limit: number }
  reserved: ReservedView
  states: StateReason[]
  /** assemble 给出的确定性数量收紧建议；target 保留收紧前值，decide 必须重新验证刻度。 */
  assemblyAdjustments?: GateAdjustment[]
  killSwitch: { tripped: boolean; source?: GateKillSource; reason?: string }
  venueRules?: VenueRules
  protectorResults: ProtectorResult[]
}

export type GateInput = GateInputBase & (
  | { target: Extract<GateTarget, { kind: 'order' | 'leverage' }>; instrument: Instrument }
  | { target: Exclude<GateTarget, { kind: 'order' | 'leverage' }>; instrument?: Instrument }
)

export interface GateAccountView {
  equity: Decimal
  available: Decimal
  availableDeductsOpenOrders: boolean
  positions: Array<Pick<Position, 'instrumentId' | 'side' | 'size' | 'notional' | 'leverage'>>
  openOrders: Array<{ instrumentId: InstrumentId; side: Side; notional: Decimal; count: number }>
  stopLossOrderIds: string[]
  asOf: Ms
  /** 有 confirmedAt 时按 now - confirmedAt 判断阈值；缺失时只看 stale；asOf 保持最后推送语义。 */
  confirmedAt?: Ms
  stale: boolean
}

export interface GateDecision extends PrecheckResult {
  gate: { schema: typeof GATE_SCHEMA; rulesetVersion: string }
  decision: GateDecisionKind
  action: GateAction
  targetDigest: Sha256Digest
  adjustedTargetDigest: Sha256Digest
  applied: GateAdjustment[]
  allowedActions: Record<GateAction, boolean>
  irreversibility: GateIrreversibility
  escalation?: { to: 'human_approval'; reason: RuleCode }
  stages: GateStage[]
  monitorHits: RuleHit[]
  snapshotDigest: Sha256Digest
  policyRef: (Pick<RiskPolicy, 'policyId' | 'version'> & { digest: Sha256Digest }) | null
  mandateRef?: { mandateId: Mandate['mandateId']; version: Mandate['version']; digest: Sha256Digest; effectiveLevel: MandateLevel; effectiveStatus: MandateStatus }
  dryRun: boolean
  attestation: Attestation & { method: 'system'; by: 'kernel' }
}

export type GateSnapshot = Omit<GateInput, 'target' | 'policy'> & {
  policy: GateDecision['policyRef']
}

export interface GateAdjustment {
  ruleId: string
  code: RuleCode
  field: GateAdjustmentField
  from: Decimal | number | boolean
  to: Decimal | number | boolean
  unit: string
  kind?: 'warning'
}

export interface GateTicket {
  ticketId: string
  precheckId: PrecheckId
  bootId: string
  accountId: AccountId
  action: GateAction
  targetDigest: Sha256Digest
  issuedAt: Ms
  expiresAt: Ms
  sig: string
}

export interface PrecheckStats {
  /** 当日起始权益（日亏基线）。 */
  dayStartEquity?: Decimal
  /** 当日已下单名义（不含被拒单）。 */
  dailyNotional: Decimal
  mandateDailyNotional: Decimal
  ordersLastMinute: number
  mandateOrdersLastMinute: number
  /** 当日笔数（每账户 / 每 Agent 钥匙授权书）。 */
  ordersToday: number
  mandateOrdersToday: number
  lastOpenTs?: Ms
  /** 重复意图窗口内已存在的同标的同方向同价同量订单（防重复报单）。 */
  duplicateOf?: string
}

export interface StateReason {
  scope: TradingScope
  state: TradingState
  reason: string
  until?: Ms
  protector?: string
}

export interface VenueRules {
  maxOpenOrders?: { cap: number; current: number }
  marketPriceBandBps?: number
  minOrderNotional?: Decimal
}

export interface ProtectorPreInput {
  target: GateTarget
  snapshot: GateAccountView
  mark?: { price: Decimal; ts: Ms }
  stats: PrecheckStats
  now: Ms
  params: Record<string, unknown>
}

export type ProtectorPreVerdict =
  | { action: Extract<ProtectorPreAction, 'pass'> }
  | { action: Extract<ProtectorPreAction, 'block'>; code?: RuleCode; message: string }
  | { action: Extract<ProtectorPreAction, 'limit'>; field: 'size'; to: Decimal; message: string }
  | { action: Extract<ProtectorPreAction, 'pause'>; scope: ProtectorPauseScope; minutes: number; message: string }

export interface ProtectorResult {
  pluginId: string
  version: string
  sourceDigest: Sha256Digest
  order: number
  mode: ProtectorMode
  seq: number
  result: ProtectorPreVerdict | { action: 'unavailable'; reason: string }
  durationUs: number
}

/** 契约 §1.4.10 的三个数字预设（九条 #7）。 */
export const RISK_PRESETS: readonly RiskPreset[] = [
  { id: 'p-lev3-o2000-d3', maxLeverage: 3, maxOrderNotional: asDecimal('2000'), maxPositionNotionalRatio: asDecimal('0.3'), maxTotalNotionalRatio: asDecimal('0.6'), maxOpenPositions: 3, maxDailyLossRatio: asDecimal('0.03'), cooldownSec: 5, display: '杠杆≤3× · 单笔≤2,000 · 日亏≤3%' },
  { id: 'p-lev5-o5000-d5', maxLeverage: 5, maxOrderNotional: asDecimal('5000'), maxPositionNotionalRatio: asDecimal('0.5'), maxTotalNotionalRatio: asDecimal('1'), maxOpenPositions: 5, maxDailyLossRatio: asDecimal('0.05'), cooldownSec: 2, display: '杠杆≤5× · 单笔≤5,000 · 日亏≤5%' },
  { id: 'p-lev10-o20000-d10', maxLeverage: 10, maxOrderNotional: asDecimal('20000'), maxPositionNotionalRatio: asDecimal('1'), maxTotalNotionalRatio: asDecimal('2'), maxOpenPositions: 10, maxDailyLossRatio: asDecimal('0.1'), cooldownSec: 0, display: '杠杆≤10× · 单笔≤20,000 · 日亏≤10%' },
]
