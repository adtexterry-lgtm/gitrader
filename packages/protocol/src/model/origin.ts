// SPDX-License-Identifier: Apache-2.0
// 契约 §1.6：来源归因。行为人不能自报 actor：MCP 服务器、GEP / GSP 宿主按已认证身份盖章。
import type { Actor, ActorType, DecisionId, EventId, InstanceId, MandateId, PrecheckId, ProposalId, SignalId } from './ids'

export const ORIGIN_VIA = ['mcp', 'ui', 'gep', 'gsp', 'cli', 'api', 'internal'] as const
export type OriginVia = (typeof ORIGIN_VIA)[number]

/**
 * 行为人大类（v0.1.2，必填）：human 人 / engine 引擎与自动化 / llm-agent 大模型驱动的 Agent / system 内核与场所。
 * 由内核按已认证身份盖章，行为人不能自报；账本保留，界面可一键筛出 llm-agent 来源的动作。
 */
export const ORIGIN_ACTOR_TYPES = ['human', 'engine', 'llm-agent', 'system'] as const
export type OriginActorType = (typeof ORIGIN_ACTOR_TYPES)[number]

/** actor 前缀 → actorType 的对应（Origin 校验时 actor 与 actorType 必须一致）。 */
export const ORIGIN_ACTOR_TYPE_OF_PREFIX: Record<ActorType, OriginActorType> = {
  user: 'human',
  agent: 'llm-agent',
  engine: 'engine',
  workflow: 'engine',
  strategy: 'engine',
  plugin: 'engine',
  mandate: 'system',
  system: 'system',
  venue: 'system',
}

export function deriveOriginActorType(actor: Actor): OriginActorType {
  const prefix = actor.slice(0, actor.indexOf(':')) as ActorType
  const t = ORIGIN_ACTOR_TYPE_OF_PREFIX[prefix]
  if (!t) throw new TypeError(`unknown actor prefix in ${JSON.stringify(actor)}`)
  return t
}

export interface Causation {
  proposalId?: ProposalId
  signalId?: SignalId
  decisionId?: DecisionId
  workflowId?: string
  nodeId?: string
  strategyId?: string
  instanceId?: InstanceId
  engineId?: string
  mandateId?: MandateId
  precheckId?: PrecheckId
  parentEventId?: EventId
  /** v0.1.3：子仓位 id（一仓多出场）。 */
  legId?: string
  /** v0.1.3：出场计划 id。 */
  exitPlanId?: string
}

export interface Origin {
  actor: Actor
  /** 行为人大类（必填）。 */
  actorType: OriginActorType
  /** MCP 工具名（`order`）、UI 动作（`ui:approve`）、引擎内策略（`strategy:ema-trend`）、系统组件（`protector:drawdown_pause`）。 */
  tool: string
  /** 由 Gitrader 生成的 UUID；不复用宿主的 `tool_use_id` 等供应商字段。 */
  requestId: string
  via: OriginVia
  /** 授权书签发人。 */
  onBehalfOf?: `user:${string}`
  causation?: Causation
  /** 旧数据按 clientTag 推断来源时为 true。 */
  inferred?: boolean
}
