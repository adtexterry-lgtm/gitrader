// SPDX-License-Identifier: CPAL-1.0
// 0.1.1 客户体验修复第二批 B2（ux-fix2）：Agent 自身出错第 2 层（活动流里放平、连续相同合一行）、UX-34 引擎授权、UX-20 取整小数、UX-10 连接态同一规则。
import { describe, expect, it } from 'vitest'
import type { LedgerEntry } from '@gitrader/protocol/types'
import { activityCounts, activityOf, agentMiss, entryToActivity, foldAgentMisses, splitHits, tidyActivity } from '../src/model-activity'
import { connOf, normalizeVenues } from '../src/model-risk'

let n = 0
const AGENT = { actor: 'agent:ak_1', actorType: 'llm-agent', tool: 'propose', via: 'mcp', requestId: 'r' }
const HUMAN = { actor: 'user:usr_local', actorType: 'human', tool: 'op:engine.bind', via: 'ui', requestId: 'h' }
const entry = (type: LedgerEntry['type'], over: Record<string, unknown> = {}): LedgerEntry => ({ id: `e_${++n}`, seq: n, ts: 10_000 + n * 1000,
  type, payload: {}, subject: { orgId: 'org_local', instrumentId: 'hyperliquid:BTC' }, origin: { ...AGENT, requestId: `r${n}` }, ruleHits: [], ...over } as unknown as LedgerEntry)
const HIT = { ruleId: 'mdt#maxOrderNotional', code: 'ORDER_NOTIONAL', limit: '200', actual: '499.9', unit: 'USDC', action: 'deny', scope: 'mandate' }
const APPROVAL = { ruleId: 'mdt#level', code: 'NEEDS_APPROVAL', limit: '0', actual: '1', unit: '', action: 'review', scope: 'mandate', message: '需要你确认' }

describe('Agent 自身出错第 2 层：不打扰人，活动流里记一笔', () => {
  it('Agent 自己的被拦 / 被拒算；人发起的、要人批准的不算', () => {
    expect(agentMiss(entryToActivity(entry('risk.denied', { ruleHits: [HIT] }))!)).toBe(true)
    expect(agentMiss(entryToActivity(entry('order.rejected', { payload: { problem: { message: 'insufficient margin' } } }))!)).toBe(true)
    expect(agentMiss(entryToActivity(entry('risk.denied', { origin: HUMAN, ruleHits: [HIT] }))!)).toBe(false)
    expect(agentMiss(entryToActivity(entry('risk.denied', { ruleHits: [APPROVAL] }))!)).toBe(false)
    expect(agentMiss(entryToActivity(entry('note'))!)).toBe(false)
  })
  it('连续相同的合成一行（留最新、repeat 计数），不同的不合；页签计数不变', () => {
    const items = tidyActivity(activityOf([
      entry('risk.denied', { ruleHits: [HIT] }), entry('risk.denied', { ruleHits: [HIT] }), entry('risk.denied', { ruleHits: [HIT] }),
      entry('note'), entry('risk.denied', { ruleHits: [{ ...HIT, actual: '600' }] }),
    ]))
    const rows = foldAgentMisses(items)
    expect(rows.map((r) => [r.type, r.repeat ?? 1])).toEqual([['risk.denied', 1], ['note', 1], ['risk.denied', 3]])
    expect(rows[2]!.seq).toBe(Math.max(...items.filter((x) => x.type === 'risk.denied' && x.rules[0]?.includes('499.9')).map((x) => x.seq)))
    expect(activityCounts(items).all).toBe(5)
  })
})

describe('UX-34 engines bind 的授权不写成「签发 Agent 权限」', () => {
  it('发起工具是 engine.bind：绑定引擎授权（纸面）；别的照旧', () => {
    expect(entryToActivity(entry('mandate.issued', { origin: HUMAN }))!.what).toBe('绑定引擎授权（纸面）')
    expect(entryToActivity(entry('mandate.issued', { origin: { ...HUMAN, tool: 'op:agentkey.create' } }))!.what).toBe('签发 Agent 权限')
  })
})

describe('UX-20 取整提示不再拖一长串小数', () => {
  const P = { ruleId: 'inst#size', code: 'SIZE_PRECISION', unit: 'BTC', action: 'limit', scope: 'instrument' }
  it('取整前只多留 3 位、截掉的用 ≈ 标出；本来就短的照原样', () => {
    expect(splitHits([{ ...P, actual: '0.001610656100762645', limit: '0.00161' }]).notes).toEqual(['数量按精度取整：≈0.00161065 → 0.00161 BTC'])
    expect(splitHits([{ ...P, actual: '0.001236', limit: '0.00123' }]).notes).toEqual(['数量按精度取整：0.001236 → 0.00123 BTC'])
  })
})

describe('UX-10 连接态：connection 与 wsState 取更差的', () => {
  it('内核 connection 缺省成 connected、连接器 wsState 已断开 → 已断开', () => {
    expect(connOf({ connection: 'connected', wsState: 'disconnected' })).toBe('disconnected')
    expect(connOf({ connection: 'disconnected', wsState: 'connecting' })).toBe('disconnected')
    expect(connOf({ wsState: 'connecting' })).toBe('connecting')
    expect(connOf({})).toBeNull()
    expect(normalizeVenues([{ venue: 'hyperliquid', connection: 'connected', wsState: 'disconnected' }])[0]!.wsText).toBe('已断开')
  })
})
