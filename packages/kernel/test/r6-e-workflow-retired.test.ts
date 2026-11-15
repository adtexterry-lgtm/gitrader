// SPDX-License-Identifier: CPAL-1.0
// R3-05：workflow 在接线实现之前退出 Agent 工具面（tools/list、discover、直接调用）。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeAgent, makeHarness } from './helpers/harness'
import type { Harness, TestAgent } from './helpers/harness'

let h: Harness
beforeEach(async () => { h = await makeHarness() })
afterEach(async () => { await h.cleanup() })

interface Reply { data: any; session: any } // eslint-disable-line @typescript-eslint/no-explicit-any
const call = async (a: TestAgent, tool: string, params: Record<string, unknown> = {}): Promise<Reply> =>
  (await h.k.ops.call(h.k, `agent.${tool}`, { principal: a.principal, params, transport: 'http' })) as Reply

describe('R3-05 workflow 退出暴露', () => {
  it.each(['read_only', 'paper', 'confirm'] as const)('%s 钥匙：session.tools 与 discover groups 都没有 workflow', async (tier) => {
    const a = await makeAgent(h, tier)
    const g = await call(a, 'discover', { action: 'groups' })
    const grouped = Object.values(g.data.groups as Record<string, { tool: string }[]>).flat().map((t) => t.tool)
    expect(grouped).not.toContain('workflow')
    expect(g.session.tools).not.toContain('workflow')
    expect(grouped).toHaveLength(17)
  })

  it('discover tool_help workflow 报错；直接调 workflow 报未知操作', async () => {
    const a = await makeAgent(h, 'paper')
    await expect(call(a, 'discover', { action: 'tool_help', tool: 'workflow' })).rejects.toMatchObject({ problem: { name: 'INVALID_PARAMS', message: expect.stringMatching(/unknown tool workflow/) } })
    await expect(call(a, 'workflow', { action: 'list' })).rejects.toMatchObject({ problem: { name: 'METHOD_NOT_FOUND' } })
  })
})
