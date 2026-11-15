// SPDX-License-Identifier: Apache-2.0
// 第六轮 C 包：MCP 工具 research 的定义、预算与引擎扩展方法登记。
import { describe, expect, it } from 'vitest'
import {
  MANDATE_LEVELS, MCP_ACTION_USAGE, MCP_BUDGET, MCP_TOOLS, RESEARCH_CAPABILITY, RESEARCH_KINDS, RESEARCH_LIMITS, RESEARCH_PARTS, X_GITRADER_METHODS,
  X_GITRADER_RESEARCH_METHODS, estimateToolDefTokens, getMcpTool, isExtensionMethod, mcpToolsForLevel, mcpUsageLine, resolveMcpAction,
} from '../src'

const ACTIONS = ['optimize', 'walk_forward', 'factor_report', 'backtest_report', 'portfolio', 'search', 'status', 'result', 'cancel']

describe('research 工具定义（R3-01）', () => {
  const t = getMcpTool('research')!
  it('只新增一个工具，紧跟 backtest；组 P、默认加载、只读标注', () => {
    const names = MCP_TOOLS.map((x) => x.name)
    expect(names.indexOf('research')).toBe(names.indexOf('backtest') + 1)
    expect(names.filter((n) => n === 'research')).toHaveLength(1)
    expect(t.group).toBe('P')
    expect(t.load).toEqual({ kind: 'always' })
    expect(t.annotations.readOnlyHint).toBe(true)
    expect('minLevel' in t).toBe(false)
  })
  it('action 枚举恰好是 9 个，actions 与枚举一致；只有三个异步起作业动作要求 L1（P2-5），其余不设最低级别', () => {
    const en = (t.inputSchema.properties.action as { enum: string[] }).enum
    expect(en).toEqual(ACTIONS)
    expect(t.actions.map((a) => a.name)).toEqual(ACTIONS)
    expect(t.actions.filter((a) => a.minLevel).map((a) => [a.name, a.minLevel])).toEqual([['optimize', 'L1'], ['walk_forward', 'L1'], ['factor_report', 'L1']])
    expect(t.actions.every((a) => !a.liveMinLevel)).toBe(true)
  })
  it('其余入参：spec / jobId / part / query / accountId / format / limit / cursor', () => {
    expect(Object.keys(t.inputSchema.properties).sort()).toEqual(['accountId', 'action', 'cursor', 'format', 'jobId', 'limit', 'part', 'query', 'spec'])
    expect((t.inputSchema.properties.part as { enum: string[] }).enum).toEqual([...RESEARCH_PARTS])
    expect((t.inputSchema.properties.format as { enum: string[] }).enum).toEqual(['md', 'json'])
    expect(t.inputSchema.required).toEqual(['action'])
  })
  it('描述 ≤ 60 字，定义 ≤ 450 token；所有级别（含只读钥匙）默认加载', () => {
    expect([...t.description].length).toBeLessThanOrEqual(MCP_BUDGET.maxDescriptionChars)
    expect(estimateToolDefTokens(t)).toBeLessThanOrEqual(MCP_BUDGET.maxToolDefTokens)
    for (const l of MANDATE_LEVELS) expect(mcpToolsForLevel(l).map((x) => x.name)).toContain('research')
  })
  it('预算常量与真实清单一致：17 / L0 13 / L1+ 16，默认集合仍在 6000 token 内', () => {
    expect(MCP_BUDGET.toolCount).toBe(MCP_TOOLS.length)
    expect(MCP_BUDGET.toolCount).toBe(17)
    expect(mcpToolsForLevel('L0')).toHaveLength(MCP_BUDGET.defaultLoadL0)
    expect(mcpToolsForLevel('L1')).toHaveLength(MCP_BUDGET.defaultLoadL1Plus)
    for (const l of MANDATE_LEVELS) expect(mcpToolsForLevel(l, { allowAgentLayout: true }).reduce((s, x) => s + estimateToolDefTokens(x), 0)).toBeLessThanOrEqual(MCP_BUDGET.maxDefaultSetTokens)
  })
  it('用法示例：每个动作一条合法 JSON；别名只指向存在的动作', () => {
    for (const a of ACTIONS) {
      const ex = JSON.parse(MCP_ACTION_USAGE.research![a]!) as Record<string, unknown>
      expect(typeof ex).toBe('object')
      expect(mcpUsageLine('research', a)).toContain(`research ${a} --args`)
    }
    const spec = (JSON.parse(MCP_ACTION_USAGE.research!.optimize!) as { spec: { validation?: unknown; space?: unknown } }).spec
    expect(spec.validation).toBeTruthy()
    expect(spec.space).toBeTruthy()
    expect(resolveMcpAction('research', 'hyperopt')?.action).toBe('optimize')
    expect(resolveMcpAction('research', 'walk-forward')?.action).toBe('walk_forward')
  })
})

describe('x-gitrader.research.* 扩展方法登记（不动 X_GITRADER_METHODS）', () => {
  it('四个方法都是合法扩展方法，同一个能力位；X_GITRADER_METHODS 原样', () => {
    expect(Object.keys(X_GITRADER_RESEARCH_METHODS)).toEqual(['x-gitrader.research.run', 'x-gitrader.research.status', 'x-gitrader.research.result', 'x-gitrader.research.cancel'])
    for (const [m, v] of Object.entries(X_GITRADER_RESEARCH_METHODS)) {
      expect(isExtensionMethod(m)).toBe(true)
      expect(v.capability).toBe(RESEARCH_CAPABILITY)
    }
    expect(Object.keys(X_GITRADER_METHODS).some((k) => k.includes('research'))).toBe(false)
    expect([...RESEARCH_KINDS]).toEqual(['optimize', 'walk_forward', 'factor_report'])
  })
  it('硬性口径：500 组、8000 字节摘要、整页 < 60,000 字符', () => {
    expect(RESEARCH_LIMITS.maxTrials).toBe(500)
    expect(RESEARCH_LIMITS.summaryMaxBytes).toBe(8000)
    expect(RESEARCH_LIMITS.pageMaxChars).toBeLessThan(60_000)
    expect(RESEARCH_LIMITS.defaultLimit).toBe(500)
    expect(RESEARCH_LIMITS.maxLimit).toBe(1000)
  })
})
