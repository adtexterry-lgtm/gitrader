// SPDX-License-Identifier: CPAL-1.0
// 工具读写标注表与协议清单一致；脱敏不泄原值、不改输入、循环引用不炸；日志截断。
import { describe, expect, it } from 'vitest'
import { MCP_TOOL_NAMES } from '@gitrader/protocol'
import { TOOL_ACCESS, describeToolCall, redactSecrets, toolAccess } from '../src/contract'

describe('TOOL_ACCESS（与协议工具清单一致）', () => {
  it('键集合与 MCP_TOOL_NAMES 完全相等', () => {
    expect(new Set(Object.keys(TOOL_ACCESS))).toEqual(new Set(MCP_TOOL_NAMES))
    expect(Object.keys(TOOL_ACCESS)).toHaveLength(MCP_TOOL_NAMES.length)
  })

  it('取值只能是 read / write / control，且至少 1 个 control、至少 5 个 read', () => {
    const values = Object.values(TOOL_ACCESS)
    for (const v of values) expect(['read', 'write', 'control']).toContain(v)
    expect(values.filter((v) => v === 'control').length).toBeGreaterThanOrEqual(1)
    expect(values.filter((v) => v === 'read').length).toBeGreaterThanOrEqual(5)
  })

  it('toolAccess 查得到表里的工具，未知工具返回 undefined', () => {
    for (const name of MCP_TOOL_NAMES) {
      expect(toolAccess(name)).toBe(TOOL_ACCESS[name])
    }
    expect(toolAccess('no_such_tool')).toBeUndefined()
  })
})

describe('redactSecrets', () => {
  it('按键名脱敏（大小写不敏感），不碰普通值，也不修改输入', () => {
    const input = {
      apiKey: 'abc',
      nested: { Authorization: 'Bearer x', ok: 1 },
      list: [{ privateKey: '0x' + 'a'.repeat(64) }],
      plain: 'hello',
    }
    const before = structuredClone(input)
    const out = redactSecrets(input)

    expect(out.apiKey).toBe('[redacted]')
    expect(out.nested.Authorization).toBe('[redacted]')
    expect(out.nested.ok).toBe(1)
    expect(out.list[0]!.privateKey).toBe('[redacted]')
    expect(out.plain).toBe('hello')
    expect(input).toEqual(before)
  })

  it('字符串值本身呈密钥形态时也脱敏', () => {
    expect(redactSecrets('0x' + 'f'.repeat(64))).toBe('[redacted]')
    expect(redactSecrets('sk-' + 'x'.repeat(30))).toBe('[redacted]')
    expect(redactSecrets('aaa.bbb.ccc')).toBe('[redacted]')
    expect(redactSecrets('the quick brown fox jumps over the lazy dog')).toBe('the quick brown fox jumps over the lazy dog')
  })

  it('循环引用不抛错，循环处替换为 [circular]，结果可 JSON 串化', () => {
    const node: Record<string, unknown> = { name: 'root' }
    node.self = node
    const out = redactSecrets(node)

    expect(out.self).toBe('[circular]')
    expect(() => JSON.stringify(out)).not.toThrow()
    expect(JSON.stringify(out)).toContain('[circular]')
  })
})

describe('describeToolCall', () => {
  it('入参脱敏后串化，超长截断', () => {
    const out = describeToolCall('order', { clientOrderId: 'c1', secret: 's' }, 50)
    expect(out).toContain('[redacted]')
    expect(out).not.toContain(': "s"')
    expect(out.length).toBeLessThanOrEqual(50 + '…(truncated)'.length)
  })
})
