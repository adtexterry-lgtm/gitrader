// SPDX-License-Identifier: CPAL-1.0
import { describe, expect, it, vi } from 'vitest'
import { buildCommands, dispatch, rankCommands, type CommandHost } from '../src/core/commands'

const host = (): CommandHost & { calls: string[] } => {
  const calls: string[] = []
  return { calls, takeover: (l) => { calls.push('takeover:' + l) }, go: (p) => { calls.push('go:' + p) } }
}
const find = (cmds: ReturnType<typeof buildCommands>, id: string) => cmds.find((c) => c.id === id)!

describe('⌘K 命令表（最小检阅版：四条）', () => {
  it('只有：暂停 Agent / 撤全部 / 全平 / 打开设置', () => {
    // fix-r4: C6 新增「撤销 Agent 钥匙…」命令（只跳设置 → 钥匙），列表多一条
    expect(buildCommands(host()).map((c) => c.id)).toEqual(['agent:halt_new', 'agent:cancel_all', 'agent:flatten_all', 'agent:revoke_key', 'go:settings'])
  })

  it('分发：每条命令调到宿主对应的方法', async () => {
    const h = host()
    const cmds = buildCommands(h)
    for (const [id, expected] of [['agent:halt_new', 'takeover:halt_new'], ['agent:cancel_all', 'takeover:cancel_all'], ['agent:flatten_all', 'takeover:flatten_all'], ['go:settings', 'go:settings']] as const) {
      await dispatch(find(cmds, id), true)
      expect(h.calls.at(-1)).toBe(expected)
    }
  })

  it('接管三档要二次确认（第一次只返回 confirm，不调宿主）；打开设置不用', async () => {
    const h = host()
    const cmds = buildCommands(h)
    for (const id of ['agent:halt_new', 'agent:cancel_all', 'agent:flatten_all']) expect(await dispatch(find(cmds, id), false)).toBe('confirm')
    expect(h.calls).toEqual([])
    expect(await dispatch(find(cmds, 'go:settings'), false)).toBe('done')
    expect(await dispatch(find(cmds, 'agent:flatten_all'), true)).toBe('done')
    expect(h.calls).toEqual(['go:settings', 'takeover:flatten_all'])
  })

  it('宿主抛错原样向上传（面板用 toast 显示上游原文）', async () => {
    const h = host()
    h.takeover = vi.fn(() => { throw new Error('场所拒绝：账户未连接') })
    await expect(dispatch(find(buildCommands(h), 'agent:halt_new'), true)).rejects.toThrow('场所拒绝：账户未连接')
  })
})

describe('排序', () => {
  const cmds = buildCommands(host())
  it('子串、拼音、英文关键词都能命中', () => {
    expect(rankCommands(cmds, '平仓')[0]?.id).toBe('agent:flatten_all')
    expect(rankCommands(cmds, 'pingcang')[0]?.id).toBe('agent:flatten_all')
    expect(rankCommands(cmds, 'settings')[0]?.id).toBe('go:settings')
    expect(rankCommands(cmds, 'zzzz')).toEqual([])
  })
  it('空查询保持原顺序', () => {
    expect(rankCommands(cmds, '').map((c) => c.id)).toEqual(cmds.map((c) => c.id))
  })
})
