// SPDX-License-Identifier: Apache-2.0
// 契约 §6 审计账本 gitrader-ledger/1：条目、类型、哈希链算法（输入构造；哈希函数由调用方注入）。
import type { Decimal, Ms } from '../model/decimal'
import type { AccountId, ClientOrderId, FillId, InstanceId, InstrumentId, LedgerId, MandateId, OrderId, OrgId, PolicyId, PrecheckId, ProposalId, Sha256Digest, TakeoverId, Ticket, ExperimentId, VenueId } from '../model/ids'
import type { Origin } from '../model/origin'
import type { RuleHit } from '../model/problem'
import type { PrecheckEstimates, PrecheckVerdict } from '../model/risk'
import { canonicalize } from './canonicalize'

export const LEDGER_SCHEMA = 'gitrader-ledger/1'

/** §6.2 条目类型。 */
export const LEDGER_ENTRY_TYPES = {
  orderAndExecution: [
    'order.intent', 'risk.precheck', 'risk.denied', 'order.submitted', 'order.accepted', 'order.rejected', 'order.amended',
    'order.cancelled', 'order.expired', 'order.triggered', 'fill', 'funding', 'liquidation', 'position.snapshot',
    'order.status_unknown',
  ],
  proposal: ['proposal.created', 'proposal.decided', 'proposal.expired', 'proposal.withdrawn', 'proposal.executed', 'proposal.failed'],
  authorizationAndRisk: [
    'mandate.issued', 'mandate.changed', 'mandate.downgraded', 'mandate.expired', 'mandate.revoked', 'policy.changed',
    'policy.relaxed', 'policy.reverted', 'protector.triggered', 'trading_state.changed',
  ],
  takeover: ['takeover.requested', 'takeover.applied', 'takeover.completed', 'takeover.failed'],
  enginesAndPlugins: ['engine.bound', 'engine.event', 'engine.health_changed', 'plugin.installed', 'plugin.updated', 'plugin.removed', 'plugin.permission_granted', 'plugin.health_changed'],
  lab: ['signal.emitted', 'decision.made', 'decision.resolved', 'note', 'experiment.created', 'experiment.updated', 'experiment.stage_changed', 'backtest.completed'],
  /** v0.1.3：分类模型滚动训练事件（payload 形状见 ModelTrainedPayload）。 */
  training: ['model.trained'],
  system: ['session.unlocked', 'key.created', 'key.rotated', 'key.revoked', 'signer.signed', 'startup.reconciled', 'reconciliation', 'annotation', 'checkpoint', 'export.created'],
} as const

export const LEDGER_ENTRY_TYPE_LIST = [
  ...LEDGER_ENTRY_TYPES.orderAndExecution,
  ...LEDGER_ENTRY_TYPES.proposal,
  ...LEDGER_ENTRY_TYPES.authorizationAndRisk,
  ...LEDGER_ENTRY_TYPES.takeover,
  ...LEDGER_ENTRY_TYPES.enginesAndPlugins,
  ...LEDGER_ENTRY_TYPES.lab,
  ...LEDGER_ENTRY_TYPES.training,
  ...LEDGER_ENTRY_TYPES.system,
] as const
export type LedgerEntryType = (typeof LEDGER_ENTRY_TYPE_LIST)[number]

export const LEDGER_ATTESTATIONS = ['kernel-observed', 'venue-confirmed', 'engine-reported', 'user-asserted'] as const
export type LedgerAttestation = (typeof LEDGER_ATTESTATIONS)[number]

/** 查询与对账的索引键，至少一项。 */
export interface LedgerSubject {
  orgId?: OrgId
  accountId?: AccountId
  instrumentId?: InstrumentId
  orderId?: OrderId
  clientOrderId?: ClientOrderId
  fillId?: FillId
  proposalId?: ProposalId
  ticket?: Ticket
  mandateId?: MandateId
  policyId?: PolicyId
  takeoverId?: TakeoverId
  engineId?: string
  instanceId?: InstanceId
  workflowId?: string
  experimentId?: ExperimentId
  pluginId?: string
  precheckId?: PrecheckId
  /** 更正 / 对账条目指向被更正 / 被核对的条目。 */
  ledgerRef?: LedgerId | string
}

export interface LedgerPrecheck {
  precheckId: PrecheckId
  verdict: PrecheckVerdict
  policyVersion: number
  estimates: PrecheckEstimates
}

export interface LedgerVenueRef {
  venue: string
  nativeOrderId?: string
  nativeFillId?: string
  txHash?: string
  /** 场所原始响应的哈希（原始响应本机留存）。 */
  receiptHash?: Sha256Digest
}

export interface LedgerEngineRef { engineId: string; sessionId: string; seq: number; eventId: string }

/** order.amended：价格与数量的改前 / 改后快照；只记录相关字段。 */
export interface OrderAmendedPayload {
  orderId: OrderId
  before: { price?: Decimal | null; size?: Decimal; triggerPrice?: Decimal | null }
  after: { price?: Decimal | null; size?: Decimal; triggerPrice?: Decimal | null }
}

