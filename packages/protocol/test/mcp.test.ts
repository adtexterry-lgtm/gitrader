// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest'
import {
  DEMO_TOOLS_MOVED_TO_HUMAN, DEMO_TOOLS_REMOVED, DEMO_TO_MCP_MAP, MANDATE_LEVELS, MCP_BUDGET, MCP_TOOLS, MCP_TOOL_NAMES, NEW_MCP_TOOLS, estimateToolDefTokens,
  getMcpTool, levelAtLeast, listSchemaIds, mcpToolsForLevel,
} from '../src'

describe('MCP 工具清单（§5.7、§7.4）', () => {
  it('17 个工具，名字与分组（S 2 / R 5 / P 8 / E 1 / W 1；workflow 在接线实现之前退出暴露，research 顶替）', () => {
    expect(MCP_TOOLS.length).toBe(17)
    expect(MCP_TOOL_NAMES).toEqual([
      'takeover', 'mandate', 'discover', 'market', 'account', 'risk_status', 'ledger', 'engines', 'propose', 'proposals', 'note', 'backtest', 'research',
      'experiment', 'plugins', 'order', 'workspace',
    ])
    expect(MCP_TOOL_NAMES as readonly string[]).not.toContain('workflow')
    const count = (g: string) => MCP_TOOLS.filter((t) => t.group === g).length
    expect([count('S'), count('R'), count('P'), count('E'), count('W')]).toEqual([2, 5, 8, 1, 1])
    expect(new Set(MCP_TOOL_NAMES).size).toBe(17)
    expect(MCP_TOOLS.length).toBeLessThanOrEqual(MCP_BUDGET.maxTools)
  })
  it('工具名不带前缀、不含 Demo 的下划线老名字之外的怪字符', () => {
    for (const n of MCP_TOOL_NAMES) expect(n).toMatch(/^[a-z][a-z_]*$/)
  })
  it('描述：中文、非空、≤60 字，且不重复同一句固定话', () => {
    const seen = new Set<string>()
    for (const t of MCP_TOOLS) {
      expect(t.description.length, t.name).toBeGreaterThan(5)
      expect([...t.description].length, `${t.name}: ${t.description}`).toBeLessThanOrEqual(MCP_BUDGET.maxDescriptionChars)
      expect(t.description, t.name).toMatch(/[一-鿿]/)
      expect(seen.has(t.description)).toBe(false)
      seen.add(t.description)
    }
  })
  it('参数描述 ≤100 字；嵌套 ≤2 层；action 枚举与 actions 一致', () => {
    for (const t of MCP_TOOLS) {
      const action = t.inputSchema.properties['action'] as { enum: string[] }
      expect(action.enum, t.name).toEqual(t.actions.map((a) => a.name))
      expect(t.inputSchema.required).toContain('action')
      for (const [k, v] of Object.entries(t.inputSchema.properties)) {
        const d = (v as { description?: string }).description
        if (d) expect([...d].length, `${t.name}.${k}`).toBeLessThanOrEqual(MCP_BUDGET.maxParamDescriptionChars)
        expect(JSON.stringify(v).split('{').length - 1, `${t.name}.${k} nesting`).toBeLessThanOrEqual(MCP_BUDGET.maxSchemaNesting + 1)
      }
    }
  })
  it('动作清单符合 §5.7 表', () => {
    const acts = (n: string) => getMcpTool(n)!.actions.map((a) => a.name)
    expect(acts('takeover')).toEqual(['halt_new', 'cancel_all', 'flatten_all'])
    expect(acts('mandate')).toEqual(['status', 'heartbeat', 'downgrade', 'request_promotion'])
    expect(acts('discover')).toEqual(['groups', 'tool_help', 'capabilities'])
    expect(acts('market')).toEqual(['search', 'quote', 'book', 'candles', 'context', 'funding', 'venue_status'])
    expect(acts('account')).toEqual(['list', 'summary', 'positions', 'orders', 'fills', 'balances', 'margin'])
    expect(acts('risk_status')).toEqual(['state', 'usage', 'rules', 'denials'])
    expect(acts('ledger')).toEqual(['query', 'trace', 'stats'])
    expect(acts('engines')).toEqual(['list', 'status', 'strategies', 'start_strategy', 'update_strategy', 'stop_strategy'])
    expect(acts('propose')).toEqual(['order', 'control'])
    expect(acts('proposals')).toEqual(['get', 'list', 'withdraw'])
    expect(acts('note')).toEqual(['add', 'list'])
    expect(acts('backtest')).toEqual(['run', 'status', 'result', 'cancel'])
    expect(getMcpTool('workflow')).toBeUndefined()
    expect(acts('experiment')).toEqual(['create', 'get', 'list', 'update', 'attach', 'stage', 'pack', 'export'])
    expect(acts('plugins')).toEqual(['list', 'describe', 'call'])
    expect(acts('order')).toEqual(['preview', 'place', 'amend', 'cancel', 'cancel_all', 'close'])
    expect(acts('workspace')).toEqual(['list', 'add', 'remove', 'arrange', 'save', 'load', 'popout', 'focus'])
    expect(acts('proposals')).not.toContain('approve')
    expect(acts('proposals')).not.toContain('reject')
  })
  it('注解：只读五件是 readOnlyHint；takeover 与 order 是 destructiveHint', () => {
    for (const n of ['discover', 'market', 'account', 'risk_status', 'ledger']) expect(getMcpTool(n)!.annotations.readOnlyHint, n).toBe(true)
    for (const n of ['takeover', 'order']) expect(getMcpTool(n)!.annotations.destructiveHint, n).toBe(true)
    expect(getMcpTool('proposals')!.annotations).toEqual({})
  })
  it('自保动作标记：takeover 三档、mandate 的 status / heartbeat / downgrade、withdraw、stop_strategy', () => {
    const selfProtect = MCP_TOOLS.flatMap((t) => t.actions.filter((a) => 'selfProtect' in a && a.selfProtect).map((a) => `${t.name}.${a.name}`))
    expect(selfProtect.sort()).toEqual([
      'engines.stop_strategy', 'mandate.downgrade', 'mandate.heartbeat', 'mandate.status', 'proposals.withdraw',
      'takeover.cancel_all', 'takeover.flatten_all', 'takeover.halt_new',
    ].sort())
  })
  it('v0.1.2：下单类工具的描述写明默认受"LLM 实盘开仓"策略约束', () => {
    expect(getMcpTool('order')!.description).toContain('LLM 实盘开仓默认被策略拒绝')
  })
})

