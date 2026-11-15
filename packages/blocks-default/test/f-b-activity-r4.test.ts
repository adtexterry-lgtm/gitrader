// SPDX-License-Identifier: CPAL-1.0
// 修复轮 4（F-b）：规则分流（精度取整是中性提示）、提案状态回写、接管折叠、授权书文案不露 ID、policy 文案、强平价 0 → 无。
import { describe, expect, it } from 'vitest'
import type { LedgerEntry } from '@gitrader/protocol/types'
import { activityOf, entryToActivity, foldTakeovers, settleProposals, tidyActivity, toPending } from '../src/model-activity'

let n = 0
const entry = (type: LedgerEntry['type'], over: Record<string, unknown> = {}): LedgerEntry => ({ id: `entry_${++n}`, seq: n, ts: 10000 + n,
  type, payload: {}, subject: { orgId: 'org_local' }, origin: { actor: 'agent:ak_1', tool: 'test', via: 'mcp' }, ruleHits: [], ...over } as unknown as LedgerEntry)
const PRECISION = { ruleId: 'inst#size', code: 'SIZE_PRECISION', limit: '0.00123', actual: '0.001236', unit: 'BTC', action: 'limit', scope: 'instrument' }
const APPROVAL = { ruleId: 'mdt#level', code: 'NEEDS_APPROVAL', limit: '0', actual: '1', unit: '', action: 'review', scope: 'mandate', message: '需要你确认' }

describe('F-b · C13 规则分流', () => {
  it('SIZE_PRECISION / limit 不进红色规则行，改成中性 notes', () => {
    const it1 = entryToActivity(entry('proposal.created', { subject: { orgId: 'o', ticket: 'T-1' }, precheck: { verdict: 'review' }, ruleHits: [PRECISION, APPROVAL] }))!
    expect(it1.rules).toEqual(['需要你确认'])
    expect(it1.notes).toEqual(['数量按精度取整：0.001236 → 0.00123 BTC'])
  })
  it('verdict=deny 时 review 命中不再显示（不挂「需要你确认」）', () => {
    const it1 = entryToActivity(entry('proposal.created', { precheck: { verdict: 'deny' }, ruleHits: [APPROVAL, { ...APPROVAL, code: 'ORDER_NOTIONAL', action: 'deny', message: '单笔超限' }] }))!
    expect(it1.rules).toEqual(['单笔超限'])
    expect(it1.rules.join('')).not.toContain('确认')
  })
  it('其它 limit / warn（风控自动缩量）照旧进规则行；deny 的 SIZE_PRECISION 仍是拒绝', () => {
    const shrink = { ruleId: 'pol#maxOrderNotional', code: 'ORDER_NOTIONAL', limit: '1000', actual: '1500', unit: 'USDC', action: 'limit', scope: 'org', message: '已自动缩量到上限' }
    const a = entryToActivity(entry('proposal.created', { precheck: { verdict: 'allow' }, ruleHits: [shrink] }))!
    expect(a.rules).toEqual(['已自动缩量到上限'])
    expect(a.notes).toBeUndefined()
    const d = entryToActivity(entry('order.intent', { precheck: { verdict: 'deny' }, ruleHits: [{ ...PRECISION, action: 'deny' }] }))!
    expect(d.rules).toHaveLength(1)
    expect(d.notes).toBeUndefined()
  })
  it('toPending 同口径：notes + 强平价 0 / null → null', () => {
    const base = { proposalId: 'p1', ticket: 'T-1', status: 'pending', expiresAt: 99999, intents: [], reason: '' }
    const c = toPending({ ...base, precheck: { verdict: 'review', ruleHits: [PRECISION, APPROVAL], estimates: { liquidationPrice: '0' } } })!
    expect(c.rules).toEqual(['需要你确认'])
    expect(c.notes).toEqual(['数量按精度取整：0.001236 → 0.00123 BTC'])
    expect(c.liquidationPrice).toBeNull()
    expect(toPending({ ...base, precheck: { verdict: 'allow', estimates: { liquidationPrice: '52110' } } })!.liquidationPrice).toBe(52110)
    expect(toPending({ ...base, precheck: { verdict: 'deny', ruleHits: [APPROVAL] } })!.rules).toEqual([])
  })
})

