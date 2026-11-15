// SPDX-License-Identifier: CPAL-1.0
// P0-4b：propose / order 的 OrderIntent 入参 schema、tools/list_changed 日志门控、结果里的毫秒时间戳旁附 ISO。
import { afterEach, describe, expect, it } from 'vitest'
import { getMcpTool, ORDER_INTENT_GUIDE } from '@gitrader/protocol'
import { logListChangedNotSent, withIsoTimes } from '../src/server'

interface Nesting {
  required?: string[]
}

const propsOf = (name: string): Record<string, unknown> => {
  const t = getMcpTool(name)
  expect(t, `tool ${name}`).toBeDefined()
  return t!.inputSchema.properties
}

const debugFlag = process.env.GITRADER_MCP_DEBUG
afterEach(() => {
  if (debugFlag === undefined) delete process.env.GITRADER_MCP_DEBUG
  else process.env.GITRADER_MCP_DEBUG = debugFlag
})

describe('P0-4b MCP 面', () => {
  it('propose.intents schema lists required fields', () => {
    const intents = propsOf('propose')['intents'] as { description?: string }
    for (const f of ['accountId', 'instrumentId', 'side', 'type', 'reason', 'tpsl.stopLoss']) expect(intents.description, 'intents.description lists ' + f).toContain(f)
    // 字段含义与 tpsl 写法放在 tool_help 的 guide 里（入参 schema 守住契约 §5.7 的嵌套上限）
    expect(ORDER_INTENT_GUIDE).toContain('tpsl.stopLoss')
    expect(ORDER_INTENT_GUIDE).toContain('hyperliquid:BTC')
    // order 的 intent 复用同一份带属性的 schema
    const intent = propsOf('order')['intent'] as Nesting
    expect(intent.required).toEqual(expect.arrayContaining(['accountId', 'instrumentId', 'side', 'type', 'reason']))
  })

  it('--check prints no list_changed noise', () => {
    const lines: string[] = []
    delete process.env.GITRADER_MCP_DEBUG
    logListChangedNotSent(new Error('host does not support list_changed'), (m) => lines.push(m))
    expect(lines.filter((l) => l.includes('not sent'))).toEqual([])
    expect(lines).toEqual([])

    // 门控是双向的：打开调试后才允许输出同类日志
    process.env.GITRADER_MCP_DEBUG = '1'
    logListChangedNotSent(new Error('host does not support list_changed'), (m) => lines.push(m))
    expect(lines.filter((l) => l.includes('not sent'))).toHaveLength(1)
  })

  it('ms timestamps get Iso sibling', () => {
    const input = { createdAt: 1761300000000, nested: [{ ts: 1761300000000 }], n: 5 }
    const out = withIsoTimes(input) as { createdAt: number; createdAtIso?: unknown; nested: { ts: number; tsIso?: unknown }[]; n: number; nIso?: unknown }
    expect(out.createdAt).toBe(1761300000000)
    expect(typeof out.createdAtIso).toBe('string')
    expect(Number.isNaN(Date.parse(out.createdAtIso as string))).toBe(false)
    expect(new Date(out.createdAt).toISOString()).toBe(out.createdAtIso as string)
    const nested = out.nested[0]
    expect(nested, 'nested[0]').toBeDefined()
    expect(typeof nested!.tsIso).toBe('string')
    expect(Number.isNaN(Date.parse(nested!.tsIso as string))).toBe(false)
    expect(out.n).toBe(5)
    expect('nIso' in out).toBe(false)
    // 不改原对象
    expect(Object.keys(input).sort()).toEqual(['createdAt', 'n', 'nested'])
    expect(Object.keys(input.nested[0]!)).toEqual(['ts'])
  })
})
