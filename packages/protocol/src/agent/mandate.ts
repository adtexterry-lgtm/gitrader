// SPDX-License-Identifier: Apache-2.0
// 契约 §5.3 授权书 Mandate（取代"执行模式"）、五级阶梯与对外四档、晋级门槛。
import { asDecimal, type Decimal, type Ms } from '../model/decimal'
import type { AccountId, MandateId } from '../model/ids'
import type { Attestation, TemporaryRelax } from '../model/risk'

export const MANDATE_LEVELS = ['L0', 'L1', 'L2', 'L3', 'L4'] as const
export type MandateLevel = (typeof MANDATE_LEVELS)[number]

/**
 * 对外只露四档（定义 §〇·〇）：只读 / 纸面 / 需确认 / 限额自动。内部五级映射：
 * L0 只读；L1 纸面；L2 批准式 = 需确认；L3 小额自动 与 L4 放量 都属"限额自动"（只是额度不同）。
 */
/**
 * 注意（产品裁决）：对 LLM 型钥匙（actorType = llm-agent），"限额自动"在 denyLlmLiveEntries 开启（缺省）时不含实盘开仓——
 * 实盘开仓仍走"需确认"。引擎型执行者（actorType = engine）不受影响。
 */
export const AGENT_PERMISSION_TIERS = ['read_only', 'paper', 'confirm', 'auto_limited'] as const
export type AgentPermissionTier = (typeof AGENT_PERMISSION_TIERS)[number]

export const AGENT_PERMISSION_TIER_LABELS: Record<AgentPermissionTier, string> = {
  read_only: '只读',
  paper: '纸面',
  confirm: '需确认',
  auto_limited: '限额自动',
}

export const TIER_OF_LEVEL: Record<MandateLevel, AgentPermissionTier> = {
  L0: 'read_only',
  L1: 'paper',
  L2: 'confirm',
  L3: 'auto_limited',
  L4: 'auto_limited',
}

/** 界面选一档时落到哪一级：限额自动默认 L3（L4 放量只能经晋级，不能直接选）。 */
export const DEFAULT_LEVEL_OF_TIER: Record<AgentPermissionTier, MandateLevel> = {
  read_only: 'L0',
  paper: 'L1',
  confirm: 'L2',
  auto_limited: 'L3',
}

export function tierOfLevel(level: MandateLevel): AgentPermissionTier {
  return TIER_OF_LEVEL[level]
}

/** 内部名称（五级）。 */
export const MANDATE_LEVEL_NAMES: Record<MandateLevel, string> = {
  L0: '只读',
  L1: '纸面',
  L2: '批准式',
  L3: '小额自动',
  L4: '放量',
}

export const MANDATE_SUBJECT_TYPES = ['agentKey', 'engine', 'workflow', 'plugin'] as const
export type MandateSubjectType = (typeof MANDATE_SUBJECT_TYPES)[number]

export const MANDATE_STATUSES = ['active', 'suspended', 'expired', 'revoked', 'downgraded'] as const
export type MandateStatus = (typeof MANDATE_STATUSES)[number]

export interface MandateLimits {
  maxOrderNotional?: Decimal
  maxDailyNotional?: Decimal
  maxDailyLoss?: Decimal
  maxPositionNotional?: Decimal
  maxOpenPositions?: number
  maxLeverage?: number
  /** 超过该额自动转提案。 */
  autoMaxOrderNotional?: Decimal
  maxOrdersPerMinute?: number
  /** v0.1.4：同 RiskLimits.maxDailyOrders。 */
  maxDailyOrders?: number
  /** v0.1.4：同 RiskLimits.maxCancelsPerMinute。 */
  maxCancelsPerMinute?: number
  /** v0.1.4：同 RiskLimits.duplicateIntentWindowSec。 */
  duplicateIntentWindowSec?: number
}

export type HeartbeatTakeover = 'none' | 'halt_new' | 'cancel_all'

export interface MandateHeartbeat {
  intervalSec: number
  timeoutSec: number
  onTimeout: { downgradeTo: MandateLevel; takeover: HeartbeatTakeover }
}

export interface MandateApproval {
  /** 待批超时，默认 600。 */
  pendingTtlSec: number
  /** 批准后执行窗口，默认 30。 */
  executeWithinSec: number
  /** 超过该名义额的批准必须有在场证明。 */
  presenceAboveNotional: Decimal
}

export interface PromotionCriteria {
  minDays?: number
  minSamples?: number
  maxDrawdownRatio?: Decimal
  maxHeartbeatTimeouts?: number
  minApprovalRatio?: Decimal
  [extension: `x-${string}`]: unknown
}

export interface PromotionProgress {
  days: number
  samples: number
  drawdownRatio: Decimal
  heartbeatTimeouts: number
  eligible: boolean
}

