// SPDX-License-Identifier: Apache-2.0
import { expect } from 'vitest'
import { compileSchema, validatePluginManifest, validateProblem } from '../../src'
import type { Target } from './target'
import type { Response } from './transport'

export interface Case { id: string; title: string; run(target: Target): Promise<void> }

function problem(response: Response, code: number): void {
  expect(response.error?.code).toBe(code)
  expect(validateProblem(response.error?.data).ok).toBe(true)
  expect(response.error?.data?.code).toBe(code)
  expect(response.error?.data?.category).toBe('PROTOCOL')
}

async function connected(t: Target) {
  const s = await t.open()
  const response = await s.request('plugin.hello', t.hello())
  expect(response.error).toBeUndefined()
  return s
}

export const cases: readonly Case[] = [
  { id: 'G01', title: 'JSON-RPC frames, NDJSON and array batches', async run(t) {
    const s = await connected(t)
    const one = await s.request('plugin.health', {})
    expect(one.result).toBeTruthy()
    const batch = await s.exchange(JSON.stringify([
      { jsonrpc: '2.0', id: 101, method: 'plugin.health', params: {} },
      { jsonrpc: '2.0', id: 102, method: 'plugin.describe', params: {} },
    ]))
    expect(Array.isArray(batch)).toBe(true)
    if (!Array.isArray(batch)) throw new Error('batch response must be an array')
    expect(batch.map(r => r.id).sort()).toEqual([101, 102])
    expect(batch.every(r => r.error === undefined && r.result !== undefined)).toBe(true)
  } },
  { id: 'G02', title: 'token rejection closes within 1 s; version negotiation', async run(t) {
    const bad = await t.open()
    const at = Date.now()
    const response = await bad.request('plugin.hello', { ...t.hello(), token: `${t.token}-invalid` })
    problem(response, 5003)
    expect(await bad.waitClosed(1000)).toBe(true)
    expect(bad.closedAt - at).toBeLessThanOrEqual(1000)
    const version = await t.open()
    problem(await version.request('plugin.health', {}), 5003)
    problem(await version.request('plugin.hello', { ...t.hello(), gsp: '9.9.0' }), 5001)
    problem(await version.request('plugin.hello', { ...t.hello(), gsp: '0.0.99' }), 5001)
    const { gsp: _gsp, ...missingVersion } = t.hello()
    problem(await version.request('plugin.hello', missingVersion), 5001)
    const good = await version.request('plugin.hello', { ...t.hello(), gsp: '0.1.99' })
    expect(good.error).toBeUndefined()
    expect(good.result).toMatchObject({ gsp: '0.1.0' })
  } },
  { id: 'G03', title: 'describe passes the frozen plugin manifest schema', async run(t) {
    const s = await connected(t)
    const response = await s.request('plugin.describe', {})
    expect(response.error).toBeUndefined()
    expect(validatePluginManifest(response.result).ok).toBe(true)
  } },
  { id: 'G04', title: 'health responds with a successful status', async run(t) {
    const s = await connected(t)
    expect((await s.request('plugin.health', {})).result).toMatchObject({ ok: true })
  } },
  { id: 'G05', title: 'declared tool round trip and unknown tool error', async run(t) {
    const s = await connected(t)
    const description = validatePluginManifest((await s.request('plugin.describe', {})).result)
    expect(description.ok).toBe(true)
    if (!description.ok) throw new Error('invalid plugin description')
    const tool = description.value.tools?.find(tool => tool.name === t.tool.tool)
    expect(tool).toBeDefined()
    expect(compileSchema(tool!.input)(t.tool.args).ok).toBe(true)
    const answer = await s.request('tool.call', { tool: t.tool.tool, args: t.tool.args })
    expect(answer.error).toBeUndefined()
    expect(answer.result).toEqual(t.tool.expected)
    if (tool!.output) expect(compileSchema(tool!.output)(answer.result).ok).toBe(true)
    problem(await s.request('tool.call', { tool: 'gsp_unknown_tool', args: {} }), -32601)
  } },
  { id: 'G06', title: 'unknown method and malformed arguments carry Problem', async run(t) {
    const s = await connected(t)
    problem(await s.request('gsp.unknown', {}), -32601)
    problem(await s.request('tool.call', { tool: t.tool.tool, args: 'invalid' }), -32602)
  } },
  { id: 'G07', title: 'nested secret-like arguments rejected with 5006', async run(t) {
    const s = await connected(t)
    const response = await s.request('tool.call', { tool: t.tool.tool, args: { nested: [{ privateKey: 'fixture-only' }] } })
    problem(response, 5006)
    expect(JSON.stringify(response).includes('fixture-only')).toBe(false)
  } },
  { id: 'G08', title: 'shutdown closes within 5 s; stdio exit code is zero', async run(t) {
    const s = await connected(t)
    const at = Date.now()
    expect((await s.request('plugin.shutdown', {})).error).toBeUndefined()
    expect(await s.waitClosed(5000)).toBe(true)
    expect(s.closedAt - at).toBeLessThanOrEqual(5000)
    if (t.kind === 'stdio') expect(s.exitCode()).toBe(0)
  } },
]
