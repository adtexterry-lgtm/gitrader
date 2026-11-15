// SPDX-License-Identifier: Apache-2.0
// 契约 §5.6 接管三档与死人开关；§5.1 人面专属动作；§5.2 AgentKey。
import type { Ms } from '../model/decimal'
import type { AgentKeyId, MandateId, TakeoverId } from '../model/ids'
import type { TradingScope, TradingState } from '../model/risk'

export const TAKEOVER_LEVELS = ['halt_new', 'cancel_all', 'flatten_all'] as const
export type TakeoverLevel = (typeof TAKEOVER_LEVELS)[number]

export interface TakeoverLevelInfo {
  level: TakeoverLevel
  tier: 'T1' | 'T2' | 'T3'
  label: string
  /** 触发后的交易状态；flatten_all 完成后进入 HALTED。 */
  resultingState: TradingState
}

/** 界面文案：停止新开仓 / 撤销挂单 / 全部平仓。 */
export const TAKEOVER_LEVEL_INFO: Record<TakeoverLevel, TakeoverLevelInfo> = {
  halt_new: { level: 'halt_new', tier: 'T1', label: '停止新开仓', resultingState: 'REDUCING' },
  cancel_all: { level: 'cancel_all', tier: 'T2', label: '撤销挂单', resultingState: 'REDUCING' },
  flatten_all: { level: 'flatten_all', tier: 'T3', label: '全部平仓', resultingState: 'HALTED' },
}

export interface TakeoverRequest {
  takeoverId?: TakeoverId
  level: TakeoverLevel
  /** Agent 的作用域不得超出其授权书的 accounts。 */
  scope: TradingScope
  /** 必填。 */
  reason: string
  /** cancel_all 默认保留只减仓的止盈止损；false 可全撤。 */
  keepProtective?: boolean
}

export const TAKEOVER_LEDGER_TYPES = ['takeover.requested', 'takeover.applied', 'takeover.completed', 'takeover.failed'] as const

/** 谁可触发（§5.6 表）：恢复 ACTIVE 只有人，且要在场证明。 */
export const TAKEOVER_TRIGGERS: Record<TakeoverLevel, readonly string[]> = {
  halt_new: ['user', 'agent', 'protector', 'heartbeat_timeout', 'engine_lost'],
  cancel_all: ['user', 'agent', 'protector', 'heartbeat_timeout', 'engine_lost'],
  flatten_all: ['user', 'agent', 'protector'],
}

/** flatten_all 的退避重试：未成交部分重试 3 次后告警人。 */
export const FLATTEN_RETRY_LIMIT = 3

/** 死人开关三层（§5.6）。 */
export const DEADMAN_LAYERS = ['agent_heartbeat', 'engine_heartbeat', 'kernel'] as const
export type DeadmanLayer = (typeof DEADMAN_LAYERS)[number]

// ---- §5.2 AgentKey ----------------------------------------------------------------

export const AGENT_HOSTS = ['claude-code', 'codex', 'hermes', 'unigit', 'other'] as const
export type AgentHost = (typeof AGENT_HOSTS)[number]

export const AGENT_KEY_STATUSES = ['active', 'suspended', 'revoked'] as const
export type AgentKeyStatus = (typeof AGENT_KEY_STATUSES)[number]

export interface AgentKey {
  keyId: AgentKeyId
  /** 如「Claude Code · 研究机」。 */
  name: string
  host: AgentHost
  /** 同时只有一份生效授权书。 */
  mandateId: MandateId
  status: AgentKeyStatus
  createdAt: Ms
  /** 默认 90 天。 */
  expiresAt: Ms
  lastSeenAt: Ms | null
  createdBy: `user:${string}`
}

export const AGENT_KEY_DEFAULTS = { expiresInDays: 90 } as const
/** 令牌：`gtk_` + 32 字节随机数的 base32（52 个字符，无填充），只显示一次；内核只存其慢哈希。 */
export const AGENT_TOKEN_PATTERN = '^gtk_[A-Z2-7]{52}$'

// ---- §5.1 人面专属动作 --------------------------------------------------------------

export type PresenceRequirement = 'none' | 'session' | 'session_and_confirm' | 'attested' | 'attested_if_above_threshold'

export interface HumanOnlyAction { action: string; presence: PresenceRequirement; note?: string }

/** 这些动作不在任何 Agent 可调的工具里；presence 为在场证明要求。 */
export const HUMAN_ONLY_ACTIONS: readonly HumanOnlyAction[] = [
  { action: 'proposal.approve', presence: 'attested_if_above_threshold', note: '名义额超过 presenceAboveNotional 时必须在场证明；拒绝无门槛' },
  { action: 'proposal.reject', presence: 'none' },
  { action: 'mandate.issue', presence: 'attested' },
  { action: 'mandate.renew', presence: 'attested' },
  { action: 'mandate.promote', presence: 'attested' },
  { action: 'mandate.edit_promotion_criteria', presence: 'attested' },
  { action: 'policy.tighten', presence: 'session' },
  { action: 'policy.relax', presence: 'attested' },
  { action: 'policy.allow_llm_live_entries', presence: 'attested', note: '有意关闭 denyLlmLiveEntries（放宽类）；关闭后 LLM 来源的实盘开仓才可能放行' },
  { action: 'policy.temporary_relax', presence: 'attested', note: '≤24 小时，到期自动回收' },
  { action: 'trading_state.resume', presence: 'attested', note: '从 REDUCING / HALTED 恢复 ACTIVE' },
  { action: 'plugin.install', presence: 'session_and_confirm' },
  { action: 'plugin.grant_permission', presence: 'session_and_confirm' },
  { action: 'plugin.consent_download', presence: 'session_and_confirm' },
  { action: 'venue.connect', presence: 'session', note: 'HL 授权在主钱包签' },
  { action: 'credential.import', presence: 'session' },
  { action: 'agent_key.create', presence: 'attested' },
  { action: 'agent_key.rotate', presence: 'attested' },
  { action: 'agent_key.revoke', presence: 'session' },
  { action: 'workspace.revert', presence: 'session' },
  { action: 'ledger.export', presence: 'session' },
]

/** Agent 经 MCP 只能做的自保动作（§5.1）。 */
export const AGENT_SELF_PROTECT_ACTIONS = [
  'takeover.halt_new', 'takeover.cancel_all', 'takeover.flatten_all',
  'mandate.downgrade', 'mandate.heartbeat',
  'proposals.withdraw', 'engines.stop_strategy',
] as const
