// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest'
import {
  AGENT_PERMISSION_TIERS, AGENT_SELF_PROTECT_ACTIONS, CONFIRM_TOKEN_DEFAULTS, DEFAULT_LEVEL_OF_TIER, HUMAN_ONLY_ACTIONS, MANDATE_LEVELS, MANDATE_LEVEL_RULES,
  PROMOTION_DEFAULTS, PROPOSAL_STATUSES, PROPOSAL_TERMINAL_STATUSES, PROPOSAL_TRANSITIONS, RISK_PRESETS, TAKEOVER_LEVEL_INFO, TIER_OF_LEVEL, TRADING_STATES,
  deriveOriginActorType, effectiveDenyLlmLiveEntries, isLlmLiveEntryDenied, isTerminalProposalStatus, llmLiveEntryRuleHit, nextProposalStatus, strictestTradingState,
  tierOfLevel, validateRuleHit, validateRiskPolicy, isDecimal, MCP_TOOLS, type ProposalStatus, ORIGIN_ACTOR_TYPES,
} from '../src'
import { sample } from './helpers'

describe('授权书：对外四档 ↔ 内部五级', () => {
  it('四档与五级映射', () => {
    expect(AGENT_PERMISSION_TIERS).toEqual(['read_only', 'paper', 'confirm', 'auto_limited'])
    expect(MANDATE_LEVELS.map(tierOfLevel)).toEqual(['read_only', 'paper', 'confirm', 'auto_limited', 'auto_limited'])
    expect(TIER_OF_LEVEL.L4).toBe('auto_limited')
    expect(DEFAULT_LEVEL_OF_TIER.auto_limited).toBe('L3')
  })
  it('四档里每一档都有默认级别，且默认级别映射回自己', () => {
    for (const t of AGENT_PERMISSION_TIERS) expect(tierOfLevel(DEFAULT_LEVEL_OF_TIER[t])).toBe(t)
  })
  it('级别规则：L3/L4 必须心跳与白名单，L0 无可下单账户', () => {
    expect(MANDATE_LEVEL_RULES.L0.tradableAccounts).toBe('none')
    expect(MANDATE_LEVEL_RULES.L0.loadsProposalTools).toBe(false)
    expect(MANDATE_LEVEL_RULES.L1.loadsProposalTools).toBe(true)
    expect(MANDATE_LEVEL_RULES.L2.execution).toBe('proposal')
    expect(MANDATE_LEVEL_RULES.L3.heartbeat).toBe('required')
    expect(MANDATE_LEVEL_RULES.L3.execution).toBe('preview_confirm_place')
    expect(MANDATE_LEVEL_RULES.L2.requiresAllowlists).toBe(true)
  })
  it('晋级阶梯连续：L0→L1→L2→L3→L4', () => {
    expect(PROMOTION_DEFAULTS.map((p) => `${p.from}>${p.to}`)).toEqual(['L0>L1', 'L1>L2', 'L2>L3', 'L3>L4'])
    expect(PROMOTION_DEFAULTS[1]?.criteria.minDays).toBe(7)
    expect(PROMOTION_DEFAULTS[3]?.criteria.maxHeartbeatTimeouts).toBe(0)
    for (const p of PROMOTION_DEFAULTS) if (p.criteria.maxDrawdownRatio !== undefined) expect(isDecimal(p.criteria.maxDrawdownRatio)).toBe(true)
  })
})