describe('F-b · 提案状态回写与接管折叠', () => {
  const ticket = { orgId: 'o', ticket: 'T-7' }
  const created = () => entry('proposal.created', { subject: ticket, precheck: { verdict: 'review' }, ruleHits: [APPROVAL] })
  it('同票有后续行：创建行改成最新状态并去掉待确认规则行', () => {
    const list = activityOf([created(), entry('proposal.decided', { subject: ticket, payload: { decision: 'approved' } }), entry('proposal.executed', { subject: ticket })])
    const before = list.find((x) => x.type === 'proposal.created')!
    expect(before.result?.label).toBe('待批')
    const settled = settleProposals(list).find((x) => x.type === 'proposal.created')!
    expect(settled.result).toEqual({ label: '已执行', tone: 'ok' })
    expect(settled.rules.join('')).not.toContain('确认')
  })
  it('没有后续行保持待批；别的票不串', () => {
    const list = activityOf([created(), entry('proposal.executed', { subject: { orgId: 'o', ticket: 'T-8' } })])
    expect(settleProposals(list).find((x) => x.type === 'proposal.created')!.result?.label).toBe('待批')
  })
  it('接管：同 takeoverId 有 completed 就隐藏 requested / applied；未完成的保留', () => {
    const t = (type: LedgerEntry['type'], id: string) => entry(type, { subject: { orgId: 'o', takeoverId: id }, payload: { level: 'cancel_all' } })
    const list = activityOf([t('takeover.requested', 'tk1'), t('takeover.applied', 'tk1'), t('takeover.completed', 'tk1'), t('takeover.requested', 'tk2')])
    expect(foldTakeovers(list).map((x) => `${x.takeoverId}:${x.type}`).sort()).toEqual(['tk1:takeover.completed', 'tk2:takeover.requested'])
    expect(tidyActivity(list)).toHaveLength(2)
  })
})

describe('F-b · C12 文案与 policy', () => {
  it('授权书作用域的交易状态不露 ID，且「交易状态」前有分隔', () => {
    const a = entryToActivity(entry('trading_state.changed', { payload: { scope: { type: 'mandate', id: 'mdt_01HTRBBE' }, to: 'REDUCING' } }))!
    expect(a.what).toBe('Agent 授权：交易状态 → 只减仓')
    expect(a.what).not.toContain('HTRBBE')
  })
  it('policy.relaxed / reverted', () => {
    const at = new Date(2026, 9, 28, 14, 5).getTime()
    expect(entryToActivity(entry('policy.relaxed', { payload: { change: 'temporaryRelax', until: at } }))!.what).toBe('临时放宽限额，至 14:05')
    expect(entryToActivity(entry('policy.relaxed', { payload: { change: 'relax' } }))!.what).toBe('修改风控上限')
    expect(entryToActivity(entry('policy.relaxed', { payload: { change: 'allow_llm_live_entries' } }))!.what).toBe('允许 LLM 实盘开仓')
    expect(entryToActivity(entry('policy.relaxed', { payload: { change: 'something_new' } }))!.what).toBe('修改风控策略')
    expect(entryToActivity(entry('policy.reverted'))!.what).toBe('临时放宽已到期收回')
  })
})

describe('fix-r4 · 重复意图不说冷却', () => {
  it('ruleId #duplicateIntent 的 COOLDOWN 命中写「刚提交过一笔相同的单」，不写「还需 10 秒」', async () => {
    const { ruleText } = await import('../src/model-activity')
    const t = ruleText({ ruleId: 'org#duplicateIntent', code: 'COOLDOWN', limit: '10', actual: '0', unit: 's', action: 'deny', scope: 'account' } as never)
    expect(t).toBe('刚提交过一笔相同的单，10 秒内不重复提交')
    expect(t).not.toContain('还需')
  })
})
