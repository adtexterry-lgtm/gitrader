// SPDX-License-Identifier: CPAL-1.0
// 夹具必须是合法的协议实体（不许自造字段骗过自己的渲染测试），回放文件必须是 SDK 能吃的形状。
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  validateAccount, validateAgentKey, validateFill, validateLedgerEntry, validateMandate, validateOrder, validatePosition, validateProposal, validateRuleHit,
} from '@gitrader/protocol'
import { describe, expect, it } from 'vitest'
import { scenario, type ScenarioName } from '../fixtures/scenarios'
import { defaultBlocks } from '../src/index'

const fmt = (r: { ok: boolean; issues?: Array<{ path: string; message: string }> }) => (r.ok ? '' : (r.issues ?? []).map((i) => `${i.path} ${i.message}`).join('; '))
const all = (['empty', 'normal', 'pending', 'halted', 'error'] as ScenarioName[]).map((n) => [n, scenario(n)] as const)

describe('场景夹具是合法的协议实体', () => {
  it.each(all)('%s：账户 / 持仓 / 成交 / 订单 / 钥匙 / 授权书 / 提案 / 账本条目', (_n, s) => {
    for (const a of s.accounts) expect(fmt(validateAccount(a)), 'account').toBe('')
    for (const list of Object.values(s.positions)) for (const p of list) expect(fmt(validatePosition(p)), 'position').toBe('')
    for (const list of Object.values(s.fills)) for (const f of list) expect(fmt(validateFill(f)), 'fill').toBe('')
    for (const list of Object.values(s.orders)) for (const o of list) expect(fmt(validateOrder(o)), 'order').toBe('')
    for (const k of s.keys) expect(fmt(validateAgentKey(k)), 'agent key').toBe('')
    for (const m of s.mandates) expect(fmt(validateMandate(m)), 'mandate').toBe('')
    for (const p of s.proposals) expect(fmt(validateProposal(p)), 'proposal').toBe('')
    for (const e of s.ledger) {
      expect(fmt(validateLedgerEntry(e)), `ledger #${e.seq}`).toBe('')
      for (const h of e.ruleHits ?? []) expect(fmt(validateRuleHit(h)), `ruleHit #${e.seq}`).toBe('')
    }
  })

  it('覆盖面：正常场景里四类来源都有、LLM 被拦、有保护器触发；待批场景有两张待审提案', () => {
    const n = scenario('normal')
    expect(new Set(n.ledger.map((e) => e.origin.actorType))).toEqual(new Set(['llm-agent', 'engine', 'human', 'system']))
    expect(n.ledger.some((e) => e.ruleHits?.some((h) => h.code === 'LLM_LIVE_ENTRY'))).toBe(true)
    expect(n.ledger.some((e) => e.type === 'protector.triggered')).toBe(true)
    expect(scenario('pending').proposals.filter((p) => p.status === 'pending')).toHaveLength(2)
    expect(scenario('empty').accounts).toHaveLength(1)
    expect(scenario('error').failing).toBe(true)
  })
})

describe('回放文件（清单 fixtures）', () => {
  const dir = join(__dirname, '..', 'fixtures')
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'))
  it('四个块各有一份，且清单指向它', () => {
    expect(files.sort()).toEqual(['agent-activity.json', 'positions.json', 'risk.json', 'statusbar.json'])
    for (const d of defaultBlocks) expect(files).toContain(d.manifest.fixtures[0]!.replace('./fixtures/', ''))
  })
  it.each(['positions', 'agent-activity', 'risk', 'statusbar'])('%s：形状是 BlockFixtures（events 按时间、queries 键是块声明过的查询）', (name) => {
    const fx = JSON.parse(readFileSync(join(dir, `${name}.json`), 'utf8')) as { events: Array<{ t: number; topic: string }>; queries: Record<string, unknown> }
    const m = defaultBlocks.find((d) => d.manifest.fixtures.some((f) => f.endsWith(`/${name}.json`)))!.manifest
    for (const q of Object.keys(fx.queries)) expect(m.inputs?.queries, `${name} 回放里的查询 ${q} 没有在清单里声明`).toContain(q)
    for (const q of m.inputs?.queries ?? []) expect(Object.keys(fx.queries), `${name} 清单声明的查询 ${q} 回放里没有`).toContain(q)
    for (const e of fx.events) {
      expect(e.t).toBeGreaterThanOrEqual(0)
      expect(m.inputs?.events?.some((x) => x.topic === e.topic || (x.topic.endsWith('.*') && e.topic.startsWith(x.topic.slice(0, -1)))), `${name} 回放事件 ${e.topic} 没有在清单里声明`).toBe(true)
    }
  })
})
