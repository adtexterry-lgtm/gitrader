// SPDX-License-Identifier: Apache-2.0
// ADR-22 名称引导：别名表、逐动作用法示例、解析与模糊建议。
import { describe, expect, it } from 'vitest'
import {
  MCP_ACTION_ALIASES, MCP_ACTION_USAGE, MCP_TOOL_ALIASES, MCP_TOOL_NAMES, MCP_TOOLS, getMcpTool,
  mcpUsageLine, resolveMcpAction, resolveMcpTool, suggestMcpNames,
} from '../src'

const toolActions = (tool: string): readonly string[] => getMcpTool(tool)?.actions.map((a) => a.name) ?? []

/** 写动作清单（别名不得指向这些动作）。 */
const WRITE_TOOLS = new Set(['order', 'propose', 'takeover', 'workspace'])
const WRITE_PAIRS = new Set([
  'proposals.withdraw',
  'mandate.heartbeat', 'mandate.downgrade', 'mandate.request_promotion',
  'engines.start_strategy', 'engines.update_strategy', 'engines.stop_strategy',
  'note.add',
  'backtest.run', 'backtest.cancel',
  'workflow.put', 'workflow.run', 'workflow.stop', 'workflow.backtest',
  'experiment.create', 'experiment.update', 'experiment.attach', 'experiment.stage', 'experiment.pack',
  'plugins.call',
])
const isWriteAction = (tool: string, action: string): boolean => WRITE_TOOLS.has(tool) || WRITE_PAIRS.has(`${tool}.${action}`)

describe('MCP 名称引导（ADR-22）', () => {
  it('every MCP action has a usage example', () => {
    for (const tool of MCP_TOOLS) {
      for (const action of tool.actions) {
        const example = MCP_ACTION_USAGE[tool.name]?.[action.name]
        expect(example, `${tool.name}.${action.name}`).toBeTruthy()
        const parsed: unknown = JSON.parse(example as string)
        expect(typeof parsed, `${tool.name}.${action.name}`).toBe('object')
        expect(Array.isArray(parsed), `${tool.name}.${action.name}`).toBe(false)
        expect(parsed, `${tool.name}.${action.name}`).not.toBeNull()
      }
    }
  })

  it('usage has no extra entries', () => {
    for (const [tool, actions] of Object.entries(MCP_ACTION_USAGE)) {
      const known = toolActions(tool)
      expect(known.length, tool).toBeGreaterThan(0)
      for (const action of Object.keys(actions)) expect(known, `${tool}.${action}`).toContain(action)
    }
  })

  it('action aliases point to existing read-only actions', () => {
    for (const [tool, aliases] of Object.entries(MCP_ACTION_ALIASES)) {
      const known = toolActions(tool)
      expect(known.length, tool).toBeGreaterThan(0)
      for (const [key, target] of Object.entries(aliases)) {
        expect(known, `${tool}: ${key} → ${target}`).toContain(target)
        expect(isWriteAction(tool, target), `${tool}: ${key} → ${target} is a write action`).toBe(false)
      }
    }
  })

  it('alias keys never shadow a real action', () => {
    for (const [tool, aliases] of Object.entries(MCP_ACTION_ALIASES)) {
      const known = toolActions(tool)
      for (const key of Object.keys(aliases)) expect(known, `${tool}.${key}`).not.toContain(key)
    }
    for (const key of Object.keys(MCP_TOOL_ALIASES)) expect(MCP_TOOL_NAMES, key).not.toContain(key)
  })

  it('resolveMcpAction', () => {
    expect(resolveMcpAction('account', 'get')).toEqual({ action: 'summary', alias: 'get' })
    expect(resolveMcpAction('account', 'summary')).toEqual({ action: 'summary' })
    expect(resolveMcpAction('account', 'Get')).toMatchObject({ action: 'summary' })
    expect(resolveMcpAction('account', 'open-orders')).toMatchObject({ action: 'orders' })
    expect(resolveMcpAction('account', 'nope')).toBeNull()
    expect(resolveMcpAction('nope', 'get')).toBeNull()
  })

  it('resolveMcpTool', () => {
    expect(resolveMcpTool('accounts')).toEqual({ tool: 'account', alias: 'accounts' })
    expect(resolveMcpTool('account')).toEqual({ tool: 'account' })
    expect(resolveMcpTool('risk')).toEqual({ tool: 'risk_status', alias: 'risk' })
    expect(resolveMcpTool('zzz')).toBeNull()
  })

  it('suggestMcpNames', () => {
    expect(suggestMcpNames('summery', ['list', 'summary', 'positions'])[0]).toBe('summary')
    expect(suggestMcpNames('', ['a'])).toEqual([])
    expect(suggestMcpNames('xyzxyzxyz', ['list'])).toEqual([])
  })

  it('mcpUsageLine', () => {
    expect(mcpUsageLine('account', 'summary')).toMatch(/^gitrader agent account summary --args '/)
  })
})