describe('提案状态机（§5.4）', () => {
  it('转移表：终态没有出边，其余状态都可达', () => {
    for (const s of PROPOSAL_TERMINAL_STATUSES) expect(PROPOSAL_TRANSITIONS.filter((t) => t.from === s)).toEqual([])
    const reachable = new Set<ProposalStatus>(['draft'])
    for (let k = 0; k < 10; k++) for (const t of PROPOSAL_TRANSITIONS) if (reachable.has(t.from)) reachable.add(t.to)
    expect([...reachable].sort()).toEqual([...PROPOSAL_STATUSES].sort())
  })
  it('主路径与分支', () => {
    expect(nextProposalStatus('draft', 'submit')).toBe('pending')
    expect(nextProposalStatus('draft', 'precheck_deny')).toBe('denied')
    expect(nextProposalStatus('pending', 'approve')).toBe('approved')
    expect(nextProposalStatus('pending', 'reject')).toBe('rejected')
    expect(nextProposalStatus('pending', 'withdraw')).toBe('withdrawn')
    expect(nextProposalStatus('pending', 'pending_timeout')).toBe('expired')
    expect(nextProposalStatus('approved', 'execute')).toBe('executing')
    expect(nextProposalStatus('approved', 'execute_window_timeout')).toBe('expired')
    expect(nextProposalStatus('executing', 'execute_ok')).toBe('executed')
    expect(nextProposalStatus('executing', 'execute_fail')).toBe('failed')
  })
  it('不允许的转移：不能跳过批准、不能撤回已批准的、终态不能再动', () => {
    expect(nextProposalStatus('draft', 'approve')).toBeNull()
    expect(nextProposalStatus('pending', 'execute')).toBeNull()
    expect(nextProposalStatus('approved', 'withdraw')).toBeNull()
    expect(nextProposalStatus('executed', 'execute')).toBeNull()
    expect(nextProposalStatus('rejected', 'approve')).toBeNull()
    expect(isTerminalProposalStatus('expired')).toBe(true)
    expect(isTerminalProposalStatus('pending')).toBe(false)
  })
  it('批准只能由人或授权书；拒绝只能由人；撤回只能由提出者', () => {
    const by = (e: string) => PROPOSAL_TRANSITIONS.find((t) => t.event === e)?.by
    expect(by('approve')).toBe('human_or_mandate')
    expect(by('reject')).toBe('human')
    expect(by('withdraw')).toBe('proposer')
  })
  it('confirmToken 默认 30 s，可设 5–120 s', () => {
    expect(CONFIRM_TOKEN_DEFAULTS).toEqual({ ttlMs: 30000, minTtlMs: 5000, maxTtlMs: 120000 })
  })
})

describe('接管三档与人面专属动作', () => {
  it('三档对应的交易状态', () => {
    expect(TAKEOVER_LEVEL_INFO.halt_new.resultingState).toBe('REDUCING')
    expect(TAKEOVER_LEVEL_INFO.cancel_all.resultingState).toBe('REDUCING')
    expect(TAKEOVER_LEVEL_INFO.flatten_all.resultingState).toBe('HALTED')
    expect(TAKEOVER_LEVEL_INFO.halt_new.label).toBe('停止新开仓')
  })
  it('交易状态取最严', () => {
    expect([...TRADING_STATES]).toEqual(['ACTIVE', 'REDUCING', 'HALTED'])
    expect(strictestTradingState([])).toBe('ACTIVE')
    expect(strictestTradingState(['ACTIVE', 'REDUCING'])).toBe('REDUCING')
    expect(strictestTradingState(['HALTED', 'REDUCING', 'ACTIVE'])).toBe('HALTED')
  })
  it('Agent 的自保动作里没有批准、放宽、恢复、签发', () => {
    for (const a of AGENT_SELF_PROTECT_ACTIONS) expect(a).not.toMatch(/approve|reject|relax|resume|issue|promote|allow_llm/)
    const human = HUMAN_ONLY_ACTIONS.map((h) => h.action)
    for (const a of ['proposal.approve', 'mandate.issue', 'policy.relax', 'trading_state.resume', 'agent_key.create', 'policy.allow_llm_live_entries']) expect(human).toContain(a)
    expect(HUMAN_ONLY_ACTIONS.find((h) => h.action === 'trading_state.resume')?.presence).toBe('attested')
    expect(HUMAN_ONLY_ACTIONS.find((h) => h.action === 'policy.tighten')?.presence).toBe('session')
  })
  it('MCP 工具面没有批准 / 拒绝 / 放宽 / 恢复类动作（人面专属不在工具面）', () => {
    const all = MCP_TOOLS.flatMap((t) => t.actions.map((a) => `${t.name}.${a.name}`))
    expect(all.join(' ')).not.toMatch(/approve|reject|relax|resume|issue/)
  })
  it('数字预设：三个，id 由数字拼成，没有标签', () => {
    expect(RISK_PRESETS.map((p) => p.id)).toEqual(['p-lev3-o2000-d3', 'p-lev5-o5000-d5', 'p-lev10-o20000-d10'])
    for (const p of RISK_PRESETS) {
      expect(p.display).toMatch(/^杠杆≤\d+× · 单笔≤[\d,]+ · 日亏≤\d+%$/)
      for (const d of [p.maxOrderNotional, p.maxPositionNotionalRatio, p.maxTotalNotionalRatio, p.maxDailyLossRatio]) expect(isDecimal(d)).toBe(true)
    }
  })
})

