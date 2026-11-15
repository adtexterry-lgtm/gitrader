// SPDX-License-Identifier: Apache-2.0
// 契约 §5.4 提案 Proposal：状态机、字段、转移表；§5.5 confirmToken。
import type { Decimal, Ms } from '../model/decimal'
import type { AccountId, MandateId, OrderId, PrecheckId, ProposalId, Sha256Digest, Ticket } from '../model/ids'
import type { OrderIntent } from '../model/order'
import type { Origin } from '../model/origin'
import type { Problem } from '../model/problem'
import type { Attestation, PrecheckResult } from '../model/risk'
import type { EvidenceRef } from '../model/signal'

export const PROPOSAL_STATUSES = [
  'draft', 'pending', 'approved', 'executing', 'executed', 'failed', 'rejected', 'expired', 'withdrawn', 'denied',
] as const
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number]

export const PROPOSAL_TERMINAL_STATUSES = ['executed', 'failed', 'rejected', 'expired', 'withdrawn', 'denied'] as const satisfies readonly ProposalStatus[]

export const PROPOSAL_EVENTS = [
  'submit', 'precheck_deny', 'approve', 'reject', 'withdraw', 'pending_timeout', 'execute', 'execute_ok', 'execute_fail', 'execute_window_timeout',
] as const
export type ProposalEvent = (typeof PROPOSAL_EVENTS)[number]

/** 谁可以触发该转移：human = 人面；mandate = 授权书自动批准；proposer = 提出者；kernel = 内核（超时、预检、执行）。 */
export type ProposalTransitionBy = 'proposer' | 'human' | 'human_or_mandate' | 'kernel'

export interface ProposalTransition { from: ProposalStatus; event: ProposalEvent; to: ProposalStatus; by: ProposalTransitionBy }

export const PROPOSAL_TRANSITIONS: readonly ProposalTransition[] = [
  { from: 'draft', event: 'submit', to: 'pending', by: 'proposer' },
  { from: 'draft', event: 'precheck_deny', to: 'denied', by: 'kernel' },
  { from: 'pending', event: 'approve', to: 'approved', by: 'human_or_mandate' },
  { from: 'pending', event: 'reject', to: 'rejected', by: 'human' },
  { from: 'pending', event: 'withdraw', to: 'withdrawn', by: 'proposer' },
  { from: 'pending', event: 'pending_timeout', to: 'expired', by: 'kernel' },
  { from: 'approved', event: 'execute', to: 'executing', by: 'kernel' },
  { from: 'approved', event: 'execute_window_timeout', to: 'expired', by: 'kernel' },
  { from: 'executing', event: 'execute_ok', to: 'executed', by: 'kernel' },
  { from: 'executing', event: 'execute_fail', to: 'failed', by: 'kernel' },
]

/** 给定状态与事件，返回下一状态；不允许的转移返回 null。 */
export function nextProposalStatus(from: ProposalStatus, event: ProposalEvent): ProposalStatus | null {
  return PROPOSAL_TRANSITIONS.find((t) => t.from === from && t.event === event)?.to ?? null
}

export function isTerminalProposalStatus(s: ProposalStatus): boolean {
  return (PROPOSAL_TERMINAL_STATUSES as readonly string[]).includes(s)
}

/** 非下单动作：实盘启动策略 / 实盘运行工作流 / 晋级申请 / 插件安装申请等。 */
export const CONTROL_KINDS = ['start_strategy', 'run_workflow', 'request_promotion', 'install_plugin'] as const
export type ControlKind = (typeof CONTROL_KINDS)[number]
/** 契约只列了 control 的几种用途，没给字段表：A 按最小集定义（见 OPEN-QUESTIONS）。 */
export interface ControlIntent { controlKind: ControlKind; params: Record<string, unknown> }

export type ProposalKind = 'order' | 'control'

export interface ProposalDecision {
  by: `user:${string}` | `mandate:${string}`
  at: Ms
  attestation?: Attestation
  note?: string
}

export interface ProposalExecution {
  orderIds: OrderId[]
  at: Ms
  result: string
  problem?: Problem
}

export const PROPOSAL_DEFAULTS = {
  /** 待批默认 10 分钟。 */
  pendingTtlMs: 600_000,
  maxIntents: 10,
} as const

export interface Proposal {
  proposalId: ProposalId
  /** `T-YYYYMMDD-NNNN`。 */
  ticket: Ticket
  kind: ProposalKind
  status: ProposalStatus
  /** kind=order 必填。 */
  accountId?: AccountId
  /** order：OrderIntent[]（≤10，可多腿）；control：ControlIntent。 */
  intents: OrderIntent[] | ControlIntent
  /** 批准绑定在这个摘要上，执行时必须一致。 */
  intentsDigest: Sha256Digest
  /** 理由必填，1–2,000 字。 */
  reason: string
  evidence?: EvidenceRef[]
  precheck: PrecheckResult
  /** kind=order 必填：批准过的价格边界不可越过。 */
  priceBounds?: { referencePrice: Decimal; maxDriftBps: number }
  mandateId: MandateId
  /** 默认 createdAt + 600000。 */
  expiresAt: Ms
  /** 批准 / 拒绝后必填，之前为 null。 */
  decision?: ProposalDecision | null
  /** 执行后必填，之前为 null。 */
  execution?: ProposalExecution | null
  origin: Origin
}

// ---- §5.5 confirmToken ------------------------------------------------------------

/** 令牌绑定的内容（内核内存密钥做 HMAC，进程重启即全部失效；令牌对外是不透明字符串）。 */
export interface ConfirmTokenClaims {
  mandateId: MandateId
  accountId: AccountId
  /** 规范化意图的摘要。 */
  normalizedIntentDigest: Sha256Digest
  precheckId: PrecheckId
  policyVersion: number
  priceRef: { markPrice: Decimal; ts: Ms }
  maxDriftBps: number
  expiresAt: Ms
  /** 一次性随机数。 */
  nonce: string
}

export const CONFIRM_TOKEN_DEFAULTS = { ttlMs: 30_000, minTtlMs: 5_000, maxTtlMs: 120_000 } as const

/** order.preview 的返回。 */
export interface OrderPreviewResult {
  confirmToken: string
  normalizedIntent: OrderIntent
  precheck: PrecheckResult
  expiresAt: Ms
}