export interface Mandate {
  mandateId: MandateId
  version: number
  subject: { type: MandateSubjectType; id: string }
  level: MandateLevel
  accounts: AccountId[]
  /** L2+ 必填。 */
  venueAllowlist?: string[]
  instrumentAllowlist?: string[]
  limits: MandateLimits
  notBefore: Ms
  /** 默认 30 天，L3 / L4 最长 90 天；到期自动降到 L0。 */
  notAfter: Ms
  /** L3+ 必填。 */
  heartbeat?: MandateHeartbeat
  approval?: MandateApproval
  promotion?: { next: MandateLevel; criteria: PromotionCriteria; progress: PromotionProgress }
  temporaryRelax?: TemporaryRelax | null
  /**
   * v0.1.2：缺省 = true（默认开启），含义同 RiskPolicy.denyLlmLiveEntries；与风控策略取最严。
   * LLM 钥匙的 L3 / L4（界面"限额自动"）在本开关开启时：纸面自动、实盘只有减仓与撤单自动，实盘开仓转提案（需确认）。
   */
  denyLlmLiveEntries?: boolean
  status: MandateStatus
  issuedBy: `user:${string}`
  attestation: Attestation
}

// ---- 阶梯规则表 --------------------------------------------------------------------

export type McpToolGroup = 'S' | 'R' | 'P' | 'E' | 'W'

export interface MandateLevelRule {
  level: MandateLevel
  /** 可下单的账户类别。 */
  tradableAccounts: 'none' | 'paper_shadow' | 'paper_shadow_and_live_propose_only' | 'live_allowlist'
  /** 实盘单的执行路径。 */
  execution: 'none' | 'direct_paper' | 'proposal' | 'preview_confirm_place'
  /** 本级必须填的限制字段（在通用必填之外）。 */
  requiredLimits: readonly (keyof MandateLimits)[]
  requiresAllowlists: boolean
  heartbeat: 'none' | 'optional' | 'required'
  /** 本级加载的 MCP 工具组（W 工作区组由用户另开）。 */
  toolGroups: readonly McpToolGroup[]
  /** 本级是否加载 propose / proposals。 */
  loadsProposalTools: boolean
}

export const MANDATE_LEVEL_RULES: Record<MandateLevel, MandateLevelRule> = {
  L0: { level: 'L0', tradableAccounts: 'none', execution: 'none', requiredLimits: [], requiresAllowlists: false, heartbeat: 'none', toolGroups: ['S', 'R', 'P'], loadsProposalTools: false },
  L1: { level: 'L1', tradableAccounts: 'paper_shadow', execution: 'direct_paper', requiredLimits: [], requiresAllowlists: false, heartbeat: 'none', toolGroups: ['S', 'R', 'P', 'E'], loadsProposalTools: true },
  L2: { level: 'L2', tradableAccounts: 'paper_shadow_and_live_propose_only', execution: 'proposal', requiredLimits: ['maxOrderNotional', 'maxDailyNotional'], requiresAllowlists: true, heartbeat: 'optional', toolGroups: ['S', 'R', 'P', 'E'], loadsProposalTools: true },
  L3: { level: 'L3', tradableAccounts: 'live_allowlist', execution: 'preview_confirm_place', requiredLimits: ['maxOrderNotional', 'maxDailyNotional', 'maxDailyLoss', 'autoMaxOrderNotional'], requiresAllowlists: true, heartbeat: 'required', toolGroups: ['S', 'R', 'P', 'E'], loadsProposalTools: true },
  L4: { level: 'L4', tradableAccounts: 'live_allowlist', execution: 'preview_confirm_place', requiredLimits: ['maxOrderNotional', 'maxDailyNotional', 'maxDailyLoss', 'autoMaxOrderNotional'], requiresAllowlists: true, heartbeat: 'required', toolGroups: ['S', 'R', 'P', 'E'], loadsProposalTools: true },
}

export const MANDATE_DEFAULTS = {
  /** 默认 30 天。 */
  notAfterDays: 30,
  /** L3 / L4 最长 90 天。 */
  notAfterMaxDaysL3L4: 90,
  heartbeat: { intervalSec: 60, timeoutSec: 180, onTimeout: { downgradeTo: 'L0', takeover: 'halt_new' } } satisfies MandateHeartbeat,
  approval: { pendingTtlSec: 600, executeWithinSec: 30 },
  /** 临时放宽 ≤ 24 小时。 */
  temporaryRelaxMaxMs: 24 * 3600 * 1000,
} as const

export interface PromotionStep {
  from: MandateLevel
  to: MandateLevel
  /** 建议默认值，人可改、改动入账；晋级本身仍是人面专属。 */
  criteria: PromotionCriteria
  note: string
}

export const PROMOTION_DEFAULTS: readonly PromotionStep[] = [
  { from: 'L0', to: 'L1', criteria: {}, note: '人签发即可' },
  { from: 'L1', to: 'L2', criteria: { minDays: 7, minSamples: 20, maxDrawdownRatio: asDecimal('0.15') }, note: '纸面 ≥ 7 天；≥ 20 笔已平仓；期间无拆单规避' },
  { from: 'L2', to: 'L3', criteria: { minDays: 14, minSamples: 30, maxDrawdownRatio: asDecimal('0.1'), minApprovalRatio: asDecimal('0.6') }, note: '纸面 + 批准式合计 ≥ 14 天；≥ 30 个已执行提案；人批准率 ≥ 60%' },
  { from: 'L3', to: 'L4', criteria: { minDays: 30, minSamples: 50, maxHeartbeatTimeouts: 0 }, note: 'L3 实盘 ≥ 30 天；≥ 50 笔；回撤上限由人设；0 次心跳超时降级' },
]
