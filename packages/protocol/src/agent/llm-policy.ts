// SPDX-License-Identifier: Apache-2.0
// v0.1.2 底线：大模型不做交易判断。denyLlmLiveEntries 缺省开启——LLM 来源（origin.actorType = llm-agent）的实盘开仓一律拒绝；
// 减仓、撤单、提案、纸面 / 影子单不受限。人可有意关闭（放宽类动作，须在场证明，见 HUMAN_ONLY_ACTIONS）。
// 产品裁决：LLM 型钥匙的"限额自动"档 = 纸面自动 + 实盘仅减仓与撤单自动，实盘开仓仍走"需确认"；只有人在人面 + PIN 下显式关闭本开关，
// LLM 钥匙的限额自动才包含实盘开仓。引擎型执行者（actorType = engine）不受本开关影响，由授权书额度约束。
import { asDecimal } from '../model/decimal'
import type { AccountMode } from '../model/account'
import type { OriginActorType } from '../model/origin'
import type { RuleHit } from '../model/problem'

export const DENY_LLM_LIVE_ENTRIES_DEFAULT = true

/**
 * 生效值：风控策略与授权书（任意作用域）取最严——只有所有适用的开关都被显式写成 false 才放行；
 * 没写 = 默认开启。传入空数组（没有任何适用文档）按默认开启处理。
 */
export function effectiveDenyLlmLiveEntries(flags: readonly (boolean | undefined)[]): boolean {
  if (flags.length === 0) return DENY_LLM_LIVE_ENTRIES_DEFAULT
  return flags.some((f) => f !== false)
}

export interface LlmLiveEntryCheckInput {
  actorType: OriginActorType
  accountMode: AccountMode
  /** 该动作是否增加敞口：下单且 reduceOnly 不为 true。撤单、改单为减少 / 不变的不算。 */
  opensOrIncreasesExposure: boolean
  /** 该单是否来自已被人批准的提案执行（提案不受限，批准后的执行不应被此策略拦下）。 */
  fromHumanApprovedProposal?: boolean
  /** 生效值，见 effectiveDenyLlmLiveEntries。 */
  deny: boolean
}

/** 是否应拒绝。 */
export function isLlmLiveEntryDenied(i: LlmLiveEntryCheckInput): boolean {
  return i.deny && i.actorType === 'llm-agent' && i.accountMode === 'live' && i.opensOrIncreasesExposure && i.fromHumanApprovedProposal !== true
}

/** 拒绝时附在 Problem.ruleHits 里的 RuleHit。limit / actual 为 dec：允许 0 笔、实际 1 笔。 */
export function llmLiveEntryRuleHit(policyOrMandateId: string): RuleHit {
  return {
    ruleId: `${policyOrMandateId}#denyLlmLiveEntries`,
    code: 'LLM_LIVE_ENTRY',
    message: 'live entries originating from an LLM agent are denied by policy',
    limit: asDecimal('0'),
    actual: asDecimal('1'),
    unit: 'entries',
    action: 'deny',
    scope: 'policy',
  }
}