/** 场所状态尚未识别；rawStatus 保留场所原始状态名称。 */
export interface OrderStatusUnknownPayload { venue: VenueId; rawStatus: string; orderId: OrderId }

/** 插件自身健康状态变更；from / to 为开放状态名，历史引擎事件保持原样。 */
export interface PluginHealthChangedPayload { pluginId: string; from: string; to: string; reason?: string }

export interface LedgerEntry {
  schema: typeof LEDGER_SCHEMA
  /** 每个本地账本单调递增、无缺口；创世条目 seq = 0。 */
  seq: number
  id: LedgerId
  /** 事件时间。 */
  ts: Ms
  /** 内核记录时间。 */
  recordedAt: Ms
  type: LedgerEntryType
  origin: Origin
  subject: LedgerSubject
  /** 下单意图、提案、拒单、执行类必填。 */
  precheck?: LedgerPrecheck
  /** verdict ≠ allow、保护器触发、接管时必填；GateDecision.decision ≠ ALLOW（含 LIMIT）时也必填。放在头部，不随载荷脱敏。 */
  ruleHits?: RuleHit[]
  /** 类型相关正文；experiment.created.payload.document 是初始全文，experiment.updated 为 {fromVersion,toVersion,patch,docDigest}，experiment.stage_changed 为 {from,to,evidencePackIds,by,pinMismatch,attestation?}；position.snapshot 的 equity/unrealized/valuationCcy 是日边界或阶段时点；导出时可整体脱敏。实验载荷不改变条目类型。风控形状：gate={decision,snapshot,target}；timing={assembleUs,decideUs,protectorUs}。无需新增条目类型。 */
  payload?: Record<string, unknown>
  payloadHash: Sha256Digest
  attestation: LedgerAttestation
  /** 场所事件必填。 */
  venueRef?: LedgerVenueRef
  /** 引擎事件必填。 */
  engineRef?: LedgerEngineRef
  prevHash: Sha256Digest
  hash: Sha256Digest
}

/**
 * v0.1.3：`model.trained` 条目的 payload。训练只用 `ts + labelMaturityMs ≤ trainWindow.to` 的样本（防前视）；模型文件本身不进账本，只进哈希。
 */
export interface ModelTrainedPayload {
  modelId: string
  modelVersion: string
  modelSha256: Sha256Digest
  trainWindow: { from: Ms; to: Ms }
  /** 标签成熟边界（毫秒）：标签需要这么久之后才算已知。 */
  labelMaturityMs: number
  sampleCount: number
  /** 验证指标，自由形状（分析级数据）。 */
  metrics?: Record<string, number>
}

/** 创世条目的 prevHash："sha256:" 加 64 个 0。 */
export const GENESIS_PREV_HASH: Sha256Digest = `sha256:${'0'.repeat(64)}`

/** 禁写字段（§6.1）：宿主模型的供应商私有字段与模型原始对话；密钥类字段名另见 gep/secrets。 */
export const LEDGER_FORBIDDEN_KEYS = ['tool_use_id', 'thinking', 'reasoning_content'] as const

/** 递归查找载荷里的禁写键（供应商私有字段），返回路径列表。 */
export function findForbiddenLedgerKeys(value: unknown, path = '$'): string[] {
  const hits: string[] = []
  if (Array.isArray(value)) value.forEach((v, i) => hits.push(...findForbiddenLedgerKeys(v, `${path}[${i}]`)))
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if ((LEDGER_FORBIDDEN_KEYS as readonly string[]).includes(k)) hits.push(`${path}.${k}`)
      hits.push(...findForbiddenLedgerKeys(v, `${path}.${k}`))
    }
  }
  return hits
}

/** 哈希函数：输入 UTF-8 文本，输出 64 位小写十六进制 SHA-256。由调用方注入（内核用 node:crypto / @noble/hashes），协议包不依赖任何加密库。 */
export type Sha256Hex = (utf8Text: string) => string

/** payloadHash 的哈希输入：JCS(payload)；无载荷时为空对象的 JCS，即 "{}"。 */
export function payloadHashInput(payload: Record<string, unknown> | undefined): string {
  return canonicalize(payload ?? {})
}

/** 条目哈希的哈希输入：JCS(条目去掉 hash 与 payload 两个字段)。头部（含 payloadHash、precheck、ruleHits、prevHash）入链。 */
export function entryHashInput(entry: Omit<LedgerEntry, 'hash'> & { hash?: string }): string {
  const { hash: _hash, payload: _payload, ...header } = entry as Record<string, unknown>
  return canonicalize(header)
}

export function computePayloadHash(payload: Record<string, unknown> | undefined, sha256Hex: Sha256Hex): Sha256Digest {
  return `sha256:${sha256Hex(payloadHashInput(payload))}`
}

export function computeEntryHash(entry: Omit<LedgerEntry, 'hash'> & { hash?: string }, sha256Hex: Sha256Hex): Sha256Digest {
  return `sha256:${sha256Hex(entryHashInput(entry))}`
}