describe('按授权书级别加载（默认只读 + 提案，执行组按授权书加载）', () => {
  it('L0 = 13，L1–L4 = 16，目标 ≤ 20；workspace 需要人打开开关', () => {
    expect(mcpToolsForLevel('L0').length).toBe(MCP_BUDGET.defaultLoadL0)
    for (const l of ['L1', 'L2', 'L3', 'L4'] as const) expect(mcpToolsForLevel(l).length, l).toBe(MCP_BUDGET.defaultLoadL1Plus)
    expect(MCP_BUDGET.defaultLoadL1Plus).toBeLessThanOrEqual(MCP_BUDGET.defaultLoadTarget)
    expect(mcpToolsForLevel('L1', { allowAgentLayout: true }).length).toBe(17)
    expect(mcpToolsForLevel('L0').map((t) => t.name)).not.toContain('order')
    expect(mcpToolsForLevel('L0').map((t) => t.name)).not.toContain('propose')
    expect(mcpToolsForLevel('L0').map((t) => t.name)).not.toContain('proposals')
    expect(mcpToolsForLevel('L0').map((t) => t.name)).not.toContain('workspace')
    expect(mcpToolsForLevel('L1').map((t) => t.name)).toEqual(expect.arrayContaining(['order', 'propose', 'proposals']))
  })
  it('自保组（takeover / mandate）在所有级别都加载', () => {
    for (const l of MANDATE_LEVELS) expect(mcpToolsForLevel(l).map((t) => t.name)).toEqual(expect.arrayContaining(['takeover', 'mandate']))
  })
  it('实盘动作的级别门：order 实盘 L3+，propose 实盘 L2+', () => {
    const place = getMcpTool('order')!.actions.find((a) => a.name === 'place')!
    expect(place.minLevel).toBe('L1')
    expect(place.liveMinLevel).toBe('L3')
    expect(getMcpTool('propose')!.actions[0]!.liveMinLevel).toBe('L2')
    expect(levelAtLeast('L2', 'L1')).toBe(true)
    expect(levelAtLeast('L0', 'L1')).toBe(false)
  })
})

describe('下单前问金额（fix-r4）', () => {
  it('propose / order 描述要求金额先经用户确认；takeover 写明 cancel_all 默认保留止损', () => {
    expect(getMcpTool('propose')!.description).toMatch(/金额/)
    expect(getMcpTool('order')!.description).toMatch(/金额/)
    expect(getMcpTool('takeover')!.description).toMatch(/cancel_all 默认保留止损/)
  })
})

describe('预算（§5.7）', () => {
  it('单个工具定义 ≤ 450 tokens（粗估），默认集合 ≤ 6,000 tokens', () => {
    for (const t of MCP_TOOLS) expect(estimateToolDefTokens(t), t.name).toBeLessThanOrEqual(MCP_BUDGET.maxToolDefTokens)
    for (const l of MANDATE_LEVELS) {
      const total = mcpToolsForLevel(l, { allowAgentLayout: true }).reduce((s, t) => s + estimateToolDefTokens(t), 0)
      expect(total, l).toBeLessThanOrEqual(MCP_BUDGET.maxDefaultSetTokens)
    }
  })
  it('出参 schema 引用都能在注册表里找到', () => {
    const ids = new Set(listSchemaIds())
    const bare = (u: string) => u.split('#')[0]!
    for (const t of MCP_TOOLS) for (const r of t.resultSchemaRefs) expect(ids.has(bare(r)), `${t.name} → ${r}`).toBe(true)
  })
})

describe('Demo 74 → 17 映射（§7.4）', () => {
  it('取代 41 + 移到人面 17 + 删除 16 = 74', () => {
    const replaced = Object.values(DEMO_TO_MCP_MAP).reduce((s, v) => s + v.length, 0)
    expect(replaced).toBe(41)
    expect(DEMO_TOOLS_MOVED_TO_HUMAN.length).toBe(17)
    expect(DEMO_TOOLS_REMOVED.length).toBe(16)
    expect(replaced + DEMO_TOOLS_MOVED_TO_HUMAN.length + DEMO_TOOLS_REMOVED.length).toBe(74)
  })
  it('映射的目标都是真工具；新增 5 个；Demo 名字没有重复归属', () => {
    for (const k of Object.keys(DEMO_TO_MCP_MAP)) expect(MCP_TOOL_NAMES as readonly string[]).toContain(k)
    expect(NEW_MCP_TOOLS.length).toBe(5)
    for (const n of NEW_MCP_TOOLS) expect(MCP_TOOL_NAMES as readonly string[]).toContain(n)
    const all = [...Object.values(DEMO_TO_MCP_MAP).flat(), ...DEMO_TOOLS_MOVED_TO_HUMAN, ...DEMO_TOOLS_REMOVED]
    expect(new Set(all).size).toBe(all.length)
    expect(DEMO_TOOLS_MOVED_TO_HUMAN).toContain('proposal_approve')
  })
})