describe('v0.1.2 大模型不做交易判断：denyLlmLiveEntries', () => {
  it('actorType 四个取值；actor 前缀的对应', () => {
    expect([...ORIGIN_ACTOR_TYPES]).toEqual(['human', 'engine', 'llm-agent', 'system'])
    expect(deriveOriginActorType('user:usr_local')).toBe('human')
    expect(deriveOriginActorType('agent:ak_01JAB5')).toBe('llm-agent')
    expect(deriveOriginActorType('engine:gitrader-core')).toBe('engine')
    expect(deriveOriginActorType('workflow:wf-mine')).toBe('engine')
    expect(deriveOriginActorType('strategy:ema-trend')).toBe('engine')
    expect(deriveOriginActorType('system:protector')).toBe('system')
    expect(deriveOriginActorType('mandate:mdt_01JAB6M2T4')).toBe('system')
    expect(deriveOriginActorType('venue:hyperliquid')).toBe('system')
    expect(() => deriveOriginActorType('robot:r2' as never)).toThrow()
  })
  it('缺省开启；取最严：只有全部显式 false 才放行', () => {
    expect(effectiveDenyLlmLiveEntries([])).toBe(true)
    expect(effectiveDenyLlmLiveEntries([undefined])).toBe(true)
    expect(effectiveDenyLlmLiveEntries([true, false])).toBe(true)
    expect(effectiveDenyLlmLiveEntries([false, undefined])).toBe(true)
    expect(effectiveDenyLlmLiveEntries([false, false])).toBe(false)
    expect(effectiveDenyLlmLiveEntries([false])).toBe(false)
  })
  const base = { actorType: 'llm-agent', accountMode: 'live', opensOrIncreasesExposure: true, deny: true } as const
  it('LLM 来源的实盘开仓被拒', () => {
    expect(isLlmLiveEntryDenied(base)).toBe(true)
  })
  it('减仓 / 撤单、纸面 / 影子、人、引擎、经人批准的提案执行都不受限', () => {
    expect(isLlmLiveEntryDenied({ ...base, opensOrIncreasesExposure: false })).toBe(false)
    expect(isLlmLiveEntryDenied({ ...base, accountMode: 'paper' })).toBe(false)
    expect(isLlmLiveEntryDenied({ ...base, accountMode: 'shadow' })).toBe(false)
    expect(isLlmLiveEntryDenied({ ...base, actorType: 'human' })).toBe(false)
    expect(isLlmLiveEntryDenied({ ...base, actorType: 'engine' })).toBe(false)
    expect(isLlmLiveEntryDenied({ ...base, actorType: 'system' })).toBe(false)
    expect(isLlmLiveEntryDenied({ ...base, fromHumanApprovedProposal: true })).toBe(false)
  })
  it('人有意关闭后放行', () => {
    expect(isLlmLiveEntryDenied({ ...base, deny: effectiveDenyLlmLiveEntries([false, false]) })).toBe(false)
  })
  it('拒绝时的 RuleHit 合法，且码在表里', () => {
    const hit = llmLiveEntryRuleHit('pol_01JAB1')
    expect(hit.code).toBe('LLM_LIVE_ENTRY')
    expect(hit.ruleId).toBe('pol_01JAB1#denyLlmLiveEntries')
    expect(validateRuleHit(hit).ok).toBe(true)
  })
  it('风控策略里关闭开关是合法文档（放宽动作由内核要求在场证明）', () => {
    expect(validateRiskPolicy({ ...sample('RiskPolicy'), denyLlmLiveEntries: false }).ok).toBe(true)
  })
})
